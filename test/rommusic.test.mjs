// "Music from the ROM" (3DS): the game's RomFS (synthetic images – .3ds, .cxi, .cia – with renamed and unknown files),
// the stream formats (BCSTM decoded against a reference decoder, ADTS frames, the BCSAR's stream loops), which stream
// plays where from the game's reads (synthetic, and a real log recorded from Pokémon Sun in Azahar), the turbo mixer's
// ROM voice (turbo on/off, track change, loop – sample for sample), the core's read log (a C++ ring buffer, compiled
// from the Azahar patch itself) and the host/server plumbing. Nothing here makes a sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { romfsOfFile, romfsLevel3 as level3Of, romfsHeader, romfsFiles, fileAt, ncchOffset } from '../shared/ctr/romfs.mjs';
import { sniffStream, cstmInfo, cstmDecodeBlock, cstmSeekHist, cstmSampleAt, cstmSamplesThrough, adtsFrames, adtsSniff, adtsSampleAt, adtsSamplesThrough, bcsarStreams, dspDecode } from '../shared/ctr/streams.mjs';
import { RomMusicTracker, readSpan, wrap, isJingle, defaultLead, FRAME_SEC } from '../shared/ctr/rommusic.mjs';
import { musicIndex, filesSig } from '../shared/ctr/musicindex.mjs';
import { CstmSource, PcmSource, RomVoice, alignLag } from '../web/lib/romvoice.mjs';
import { TurboMixer } from '../web/lib/turboaudio.mjs';
import { parseRomfs, romReadPayload, bestLag, RomMusic } from '../web/lib/rommusic.mjs';
import { cciWithRomfs, romfsLevel3 } from './fixtures/ctr.mjs';
import { makeCstm, makeBcsar, makeAdts, ciaAround, refDsp, rng } from './fixtures/rommusic.mjs';
import { fileURLToPath } from 'node:url';

const reader = (u8) => (o, n) => (o >= u8.length ? new Uint8Array(0) : u8.subarray(o, Math.min(u8.length, o + n)));

// ---- the RomFS ---------------------------------------------------------------------------------------------------------
const trackA = makeCstm({ seed: 1 });
const trackB = makeCstm({ seed: 2, blocks: 8, loop: null });
const jingle = makeCstm({ seed: 3, blocks: 2, loop: null });
const trackC = makeCstm({ seed: 4, blocks: 7 });
const files = {
  // renamed and unknown: nothing here is called bgm_* – the bytes say what is music
  'zz/xq1.bin': trackA.file,
  'zz/data/0001': trackB.file,
  'zz/data/fanfare': jingle.file,
  'zz/data/0002': trackC.file,
  'a/0/1/2': new Uint8Array(4096).fill(7), // (a GARC-ish blob: not music)
  'sound/notastream.bcstm': new Uint8Array(512).fill(1), // (named like one, isn't one)
};

test('the RomFS of a .3ds, a .cxi and a .cia: every file with its place from level 3, whatever its name', () => {
  const cci = cciWithRomfs({}, files);
  const a = romfsOfFile(reader(cci));
  assert.ok(a, 'parsed');
  assert.equal(a.files.length, 6);
  assert.deepEqual(a.files.map((f) => f.path).sort(), Object.keys(files).sort());
  for (const f of a.files) assert.deepEqual(cci.subarray(a.base + f.start, a.base + f.start + f.size), files[f.path], f.path);
  // sorted by place, and fileAt finds the file holding any byte
  for (let i = 1; i < a.files.length; i++) assert.ok(a.files[i].start > a.files[i - 1].start);
  const x = a.files.find((f) => f.path === 'zz/data/0001');
  assert.equal(fileAt(a.files, x.start + 100), x);
  assert.equal(fileAt(a.files, x.start + x.size + 100000000), null);
  // the same game as a .cxi (the NCCH alone) and a .cia (the NCCH as content 0, a meta block after it)
  const ncch = cci.subarray(0x4000);
  const cxi = romfsOfFile(reader(ncch));
  assert.deepEqual(cxi.files, a.files);
  const cia = ciaAround(ncch);
  assert.ok(ncchOffset(reader(cia)) > 0);
  assert.deepEqual(romfsOfFile(reader(cia)).files, a.files);
  // encrypted contents: no RomFS (souldew decrypts nothing)
  const enc = cci.slice();
  enc[0x4000 + 0x18f] = 0;
  assert.equal(romfsOfFile(reader(enc)), null);
  // garbage never throws
  assert.equal(romfsOfFile(reader(new Uint8Array(0x300))), null);
  assert.equal(romfsHeader(new Uint8Array(0x28)), null);
  assert.equal(level3Of(reader(new Uint8Array(16))), null);
});

test('the RomFS tables read on their own (as the page reads them through the core): same list', () => {
  const l3 = romfsLevel3(files);
  const h = romfsHeader(l3.subarray(0, 0x28));
  const list = romfsFiles(h, l3.subarray(h.dirMeta.off, h.dirMeta.off + h.dirMeta.len), l3.subarray(h.fileMeta.off, h.fileMeta.off + h.fileMeta.len));
  assert.deepEqual(list.map((f) => f.path).sort(), Object.keys(files).sort());
  // a damaged table (a loop in the sibling chain) ends the walk instead of hanging
  const bad = l3.slice();
  const fm = h.fileMeta.off;
  bad[fm + 4] = 0;
  bad[fm + 5] = bad[fm + 6] = bad[fm + 7] = 0; // first file's sibling → itself
  const l = romfsFiles(h, bad.subarray(h.dirMeta.off, h.dirMeta.off + h.dirMeta.len), bad.subarray(fm, fm + h.fileMeta.len), { max: 1000 });
  assert.ok(l.length <= 1000);
});

// ---- the formats -------------------------------------------------------------------------------------------------------
test('BCSTM: header, INFO and SEEK parsed; DSP-ADPCM decoded sample for sample like the reference decoder', () => {
  const s = cstmInfo(trackA.file);
  assert.equal(s.codec, 'cstm');
  assert.equal(s.format, 'dsp');
  for (const k of ['channels', 'rate', 'samples', 'blockSize', 'blockSamples', 'blocks', 'dataStart']) assert.equal(s[k], trackA.info[k], k);
  assert.deepEqual(s.loop, trackA.info.loop);
  // block by block, history carried over …
  const hist = s.hist.map((h) => [...h]);
  for (let i = 0; i < s.blocks; i++) {
    const b = cstmDecodeBlock(s, trackA.file, i, hist);
    for (let c = 0; c < 2; c++) assert.deepEqual(b[c], trackA.decoded[c].subarray(i * s.blockSamples, i * s.blockSamples + b[c].length), `block ${i} ch ${c}`);
  }
  // … or from the SEEK history (random access)
  const seek = trackA.file.subarray(s.seekAt);
  const b3 = cstmDecodeBlock(s, trackA.file, 3, [cstmSeekHist(s, seek, 3, 0), cstmSeekHist(s, seek, 3, 1)]);
  assert.deepEqual(b3[1], trackA.decoded[1].subarray(3 * s.blockSamples, 4 * s.blockSamples));
  // the voice's source reads across blocks and from anywhere
  const src = new CstmSource(trackA.file, s);
  const l = new Float32Array(1500);
  const r = new Float32Array(1500);
  src.read(800, 1500, l, r);
  for (let i = 0; i < 1500; i++) assert.equal(Math.round(r[i] * 32768), trackA.decoded[1][800 + i]);
  // PCM16 streams are copied
  const p = makeCstm({ format: 'pcm16', seed: 5 });
  const ps = cstmInfo(p.file);
  assert.equal(ps.format, 'pcm16');
  assert.deepEqual(cstmDecodeBlock(ps, p.file, 2, null)[0], p.decoded[0].subarray(2 * ps.blockSamples, 3 * ps.blockSamples));
  // the decoder itself, mid-frame start
  const ch0 = trackA.file.subarray(s.dataStart);
  const out = new Int16Array(30);
  dspDecode(ch0, s.coefs[0], [...s.hist[0]], out, 30, { skip: 5 });
  assert.deepEqual(out, refDsp(ch0, s.coefs[0], s.hist[0], 35).out.subarray(5));
});

