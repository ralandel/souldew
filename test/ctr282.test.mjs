// 2.8.2, 3DS tickets #19 and #21: a 3DS game copied into the library only whole (never a cut-off copy under its name),
// a cut-off game file recognised before it starts to a black screen (the game's own hashes, server/lib/ctrcheck.mjs), a
// black picture said and recorded, what "Save diagnostics" keeps about the game file – and the ROM data of a 3DS game
// that couldn't be read for a moment no longer cached as "no place names" for good.
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TMP = mkdtempSync(join(tmpdir(), 'sls-ctr282-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
// (scratch data and tools folders before the server modules read their paths)
process.env.SLS_DATA_DIR = join(TMP, 'data');
process.env.SLS_TOOLS_DIR = join(TMP, 'tools');
const { ctrIntegrity } = await import('../server/lib/ctrcheck.mjs');
const { ctrFileReport } = await import('../server/lib/ctr.mjs');
const { copyIntoLibrary, importFiles, removeStaleParts, uploadTarget } = await import('../server/lib/library.mjs');
const { ctrData, romDataFor } = await import('../server/lib/romloc.mjs');
const { LIBRARY_DIR } = await import('../server/lib/paths.mjs');
const { watchRomData } = await import('../web/lib/romdata.mjs');
const { blackPicture } = await import('../shared/ctrlayout.mjs');
const { probeGen67, encryptPK6 } = await import('../shared/live/gen67.mjs');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const w32 = (b, o, v) => b.writeUInt32LE(v >>> 0, o);
const w64 = (b, o, v) => b.writeBigUInt64LE(BigInt(v), o);
const al = (n, a) => Math.ceil(n / a) * a;

/**
 * A small decrypted NCCH as a real one is laid out: header (unit 0x200), an ExeFS with its hash in the header, a RomFS
 * with its IVFC hash tree (level 3 – the files –, then level 1, then level 2, 4 KB blocks) and the header's hash over
 * the RomFS's first bytes. `blocks` level-3 blocks (the last one partial).
 */
function makeNcch({ blocks = 40, encrypted = false } = {}) {
  const BS = 4096;
  const l3Size = (blocks - 1) * BS + 1000;
  const l2Size = blocks * 32;
  const exefsAt = 0x200;
  const romfs = 0x600;
  const l3 = romfs + al(0x60 + 32, BS);
  const l1 = l3 + al(l3Size, BS);
  const l2 = l1 + al(32, BS);
  const total = al(l2 + l2Size, 0x200);
  const b = Buffer.alloc(total);
  // ExeFS and level 3: bytes that aren't zero
  for (let i = exefsAt; i < exefsAt + 0x400; i++) b[i] = (i * 7 + 3) & 0xff || 1;
  for (let i = 0; i < l3Size; i++) b[l3 + i] = (i * 31 + (i >> 9)) & 0xff || 5;
  // level 2: a hash per level-3 block (the last padded with zeros); level 1: the hash of level 2's block
  for (let i = 0; i < blocks; i++) {
    const blk = Buffer.alloc(BS);
    b.copy(blk, 0, l3 + i * BS, l3 + Math.min((i + 1) * BS, l3Size));
    Buffer.from(sha256(blk), 'hex').copy(b, l2 + i * 32);
  }
  const l2blk = Buffer.alloc(BS);
  b.copy(l2blk, 0, l2, l2 + l2Size);
  Buffer.from(sha256(l2blk), 'hex').copy(b, l1);
  const l1blk = Buffer.alloc(BS);
  b.copy(l1blk, 0, l1, l1 + 32);
  // IVFC header + master hash
  b.write('IVFC', romfs, 'latin1');
  w32(b, romfs + 4, 0x10000);
  w32(b, romfs + 8, 32);
  [[32, 0], [l2Size, BS], [l3Size, 2 * BS]].forEach(([size, off], i) => {
    w64(b, romfs + 0x0c + i * 0x18, off);
    w64(b, romfs + 0x14 + i * 0x18, size);
    w32(b, romfs + 0x1c + i * 0x18, 12);
  });
  Buffer.from(sha256(l1blk), 'hex').copy(b, romfs + 0x60);
  // the NCCH header
  b.write('NCCH', 0x100, 'latin1');
  w32(b, 0x104, total / 0x200);
  w64(b, 0x118, 0x000400000011c500n);
  b.write('CTR-P-ECLA', 0x150, 'latin1');
  b[0x18f] = encrypted ? 0 : 0x04;
  w32(b, 0x1a0, exefsAt / 0x200);
  w32(b, 0x1a4, 2);
  w32(b, 0x1a8, 1);
  Buffer.from(sha256(b.subarray(exefsAt, exefsAt + 0x200)), 'hex').copy(b, 0x1c0);
  w32(b, 0x1b0, romfs / 0x200);
  w32(b, 0x1b4, (total - romfs) / 0x200);
  w32(b, 0x1b8, 1);
  Buffer.from(sha256(b.subarray(romfs, romfs + 0x200)), 'hex').copy(b, 0x1e0);
  return b;
}
const reader = (b) => (o, n) => (o >= b.length ? new Uint8Array(0) : new Uint8Array(b.buffer, b.byteOffset + o, Math.min(n, b.length - o)));
const check = (b, size = b.length) => ctrIntegrity(reader(b), size, sha256);

// ---- #19: is the game file whole? ------------------------------------------------------------------------------------
test('3DS integrity: a whole game passes; a copy cut off or zero-filled after any point is damaged (the game\'s own hashes)', () => {
  const g = makeNcch();
  assert.deepEqual(check(g), { state: 'ok', why: null });
  for (const frac of [0.02, 0.3, 0.6, 0.97]) {
    const cut = Math.floor(g.length * frac);
    // an interrupted copy at its full size, the rest never written (Windows' copy sets the size first)
    const zero = Buffer.from(g);
    zero.fill(0, cut);
    assert.equal(check(zero).state, 'damaged', `zero-filled from ${frac}`);
    // … or simply shorter
    assert.equal(check(g.subarray(0, cut)).state, 'damaged', `cut at ${frac}`);
  }
});

test('3DS integrity: a cartridge image whose game partition runs past the end is damaged; encrypted / unknown are not judged', () => {
  const g = makeNcch();
  const cci = Buffer.alloc(0x4000 + g.length);
  cci.write('NCSD', 0x100, 'latin1');
  w32(cci, 0x120, 0x4000 / 0x200);
  w32(cci, 0x124, g.length / 0x200);
  g.copy(cci, 0x4000);
  assert.equal(check(cci).state, 'ok');
  assert.deepEqual(check(cci.subarray(0, cci.length - 0x200)), { state: 'damaged', why: 'truncated' });
  // the game partition's header zeroed: the copy never got there
  const noNcch = Buffer.from(cci);
  noNcch.fill(0, 0x4000);
  assert.equal(check(noNcch).state, 'damaged');
  assert.deepEqual(check(makeNcch({ encrypted: true })), { state: 'unchecked', why: 'encrypted' });
  assert.equal(check(Buffer.from('not a game at all, just some text that is long enough to be read'.repeat(20))).state, 'unchecked');
  assert.equal(check(Buffer.alloc(0)).state, 'unchecked');
});

test('3DS integrity: data that is there but doesn\'t match its hash is only reported (a modified game may run)', () => {
  const g = makeNcch();
  const romfs = 0x600;
  const l3 = romfs + 4096;
  const mod = Buffer.from(g);
  mod[l3 + 10] ^= 0x5a; // the first level-3 block is always sampled
  assert.deepEqual(check(mod), { state: 'mismatch', why: 'romfs-data' });
});

test('ctrFileReport: size, header, encrypted flag and integrity – nothing that names the player; cached per file stamp', () => {
  const dir = join(TMP, 'report');
  mkdirSync(dir, { recursive: true });
  const good = join(dir, 'Pokémon Alpha Sapphire.cxi');
  writeFileSync(good, makeNcch());
  const r = ctrFileReport(good);
  assert.equal(r.magic, 'NCCH');
  assert.equal(r.format, 'cxi');
  assert.equal(r.encrypted, false);
  assert.equal(r.code, 'ECLA');
  assert.equal(r.titleId, '000400000011C500');
  assert.equal(r.size, statSync(good).size);
  assert.deepEqual(r.integrity, { state: 'ok', why: null });
  assert.doesNotMatch(JSON.stringify(r), /report|Pok|sls-ctr282/, 'no path, no file name');
  const bad = join(dir, 'cut.cxi');
  const g = makeNcch();
  g.fill(0, Math.floor(g.length / 2));
  writeFileSync(bad, g);
  assert.equal(ctrFileReport(bad).integrity.state, 'damaged');
  assert.deepEqual(ctrFileReport(join(dir, 'missing.cxi')), { error: 'ENOENT' });
});

// ---- #19: never a half copy in the library -------------------------------------------------------------------------
test('copyIntoLibrary: the copy appears under its name only whole and checked; a copy that stops leaves nothing', async () => {
  const src = join(TMP, 'src');
  const lib = join(TMP, 'lib1');
  mkdirSync(src, { recursive: true });
  mkdirSync(lib, { recursive: true });
  const file = join(src, 'Pokemon X.3ds');
  const data = makeNcch({ blocks: 300 });
  writeFileSync(file, data);
  await copyIntoLibrary(file, join(lib, 'Pokemon X.3ds'));
  assert.deepEqual(readFileSync(join(lib, 'Pokemon X.3ds')), data);
  assert.deepEqual(readdirSync(lib), ['Pokemon X.3ds'], 'no part file left');
  // a copy that ended half way (the app closed, a drive that went away): no file under the name, no part left
  const half = async (from, to) => writeFileSync(to, readFileSync(from).subarray(0, data.length >> 1));
  await assert.rejects(copyIntoLibrary(file, join(lib, 'Half.3ds'), { copy: half }), (e) => e.code === 'importVerify');
  // the same size with the rest never written (as an interrupted copy on Windows)
  const holes = async (from, to) => {
    const b = Buffer.from(readFileSync(from));
    b.fill(0, b.length >> 1);
    writeFileSync(to, b);
  };
  await assert.rejects(copyIntoLibrary(file, join(lib, 'Holes.3ds'), { copy: holes }), (e) => e.code === 'importVerify');
  // a copy that fails outright (a file another program holds): a coded error, nothing left
  const locked = async () => {
    throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
  };
  await assert.rejects(copyIntoLibrary(file, join(lib, 'Locked.3ds'), { copy: locked }), (e) => e.code === 'importFailed' && e.vars?.why === 'EBUSY');
  assert.deepEqual(readdirSync(lib), ['Pokemon X.3ds']);
});

test('importFiles: games are copied off the main thread; .7z / .rar are named as skipped instead of vanishing', async () => {
  const src = join(TMP, 'pick');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'Pokemon Y.cxi'), makeNcch());
  writeFileSync(join(src, 'Pokemon Y.7z'), 'not unpacked here');
  writeFileSync(join(src, 'notes.docx'), 'x');
  const skipped = [];
  const added = await importFiles([join(src, 'Pokemon Y.cxi'), join(src, 'Pokemon Y.7z'), join(src, 'notes.docx')], {}, { roots: [src], skipped });
  assert.deepEqual(added, [join(LIBRARY_DIR, 'Pokemon Y.cxi')]);
  assert.deepEqual(skipped, [{ name: 'Pokemon Y.7z', why: 'archive' }, { name: 'notes.docx', why: 'type' }]);
  assert.ok(!readdirSync(LIBRARY_DIR).some((n) => n.startsWith('.')), 'no part file in the library');
  // a dropped .rar gets its own message as well
  assert.throws(() => uploadTarget('Pokemon X.rar'), (e) => e.code === 'archiveUnsupported');
  // every code has its text in all five languages
  const errors = readFileSync(new URL('../web/lib/errors.mjs', import.meta.url), 'utf8');
  for (const c of ['ctrIncomplete', 'importFailed', 'importVerify', 'archiveUnsupported']) assert.match(errors, new RegExp(`\\b${c}: `));
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of ['err.ctrIncomplete', 'err.importFailed', 'err.importVerify', 'lib.skipArchive', 'lib.skipType', 'ctr.blackTitle', 'ctr.blackText']) assert.ok(d[k], `${lang} ${k}`);
  }
});

