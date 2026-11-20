// The session around the seats – see session.h and docs/MULTIPLAYER.md › "Netcode".
#include "session.h"
#include "seats.h"
#include "../common/hostio.h"
#include "../common/protocol.h"

#include <stdlib.h>
#include <string.h>

#define RING 4096          // frames of buttons kept per seat
#define TOUCH_MIN_FRAMES 4 // a quick tap still counts as held this long – the games poll the touch screen slowly
#define SESSION_MAGIC 0x5345534cu // 'LSES': the session tail of a whole-session state

static int nseats, local_seat, net_mode, delay_frames = 4;
static uint32_t frame;
static double wait_since;
static struct seat_input {
  link_input in[RING];   // buttons per frame
  uint8_t early[RING];   // a peer's buttons that came ahead of a gap: kept until the gap fills
  uint32_t have;         // buttons known for frames < have
  link_input held;       // local mode / the local seat: the buttons held now (touch included)
  link_input touch_last; // where the last touch was (with LINK_TOUCH)
  int touch_latch;       // a quick tap still counts as held for this many frames
} seat[LINK_MAX_SEATS];
static FILE *record_f;
static link_input *script;
static uint32_t script_frames;
static int script_seats;

static link_input script_input(uint32_t f, int s) { return f < script_frames && s < script_seats ? script[(size_t)f * script_seats + s] : 0; }

void session_begin(int n, int local, bool net, int delay) {
  nseats = n, local_seat = local, net_mode = net, delay_frames = delay;
  frame = 0;
  wait_since = 0;
  free(script); // (a recording belongs to the session it was given for – never to the game alone afterwards)
  script = NULL, script_frames = 0;
  memset(seat, 0, sizeof seat);
  for (int s = 0; s < n; s++) seat[s].have = net ? (uint32_t)delay : 0; // the first frames: nothing pressed, known to all
}
int session_local(void) { return local_seat; }
bool session_net(void) { return net_mode; }
int session_delay(void) { return delay_frames; }
uint32_t session_frame(void) { return frame; }

// ---- input --------------------------------------------------------------------------------------------------------
/** RETRO_DEVICE_ID_JOYPAD_* bits → link_input. */
static link_input retro_to_input(uint32_t r) {
  static const link_input map[12] = {LINK_KEY_B, LINK_KEY_Y, LINK_KEY_SELECT, LINK_KEY_START, LINK_KEY_UP, LINK_KEY_DOWN, LINK_KEY_LEFT, LINK_KEY_RIGHT,
                                     LINK_KEY_A, LINK_KEY_X, LINK_KEY_L, LINK_KEY_R};
  link_input k = 0;
  for (int i = 0; i < 12; i++) if (r >> i & 1) k |= map[i];
  return k;
}

/**
 * The touch bits (link_input: bit 12, x in 16–23, y in 24–31) from the fast player's pointer (INPUT bytes 12–16: s16 px,
 * py over the whole picture, −0x7fff…0x7fff, u8 pressed). The DS picture is the top screen above the touch screen
 * (256 × 384): only the lower half touches. 0 when the pointer isn't on the touch screen.
 */
static link_input touch_from_pointer(const uint8_t *p, int screen_h) {
  int16_t px, py;
  memcpy(&px, p + 12, 2), memcpy(&py, p + 14, 2);
  if (!p[16] || screen_h < 384) return 0;
  const int x = (int)((px + 0x7fff) * (int64_t)256 / 0xffff), y = (int)((py + 0x7fff) * (int64_t)screen_h / 0xffff) - (screen_h - 192);
  if (y < 0) return 0; // the top screen
  return LINK_TOUCH | (link_input)(x < 0 ? 0 : x > 255 ? 255 : x) << 16 | (link_input)(y > 191 ? 191 : y) << 24;
}

void session_take_input(const uint8_t *p, uint32_t len, int screen_h) {
  if (len < 4) return;
  uint32_t bits, s = (uint32_t)local_seat;
  memcpy(&bits, p, 4);
  if (len == 8 && !net_mode) memcpy(&s, p + 4, 4);
  if (s >= (uint32_t)nseats) return;
  struct seat_input *st = &seat[s];
  const link_input t = len >= 17 ? touch_from_pointer(p, screen_h) : 0;
  if (t && !(st->held & LINK_TOUCH)) st->touch_latch = TOUCH_MIN_FRAMES;
  if (t) st->touch_last = t;
  st->held = retro_to_input(bits) | t | (len == 8 ? bits & 0xFFFF1000u : 0); // (tests: link_input touch bits as they are)
}

