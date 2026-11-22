// The link host's DS backend: N Nintendo DS consoles (melonDS's core library, no frontend) in ONE process, joined by
// an in-process DS local-wireless ("MP") layer that is deterministic – the engine behind Union Room / Pokémon Center
// trades and battles in Pokémon Diamond/Pearl/Platinum, HeartGold/SoulSilver, Black/White, Black 2/White 2 (and any
// other DS game's local wireless play). See docs/MULTIPLAYER.md › "DS backend".
//
// How melonDS itself links consoles (src/net/LocalMP.cpp): every instance runs on its own thread at its own pace; the
// emulated Wi-Fi chip (src/Wifi.cpp) hands 802.11 frames to Platform::MP_* and, while a MP exchange is going on, BLOCKS
// (wall clock, 25 ms timeouts) – the host waits for the clients' replies after a CMD frame, a client waits for the
// host's next frame. Which packet a console sees when depends on thread timing: fine on one computer, hopeless for
// lockstep netplay, where every peer must compute the same thing.
//
// This backend keeps melonDS's MP protocol and replaces the timing with a conservative discrete-event schedule over
// the consoles' own emulated clocks (NDS::SysTimestamp, 33.5 MHz):
//   - Each console still runs on its own thread (Wifi.cpp blocks deep inside NDS::RunFrame, so a console must be able
//     to stop mid-frame), but only ONE thread runs at a time: a baton is passed at every MP call and at every frame end.
//   - The baton always goes to the console with the smallest virtual time: its clock when it is ready to run, its
//     timeout horizon when it waits for a packet, its frame end when it finished the session frame. Ties: ready before
//     waiting before done, then the lower seat. A waiting console is woken by a matching packet or times out once
//     every other console passed its horizon (an emulated timeout instead of melonDS's 25 ms of wall clock).
//   - A packet carries its sender's clock; a non-blocking receive only sees packets sent at or before the receiver's
//     clock, a blocking one those sent before its horizon. Every decision depends only on emulated state, so the same
//     ROMs + saves + start time + per-frame inputs give the same consoles on every peer (and the same as a re-run).
//   - "Clock" is a console's session clock: its emulated time since the session began (SysTimestamp minus what it was
//     at the start). Consoles that join from the players' running games have been on for very different times
//     (minutes apart, more with fast-forward) – on their own clocks the one on longest would stand still until the
//     others caught up with it, and its player would see nothing but black (souldew 3.0.0, Union Room trades).
// run_frame() runs the schedule until every console finished the session frame – or still waits for a packet past
// another console's frame end (then it simply carries on in the next run_frame; consoles stay within a frame of each
// other).
//
// No Nintendo BIOS or firmware: melonDS's FreeBIOS and a generated firmware (per seat: own MAC address and nickname –
// two consoles with one MAC can't talk) – the games' wireless code lives in the cartridge's ARM7 binary.
//
// Alone (the souldew engine's solo seat, link_open.solo) the console is set up as the fast player's melonDS DS: the JIT
// on, the 3D picture drawn on its own thread, melonDS DS's firmware (its default MAC, the nickname "melonDS DS") and the
// computer's local time. Nothing there has to match another computer; a link session re-forms the consoles from their
// states with the interpreter and the per-seat firmware before anyone links.
#include <NDS.h>
#include <NDSCart.h>
#include <Platform.h>
#include <Savestate.h>
#include <SPI_Firmware.h>
#include <Args.h>
#include <FreeBIOS.h>
#include <GPU.h>
#include <GPU3D_Soft.h>

#include <atomic>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include "linkbackend.h"
}
#include "../common/hostio.h"

using namespace melonDS;

