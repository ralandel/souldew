// A core's messages for the player (RETRO_ENVIRONMENT_SET_MESSAGE / _EXT) into the host's log – without the empty ones
// and without the same message over and over. Shared by the native hosts (retrohost.c; ctrhost.c can include it too).
//
// melonDS DS 1.4.0 sends its on-screen display every frame (OnScreenDisplayTask: the text buffer gets its terminating zero
// before the "anything to show?" check, so an empty display is never empty): 60 to 250 "[core message] " lines a second
// in the host's stderr, each also a LOG message to the page. A DS player's diagnostics (Linux, souldew 2.8.3, Pokémon
// White 2 Redux) held nothing but those – the end of stderr and the page's log, where the useful lines are, were gone.
// Now a message with no text in it is left out, and the same text again within CORE_MSG_QUIET seconds too (its repeats
// are counted and said with the next one that is logged).
#ifndef SOULDEW_COREMSG_H
#define SOULDEW_COREMSG_H
#include <string.h>

#ifndef CORE_MSG_QUIET
#define CORE_MSG_QUIET 10.0 // seconds the same message stays out of the log after it was logged
#endif
#define CORE_MSG_KEEP 256   // the start of the last message kept to compare with (longer ones: the start must match)

static struct {
  char last[CORE_MSG_KEEP];
  double at;         // when it was logged
  unsigned repeats;  // left out since
  int have;
} core_msg;

/**
 * Should the core's message `msg` (at `now`, seconds on any steady clock) go to the log? 0 for nothing visible in it (no
 * text, only spaces, tabs or line breaks) and for the text logged last, again within CORE_MSG_QUIET seconds. On 1,
 * *repeats says how often the message before it was left out since it was logged (0: none).
 */
static int core_msg_wanted(const char *msg, double now, unsigned *repeats) {
  if (repeats) *repeats = 0;
  if (!msg) return 0;
  const char *p = msg;
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
  if (!*p) return 0;
  const int same = core_msg.have && !strncmp(core_msg.last, msg, CORE_MSG_KEEP - 1);
  if (same && now - core_msg.at < CORE_MSG_QUIET && now >= core_msg.at) {
    core_msg.repeats++;
    return 0;
  }
  if (repeats) *repeats = core_msg.repeats;
  strncpy(core_msg.last, msg, CORE_MSG_KEEP - 1);
  core_msg.last[CORE_MSG_KEEP - 1] = 0;
  core_msg.at = now;
  core_msg.repeats = 0;
  core_msg.have = 1;
  return 1;
}
#endif
