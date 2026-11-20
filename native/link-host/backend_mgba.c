// Link backend on libmgba: Game Boy Advance seats joined by mGBA's lockstep SIO driver (link cable, multiplayer and
// normal modes – Gen 3 Cable Club trades and battles, up to 4 seats), or two Game Boy / Game Boy Color seats joined by
// its GB serial lockstep (Gen 1/2 Cable Club). All seats run in this thread: the drivers' sleep/wake only set flags,
// and the scheduler runs whoever is awake, event by event, in a fixed order – deterministic by construction.
#include "linkbackend.h"
#include "../common/hostio.h"

#include <mgba/flags.h>
#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/interface.h>
#include <mgba/core/lockstep.h>
#include <mgba/core/log.h>
#include <mgba/core/serialize.h>
#include <mgba/gba/interface.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/sio/lockstep.h>
#include <mgba/internal/gb/gb.h>
#include <mgba/internal/gb/sio/lockstep.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/vfs.h>

#include <fcntl.h>
#include <stdlib.h>
#include <string.h>

static int nseats;
static bool linked; // the seats are joined by a lockstep driver (two or more)
static enum mPlatform platform;
static struct mseat {
  struct mCore *core;
  uint32_t *video;
  unsigned w, h;
  int asleep;         // the lockstep driver put this console to sleep: it waits for the others
  int32_t posted;     // GB lockstep: cycles the primary allowed this one to run
  uint32_t wait_mask; // GB lockstep (primary): which secondaries it waits for
} seats[LINK_MAX_SEATS];

// GBA: the coordinator and one driver per console; sleep/wake set the flag the scheduler honours
static struct GBASIOLockstepCoordinator gba_coord;
static struct GBASIOLockstepDriver gba_drv[LINK_MAX_SEATS];
static struct seat_user { struct mLockstepUser d; int seat; } users[LINK_MAX_SEATS];
static void user_sleep(struct mLockstepUser *u) { seats[((struct seat_user *)u)->seat].asleep = 1; }
static void user_wake(struct mLockstepUser *u) { seats[((struct seat_user *)u)->seat].asleep = 0; }
static int user_requested_id(struct mLockstepUser *u) { return ((struct seat_user *)u)->seat; }

// GB: the older mLockstep with signal/wait/cycle budgets, driven as mGBA's own MultiplayerController does – with flags
// in place of thread pauses
static struct GBSIOLockstep gb_lock;
static struct GBSIOLockstepNode gb_node[LINK_MAX_SEATS];
static bool gb_signal(struct mLockstep *l, unsigned mask) {
  (void)l;
  struct mseat *p = &seats[0];
  p->wait_mask &= ~mask;
  if (!p->wait_mask && p->asleep) { p->asleep = 0; return true; }
  return false;
}
static bool gb_wait(struct mLockstep *l, unsigned mask) {
  (void)l;
  struct mseat *p = &seats[0];
  p->wait_mask |= mask;
  if (!p->asleep) { p->asleep = 1; return true; }
  return false;
}
static void gb_add_cycles(struct mLockstep *l, int id, int32_t cycles) {
  (void)l;
  if (cycles < 0) return;
  if (!id) {
    struct mseat *p = &seats[1];
    p->posted += cycles;
    if (p->asleep) gb_node[1].nextEvent += p->posted;
    p->asleep = 0;
  } else seats[id].posted += cycles;
}
static int32_t gb_use_cycles(struct mLockstep *l, int id, int32_t cycles) {
  (void)l;
  struct mseat *p = &seats[id];
  p->posted -= cycles;
  if (p->posted <= 0) p->asleep = 1;
  return p->posted;
}
static int32_t gb_unused_cycles(struct mLockstep *l, int id) { (void)l; return seats[id].posted; }
static void gb_unload(struct mLockstep *l, int id) {
  (void)l;
  if (id) {
    seats[id].posted = 0;
    seats[0].wait_mask &= ~(1u << id);
    if (!seats[0].wait_mask) seats[0].asleep = 0;
  } else {
    for (int i = 1; i < nseats; i++) {
      seats[i].posted += gb_lock.players[0]->eventDiff;
      if (seats[i].asleep) gb_node[i].nextEvent += seats[i].posted;
      seats[i].asleep = 0;
    }
  }
}

