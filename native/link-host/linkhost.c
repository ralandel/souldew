// The souldew engine: ONE native player for the Game Boy / Game Boy Color, Game Boy Advance and Nintendo DS on the
// emulators' own APIs (SameBoy, libmgba, melonDS – one backend each, linkbackend.h), and the engine behind trades and
// battles between players (docs/MULTIPLAYER.md). It runs a player's game alone (solo: the fast player – retrohost's
// protocol, save states in the fast player's format) and links it in place: when a session starts, the partners'
// consoles join this process from their states (CMD_LINK); when it ends they leave and the game goes on alone
// (CMD_SOLO). Started as a link session (--rom … --net) it plays one from the start – booted from the battery saves,
// a rejoin (--load), or the e2e.
//
// In a link session every peer runs ALL seats from the same ROMs (each partner's ROM rebuilt locally and checked by
// SHA-1 – no ROM ever crosses the network), the same battery saves / states and the same start time, and only the
// buttons travel: same program + same inputs on the same frames = the same games everywhere.
//
//   linkhost --solo --rom <game> [--sram <file>] [--state <file>] [--model dmg|cgb] [--ram ADDR:LEN]…
//   linkhost --rom <seat0> [--rom <seat1> …] [--sram <file>|-]… [--state <file>|-]… [--model dmg|cgb]… [--local k]
//            [--net --delay D] [--rtc <unix ms>] [--ram ADDR:LEN]… [--load <file>]
//   tests:   [--record <file>] [--script <file>] [--bench FRAMES [--speed X] [--out dir] [--export dir]] [--backend NAME]
//
// Messages: native/common/protocol.h. Alone, the engine speaks retrohost's protocol (native/retro-host/retrohost.c):
// INPUT, SPEED, SAVE / LOAD (a state in the fast player's format), QUIT, RESET, WRITE (cheats), FLUSH, SRAM (a battery
// save given late), RESYNC, STEP, WATCH; out VIDEO (RGB565), AUDIO, STATE, LOG, EVENT, RAM, SRAM, WATCHED. In a link
// session: INPUT, SPEED, SAVE / LOAD (whole-session states), QUIT, FLUSH (+ SEATSRAM), RESYNC, STEP, VIEW, RINPUT,
// READ / POKE (tests), UNTIL, NEED, SEATSTATE; out LINPUT, SEATSRAM, SEATSTATE, MEM and the events hash {frame, hash}
// every 120 frames and wait {seats, frame, ms}. Both: CMD_LINK / CMD_SOLO (the server only, never the page).
// Events: loaded {engine, mode, core, system, seats, local, net, delay, width, height, fps, sampleRate, frame, ram,
// saveSize, stateSize, state} | stats {fps, speed, shown, frame, ffk, ffHoles} | ffrate {k} | audioRate | stepped | saved | written | stateLoaded | seatState |
// error | ended.
//
// Modules: seats.c (the consoles and their re-forming), session.c (whose buttons on which frame: solo / lockstep),
// avout.c (picture and sound), ../common (IPC, the RAM stream, the fast-forward sound, the loop's cadence) – this file
// is the frame loop and the commands.
#include "avout.h"
#include "linkbackend.h"
#include "seats.h"
#include "session.h"
#include "../common/cadence.h"
#include "../common/depth.h"
#include "../common/hostio.h"
#include "../common/protocol.h"
#include "../common/ramstream.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define HASH_EVERY 120
#define MAX_CMD_LEN (64u * 1024 * 1024)
#define MAX_SETTLE 600

// ---- arguments: the command line, and CMD_LINK / CMD_SOLO's payloads (the same words, NUL-separated) ---------------
struct start_args {
  int n;                                    // --rom count
  const char *rom[LINK_MAX_SEATS], *sram[LINK_MAX_SEATS], *state[LINK_MAX_SEATS], *model[LINK_MAX_SEATS];
  int nsram, nstate, nmodel;
  int local, delay;
  bool net, solo;
  int64_t rtc_ms;
  const char *load, *backend, *record, *script, *out, *export_dir;
  int bench;
  double bench_speed;
};