test('removeStaleParts: what an ended souldew left half copied goes; a running copy and real games stay', () => {
  const dir = join(TMP, 'stale');
  mkdirSync(dir, { recursive: true });
  const dead = 2 ** 22 + 12345; // (no such process)
  const names = [`.Pokemon X.3ds.${dead}.import`, `.Pokemon Y.3ds.${dead}.part`, `Pokemon Moon.3ds.${dead}.upload`, `.upload-${dead}-ab12cd34.zip`,
    `.Mine.3ds.${process.pid}.import`, `.Parent.3ds.${process.ppid}.part`, 'Pokemon X.3ds', 'notes.txt'];
  for (const n of names) writeFileSync(join(dir, n), 'x');
  const removed = removeStaleParts(dir);
  assert.deepEqual(removed.sort(), names.slice(0, 4).sort());
  assert.deepEqual(readdirSync(dir).sort(), names.slice(4).sort());
});

test('/api/ctr/start: a cut-off 3DS game is refused with its own code (no black screen) and lands in the diagnostics', async () => {
  const { PLATFORM_DIR } = await import('../server/lib/ctr.mjs');
  // stand-in tools: the start must stop before any host runs
  const tools = join(TMP, 'tools', 'ctr', PLATFORM_DIR);
  mkdirSync(tools, { recursive: true });
  for (const f of ['ctrhost', 'ctrhost.exe', 'azahar_libretro.dylib', 'azahar_libretro.dll', 'azahar_libretro.so', 'libMoltenVK.dylib', 'vulkan-1.dll', 'libvulkan.so.1']) writeFileSync(join(tools, f), '');
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const g = makeNcch();
  g.fill(0, Math.floor(g.length * 0.4));
  writeFileSync(join(LIBRARY_DIR, 'Cut Short.cxi'), g);
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  try {
    const lib = await fetch(`${url}/api/library`, { headers: { 'x-soullink': '1' } }).then((r) => r.json());
    const rom = lib.roms.find((r) => r.name === 'Cut Short.cxi');
    assert.ok(rom, 'listed (its header is fine)');
    const res = await fetch(`${url}/api/ctr/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ rom: `/api/library/rom?id=${encodeURIComponent(rom.id)}`, key: rom.id }) });
    const j = await res.json();
    assert.equal(res.status, 409);
    assert.equal(j.code, 'ctrIncomplete');
    const diag = await fetch(`${url}/api/diagnostics/players`, { headers: { 'x-soullink': '1' } }).then((r) => r.json());
    assert.equal(diag.ctr.last.file.integrity.state, 'damaged');
    assert.equal(diag.ctr.last.file.magic, 'NCCH');
    assert.doesNotMatch(JSON.stringify(diag.ctr.last), /Cut Short|sls-ctr282/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- #19: a black picture is told -------------------------------------------------------------------------------------
test('blackPicture: a black frame (BGRA / RGBA) is black, a frame with anything drawn is not', () => {
  const w = 400;
  const h = 480;
  const px = new Uint8Array(w * h * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  assert.equal(blackPicture(px, w, h), true);
  // a dark logo in the middle of the bottom screen
  for (let y = 300; y < 340; y++) for (let x = 150; x < 250; x++) px[(y * w + x) * 4 + 1] = 90;
  assert.equal(blackPicture(px, w, h), false);
});

// ---- #21: the ROM data of a 3DS game that couldn't be read ---------------------------------------------------------------
test('ctrData: a read that fails throws (not "no zone table"), so it isn\'t cached on disk and is read again later', async () => {
  const notAFile = join(TMP, 'Host - Alpha Sapphire Randomized.cxi');
  mkdirSync(notAFile, { recursive: true }); // (opens, but every read fails – EISDIR – like a file a scanner holds)
  assert.throws(() => ctrData(notAFile));
  const cacheDir = join(TMP, 'cache');
  const r = await romDataFor({ file: notAFile }, { sharedDir: fileURLToPath(new URL('../shared', import.meta.url)), cacheDir });
  assert.equal(r.data, null);
  assert.ok(!existsSync(join(cacheDir, 'romloc')) || readdirSync(join(cacheDir, 'romloc')).length === 0, 'nothing on disk');
  // a whole file is read and cached as before
  const ok = join(TMP, 'whole.cxi');
  writeFileSync(ok, makeNcch());
  const d = ctrData(ok);
  assert.equal(d.header.code, 'ECLA');
  assert.equal(d.header.titleId, '000400000011C500');
});

test('watchRomData: no answer or no header → asked again until one comes; stops for another game', async () => {
  const answers = [null, { data: null, header: null }, { data: { gen: 6, ctr: { places: [0, 6, 10] } }, header: { system: '3ds' } }];
  const applied = [];
  let asked = 0;
  await watchRomData('src', (j) => applied.push(j), { retry: [1, 1, 1, 1], wait: async () => {}, get: async () => answers[asked++] ?? null });
  assert.equal(asked, 3);
  assert.deepEqual(applied.map((j) => !!j?.header), [false, true], 'the first answer at once, the good one when it came');
  // a good first answer: asked once
  asked = 0;
  await watchRomData('src', () => {}, { wait: async () => {}, get: async () => (asked++, answers[2]) });
  assert.equal(asked, 1);
  // another game started meanwhile: no more asking, nothing applied for the old one
  let current = true;
  const late = [];
  await watchRomData('src', (j) => late.push(j), { retry: [1, 1], wait: async () => { current = false; }, get: async () => null, current: () => current });
  assert.equal(late.length, 1);
});

test('probeGen67: what each update\'s party address holds (diagnostics) – unread, empty, garbage, a Pokémon', () => {
  const oras = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url), 'utf8')).games.find((g) => g.id === 'oras');
  const plain = new Uint8Array(260);
  plain.set([0x78, 0x56, 0x34, 0x12], 0); // encryption constant
  plain[0x08] = 252; // Treecko
  plain[0xec] = 5;
  plain[0xf0] = 20;
  plain[0xf2] = 20;
  for (let o = 0xf4; o < 0xfe; o += 2) plain[o] = 10;
  const enc = encryptPK6(plain);
  const party = new Uint8Array(6 * 0x1e4);
  party.set(enc.subarray(0, 0xe8), 0);
  party.set(enc.subarray(0xe8), 0x158);
  const garbage = new Uint8Array(6 * 0x1e4).map((_, i) => (i * 13) & 0xff);
  const mem = { [0x08cfb26c]: garbage, [0x08cf727c]: party, [0x08187bd4]: new Uint8Array([0x22, 0x01]) };
  const read = (addr, len) => (mem[addr] ? mem[addr].subarray(0, len) : null);
  assert.deepEqual(probeGen67(oras, read), { addrs: [{ version: '1.4', slot0: 'checksum' }, { version: '1.0', slot0: 'ok' }], zone: 0x122 });
  assert.deepEqual(probeGen67(oras, () => null), { addrs: [{ version: '1.4', slot0: 'unread' }, { version: '1.0', slot0: 'unread' }], zone: null });
  mem[0x08cf727c] = new Uint8Array(6 * 0x1e4);
  assert.equal(probeGen67(oras, read).addrs[1].slot0, 'empty');
});