test('BCSTM: byte offsets → samples (a read of the header brings block 0; a block read its first sample)', () => {
  const s = cstmInfo(trackA.file);
  const group = s.blockSize * s.channels;
  assert.equal(cstmSampleAt(s, 0), -1);
  assert.equal(cstmSampleAt(s, s.dataStart), 0);
  assert.equal(cstmSampleAt(s, s.dataStart + 2 * group + 5), 2 * s.blockSamples);
  assert.equal(cstmSamplesThrough(s, s.dataStart + 3 * group), 3 * s.blockSamples);
  assert.deepEqual(readSpan(s, 0, s.dataStart + group), { s: 0, e: s.blockSamples });
  assert.deepEqual(readSpan(s, s.dataStart + group, 2 * group), { s: s.blockSamples, e: 3 * s.blockSamples });
  assert.equal(readSpan(s, 0, 0x20), null); // (only the header)
});

test('streams are recognised by their bytes only; damaged or foreign files are not music', () => {
  assert.equal(sniffStream(trackA.file.subarray(0, 0x1000)).codec, 'cstm');
  assert.equal(sniffStream(new Uint8Array(4096).fill(7)), null);
  const broken = trackA.file.slice(0, 0x1000);
  broken[0x40] = 0; // INFO magic gone
  assert.equal(sniffStream(broken), null);
  const odd = trackA.file.slice(0, 0x1000);
  odd[0x40 + 8 + 0x18] = 3; // codec 3 (IMA-ADPCM): not played
  assert.equal(cstmInfo(odd), null);
  const aac = makeAdts([300, 280, 310, 290]);
  assert.deepEqual(sniffStream(aac), { codec: 'adts', rate: 48000, channels: 2 });
  assert.equal(adtsSniff(aac.subarray(0, 100)), null);
  assert.equal(sniffStream(Uint8Array.from([0xff, 0xf1, 0, 0, 0, 0, 0])), null);
});

test('ADTS: the frame table maps bytes to samples (1024 per frame; the decoder delay taken off for the reads)', () => {
  const aac = makeAdts([300, 280, 310, 290, 305]);
  const t = adtsFrames(aac);
  assert.equal(t.samples, 5 * 1024);
  assert.deepEqual([...t.offsets], [0, 300, 580, 890, 1180]);
  assert.equal(adtsSampleAt(t, 581), 2048);
  assert.equal(adtsSamplesThrough(t, 890), 3 * 1024);
  assert.equal(adtsSamplesThrough(t, 889), 2 * 1024);
  const info = { codec: 'adts', rate: 48000, frames: t, priming: 1024, samples: 4 * 1024 };
  assert.deepEqual(readSpan(info, 580, 600), { s: 1024, e: 3072 }); // (frames 2 and 3 complete)
  assert.deepEqual(readSpan(info, 0, 300), { s: 0, e: 0 });
});

test('BCSAR: the stream sounds\' loop points by their file (X/Y layout), no loop for the next-reference pattern, no STRG', () => {
  const sar = makeBcsar([
    { path: 'stream/zz_town.aac', loop: { start: 1175936, end: 2903936 }, name: 'STRM_TOWN' },
    { path: 'stream/zz_title.aac', loop: null, name: 'STRM_TITLE' },
    { path: 'Stream/Odd_Name.AAC', loop: { start: 48000, end: 96000 } },
  ]);
  const m = bcsarStreams(sar);
  assert.equal(m.size, 3);
  assert.deepEqual(m.get('zz_town.aac'), { loop: { start: 1175936, end: 2903936 }, name: 'STRM_TOWN' });
  assert.deepEqual(m.get('zz_title.aac').loop, null);
  assert.deepEqual(m.get('odd_name.aac').loop, { start: 48000, end: 96000 });
  const plain = bcsarStreams(makeBcsar([{ path: 'stream/a.aac', loop: { start: 1, end: 9 } }], { strings: false }));
  assert.deepEqual(plain.get('a.aac'), { loop: { start: 1, end: 9 }, name: null });
  assert.equal(bcsarStreams(new Uint8Array(100)).size, 0);
  assert.equal(bcsarStreams(sar.subarray(0, 0x80)).size, 0); // cut off: nothing, never a throw
});

test('the server\'s music index: every stream of the file by its bytes, the sound archive\'s loops, a table signature', () => {
  const sar = makeBcsar([{ path: 'stream/xq1.bin', loop: { start: 10, end: 20 } }]);
  const cci = cciWithRomfs({}, { ...files, 'snd/archive.dat': sar });
  const idx = musicIndex(reader(cci));
  assert.deepEqual(idx.streams.map((x) => x.path).sort(), ['zz/data/0001', 'zz/data/0002', 'zz/data/fanfare', 'zz/xq1.bin']);
  assert.deepEqual(idx.loops, { 'xq1.bin': { start: 10, end: 20 } });
  const again = musicIndex(reader(cci));
  assert.equal(idx.sig, again.sig);
  assert.equal(idx.sig, filesSig(romfsOfFile(reader(cci)).files));
  // the info survives JSON (the romloc cache) and still places reads
  const info = JSON.parse(JSON.stringify(idx.streams.find((x) => x.path === 'zz/xq1.bin').info));
  assert.deepEqual(readSpan(info, info.dataStart, 10), { s: 0, e: 0 });
  // another RomFS (a mod with one more file) has another signature
  assert.notEqual(musicIndex(reader(cciWithRomfs({}, { ...files, 'zz/new': trackA.file }))).sig, idx.sig);
});

// ---- which stream plays where --------------------------------------------------------------------------------------------
/** A tracker over the synthetic image, answering its needs at once (as the page does). */
function trackerFor(cci) {
  const fs = romfsOfFile(reader(cci));
  const ev = [];
  const t = new RomMusicTracker({ onEvent: (e) => ev.push(e) });
  const answer = (needs) => {
    for (const n of needs) {
      if (n.type === 'files') answer(t.setFiles(n.tag, fs.files));
      else t.setInfo(n.tag, n.file, sniffStream(cci.subarray(fs.base + n.file.start, fs.base + n.file.start + 0x1000)));
    }
  };
  const feed = (list) => answer(t.reads(list));
  return { t, ev, fs, feed };
}

