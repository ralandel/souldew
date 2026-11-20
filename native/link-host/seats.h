// Seat management: the consoles the souldew engine runs in this process and what they were made from – one seat alone
// (solo: the player's game, as the fast player runs it) or 2–4 seats in a link session – the backend that runs them,
// and the battery save of each. A change of mode re-forms the set in place from the seats' games and states: the
// process, its stream to souldew and the page's picture stay.
#ifndef SOULDEW_SEATS_H
#define SOULDEW_SEATS_H

#include "linkbackend.h"

/** What a seat is made from (the seat set keeps its own copies). */
struct seat_game {
  char *rom;          // path of the game
  uint8_t *save;      // battery save (as souldew keeps it) or NULL
  size_t save_len;
  uint8_t *state;     // a state in the fast player's format to go on from, or NULL (the game boots)
  size_t state_len;
  char model[4];      // Game Boy family: "dmg" or "cgb" ("" = the backend's default)
};
void seat_game_free(struct seat_game *g);

/** The backend running the seats (NULL before the first open). */
extern const struct link_backend *B;
extern int seats_n;     // seats now
extern bool seats_solo; // one player's game alone (link_open.solo)

/**
 * The backend for these games: `forced` by name (tests: --backend), else the first whose probe takes every one of them
 * (backends in order of preference: SameBoy, mGBA, melonDS).
 */
const struct link_backend *seats_backend_for(const char *forced, int n, char *const *roms);
/**
 * (Re-)form the seats: whatever runs is closed, then `n` seats open from `games` (copied: the caller keeps its own).
 * `rtc_ms`: a link session's shared clock start. False (logged) when they can't start – no seats then.
 */
bool seats_open(const struct link_backend *backend, int n, const struct seat_game *games, int64_t rtc_ms, bool solo);
void seats_close(void);
/** Seat `s`'s game as it was opened (its ROM path and model; save and state as they were given then). */
const struct seat_game *seats_game(int s);

/** The battery save as souldew keeps it (a Game Boy clock cartridge's with its footer), malloc'd; 0 = none. */
size_t seats_battery(int s, void **out);
/**
 * Seat `s`'s battery save to souldew (SRAM, then the event "saved") once the game changed it and it settled – or
 * right away with `force` (FLUSH, QUIT, leaving a session).
 */
void seats_check_sram(int s, bool force);
/** Every seat's battery save (SEATSRAM) – a link session's FLUSH. */
void seats_send_all_sram(void);

#endif