// mGBA's own log: only what went badly wrong (it logs every DMA otherwise)
static void core_log(struct mLogger *l, int category, enum mLogLevel level, const char *fmt, va_list ap) {
  (void)l, (void)category;
  if (!(level & (mLOG_FATAL | mLOG_ERROR))) return;
  char buf[512];
  vsnprintf(buf, sizeof buf, fmt, ap);
  host_log("[mGBA] %s", buf);
}
static struct mLogger logger = {core_log, NULL};

static const char *m_system(void) { return platform == mPLATFORM_GBA ? "gba" : "gb"; }

static bool m_probe(const char *rom) {
  struct VFile *vf = VFileOpen(rom, O_RDONLY);
  if (!vf) return false;
  const enum mPlatform p = mCoreIsCompatible(vf);
  vf->close(vf);
  return p == mPLATFORM_GBA || p == mPLATFORM_GB;
}

static bool solo; // one player's game alone: the computer's clock, the fast player's state format

/** The cartridge clock: alone it follows the computer's (as the fast player's mGBA); in a link session one shared start,
 *  then emulated time only (a real clock would differ between peers). */
static void set_clock(struct mCore *c, int64_t rtc_ms) {
  if (solo) {
    c->rtc.override = RTC_NO_OVERRIDE;
  } else {
    c->rtc.override = RTC_FAKE_EPOCH;
    c->rtc.value = rtc_ms;
  }
}

static bool m_open(const struct link_open *o) {
  mLogSetDefaultLogger(&logger);
  nseats = o->n;
  solo = o->solo;
  for (int s = 0; s < o->n; s++) {
    const struct link_seat_config *cfg = &o->seats[s];
    struct mseat *st = &seats[s];
    memset(st, 0, sizeof *st);
    st->core = mCoreFind(cfg->rom);
    if (!st->core) { host_log("seat %d: not a Game Boy / Game Boy Advance game", s); return false; }
    if (!s) platform = st->core->platform(st->core);
    else if (st->core->platform(st->core) != platform) { host_log("seat %d: another system than seat 0", s); return false; }
    if (!st->core->init(st->core)) { host_log("seat %d: the core didn't start", s); st->core = NULL; return false; }
    mCoreInitConfig(st->core, NULL);
    // (sound on for every seat alike – only the local seat's is played; volume only scales the output)
    struct mCoreOptions opts = {.useBios = false, .skipBios = true, .volume = 0x100, .mute = false};
    mCoreConfigLoadDefaults(&st->core->config, &opts);
    mCoreConfigSetDefaultValue(&st->core->config, "idleOptimization", "remove");
    mCoreLoadConfig(st->core);
    st->core->baseVideoSize(st->core, &st->w, &st->h);
    st->video = calloc((size_t)st->w * st->h, sizeof *st->video);
    st->core->setVideoBuffer(st->core, (void *)st->video, st->w);
    if (!mCoreLoadFile(st->core, cfg->rom)) { host_log("seat %d: the game didn't load", s); return false; }
    st->core->setAudioBufferSize(st->core, 4096);
    // the battery save in memory only – souldew gets it back through SRAM / SEATSRAM, nothing is written here
    st->core->loadSave(st->core, VFileMemChunk(cfg->save, cfg->save_len));
    set_clock(st->core, o->rtc_ms);
    st->core->reset(st->core);
    if (cfg->state) {
      // (the player's running game, from the fast player – mGBA's libretro core of this very commit: the same format)
      struct VFile *sf = VFileFromConstMemory(cfg->state, cfg->state_len);
      const bool ok = sf && mCoreLoadStateNamed(st->core, sf, SAVESTATE_SAVEDATA | SAVESTATE_RTC);
      if (sf) sf->close(sf);
      if (!ok) { host_log("seat %d: state not loadable", s); return false; }
      set_clock(st->core, o->rtc_ms); // (a state carries its own clock setting)
    }
  }
  if (o->n < 2) return true;
  if (platform == mPLATFORM_GBA) {
    GBASIOLockstepCoordinatorInit(&gba_coord);
    for (int s = 0; s < o->n; s++) {
      users[s] = (struct seat_user){{user_sleep, user_wake, user_requested_id, NULL}, s};
      GBASIOLockstepDriverCreate(&gba_drv[s], &users[s].d);
      GBASIOLockstepCoordinatorAttach(&gba_coord, &gba_drv[s]);
      seats[s].core->setPeripheral(seats[s].core, mPERIPH_GBA_LINK_PORT, &gba_drv[s].d);
    }
  } else {
    if (o->n > 2) { host_log("a Game Boy link cable joins two consoles"); return false; }
    GBSIOLockstepInit(&gb_lock);
    gb_lock.d.signal = gb_signal;
    gb_lock.d.wait = gb_wait;
    gb_lock.d.addCycles = gb_add_cycles;
    gb_lock.d.useCycles = gb_use_cycles;
    gb_lock.d.unusedCycles = gb_unused_cycles;
    gb_lock.d.unload = gb_unload;
    for (int s = 0; s < o->n; s++) {
      GBSIOLockstepNodeCreate(&gb_node[s]);
      GBSIOLockstepAttachNode(&gb_lock, &gb_node[s]);
      GBSIOSetDriver(&((struct GB *)seats[s].core->board)->sio, &gb_node[s].d);
    }
  }
  linked = true;
  return true;
}