/** The reads a stream file gets: header + block 0, a prefill burst, then two blocks every 2 blocks' time, its loop. */
function streamReads(fs, path, s, { tag = 1, from = 100, seconds = 10, prefill = 2 } = {}) {
  const f = fs.files.find((x) => x.path === path);
  const group = s.blockSize * s.channels;
  const spf = s.rate * FRAME_SEC;
  const lead = defaultLead(s);
  const out = [{ tag, off: f.start, len: s.dataStart + group, frame: from }];
  let k = 1;
  for (let i = 0; i < prefill && k < s.blocks; i++, k += 2) out.push({ tag, off: f.start + s.dataStart + k * group, len: Math.min(2, s.blocks - k) * group, frame: from + 1 + i });
  // steady: block k is read when the sound reaches its first sample minus the lead (the line starts 5 frames on)
  const start = from + 5;
  for (; k < s.blocks; k += 2) {
    const frame = Math.round(start + (k * s.blockSamples - lead) / spf);
    if (frame > from + seconds / FRAME_SEC) break;
    out.push({ tag, off: f.start + s.dataStart + k * group, len: Math.min(2, s.blocks - k) * group, frame: Math.max(frame, out.at(-1).frame + 20) });
  }
  return out;
}

test('a renamed stream read block by block is the music; its position follows the reads, wraps at its loop', () => {
  const cci = cciWithRomfs({}, files);
  const { t, ev, fs, feed } = trackerFor(cci);
  const s = cstmInfo(trackA.file);
  const reads = streamReads(fs, 'zz/xq1.bin', s, { seconds: 1.2 });
  feed(reads.slice(0, 3));
  assert.equal(t.playing()?.file.path, 'zz/xq1.bin');
  assert.equal(ev.find((e) => e.type === 'start').path, 'zz/xq1.bin');
  // a few frames after the first read the track starts at 0; position = frames × 547.0 samples
  const p = t.playing(reads[0].frame + 5 + 100);
  assert.ok(Math.abs(p.u - 100 * s.rate * FRAME_SEC) < 1, `pos ${p.u}`);
  assert.equal(p.pos, wrap(s, p.u)); // (a tiny test track: long past its loop end already)
  // the loop: a read back to the loop start block goes on after the loop end
  const f = fs.files.find((x) => x.path === 'zz/xq1.bin');
  const group = s.blockSize * s.channels;
  const last = reads.at(-1).frame;
  feed([{ tag: 1, off: f.start + s.dataStart + (s.blocks - 1) * group, len: group, frame: last + 20 }]);
  feed([{ tag: 1, off: f.start + s.dataStart + Math.floor(s.loop.start / s.blockSamples) * group, len: 2 * group, frame: last + 40 }]);
  assert.ok(ev.some((e) => e.type === 'loop'));
  const later = t.playing(last + 200);
  assert.ok(later.pos >= s.loop.start && later.pos < s.loop.end);
  assert.equal(wrap(s, s.loop.end + 5), s.loop.start + 5);
  // the file that isn't a stream (named .bcstm) and the GARC blob are never music
  feed([{ tag: 1, off: fs.files.find((x) => x.path === 'sound/notastream.bcstm').start, len: 64, frame: last + 50 }]);
  feed([{ tag: 1, off: fs.files.find((x) => x.path === 'a/0/1/2').start, len: 64, frame: last + 51 }]);
  assert.equal(t.playing().file.path, 'zz/xq1.bin');
});

test('a jingle (short, no loop) never takes over; a new stream does, and the old one stops once it ran out', () => {
  const cci = cciWithRomfs({}, files);
  const { t, ev, fs, feed } = trackerFor(cci);
  const a = cstmInfo(trackA.file);
  const ra = streamReads(fs, 'zz/xq1.bin', a, { seconds: 0.5 });
  feed(ra);
  const j = cstmInfo(jingle.file);
  assert.ok(isJingle(j, 'zz/data/fanfare'));
  assert.ok(!isJingle(a, 'whatever'));
  assert.ok(isJingle({ ...a, loop: a.loop, samples: a.samples }, 'me_fanfare.bcstm')); // (the name as a hint only for short looping ones)
  feed(streamReads(fs, 'zz/data/fanfare', j, { from: ra.at(-1).frame + 5, seconds: 0.3 }));
  assert.equal(t.playing().file.path, 'zz/xq1.bin', 'the jingle is not the music');
  const c = cstmInfo(trackC.file);
  feed(streamReads(fs, 'zz/data/0002', c, { from: ra.at(-1).frame + 30, seconds: 0.4 }));
  assert.equal(t.playing().file.path, 'zz/data/0002');
  assert.ok(ev.some((e) => e.type === 'track' && e.path === 'zz/data/0002'));
  t.tick(2000);
  assert.ok(ev.some((e) => e.type === 'stop' && e.key.endsWith(`:${fs.files.find((x) => x.path === 'zz/xq1.bin').start}`)));
});

test('reads that came before the tables or the file\'s header was known are placed once they are', () => {
  const cci = cciWithRomfs({}, files);
  const fs = romfsOfFile(reader(cci));
  const t = new RomMusicTracker();
  const s = cstmInfo(trackA.file);
  const reads = streamReads(fs, 'zz/xq1.bin', s, { seconds: 0.3 });
  const needs = t.reads(reads);
  assert.deepEqual(needs, [{ type: 'files', tag: 1 }]);
  assert.equal(t.playing(), null);
  t.setFiles(1, fs.files);
  const f = fs.files.find((x) => x.path === 'zz/xq1.bin');
  assert.equal(t.playing(), null); // (its header isn't known yet)
  t.setInfo(1, f, s);
  assert.equal(t.playing().file.path, 'zz/xq1.bin');
  assert.equal(t.streams.get(`1:${f.start}`).started, reads[0].frame);
});

test('a stream without loop points learns its loop from the read back (as X/Y\'s AAC without a sound archive)', () => {
  const cci = cciWithRomfs({}, files);
  const { t, ev, fs, feed } = trackerFor(cci);
  const b = cstmInfo(trackB.file);
  assert.equal(b.loop, null);
  const f = fs.files.find((x) => x.path === 'zz/data/0001');
  const group = b.blockSize * b.channels;
  feed(streamReads(fs, 'zz/data/0001', b, { seconds: 3 }));
  const lastFrame = t.streams.get(`1:${f.start}`).lastFrame;
  feed([{ tag: 1, off: f.start + b.dataStart + 2 * group, len: 2 * group, frame: lastFrame + 30 }]);
  const learned = ev.find((e) => e.type === 'learned');
  assert.ok(learned, 'learned');
  assert.deepEqual({ ...learned.loop }, { start: 2 * b.blockSamples, end: b.samples, learned: true });
});

