// IPC of souldew's native hosts – see hostio.h. The OS calls come from ../ctr-host/compat.h (the 3DS host's portability
// layer: POSIX, or Windows with its own small pthread shim), included here only: this file is its own translation unit,
// so the link host's winpthreads never meets the shim.
#include "hostio.h"
#include "protocol.h"

#include <errno.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include "../ctr-host/compat.h"

static const char *host_name = "host";
static bool protocol_on = true;
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;

void hostio_init(const char *name, bool protocol) {
  host_name = name;
  protocol_on = protocol;
  compat_init(); // (binary stdin/stdout and the 1 ms timer on Windows; nothing elsewhere)
}

// ---- out -------------------------------------------------------------------------------------------------------------
static void write_all(const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    compat_ssize w = compat_write(1, b, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      _exit(0); // souldew went away
    }
    b += w;
    n -= (size_t)w;
  }
}

void host_send2(uint32_t type, const void *a, uint32_t na, const void *b, uint32_t nb) {
  if (!protocol_on) return;
  const uint32_t h[2] = {type, na + nb};
  pthread_mutex_lock(&out_lock);
  write_all(h, 8);
  if (na) write_all(a, na);
  if (nb) write_all(b, nb);
  pthread_mutex_unlock(&out_lock);
}
void host_send(uint32_t type, const void *p, uint32_t n) { host_send2(type, p, n, NULL, 0); }

void host_event(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  const int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n > 0) host_send(MSG_EVENT, buf, (uint32_t)(n < (int)sizeof buf ? n : (int)sizeof buf - 1));
}

void host_log(const char *fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n <= 0) return;
  if (n >= (int)sizeof buf) n = sizeof buf - 1;
  while (n && buf[n - 1] == '\n') buf[--n] = 0;
  fprintf(stderr, "%s: %s\n", host_name, buf);
  host_send(MSG_LOG, buf, (uint32_t)n);
}

void host_exit(int code) {
  fflush(stdout);
  fflush(stderr);
  _exit(code);
}

void host_json_escape(char *out, size_t cap, const char *s) {
  size_t o = 0;
  for (; *s && o + 7 < cap; s++) {
    const unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') out[o++] = '\\', out[o++] = (char)c;
    else if (c < 0x20) o += (size_t)snprintf(out + o, cap - o, "\\u%04x", c);
    else out[o++] = (char)c;
  }
  out[o] = 0;
}

void host_die(const char *fmt, ...) {
  char buf[1024], esc[1100];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  fprintf(stderr, "%s: %s\n", host_name, buf);
  host_json_escape(esc, sizeof esc, buf);
  host_event("{\"event\":\"error\",\"message\":\"%s\"}", esc);
  fflush(stderr);
  _exit(1); // not exit(): a core's exit handlers may hang
}

// ---- in: the command queue -------------------------------------------------------------------------------------------
// The reader thread appends, the frame loop takes between frames. Bounded in bytes: a page that floods the host makes
// the reader wait (and souldew's pipe fill) instead of growing without end.
#define QUEUE_BYTES_MAX (512u * 1024 * 1024)
static pthread_mutex_t q_lock = PTHREAD_MUTEX_INITIALIZER;
static struct host_cmd *queue;
static int q_len, q_cap;
static size_t q_bytes;
static uint32_t q_max_len;

static int read_full(void *p, size_t n) {
  uint8_t *b = p;
  while (n) {
    const compat_ssize r = compat_read(0, b, n);
    if (r == 0) return 0;
    if (r < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    b += r;
    n -= (size_t)r;
  }
  return 1;
}

static void push(struct host_cmd c) {
  for (;;) {
    pthread_mutex_lock(&q_lock);
    if (q_bytes < QUEUE_BYTES_MAX || !q_len) break;
    pthread_mutex_unlock(&q_lock);
    compat_sleep(0.001);
  }
  if (q_len == q_cap) {
    const int cap = q_cap ? q_cap * 2 : 256;
    struct host_cmd *b = realloc(queue, (size_t)cap * sizeof *b);
    if (!b) { // (out of memory: the command is lost – the host can't do better here)
      pthread_mutex_unlock(&q_lock);
      free(c.p);
      return;
    }
    queue = b, q_cap = cap;
  }
  queue[q_len++] = c;
  q_bytes += c.len;
  pthread_mutex_unlock(&q_lock);
}

static void *reader(void *arg) {
  (void)arg;
  for (;;) {
    uint32_t h[2];
    if (!read_full(h, 8) || h[1] > q_max_len) break;
    uint8_t *p = h[1] ? malloc(h[1]) : NULL;
    if (h[1] && (!p || !read_full(p, h[1]))) {
      free(p);
      break;
    }
    push((struct host_cmd){h[0], h[1], p});
  }
  push((struct host_cmd){CMD_QUIT, 0, NULL}); // souldew closed the pipe (or sent something that can't be a command)
  return NULL;
}

void host_start_reader(uint32_t max_len) {
  q_max_len = max_len;
  pthread_t t;
  if (pthread_create(&t, NULL, reader, NULL)) host_die("no command reader thread");
}

int host_take_commands(struct host_cmd *out, int cap) {
  pthread_mutex_lock(&q_lock);
  const int n = q_len < cap ? q_len : cap;
  for (int i = 0; i < n; i++) out[i] = queue[i], q_bytes -= queue[i].len;
  memmove(queue, queue + n, (size_t)(q_len - n) * sizeof *queue);
  q_len -= n;
  pthread_mutex_unlock(&q_lock);
  return n;
}

// ---- platform --------------------------------------------------------------------------------------------------------
double host_now(void) { return compat_now(); }
void host_sleep(double s) {
  if (s > 0) compat_sleep(s);
}
FILE *host_fopen(const char *path, const char *mode) { return compat_fopen(path, mode); }
char **host_utf8_argv(int *argc, char **argv) { return compat_utf8_argv(argc, argv); }

void *host_read_file(const char *path, size_t *n) {
  *n = 0;
  FILE *f = host_fopen(path, "rb");
  if (!f) return NULL;
  void *b = NULL;
  if (!fseek(f, 0, SEEK_END)) {
    const long len = ftell(f);
    if (len > 0 && !fseek(f, 0, SEEK_SET) && (b = malloc((size_t)len)) && fread(b, 1, (size_t)len, f) == (size_t)len) *n = (size_t)len;
    else free(b), b = NULL;
  }
  fclose(f);
  return b;
}

uint64_t host_fnv(uint64_t h, const void *p, size_t n) {
  const uint8_t *b = p;
  for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 1099511628211ull;
  return h;
}
