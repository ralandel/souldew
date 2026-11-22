// .sgb files (Super Game Boy dumps – what some cartridge readers name Red, Blue and other Game Boy games that support
// the Super Game Boy) are plain Game Boy ROMs: the library, the pickers, patching, run creation and the players treat
// them exactly like .gb files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, crc32Hex } from '../shared/checksum.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-sgb-'));
process.env.SLS_DATA_DIR = DATA;
const { identifyRom, matchCatalog, ROM_EXTENSIONS, SYSTEMS } = await import('../shared/romid.mjs');
const { scanLibrary, uploadTarget, catalog, discoverRoms } = await import('../server/lib/library.mjs');
const { preparePatchedRom } = await import('../server/lib/roms.mjs');
const { buildRun } = await import('../server/lib/build.mjs');
const { defaultSavePath } = await import('../server/app.mjs');
const { runGen } = await import('../shared/overlay.mjs');
const { guessHack } = await import('../shared/hackguess.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIB = join(DATA, 'Library');
mkdirSync(LIB, { recursive: true });

/** A tiny Game Boy ROM with a real header (Nintendo logo start, title, CGB flag). */
function gbRom(title, cgb = 0) {
  const b = Buffer.alloc(0x8000, 0);
  Buffer.from([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b]).copy(b, 0x104);
  b.write(title, 0x134, 'ascii');
  b[0x143] = cgb;
  for (let i = 0x150; i < b.length; i++) b[i] = (i * 13) & 0xff;
  return b;
}

const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
/** Minimal stored zip. */
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name);
    const crc = le(crc32(data));
    const head = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...crc, ...le(data.length), ...le(data.length), n.length, 0, 0, 0]);
    local.push(head, n, Buffer.from(data));
    central.push(Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...crc, ...le(data.length), ...le(data.length),
      n.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(offset)]), n);
    offset += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, entries.length, 0, entries.length, 0, ...le(cd.length), ...le(offset), 0, 0]);
  return Buffer.concat([...local, cd, eocd]);
}

test('.sgb is a Game Boy ROM extension: identified like .gb (a Color game stays Color)', () => {
  assert.ok(ROM_EXTENSIONS.includes('sgb'));
  assert.ok(SYSTEMS.gb.ext.includes('sgb'));
  const red = identifyRom(gbRom('POKEMON RED'), 'sgb');
  assert.deepEqual(red, identifyRom(gbRom('POKEMON RED'), 'gb'));
  assert.equal(red.system, 'gb');
  assert.equal(red.title, 'POKEMON RED');
  assert.equal(identifyRom(gbRom('POKEMON_GLDAAUE', 0x80), '.SGB').system, 'gbc');
  assert.equal(matchCatalog(red, catalog())?.game?.id, 'pokemon-red');
});

test('the upload, the pickers and the drop zone take .sgb', () => {
  assert.equal(extname(uploadTarget('Pokemon Red.sgb')), '.sgb');
  assert.equal(extname(uploadTarget('POKEMON BLUE.SGB')), '.SGB');
  const main = readFileSync(join(ROOT, 'electron', 'main.mjs'), 'utf8');
  assert.match(main, /extensions: \[[^\]]*'sgb'/, 'the file dialog filter');
  const lib = readFileSync(join(ROOT, 'web', 'views', 'library.mjs'), 'utf8');
  assert.match(lib, /input\.accept = '[^']*\.sgb[,']/, 'the browser file picker');
});

test('the library lists .sgb ROMs – loose and inside a zip – as Game Boy games of the catalog', () => {
  writeFileSync(join(LIB, 'Pokemon Red.sgb'), gbRom('POKEMON RED'));
  writeFileSync(join(LIB, 'dump.zip'), makeZip([{ name: 'POKEMON BLUE.sgb', data: gbRom('POKEMON BLUE') }]));
  const { roms } = scanLibrary({});
  const red = roms.find((r) => r.name === 'Pokemon Red.sgb');
  assert.equal(red.system, 'gb');
  assert.equal(red.gameId, 'pokemon-red');
  assert.equal(red.crc, crc32Hex(gbRom('POKEMON RED')));
  const blue = roms.find((r) => r.name === 'POKEMON BLUE.sgb');
  assert.ok(blue, 'the zipped .sgb is listed');
  assert.equal(blue.system, 'gb');
  assert.equal(blue.gameId, 'pokemon-blue');
});

test('a zip indexed by an older version (which skipped .sgb) is read again', () => {
  const zip = join(LIB, 'old.zip');
  writeFileSync(zip, makeZip([{ name: 'red.sgb', data: gbRom('POKEMON RED') }]));
  scanLibrary({});
  const indexFile = join(DATA, 'library-index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  const keys = Object.keys(index).filter((k) => k.startsWith(`${zip}|`));
  assert.equal(keys.length, 1);
  for (const k of keys) index[k] = { roms: [], patches: [], notes: [], ctr: [] }; // what 2.8.0 wrote for it
  writeFileSync(indexFile, JSON.stringify(index));
  assert.ok(scanLibrary({}).roms.some((r) => r.name === 'red.sgb'));
});

test('"find ROMs on this computer" finds .sgb files', () => {
  const home = join(DATA, 'home', 'Downloads');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'Pokemon Blue.sgb'), gbRom('POKEMON BLUE'));
  const { found } = discoverRoms({ roots: [dirname(home)], budgetMs: 4000 });
  const blue = found.find((f) => f.name === 'Pokemon Blue.sgb');
  assert.ok(blue);
  assert.equal(blue.system, 'gb');
});