/** Every console gone (the link first: its drivers point into the consoles). */
static void m_close(void) {
  if (linked && platform == mPLATFORM_GBA) {
    for (int s = 0; s < nseats; s++) {
      seats[s].core->setPeripheral(seats[s].core, mPERIPH_GBA_LINK_PORT, NULL);
      GBASIOLockstepCoordinatorDetach(&gba_coord, &gba_drv[s]);
    }
    GBASIOLockstepCoordinatorDeinit(&gba_coord);
  } else if (linked) {
    for (int s = 0; s < nseats; s++) {
      GBSIOSetDriver(&((struct GB *)seats[s].core->board)->sio, NULL);
      GBSIOLockstepDetachNode(&gb_lock, &gb_node[s]);
    }
    mLockstepDeinit(&gb_lock.d);
  }
  linked = false;
  for (int s = 0; s < LINK_MAX_SEATS; s++) {
    struct mseat *st = &seats[s];
    if (st->core) mCoreConfigDeinit(&st->core->config), st->core->deinit(st->core);
    free(st->video);
    memset(st, 0, sizeof *st);
  }
  nseats = 0;
}

static void m_set_input(int seat, link_input in) {
  seats[seat].core->setKeys(seats[seat].core, platform == mPLATFORM_GB ? in & 0xff : in & 0x3ff);
}

/**
 * Every console runs until it has started one more frame. A console the lockstep driver put to sleep waits; the
 * others run (event by event, `runLoop`) until it is woken. Consoles that finished the frame run on into the next one
 * while a slower one still needs them – all in a fixed order, so it is the same on every peer.
 */
static void m_run_frame(void) {
  uint32_t start[LINK_MAX_SEATS];
  for (int s = 0; s < nseats; s++) start[s] = seats[s].core->frameCounter(seats[s].core);
  for (long guard = 0;; guard++) {
    int behind = 0, ran = 0;
    for (int s = 0; s < nseats; s++) {
      struct mCore *c = seats[s].core;
      if (c->frameCounter(c) - start[s] >= 1) continue;
      behind = 1;
      if (seats[s].asleep) continue;
      c->runLoop(c);
      ran = 1;
    }
    if (!behind) break;
    if (!ran) { // the ones still behind sleep: whoever is awake runs on (it is what they wait for)
      for (int s = 0; s < nseats; s++) {
        if (seats[s].asleep) continue;
        seats[s].core->runLoop(seats[s].core);
        ran = 1;
      }
      // (can't happen with the lockstep driver's own rules; if it did, the session is broken for good: the log line
      // reaches the page, the host ends, the page sees the stream end – an abort, not a hang)
      if (!ran) { host_log("link: every console waits for another (deadlock)"); abort(); }
    }
    if (guard > 50000000) { host_log("link: a frame never ended"); abort(); }
  }
}

