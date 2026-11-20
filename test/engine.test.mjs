// The souldew engine (native/link-host as the fast player, docs/MULTIPLAYER.md › "The souldew engine"): the server's
// engine sessions (arguments, the in-place link and back, a desync that doesn't stop the game) with a stand-in host –
// and, when the native part is built (npm run native), the real engine on tiny ROMs made here: everything the fast
// player's tests check on retrohost (RAM mirror, exact steps, cheats, save states, battery saves, the cartridge clock),
// WATCH, the fast-forward sound, save states that go both ways between retrohost and the engine, and a link session
// formed in place from two running games – the same consoles a fresh link host forms, each game alone again afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const DATA = mkdtempSync(join(tmpdir(), 'sls-engine-'));
process.env.SLS_DATA_DIR = DATA;
const { NCMD, NativeSessions, engineArgs, ENGINE_CMD, linkTool, nativeDirs, hostArgs } = await import('../server/lib/native.mjs');
const { command, splitMessages } = await import('../server/lib/ctr.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const u32 = (...v) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4));
  return b;
};
const f32 = (x) => Buffer.from(new Float32Array([x]).buffer);
const msg = (type, payload) => Buffer.concat([u32(type, payload.length), payload]);
const event = (e) => msg(7, Buffer.from(JSON.stringify(e)));

// ---- the server's engine sessions (a stand-in host) ---------------------------------------------------------------------
function fakeSpawn(calls) {
  return (exe, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGKILL');
    child.sent = [];
    child.stdin.on('data', (d) => child.sent.push(d));
    calls.push({ exe, args, child });
    return child;
  };
}
const sentTypes = (child) => splitMessages(Buffer.concat(child.sent)).messages;

test('engine sessions: started with --solo; a link joins the running game in place and leaves it the same way', async () => {
  const calls = [];
  const s = new NativeSessions({ spawn: fakeSpawn(calls) });
  const id = s.startNative({ rom: '/r/em.gba', key: 'k', system: 'gba', tools: { cores: {} }, engine: '/t/linkhost', save: Buffer.from([1, 2]) });
  const { exe, args, child } = calls[0];
  assert.equal(exe, '/t/linkhost');
  assert.deepEqual(args.slice(0, 3), ['--solo', '--rom', '/r/em.gba']);
  assert.ok(args.includes('--sram') && args.includes('--ram'));
  assert.deepEqual(engineArgs({ system: 'gb', rom: 'r', model: 'dmg' }).slice(3, 5), ['--model', 'dmg']);
  assert.throws(() => engineArgs({ system: '3ds', rom: 'r' }), { code: 'nativeSystem' });
  // a page may never send the engine's own commands
  assert.throws(() => s.send(id, command(ENGINE_CMD.LINK, Buffer.from('--rom\0x\0'))), { code: 'badCommand' });

  // a link session for the game that runs: the same process (CMD_LINK with the session's words), the same id
  const seats = [{ rom: '/r/em.gba', save: null, state: Buffer.from('A') }, { rom: '/r/sa.gba', save: Buffer.from([3]), state: Buffer.from('B') }];
  const started = s.startLink({ host: '/t/linkhost', system: 'gba', seats, local: 0, delay: 5, rtc: 1763200000000, key: 'run:me' });
  await new Promise((r) => setImmediate(r));
  const link = sentTypes(child).find((m) => m.type === ENGINE_CMD.LINK);
  assert.ok(link, 'CMD_LINK');
  const words = link.payload.toString().split('\0').filter(Boolean);
  assert.deepEqual(words.filter((w, i) => words[i - 1] === '--rom'), ['/r/em.gba', '/r/sa.gba']);
  assert.ok(words.includes('--net') && words[words.indexOf('--delay') + 1] === '5' && !words.includes('--ram'));
  child.stdout.write(event({ event: 'loaded', engine: true, mode: 'link', seats: 2, local: 0 }));
  assert.equal(await started, id);
  assert.equal(calls.length, 1, 'no new process');
  assert.ok(s.current.link);
  s.send(id, command(21, Buffer.concat([u32(1, 0), u32(0)]))); // (link commands are allowed now: a peer's buttons)
  assert.throws(() => s.send(id, command(NCMD.WRITE, Buffer.concat([u32(0x2000000), Buffer.from([1])]))), { code: 'badCommand' });

  // out of step: the game only stands still – it goes on from the snapshot right after (not stopped)
  assert.ok(s.linkRestore(id));
  assert.equal(s.current?.id, id);
  assert.ok(sentTypes(child).some((m) => m.type === NCMD.SPEED && m.payload.readFloatLE(0) === 0));

  // leaving: CMD_SOLO without words (the console as it is), the same id again
  const back = s.unlink(id);
  await new Promise((r) => setImmediate(r));
  const solo = sentTypes(child).filter((m) => m.type === ENGINE_CMD.SOLO);
  assert.equal(solo.length, 1);
  assert.equal(solo[0].payload.length, 0);
  child.stdout.write(event({ event: 'loaded', engine: true, mode: 'solo' }));
  assert.equal((await back).id, id);
  assert.equal(s.current.link, null);
  assert.equal(await s.unlink(id), null, 'not linked any more');

  // a link the engine refuses: an error for the page, the game goes on
  const refused = s.startLink({ host: '/t/linkhost', system: 'gba', seats, local: 0, delay: 5, rtc: 1, key: 'run:me' });
  await new Promise((r) => setImmediate(r));
  child.stdout.write(event({ event: 'linkRefused', message: 'x' }));
  await assert.rejects(refused, { code: 'linkRefused' });
  assert.equal(s.current.id, id);
  s.stop();
});

