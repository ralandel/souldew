// souldew+ PREVIEW MEDIA: what someone without souldew+ sees of every premium item before buying it – pictures only,
// rendered offline with the same engines from the design sources. No recipe, no code, no stylesheet: a PNG still and
// a short, low-resolution animated WebP loop per item, plus a still of the app in every colour skin. They are free to
// give away: the accounts service serves them to anyone (GET /v1/previews), signed like every pack, so the app still
// checks them against the pinned pack key before it shows one.
//
//   <kind>/<id>.png    still, display size ×2: banners 768×112, nameplates 320×52, frames 208×208
//   <kind>/<id>.webp   loop, native resolution (the page scales it pixelated), ≤ 150 KB, a few seconds
//   skins/<id>.webp    the library in that skin, 960×600 (scripts/plus-skin-shots.mjs renders it in Electron)
//
// Used by scripts/plus-dev-pack.mjs (--previews-source, and the test pack of --out).
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, mkdtempSync, statSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PREVIEW_KINDS = ['banners', 'nameplates', 'frames', 'skins'];
export const LOOP_MAX_BYTES = 150 * 1024;
const FPS = 12;

/** RGBA little-endian Uint32 pixels → nearest-neighbour ×k */
function upscale(w, h, src, k) {
  if (k === 1) return src;
  const out = new Uint32Array(w * k * h * k);
  for (let y = 0; y < h * k; y++) { const sy = (y / k) | 0; for (let x = 0; x < w * k; x++) out[y * w * k + x] = src[sy * w + ((x / k) | 0)]; }
  return out;
}

/** an animated WebP from RGBA frames (img2webp: lossless first – pixel art packs small – lossy when that is too big) */
function loopWebp(frames, w, h, encodePNG, file) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-loop-'));
  try {
    const names = frames.map((f, i) => {
      const p = join(dir, `f${String(i).padStart(3, '0')}.png`);
      writeFileSync(p, encodePNG(w, h, f));
      return p;
    });
    for (const mode of [['-lossless'], ['-lossy', '-q', '80'], ['-lossy', '-q', '55']]) {
      const r = spawnSync('img2webp', ['-loop', '0', '-d', String(Math.round(1000 / FPS)), '-mixed', ...mode, ...names, '-o', file], { encoding: 'utf8' });
      if (r.error) throw new Error('img2webp is needed for the preview loops (brew install webp)');
      if (r.status !== 0) throw new Error(`img2webp failed: ${r.stderr}`);
      if (statSync(file).size <= LOOP_MAX_BYTES) return;
    }
    throw new Error(`${basename(file)}: the loop stays over ${LOOP_MAX_BYTES} bytes`);
  } finally {
    for (const n of readdirSync(dir)) rmSync(join(dir, n));
    rmdirSync(dir);
  }
}

/**
 * The launch looks of "Your handheld" (launch/<name>.png – a 640×400 still – and launch/<name>.webp – a 3 s loop at
 * 288×180, 10 fps): "Your colours", Gold, Holo label and the Clear shell in each of its four colours, drawn by the real launch
 * scene in Electron (scripts/handheld/launch-shots.mjs) with the souldew+ looks' data `looks` (the design source's
 * handheld/looks.mjs LOOKS). The souldew+ page shows them on its launch cards to everyone (views/launchlooks.mjs).
 */
export function renderLaunchPreviews({ looks, out, log = console.log }) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-launchshots-'));
  try {
    writeFileSync(join(dir, 'looks.json'), JSON.stringify(looks));
    const electron = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
    const r = spawnSync(electron, [join(ROOT, 'scripts', 'handheld', 'launch-shots.mjs'), dir], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000, env });
    if (r.status !== 0 || !existsSync(join(dir, 'shots.json'))) throw new Error('could not render the launch previews');
    const files = [];
    mkdirSync(join(out, 'launch'), { recursive: true });
    for (const name of JSON.parse(readFileSync(join(dir, 'shots.json'), 'utf8'))) {
      const still = join(out, 'launch', `${name}.png`);
      writeFileSync(still, readFileSync(join(dir, `${name}.png`)));
      files.push({ path: `launch/${name}.png`, bytes: new Uint8Array(readFileSync(still)) });
      const fdir = join(dir, name);
      const frames = readdirSync(fdir).filter((f) => f.endsWith('.png')).sort().map((f) => join(fdir, f));
      const loop = join(out, 'launch', `${name}.webp`);
      let fits = false;
      for (const q of ['78', '62', '48']) { // rendered 3D (smooth light, not pixel art): lossy from the start
        const e = spawnSync('img2webp', ['-loop', '0', '-d', '100', '-lossy', '-q', q, '-m', '4', ...frames, '-o', loop], { encoding: 'utf8' });
        if (e.error) throw new Error('img2webp is needed for the preview loops (brew install webp)');
        if (e.status !== 0) throw new Error(`img2webp failed: ${e.stderr}`);
        if (statSync(loop).size <= LOOP_MAX_BYTES) { fits = true; break; }
      }
      if (!fits) throw new Error(`launch/${name}.webp stays over ${LOOP_MAX_BYTES} bytes`);
      files.push({ path: `launch/${name}.webp`, bytes: new Uint8Array(readFileSync(loop)) });
    }
    log(`previews: ${files.length / 2} launch looks`);
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Renders every premium banner, nameplate and frame into `out` (<kind>/<id>.png + .webp) and returns the file list
 * [{ path, bytes }]. design: the design/plus folder; banners / frames: the premium items.
 */