static void m_video(int seat, const uint32_t **px, unsigned *w, unsigned *h, unsigned *stride) {
  struct mseat *st = &seats[seat];
  unsigned cw = st->w, ch = st->h;
  st->core->currentVideoSize(st->core, &cw, &ch); // (a Game Boy draws 160×144 into the 256×224 Super Game Boy frame)
  *px = st->video, *w = cw, *h = ch, *stride = st->w;
}
static double m_fps(void) { return (double)seats[0].core->frequency(seats[0].core) / seats[0].core->frameCycles(seats[0].core); }
static size_t m_sram(int seat, void **out) { return seats[seat].core->savedataClone(seats[seat].core, out); }

static uint64_t m_hash(uint64_t h) {
  for (int s = 0; s < nseats; s++) {
    struct mCore *c = seats[s].core;
    if (platform == mPLATFORM_GBA) {
      struct GBA *gba = c->board;
      h = host_fnv(h, gba->memory.wram, GBA_SIZE_EWRAM);
      h = host_fnv(h, gba->memory.iwram, GBA_SIZE_IWRAM);
      h = host_fnv(h, gba->cpu->gprs, sizeof gba->cpu->gprs);
    } else {
      struct GB *gb = c->board;
      h = host_fnv(h, gb->memory.wram, GB_SIZE_WORKING_RAM);
      h = host_fnv(h, gb->memory.hram, GB_SIZE_HRAM);
    }
    int32_t t = mTimingCurrentTime(c->timing);
    h = host_fnv(h, &t, sizeof t);
  }
  return h;
}

static uint8_t *m_mem(int seat, uint32_t addr, uint32_t len) {
  struct mCore *core = seats[seat].core;
  const struct mCoreMemoryBlock *blocks;
  size_t n = core->listMemoryBlocks(core, &blocks);
  for (size_t i = 0; i < n; i++) {
    const struct mCoreMemoryBlock *b = &blocks[i];
    if (addr < b->start || (uint64_t)addr + len > (uint64_t)b->start + b->size) continue;
    size_t size = 0;
    uint8_t *p = core->getMemoryBlock(core, b->id, &size);
    if (p && (uint64_t)(addr - b->start) + len <= size) return p + (addr - b->start);
  }
  return NULL;
}
static uint8_t m_read8(int seat, uint32_t addr) { return (uint8_t)seats[seat].core->busRead8(seats[seat].core, addr); }
static void m_write8(int seat, uint32_t addr, uint8_t v) { seats[seat].core->busWrite8(seats[seat].core, addr, v); }
// Session states: the console's own state, then (GBA, linked) the lockstep driver's – its player, the events in flight
// and, for player 0, the coordinator – then the battery save's contents. mCore's plain saveState leaves the driver out
// (it is "extra" state) and the flash / EEPROM contents too, so a state loaded into a fresh host (a player rejoining)
// would meet a driver that knows nothing of the transfer in progress and wait forever, and an old battery save.
#define SIO_STATE_MAX 0x400
static bool linked_gba(void) { return platform == mPLATFORM_GBA && linked; }
static size_t save_size(int seat) {
  void *p = NULL;
  const size_t n = seats[seat].core->savedataClone(seats[seat].core, &p);
  free(p);
  return n;
}
static size_t m_state_size(int seat) {
  size_t n = seats[seat].core->stateSize(seats[seat].core);
  return n + (linked_gba() ? 4 + SIO_STATE_MAX : 0) + 4 + save_size(seat);
}
static bool m_save_state(int seat, void *out) {
  struct mCore *c = seats[seat].core;
  const size_t n = c->stateSize(c);
  if (!c->saveState(c, out)) return false;
  uint8_t *x = (uint8_t *)out + n;
  if (linked_gba()) {
    memset(x, 0, 4 + SIO_STATE_MAX);
    struct GBASIODriver *d = &gba_drv[seat].d;
    void *buf = NULL;
    size_t size = 0;
    d->saveState(d, &buf, &size);
    if (!buf || size > SIO_STATE_MAX) { free(buf); return false; }
    const uint32_t len = (uint32_t)size;
    memcpy(x, &len, 4);
    memcpy(x + 4, buf, size);
    free(buf);
    x += 4 + SIO_STATE_MAX;
  }
  void *sv = NULL;
  const uint32_t sn = (uint32_t)c->savedataClone(c, &sv);
  memcpy(x, &sn, 4);
  if (sn) memcpy(x + 4, sv, sn);
  free(sv);
  return true;
}
static bool m_load_state(int seat, const void *in, size_t len) {
  struct mCore *c = seats[seat].core;
  const size_t n = c->stateSize(c);
  if (len < n + 4) return false;
  const uint8_t *x = (const uint8_t *)in + n, *end = (const uint8_t *)in + len;
  const uint8_t *sio = NULL;
  uint32_t sio_len = 0;
  if (linked_gba()) {
    if (end - x < 4 + SIO_STATE_MAX) return false;
    memcpy(&sio_len, x, 4);
    if (!sio_len || sio_len > SIO_STATE_MAX) return false;
    sio = x + 4;
    x += 4 + SIO_STATE_MAX;
  }
  uint32_t sn;
  if (end - x < 4) return false;
  memcpy(&sn, x, 4);
  if ((size_t)(end - x - 4) != sn) return false;
  if (sn && !c->savedataRestore(c, x + 4, sn, false)) return false; // (the battery save first: loadState keeps it)
  if (!c->loadState(c, in)) return false;
  if (sio) {
    struct GBASIODriver *d = &gba_drv[seat].d;
    return d->loadState(d, sio, sio_len);
  }
  return true;
}

