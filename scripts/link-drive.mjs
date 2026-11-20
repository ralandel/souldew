#!/usr/bin/env node
// A remote control for the link host (native/link-host): starts it with N consoles and serves a tiny HTTP API on
// 127.0.0.1, so a person (or a test) can walk both games to the Cable Club, look at screenshots and take the saves –
// a dev tool for making recordings and checking a backend (docs/MULTIPLAYER.md). Never commit ROMs, saves or screenshots.
//
//   node scripts/link-drive.mjs --host <linkhost> --port 7788 --rom a.gba --rom b.gba [--sram a.sav|-]… [--state s|-]…
//        [--rtc <unix ms>] [--record <file>]   (--record: every frame's buttons, for scripts/link-net-test.mjs)
//
//   GET /press?seat=0&keys=A,UP&hold=8&gap=8&times=1   hold the keys for `hold` frames, release for `gap`, `times` times
//                                                     (&touch=x,y: touch the DS touch screen there meanwhile)
//   GET /both?keys=A&hold=8&gap=8&times=1               the same on every seat at once
//   GET /step?n=60          run n frames (buttons as they are)
//   GET /shot?file=x.png    a picture of every seat side by side (PNG)
//   GET /read?seat=0&addr=0x2024284&len=16                hex bytes
//   GET /poke?seat=0&addr=..&hex=0102                     write bytes (test setup only)
//   GET /flush?dir=<dir>    every seat's battery save → <dir>/seat<k>.sav
//   GET /state?save=file | ?load=file                     all seats at once
//   GET /quit
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const host = opt('host');
const port = Number(opt('port', '7788'));
const roms = all('rom');
const hostArgs = [...roms.flatMap((r) => ['--rom', r]), ...all('sram').flatMap((s) => ['--sram', s]), ...all('state').flatMap((s) => ['--state', s])];
if (opt('rtc')) hostArgs.push('--rtc', opt('rtc'));
if (opt('record')) hostArgs.push('--record', opt('record'));

// RETRO_DEVICE_ID_JOYPAD_* bits
export const KEY = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };
export const bits = (keys) => String(keys || '').split(',').filter(Boolean).reduce((b, k) => b | (1 << KEY[k.trim().toUpperCase()]), 0);

/** A PNG of RGBA rows. */
export function png(w, h, rgba) {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8, ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The link host as a process with request/response helpers. */
export function startHost(hostPath, argv, { onEvent = () => {}, onMessage = () => {} } = {}) {
  const p = spawn(hostPath, argv, { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  const waiters = [];
  const frames = {};
  let viewSeat = 0;
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const type = buf.readUInt32LE(0), len = buf.readUInt32LE(4);
      if (buf.length < 8 + len) break;
      const payload = buf.subarray(8, 8 + len);
      buf = buf.subarray(8 + len);
      if (type === 2) frames[viewSeat] = Buffer.from(payload);
      const msg = { type, payload };
      if (type === 7) msg.event = JSON.parse(payload.toString());
      if (type === 7) onEvent(msg.event);
      if (type === 6) console.error('[host]', payload.toString());
      onMessage(msg);
      for (let i = 0; i < waiters.length; i++) if (waiters[i].test(msg)) { waiters[i].resolve(msg); waiters.splice(i--, 1); }
    }
  });
  const send = (type, payload = Buffer.alloc(0)) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(type, 0);
    h.writeUInt32LE(payload.length, 4);
    p.stdin.write(Buffer.concat([h, payload]));
  };
  const u32 = (...v) => {
    const b = Buffer.alloc(v.length * 4);
    v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4));
    return b;
  };
  const wait = (test, ms = 600000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('host timeout')); } }, ms);
    timer.unref?.(); // (a pending wait doesn't keep the process alive)
    const w = { test, resolve: (v) => { clearTimeout(timer); resolve(v); } };
    waiters.push(w);
  });
  const api = {
    proc: p, send, u32, wait, frames,
    loaded: wait((m) => m.event?.event === 'loaded' || m.event?.event === 'error'),
    async step(n) { const w = wait((m) => m.event?.event === 'stepped'); send(13, u32(n)); return w; },
    hold(seat, keyBits) { send(1, u32(keyBits, seat)); },
    async view(seat) { viewSeat = seat; const w = wait((m) => m.type === 2); send(20, u32(seat)); await w; return frames[seat]; },
    async read(seat, addr, len) { const w = wait((m) => m.type === 11 && m.payload.readUInt32LE(0) === seat && m.payload.readUInt32LE(4) === addr); send(22, u32(seat, addr, len)); return (await w).payload.subarray(8); },
    poke(seat, addr, bytes) { send(23, Buffer.concat([u32(seat, addr), Buffer.from(bytes)])); },
    async flush(n) {
      const got = {};
      const w = new Promise((resolve) => { const t = (m) => { if (m.type === 14) { got[m.payload.readUInt32LE(0)] = Buffer.from(m.payload.subarray(4)); if (Object.keys(got).length === n) resolve(got); } return false; }; waiters.push({ test: t, resolve() {} }); });
      send(10);
      return w;
    },
    async saveState() { const w = wait((m) => m.type === 5); send(3); return (await w).payload; },
    async loadState(b) { const w = wait((m) => m.event?.event === 'stateLoaded'); send(4, b); return (await w).event.ok; },
  };
  return api;
}