test('real reads (Pokémon Sun in Azahar, two songs, title and intro): the position matches the game\'s own sound', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/rommusic-sun-reads.json', import.meta.url), 'utf8'));
  for (const rename of [false, true]) {
    // (renamed: every path replaced – the result must not change)
    const list = fx.files.map((f, i) => ({ path: rename ? `x/${i}.dat` : f.path, start: f.start, size: f.size })).sort((a, b) => a.start - b.start);
    const infos = new Map(fx.files.map((f) => [f.start, f.info]));
    const truth = new Map(fx.files.filter((f) => fx.truth[f.path.split('/').pop()] != null).map((f) => [f.start, fx.truth[f.path.split('/').pop()]]));
    const t = new RomMusicTracker();
    const audioAt = (fr) => {
      const fa = fx.frames;
      for (let i = 1; i < fa.length; i++) if (fa[i][0] >= fr) return fa[i - 1][1] + ((fa[i][1] - fa[i - 1][1]) * (fr - fa[i - 1][0])) / (fa[i][0] - fa[i - 1][0] || 1);
      return null;
    };
    const reads = fx.reads.map(([frame, tag, off, len]) => ({ frame, tag, off, len }));
    let ri = 0;
    const errs = [];
    for (const [frame] of fx.frames) {
      const batch = [];
      while (ri < reads.length && reads[ri].frame <= frame) batch.push(reads[ri++]);
      for (const n of t.reads(batch)) {
        if (n.type === 'files') t.setFiles(n.tag, list);
        else t.setInfo(n.tag, n.file, infos.get(n.file.start));
      }
      t.tick(frame);
      const p = t.playing(frame);
      if (!p || !truth.has(p.file.start)) continue;
      const st = t.cur;
      if (st.anchor.guess) continue; // (the first second: placed by the start, ±15 frames)
      const u = audioAt(frame) - truth.get(p.file.start);
      errs.push(Math.abs(p.pos - wrap(p.info, u)));
    }
    errs.sort((a, b) => a - b);
    assert.ok(errs.length > 150, `samples ${errs.length}`);
    // measured: median ~50 samples (1.5 ms), worst ~250 (8 ms) at 32728 Hz
    assert.ok(errs[errs.length >> 1] < 150, `median ${errs[errs.length >> 1]}`);
    assert.ok(errs.at(-1) < 400, `max ${errs.at(-1)}`);
    assert.equal(t.cur.file.path, rename ? t.cur.file.path : 'data/sound/bgm_nj_starting.dspadpcm.bcstm');
  }
});

// ---- the voice and the mixer -------------------------------------------------------------------------------------------
const SR = 32728;
const N = 128;
/** A noisy test track (unique everywhere: alignment can only match its own place). */
function pcmTrack(seconds, seed, loop = null) {
  const r = rng(seed);
  const n = Math.round(seconds * SR);
  const l = new Int16Array(n);
  const rr = new Int16Array(n);
  let a = 0;
  for (let i = 0; i < n; i++) {
    a = a * 0.9 + (r() - 0.5) * 6000; // (low-passed noise: music-like, not white)
    l[i] = Math.round(a);
    rr[i] = Math.round(a * 0.8);
  }
  return { l, r: rr, rate: SR, loop };
}
const q = (x) => Math.round(x * 32768);

/** Runs the mixer `blocks` × 128 samples; `game(i)` gives the input sample at absolute index i (null: silence). */
function run(m, blocks, game, from) {
  const outL = [];
  const inL = new Float32Array(N);
  const inR = new Float32Array(N);
  const oL = new Float32Array(N);
  const oR = new Float32Array(N);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < N; i++) {
      const v = game(from + b * N + i);
      inL[i] = v ? v[0] : 0;
      inR[i] = v ? v[1] : 0;
    }
    m.process(inL, inR, oL, oR, N);
    outL.push(...oL.map(q));
  }
  return outL;
}

test('the ROM voice: silent along at 1×, the track itself in fast-forward – its loop, the next track, sample for sample', () => {
  const A = pcmTrack(3, 11, { start: Math.round(0.5 * SR), end: Math.round(2.5 * SR) });
  const B = pcmTrack(4, 12);
  const ev = [];
  const m = new TurboMixer(SR, { onEvent: (e) => ev.push(e) });
  m.command({ type: 'mode', mode: 'music' });
  m.command({ type: 'rom-track', id: 'A', kind: 'pcm', ...A, l: A.l.slice(), r: A.r.slice() });
  const noise = rng(99);
  const game = () => [(noise() - 0.5) * 0.5, (noise() - 0.5) * 0.5];
  // 1×: told where the game is – the game's sound comes out unchanged, the voice plays along unheard
  m.command({ type: 'rom-sync', id: 'A', pos: 1000, slow: true });
  let t = 0;
  const g1 = [];
  const gameRec = (i) => {
    const v = game(i);
    g1.push(q(v[0]));
    return v;
  };
  const out1 = run(m, 40, gameRec, t);
  assert.deepEqual(out1, g1, '1×: the game\'s own sound');
  t += 40 * N;
  assert.equal(m.rom.pos, 1000 + 40 * N);
  // fast-forward: after the fade (80 ms) the output is track A from where it is, at normal speed
  m.command({ type: 'speed', ratio: 4 });
  const out2 = run(m, 120, game, t);
  const p0 = 1000 + 40 * N;
  const fade = Math.round(0.08 * SR);
  for (let i = fade + N + 10; i < out2.length; i++) {
    const k = p0 + i;
    const want = A.l[k >= A.loop.end ? A.loop.start + ((k - A.loop.start) % (A.loop.end - A.loop.start)) : k];
    assert.ok(Math.abs(out2[i] - want) <= 1, `sample ${i}: ${out2[i]} vs ${want}`);
  }
  t += 120 * N;
  // past the loop end: the loop is followed exactly
  const out3 = run(m, 400, game, t);
  const p3 = p0 + 120 * N;
  for (let i = 0; i < out3.length; i++) {
    let k = p3 + i;
    if (k >= A.loop.end) k = A.loop.start + ((k - A.loop.start) % (A.loop.end - A.loop.start));
    assert.ok(Math.abs(out3[i] - A.l[k]) <= 1, `loop sample ${i}`);
  }
  t += 400 * N;
  // the game starts track B (its data comes after the position): crossfade 0.4 s, then B exactly
  m.command({ type: 'rom-sync', id: 'B', pos: 500, slow: false });
  m.command({ type: 'rom-track', id: 'B', kind: 'pcm', ...B, l: B.l.slice(), r: B.r.slice() });
  const out4 = run(m, 200, game, t);
  const xf = Math.round(0.4 * SR);
  for (let i = xf + N + 10; i < out4.length; i++) assert.ok(Math.abs(out4[i] - B.l[500 + i]) <= 1, `B sample ${i}`);
  assert.equal(m.playing().src, 'rom');
  assert.equal(m.playing().of, 'B');
  assert.ok(ev.some((e) => e.type === 'rom' && e.id === 'B' && e.turbo));
});

test('after fast-forward the voice lines up with the game\'s sound to the sample, then hands back without a seam', () => {
  const A = pcmTrack(6, 21);
  const ev = [];
  const m = new TurboMixer(SR, { onEvent: (e) => ev.push(e) });
  m.command({ type: 'mode', mode: 'music' });
  m.command({ type: 'rom-track', id: 'A', kind: 'pcm', ...A, l: A.l.slice(), r: A.r.slice() });
  const noise = rng(5);
  m.command({ type: 'rom-sync', id: 'A', pos: 0, slow: true });
  m.command({ type: 'speed', ratio: 4 });
  let t = 0;
  run(m, 200, () => [(noise() - 0.5) * 0.4, 0], t);
  t += 200 * N;
  // the game is now at G in the track; the reads say G + 150 (a few ms off, as they are)
  m.command({ type: 'speed', ratio: 1 });
  const G = Math.round(3 * SR);
  // a position from a frame that was still fast-forwarded must not be taken for the hand-back
  m.command({ type: 'rom-sync', id: 'A', pos: G - 20000, slow: false });
  m.command({ type: 'rom-sync', id: 'A', pos: G + 150, slow: true });
  const gameAt = (i) => [A.l[G + (i - t)] / 32768, A.r[G + (i - t)] / 32768];
  const out = run(m, 300, gameAt, t);
  const al = ev.find((e) => e.type === 'rom-align' && e.back);
  assert.ok(al, 'lined up');
  assert.equal(al.d, -150);
  assert.equal(al.score, 1);
  // from the hand-back on, what comes out is the game's (= the track's) sound with no seam: the voice and the game are
  // the same samples while they crossfade
  const start = Math.round(0.1 * SR);
  // (within the crossfade the two fades' gains add up to 1 within a block's step – a hair, not a seam)
  for (let i = start; i < out.length; i++) assert.ok(Math.abs(out[i] - A.l[G + i]) <= Math.max(3, Math.abs(A.l[G + i]) * 0.01), `sample ${i}: ${out[i]} vs ${A.l[G + i]}`);
  assert.equal(m.playing().src, 'game');
});