/** A seat's buttons for the next frame: a tap shorter than TOUCH_MIN_FRAMES still lasts that long. Once per frame. */
static link_input sample(struct seat_input *st) {
  link_input k = st->held;
  if (!(k & LINK_TOUCH) && st->touch_latch > 0) k |= st->touch_last;
  if (st->touch_latch > 0) st->touch_latch--;
  return k;
}

void session_take_remote(const uint8_t *p, uint32_t len) {
  if (len < 8) return;
  uint32_t s, first;
  memcpy(&s, p, 4), memcpy(&first, p + 4, 4);
  if (s >= (uint32_t)nseats || (int)s == local_seat) return;
  struct seat_input *st = &seat[s];
  const uint32_t n = (len - 8) / 4;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t f = first + i;
    if (f < st->have) continue;       // known already (a resend)
    if (f >= frame + RING - 1) break; // too far ahead
    memcpy(&st->in[f % RING], p + 8 + i * 4, 4);
    st->early[f % RING] = 1;
  }
  while (st->early[st->have % RING]) st->early[st->have % RING] = 0, st->have++;
}

void session_answer_need(const uint8_t *p, uint32_t len) {
  if (len < 8) return;
  uint32_t s, from;
  memcpy(&s, p, 4), memcpy(&from, p + 4, 4);
  if (s >= (uint32_t)nseats) return;
  struct seat_input *st = &seat[s];
  const uint32_t lo = st->have > RING - 2 ? st->have - (RING - 2) : 0;
  if (from < lo) from = lo; // (older than the ring: gone)
  if (from >= st->have) return;
  uint32_t n = st->have - from;
  if (n > 1024) n = 1024;
  uint32_t *m = malloc(8 + 4 * (size_t)n);
  if (!m) return;
  m[0] = s, m[1] = from;
  for (uint32_t i = 0; i < n; i++) m[2 + i] = st->in[(from + i) % RING];
  host_send(MSG_LINPUT, m, 8 + 4 * n);
  free(m);
}

bool session_ready(double now) {
  if (!net_mode) {
    for (int s = 0; s < nseats; s++) seat[s].in[frame % RING] = script ? script_input(frame, s) : sample(&seat[s]);
    return true;
  }
  struct seat_input *me = &seat[local_seat];
  while (me->have <= frame + (uint32_t)delay_frames) { // the local buttons, D frames ahead, out to the peers
    const uint32_t f = me->have;
    const link_input k = script ? script_input(f, local_seat) : sample(me);
    me->in[f % RING] = k;
    me->have = f + 1;
    const uint32_t m[3] = {(uint32_t)local_seat, f, k};
    host_send(MSG_LINPUT, m, sizeof m);
  }
  int missing = 0;
  for (int s = 0; s < nseats; s++) if (seat[s].have <= frame) missing |= 1 << s;
  if (!missing) {
    wait_since = 0;
    return true;
  }
  // a peer's buttons are late: wait (the game stands still – the same for everybody)
  if (!wait_since) wait_since = now;
  if (now - wait_since > 0.25) {
    host_event("{\"event\":\"wait\",\"seats\":%d,\"frame\":%u,\"ms\":%.0f}", missing, frame, (now - wait_since) * 1000);
    wait_since = now - 0.0001;
  }
  return false;
}

void session_run_frame(void) {
  for (int s = 0; s < nseats; s++) B->set_input(s, seat[s].in[frame % RING]);
  if (record_f) {
    fwrite(&frame, 4, 1, record_f);
    for (int s = 0; s < nseats; s++) fwrite(&seat[s].in[frame % RING], 4, 1, record_f);
    fflush(record_f);
  }
  B->run_frame();
  frame++;
}

void session_run_idle_frame(void) {
  for (int s = 0; s < nseats; s++) seat[s].in[frame % RING] = 0;
  session_run_frame();
}

void session_bench_inputs(void) {
  for (int s = 0; s < nseats; s++) seat[s].in[frame % RING] = script_input(frame, s);
}