test('engine sessions: back from a link session started from the board – the link host goes on alone (state handed in)', async () => {
  const calls = [];
  const s = new NativeSessions({ spawn: fakeSpawn(calls) });
  const seats = [{ rom: '/r/red.gb', save: Buffer.from([1]) }, { rom: '/r/red2.gb', save: Buffer.from([2]) }];
  const id = await s.startLink({ host: '/t/linkhost', system: 'gb', seats, local: 1, delay: 4, rtc: 1, key: 'run:b' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--net'));
  const back = s.startNative({ rom: '/r/red2.gb', key: 'run:b', system: 'gb', tools: { cores: {} }, engine: '/t/linkhost', state: Buffer.from('state'), save: Buffer.from([9]) });
  await new Promise((r) => setImmediate(r));
  const solo = sentTypes(calls[0].child).find((m) => m.type === ENGINE_CMD.SOLO);
  const words = solo.payload.toString().split('\0').filter(Boolean);
  assert.equal(words[words.indexOf('--rom') + 1], '/r/red2.gb');
  assert.ok(words.includes('--state') && words.includes('--sram') && !words.includes('--solo'));
  calls[0].child.stdout.write(event({ event: 'loaded', engine: true, mode: 'solo' }));
  assert.equal(await back, id);
  assert.equal(calls.length, 1);
  // retrohost (the engine off) after a link session: a new process, as before
  s.startNative({ rom: '/r/red2.gb', key: 'run:b', system: 'gb', tools: { host: '/t/retrohost', cores: { gb: '/t/sameboy' } }, state: Buffer.from('s') });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].exe, '/t/retrohost');
  s.stop();
});

// ---- the real engine ------------------------------------------------------------------------------------------------------
const engine = linkTool();
const retroDir = nativeDirs().find((d) => existsSync(join(d, process.platform === 'win32' ? 'retrohost.exe' : 'retrohost')));
const EXT = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
const skip = !engine && 'the engine (link host) isn\'t built (npm run native)';
const BOOT_FRAMES = 120; // the Game Boy Color's fast boot ROM runs first (as in the fast player)
const hosts = [];
test.afterEach(() => hosts.splice(0).forEach((p) => p.exitCode === null && p.signalCode === null && p.kill('SIGKILL')));
const exitOf = (p, exit, ms = 10000) => {
  if (p.exitCode !== null) return Promise.resolve(p.exitCode);
  let t;
  const late = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`the host didn't end within ${ms / 1000} s`)), ms)));
  return Promise.race([exit, late]).finally(() => clearTimeout(t));
};