static bool parse_args(int argc, char **argv, struct start_args *a, struct ram_stream *rs) {
  *a = (struct start_args){.delay = 4};
  for (int i = 0; i < argc; i++) {
    const char *k = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!strcmp(k, "--net")) { a->net = true; continue; }
    if (!strcmp(k, "--solo")) { a->solo = true; continue; }
    if (!v) return false;
    i++;
    if (!strcmp(k, "--rom") && a->n < LINK_MAX_SEATS) a->rom[a->n++] = v;
    else if (!strcmp(k, "--sram") && a->nsram < LINK_MAX_SEATS) a->sram[a->nsram++] = v;
    else if (!strcmp(k, "--state") && a->nstate < LINK_MAX_SEATS) a->state[a->nstate++] = v;
    else if (!strcmp(k, "--model") && a->nmodel < LINK_MAX_SEATS) a->model[a->nmodel++] = v;
    else if (!strcmp(k, "--local")) a->local = atoi(v);
    else if (!strcmp(k, "--delay")) a->delay = atoi(v);
    else if (!strcmp(k, "--rtc")) a->rtc_ms = strtoll(v, NULL, 10);
    else if (!strcmp(k, "--load")) a->load = v;
    else if (!strcmp(k, "--backend")) a->backend = v;
    else if (!strcmp(k, "--record")) a->record = v;
    else if (!strcmp(k, "--script")) a->script = v;
    else if (!strcmp(k, "--out")) a->out = v;
    else if (!strcmp(k, "--export")) a->export_dir = v;
    else if (!strcmp(k, "--bench")) a->bench = atoi(v);
    else if (!strcmp(k, "--speed")) a->bench_speed = atof(v);
    else if (!strcmp(k, "--ram")) { if (!rs || !ram_add_arg(rs, v)) return false; }
    else return false;
  }
  if (!a->rtc_ms) a->rtc_ms = (int64_t)time(NULL) * 1000;
  return a->delay >= 1 && a->delay <= 120 && a->local >= 0 && (a->n == 0 || a->local < a->n);
}

/** A payload's NUL-separated words → argv (pointing into `p`, which gets a terminating NUL). */
static int split_words(uint8_t *p, uint32_t len, char **argv, int cap) {
  int n = 0;
  for (uint32_t i = 0; i < len && n < cap;) {
    argv[n++] = (char *)p + i;
    while (i < len && p[i]) i++;
    i++;
  }
  return n;
}

/** The seats' games from the arguments ("-" = none): files read here; false (logged) when one can't be. */
static bool games_from(const struct start_args *a, struct seat_game *g) {
  memset(g, 0, sizeof *g * (size_t)a->n);
  for (int s = 0; s < a->n; s++) {
    g[s].rom = (char *)a->rom[s];
    if (s < a->nsram && strcmp(a->sram[s], "-")) g[s].save = host_read_file(a->sram[s], &g[s].save_len); // (none: a new cartridge)
    if (s < a->nstate && strcmp(a->state[s], "-") && !(g[s].state = host_read_file(a->state[s], &g[s].state_len))) {
      host_log("seat %d: the state %s can't be read", s, a->state[s]);
      return false;
    }
    if (s < a->nmodel) snprintf(g[s].model, sizeof g[s].model, "%s", !strcmp(a->model[s], "dmg") ? "dmg" : "cgb");
  }
  return true;
}
static void games_free(struct seat_game *g, int n) {
  for (int s = 0; s < n; s++) free(g[s].save), free(g[s].state), g[s].rom = NULL;
}

// ---- the engine's state ----------------------------------------------------------------------------------------------
static struct ram_stream rs;
static void seat_picture(int seat, struct ram_stream *r, uint32_t frame); // (the picture, after the DS's depth – below)
static struct cadence cad;
static float speed = 1.0f;
static uint32_t step_left, until_frame; // STEP: frames still to run; UNTIL: pause at this session frame
static int view_seat;
static int state_loaded = -1; // the loaded event's "state": -1 none asked for, 0 refused (booted instead), 1 loaded

static bool linked(void) { return !seats_solo; }

static uint8_t *locate(int index, uint32_t addr, uint32_t len, void *ctx) {
  (void)index, (void)ctx;
  return B->mem(session_local(), addr, len);
}

