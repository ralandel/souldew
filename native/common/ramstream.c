// The game's memory for souldew's live tracking – see ramstream.h.
#include "ramstream.h"
#include "hostio.h"
#include "protocol.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BLOCK 1024

bool ram_add_arg(struct ram_stream *rs, const char *v) {
  if (rs->n >= RAM_MAX_REGIONS) return false;
  char *end = NULL;
  const unsigned long a = strtoul(v, &end, 0), n = end && *end == ':' ? strtoul(end + 1, NULL, 0) : 0;
  if (!n || n > 16u * 1024 * 1024 || (unsigned long long)a + n > 0xffffffffull) return false;
  rs->r[rs->n++] = (struct ram_region){(uint32_t)a, (uint32_t)n, NULL, NULL};
  rs->full = true;
  return true;
}

void ram_locate(struct ram_stream *rs, ram_locate_fn locate, void *ctx) {
  for (int i = 0; i < rs->n; i++) {
    struct ram_region *r = &rs->r[i];
    uint8_t *p = locate(i, r->addr, r->len, ctx);
    if (!p && r->ptr) host_log("memory region %08X+%X not found any more", r->addr, r->len);
    r->ptr = p;
    if (p && !r->shadow) r->shadow = calloc(1, r->len);
  }
}

void ram_resync(struct ram_stream *rs) { rs->full = true; }

void ram_send(struct ram_stream *rs) {
  size_t cap = 4;
  for (int i = 0; i < rs->n; i++) cap += rs->r[i].len + 8 * (rs->r[i].len / BLOCK + 1);
  if (cap > rs->msg_cap) {
    uint8_t *b = realloc(rs->msg, cap);
    if (!b) return;
    rs->msg = b, rs->msg_cap = cap;
  }
  uint8_t *p = rs->msg + 4;
  uint32_t count = 0;
  for (int i = 0; i < rs->n; i++) {
    struct ram_region *r = &rs->r[i];
    if (!r->ptr || !r->shadow) continue;
    uint32_t at = 0;
    while (at < r->len) {
      uint32_t n = r->len - at < BLOCK ? r->len - at : BLOCK;
      if (!rs->full && !memcmp(r->ptr + at, r->shadow + at, n)) {
        at += n;
        continue;
      }
      const uint32_t start = at; // a run of changed blocks: one entry
      while (at < r->len) {
        n = r->len - at < BLOCK ? r->len - at : BLOCK;
        if (!rs->full && !memcmp(r->ptr + at, r->shadow + at, n)) break;
        memcpy(r->shadow + at, r->ptr + at, n);
        at += n;
      }
      const uint32_t addr = r->addr + start, len = at - start;
      memcpy(p, &addr, 4), memcpy(p + 4, &len, 4), memcpy(p + 8, r->shadow + start, len);
      p += 8 + len;
      count++;
    }
  }
  rs->full = false;
  if (!count) return;
  memcpy(rs->msg, &count, 4);
  host_send(MSG_RAM, rs->msg, (uint32_t)(p - rs->msg));
}

/** The region holding all of addr…addr+len, or NULL. */
static struct ram_region *region_of(struct ram_stream *rs, uint32_t addr, uint32_t len) {
  for (int i = 0; i < rs->n; i++) {
    struct ram_region *r = &rs->r[i];
    if (r->ptr && addr >= r->addr && (uint64_t)addr + len <= (uint64_t)r->addr + r->len) return r;
  }
  return NULL;
}

bool ram_write(struct ram_stream *rs, uint32_t addr, const uint8_t *b, uint32_t len) {
  struct ram_region *r = len ? region_of(rs, addr, len) : NULL;
  if (!r) return false;
  memcpy(r->ptr + (addr - r->addr), b, len);
  return true;
}

bool ram_set_watch(struct ram_stream *rs, const uint8_t *p, uint32_t len) {
  if (len < 4) return false;
  uint32_t n, total = 0;
  memcpy(&n, p, 4);
  if (n > RAM_MAX_WATCH || len < 4 + 8 * n) return false;
  for (uint32_t i = 0; i < n; i++) {
    uint32_t l;
    memcpy(&l, p + 8 + 8 * i, 4);
    if (!l || l > RAM_MAX_WATCH_BYTES || (total += l) > RAM_MAX_WATCH_BYTES) return false;
  }
  for (uint32_t i = 0; i < n; i++) memcpy(&rs->watch[i].addr, p + 4 + 8 * i, 4), memcpy(&rs->watch[i].len, p + 8 + 8 * i, 4);
  rs->watch_n = (int)n;
  return true;
}

void ram_send_watched(struct ram_stream *rs, uint32_t frame) {
  if (!rs->watch_n) return;
  memcpy(rs->watched, &frame, 4);
  uint8_t *p = rs->watched + 4;
  for (int i = 0; i < rs->watch_n; i++) {
    const struct ram_region *r = region_of(rs, rs->watch[i].addr, rs->watch[i].len);
    if (r) memcpy(p, r->ptr + (rs->watch[i].addr - r->addr), rs->watch[i].len);
    else memset(p, 0, rs->watch[i].len);
    p += rs->watch[i].len;
  }
  host_send(MSG_WATCHED, rs->watched, (uint32_t)(p - rs->watched));
}

size_t ram_regions_json(const struct ram_stream *rs, char *out, size_t cap) {
  size_t o = 0;
  out[0] = 0;
  for (int i = 0; i < rs->n && o + 48 < cap; i++)
    o += (size_t)snprintf(out + o, cap - o, "%s{\"addr\":%u,\"len\":%u,\"ok\":%s}", i ? "," : "", rs->r[i].addr, rs->r[i].len, rs->r[i].ptr ? "true" : "false");
  return o;
}