test('alignLag finds the game\'s place in the track to the sample, and says so when it can\'t', () => {
  const A = pcmTrack(2, 31);
  const src = new PcmSource(A);
  const game = new Float32Array(2046);
  for (let i = 0; i < game.length; i++) game[i] = (A.l[20000 + i] + A.r[20000 + i]) / 65536;
  const a1 = alignLag(game, src, 20000 - 777);
  assert.equal(a1.d, 777);
  assert.equal(a1.score, 1);
  assert.deepEqual(alignLag(game, src, 20000 + 1500).d, -1500);
  assert.equal(alignLag(new Float32Array(2046), src, 20000), null); // (silence)
  const r = alignLag(game, src, 20000 + 30000, 2048); // (out of range: a poor match, not a wrong certainty)
  assert.ok(r.score < 0.8);
  const big = new Float32Array(SR);
  const b = bestLag(game, Float32Array.from({ length: 30000 }, (_, i) => (A.l[10000 + i] + A.r[10000 + i]) / 65536));
  assert.equal(b.lag, 10000);
  assert.ok(b.score > 0.999);
  assert.equal(bestLag(big.subarray(0, 100), big.subarray(0, 50)), null);
});

test('RomVoice: keeps three tracks (never the playing one), cuts or crossfades, stops at the end of a song without loop', () => {
  const v = new RomVoice(SR);
  const mk = (id, sec) => ({ id, kind: 'pcm', ...pcmTrack(sec, id.charCodeAt(0)) });
  for (const id of ['a', 'b', 'c', 'd']) v.add(mk(id, 0.1));
  assert.equal(v.tracks.size, 3);
  assert.ok(!v.has('a'));
  v.play('b', 0, 0);
  for (const id of ['e', 'f', 'g']) v.add(mk(id, 0.1));
  assert.ok(v.has('b'), 'the playing track stays');
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  for (let i = 0; i < 40; i++) v.render(l, r, N);
  assert.equal(v.id, null, 'ended (0.1 s, no loop)');
  assert.equal(v.add({ id: 'x', kind: 'what' }), false);
  // a CSTM source at another rate is resampled (Catmull-Rom), the position advancing by the ratio
  const c = makeCstm({ seed: 9, rate: 48000 });
  v.add({ id: 'c48', kind: 'cstm', file: c.file, info: cstmInfo(c.file) });
  v.play('c48', 100, 0);
  v.render(l, r, N);
  assert.ok(Math.abs(v.pos - (100 + (N * 48000) / SR)) < 1e-6);
});

// ---- the page's plumbing --------------------------------------------------------------------------------------------
test('ROMFS / ROMREAD wire formats (ctrhost.c messages 9 and 10)', () => {
  const b = new Uint8Array(16 + 2 * 32);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, 1234n, true);
  v.setUint32(8, 2, true);
  v.setUint32(12, 1, true);
  for (let i = 0; i < 2; i++) {
    v.setBigUint64(16 + i * 32, BigInt(7 + i), true);
    v.setBigUint64(24 + i * 32, 0x123456789n + BigInt(i), true);
    v.setUint32(32 + i * 32, 0x8000, true);
    v.setUint32(36 + i * 32, 1, true);
    v.setBigUint64(40 + i * 32, 1230n + BigInt(i), true);
  }
  assert.deepEqual(parseRomfs(b), { frame: 1234, fast: true, reads: [{ serial: 7, off: 0x123456789, len: 0x8000, tag: 1, frame: 1230 }, { serial: 8, off: 0x12345678a, len: 0x8000, tag: 1, frame: 1231 }] });
  assert.deepEqual(parseRomfs(new Uint8Array(4)).reads, []);
  const p = romReadPayload(5, 2, 0x100000000 + 16, 4096);
  const pv = new DataView(p.buffer);
  assert.equal(pv.getUint32(0, true), 5);
  assert.equal(pv.getUint32(4, true), 2);
  assert.equal(pv.getBigUint64(8, true), 0x100000010n);
  assert.equal(pv.getUint32(16, true), 4096);
});

test('the page reads tables, headers and the track through the core and hands the track to the worklet', async () => {
  const cci = cciWithRomfs({}, files);
  const fs = romfsOfFile(reader(cci));
  const l3 = cci.subarray(fs.base);
  const told = [];
  const logs = [];
  const box = {}; // (the RomMusic below – its answers come back through send)
  const send = (payload) => {
    const v = new DataView(payload.buffer, payload.byteOffset);
    const id = v.getUint32(0, true);
    const off = Number(v.getBigUint64(8, true));
    const len = v.getUint32(16, true);
    // the host's answer: status 0, the RomFS size, the bytes
    setTimeout(() => {
      const bytes = l3.subarray(off, Math.min(l3.length, off + len));
      const a = new Uint8Array(16 + bytes.length);
      const av = new DataView(a.buffer);
      av.setUint32(0, id, true);
      av.setBigUint64(8, BigInt(l3.length), true);
      a.set(bytes, 16);
      box.rm.onRomData(a);
    }, 0);
    return Promise.resolve(true);
  };
  const rm = new RomMusic({ send, tell: (m) => told.push(m), log: (e) => logs.push(e) });
  box.rm = rm;
  const s = cstmInfo(trackA.file);
  const reads = streamReads(fs, 'zz/xq1.bin', s, { seconds: 1 });
  const msg = (frame, list) => {
    const b = new Uint8Array(16 + list.length * 32);
    const v = new DataView(b.buffer);
    v.setBigUint64(0, BigInt(frame), true);
    v.setUint32(8, list.length, true);
    list.forEach((r, i) => {
      v.setBigUint64(24 + i * 32, BigInt(r.off), true);
      v.setUint32(32 + i * 32, r.len, true);
      v.setUint32(36 + i * 32, r.tag, true);
      v.setBigUint64(40 + i * 32, BigInt(r.frame), true);
    });
    return b;
  };
  rm.onRomfs(msg(reads[2].frame, reads.slice(0, 3)));
  for (let i = 0; i < 50 && !told.some((m) => m.type === 'rom-track'); i++) {
    await new Promise((r) => setTimeout(r, 5));
    rm.onRomfs(msg(reads[2].frame + i, []));
  }
  const track = told.find((m) => m.type === 'rom-track');
  assert.ok(track, `track told (${JSON.stringify(logs.slice(-3))})`);
  assert.equal(track.kind, 'cstm');
  assert.deepEqual(track.file, trackA.file);
  const sync = told.filter((m) => m.type === 'rom-sync').at(-1);
  assert.equal(sync.id, track.id);
  assert.ok(sync.inband && sync.slow);
  assert.ok(logs.some((e) => e.type === 'romfs' && e.files === 6));
  assert.ok(logs.some((e) => e.type === 'stream' && e.path === 'zz/xq1.bin'));
  assert.equal(rm.state().playing.path, 'zz/xq1.bin');
});