/**
 * The console as mGBA's libretro core keeps it (retro_serialize: the state with the battery save and the clock as extra
 * data). A link session's console goes back without the clock: the fast player's cartridge clock follows the computer's
 * again, not the session's.
 */
static size_t m_export(int seat, void **out) {
  *out = NULL;
  struct VFile *vf = VFileMemChunk(NULL, 0);
  if (!vf) return 0;
  size_t n = 0;
  if (mCoreSaveStateNamed(seats[seat].core, vf, SAVESTATE_SAVEDATA | (solo ? SAVESTATE_RTC : 0))) {
    n = (size_t)vf->size(vf);
    *out = n ? malloc(n) : NULL;
    vf->seek(vf, 0, SEEK_SET);
    if (!*out || (size_t)vf->read(vf, *out, n) != n) free(*out), *out = NULL, n = 0;
  }
  vf->close(vf);
  return n;
}
/** A fast-player state into the running console – as retro_unserialize: the clock comes along, the battery save stays
 *  what the game wrote last (an old save state never rolls the cartridge back). */
static bool m_import(int seat, const void *in, size_t len) {
  struct VFile *vf = VFileFromConstMemory(in, len);
  if (!vf) return false;
  const bool ok = mCoreLoadStateNamed(seats[seat].core, vf, SAVESTATE_RTC);
  vf->close(vf);
  return ok;
}

static double m_sample_rate(void) { return seats[0].core->audioSampleRate(seats[0].core); }
static size_t m_audio(int seat, int16_t *out, size_t max) {
  struct mAudioBuffer *b = seats[seat].core->getAudioBuffer(seats[seat].core);
  return b ? mAudioBufferRead(b, out, max) : 0;
}

const struct link_backend link_backend_mgba = {
  .name = "mgba", .system = m_system, .probe = m_probe, .open = m_open, .set_input = m_set_input, .run_frame = m_run_frame,
  .video = m_video, .fps = m_fps, .sram = m_sram, .hash = m_hash, .mem = m_mem, .read8 = m_read8, .write8 = m_write8,
  .state_size = m_state_size, .save_state = m_save_state, .load_state = m_load_state, .sample_rate = m_sample_rate, .audio = m_audio,
  .export_state = m_export, .import_state = m_import, .close = m_close,
};
