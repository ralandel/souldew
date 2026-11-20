// IPC of souldew's native hosts (native/retro-host, native/link-host): framed messages over stdout (protocol.h), the
// command reader that queues souldew's commands for the frame loop, and the few platform services both hosts need
// (a monotonic clock, short sleeps, UTF-8 file names on Windows). Both hosts are single-threaded around the emulation:
// commands are taken between two frames, in the order they came.
#ifndef SOULDEW_HOSTIO_H
#define SOULDEW_HOSTIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Set up stdio for the protocol (binary on Windows) and a 1 ms timer resolution (Windows: frame pacing at 60 fps needs
 * sleeps shorter than the default 15.6 ms tick). `name` prefixes the host's lines on stderr. `protocol` false (bench
 * runs): nothing goes to stdout.
 */
void hostio_init(const char *name, bool protocol);

/** One message to souldew (thread-safe: whole messages, never interleaved). `send2`: a header part and a body part. */
void host_send(uint32_t type, const void *p, uint32_t n);
void host_send2(uint32_t type, const void *a, uint32_t na, const void *b, uint32_t nb);
/** EVENT: a JSON object (printf-style, at most 1 KB). */
void host_event(const char *fmt, ...);
/** LOG and stderr. */
void host_log(const char *fmt, ...);
/** An error event, then the host ends (exit code 1). */
void host_die(const char *fmt, ...);
/** The host ends now (stdout flushed; `_exit`: a core's exit handlers may hang). */
void host_exit(int code);
/** `s` as the inside of a JSON string. */
void host_json_escape(char *out, size_t cap, const char *s);

/** One command from souldew; `p` is malloc'd (NULL when empty) and belongs to whoever takes it. */
struct host_cmd {
  uint32_t type, len;
  uint8_t *p;
};
/**
 * Start the thread that reads souldew's commands into a queue. A command longer than `max_len` or the end of stdin
 * (souldew went away) queues a QUIT.
 */
void host_start_reader(uint32_t max_len);
/** The queued commands, in order (at most `cap`; the rest stay for the next call). Returns how many. */
int host_take_commands(struct host_cmd *out, int cap);

/** Monotonic seconds. */
double host_now(void);
/** Sleep (sub-millisecond requests are honoured as well as the OS allows). */
void host_sleep(double seconds);
/** fopen for UTF-8 paths (Windows: _wfopen). */
FILE *host_fopen(const char *path, const char *mode);
/** A whole file (malloc'd), or NULL; `*n` its size. */
void *host_read_file(const char *path, size_t *n);
/** The command line as UTF-8 (Windows' argv is in the ANSI code page, which can't hold every file name). */
char **host_utf8_argv(int *argc, char **argv);

/** FNV-1a, 64 bit (battery-save fingerprints, link-session hashes). */
#define HOST_FNV0 1469598103934665603ull
uint64_t host_fnv(uint64_t h, const void *p, size_t n);

#ifdef __cplusplus
}
#endif

#endif