// ---- the core's read log (C++, from the Azahar patch) ---------------------------------------------------------------
const patch = readFileSync(new URL('../native/azahar-patch/souldew-romfs.patch', import.meta.url), 'utf8');
/** A file the patch adds, as it will be in the Azahar tree. */
function addedFile(name) {
  const at = patch.indexOf(`+++ b/${name}`);
  assert.ok(at >= 0, name);
  const body = patch.slice(patch.indexOf('\n@@', at) + 1);
  const end = body.indexOf('\ndiff --git');
  return (end >= 0 ? body.slice(0, end) : body).split('\n').filter((l) => !l.startsWith('@@')).map((l) => l.slice(1)).join('\n');
}
const cxx = ['c++', 'g++', 'clang++'].find((c) => spawnSync(c, ['--version']).status === 0);

test('the core\'s RomFS read log: many writers, one reader, nothing torn, overflow drops the oldest', { skip: !cxx && 'no C++ compiler' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-ring-'));
  try {
    writeFileSync(join(dir, 'souldew_romfs_ring.h'), addedFile('src/core/file_sys/souldew_romfs_ring.h'));
    writeFileSync(join(dir, 'ring_test.cpp'), `
#include "souldew_romfs_ring.h"
#include <atomic>
#include <cstdio>
#include <thread>
#include <vector>
using SouldewRomfs::Read;
int main() {
  {
    SouldewRomfs::Ring<256> r;
    for (uint64_t i = 0; i < 1000; i++) r.Push(i * 7, (uint32_t)i, 3);
    Read out[300];
    uint32_t n = r.Drain(out, 300);
    if (n != 256 || out[0].serial != 744 || out[255].serial != 999) { printf("overflow %u %llu\\n", n, (unsigned long long)out[0].serial); return 1; }
    for (uint32_t i = 0; i < n; i++) if (out[i].offset != out[i].serial * 7 || out[i].length != out[i].serial || out[i].tag != 3) { printf("torn\\n"); return 1; }
    if (r.Drain(out, 300) != 0) return 1;
    r.Push(5, 6, 7);
    if (r.Drain(out, 1) != 1 || out[0].serial != 1000) return 1;
  }
  {
    static SouldewRomfs::Ring<256> r;
    const int P = 4;
    const uint64_t M = 200000;
    std::atomic<int> done{0};
    std::vector<std::thread> th;
    for (int t = 0; t < P; t++) th.emplace_back([t, M, &done] {
      for (uint64_t i = 0; i < M; i++) r.Push(((uint64_t)t << 40) | i, (uint32_t)(i ^ (uint64_t)t), (uint32_t)t + 1);
      done++;
    });
    uint64_t got = 0, last = 0, lastOf[P] = {0};
    bool first = true, firstOf[P] = {true, true, true, true};
    Read buf[64];
    for (;;) {
      bool all = done.load() == P;
      uint32_t n = r.Drain(buf, 64);
      for (uint32_t i = 0; i < n; i++) {
        const Read& e = buf[i];
        if (!first && e.serial <= last) { printf("order\\n"); return 1; }
        first = false;
        last = e.serial;
        int t = (int)e.tag - 1;
        if (t < 0 || t >= P) { printf("tag\\n"); return 1; }
        uint64_t idx = e.offset & ((1ull << 40) - 1);
        if ((e.offset >> 40) != (uint64_t)t || e.length != (uint32_t)(idx ^ (uint64_t)t)) { printf("torn\\n"); return 1; }
        if (!firstOf[t] && idx <= lastOf[t]) { printf("producer order\\n"); return 1; }
        firstOf[t] = false;
        lastOf[t] = idx;
        got++;
      }
      if (all && n == 0) break;
    }
    for (auto& x : th) x.join();
    const uint64_t total = (uint64_t)P * M;
    if (r.Count() != total) { printf("count\\n"); return 1; }
    printf("ok %llu %llu\\n", (unsigned long long)got, (unsigned long long)(total - got));
  }
  return 0;
}
`);
    const exe = join(dir, process.platform === 'win32' ? 'ring_test.exe' : 'ring_test');
    const c = spawnSync(cxx, ['-std=c++17', '-O2', '-pthread', '-Wall', '-o', exe, join(dir, 'ring_test.cpp')], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [, got, lost] = r.stdout.trim().split(' ').map(Number);
    assert.equal(got + lost, 800000);
    assert.ok(got > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the patch: IVFCFile::Read notes every game read, the core exports the calls (Windows: RETRO_API, macOS: .def)', () => {
  assert.match(patch, /^\+ {4}Souldew::Note\(romfs_file, offset, length\); \/\/ \(souldew\)$/m);
  for (const s of ['souldew_romfs_reads(uint64_t* out, uint32_t max)', 'souldew_romfs_read(uint32_t tag, uint64_t offset, void* out, uint32_t size)', 'souldew_romfs_size(uint32_t tag)']) assert.ok(new RegExp(`^\\+RETRO_API uint\\d+_t ${s.replace(/[()*]/g, '\\$&')}`, 'm').test(patch), s);
  for (const s of ['_souldew_romfs_read', '_souldew_romfs_reads', '_souldew_romfs_size']) assert.match(patch, new RegExp(`^\\+${s}$`, 'm'));
  assert.match(patch, /thread_local bool own_read/); // (its own reads aren't the game's)
  const host = readFileSync(new URL('../native/ctr-host/ctrhost.c', import.meta.url), 'utf8');
  for (const s of ['souldew_romfs_reads', 'souldew_romfs_read', 'souldew_romfs_size']) assert.match(host, new RegExp(`${s} = dlsym\\(lib, "${s}"\\)`));
  assert.match(host, /send_msg\(9, romfs_buf, 16 \+ romfs_n \* 32\)/);
  assert.match(host, /case 10: \/\/ ROMREAD/);
  // sent before the frame's sound (the page lines the music up with it)
  assert.ok(host.indexOf('romfs_send(frame, t, turbo);') < host.indexOf('if (audio_n) send_msg(3, audio_buf'));
  // the CI builds the Windows and Linux core with every patch and checks the exports
  const ci = readFileSync(new URL('../.github/workflows/ctr.yml', import.meta.url), 'utf8');
  assert.match(ci, /for p in native\/azahar-patch\/\*\.patch/);
  assert.match(ci, /souldew_romfs_reads souldew_romfs_read souldew_romfs_size/);
});

test('the server takes ROMREAD only with its exact size and a sane length', async () => {
  const DATA = mkdtempSync(join(tmpdir(), 'sls-rommusic-'));
  process.env.SLS_DATA_DIR = DATA;
  try {
    const { checkCommands, command, CMD, CTR_ROMREAD_MAX } = await import('../server/lib/ctr.mjs');
    const ok = Buffer.from(romReadPayload(1, 1, 0, 4096));
    assert.ok(checkCommands(command(CMD.ROMREAD, ok)));
    assert.throws(() => checkCommands(command(CMD.ROMREAD, Buffer.alloc(19))));
    assert.throws(() => checkCommands(command(CMD.ROMREAD, Buffer.from(romReadPayload(1, 1, 0, CTR_ROMREAD_MAX + 1)))));
  } finally {
    rmSync(DATA, { recursive: true, force: true });
  }
});

// ---- a real game, when one is given (a COPY: ROMMUSIC_3DS=/path/to/copy.3ds) ------------------------------------------
const real = process.env.ROMMUSIC_3DS;
test('a real game\'s music: every stream decodes, its loop is seamless', { skip: !(real && existsSync(real)) && 'no ROMMUSIC_3DS' }, () => {
  const fd = openSync(real, 'r');
  try {
    const readAt = (o, n) => {
      const b = Buffer.alloc(n);
      return new Uint8Array(b.buffer, b.byteOffset, readSync(fd, b, 0, n, o));
    };
    const idx = musicIndex(readAt);
    assert.ok(idx.streams.length > 50, `streams ${idx.streams.length}`);
    const looping = idx.streams.filter((x) => x.info.codec === 'cstm' && x.info.loop).slice(0, 5);
    for (const st of looping) {
      const file = readAt(idx.base + st.start, st.size);
      const s = cstmInfo(file);
      const L = new Float32Array(s.samples);
      const hist = s.hist.map((h) => [...h]);
      for (let i = 0; i < s.blocks; i++) {
        const b = cstmDecodeBlock(s, file, i, hist);
        for (let k = 0; k < b[0].length; k++) L[i * s.blockSamples + k] = b[0][k];
      }
      // the music just before the loop end continues like the music just before the loop start
      let num = 0;
      let ea = 0;
      let eb = 0;
      for (let k = 1; k <= 4096; k++) {
        num += L[s.loop.end - k] * L[s.loop.start - k];
        ea += L[s.loop.end - k] ** 2;
        eb += L[s.loop.start - k] ** 2;
      }
      assert.ok(num / Math.sqrt(ea * eb) > 0.9, st.path);
    }
  } finally {
    closeSync(fd);
  }
});

// ---- X/Y's AAC reader (Windows verification, Pokémon Y): aligned, overlapping reads; a lead of its own ----------------
/** An AAC stream of `n` frames (lengths around 1 KB) and the game's reads of it: 20 KB from an offset aligned down to
 * 0x200 (overlapping the read before), three at once to start, then one whenever the sound reaches the data's end minus
 * `lead` (in samples). Returns { file, frames, reads, startFrame }. */
function aacGame({ n = 1100, lead = 70000, from = 1000, seconds = 20, loopBack = null } = {}) {
  const r = rng(77);
  const lens = Array.from({ length: n }, () => 980 + Math.floor(r() * 90));
  const file = makeAdts(lens);
  const frames = adtsFrames(file);
  const info = { codec: 'adts', rate: 48000, channels: 2, samples: frames.samples - 1024, priming: 1024, frames, loop: loopBack };
  const spf = 48000 * FRAME_SEC;
  const start = from + 5; // the sound starts a few frames after the first read
  const reads = [];
  let B = 0;
  let base = 0; // (samples of the loops taken: the unwrapped line)
  const through = (b) => Math.max(0, adtsSamplesThrough(frames, b) - 1024);
  for (let k = 0; ; k++) {
    const at = B & ~0x1ff;
    const len = Math.min(20480 + (B - at), file.length - at);
    let frame;
    if (k < 3) frame = from + k;
    else frame = Math.ceil(start + (base + through(B) - lead) / spf);
    if (frame > from + seconds / FRAME_SEC) break;
    reads.push({ tag: 1, off: at, len, frame: Math.max(frame, (reads.at(-1)?.frame ?? 0) + 1) });
    B = at + len;
    if (B >= file.length) {
      if (!loopBack) break;
      base += loopBack.end - loopBack.start;
      B = frames.offsets[Math.floor((loopBack.start + 1024) / 1024)]; // the frame holding the loop start
    }
  }
  return { file, info, reads, start, spf };
}

test('X/Y\'s AAC reader (aligned reads that overlap): one start, steady reads, the line follows the frames', () => {
  const g = aacGame({ seconds: 15 });
  const files = [{ path: 'sound/zz.aac', start: 0, size: g.file.length }];
  const ev = [];
  const t = new RomMusicTracker({ onEvent: (e) => ev.push(e) });
  for (const n of t.reads(g.reads.slice(0, 1))) if (n.type === 'files') for (const m of t.setFiles(1, files)) t.setInfo(1, m.file, g.info);
  for (const r of g.reads.slice(1)) t.reads([r]);
  assert.equal(ev.filter((e) => e.type === 'start').length, 1, 'one start, not one per read');
  const st = t.cur;
  assert.ok(st && !st.anchor.guess && st.steady > 10, `steady ${st?.steady}`);
  // placed with the default lead (1.76 s): off by default − real lead; the game's sound fixes that (nudge) – and it stays
  const f = g.reads.at(-1).frame;
  const truth = (fr) => (fr - g.start) * g.spf;
  const off = t.playing(f).u - truth(f);
  assert.ok(Math.abs(off - (70000 - defaultLead(g.info))) < 1500, `off ${off}`);
  t.nudge(-off, { codec: 'adts' });
  assert.ok(ev.some((e) => e.type === 'anchor' && e.heard));
  const g2 = aacGame({ seconds: 25 });
  for (const r of g2.reads.filter((x) => x.frame > f)) t.reads([r]);
  const f2 = g2.reads.at(-1).frame;
  assert.ok(Math.abs(t.playing(f2).u - truth(f2)) < 1100, `after the nudge: ${t.playing(f2).u - truth(f2)}`); // (≈ one AAC frame: what a read can tell)
  assert.ok(Math.abs(t.leadOf(g.info) - 70000) < 1100, `lead ${t.leadOf(g.info)}`);
});

test('X/Y\'s AAC reader: the read back to the loop start is the loop (from the sound archive), never a restart', () => {
  const loop = { start: 292584, end: 600000 };
  const g = aacGame({ n: 700, seconds: 30, loopBack: loop });
  assert.ok(g.reads.some((r, i) => i && r.off < g.reads[i - 1].off), 'the reads go back');
  const files = [{ path: 'x/y', start: 0, size: g.file.length }];
  const ev = [];
  const t = new RomMusicTracker({ onEvent: (e) => ev.push(e) });
  for (const n of t.reads(g.reads.slice(0, 1))) if (n.type === 'files') for (const m of t.setFiles(1, files)) t.setInfo(1, m.file, g.info);
  for (const r of g.reads.slice(1)) t.reads([r]);
  assert.equal(ev.filter((e) => e.type === 'start').length, 1);
  assert.ok(ev.filter((e) => e.type === 'loop').length >= 1);
  const p = t.playing(g.reads.at(-1).frame);
  assert.ok(p.pos >= loop.start && p.pos < loop.end && p.loops >= 1);
});

test('calibration: AAC\'s different decoder still lines up (the band below 2 kHz), and the line is moved by it', () => {
  const A = pcmTrack(8, 41);
  const rm = new RomMusic({ send: () => true, tell: () => {}, rate: SR });
  // the game's sound: the track from 2.0 s on, with a top end of its own (another decoder): full-band below 0.85
  const noise = rng(3);
  const G0 = Math.round(2 * SR);
  const len = Math.round(3.2 * SR);
  const f = new Float32Array(len * 2);
  for (let i = 0; i < len; i++) {
    const hiss = (noise() - 0.5) * 0.24;
    f[2 * i] = A.l[G0 + i] / 32768 + hiss;
    f[2 * i + 1] = A.r[G0 + i] / 32768 + hiss;
  }
  rm.onGameSound(f);
  rm.game.frameAt = rm.game.at;
  const truthEnd = G0 + len;
  const t = { pcm: { l: A.l, r: A.r }, ratio: 1, voicePos: (x) => x };
  const p = { pos: truthEnd + 900, u: truthEnd + 900, info: { codec: 'adts', rate: SR } }; // the tracker: 900 samples ahead
  const r = rm.calibrate(p, t, { range: 0.8 });
  assert.ok(Math.abs(r.err + 900) <= 2, `err ${r.err}`);
  assert.ok(r.full < 0.85, `full ${r.full}`);
  assert.ok(r.band >= 0.9 && r.score >= 0.9, `band ${r.band} full ${r.full}`);
  // the tracker takes it (a line placed only by the start: as it is)
  const tr = new RomMusicTracker();
  tr.cur = { key: 'k', info: { codec: 'adts', rate: SR }, anchor: { frame: 0, u: 1000, guess: true }, errs: [] };
  assert.ok(tr.nudge(r.err, { codec: 'adts' }));
  assert.deepEqual({ ...tr.cur.anchor }, { frame: 0, u: 1000 + r.err, guess: false, heard: true });
});

test('the music log: a stream that restarts on every read is told once, then summed up – not 117 lines', () => {
  const logs = [];
  const rm = new RomMusic({ send: () => true, tell: () => {}, log: (e) => logs.push(e) });
  let now = 0;
  rm.now = () => now;
  for (let i = 0; i < 117; i++) {
    rm.onTrack({ type: 'start', key: '1:5', path: 'sound/bgm.aac', at: i * 20480, frame: 1000 + i * 25 });
    now += 25 * FRAME_SEC * 1000;
  }
  rm.onTrack({ type: 'track', key: '1:5', path: 'sound/bgm.aac' });
  assert.equal(logs.filter((e) => e.type === 'rom-start').length, 1);
  assert.ok(logs.filter((e) => e.type === 'rom-restarts').length <= 6);
  assert.equal(logs.filter((e) => e.type === 'rom-restarts').reduce((a, e) => a + e.count, 0) <= 116, true);
  assert.equal(logs.at(-1).type, 'rom-track');
  // another track's start is told at once
  rm.onTrack({ type: 'start', key: '1:9', path: 'sound/b.aac', at: 0, frame: 5000 });
  assert.equal(logs.at(-1).type, 'rom-start');
});

// ---- AAC calibration with real AAC frames --------------------------------------------------------------------------
// test/fixtures/rommusic-music.aac: 6 s of synthetic music (plucked chords, stereo, 48 kHz), encoded to ADTS AAC-LC with
// macOS' encoder (afconvert -f adts -d aac -b 96000) – encoder delay and all. Decoded with ffmpeg (as Chromium does, and
// FAAD in the core, both keep the 1024-sample priming): the game's path is Azahar's DSP voice playing the 48 kHz PCM at
// 32728 Hz with linear interpolation, the page's path the browser's decode resampled to the context's rate (soxr here)
// with the priming taken off (decodeAac).
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
function aacPaths() {
  const src = fileURLToPath(new URL('./fixtures/rommusic-music.aac', import.meta.url));
  const dec = (args) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', src, ...args, '-f', 'f32le', '-ac', '2', '-'], { maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, String(r.stderr));
    return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 2);
  };
  const d48 = dec([]);
  const d32 = dec(['-af', 'aresample=32728:resampler=soxr']);
  const SR = 32728;
  const step = 48000 / SR;
  const gameN = Math.floor((d48.length / 2 - 2) / step);
  const game = new Float32Array(gameN * 2);
  for (let i = 0; i < gameN; i++) {
    const x = i * step;
    const k = Math.floor(x);
    const f = x - k;
    for (let c = 0; c < 2; c++) game[2 * i + c] = d48[2 * k + c] * (1 - f) + d48[2 * (k + 1) + c] * f;
  }
  const skip = Math.round(1024 / step);
  const n = d32.length / 2 - skip;
  const l = new Int16Array(n);
  const r = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = Math.round(d32[2 * (i + skip)] * 32767);
    r[i] = Math.round(d32[2 * (i + skip) + 1] * 32767);
  }
  return { SR, step, game, gameN, track: { pcm: { l, r }, ratio: SR / 48000, voicePos: (x) => (x * SR) / 48000 } };
}