/** The event that tells the page what plays now (after every start and every change of mode). */
static void send_loaded(void) {
  const uint32_t *px;
  unsigned w, h, stride;
  B->video(session_local(), &px, &w, &h, &stride);
  char regions[256];
  ram_regions_json(&rs, regions, sizeof regions);
  void *sv = NULL;
  const size_t sn = B->sram(session_local(), &sv);
  free(sv);
  const char *st = state_loaded < 0 ? "null" : state_loaded ? "true" : "false";
  host_event("{\"event\":\"loaded\",\"engine\":true,\"mode\":\"%s\",\"core\":\"souldew engine (%s)\",\"system\":\"%s\",\"seats\":%d,\"local\":%d,\"net\":%s,\"delay\":%d,"
             "\"width\":%u,\"height\":%u,\"fps\":%.4f,\"sampleRate\":%.1f,\"frame\":%u,\"ram\":[%s],\"saveSize\":%zu,\"stateSize\":0,\"state\":%s}",
             linked() ? "link" : "solo", B->name, B->system(), seats_n, session_local(), session_net() ? "true" : "false", session_delay(), w, h, B->fps(),
             B->sample_rate ? B->sample_rate() : 0.0, session_frame(), regions, sn, st);
}

/** After the seats were (re-)formed: memory, picture, sound and pacing follow, and the page hears what plays now. */
static void seats_formed(int local, bool net, int delay) {
  session_begin(seats_n, local, net, delay);
  view_seat = local;
  step_left = until_frame = 0;
  ram_locate(&rs, locate, NULL);
  ram_resync(&rs);
  avout_reset(B->sample_rate ? B->sample_rate() : 0);
  cadence_init(&cad, B->fps(), host_now());
}

/**
 * Alone: one seat from `g` (with a state to go on from – a refused state boots the game from its battery save instead,
 * as the fast player does).
 */
static bool open_solo(const struct link_backend *backend, struct seat_game *g) {
  state_loaded = g->state ? 1 : -1;
  if (seats_open(backend, 1, g, 0, true)) return true;
  if (!g->state) return false;
  host_log("the state doesn't load – the game starts from its battery save");
  free(g->state), g->state = NULL, g->state_len = 0;
  state_loaded = 0;
  return seats_open(backend, 1, g, 0, true);
}

/**
 * The local seat's console as it is now, for the fast player's format. A DS console waiting mid-frame for a wireless
 * packet can't be written down: then every seat runs on alone with nothing pressed (the session is over – those frames
 * no longer have to match anybody), at most `settle` frames.
 */
static size_t export_local(void **out, uint32_t settle) {
  size_t n = B->export_state(session_local(), out);
  for (uint32_t i = 0; !n && i < settle; i++) {
    session_run_idle_frame();
    avout_sound(session_local(), false, false, 1, host_now());
    n = B->export_state(session_local(), out);
  }
  return n;
}

/** The local seat as a game to open again: its ROM and model, its battery save and its console as it is now (no state
 *  when it can't be written down within `settle` frames – it then boots from the save). */
static struct seat_game this_game(uint32_t settle) {
  const struct seat_game *mine = seats_game(session_local());
  struct seat_game g = {0};
  g.rom = strdup(mine->rom);
  memcpy(g.model, mine->model, sizeof g.model);
  void *sv = NULL, *st = NULL;
  g.save_len = seats_battery(session_local(), &sv);
  g.save = sv;
  g.state_len = export_local(&st, settle);
  g.state = st;
  return g;
}

/** A link that didn't start: the event for the server (it answers the page's start with it). */
static void link_refused(const char *why) {
  host_log("link: %s", why);
  host_event("{\"event\":\"linkRefused\",\"message\":\"%s\"}", why);
}

// ---- mode changes -----------------------------------------------------------------------------------------------------
/**
 * CMD_LINK: partners join – every seat (this game's too) is formed from the session's agreed states and saves, exactly
 * as every peer forms them, so all consoles are the same everywhere. If that fails the game goes on alone as it was.
 */