export async function renderItemPreviews({ design, banners, frames, out, log = console.log }) {
  const imp = (p) => import(pathToFileURL(join(design, p)).href);
  const { encodePNG } = await imp('banners/tools/png.mjs');
  const { compile } = await imp('banners/engine/index.mjs');
  const { compileFrame } = await imp('frames/engine/index.mjs');
  const files = [];
  const put = (path, bytes) => {
    const target = join(out, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.push({ path, bytes: new Uint8Array(bytes) });
  };
  const loop = (path, frs, w, h) => {
    const target = join(out, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    loopWebp(frs, w, h, encodePNG, target);
    files.push({ path, bytes: new Uint8Array(readFileSync(target)) });
  };
  const frameTimes = (from, secs) => Array.from({ length: Math.max(1, Math.round(secs * FPS)) }, (_, i) => from + i / FPS);

  // banners: the profile strip at 384 native columns (768×112 still), the loop at native size, 4 s
  for (const b of banners) {
    const sc = compile(b, { width: 384 });
    sc.noIntro = true;
    const buf = new Uint32Array(sc.W * sc.H);
    sc.frame(sc.still, buf);
    put(`banners/${b.id}.png`, encodePNG(sc.W * 2, sc.H * 2, upscale(sc.W, sc.H, buf, 2)));
    const lw = 192;
    const lc = compile(b, { width: lw });
    lc.noIntro = true;
    const span = sc.animated === false ? 0 : Math.min(4, lc.loop || 24);
    const frs = (span ? frameTimes(lc.still, span) : [lc.still]).map((t) => { const f = new Uint32Array(lc.W * lc.H); lc.frame(t, f); return f; });
    loop(`banners/${b.id}.webp`, frs, lc.W, lc.H);
    // nameplate: the banner's window behind a list row, faded into classic's row colour (160×26 native)
    const pc = compile({ ...b, plateBg: '#1b1a1f' }, { width: 384 });
    pc.noIntro = true;
    const pw = 160;
    const ph = 26;
    const o = { w: pw, h: ph, x: b.focusX ?? 250, y: 18 };
    const plate = (t) => { const f = new Uint32Array(pw * ph); pc.plate(t, f, o); return f; };
    put(`nameplates/${b.id}.png`, encodePNG(pw * 2, ph * 2, upscale(pw, ph, plate(pc.still), 2)));
    loop(`nameplates/${b.id}.webp`, (span ? frameTimes(pc.still, Math.min(3, span)) : [pc.still]).map(plate), pw, ph);
  }
  log(`previews: ${banners.length} banners + nameplates`);

  // frames: the profile size (N 40 → 52 px with the overhang; still ×4 = 208 px), the loop with its intro and some idle
  for (const r of frames) {
    const sc = compileFrame(r, { N: 40 });
    sc.noIntro = true;
    const buf = new Uint32Array(sc.G * sc.G);
    sc.frame(sc.still, buf);
    put(`frames/${r.id}.png`, encodePNG(sc.G * 4, sc.G * 4, upscale(sc.G, sc.G, buf, 4)));
    const lc = compileFrame(r, { N: 40 });
    lc.noIntro = false;
    const intro = lc.intro ? lc.intro.dur : 0;
    const secs = Math.min(4, intro + (lc.animated ? 2.5 : 0.8));
    const frs = frameTimes(0, secs).map((t) => { const f = new Uint32Array(lc.G * lc.G); lc.frame(t, f); return f; });
    loop(`frames/${r.id}.webp`, frs, lc.G, lc.G);
  }
  log(`previews: ${frames.length} frames`);

  return files;
}

/** The app in every colour skin (Electron: scripts/plus-skin-shots.mjs) → skins/<id>.webp, 960×600. */
export function renderSkinPreviews({ skins, out, log = console.log }) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-skinshots-'));
  try {
    writeFileSync(join(dir, 'skins.json'), JSON.stringify(skins.map((s) => ({ id: s.id, css: s.css }))));
    const electron = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
    const r = spawnSync(electron, [join(ROOT, 'scripts', 'plus-skin-shots.mjs'), dir], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000, env });
    if (r.status !== 0) throw new Error('could not render the skin previews');
    const files = [];
    mkdirSync(join(out, 'skins'), { recursive: true });
    for (const s of skins) {
      const png = join(dir, `${s.id}.png`);
      if (!existsSync(png)) throw new Error(`no skin preview for ${s.id}`);
      const target = join(out, 'skins', `${s.id}.webp`);
      const c = spawnSync('cwebp', ['-quiet', '-q', '82', '-m', '6', png, '-o', target]);
      if (c.status !== 0) throw new Error(`cwebp failed for ${s.id}`);
      files.push({ path: `skins/${s.id}.webp`, bytes: new Uint8Array(readFileSync(target)) });
    }
    log(`previews: ${skins.length} skins`);
    return files;
  } finally {
    for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
    rmdirSync(dir);
  }
}