/** Frames of every seat (RGB565 or BGRA) → one RGBA picture side by side. */
export function sideBySide(frameList) {
  const fs = frameList.filter(Boolean);
  const ws = fs.map((f) => f.readUInt16LE(0)), hs = fs.map((f) => f.readUInt16LE(2));
  const W = ws.reduce((a, b) => a + b + 4, -4), H = Math.max(...hs);
  const out = Buffer.alloc(W * H * 4, 40);
  let x0 = 0;
  fs.forEach((f, i) => {
    for (let y = 0; y < hs[i]; y++)
      for (let x = 0; x < ws[i]; x++) {
        const d = (y * W + x0 + x) * 4;
        if (f.readUInt32LE(4) === 2) { // RGB565
          const c = f.readUInt16LE(8 + (y * ws[i] + x) * 2);
          out[d] = (c >> 11) << 3, out[d + 1] = ((c >> 5) & 63) << 2, out[d + 2] = (c & 31) << 3, out[d + 3] = 255;
        } else {
          const s = 8 + (y * ws[i] + x) * 4;
          out[d] = f[s + 2], out[d + 1] = f[s + 1], out[d + 2] = f[s], out[d + 3] = 255;
        }
      }
    x0 += ws[i] + 4;
  });
  return { w: W, h: H, rgba: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const h = startHost(host, hostArgs);
  const loaded = await h.loaded;
  console.log(JSON.stringify(loaded.event));
  const n = roms.length;
  let queue = Promise.resolve();
  createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    queue = queue.then(async () => {
      try {
        let out = 'ok';
        const seats = u.pathname === '/both' ? [...Array(n).keys()] : [Number(q.seat || 0)];
        if (u.pathname === '/press' || u.pathname === '/both') {
          const hold = Number(q.hold || 8), gap = Number(q.gap || 8), times = Number(q.times || 1);
          for (let t = 0; t < times; t++) {
            // touch=x,y (DS): link_input's touch bits (linkhost passes bits 12–31 of a test's 8-byte INPUT through)
            const tb = q.touch ? ((1 << 12) | (Number(q.touch.split(',')[0]) << 16) | (Number(q.touch.split(',')[1]) << 24)) >>> 0 : 0;
            for (const s of seats) h.hold(s, (bits(q.keys) | tb) >>> 0);
            await h.step(hold);
            for (const s of seats) h.hold(s, 0);
            if (gap) await h.step(gap);
          }
        } else if (u.pathname === '/step') await h.step(Number(q.n || 1));
        else if (u.pathname === '/shot') {
          const fr = [];
          for (let s = 0; s < n; s++) fr.push(await h.view(s));
          const p = sideBySide(fr);
          writeFileSync(q.file, png(p.w, p.h, p.rgba));
          out = q.file;
        } else if (u.pathname === '/read') out = (await h.read(Number(q.seat || 0), Number(q.addr), Number(q.len || 16))).toString('hex');
        else if (u.pathname === '/poke') h.poke(Number(q.seat || 0), Number(q.addr), Buffer.from(q.hex, 'hex'));
        else if (u.pathname === '/flush') {
          const got = await h.flush(n);
          mkdirSync(q.dir, { recursive: true });
          out = Object.entries(got).map(([s, b]) => { const f = join(q.dir, `seat${s}.sav`); writeFileSync(f, b); return `${f} ${b.length}`; }).join('\n');
        } else if (u.pathname === '/state') {
          if (q.save) writeFileSync(q.save, await h.saveState());
          if (q.load) out = String(await h.loadState(readFileSync(q.load)));
        } else if (u.pathname === '/quit') { h.send(6); setTimeout(() => process.exit(0), 300); }
        res.end(out + '\n');
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e.stack || e));
      }
    });
  }).listen(port, '127.0.0.1', () => console.log(`link-drive on http://127.0.0.1:${port}`));
}
