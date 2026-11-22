// The real link host (native/link-host, docs/MULTIPLAYER.md) on tiny ROMs made here: two linked Game Boys (SameBoy) and
// two linked GBAs (mGBA) run deterministically (the same hash twice), a whole-session state taken in the middle loads
// into a fresh host and goes on exactly as the session did (rejoin), the battery saves come out, the sound has a rate.
// Skipped when the link host isn't built (npm run native).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { linkTool } from '../server/lib/native.mjs';
import { startHost as startLinkHost } from '../scripts/link-drive.mjs';

const host = linkTool();
const skip = !host && 'link host not built (npm run native)';
const dir = mkdtempSync(join(tmpdir(), 'souldew-linkhost-'));
const started = []; // every host a test starts: none outlives the file, also when a test fails halfway
const startHost = (...a) => { const h = startLinkHost(...a); started.push(h.proc); return h; };
test.after(() => {
  for (const p of started) if (p.exitCode === null) p.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

/** A 32 KB Game Boy ROM (MBC1 + battery RAM) that counts 0xC000 up forever and copies it to the cartridge RAM. */
function gbRom() {
  const r = Buffer.alloc(0x8000);
  r.set([0x00, 0xc3, 0x50, 0x01], 0x100);
  r.set([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b], 0x104); // (the header bytes backend_sameboy.c's probe looks for)
  r.write('SOULDEWLINK', 0x134, 'latin1');
  r[0x147] = 0x03, r[0x148] = 0x00, r[0x149] = 0x02;
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - r[i] - 1) & 0xff;
  r[0x14d] = x;
  r.set([0x3e, 0x0a, 0xea, 0x00, 0x00, 0x21, 0x00, 0xc0, 0x34, 0x7e, 0xea, 0x00, 0xa0, 0x18, 0xf9], 0x150);
  return r;
}

/** A 64 KB GBA ROM: from the entry it jumps to a loop that counts a word in IWRAM up (no BIOS needed). */
function gbaRom() {
  const r = Buffer.alloc(0x10000);
  r.writeUInt32LE(0xea00002e, 0); // b 0xC0
  r.write('SOULDEWLINK', 0xa0, 'latin1');
  r[0xb2] = 0x96; // the fixed header byte
  let c = 0;
  for (let i = 0xa0; i <= 0xbc; i++) c = (c - r[i]) & 0xff;
  r[0xbd] = (c - 0x19) & 0xff;
  // ldr r0,=0x03000000 (pc-relative: [pc, #8]); loop: ldr r1,[r0]; add r1,r1,#1; str r1,[r0]; b loop; .word 0x03000000
  [0xe59f0008, 0xe5901000, 0xe2811001, 0xe5801000, 0xeafffffb, 0x03000000].forEach((w, i) => r.writeUInt32LE(w, 0xc0 + i * 4));
  return r;
}

const games = { gb: ['gb', gbRom()], gba: ['gba', gbaRom()] };
for (const [name, [ext, bytes]] of Object.entries(games)) writeFileSync(join(dir, `${name}.${ext}`), bytes);
const rom = (name) => join(dir, `${name}.${games[name][0]}`);

function bench(name, frames) {
  const r = spawnSync(host, ['--rom', rom(name), '--rom', rom(name), '--rtc', '1763200000000', '--bench', String(frames)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stderr.match(/bench: (\w+) (\w+), 2 seats, .* hash ([0-9a-f]{16})/);
  assert.ok(m, r.stderr);
  return { backend: m[1], system: m[2], hash: m[3] };
}

for (const name of Object.keys(games)) {
  test(`link host, two linked ${name.toUpperCase()}s: deterministic, the right backend`, { skip }, () => {
    const a = bench(name, 300);
    const b = bench(name, 300);
    assert.equal(a.backend, name === 'gb' ? 'sameboy' : 'mgba');
    assert.equal(a.system, name);
    assert.equal(a.hash, b.hash);
  });

  test(`link host, two linked ${name.toUpperCase()}s: a session state loads into a fresh host and goes on the same (rejoin)`, { skip }, async () => {
    const argv = ['--rom', rom(name), '--rom', rom(name), '--rtc', '1763200000000'];
    const hashes = (box) => (e) => e.event === 'hash' && (box[e.frame] = e.hash);
    const ha = {}, hb = {};
    const A = startHost(host, argv, { onEvent: hashes(ha) });
    const la = (await A.loaded).event;
    assert.equal(la.event, 'loaded');
    assert.ok(la.sampleRate > 0, 'the link host has sound');
    await A.step(130); // (the host also runs at real time meanwhile: the frame is the one the state says)
    const state = await A.saveState();
    assert.ok(state.length > 1000);
    const tail = state.lastIndexOf(Buffer.from('LSES', 'latin1')); // then the frame, then each seat's known buttons
    assert.ok(tail > 0 && tail + 8 + 4 * 2 <= state.length, 'the session tail');
    const at = state.readUInt32LE(tail + 4); // the frame it was taken at
    assert.ok(at >= 130 && at < 240, `state at frame ${at}`);
    // (UNTIL: an absolute frame – a host runs at 1× until a STEP arrives, so "n more frames" would race the start)
    const until = (h, f) => { const w = h.wait((m) => m.event?.event === 'stepped'); h.send(24, h.u32(f)); return w; };
    await until(A, 250);
    const sa = await A.flush(2);
    const file = join(dir, `${name}.state`);
    writeFileSync(file, state);
    const B = startHost(host, [...argv, '--load', file], { onEvent: hashes(hb) });
    const lb = (await B.loaded).event;
    assert.equal(lb.frame, at);
    await until(B, 250);
    const sb = await B.flush(2);
    assert.ok(ha[240] && ha[240] === hb[240], `hash at frame 240: ${ha[240]} / ${hb[240]}`);
    assert.ok(sa[0].equals(sb[0]) && sa[1].equals(sb[1]), 'the battery saves are the same');
    A.send(6), B.send(6);
    // a state of other games is refused
    const bad = join(dir, 'bad.state');
    writeFileSync(bad, readFileSync(file).subarray(0, 100));
    const r = spawnSync(host, [...argv, '--load', bad], { encoding: 'utf8', input: '' });
    assert.notEqual(r.status, 0);
  });
}

for (const name of Object.keys(games)) {
  test(`link host, ${name.toUpperCase()}: seamless – a session starts from the players' running games and hands each console back`, { skip }, () => {
    // a running game: --export writes every seat as the fast player's core saves it (here: the link host's own, at frame 200)
    const argv = ['--rom', rom(name), '--rom', rom(name), '--rtc', '1763200000000'];
    const exp = (tag, extra, frames) => {
      const d = join(dir, `exp-${name}-${tag}`);
      mkdirSync(d, { recursive: true });
      const r = spawnSync(host, [...extra, '--bench', String(frames), '--export', d], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return [0, 1].map((k) => readFileSync(join(d, `seat${k}.state`)));
    };
    const at200 = exp('200', argv, 200);
    assert.ok(at200[0].length > 1000);
    const states = at200.map((b, k) => { const f = join(dir, `${name}-seat${k}.state`); writeFileSync(f, b); return f; });
    // a session started from them (--state per seat) goes on from frame 200 – it doesn't boot
    const fromState = exp('from', ['--rom', rom(name), '--state', states[0], '--rom', rom(name), '--state', states[1], '--rtc', '1763200000000'], 1);
    const booted = exp('boot', argv, 1);
    assert.ok(!fromState[0].equals(booted[0]), 'not a fresh boot');
    if (name === 'gba') { // (mGBA's core state: the same as the session that ran on to frame 201 itself)
      const at201 = exp('201', argv, 201);
      assert.ok(fromState[0].subarray(0, 0x61000).equals(at201[0].subarray(0, 0x61000)), 'frame 201, as if the session had run all along');
    }
  });
}

test('link host, GB: each seat on its player\'s console – an original Game Boy linked with a Game Boy Color, the same everywhere', { skip }, () => {
  const run = () => spawnSync(host, ['--rom', rom('gb'), '--model', 'dmg', '--rom', rom('gb'), '--model', 'cgb', '--rtc', '1763200000000', '--bench', '300'], { encoding: 'utf8' });
  const [a, b] = [run(), run()];
  assert.equal(a.status, 0, a.stderr);
  const hash = (r) => r.stderr.match(/hash ([0-9a-f]{16})/)?.[1];
  assert.ok(hash(a) && hash(a) === hash(b), 'deterministic');
  const both = spawnSync(host, ['--rom', rom('gb'), '--rom', rom('gb'), '--rtc', '1763200000000', '--bench', '300'], { encoding: 'utf8' });
  assert.notEqual(hash(both), hash(a), 'two Game Boy Colors are another session');
});

test('link host: SEATSTATE hands the local seat\'s console over (the fast player goes on from it)', { skip }, async () => {
  const A = startHost(host, ['--rom', rom('gba'), '--rom', rom('gba'), '--rtc', '1763200000000', '--local', '1']);
  await A.loaded;
  await A.step(30);
  const got = A.wait((m) => m.type === 15);
  A.send(26, A.u32(10));
  const m = await got;
  assert.equal(m.payload.readUInt32LE(0), 1, 'the local seat');
  assert.ok(m.payload.length > 0x61000, 'its mGBA state (the libretro core\'s format)');
  A.send(6);
});

test('link host: NEED answers with the seat\'s buttons it knows', { skip }, async () => {
  const A = startHost(host, ['--rom', rom('gb'), '--rom', rom('gb'), '--net', '--delay', '4', '--local', '0', '--rtc', '1763200000000']);
  await A.loaded;
  const got = A.wait((m) => m.type === 12 && m.payload.readUInt32LE(0) === 0 && m.payload.readUInt32LE(4) === 0 && m.payload.length > 12);
  A.send(25, A.u32(0, 0)); // NEED seat 0 from frame 0 (the local seat: frames 0–3 are "nothing pressed", known)
  const m = await got;
  assert.ok((m.payload.length - 8) / 4 >= 4);
  A.send(6);
});

// ---- the DS (melonDS): a tiny homebrew cartridge – its ARM9 counts a word in main RAM up forever, its ARM7 waits ----------
function dsRom() {
  const r = Buffer.alloc(0x20000);
  r.write('SOULDEWLINK', 0, 'latin1'), r.write('####', 0x0c, 'latin1'), r.write('00', 0x10, 'latin1');
  const w = (o, v) => r.writeUInt32LE(v >>> 0, o);
  w(0x20, 0x200), w(0x24, 0x02000000), w(0x28, 0x02000000), w(0x2c, 0x100); // ARM9: ROM offset, entry, RAM address, size
  w(0x30, 0x400), w(0x34, 0x02380000), w(0x38, 0x02380000), w(0x3c, 0x100); // ARM7
  w(0x80, 0x20000), w(0x84, 0x4000);
  r[0x15c] = 0x56, r[0x15d] = 0xcf; // (the logo CRC backend_melonds.cpp's probe looks for)
  let crc = 0xffff;
  for (let i = 0; i < 0x15e; i++) { crc ^= r[i]; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1; }
  r.writeUInt16LE(crc, 0x15e);
  // ldr r0,[pc,#12] (=0x02100000); loop: ldr r1,[r0]; add r1,r1,#1; str r1,[r0]; b loop; .word 0x02100000
  [0xe59f000c, 0xe5901000, 0xe2811001, 0xe5801000, 0xeafffffb, 0x02100000].forEach((x, i) => w(0x200 + i * 4, x));
  w(0x400, 0xeafffffe); // ARM7: b .
  return r;
}
const dsFile = join(dir, 'tiny.nds');
writeFileSync(dsFile, dsRom());

test('link host, DS: consoles that joined from games running for very different times both run from the first frame (3.0.0: the one on longer stood still – black)', { skip }, async () => {
  // two running games, as the fast player keeps them: one on for 60 frames, the other for 960 (the souldew engine alone
  // writes states in the fast player's format)
  const S = startHost(host, ['--solo', '--rom', dsFile]);
  await S.loaded;
  await S.step(60);
  const young = join(dir, 'ds-young.state');
  writeFileSync(young, await S.saveState());
  await S.step(900);
  const old = join(dir, 'ds-old.state');
  writeFileSync(old, await S.saveState());
  S.send(6);
  const run = async () => {
    const ev = [];
    const L = startHost(host, ['--rom', dsFile, '--state', old, '--rom', dsFile, '--state', young, '--rtc', '1763200000000'],
      { onEvent: (e) => (e.event === 'hash' || e.event === 'stuck') && ev.push(e) });
    await L.loaded;
    const count = async () => [(await L.read(0, 0x02100000, 4)).readUInt32LE(0), (await L.read(1, 0x02100000, 4)).readUInt32LE(0)];
    const before = await count();
    await L.step(720);
    const after = await count();
    L.send(6);
    return { ev, before, after };
  };
  const a = await run();
  // every 120 frames the hash carries each console's frames: both kept up with the session
  const hashes = a.ev.filter((e) => e.event === 'hash');
  assert.deepEqual(hashes.map((e) => e.frame), [120, 240, 360, 480, 600, 720]);
  for (const e of hashes) assert.deepEqual(e.done, [e.frame, e.frame], `frame ${e.frame}: ${e.done}`);
  assert.ok(!a.ev.some((e) => e.event === 'stuck'), 'nothing stuck');
  // both consoles ran all 720 frames – the same work each (the older one did not wait for the younger to catch up)
  const ran = [a.after[0] - a.before[0], a.after[1] - a.before[1]];
  assert.ok(ran[0] > 0 && Math.abs(ran[0] - ran[1]) < ran[1] / 50, `counted ${ran}`); // (± a frame: they start at different moments of it)
  // and the same on every computer
  const b = await run();
  assert.deepEqual(b.ev.map((e) => e.hash), a.ev.map((e) => e.hash));
});

test('link host, DS: a session state (with the session clock) loads into a fresh host and goes on the same (rejoin)', { skip }, async () => {
  const argv = ['--rom', dsFile, '--state', join(dir, 'ds-old.state'), '--rom', dsFile, '--state', join(dir, 'ds-young.state'), '--rtc', '1763200000000'];
  const hashes = (box) => (e) => e.event === 'hash' && (box[e.frame] = e.hash);
  const ha = {}, hb = {};
  const A = startHost(host, argv, { onEvent: hashes(ha) });
  await A.loaded;
  await A.step(130);
  const state = await A.saveState();
  assert.ok(state.length > 1000, 'every console at its frame end: a state now');
  const tail = state.lastIndexOf(Buffer.from('LSES', 'latin1'));
  const at = state.readUInt32LE(tail + 4);
  assert.ok(state.indexOf(Buffer.from('LMP2', 'latin1')) > 0, 'the wireless part with the session clock');
  const until = (h, f) => { const w = h.wait((m) => m.event?.event === 'stepped'); h.send(24, h.u32(f)); return w; };
  await until(A, 370);
  const file = join(dir, 'ds.session');
  writeFileSync(file, state);
  const B = startHost(host, [...argv, '--load', file], { onEvent: hashes(hb) });
  assert.equal((await B.loaded).event.frame, at);
  await until(B, 370);
  assert.ok(ha[360] && ha[360] === hb[360], `hash at frame 360: ${ha[360]} / ${hb[360]}`);
  A.send(6), B.send(6);
});

test('the link host build is there when the native part is (npm run native builds it)', { skip }, () => {
  assert.ok(existsSync(host));
});