test('patching and caching a .sgb base: the result is a .gb file (a Color game a .gbc file)', () => {
  const rom = join(LIB, 'Pokemon Red.sgb');
  const plain = preparePatchedRom(rom, null);
  assert.equal(extname(plain.path), '.gb');
  assert.equal(plain.system, 'gb');
  assert.equal(plain.header.title, 'POKEMON RED');
  // an IPS patch that writes two bytes at 0x200
  const ips = join(LIB, 'tweak.ips');
  writeFileSync(ips, Buffer.from([0x50, 0x41, 0x54, 0x43, 0x48, 0, 0x02, 0, 0, 2, 0xaa, 0xbb, 0x45, 0x4f, 0x46]));
  const patched = preparePatchedRom(rom, ips);
  assert.equal(extname(patched.path), '.gb');
  assert.equal(patched.system, 'gb');
  assert.deepEqual([...readFileSync(patched.path).subarray(0x200, 0x202)], [0xaa, 0xbb]);

  const color = join(LIB, 'color.sgb');
  writeFileSync(color, gbRom('COLORGAME', 0xc0));
  const c = preparePatchedRom(color, null);
  assert.equal(extname(c.path), '.gbc');
  assert.equal(c.system, 'gbc');

  // without a header (a homebrew dump) it still is a Game Boy game, never a ".bin"
  const bare = join(LIB, 'bare.sgb');
  writeFileSync(bare, Buffer.alloc(0x8000, 7));
  assert.equal(extname(preparePatchedRom(bare, null).path), '.gb');
});

test('a run built from a .sgb ROM: Game Boy ROMs (.gb) per player, the battery save next to them', async () => {
  const m = await buildRun({
    romId: join(LIB, 'Pokemon Red.sgb'), randomize: false, config: {}, gameId: 'pokemon-red', mode: 'nuzlocke',
    players: { p1: { name: 'Lou' } },
  });
  assert.equal(m.game.system, 'gb');
  assert.equal(m.base.name, 'Pokemon Red.sgb');
  assert.match(m.outputs.p1.rom, /\.gb$/);
  assert.ok(existsSync(join(DATA, 'runs', m.id, m.outputs.p1.rom)));
  assert.match(defaultSavePath(m, 'p1'), /\.sav$/);
  assert.equal(runGen(m), 1);
  assert.equal(runGen({ base: { name: 'Red.sgb' } }), 1, 'older manifests: generation from the base ROM name');
  assert.match(defaultSavePath({ id: m.id, outputs: { p1: { rom: 'x.sgb' } } }, 'p1'), /x\.sav$/);
});

test('file names: ".sgb" is cut off like ".gb"', () => {
  const cat = catalog();
  const withSgb = guessHack('Pokemon Brown.sgb', 'pokemon-red', cat);
  const withGb = guessHack('Pokemon Brown.gb', 'pokemon-red', cat);
  assert.deepEqual(withSgb, withGb);
});

// #43: a patch that doesn't fit the ROM (made for another copy of the game, or damaged) stopped the new-run assistant's
// check with a bare error 500 – now an answer with a code the page words
test('a patch that doesn\'t fit the ROM: 422 patchNoFit with what the patcher said, not an error without a code', () => {
  const rom = join(LIB, 'Pokemon Red.sgb');
  const bps = join(LIB, 'other-copy.bps');
  // a BPS patch for a 16-byte source: this ROM is another one
  const enc = (n) => { const b = []; for (;;) { const x = n & 0x7f; n >>= 7; if (!n) { b.push(0x80 | x); break; } b.push(x); n--; } return b; };
  const body = Buffer.from([0x42, 0x50, 0x53, 0x31, ...enc(16), ...enc(16), ...enc(0)]);
  const crcs = Buffer.alloc(12);
  crcs.writeUInt32LE(0x12345678, 0);
  const withCrc = Buffer.concat([body, crcs]);
  withCrc.writeUInt32LE(crc32(withCrc.subarray(0, withCrc.length - 4)) >>> 0, withCrc.length - 4);
  writeFileSync(bps, withCrc);
  assert.throws(() => preparePatchedRom(rom, bps), (e) => e.status === 422 && e.code === 'patchNoFit' && /BPS/.test(e.vars?.detail || ''));
  const errors = readFileSync(join(ROOT, 'web/lib/errors.mjs'), 'utf8');
  assert.match(errors, /patchNoFit: \(v\) => t\('err\.patchNoFit',/);
});
