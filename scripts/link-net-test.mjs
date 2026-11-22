#!/usr/bin/env node
// Network test of the link host (native/link-host): one link host per player in net mode – each running EVERY
// console – exchange only their player's buttons through a mesh relay that adds latency and jitter (ordered, reliable
// channels like WebRTC data channels). 2–4 peers. All must stay in step (equal RAM hashes every 120 frames) and end
// with the same battery saves; with a recording (linkhost --record) the result is also compared with the local
// session's saves. --random: every seat mashes buttons (a reproducible random recording) instead of a recording.
//
//   node scripts/link-net-test.mjs --host <linkhost> --rom a.gba --rom b.gba --sram a.sav --sram b.sav --rtc <ms>
//        --script <rec> --frames N [--rtt 80] [--jitter 10] [--delay auto|D] [--speed 1|max] [--out <dir>]
//        [--expect <dir with seat0.sav, seat1.sav>] [--random <seed>] [--state <seat0.state|-> …] (the seats from the
//        players' running games, the fast player's format) [--speeds 1,0.5] (each peer's own pace – a slow computer that
//        only manages half of real time; the others wait for it)
// Never commit ROMs or saves.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { startHost } from './link-drive.mjs';
import { linkDelay } from '../shared/link.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const roms = all('rom'), srams = all('sram'), states = all('state');
const frames = Number(opt('frames', '3000'));
const rtt = Number(opt('rtt', '80')), jitter = Number(opt('jitter', '10'));
// the input delay for this round trip (linkcable's rule of thumb: half the RTT with a margin, plus 3 frames)
const delay = opt('delay', 'auto') === 'auto' ? linkDelay(rtt) : Number(opt('delay')); // (the app's formula)
const speed = opt('speed', 'max') === 'max' ? 1000 : Number(opt('speed'));
const out = opt('out');
const N = roms.length;
let script = opt('script');
if (opt('random')) { // u32 frame + u32 input per seat, buttons held for a few frames at a time
  let x = Number(opt('random')) >>> 0 || 1;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const b = Buffer.alloc(frames * (4 + 4 * N));
  const held = new Array(N).fill(0);
  for (let f = 0; f < frames; f++) {
    b.writeUInt32LE(f, f * (4 + 4 * N));
    for (let s = 0; s < N; s++) {
      if (rnd() < 0.08) held[s] = rnd() < 0.4 ? 0 : 1 << Math.floor(rnd() * 10);
      b.writeUInt32LE(held[s], f * (4 + 4 * N) + 4 + 4 * s);
    }
  }
  script = join(opt('out') || '.', 'random.rec');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, b);
}

const hashes = Array.from({ length: N }, () => ({}));
const waits = new Array(N).fill(0), stuck = new Array(N).fill(0);
const hosts = [...Array(N).keys()].map((seat) => startHost(opt('host'), [
  ...roms.flatMap((r) => ['--rom', r]), ...srams.flatMap((s) => ['--sram', s]), ...states.flatMap((s) => ['--state', s]), '--rtc', opt('rtc', '1763150000000'),
  '--local', String(seat), '--net', '--delay', String(delay), ...(script ? ['--script', script] : []),
], {
  onEvent: (e) => {
    if (e.event === 'hash') hashes[seat][e.frame] = e.hash;
    if (e.event === 'wait') waits[seat]++;
    if (e.event === 'stuck') stuck[seat]++;
  },
  onMessage: (m) => { if (m.type === 12) relay(seat, m.payload); },
}));

// the "network": a mesh, every link in order, each message after rtt/2 ± jitter
const lastAt = {};
const chain = {};
let sent = 0, bytes = 0;
function relay(from, payload) {
  const p = Buffer.from(payload);
  for (let to = 0; to < N; to++) {
    if (to === from) continue;
    const k = `${from}>${to}`;
    const at = Math.max(lastAt[k] || 0, Date.now() + rtt / 2 + (Math.random() * 2 - 1) * jitter);
    lastAt[k] = at;
    sent++;
    bytes += payload.length;
    // (a timer per message, strictly in order – Node may fire timers of different lengths out of order)
    chain[k] = (chain[k] || Promise.resolve()).then(() => new Promise((res) => setTimeout(res, Math.max(0, at - Date.now())))).then(() => hosts[to].send(21, p));
  }
}

await Promise.all(hosts.map((h) => h.loaded));
const t0 = Date.now();
const f32 = (x) => Buffer.from(new Float32Array([x]).buffer);
const speeds = String(opt('speeds', '')).split(',').filter(Boolean).map(Number);
hosts.forEach((h, k) => h.send(2, f32(speeds[k] > 0 ? speeds[k] : speed)));
const slowest = Math.min(...hosts.map((_, k) => (speeds[k] > 0 ? speeds[k] : speed)));
const limit = Math.max(600000, (frames / 60 / Math.min(slowest, 1)) * 2000); // (a slow peer takes its time – the others wait for it)
await Promise.all(hosts.map((h) => { const w = h.wait((m) => m.event?.event === 'stepped', limit); h.send(24, h.u32(frames)); return w; }));
const dt = (Date.now() - t0) / 1000;
const saves = await Promise.all(hosts.map((h) => h.flush(roms.length)));
for (const h of hosts) h.send(6);

const common = Object.keys(hashes[0]).filter((f) => hashes.every((h) => f in h));
const bad = common.filter((f) => hashes.some((h) => h[f] !== hashes[0][f]));
const seats = [...Array(N).keys()];
const sameSaves = seats.every((p) => seats.every((s) => saves[p][s].equals(saves[0][s])));
let expectOk = null;
// (a Game Boy clock cartridge's save from the host carries the 48-byte clock footer: the battery RAM is compared)
if (opt('expect')) expectOk = seats.every((s) => { const e = readFileSync(join(opt('expect'), `seat${s}.sav`)); return e.equals(saves[0][s].subarray(0, e.length)); });
if (out) {
  mkdirSync(out, { recursive: true });
  for (const p of seats) for (const s of seats) writeFileSync(join(out, `peer${p}-seat${s}.sav`), saves[p][s]);
}
const res = {
  peers: N, frames, rtt, jitter, delay, speed: speed >= 1000 ? 'max' : speed, seconds: dt, fps: +(frames / dt).toFixed(1),
  hashChecks: common.length, hashMismatches: bad.length, firstMismatch: bad[0] ?? null, waitEvents: waits, stuckEvents: stuck,
  ...(speeds.length ? { speeds } : {}),
  messages: sent, bytesPerSecondPerPeer: Math.round(bytes / dt / N), savesEqualBetweenPeers: sameSaves, savesEqualToLocalSession: expectOk,
};
console.log(JSON.stringify(res, null, 2));
process.exit(bad.length || !sameSaves || expectOk === false || stuck.some(Boolean) ? 1 : 0);