static void go_link(uint8_t *p, uint32_t len) {
  char *argv[64];
  struct start_args a;
  const int argc = split_words(p, len, argv, 64);
  if (!parse_args(argc, argv, &a, NULL) || a.n < 2) {
    link_refused("not a link session's arguments");
    return;
  }
  const struct link_backend *backend = seats_backend_for(a.backend, a.n, (char *const *)a.rom);
  struct seat_game g[LINK_MAX_SEATS] = {{0}};
  if (!backend || !games_from(&a, g)) {
    games_free(g, a.n);
    link_refused(backend ? "a seat's state can't be read" : "no backend runs these games");
    return;
  }
  const double t0 = host_now();
  seats_check_sram(session_local(), true); // (the save as it was before the session: souldew has it)
  struct seat_game back = this_game(0);    // (to go on alone with if the session can't start)
  const struct link_backend *was = B;
  const bool ok = seats_open(backend, a.n, g, a.rtc_ms, false);
  games_free(g, a.n);
  if (!ok) {
    if (!open_solo(was, &back)) host_die("the game didn't start again");
    seat_game_free(&back);
    seats_formed(0, false, 1);
    send_loaded();
    link_refused("the games didn't start");
    return;
  }
  seat_game_free(&back);
  seats_formed(a.local, a.net, a.delay);
  if (a.script && !session_script(a.script)) host_log("link: --script not readable");
  state_loaded = -1;
  if (a.load) { // a rejoin: the session as the partners who stayed had it
    size_t n = 0;
    uint8_t *b = host_read_file(a.load, &n);
    if (!b || !session_load_state(b, n)) host_die("link: not a session state of these games");
    free(b);
  }
  host_log("link: %d seats formed in %.0f ms (seat %d is ours, delay %d)", a.n, (host_now() - t0) * 1000, a.local, a.delay);
  speed = 1.0f;
  send_loaded();
  seat_picture(view_seat, &rs, session_frame());
}

/**
 * CMD_SOLO: the session is over, this game goes on alone – without arguments from the local console as it is (its
 * battery save goes out first: souldew writes it into the run); with --rom/--sram/--state/--model from those (out of
 * step: back to the game as it was before the link).
 */
static void go_solo(uint8_t *p, uint32_t len) {
  char *argv[16];
  struct start_args a;
  const int argc = split_words(p, len, argv, 16);
  if (!parse_args(argc, argv, &a, NULL) || a.n > 1) {
    host_log("solo: bad arguments");
    return;
  }
  const double t0 = host_now();
  struct seat_game g = {0};
  if (a.n) {
    if (!games_from(&a, &g)) host_die("solo: the game can't be read");
    g.rom = strdup(g.rom);
  } else {
    seats_check_sram(session_local(), true);
    g = this_game(300);
    if (!g.state) host_log("solo: the console couldn't be written down – the game starts from its battery save");
  }
  const struct link_backend *backend = seats_backend_for(a.backend, 1, &g.rom);
  if (!backend || !open_solo(backend, &g)) host_die("solo: the game didn't start");
  seat_game_free(&g);
  seats_formed(0, false, 1);
  host_log("solo: alone again in %.0f ms", (host_now() - t0) * 1000);
  speed = 1.0f;
  send_loaded();
  seat_picture(view_seat, &rs, session_frame());
}

/** RESET / SRAM while alone: the console starts over from its game – with `save` (a battery save given late) or the one
 *  it has now. */
static void restart_solo(const uint8_t *save, size_t len) {
  struct seat_game g = *seats_game(0);
  void *own = NULL;
  g.rom = strdup(g.rom);
  if (save) g.save = (uint8_t *)save, g.save_len = len;
  else g.save_len = seats_battery(0, &own), g.save = own;
  g.state = NULL, g.state_len = 0;
  const struct link_backend *backend = B;
  state_loaded = -1;
  if (!seats_open(backend, 1, &g, 0, true)) host_die("the game didn't start again");
  free(g.rom), free(own);
  seats_formed(0, false, 1);
}

// ---- commands -----------------------------------------------------------------------------------------------------------
static void set_speed(const uint8_t *p, uint32_t len) {
  if (len < 4) return;
  float v;
  memcpy(&v, p, 4);
  speed = isfinite(v) ? (v <= 0 ? 0 : v < 0.05f ? 0.05f : v > 1000.0f ? 1000.0f : v) : v > 0 ? 1000.0f : 1.0f;
}

static void do_read(const uint8_t *p, uint32_t len) {
  if (len < 12) return;
  uint32_t s, addr, n;
  memcpy(&s, p, 4), memcpy(&addr, p + 4, 4), memcpy(&n, p + 8, 4);
  if (s >= (uint32_t)seats_n || n > 1 << 20) return;
  uint8_t *out = malloc(8 + n);
  if (!out) return;
  memcpy(out, &s, 4), memcpy(out + 4, &addr, 4);
  for (uint32_t i = 0; i < n; i++) out[8 + i] = B->read8((int)s, addr + i);
  host_send(MSG_MEM, out, 8 + n);
  free(out);
}
static void do_poke(const uint8_t *p, uint32_t len) {
  if (len < 9) return;
  uint32_t s, addr;
  memcpy(&s, p, 4), memcpy(&addr, p + 4, 4);
  if (s >= (uint32_t)seats_n) return;
  for (uint32_t i = 0; i < len - 8; i++) B->write8((int)s, addr + i, p[8 + i]);
}