/** A 32 KB Game Boy ROM (MBC1 + 8 KB battery RAM) that counts 0xC000 up forever and copies it to 0xA000. */
function gbRom(mbc = 0x03) {
  const r = Buffer.alloc(0x8000);
  r.set([0x00, 0xc3, 0x50, 0x01], 0x100);
  r.set([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b], 0x104);
  r.write('SOULDEWTEST', 0x134, 'latin1');
  r[0x147] = mbc, r[0x148] = 0x00, r[0x149] = 0x02;
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - r[i] - 1) & 0xff;
  r[0x14d] = x;
  r.set([0x3e, 0x0a, 0xea, 0x00, 0x00, 0x21, 0x00, 0xc0, 0x34, 0x7e, 0xea, 0x00, 0xa0, 0x18, 0xf9], 0x150);
  return r;
}
/** A 64 KB GBA ROM that counts a word in IWRAM up (no BIOS needed). */
function gbaRom() {
  const r = Buffer.alloc(0x10000);
  r.writeUInt32LE(0xea00002e, 0);
  r.write('SOULDEWTEST', 0xa0, 'latin1');
  r[0xb2] = 0x96;
  let c = 0;
  for (let i = 0xa0; i <= 0xbc; i++) c = (c - r[i]) & 0xff;
  r[0xbd] = (c - 0x19) & 0xff;
  [0xe59f0008, 0xe5901000, 0xe2811001, 0xe5801000, 0xeafffffb, 0x03000000].forEach((w, i) => r.writeUInt32LE(w, 0xc0 + i * 4));
  return r;
}

/** A host spoken to like the page does: events, RAM mirror, states, saves, pictures, sound, WATCHED. */
function drive(exe, args) {
  const p = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  hosts.push(p);
  const h = { p, events: [], ram: new Map(), states: [], srams: [], logs: [], videos: [], audio: [], watched: [], order: [], linput: [], waiters: [], exit: new Promise((res) => p.on('exit', (code) => res(code))) };
  let buf = Buffer.alloc(0);
  p.stderr.on('data', () => {});
  p.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    const { messages, rest } = splitMessages(buf);
    buf = Buffer.from(rest);
    for (const m of messages) {
      h.order.push(m.type);
      if (m.type === 7) h.events.push(JSON.parse(m.payload.toString()));
      if (m.type === 2) h.videos.push(Buffer.from(m.payload.subarray(0, 8)));
      if (m.type === 3) h.audio.push({ t: Date.now(), frames: m.payload.length / 4 });
      if (m.type === 5) h.states.push(Buffer.from(m.payload));
      if (m.type === 9) h.srams.push(Buffer.from(m.payload));
      if (m.type === 6) h.logs.push(m.payload.toString());
      if (m.type === 12) h.linput.push(Buffer.from(m.payload));
      if (m.type === 16) h.watched.push(Buffer.from(m.payload));
      if (m.type === 8) {
        const n = m.payload.readUInt32LE(0);
        for (let i = 0, o = 4; i < n; i++) {
          const addr = m.payload.readUInt32LE(o), len = m.payload.readUInt32LE(o + 4);
          h.ram.set(addr, Buffer.from(m.payload.subarray(o + 8, o + 8 + len)));
          o += 8 + len;
        }
      }
    }
    for (const w of h.waiters.splice(0)) if (!w()) h.waiters.push(w);
  });
  h.send = (type, payload) => p.stdin.write(command(type, payload));
  h.until = (cond, ms = 15000) => new Promise((res, rej) => {
    if (cond()) return res();
    const t = setTimeout(() => rej(new Error(`timeout: ${cond}`)), ms);
    h.waiters.push(() => (cond() ? (clearTimeout(t), res(), true) : false));
  });
  h.ev = (name) => h.events.filter((e) => e.event === name);
  h.read = (addr, len) => {
    for (const [a, b] of h.ram) if (addr >= a && addr + len <= a + b.length) return b.subarray(addr - a, addr - a + len);
    return null;
  };
  h.step = async (n) => {
    const k = h.ev('stepped').length;
    h.send(NCMD.STEP, u32(n));
    await h.until(() => h.ev('stepped').length > k);
    return h.ev('stepped').at(-1).frame;
  };
  return h;
}
const startEngine = (dir, { system = 'gb', rom = gbRom(), sram = null, state = null, model = 'cgb' } = {}) => {
  const file = join(dir, system === 'gba' ? 'test.gba' : 'test.gb');
  writeFileSync(file, rom);
  return drive(engine, engineArgs({ system, rom: file, sram, state, model }));
};
const startRetro = (dir, { system = 'gb', rom = gbRom(), state = null } = {}) => {
  const file = join(dir, system === 'gba' ? 'test.gba' : 'test.gb');
  writeFileSync(file, rom);
  const core = join(retroDir, `${system === 'gba' ? 'mgba' : 'sameboy'}_libretro.${EXT}`);
  return drive(join(retroDir, process.platform === 'win32' ? 'retrohost.exe' : 'retrohost'), hostArgs({ system, core, rom: file, saveDir: dir, systemDir: dir, state, model: 'cgb' }));
};
const tmp = (name) => mkdtempSync(join(tmpdir(), `sls-engine-${name}-`));