namespace {

constexpr u64 kClock = 33513982;               // NDS system clock (Hz)
constexpr u64 kFrameCycles = 560190;           // 263 lines × 2130 cycles
constexpr u64 kWaitCycles = kClock / 1000 * 4; // how long a blocking MP receive waits (emulated): 4 ms

/** NDS with its scheduler clock readable (protected in melonDS). */
struct LinkNDS : public NDS {
  LinkNDS(NDSArgs &&args, void *user) : NDS(std::move(args), user) {}
  u64 Now() const { return SysTimestamp; }
  /** The Wi-Fi chip is powered (POWCNT2 bit 1 and W_POWER_US) – as melonDS's Wifi::UpdatePowerOn decides it. */
  bool WifiOn() { return (PowerControl7 & 0x0002) && !(Wifi.Read(0x04808036) & 1); }
};

struct Packet {
  int sender;
  u32 type; // 0 regular, 1 CMD, 2 reply (aid in bits 16+), 3 ack – LocalMP's numbering
  u64 sent;    // sender's SysTimestamp
  u64 wifiTs;  // sender's Wi-Fi µs timestamp (what melonDS passes along)
  std::vector<u8> data;
};

enum class St { Done, Ready, Waiting, Running };

struct Seat {
  int index = 0;
  std::unique_ptr<LinkNDS> nds;
  std::thread thread;
  St st = St::Done;
  u64 base = 0;    // SysTimestamp when the session began: the session's clock is SysTimestamp − base
  u64 t = 0;       // clock at the last yield
  u64 horizon = 0; // Waiting: times out when every other console passed this
  bool woken = false;
  int waitKind = 0; // 1 host packet, 2 replies
  std::deque<Packet> rx, replies;
  bool connected = false; // between MP_Begin and MP_End (the Wi-Fi chip is on)
  u32 frames = 0;         // frames finished (in this session)
  std::deque<link_input> inputs; // inputs for the frames not started yet (front = next)
  link_input cur = 0;
  std::vector<u32> video; // 256 × 384, top screen above the bottom one (0x00BBGGRR)
  std::vector<u8> sram;
  std::vector<u8> stateCache;
};

int nseats;
Seat seats[LINK_MAX_SEATS];
std::mutex lock;
std::condition_variable cv;
int baton = -1;       // which seat runs; -1 = the caller of run_frame
bool quitting = false;
bool solo = false;    // one console alone (see the header)
int lastHost = -1;    // the seat that sent the last CMD frame (LocalMP's LastHostID)

/** Pick the console that runs next (lock held). Returns -1 when the session frame is over. */
int pick(int *doneBest = nullptr) {
  int best = -1;
  u64 bv = 0;
  int bp = 0;
  for (int i = 0; i < nseats; i++) {
    Seat &s = seats[i];
    u64 v;
    int p;
    switch (s.st) {
    case St::Ready: v = s.t, p = 0; break;
    case St::Waiting: v = s.woken ? s.t : s.horizon, p = s.woken ? 0 : 1; break;
    case St::Done: v = s.t, p = 2; break;
    default: continue;
    }
    if (best < 0 || v < bv || (v == bv && p < bp)) best = i, bv = v, bp = p;
  }
  if (doneBest) *doneBest = best >= 0 && seats[best].st == St::Done ? best : -1;
  if (best < 0 || seats[best].st == St::Done) return -1;
  return best;
}

/** Hand the baton on and wait until it comes back to `me` (lock held via `lk`). */
void yield(std::unique_lock<std::mutex> &lk, int me) {
  const int next = pick();
  if (next == me) {
    seats[me].st = St::Running;
    return;
  }
  baton = next;
  if (next >= 0) seats[next].st = St::Running;
  cv.notify_all();
  cv.wait(lk, [&] { return baton == me || quitting; });
}

Seat &seatOf(void *user) { return *static_cast<Seat *>(user); }
/** The seat's session clock (see the header). */
u64 clk(const Seat &s) { return s.nds->Now() - s.base; }

/** Wake waiting consoles that now have what they wait for (lock held). */
void wakeWaiters() {
  for (int i = 0; i < nseats; i++) {
    Seat &s = seats[i];
    if (s.st != St::Waiting || s.woken) continue;
    const auto &q = s.waitKind == 2 ? s.replies : s.rx;
    for (const Packet &p : q)
      if (p.sent <= s.horizon) { s.woken = true; break; }
  }
}

int send(void *user, u32 type, const u8 *data, int len, u64 wifiTs) {
  Seat &me = seatOf(user);
  std::unique_lock<std::mutex> lk(lock);
  me.t = clk(me);
  Packet p{me.index, type, me.t, wifiTs, std::vector<u8>(data, data + (len > 0 ? len : 0))};
  if ((type & 0xFFFF) == 1) { // a CMD: this console is the host now, older replies are void
    lastHost = me.index;
    me.replies.clear();
  }
  for (int i = 0; i < nseats; i++) {
    if (i == me.index || !seats[i].connected) continue;
    ((type & 0xFFFF) == 2 ? seats[i].replies : seats[i].rx).push_back(p);
  }
  wakeWaiters();
  me.st = St::Ready;
  yield(lk, me.index);
  return len;
}

/** Take the first packet of `q` sent no later than `limit`. */
std::optional<Packet> take(std::deque<Packet> &q, u64 limit) {
  for (auto it = q.begin(); it != q.end(); ++it)
    if (it->sent <= limit) {
      Packet p = std::move(*it);
      q.erase(it);
      return p;
    }
  return std::nullopt;
}

/** A blocking receive: first let everyone behind catch up, then wait (emulated) for a packet. */
std::optional<Packet> waitFor(Seat &me, std::unique_lock<std::mutex> &lk, int kind) {
  auto &q = kind == 2 ? me.replies : me.rx;
  me.t = clk(me);
  me.st = St::Ready;
  yield(lk, me.index);
  if (auto p = take(q, me.t + kWaitCycles)) return p;
  me.horizon = me.t + kWaitCycles;
  me.woken = false;
  me.waitKind = kind;
  me.st = St::Waiting;
  yield(lk, me.index);
  me.waitKind = 0;
  if (me.woken) {
    me.woken = false;
    return take(q, me.horizon);
  }
  return std::nullopt; // timed out
}

void seatMain(Seat *s) {
  std::unique_lock<std::mutex> lk(lock);
  for (;;) {
    cv.wait(lk, [&] { return baton == s->index || quitting; });
    if (quitting) return;
    // start the next frame with its inputs
    s->cur = s->inputs.empty() ? s->cur : s->inputs.front();
    if (!s->inputs.empty()) s->inputs.pop_front();
    const link_input in = s->cur;
    s->nds->SetKeyMask(~in & 0xFFF);
    if (in & LINK_TOUCH) s->nds->TouchScreen((in >> 16) & 0xFF, (in >> 24) & 0xFF);
    else s->nds->ReleaseScreen();
    lk.unlock();
    s->nds->RunFrame();
    lk.lock();
    void *top = nullptr, *bottom = nullptr;
    if (s->nds->GPU.GetFramebuffers(&top, &bottom) && top && bottom) {
      const u32 *a = static_cast<const u32 *>(top), *b = static_cast<const u32 *>(bottom);
      for (int i = 0; i < 256 * 192; i++) { // melonDS: 0x00RRGGBB → 0x00BBGGRR
        const u32 c = a[i], d = b[i];
        s->video[i] = ((c >> 16) & 0xFF) | (c & 0xFF00) | ((c & 0xFF) << 16);
        s->video[256 * 192 + i] = ((d >> 16) & 0xFF) | (d & 0xFF00) | ((d & 0xFF) << 16);
      }
    }
    s->frames++;
    s->t = clk(*s);
    s->st = St::Done;
      const int next = pick();
      baton = next;
    if (next >= 0) seats[next].st = St::Running;
    cv.notify_all();
  }
}

/** A seat's firmware: in a link session its own MAC and nickname; alone, the one melonDS DS (the fast player) generates
 *  with souldew's settings – melonDS's default MAC and the nickname "melonDS DS". */
Firmware makeFirmware(int seat) {
  Firmware fw(0);
  auto &h = fw.GetHeader();
  // a locally administered unicast MAC per seat: same on every peer, different between seats
  if (!solo) h.MacAddr = MacAddress{0x02, 0x50, 0x4b, 0x53, 0x44, static_cast<u8>(0x10 + seat)};
  auto &u = fw.GetEffectiveUserData();
  char name[11];
  snprintf(name, sizeof name, solo ? "melonDS DS" : "souldew%d", seat + 1);
  memset(u.Nickname, 0, sizeof u.Nickname);
  const size_t n = strlen(name);
  for (size_t i = 0; i < n; i++) u.Nickname[i] = static_cast<char16_t>(name[i]);
  u.NameLength = static_cast<u16>(n);
  u.Settings = (u.Settings & ~Firmware::Language::Reserved) | Firmware::Language::English;
  u.TouchCalibrationADC1[0] = 0, u.TouchCalibrationADC1[1] = 0;
  u.TouchCalibrationPixel1[0] = 0, u.TouchCalibrationPixel1[1] = 0;
  u.TouchCalibrationADC2[0] = 255 << 4, u.TouchCalibrationADC2[1] = 191 << 4;
  u.TouchCalibrationPixel2[0] = 255, u.TouchCalibrationPixel2[1] = 191;
  fw.UpdateChecksums();
  return fw;
}


// ---- backend -------------------------------------------------------------------------------------------------------
const char *d_system() { return "nds"; }

bool d_probe(const char *rom) {
  FILE *f = host_fopen(rom, "rb");
  if (!f) return false;
  u8 h[0x200];
  const size_t n = fread(h, 1, sizeof h, f);
  fclose(f);
  if (n < 0x160) return false;
  // the Nintendo logo's CRC16 in the header (0xCF56 on every licensed cartridge) and a plausible ARM9 entry
  return h[0x15C] == 0x56 && h[0x15D] == 0xCF;
}

/**
 * A DS cartridge is a power of two in size; a trimmed or patched ROM (Renegade Platinum: 104,923,028 bytes) isn't.
 * melonDS rounds the size up and reads past the end of the buffer – padded with 0xFF, as an unused cartridge area reads,
 * the game starts (the fast player's host does the same).
 */
void *padRom(void *rom, size_t *len) {
  if (!*len || !(*len & (*len - 1))) return rom;
  size_t want = 1;
  while (want < *len) want <<= 1;
  void *b = realloc(rom, want);
  if (!b) return rom;
  memset(static_cast<u8 *>(b) + *len, 0xff, want - *len);
  *len = want;
  return b;
}

bool d_open(const struct link_open *o) {
  const int n = o->n;
  if (n < 1 || n > LINK_MAX_SEATS) return false;
  nseats = n;
  solo = o->solo;
  // the consoles' clock: a link session's agreed start (UTC, the same on every peer); alone, the computer's local time
  // (as melonDS DS sets it)
  const time_t secs = solo ? time(nullptr) : static_cast<time_t>(o->rtc_ms / 1000);
  struct tm tm;
#ifdef _WIN32
  if (solo) localtime_s(&tm, &secs);
  else gmtime_s(&tm, &secs);
#else
  if (solo) localtime_r(&secs, &tm);
  else gmtime_r(&secs, &tm);
#endif
  for (int i = 0; i < n; i++) {
    const struct link_seat_config &cfg = o->seats[i];
    Seat &s = seats[i];
    s.index = i;
    s.video.assign(256 * 384, 0);
    size_t romLen = 0;
    void *rom = host_read_file(cfg.rom, &romLen);
    if (!rom) { host_log("ds: can't read %s", cfg.rom); return false; }
    rom = padRom(rom, &romLen);
    NDSArgs args{};
    args.Firmware = makeFirmware(i);
    // the JIT only alone: its timing differs from the interpreter's, and every peer of a link session must compute the
    // same (melonDS DS's settings: no fast memory)
    if (solo) args.JIT = JITArgs{32, true, true, false};
    else args.JIT = std::nullopt;
    s.nds = std::make_unique<LinkNDS>(std::move(args), &s);
    if (solo) { // (the fast player's software renderer: the 3D picture on a thread of its own)
      RendererSettings rs{1, true, false, false};
      s.nds->GetRenderer().SetRenderSettings(rs);
    }
    NDSCart::NDSCartArgs cart{};
    if (cfg.save && cfg.save_len) {
      cart.SRAM = std::make_unique<u8[]>(cfg.save_len);
      memcpy(cart.SRAM.get(), cfg.save, cfg.save_len);
      cart.SRAMLength = static_cast<u32>(cfg.save_len);
    }
    auto c = NDSCart::ParseROM(static_cast<const u8 *>(rom), static_cast<u32>(romLen), &s, std::move(cart));
    free(rom);
    if (!c) { host_log("ds: %s is not a DS game melonDS can load", cfg.rom); return false; }
    s.nds->SetNDSCart(std::move(c));
    s.nds->Reset();
    if (s.nds->NeedsDirectBoot()) s.nds->SetupDirectBoot("game.nds");
    s.nds->RTC.SetDateTime(tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
    s.nds->Start();
    const u8 *sv = s.nds->GetNDSSave();
    s.sram.assign(sv, sv + s.nds->GetNDSSaveLength());
    if (cfg.state) { // the player's running game (melonDS DS's state: melonDS's own format)
      std::vector<u8> copy(cfg.state, cfg.state + cfg.state_len); // (Savestate reads from a buffer it may touch)
      Savestate ss(copy.data(), static_cast<u32>(copy.size()), false);
      if (!s.nds->DoSavestate(&ss) || ss.Error) { host_log("ds: seat %d: state not loadable", i); return false; }
      const u8 *v = s.nds->GetNDSSave(); // (the battery save came back with the cartridge's state)
      if (v) s.sram.assign(v, v + s.nds->GetNDSSaveLength());
      // a game in the middle of its wireless (standing in the Union Room alone): melonDS powers the chip on from the
      // state without telling the platform (MP_Begin) – without this the console would never hear the others
      s.connected = s.nds->WifiOn();
    }
    s.base = s.nds->Now(); // (every console's session clock starts at 0, at its frame end)
    s.t = 0;
    s.st = St::Done;
  }
  for (int i = 0; i < n; i++) seats[i].thread = std::thread(seatMain, &seats[i]);
  host_log("ds: %d console(s), FreeBIOS + generated firmware, %s", n, solo ? "JIT" : "interpreter");
  return true;
}

/** Every console gone: their threads end (a console waiting mid-frame for a packet finishes its frame alone first). */
void d_close() {
  {
    std::lock_guard<std::mutex> g(lock);
    quitting = true;
  }
  cv.notify_all();
  for (int i = 0; i < LINK_MAX_SEATS; i++)
    if (seats[i].thread.joinable()) seats[i].thread.join();
  for (int i = 0; i < LINK_MAX_SEATS; i++) seats[i] = Seat{};
  std::lock_guard<std::mutex> g(lock);
  quitting = false;
  baton = -1;
  lastHost = -1;
  nseats = 0;
}

void d_set_input(int seat, link_input in) {
  if (seat < 0 || seat >= nseats) return;
  std::lock_guard<std::mutex> g(lock);
  seats[seat].inputs.push_back(in);
  while (seats[seat].inputs.size() > 8) seats[seat].inputs.pop_front();
}

/**
 * One session frame: every console finishes one more frame. A console that waits mid-frame for a packet times out only
 * once every other console passed its horizon – and the one that holds it back may already be at its frame end. That
 * one then starts its next frame right away (with its next buttons if they are queued, else the ones it holds), so the
 * waiting one can go on. (souldew 3.0.0 ended the session frame there instead: in a wireless exchange – the whole Union
 * Room – the consoles took turns finishing their frames, the games ran at half speed and the input queue overflowed.)
 * The order of everything the consoles do is the same either way; only the frames are counted out fairly.
 */
void d_run_frame() {
  std::unique_lock<std::mutex> lk(lock);
  u32 target[LINK_MAX_SEATS];
  for (int i = 0; i < nseats; i++) {
    target[i] = seats[i].frames + 1;
    if (seats[i].st == St::Done) seats[i].st = St::Ready; // the next frame (a console still waiting mid-frame goes on)
  }
  for (int ahead = 0;;) {
    int done = -1;
    const int next = pick(&done);
    if (next < 0) {
      bool all = true;
      for (int i = 0; i < nseats; i++) all = all && seats[i].frames >= target[i];
      // (a console never runs more than a few frames ahead: the others' waits end within 4 ms of emulated time)
      if (all || done < 0 || ++ahead > 3 * nseats) return;
      seats[done].st = St::Ready; // the console holding the others back starts its next frame now
      continue;
    }
    baton = next;
    seats[next].st = St::Running;
    cv.notify_all();
    cv.wait(lk, [&] { return baton == -1; });
  }
}

void d_video(int seat, const uint32_t **px, unsigned *w, unsigned *h, unsigned *stride) {
  *px = seats[seat].video.data();
  *w = 256, *h = 384, *stride = 256;
}

double d_fps() { return static_cast<double>(kClock) / kFrameCycles; }

size_t d_sram(int seat, void **out) {
  std::lock_guard<std::mutex> g(lock);
  const std::vector<u8> &s = seats[seat].sram;
  *out = malloc(s.size() ? s.size() : 1);
  if (!*out) return 0;
  memcpy(*out, s.data(), s.size());
  return s.size();
}

uint64_t d_hash(uint64_t h) {
  std::lock_guard<std::mutex> g(lock);
  for (int i = 0; i < nseats; i++) {
    LinkNDS &n = *seats[i].nds;
    h = host_fnv(h, n.MainRAM, n.MainRAMMask + 1);
    h = host_fnv(h, n.SharedWRAM, n.SharedWRAMSize);
    h = host_fnv(h, n.ARM7WRAM, n.ARM7WRAMSize);
    h = host_fnv(h, n.ARM9.R, sizeof n.ARM9.R);
    h = host_fnv(h, n.ARM7.R, sizeof n.ARM7.R);
    const u64 t = n.Now();
    h = host_fnv(h, &t, sizeof t);
  }
  return h;
}

uint8_t *d_mem(int seat, uint32_t addr, uint32_t len) {
  LinkNDS &n = *seats[seat].nds;
  if (addr >= 0x02000000 && addr < 0x03000000) {
    const u32 off = addr & n.MainRAMMask;
    if (off + len <= n.MainRAMMask + 1) return n.MainRAM + off;
  }
  return nullptr;
}
uint8_t d_read8(int seat, uint32_t addr) {
  uint8_t *p = d_mem(seat, addr, 1);
  return p ? *p : 0;
}
void d_write8(int seat, uint32_t addr, uint8_t v) {
  uint8_t *p = d_mem(seat, addr, 1);
  if (p) *p = v;
}

// Save states: only at a session frame boundary with every console at its frame end (a console waiting mid-frame for a
// packet lives on its thread's stack and can't be written down – then state_size is 0: "not now, try a later frame").
// A seat's state is melonDS's own, then its side of the wireless layer: whether its Wi-Fi is on, the packets queued for
// it (sent, not yet taken), the last buttons and who hosts the MP exchange – so a session can go on from a state in a
// fresh host (rejoin) in the middle of a Union Room visit, the same as on the peers that never stopped.
namespace mpstate {
void put(std::vector<u8> &b, const void *p, size_t n) { b.insert(b.end(), static_cast<const u8 *>(p), static_cast<const u8 *>(p) + n); }
template <class T> void put(std::vector<u8> &b, T v) { put(b, &v, sizeof v); }
void putQueue(std::vector<u8> &b, const std::deque<Packet> &q) {
  put<u32>(b, static_cast<u32>(q.size()));
  for (const Packet &p : q) {
    put<s32>(b, p.sender), put<u32>(b, p.type), put<u64>(b, p.sent), put<u64>(b, p.wifiTs), put<u32>(b, static_cast<u32>(p.data.size()));
    put(b, p.data.data(), p.data.size());
  }
}
struct Reader {
  const u8 *p, *end;
  bool ok = true;
  template <class T> T get() {
    T v{};
    if (end - p < static_cast<ptrdiff_t>(sizeof v)) { ok = false; return v; }
    memcpy(&v, p, sizeof v), p += sizeof v;
    return v;
  }
  bool queue(std::deque<Packet> &q) {
    q.clear();
    const u32 n = get<u32>();
    for (u32 i = 0; ok && i < n && i < 4096; i++) {
      Packet k;
      k.sender = get<s32>(), k.type = get<u32>(), k.sent = get<u64>(), k.wifiTs = get<u64>();
      const u32 len = get<u32>();
      if (!ok || len > 65536 || end - p < static_cast<ptrdiff_t>(len)) return ok = false;
      k.data.assign(p, p + len), p += len;
      q.push_back(std::move(k));
    }
    return ok;
  }
};
} // namespace mpstate

size_t d_state_size(int seat) {
  std::lock_guard<std::mutex> g(lock);
  Seat &me = seats[seat];
  me.stateCache.clear();
  for (int i = 0; i < nseats; i++)
    if (seats[i].st != St::Done) return 0; // a console waits mid-frame for a packet: no state now
  Savestate ss;
  if (!me.nds->DoSavestate(&ss) || ss.Error) return 0;
  ss.Finish();
  const u8 *b = static_cast<const u8 *>(ss.Buffer());
  me.stateCache.assign(b, b + ss.Length());
  using namespace mpstate;
  put(me.stateCache, "LMP2", 4); // (LMP1, souldew 3.0.0: no session clock – the consoles' own clocks were compared)
  put<u8>(me.stateCache, me.connected ? 1 : 0);
  put<u32>(me.stateCache, me.cur);
  put<s32>(me.stateCache, lastHost);
  put<u64>(me.stateCache, me.base);
  putQueue(me.stateCache, me.rx);
  putQueue(me.stateCache, me.replies);
  return me.stateCache.size();
}
/** The console as melonDS DS (the fast player's core, built on this melonDS) keeps it: melonDS's own state, without the
 *  wireless layer's part. Not while a console waits mid-frame for a packet. */
size_t d_export(int seat, void **out) {
  *out = nullptr;
  if (!d_state_size(seat)) return 0;
  std::lock_guard<std::mutex> g(lock);
  const std::vector<u8> &c = seats[seat].stateCache;
  u32 len = 0;
  if (c.size() < 16) return 0;
  memcpy(&len, c.data() + 8, 4); // ("MELN", u16 major, u16 minor, u32 length)
  if (len < 16 || len > c.size() || !(*out = malloc(len))) return 0;
  memcpy(*out, c.data(), len);
  return len;
}
bool d_save_state(int seat, void *out) {
  std::lock_guard<std::mutex> g(lock);
  if (seats[seat].stateCache.empty()) return false;
  memcpy(out, seats[seat].stateCache.data(), seats[seat].stateCache.size());
  return true;
}
/** A fast-player state (melonDS's own) into the running console – between frames only. */
bool d_import(int seat, const void *in, size_t len) {
  std::lock_guard<std::mutex> g(lock);
  for (int i = 0; i < nseats; i++)
    if (seats[i].st != St::Done) return false;
  const u8 *b = static_cast<const u8 *>(in);
  if (len < 16 || memcmp(b, "MELN", 4)) return false;
  Seat &me = seats[seat];
  std::vector<u8> copy(b, b + len);
  Savestate ss(copy.data(), static_cast<u32>(len), false);
  if (!me.nds->DoSavestate(&ss) || ss.Error) return false;
  me.base = me.nds->Now(), me.t = 0;
  me.connected = me.nds->WifiOn();
  me.inputs.clear();
  return true;
}

bool d_load_state(int seat, const void *in, size_t have) {
  std::lock_guard<std::mutex> g(lock);
  const u8 *b = static_cast<const u8 *>(in);
  u32 len = 0;
  if (have < 16) return false;
  memcpy(&len, b + 8, 4); // melonDS state header: "MELN", u16 major, u16 minor, u32 length
  if (memcmp(b, "MELN", 4) || len < 16 || len > have) return false;
  for (int i = 0; i < nseats; i++)
    if (seats[i].st != St::Done) return false; // (a console mid-frame: only between frames)
  Seat &me = seats[seat];
  std::vector<u8> copy(b, b + len);
  Savestate ss(copy.data(), len, false);
  if (!me.nds->DoSavestate(&ss) || ss.Error) return false;
  const u8 *sv = me.nds->GetNDSSave(); // (the battery save came back with the cartridge's state)
  if (sv) me.sram.assign(sv, sv + me.nds->GetNDSSaveLength());
  me.inputs.clear();
  mpstate::Reader r{b + len, b + have};
  const bool v2 = have - len >= 4 && !memcmp(b + len, "LMP2", 4);
  if (v2 || (have - len >= 4 && !memcmp(b + len, "LMP1", 4))) {
    r.p += 4;
    me.connected = r.get<u8>() != 0;
    me.cur = r.get<u32>();
    const s32 host = r.get<s32>();
    if (seat == 0) lastHost = host >= -1 && host < nseats ? host : -1;
    me.base = v2 ? r.get<u64>() : 0; // (the session clock as the peers have it – the queued packets carry it)
    me.t = clk(me);
    if (!r.queue(me.rx) || !r.queue(me.replies)) return false;
    return r.ok;
  }
  me.rx.clear(), me.replies.clear(); // (a state without the wireless part: the link drops)
  me.base = me.nds->Now(), me.t = 0;
  me.connected = me.nds->WifiOn();
  return true;
}

} // namespace

// Sound: melonDS's SPU output (48 kHz, resampled – the emulation is the same whether or not anyone reads it), read
// between frames when no console runs.
double d_sample_rate() { return 48000.0; }
size_t d_audio(int seat, int16_t *out, size_t max) {
  std::lock_guard<std::mutex> g(lock);
  SPU &spu = seats[seat].nds->SPU;
  const int avail = spu.GetOutputSize();
  const int n = avail < static_cast<int>(max) ? avail : static_cast<int>(max);
  return n > 0 ? static_cast<size_t>(spu.ReadOutput(out, n)) : 0;
}

// Shared World: the 3D depth of the seat's frame on screen (souldew's patch to melonDS, native/melonds-patch – the
// software renderer keeps it once its rendering is done, before the next frame's starts)
static int d_depth(int seat, int on, int x, int y, int w, int h, uint32_t *out) {
  if (seat < 0 || seat >= LINK_MAX_SEATS || !seats[seat].nds) return -1;
  auto *soft = dynamic_cast<melonDS::SoftRenderer3D *>(seats[seat].nds->GPU.GetRenderer().Souldew3D());
  if (!soft) return -1;
  soft->SouldewKeepDepth(on != 0);
  if (!on || !out) return 0;
  return soft->SouldewDepth(x, y, w, h, out);
}

static uint32_t d_frames(int seat) {
  std::lock_guard<std::mutex> g(lock);
  return seat >= 0 && seat < nseats ? seats[seat].frames : 0;
}

extern "C" const struct link_backend link_backend_melonds = {
    "melonds", d_system, d_probe, d_open, d_close, d_set_input, d_run_frame, d_video, d_fps, d_sram, d_hash,
    d_mem, d_read8, d_write8, d_state_size, d_save_state, d_load_state, d_sample_rate, d_audio,
    nullptr, d_export, d_import, d_depth, d_frames,
};

// ---- melonDS's platform layer (what the core asks of a frontend) ---------------------------------------------------
namespace melonDS::Platform {

void SignalStop(StopReason, void *) {}

struct FileHandle { FILE *f; };
static const char *modeString(FileMode m) {
  const bool r = (m & FileMode::Read) != FileMode::None, w = (m & FileMode::Write) != FileMode::None;
  const bool pre = (m & FileMode::Preserve) != FileMode::None;
  if (r && w) return pre ? "r+b" : "w+b";
  if (w) return (m & FileMode::Append) != FileMode::None ? "ab" : "wb";
  return "rb";
}
std::string GetLocalFilePath(const std::string &filename) { return filename; }
FileHandle *OpenFile(const std::string &path, FileMode mode) {
  if ((mode & FileMode::NoCreate) != FileMode::None) {
    FILE *t = host_fopen(path.c_str(), "rb");
    if (!t) return nullptr;
    fclose(t);
  }
  FILE *f = host_fopen(path.c_str(), modeString(mode));
  return f ? new FileHandle{f} : nullptr;
}
FileHandle *OpenLocalFile(const std::string &, FileMode) { return nullptr; } // no BIOS / firmware / config files
bool FileExists(const std::string &name) {
  FILE *f = host_fopen(name.c_str(), "rb");
  if (f) fclose(f);
  return f != nullptr;
}
bool LocalFileExists(const std::string &) { return false; }
bool CheckFileWritable(const std::string &) { return false; }
bool CheckLocalFileWritable(const std::string &) { return false; }
bool CloseFile(FileHandle *file) {
  const bool ok = fclose(file->f) == 0;
  delete file;
  return ok;
}
bool IsEndOfFile(FileHandle *file) { return feof(file->f) != 0; }
bool FileReadLine(char *str, int count, FileHandle *file) { return fgets(str, count, file->f) != nullptr; }
u64 FilePosition(FileHandle *file) { return static_cast<u64>(ftell(file->f)); }
bool FileSeek(FileHandle *file, s64 offset, FileSeekOrigin origin) {
  return fseek(file->f, offset, origin == FileSeekOrigin::Start ? SEEK_SET : origin == FileSeekOrigin::Current ? SEEK_CUR : SEEK_END) == 0;
}
void FileRewind(FileHandle *file) { rewind(file->f); }
u64 FileRead(void *data, u64 size, u64 count, FileHandle *file) { return fread(data, size, count, file->f); }
bool FileFlush(FileHandle *file) { return fflush(file->f) == 0; }
u64 FileWrite(const void *data, u64 size, u64 count, FileHandle *file) { return fwrite(data, size, count, file->f); }
u64 FileWriteFormatted(FileHandle *file, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  const int n = vfprintf(file->f, fmt, ap);
  va_end(ap);
  return n < 0 ? 0 : static_cast<u64>(n);
}
u64 FileLength(FileHandle *file) {
  const long pos = ftell(file->f);
  fseek(file->f, 0, SEEK_END);
  const long len = ftell(file->f);
  fseek(file->f, pos, SEEK_SET);
  return len < 0 ? 0 : static_cast<u64>(len);
}

void Log(LogLevel level, const char *fmt, ...) {
  if (level == LogLevel::Debug || level == LogLevel::Info) return; // (melonDS's chatter: only what went wrong)
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  size_t n = strlen(buf);
  while (n && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) buf[--n] = 0;
  if (n) host_log("melonDS: %s", buf);
}

struct Thread { std::thread t; };
Thread *Thread_Create(std::function<void()> func) { return new Thread{std::thread(std::move(func))}; }
void Thread_Free(Thread *thread) {
  if (thread->t.joinable()) thread->t.detach();
  delete thread;
}
void Thread_Wait(Thread *thread) {
  if (thread->t.joinable()) thread->t.join();
}

struct Semaphore {
  std::mutex m;
  std::condition_variable c;
  int count = 0;
};
Semaphore *Semaphore_Create() { return new Semaphore; }
void Semaphore_Free(Semaphore *s) { delete s; }
void Semaphore_Reset(Semaphore *s) {
  std::lock_guard<std::mutex> g(s->m);
  s->count = 0;
}
void Semaphore_Wait(Semaphore *s) {
  std::unique_lock<std::mutex> l(s->m);
  s->c.wait(l, [&] { return s->count > 0; });
  s->count--;
}
bool Semaphore_TryWait(Semaphore *s, int timeout_ms) {
  std::unique_lock<std::mutex> l(s->m);
  if (!s->c.wait_for(l, std::chrono::milliseconds(timeout_ms), [&] { return s->count > 0; })) return false;
  s->count--;
  return true;
}
void Semaphore_Post(Semaphore *s, int count) {
  {
    std::lock_guard<std::mutex> g(s->m);
    s->count += count;
  }
  s->c.notify_all();
}

struct Mutex { std::mutex m; };
Mutex *Mutex_Create() { return new Mutex; }
void Mutex_Free(Mutex *m) { delete m; }
void Mutex_Lock(Mutex *m) { m->m.lock(); }
void Mutex_Unlock(Mutex *m) { m->m.unlock(); }
bool Mutex_TryLock(Mutex *m) { return m->m.try_lock(); }

void Sleep(u64 usecs) { std::this_thread::sleep_for(std::chrono::microseconds(usecs)); }

void WriteNDSSave(const u8 *savedata, u32 savelen, u32, u32, void *userdata) {
  Seat &s = seatOf(userdata);
  std::vector<u8> copy(savedata, savedata + savelen);
  // (called on the console's own thread while it holds the baton: no other console runs)
  s.sram.swap(copy);
}
void WriteGBASave(const u8 *, u32, u32, u32, void *) {}
void WriteFirmware(const Firmware &, u32, u32, void *) {} // the generated firmware stays in memory
void WriteDateTime(int, int, int, int, int, int, void *) {}

// ---- local wireless --------------------------------------------------------------------------------------------
void MP_Begin(void *userdata) {
  std::lock_guard<std::mutex> g(lock);
  Seat &s = seatOf(userdata);
  s.connected = true;
  s.rx.clear(), s.replies.clear();
}
void MP_End(void *userdata) {
  std::lock_guard<std::mutex> g(lock);
  seatOf(userdata).connected = false;
}
int MP_SendPacket(u8 *data, int len, u64 timestamp, void *userdata) { return send(userdata, 0, data, len, timestamp); }
int MP_SendCmd(u8 *data, int len, u64 timestamp, void *userdata) { return send(userdata, 1, data, len, timestamp); }
int MP_SendReply(u8 *data, int len, u64 timestamp, u16 aid, void *userdata) {
  return send(userdata, 2u | (static_cast<u32>(aid) << 16), data, len, timestamp);
}
int MP_SendAck(u8 *data, int len, u64 timestamp, void *userdata) { return send(userdata, 3, data, len, timestamp); }

int MP_RecvPacket(u8 *data, u64 *timestamp, void *userdata) {
  Seat &me = seatOf(userdata);
  std::unique_lock<std::mutex> lk(lock);
  me.t = clk(me);
  me.st = St::Ready;
  yield(lk, me.index); // everyone behind this clock first: then every packet sent up to it is here
  auto p = take(me.rx, me.t);
  if (!p) return 0;
  if (p->type == 1) lastHost = p->sender;
  memcpy(data, p->data.data(), p->data.size());
  if (timestamp) *timestamp = p->wifiTs;
  return static_cast<int>(p->data.size());
}

int MP_RecvHostPacket(u8 *data, u64 *timestamp, void *userdata) {
  Seat &me = seatOf(userdata);
  std::unique_lock<std::mutex> lk(lock);
  if (lastHost >= 0 && !seats[lastHost].connected) return -1; // the host is gone
  auto p = waitFor(me, lk, 1);
  if (!p) return 0;
  if (p->type == 1) lastHost = p->sender;
  memcpy(data, p->data.data(), p->data.size());
  if (timestamp) *timestamp = p->wifiTs;
  return static_cast<int>(p->data.size());
}

u16 MP_RecvReplies(u8 *data, u64 timestamp, u16 aidmask, void *userdata) {
  Seat &me = seatOf(userdata);
  std::unique_lock<std::mutex> lk(lock);
  u16 others = 0, got = 0, ret = 0;
  for (int i = 0; i < nseats; i++)
    if (i != me.index && seats[i].connected) others |= 1 << i;
  if (!others) return 0;
  for (;;) {
    auto p = waitFor(me, lk, 2);
    if (!p) return ret;
    if (p->wifiTs + 32 < timestamp) continue; // stale
    const u32 aid = p->type >> 16;
    if (!p->data.empty() && aid >= 1 && aid <= 15) {
      memcpy(&data[(aid - 1) * 1024], p->data.data(), std::min<size_t>(p->data.size(), 1024));
      ret |= 1 << aid;
    }
    got |= 1 << p->sender;
    if ((got & others) == others || (ret & aidmask) == aidmask) return ret;
  }
}

int Net_SendPacket(u8 *, int len, void *) { return len; } // no infrastructure Wi-Fi in link sessions
int Net_RecvPacket(u8 *, void *) { return 0; }

void Camera_Start(int, void *) {}
void Camera_Stop(int, void *) {}
void Camera_CaptureFrame(int, u32 *frame, int width, int height, bool, void *) { memset(frame, 0, sizeof(u32) * width * height); }
void Mic_Start(void *) {}
void Mic_Stop(void *) {}
int Mic_ReadInput(s16 *data, int maxlength, void *) {
  memset(data, 0, sizeof(s16) * maxlength);
  return maxlength;
}
AACDecoder *AAC_Init() { return nullptr; }
void AAC_DeInit(AACDecoder *) {}
bool AAC_Configure(AACDecoder *, int, int) { return false; }
bool AAC_DecodeFrame(AACDecoder *, const void *, int, void *, int) { return false; }
bool Addon_KeyDown(KeyType, void *) { return false; }
void Addon_RumbleStart(u32, void *) {}
void Addon_RumbleStop(void *) {}
float Addon_MotionQuery(MotionQueryType, void *) { return 0; }
DynamicLibrary *DynamicLibrary_Load(const char *) { return nullptr; }
void DynamicLibrary_Unload(DynamicLibrary *) {}
void *DynamicLibrary_LoadFunction(DynamicLibrary *, const char *) { return nullptr; }

} // namespace melonDS::Platform