static void send_seatstate(const uint8_t *p, uint32_t len) {
  uint32_t settle = 0;
  if (len >= 4) memcpy(&settle, p, 4);
  void *st = NULL;
  const size_t n = export_local(&st, settle > MAX_SETTLE ? MAX_SETTLE : settle);
  const uint32_t seat = (uint32_t)session_local();
  host_send2(MSG_SEATSTATE, &seat, 4, st, (uint32_t)n);
  host_event("{\"event\":\"seatState\",\"seat\":%d,\"size\":%zu,\"frame\":%u}", session_local(), n, session_frame());
  free(st);
}

// ---- the DS's 3D depth for Shared World (native/common/depth.h): the picture's seat ------------------------------------
static struct depth_req dreq;
static int link_depth(void *ctx, int on, int x, int y, int w, int h, uint32_t *out) {
  return B && B->depth ? B->depth((int)(intptr_t)ctx, on, x, y, w, h, out) : -1;
}
/** The seat's picture – after its depth (asked for) and the watched bytes, as retrohost sends them. */
static void seat_picture(int seat, struct ram_stream *r, uint32_t frame) {
  if (r) depth_send(&dreq, frame, link_depth, (void *)(intptr_t)seat);
  avout_picture(seat, r, frame);
}

/** One command, between two frames. Returns false on QUIT. `*wrote`: a cheat went in (the RAM goes out right away). */
static bool command(struct host_cmd *c, bool *wrote) {
  const int local = session_local();
  switch (c->type) {
  case CMD_INPUT: session_take_input(c->p, c->len, avout_screen_height(local)); break;
  case CMD_SPEED: set_speed(c->p, c->len); break;
  case CMD_QUIT: return false;
  case CMD_RESYNC: ram_resync(&rs); break;
  case CMD_WATCH: ram_set_watch(&rs, c->p, c->len); break;
  case CMD_DEPTH: depth_set(&dreq, c->p, c->len, link_depth, (void *)(intptr_t)local); break;
  case CMD_STEP:
    if (c->len >= 4) {
      uint32_t n;
      memcpy(&n, c->p, 4);
      step_left = n > 1000000 ? 1000000 : n;
      speed = step_left ? (session_net() && speed > 0 ? speed : 1000.0f) : 0.0f; // (net: at the pace set)
    }
    break;
  case CMD_UNTIL:
    if (c->len >= 4) {
      memcpy(&until_frame, c->p, 4);
      if (speed <= 0) speed = 1000.0f;
    }
    break;
  case CMD_VIEW:
    if (c->len >= 4) {
      uint32_t v;
      memcpy(&v, c->p, 4);
      if (v < (uint32_t)seats_n) view_seat = (int)v;
      avout_picture(view_seat, NULL, session_frame()); // (the picture right away, paused or not)
    }
    break;
  case CMD_READ: do_read(c->p, c->len); break;
  case CMD_POKE: do_poke(c->p, c->len); break;
  case CMD_SEATSTATE: send_seatstate(c->p, c->len); break;
  case CMD_FLUSH:
    seats_check_sram(local, true);
    if (linked()) seats_send_all_sram();
    break;
  case CMD_SAVE:
    if (linked()) session_send_state();
    else {
      void *st = NULL;
      const size_t n = B->export_state(0, &st);
      host_send(MSG_STATE, st, (uint32_t)n);
      free(st);
    }
    break;
  case CMD_LOAD: {
    const bool ok = linked() ? session_load_state(c->p, c->len) : B->import_state(0, c->p, c->len);
    ram_locate(&rs, locate, NULL);
    host_event("{\"event\":\"stateLoaded\",\"ok\":%s}", ok ? "true" : "false");
    break;
  }
  case CMD_WRITE:
    if (c->len > 4 && c->len <= 4 + 65536) {
      uint32_t a;
      memcpy(&a, c->p, 4);
      // (no cheats in a link session: the partners' copies of this console would differ)
      const bool ok = !linked() && ram_write(&rs, a, c->p + 4, c->len - 4);
      host_event("{\"event\":\"written\",\"addr\":%u,\"len\":%u,\"ok\":%s}", a, c->len - 4, ok ? "true" : "false");
      *wrote = true;
    }
    break;
  case CMD_RESET:
    if (!linked()) restart_solo(NULL, 0);
    break;
  case CMD_SRAM:
    if (!linked() && c->len) restart_solo(c->p, c->len);
    break;
  case CMD_RINPUT:
    if (linked()) session_take_remote(c->p, c->len);
    break;
  case CMD_NEED:
    if (linked()) session_answer_need(c->p, c->len);
    break;
  case CMD_LINK:
    if (!linked()) go_link(c->p, c->len);
    else host_log("link: already in a link session");
    break;
  case CMD_SOLO:
    if (linked()) go_solo(c->p, c->len);
    break;
  }
  return true;
}