test('AAC calibration with real AAC frames: near the line, and far off it (wide search, taken when two agree)', { skip: !ffmpeg && 'no ffmpeg' }, async () => {
  const { SR, step, game, gameN, track } = aacPaths();
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/rommusic-music.aac', import.meta.url)));
  const frames = adtsFrames(bytes);
  assert.equal(frames.rate, 48000);
  const rm = new RomMusic({ send: () => {}, tell: () => {}, rate: SR });
  const end = Math.min(gameN, SR * 4 - 1);
  rm.onGameSound(game.subarray(0, end * 2));
  rm.game.frameAt = end;
  // the game's sample `end` is the track's (48 kHz, priming off) end·step − 1024
  const truth = end * step - 1024;
  const info = { codec: 'adts', rate: 48000 };
  for (const offMs of [0, 120, -300]) {
    const r = rm.calibrate({ pos: truth + (offMs / 1000) * 48000, info, u: truth }, track, { end, range: 0.4 });
    assert.ok(r.score >= 0.95, `score ${r.score} at ${offMs} ms`);
    assert.ok(Math.abs(r.err + (offMs / 1000) * 48000) < 2 * step, `err ${r.err} for ${offMs} ms`);
  }
  // 1.4 s off: the near search finds nothing; the wide one finds it – nudged only once a second wide search agrees
  const off = 1.4 * 48000;
  const nudges = [];
  rm.tracker.cur = { anchor: { guess: false } };
  rm.tracker.nudge = (e) => nudges.push(e);
  rm.tracker.playing = () => null;
  const p = { pos: truth + off, info, u: truth };
  const logs = [];
  rm.log = (e) => logs.push(e);
  rm.game.at = SR * 4; // (enough of the game's sound)
  rm.game.frameAt = end;
  for (let i = 0; i < 2; i++) {
    rm.cal.get('adts') && (rm.cal.get('adts').next = 0);
    rm.maybeCalibrate(p, track);
    await rm.calJob; // (the measurement runs in slices, off the frame's task)
  }
  const cal = logs.filter((e) => e.type === 'rom-calibrated');
  assert.equal(cal.length, 2);
  assert.ok(cal.every((e) => e.wide && e.score >= 0.95 && e.margin >= 0.08), JSON.stringify(cal));
  assert.deepEqual(cal.map((e) => e.taken), [false, true]);
  assert.equal(nudges.length, 1);
  assert.ok(Math.abs(nudges[0] + off) < 2 * step, `nudged by ${nudges[0]}`);
});
