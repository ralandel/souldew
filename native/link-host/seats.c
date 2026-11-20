// Seat management – see seats.h.
#include "seats.h"
#include "../common/cadence.h"
#include "../common/hostio.h"
#include "../common/protocol.h"

#include <stdlib.h>
#include <string.h>

// in order of preference: the first whose probe takes every seat's game runs the seats
static const struct link_backend *backends[] = {&link_backend_sameboy, &link_backend_mgba, &link_backend_melonds};

const struct link_backend *B;
int seats_n;
bool seats_solo;
static struct seat_game games[LINK_MAX_SEATS];
static struct sram_watch sram_w[LINK_MAX_SEATS];

void seat_game_free(struct seat_game *g) {
  free(g->rom), free(g->save), free(g->state);
  memset(g, 0, sizeof *g);
}

static void *dup_bytes(const void *p, size_t n) {
  void *b = p && n ? malloc(n) : NULL;
  if (b) memcpy(b, p, n);
  return b;
}

const struct link_backend *seats_backend_for(const char *forced, int n, char *const *roms) {
  for (size_t i = 0; i < sizeof backends / sizeof *backends; i++) {
    if (forced && strcmp(forced, backends[i]->name)) continue;
    int all = n > 0;
    for (int s = 0; s < n && all; s++) all = backends[i]->probe(roms[s]);
    if (all) return backends[i];
  }
  return NULL;
}

void seats_close(void) {
  if (B && seats_n) B->close();
  for (int s = 0; s < LINK_MAX_SEATS; s++) seat_game_free(&games[s]);
  seats_n = 0;
}

bool seats_open(const struct link_backend *backend, int n, const struct seat_game *from, int64_t rtc_ms, bool solo) {
  // (copies first: `from` may be the set's own games – re-forming a seat from what it was made of)
  struct seat_game next[LINK_MAX_SEATS] = {{0}};
  for (int s = 0; s < n; s++) {
    next[s] = (struct seat_game){from[s].rom ? strdup(from[s].rom) : NULL, dup_bytes(from[s].save, from[s].save_len), from[s].save ? from[s].save_len : 0,
                                 dup_bytes(from[s].state, from[s].state_len), from[s].state ? from[s].state_len : 0, ""};
    memcpy(next[s].model, from[s].model, sizeof next[s].model);
  }
  seats_close();
  B = backend;
  struct link_seat_config cfg[LINK_MAX_SEATS];
  for (int s = 0; s < n; s++) {
    games[s] = next[s];
    cfg[s] = (struct link_seat_config){games[s].rom, games[s].save, games[s].save_len, games[s].state, games[s].state_len, games[s].model[0] ? games[s].model : NULL};
  }
  seats_n = n;
  seats_solo = solo;
  const struct link_open o = {n, cfg, rtc_ms, solo};
  if (!B->open(&o)) {
    seats_close();
    return false;
  }
  for (int s = 0; s < n; s++) { // what souldew has: the save given (or the one a state carried)
    void *p = NULL;
    const size_t len = B->sram(s, &p);
    sram_known(&sram_w[s], p, p ? len : 0);
    free(p);
  }
  return true;
}

const struct seat_game *seats_game(int s) { return s >= 0 && s < seats_n ? &games[s] : NULL; }

size_t seats_battery(int s, void **out) {
  *out = NULL;
  size_t n = B->battery ? B->battery(s, out) : 0;
  if (!*out || !n) free(*out), *out = NULL, n = B->sram(s, out);
  if (!n) free(*out), *out = NULL;
  return n;
}

void seats_check_sram(int s, bool force) {
  if (s < 0 || s >= seats_n) return;
  void *p = NULL;
  const size_t n = B->sram(s, &p);
  if (p && n && sram_due(&sram_w[s], p, n, force)) {
    void *full = NULL;
    const size_t fn = B->battery ? B->battery(s, &full) : 0;
    if (full && fn) host_send(MSG_SRAM, full, (uint32_t)fn);
    else host_send(MSG_SRAM, p, (uint32_t)n);
    free(full);
    host_event("{\"event\":\"saved\",\"seat\":%d,\"size\":%zu}", s, n);
  }
  free(p);
}

void seats_send_all_sram(void) {
  for (int s = 0; s < seats_n; s++) {
    void *p = NULL;
    const size_t n = seats_battery(s, &p);
    const uint32_t seat = (uint32_t)s;
    host_send2(MSG_SEATSRAM, &seat, 4, p, (uint32_t)n);
    free(p);
  }
}