// ---- bench (tests): headless, as fast as possible or paced ---------------------------------------------------------------
static void bench(const struct start_args *a) {
  double t0 = host_now(), next = t0, worst = 0;
  const double fps = B->fps();
  for (int i = 0; i < a->bench; i++) {
    const double t = host_now();
    session_bench_inputs();
    session_run_frame();
    avout_sound(session_local(), false, false, 1, t);
    const double d = host_now() - t;
    if (d > worst) worst = d;
    if (a->bench_speed > 0) {
      next += 1.0 / (fps * a->bench_speed);
      host_sleep(next - host_now());
    }
  }
  const double dt = host_now() - t0;
  fprintf(stderr, "bench: %s %s, %d seats, %d frames in %.2f s = %.1f fps (%.2fx), %.3f ms/frame avg, %.3f ms worst, hash %016llx\n", B->name, B->system(), seats_n, a->bench, dt,
          a->bench / dt, a->bench / dt / fps, dt * 1000 / a->bench, worst * 1000, (unsigned long long)B->hash(HOST_FNV0));
  char path[1024];
  for (int s = 0; a->out && s < seats_n; s++) { // every seat's battery save as the session left it
    void *p = NULL;
    const size_t n = B->sram(s, &p);
    snprintf(path, sizeof path, "%s/seat%d.sav", a->out, s);
    FILE *f = host_fopen(path, "wb");
    if (f && p) fwrite(p, 1, n, f);
    if (f) fclose(f);
    free(p);
  }
  for (int s = 0; a->export_dir && s < seats_n; s++) { // every seat's console in the fast player's format
    void *p = NULL;
    const size_t n = B->export_state(s, &p);
    snprintf(path, sizeof path, "%s/seat%d.state", a->export_dir, s);
    FILE *f = n ? host_fopen(path, "wb") : NULL;
    if (f) fwrite(p, 1, n, f), fclose(f);
    fprintf(stderr, "export: seat %d: %zu bytes%s\n", s, n, n ? "" : " (not now)");
    free(p);
  }
  host_exit(0);
}

