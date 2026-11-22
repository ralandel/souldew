// The session around the seats: whose buttons drive which console on which frame. Alone (solo) and in local mode
// (tests) every seat's buttons are the ones held now; in a link session (net mode) it is input-delay lockstep – the
// local seat's buttons for frame f are taken at frame f − D and sent to the peers (LINPUT), and frame f runs only once
// every seat's buttons for it are known. Also: the peers' buttons coming in (RINPUT, NEED), the hash every 120 frames,
// whole-session states for a partner who rejoins, and record / replay of every seat's buttons (tests).
#ifndef SOULDEW_SESSION_H
#define SOULDEW_SESSION_H

#include "linkbackend.h"

/** Start counting from frame 0 with `n` seats; `local`: this player's seat; `net`: lockstep with `delay` frames. */
void session_begin(int n, int local, bool net, int delay);
int session_local(void);
bool session_net(void);
int session_delay(void);
/** The session's frame: every console started this many frames. */
uint32_t session_frame(void);
/** Seat `s`'s buttons are known for the frames before this one (net mode: what its peer sent so far; diagnostics). */
uint32_t session_have(int s);

/** INPUT: the fast player's 17 bytes (buttons, the pointer = DS touch) for the local seat; tests in local mode: exactly
 *  8 bytes { link_input bits, u32 seat }. `screen_h`: the picture's height the pointer is relative to. */
void session_take_input(const uint8_t *p, uint32_t len, int screen_h);
/** RINPUT: a peer's buttons (repeats and frames that come early are fine). */
void session_take_remote(const uint8_t *p, uint32_t len);
/** NEED: a peer missed a seat's buttons – what this host knows, as LINPUT. */
void session_answer_need(const uint8_t *p, uint32_t len);

/**
 * Can the next frame run? Local mode: yes, with the buttons held now (or the script's). Net mode: the local buttons D
 * frames ahead go out first; then yes once every seat's buttons are known – else the event "wait" (after 250 ms,
 * repeated) and false.
 */
bool session_ready(double now);
/** Run the frame the session is at (every seat's buttons into the backend; recorded with --record). */
void session_run_frame(void);
/** The frames after a session's end, where nothing is pressed any more (a DS console settling, SEATSTATE). */
void session_run_idle_frame(void);

/** STATE: every console of the session, its frame and the buttons known past it (empty = not now). */
void session_send_state(void);
/** A whole-session state (SAVE's / --load's format); false (nothing changed) when it doesn't fit these seats. */
bool session_load_state(const uint8_t *b, size_t len);

/** Tests: write every frame's buttons to `path` (--record); play a recording back (--script – for this session only:
 *  session_begin drops it). */
bool session_record(const char *path);
bool session_script(const char *path);
/** --bench: the script's buttons for the coming frame (every seat, local mode). */
void session_bench_inputs(void);

#endif