// ---- whole-session states --------------------------------------------------------------------------------------------
// u32 n, n × { u32 len, state }, then u32 'LSES', u32 frame – every console and the session frame it was taken at (rejoin:
// the peers that stayed send it to the one coming back) – then every seat's buttons known from that frame on (u32 count,
// inputs): a rejoiner's own buttons that the others already have are taken as they were, not pressed again. An empty
// STATE means "not now" (the DS backend can't write a console down while it waits mid-frame for a wireless packet).
void session_send_state(void) {
  size_t total = 4 + 8, sizes[LINK_MAX_SEATS];
  for (int s = 0; s < nseats; s++) {
    sizes[s] = B->state_size(s);
    if (!sizes[s]) { host_send(MSG_STATE, NULL, 0); return; }
    total += 4 + sizes[s];
  }
  size_t extra = 0;
  for (int s = 0; s < nseats; s++) extra += 4 + 4 * (size_t)(seat[s].have > frame ? seat[s].have - frame : 0);
  uint8_t *b = malloc(total + extra), *p = b + 4;
  if (!b) { host_send(MSG_STATE, NULL, 0); return; }
  const uint32_t n = (uint32_t)nseats;
  memcpy(b, &n, 4);
  for (int s = 0; s < nseats; s++) {
    const uint32_t len = (uint32_t)sizes[s];
    memcpy(p, &len, 4);
    if (B->state_size(s) != sizes[s] || !B->save_state(s, p + 4)) { free(b); host_send(MSG_STATE, NULL, 0); return; }
    p += 4 + len;
  }
  const uint32_t tail[2] = {SESSION_MAGIC, frame};
  memcpy(p, tail, 8), p += 8;
  for (int s = 0; s < nseats; s++) {
    const uint32_t k = seat[s].have > frame ? seat[s].have - frame : 0;
    memcpy(p, &k, 4), p += 4;
    for (uint32_t i = 0; i < k; i++, p += 4) memcpy(p, &seat[s].in[(frame + i) % RING], 4);
  }
  host_send(MSG_STATE, b, (uint32_t)(total + extra));
  free(b);
}

bool session_load_state(const uint8_t *b, size_t len) {
  uint32_t n;
  if (len < 4) return false;
  memcpy(&n, b, 4);
  if (n != (uint32_t)nseats) return false;
  size_t at = 4;
  for (int s = 0; s < nseats; s++) { // (all sizes checked before anything is loaded)
    uint32_t l;
    if (at + 4 > len) return false;
    memcpy(&l, b + at, 4);
    if (!l || at + 4 + l > len) return false;
    at += 4 + l;
  }
  uint32_t tail[2] = {0, 0};
  if (at + 8 <= len) memcpy(tail, b + at, 8);
  size_t q = 4;
  for (int s = 0; s < nseats; s++) {
    uint32_t l;
    memcpy(&l, b + q, 4);
    if (!B->load_state(s, b + q + 4, l)) return false;
    q += 4 + l;
  }
  if (tail[0] != SESSION_MAGIC) return true;
  frame = tail[1]; // the session goes on from that frame, with the buttons known past it
  q += 8;
  for (int s = 0; s < nseats; s++) {
    memset(seat[s].early, 0, sizeof seat[s].early);
    uint32_t k = 0;
    if (q + 4 <= len) memcpy(&k, b + q, 4), q += 4;
    if (k > RING - 2 || q + 4 * (size_t)k > len) k = 0;
    for (uint32_t i = 0; i < k; i++, q += 4) memcpy(&seat[s].in[(frame + i) % RING], b + q, 4);
    seat[s].have = net_mode ? frame + k : 0;
  }
  return true;
}

// ---- tests -------------------------------------------------------------------------------------------------------------
bool session_record(const char *path) { return (record_f = host_fopen(path, "wb")) != NULL; }

bool session_script(const char *path) {
  size_t n = 0;
  uint8_t *b = host_read_file(path, &n);
  const size_t rec = 4 + 4 * (size_t)nseats;
  if (!b || n < rec) {
    free(b);
    return false;
  }
  free(script);
  script_seats = nseats;
  script_frames = (uint32_t)(n / rec);
  script = calloc((size_t)script_frames * nseats, sizeof *script);
  for (uint32_t f = 0; script && f < script_frames; f++) memcpy(script + (size_t)f * nseats, b + f * rec + 4, 4 * (size_t)nseats);
  free(b);
  return script != NULL;
}