// ---- main ---------------------------------------------------------------------------------------------------------------
int main(int argc, char **argv) {
  argv = host_utf8_argv(&argc, argv);
  struct start_args a;
  if (!parse_args(argc - 1, argv + 1, &a, &rs) || a.n < 1 || (a.solo && a.n != 1)) {
    fprintf(stderr, "usage: linkhost --solo --rom <game> [--sram f] [--state f] [--model dmg|cgb] [--ram a:n]…\n"
                    "       linkhost --rom <seat0> [--rom <seat1>…] [--sram f|-]… [--state f|-]… [--model dmg|cgb]… [--local k] [--net --delay D] [--rtc ms] [--ram a:n]… [--load state]\n"
                    "       tests: [--record f] [--script f] [--bench frames [--speed x] [--out dir] [--export dir]] [--backend sameboy|mgba|melonds]\n");
    return 2;
  }
  hostio_init("linkhost", !a.bench);
  const struct link_backend *backend = seats_backend_for(a.backend, a.n, (char *const *)a.rom);
  if (!backend) host_die(a.solo ? "the engine can't run this game" : "no link backend runs these games");
  struct seat_game g[LINK_MAX_SEATS] = {{0}};
  if (!games_from(&a, g)) host_die("a state can't be read");
  if (a.solo) {
    if (!open_solo(backend, &g[0])) host_die("the game didn't start");
  } else if (!seats_open(backend, a.n, g, a.rtc_ms, false)) {
    host_die("the games didn't start");
  }
  games_free(g, a.n);
  seats_formed(a.local, a.net, a.delay);
  if (a.record && !session_record(a.record)) host_die("--record: can't write %s", a.record);
  if (a.script && !session_script(a.script)) host_die("--script: not a recording of %d seats", a.n);
  if (a.load) { // a whole-session state (rejoin): every console, and the frame the session goes on from
    size_t n = 0;
    uint8_t *b = host_read_file(a.load, &n);
    if (!b || !session_load_state(b, n)) host_die("--load: not a session state of these games");
    free(b);
  }
  if (a.bench) bench(&a);

  send_loaded();
  host_start_reader(MAX_CMD_LEN);
  static struct host_cmd cmds[256];
  for (;;) {
    // ---- souldew's commands, in order, between two frames
    bool quit = false, wrote = false;
    for (int nc; !quit && (nc = host_take_commands(cmds, 256)) > 0;)
      for (int i = 0; i < nc; i++) {
        if (!quit && !command(&cmds[i], &wrote)) quit = true;
        free(cmds[i].p);
      }
    if (quit) break;
    double t = host_now();
    if (speed <= 0.0f) { // paused: the RAM and the save stay current (cheats, a save state's check)
      if (wrote || cadence_every(&cad.last_ram, 0.1, t)) cad.last_ram = t, ram_send(&rs);
      if (cadence_every(&cad.last_sram, 0.5, t)) seats_check_sram(session_local(), false);
      host_sleep(0.01);
      cadence_restart(&cad, host_now());
      avout_idle(host_now()); // (the pause is no time the fast-forward sound owes)
      continue;
    }
    if (!session_ready(t)) { // a link session waits for a peer's buttons: the game stands still, for everybody
      if (cadence_every(&cad.last_ram, 0.1, t)) ram_send(&rs);
      host_sleep(0.002);
      cadence_restart(&cad, host_now());
      avout_idle(host_now());
      continue;
    }
    session_run_frame();
    cadence_frame(&cad);
    const uint32_t frame = session_frame();
    if (linked() && frame % HASH_EVERY == 0) host_event("{\"event\":\"hash\",\"frame\":%u,\"hash\":\"%016llx\"}", frame, (unsigned long long)B->hash(HOST_FNV0));
    const bool stepped = (step_left && --step_left == 0) || (until_frame && frame >= until_frame);
    if (until_frame && frame >= until_frame) until_frame = 0;
    if (stepped) speed = 0.0f;
    t = host_now();
    const bool turbo = speed > 1.01f;
    avout_sound(session_local(), true, turbo, speed, t);
    if (stepped || cadence_picture_due(&cad, turbo, t)) seat_picture(view_seat, &rs, frame), cad.shown++;
    if (stepped) { // the plan's next input applies from the next frame: the RAM as it is now
      ram_send(&rs);
      cad.last_ram = t;
      host_event("{\"event\":\"stepped\",\"frame\":%u}", frame);
    }
    if (wrote || cadence_every(&cad.last_ram, 0.1, t)) cad.last_ram = t, ram_send(&rs); // ten times a second, whatever the speed
    if (cadence_every(&cad.last_sram, 0.25, t)) seats_check_sram(session_local(), false); // (once it held still for a quarter second)
    double rfps, real;
    if (cadence_stats(&cad, t, &rfps, &real)) { // the page measures the real speed with the frame count
      avout_measured(real);
      double ffk;
      unsigned holes;
      avout_ff(&ffk, &holes); // (the fast-forward sound's ratio, and how often its queue ran dry – diagnostics)
      host_event("{\"event\":\"stats\",\"fps\":%.1f,\"speed\":%.3f,\"shown\":%llu,\"frame\":%u,\"ffk\":%.3f,\"ffHoles\":%u}", rfps, real,
                 (unsigned long long)cad.shown, frame, ffk, holes);
    }
    cadence_wait(&cad, speed, t);
  }
  seats_check_sram(session_local(), true); // the last of the game's saves
  host_event("{\"event\":\"ended\",\"frame\":%u}", session_frame());
  host_exit(0);
}