test('the engine alone: the fast player\'s protocol – RAM mirror, exact steps, cheats, save states, battery saves, a broken stream', { skip }, async () => {
  const dir = tmp('solo');
  try {
    const boot = join(dir, 'boot.sav');
    writeFileSync(boot, Buffer.alloc(8192, 0x5a));
    const h = startEngine(dir, { sram: boot });
    await h.until(() => h.ev('loaded').length);
    const loaded = h.ev('loaded')[0];
    assert.equal(loaded.engine, true);
    assert.equal(loaded.mode, 'solo');
    assert.deepEqual(loaded.ram, [{ addr: 0xc000, len: 0x2000, ok: true }]);
    assert.equal(loaded.saveSize, 8192);
    assert.equal(loaded.sampleRate, 48000);
    const first = await h.step(30);
    assert.ok(first >= 30 && first < 60, String(first));
    assert.equal(await h.step(37), first + 37, 'paused in between, exactly 37');
    await h.until(() => h.read(0xc000, 1) !== null);
    assert.ok(h.videos.length > 0 && h.videos.every((v) => v.readUInt32LE(4) === 2), 'RGB565 pictures');
    // cheats: inside the RAM, outside it
    h.send(NCMD.WRITE, Buffer.concat([u32(0xc100), Buffer.from([7, 8, 9])]));
    h.send(NCMD.WRITE, Buffer.concat([u32(0x9000), Buffer.from([1])]));
    await h.until(() => h.ev('written').length === 2);
    assert.deepEqual(h.ev('written').map((e) => e.ok), [true, false]);
    await h.until(() => h.read(0xc100, 3)?.equals(Buffer.from([7, 8, 9])));
    // the battery save given at the start is in the cartridge; the game's counter at 0xA000
    h.send(NCMD.FLUSH);
    await h.until(() => h.srams.length >= 1);
    assert.equal(h.srams.at(-1).length, 8192);
    assert.equal(h.srams.at(-1)[1], 0x5a);
    assert.notEqual(h.srams.at(-1)[0], 0x5a);
    // a save state and back; junk refused, the game goes on
    h.send(NCMD.SAVE);
    await h.until(() => h.states.length === 1);
    assert.ok(h.states[0].length > 1000);
    h.send(NCMD.LOAD, h.states[0]);
    await h.until(() => h.ev('stateLoaded').length === 1);
    assert.equal(h.ev('stateLoaded')[0].ok, true);
    h.send(NCMD.LOAD, Buffer.from('not a state'));
    await h.until(() => h.ev('stateLoaded').length === 2);
    assert.equal(h.ev('stateLoaded')[1].ok, false);
    // a battery save given later: the game starts over with it
    h.send(NCMD.SRAM, Buffer.alloc(8192, 0x33));
    await h.step(BOOT_FRAMES);
    h.send(NCMD.FLUSH);
    await h.until(() => h.srams.some((b) => b[1] === 0x33));
    // RESET: starts over, the battery save stays
    h.send(NCMD.RESET);
    await h.step(BOOT_FRAMES);
    h.send(NCMD.FLUSH);
    await h.until(() => h.srams.at(-1)[1] === 0x33);
    // speed: Max is reported as such
    h.send(NCMD.SPEED, f32(1000));
    await h.until(() => h.ev('stats').some((e) => e.speed > 1.5 && e.shown > 0));
    // a header that announces more than the host takes: it ends cleanly (as when souldew goes away)
    h.p.stdin.write(Buffer.concat([u32(1), u32(0x7fffffff)]));
    assert.equal(await exitOf(h.p, h.exit), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the engine alone: QUIT hands over the last battery save; a game it can\'t run is an error event', { skip }, async () => {
  const dir = tmp('quit');
  try {
    const h = startEngine(dir);
    await h.until(() => h.ev('loaded').length);
    await h.step(BOOT_FRAMES);
    h.send(NCMD.QUIT);
    assert.equal(await exitOf(h.p, h.exit), 0);
    assert.ok(h.srams.length >= 1);
    const bad = join(dir, 'bad.gb');
    writeFileSync(bad, Buffer.alloc(16));
    const r = spawnSync(engine, ['--solo', '--rom', bad], { input: '' });
    assert.equal(r.status, 1);
    assert.ok(splitMessages(r.stdout).messages.some((m) => m.type === 7 && JSON.parse(m.payload.toString()).event === 'error'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the engine alone: --state goes on from a state; one that isn\'t this game\'s boots the game instead', { skip }, async () => {
  const dir = tmp('state');
  try {
    let h = startEngine(dir);
    await h.until(() => h.ev('loaded').length);
    assert.equal(h.ev('loaded')[0].state, null);
    await h.step(20);
    h.send(NCMD.WRITE, Buffer.concat([u32(0xc200), Buffer.from([0x42, 0x43])]));
    await h.until(() => h.ev('written').length);
    h.send(NCMD.SAVE);
    await h.until(() => h.states.length === 1);
    h.send(NCMD.QUIT);
    await h.exit;
    const file = join(dir, 'resume.state');
    writeFileSync(file, h.states[0]);
    h = startEngine(dir, { state: file });
    await h.until(() => h.ev('loaded').length);
    assert.equal(h.ev('loaded')[0].state, true);
    await h.until(() => h.read(0xc200, 2) !== null);
    assert.deepEqual([...h.read(0xc200, 2)], [0x42, 0x43]);
    h.send(NCMD.QUIT);
    await h.exit;
    writeFileSync(file, Buffer.alloc(200000, 7));
    h = startEngine(dir, { state: file });
    await h.until(() => h.ev('loaded').length);
    assert.equal(h.ev('loaded')[0].state, false);
    h.send(NCMD.QUIT);
    await h.exit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const system of ['gb', 'gba']) {
  test(`save states go both ways between the fast player (retrohost) and the engine – ${system.toUpperCase()}`, { skip: skip || (!retroDir && 'retrohost not built') }, async () => {
    const dir = tmp(`x${system}`);
    const rom = system === 'gba' ? gbaRom() : gbRom();
    const mark = system === 'gba' ? 0x3000100 : 0xc300;
    try {
      const make = async (start, bytes) => { // a state with a mark only it has
        const h = start(dir, { system, rom });
        await h.until(() => h.ev('loaded').length);
        await h.step(system === 'gb' ? BOOT_FRAMES : 30);
        h.send(NCMD.WRITE, Buffer.concat([u32(mark), Buffer.from(bytes)]));
        await h.until(() => h.ev('written').length);
        h.send(NCMD.SAVE);
        await h.until(() => h.states.length === 1);
        h.send(NCMD.QUIT);
        await h.exit;
        return h.states[0];
      };
      const loads = async (start, state, bytes) => {
        const h = start(dir, { system, rom });
        await h.until(() => h.ev('loaded').length);
        await h.step(5);
        h.send(NCMD.LOAD, state);
        await h.until(() => h.ev('stateLoaded').length);
        assert.equal(h.ev('stateLoaded')[0].ok, true, `${start.name} loads it`);
        h.send(NCMD.RESYNC);
        await h.until(() => h.read(mark, bytes.length)?.equals(Buffer.from(bytes)));
        h.send(NCMD.QUIT);
        await h.exit;
      };
      await loads(startEngine, await make(startRetro, [0x11, 0x22]), [0x11, 0x22]);
      await loads(startRetro, await make(startEngine, [0x33, 0x44]), [0x33, 0x44]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the engine alone: a clock cartridge\'s save carries the clock out and back in (the 48-byte footer)', { skip }, async () => {
  const dir = tmp('rtc');
  try {
    let h = startEngine(dir, { rom: gbRom(0x10) });
    await h.until(() => h.ev('loaded').length);
    await h.step(BOOT_FRAMES);
    h.send(NCMD.QUIT);
    assert.equal(await h.exit, 0);
    const out = h.srams.at(-1);
    assert.equal(out.length, 8192 + 48);
    assert.ok(Math.abs(Number(out.readBigUInt64LE(8192 + 40)) - Date.now() / 1000) < 120, 'the footer\'s time is now');
    const save = Buffer.alloc(8192 + 48);
    [6, 5, 4, 3, 0].forEach((v, i) => { save.writeUInt32LE(v, 8192 + i * 4); save.writeUInt32LE(v, 8192 + 20 + i * 4); });
    save.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000) - 600), 8192 + 40);
    const file = join(dir, 'clock.srm');
    writeFileSync(file, save);
    h = startEngine(dir, { rom: gbRom(0x10), sram: file });
    await h.until(() => h.ev('loaded').length);
    assert.ok(h.logs.some((l) => /cartridge clock from the save: 3 days 04:/.test(l)), h.logs.join('\n'));
    await h.step(BOOT_FRAMES);
    h.send(NCMD.QUIT);
    assert.equal(await h.exit, 0);
    const back = h.srams.at(-1);
    assert.equal(back.readUInt32LE(8192 + 12), 3, 'still day 3');
    assert.equal(back.readUInt32LE(8192 + 8), 4, '4 o\'clock');
    assert.ok(back.readUInt32LE(8192 + 4) >= 15 && back.readUInt32LE(8192 + 4) <= 17, 'ten minutes later');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the engine alone: WATCHED right before each picture; fast-forward sound sped up, never more than real time', { skip }, async () => {
  const dir = tmp('watch');
  try {
    const h = startEngine(dir);
    await h.until(() => h.ev('loaded').length);
    h.send(NCMD.WATCH, Buffer.concat([u32(1), u32(0xc000, 2)]));
    await h.until(() => h.watched.length > 5);
    const i = h.order.indexOf(16);
    assert.equal(h.order[i + 1], 2, 'a picture follows its watched bytes');
    assert.equal(h.watched[0].length, 4 + 2);
    // 1×: about real time; 4×: sped up, never more than real time (the turbo mixer slows it down again)
    const rate = h.ev('loaded')[0].sampleRate;
    const second = async () => {
      const t0 = Date.now(), n0 = h.audio.length;
      await new Promise((r) => setTimeout(r, 1000));
      return h.audio.slice(n0).reduce((n, a) => n + a.frames, 0) / ((Date.now() - t0) / 1000);
    };
    const normal = await second();
    assert.ok(normal > rate * 0.8 && normal < rate * 1.2, `1×: ${normal}`);
    h.send(NCMD.SPEED, f32(4));
    await new Promise((r) => setTimeout(r, 500));
    const fast = await second();
    assert.ok(fast > rate * 0.5 && fast <= rate * 1.2, `4×: ${fast}`);
    assert.ok(h.ev('stats').at(-1).speed > 3, 'it reaches 4×');
    const pictures = h.videos.length;
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(h.videos.length - pictures < 75, 'about 60 pictures a second while fast-forwarding');
    h.send(NCMD.QUIT);
    await h.exit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a link session formed in place from two running games: the same consoles as a fresh link host, each game alone again afterwards', { skip }, async () => {
  const dir = tmp('link');
  try {
    const rom = join(dir, 'test.gb');
    writeFileSync(rom, gbRom());
    const A = drive(engine, engineArgs({ system: 'gb', rom, model: 'cgb' }));
    const Bh = drive(engine, engineArgs({ system: 'gb', rom, model: 'cgb' }));
    await A.until(() => A.ev('loaded').length);
    await Bh.until(() => Bh.ev('loaded').length);
    // two running games, at different moments, with different marks
    await A.step(BOOT_FRAMES + 10);
    await Bh.step(BOOT_FRAMES + 40);
    A.send(NCMD.WRITE, Buffer.concat([u32(0xc400), Buffer.from([0xaa])]));
    Bh.send(NCMD.WRITE, Buffer.concat([u32(0xc400), Buffer.from([0xbb])]));
    await A.until(() => A.ev('written').length);
    await Bh.until(() => Bh.ev('written').length);
    A.send(NCMD.SAVE), Bh.send(NCMD.SAVE);
    await A.until(() => A.states.length), await Bh.until(() => Bh.states.length);
    writeFileSync(join(dir, 'a.state'), A.states[0]);
    writeFileSync(join(dir, 'b.state'), Bh.states[0]);
    const seats = ['--rom', rom, '--sram', '-', '--state', join(dir, 'a.state'), '--model', 'cgb', '--rom', rom, '--sram', '-', '--state', join(dir, 'b.state'), '--model', 'cgb'];
    const words = (local) => Buffer.from([...seats, '--local', String(local), '--net', '--delay', '4', '--rtc', '1763200000000'].map((w) => `${w}\0`).join(''));
    // the peers relay each other's buttons, as the pages do
    const relay = (from, to) => from.p.stdout.on('data', () => { for (const b of from.linput.splice(0)) to.send(21, b); });
    relay(A, Bh), relay(Bh, A);
    A.send(ENGINE_CMD.LINK, words(0));
    Bh.send(ENGINE_CMD.LINK, words(1));
    await A.until(() => A.ev('loaded').some((e) => e.mode === 'link'));
    await Bh.until(() => Bh.ev('loaded').some((e) => e.mode === 'link'));
    assert.deepEqual(A.ev('loaded').at(-1).ram, [{ addr: 0xc000, len: 0x2000, ok: true }]);
    const hashAt = (h, f) => h.ev('hash').find((e) => e.frame === f)?.hash;
    await A.until(() => hashAt(A, 240) && hashAt(Bh, 240), 30000);
    assert.equal(hashAt(A, 240), hashAt(Bh, 240), 'both peers the same');
    // a link host started fresh from the same states (nothing pressed – as here) forms the same consoles
    const fresh = spawnSync(engine, [...seats, '--rtc', '1763200000000', '--bench', '240'], { encoding: 'utf8' });
    assert.equal(fresh.stderr.match(/hash ([0-9a-f]{16})/)?.[1], hashAt(A, 240), 'in place = a fresh link host');
    // the linked console is the player's own game: its mark is there
    A.send(NCMD.RESYNC);
    await A.until(() => A.read(0xc400, 1)?.[0] === 0xaa);
    // leaving: each goes on alone in its process, from where the session left it
    A.send(NCMD.SPEED, f32(0)), Bh.send(NCMD.SPEED, f32(0));
    A.send(ENGINE_CMD.SOLO, Buffer.alloc(0));
    await A.until(() => A.ev('loaded').at(-1).mode === 'solo');
    const at = A.ev('stats').length;
    await A.until(() => A.ev('stats').length > at + 2 && A.ev('stats').at(-1).frame > 10);
    A.send(NCMD.RESYNC);
    await A.until(() => A.read(0xc400, 1)?.[0] === 0xaa);
    assert.ok(A.srams.length >= 1, 'the session\'s last battery save came out first');
    // cheats again, alone
    A.send(NCMD.WRITE, Buffer.concat([u32(0xc401), Buffer.from([1])]));
    await A.until(() => A.ev('written').at(-1)?.addr === 0xc401);
    assert.equal(A.ev('written').at(-1).ok, true);
    // a link the engine can't form (a state file that isn't there): refused, the game goes on alone
    A.send(ENGINE_CMD.LINK, Buffer.from(['--rom', rom, '--state', join(dir, 'missing.state'), '--rom', rom, '--local', '0', '--net', '--delay', '4'].map((w) => `${w}\0`).join('')));
    await A.until(() => A.ev('linkRefused').length);
    const n = A.ev('stats').length;
    await A.until(() => A.ev('stats').length > n + 2);
    assert.equal(A.ev('loaded').at(-1).mode, 'solo');
    A.send(NCMD.QUIT), Bh.send(NCMD.QUIT);
    await Promise.all([exitOf(A.p, A.exit), exitOf(Bh.p, Bh.exit)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A GBA ROM that switches its sound hardware to 65536 Hz (SOUNDBIAS resolution 1), as the Pokémon games do once booted. */
function soundbiasRom() {
  const r = gbaRom();
  // ldr r0,=0x04000088; ldr r1,=0x4200; strh r1,[r0]; b .
  [0xe59f0008, 0xe59f1008, 0xe1c010b0, 0xeafffffe, 0x04000088, 0x00004200].forEach((w, i) => r.writeUInt32LE(w, 0xc0 + i * 4));
  return r;
}

test('a GBA game\'s switch to 65536 Hz sound is announced (audioRate) – by the engine and by the fast player', { skip }, async () => {
  const dir = tmp('rate');
  try {
    for (const start of [startEngine, ...(retroDir ? [startRetro] : [])]) {
      const h = start(dir, { system: 'gba', rom: soundbiasRom() });
      await h.until(() => h.ev('loaded').length);
      assert.equal(h.ev('loaded')[0].sampleRate, 32768);
      await h.until(() => h.ev('audioRate').length);
      assert.equal(h.ev('audioRate')[0].sampleRate, 65536, start.name);
      h.send(NCMD.QUIT);
      await h.exit;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
