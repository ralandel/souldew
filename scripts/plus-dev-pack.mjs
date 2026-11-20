// The souldew+ pack from the design sources, in the ONE pack format (souldew-accounts docs/API.md §10: a signed manifest +
// one encrypted envelope per file, web/lib/cosmetics/pack/format.mjs).
//
//   node scripts/plus-dev-pack.mjs --design <design/plus> --source <dir> [--preview-source <dir>] [--previews-source <dir>]
//        the pack SOURCE folders, unsigned: the input of the owner's pack tool (souldew-accounts tools/pack-build.mjs),
//        which signs them offline with the production key – the app never sees that key.
//          <source>          contents.json, banners.json, frames.mjs, skins/*.css, fonts/*.woff2, assets/*
//          <preview-source>  the live theme preview pack (--kind preview): the skin stylesheets – nothing else (the
//                            colour skins need no fonts or art; the builder would still carry fonts/*.woff2 and art as
//                            PNG ≤ 512 px if a skin referenced them, within the service's limits)
//          <previews-source> the PUBLIC preview media (--kind previews): a still and a short loop of every premium banner,
//                            nameplate and frame and a still of the app in every colour skin –
//                            pictures only (scripts/plus-previews.mjs); the service hands them to anyone
//   node scripts/plus-dev-pack.mjs --design <design/plus> --out <dir>      a TEST pack to try the whole path locally:
//        signed with a throwaway dev key (dev-signing.key, kept so later builds keep the same identity) and sealed per file
//        for a throwaway account key – sealed-pack/, sealed-preview/, access.json, access-preview.json – plus the preview
//        media (previews/, access-previews.json; public, so not sealed). Then start the
//        server with SLS_PLUS_DEV_PACK=<dir>; the app trusts that key only then.
//   node scripts/plus-dev-pack.mjs --design <design/plus> --catalog        + the public catalog and the free content
//   --handheld <dir>   "Your handheld"'s souldew+ sources (default <design>/handheld: stickers.mjs PLUS_DESIGNS, wraps.mjs
//                      PLUS_WRAPS, looks.mjs LOOKS) → handheld/stickers.png + stickers-cut.png + stickers.json (the atlas,
//                      pre-built), handheld/wraps.json and handheld/looks.json (Gold, Clear shell, Holo label, the Rare
//                      start, the holo / glitter finishes – web/lib/handheld/looks.mjs) in the pack, and a picture of
//                      every souldew+ sticker and wrap in the previews (a tilted, glossy product shot – never the art 1:1),
//                      and the launch looks' still + loop (launch/<name>.png|webp, drawn by the real launch scene in
//                      Electron: scripts/handheld/launch-shots.mjs – the souldew+ page's launch cards)
//
// --catalog rewrites web/lib/cosmetics/content/{catalog,banners-free,frames-free}.mjs: the PUBLIC part (names,
// collections, rarities, swatches, pairings – what a locked card shows) and the free banners and frames.
// Never write a pack inside the repository: premium content is never committed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, rmdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildManifest, sealFile, makeSigner, b64encode, b64decode, b64url } from '../web/lib/cosmetics/pack/format.mjs';
import { renderItemPreviews, renderSkinPreviews, renderLaunchPreviews } from './plus-previews.mjs';
import { buildAtlas, stickerPicture } from '../web/lib/handheld/atlas.mjs';
import { STICKERS as HH_STICKERS, WRAPS as HH_WRAPS } from '../shared/handheld.mjs';
import { atlasFiles, encodePng } from './handheld/png.mjs';
import { cleanLooks } from '../web/lib/handheld/looks.mjs';
import { productShot } from './handheld/preview-shot.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DESIGN = resolve(opt('design', join(ROOT, '..', 'design-plus', 'design', 'plus')));
const OUT = opt('out') ? resolve(opt('out')) : null;
const SOURCE = opt('source') ? resolve(opt('source')) : null;
const PREVIEW_SOURCE = opt('preview-source') ? resolve(opt('preview-source')) : null;
const PREVIEWS_SOURCE = opt('previews-source') ? resolve(opt('previews-source')) : null;
const CATALOG = args.includes('--catalog');
const DAYS = Number(opt('days', 30));
const HANDHELD = resolve(opt('handheld', join(DESIGN, 'handheld')));
if (!existsSync(join(DESIGN, 'themes', 'skins.json'))) {
  console.error(`no design sources at ${DESIGN} (expected themes/, banners/, frames/) – pass --design`);
  process.exit(2);
}
if (!OUT && !CATALOG && !SOURCE && !PREVIEW_SOURCE && !PREVIEWS_SOURCE) {
  console.error('usage: node scripts/plus-dev-pack.mjs --design <dir> [--source <dir>] [--preview-source <dir>] [--previews-source <dir>] [--out <dir>] [--catalog] [--days 30] [--version 1.0.0]');
  process.exit(2);
}
for (const d of [OUT, SOURCE, PREVIEW_SOURCE, PREVIEWS_SOURCE]) {
  if (d && (d + '/').startsWith(ROOT + '/')) {
    console.error('--out / --source / --preview-source must be outside the repository (premium content is never committed)');
    process.exit(2);
  }
}
const enc = new TextEncoder();
const imp = (p) => import(pathToFileURL(join(DESIGN, p)).href);

// ------------------------------------------------------------------ sources
// souldew+ themes are COLOUR skins only (the owner's decision for 3.0): the rich "editions" of the design sources
// (kind "rich": Fieldbook, Clearshell, Woodgrain & Brass, Enamel) are not part of the app, the catalog or any pack.
const SKINS_ALL = JSON.parse(readFileSync(join(DESIGN, 'themes', 'skins.json'), 'utf8'));
const SKINS = SKINS_ALL.filter((s) => s.kind === 'classic' || s.kind === 'colour');
const DROPPED_SKINS = new Set(SKINS_ALL.filter((s) => !SKINS.includes(s)).map((s) => s.id));
/** pairings keep only the skins that exist */
const livePairs = (list) => [].concat(list || []).filter((id) => !DROPPED_SKINS.has(id));
const B = await imp('banners/recipes/index.mjs');
const F = await imp('frames/recipes/index.mjs');
// The 2D launch animations of the design sources (launch/) are no longer part of souldew (3.0: the launch is your
// handheld in 3D, web/lib/handheld) – not in the catalog, the pack or the previews.
// the Theme Matches banners of the dropped editions stay, as ordinary banners in the collection closest to their art
const BANNER_REHOME = {
  'field-notes': 'wild', 'pressed-flowers': 'seasons', 'cyanotype-plate': 'fields', 'trace-current': 'console',
  'amber-readout': 'console', 'walnut-and-brass': 'console', 'enamel-pins': 'wild',
};

/** a few colours of a palette for the locked card's swatch strip (no art – just the mood) */
const swatch = (pal, n = 6) => {
  const vals = Object.values(pal || {}).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  if (vals.length <= n) return vals;
  return Array.from({ length: n }, (_, i) => vals[Math.round((i * (vals.length - 1)) / (n - 1))]);
};

function assertData(v, where) {
  if (typeof v === 'function') throw new Error(`${where}: a function in data`);
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${where}: not a finite number`);
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertData(x, `${where}.${k}`);
}

for (const b of B.BANNERS) {
  if (b.pairsWith) b.pairsWith = livePairs(b.pairsWith);
  if (BANNER_REHOME[b.id] && b.set === 'themes' && !b.pairsWith?.length) b.set = BANNER_REHOME[b.id];
  if (b.set === 'themes' && !b.pairsWith?.length) throw new Error(`banner ${b.id}: a Theme Match without a skin – give it a collection in BANNER_REHOME`);
}
for (const f of F.FRAMES) if (f.pairsWith) f.pairsWith = livePairs(f.pairsWith);
const bannerByName = new Map(B.BANNERS.map((b) => [b.name, b.id]));
const freeBanners = B.BANNERS.filter((b) => b.set === 'basics');
const plusBanners = B.BANNERS.filter((b) => b.set !== 'basics');
const freeFrames = F.FRAMES.filter((f) => f.set === 'basics');
const plusFrames = F.FRAMES.filter((f) => f.set !== 'basics');

// ------------------------------------------------------------------ "Your handheld": the souldew+ stickers and wraps
// The catalog (names, tiers) is public (shared/handheld.mjs); the art is here. The atlas is built now, once – the app
// never builds it at run time.
const HH = existsSync(join(HANDHELD, 'stickers.mjs')) ? {
  stickers: (await import(pathToFileURL(join(HANDHELD, 'stickers.mjs')).href)).PLUS_DESIGNS,
  wraps: (await import(pathToFileURL(join(HANDHELD, 'wraps.mjs')).href)).PLUS_WRAPS,
  looks: existsSync(join(HANDHELD, 'looks.mjs')) ? (await import(pathToFileURL(join(HANDHELD, 'looks.mjs')).href)).LOOKS : null,
} : null;
if (HH) {
  // the design sources and this checkout must name the same souldew+ stickers and wraps – else they are from different
  // rounds (exit 3: test/skin-proof.test.mjs skips on that, naming the difference)
  const want = (list) => list.filter((x) => x.tier === 'plus').map((x) => x.id).sort();
  const mismatch = (what, have, need) => {
    const extra = have.filter((id) => !need.includes(id));
    const missing = need.filter((id) => !have.includes(id));
    console.error(`catalog mismatch: ${what} ≠ shared/handheld.mjs – only in the design: ${extra.join(', ') || '–'}; only in the app: ${missing.join(', ') || '–'}`);
    process.exit(3);
  };
  const ids = (list) => list.map((x) => x.id).sort();
  if (ids(HH.stickers).join(',') !== want(HH_STICKERS).join(',')) mismatch('handheld/stickers.mjs PLUS_DESIGNS (souldew+ stickers)', ids(HH.stickers), want(HH_STICKERS));
  if (ids(HH.wraps).join(',') !== want(HH_WRAPS).join(',')) mismatch('handheld/wraps.mjs PLUS_WRAPS (souldew+ wraps)', ids(HH.wraps), want(HH_WRAPS));
  for (const w of HH.wraps) {
    assertData(w, `wrap ${w.id}`);
    if (!B.BANNERS.some((b) => b.id === w.banner && b.set !== 'basics')) throw new Error(`wrap ${w.id}: its banner ${w.banner} is not a souldew+ banner`);
  }
  if (HH.looks) {
    // the app takes a look only whole: refuse a source the app would drop (looks.mjs cleanLooks)
    const ok = cleanLooks(JSON.parse(JSON.stringify(HH.looks)));
    for (const k of ['gold', 'clear', 'holo', 'rare']) if (HH.looks[k] && !ok?.[k]) throw new Error(`handheld/looks.mjs: ${k} does not pass the app's check`);
    for (const k of ['holo', 'glitter']) if (HH.looks.finishes?.[k] && !ok?.finishes?.[k]) throw new Error(`handheld/looks.mjs: the ${k} finish does not pass the app's check`);
  } else console.warn(`no handheld/looks.mjs at ${HANDHELD} – the pack goes without Gold, Clear shell, Holo label, the Rare start and the holo / glitter finishes`);
  HH.atlas = buildAtlas(HH.stickers);
  HH.files = await atlasFiles(HH.atlas);
} else console.warn(`no handheld sources at ${HANDHELD} – the pack goes without the souldew+ stickers and wraps`);

// ------------------------------------------------------------------ bundling code recipes into one module
// Frames are code (per-pixel functions). Each becomes ONE module whose imports point at the app's
// public engine ('@cosmetics/…' – rewritten to absolute same-origin URLs by web/lib/cosmetics/sandbox.mjs), run in a
// worker. Collection files are wrapped in their own function scope so their top-level names can't collide.
function bundle(files, specMap, exportName, filterExpr) {
  const imports = new Map(); // module → Set(names)
  const parts = [];
  files.forEach((file, i) => {
    let src = readFileSync(file, 'utf8');
    src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?\s*$/gm, (_, names, from) => {
      const target = specMap[from];
      if (!target) throw new Error(`${basename(file)}: unexpected import ${from}`);
      const set = imports.get(target) || new Set();
      for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) set.add(n);
      imports.set(target, set);
      return '';
    });
    if (/^\s*import\s/m.test(src)) throw new Error(`${basename(file)}: an import the bundler can't map`);
    if ((src.match(/^export default /gm) || []).length !== 1) throw new Error(`${basename(file)}: needs exactly one default export`);
    if (/^export (?!default)/m.test(src)) throw new Error(`${basename(file)}: named exports are not bundled`);
    parts.push(`// ${basename(file)}\nconst __m${i} = (() => {\n${src.replace(/^export default /m, 'return ')}\n})();`);
  });
  const head = [...imports].map(([from, names]) => `import { ${[...names].sort().join(', ')} } from '${from}';`).join('\n');
  const list = files.map((_, i) => `...(Array.isArray(__m${i}) ? __m${i} : [__m${i}])`).join(', ');
  return `// souldew+ pack module (generated by scripts/plus-dev-pack.mjs – do not edit)\n${head}\n\n${parts.join('\n\n')}\n\nexport const ${exportName} = [${list}].filter(${filterExpr});\n`;
}

const FRAME_FILES = readdirSync(join(DESIGN, 'frames', 'recipes')).filter((f) => f.endsWith('.mjs') && !['index.mjs', '_lib.mjs', 'basics.mjs'].includes(f)).sort();
// the recipes' own pairsWith lists (plain literals) lose the dropped editions too – the pack names no skin it lacks
const framesModule = bundle(FRAME_FILES.map((f) => join(DESIGN, 'frames', 'recipes', f)),
  { './_lib.mjs': '@cosmetics/frames/recipe-lib.mjs', '../engine/core.mjs': '@cosmetics/frames/engine/core.mjs' }, 'RECIPES', '(r) => !r.reject')
  .replace(/pairsWith:\s*\[([^\]]*)\]/g, (m, list) => `pairsWith: [${list.split(',').map((x) => x.trim()).filter((x) => x && !DROPPED_SKINS.has(x.replace(/^['"]|['"]$/g, ''))).join(', ')}]`);
if ([...DROPPED_SKINS].some((id) => new RegExp(`pairsWith:[^\\]]*'${id}'`).test(framesModule))) throw new Error('frames.mjs still pairs a dropped skin');

// ------------------------------------------------------------------ skins: CSS with its fonts and art as pack files
function skinFiles() {
  const out = [];
  const extra = new Map();
  for (const s of SKINS.filter((k) => k.kind !== 'classic')) {
    let css = readFileSync(join(DESIGN, 'themes', `${s.id}.css`), 'utf8');
    css = css.replace(/url\((['"]?)(\.\.\/fonts\/|assets\/)([A-Za-z0-9._-]+)\1\)/g, (_, q, dir, name) => {
      const path = `${dir.startsWith('..') ? 'fonts' : 'assets'}/${name.toLowerCase()}`;
      extra.set(path, join(DESIGN, dir.startsWith('..') ? 'fonts' : 'themes/assets', name));
      return `url('pack:${path}')`;
    });
    const foreign = [...css.matchAll(/url\(\s*(['"]?)([^'")]*)/g)].map((m) => m[2]).filter((u) => !/^(data:|pack:|#|%23)/.test(u));
    if (foreign.length) throw new Error(`${s.id}.css: assets the builder doesn't package: ${foreign.join(', ')}`);
    out.push({ path: `skins/${s.id}.css`, bytes: enc.encode(css) });
  }
  for (const [path, file] of extra) out.push({ path, bytes: new Uint8Array(readFileSync(file)) });
  return out;
}

// ------------------------------------------------------------------ the public catalog
const collName = (list, id) => list.find((c) => c.id === id)?.name || id;
function catalogData() {
  const skins = SKINS.map((s) => ({
    id: s.id, name: s.name, hint: s.hint, plus: s.kind !== 'classic',
    group: s.tone === 'light' ? 'light' : 'dark', tone: s.tone, sw: s.sw,
  }));
  const bannerPairs = (b) => (b.pairsWith ? [].concat(b.pairsWith) : []);
  const banners = B.BANNERS.map((b) => ({
    id: b.id, name: b.name, collection: b.set, rarity: b.rarity, plus: b.set !== 'basics', pairsWith: bannerPairs(b),
    drop: b.drop || null, sw: swatch(b.pal),
  }));
  const frames = F.FRAMES.map((f) => ({
    id: f.id, name: f.name, collection: f.set, rarity: f.rarity, plus: f.set !== 'basics', pairsWith: f.pairsWith || [],
    pair: f.pair ? bannerByName.get(f.pair) || null : null, sw: swatch(f.pal),
  }));
  const collections = {
    banners: B.COLLECTIONS.map((c) => ({ id: c.id, name: c.name.replace(/ \(free\)$/, '') })),
    frames: F.COLLECTIONS.map((c) => ({ id: c.id, name: c.name.replace(/ \(free\)$/, '') })),
  };
  for (const b of banners) b.collectionName = collName(collections.banners, b.collection);
  for (const f of frames) f.collectionName = collName(collections.frames, f.collection);
  return { skins, banners, frames, collections };
}

if (CATALOG) {
  const dir = join(ROOT, 'web', 'lib', 'cosmetics', 'content');
  mkdirSync(dir, { recursive: true });
  const head = (what) => `// ${what} – generated by scripts/plus-dev-pack.mjs --catalog from the design sources. Do not edit by hand.\n`;
  const cat = catalogData();
  assertData(cat, 'catalog');
  writeFileSync(join(dir, 'catalog.mjs'), `${head('The PUBLIC souldew+ catalog: what every card shows, owned or not (no art, no recipes)')}export default ${JSON.stringify(cat)};\n`);
  for (const b of freeBanners) assertData(b, b.id);
  writeFileSync(join(dir, 'banners-free.mjs'), `${head('The free banners (Basics) – shipped with the app')}export default ${JSON.stringify(freeBanners, null, 1)};\n`);
  let ff = readFileSync(join(DESIGN, 'frames', 'recipes', 'basics.mjs'), 'utf8');
  for (const f of freeFrames) f.pairsWith = f.pairsWith || [];
  ff = `${head('The free avatar frames (Basics) – shipped with the app')}${ff}`;
  writeFileSync(join(dir, 'frames-free.mjs'), ff);
  console.log(`catalog: ${cat.skins.length} skins, ${cat.banners.length} banners, ${cat.frames.length} frames → web/lib/cosmetics/content/`);
}

// ------------------------------------------------------------------ the pack's files
function packFiles() {
  for (const b of plusBanners) assertData(b, b.id);
  const contents = {
    skins: SKINS.filter((k) => k.kind !== 'classic').map((s) => ({ id: s.id, css: `skins/${s.id}.css` })),
    banners: 'banners.json', frames: { module: 'frames.mjs', ids: plusFrames.map((f) => f.id) },
    ...(HH ? { handheld: { wraps: 'handheld/wraps.json', stickers: 'handheld/stickers.json', art: 'handheld/stickers.png', cut: 'handheld/stickers-cut.png', ...(HH.looks ? { looks: 'handheld/looks.json' } : {}) } } : {}),
  };
  const files = [
    { path: 'contents.json', bytes: enc.encode(JSON.stringify(contents)) },
    { path: 'banners.json', bytes: enc.encode(JSON.stringify(plusBanners)) },
    { path: 'frames.mjs', bytes: enc.encode(framesModule) },
    ...skinFiles(),
    ...(HH ? [
      { path: 'handheld/wraps.json', bytes: enc.encode(JSON.stringify(HH.wraps)) },
      { path: 'handheld/stickers.json', bytes: new Uint8Array(HH.files.layout) },
      { path: 'handheld/stickers.png', bytes: new Uint8Array(HH.files.art) },
      { path: 'handheld/stickers-cut.png', bytes: new Uint8Array(HH.files.cut) },
      ...(HH.looks ? [{ path: 'handheld/looks.json', bytes: enc.encode(JSON.stringify(HH.looks)) }] : []),
    ] : []),
  ];
  return { files, contents };
}

/** An SVG → PNG of at most `max` px per side, rendered by Electron's Chromium (the app's own dev dependency). */
function rasterize(svgFile, max) {
  const out = join(mkdtempSync(join(tmpdir(), 'souldew-raster-')), `${basename(svgFile)}.png`);
  const electron = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const r = spawnSync(electron, [join(ROOT, 'scripts', 'svg-raster.mjs'), svgFile, out, String(max)], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 60000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')) } });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`could not rasterize ${svgFile}`);
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(out, { force: true });
  rmdirSync(dirname(out));
  return bytes;
}

/**
 * The live theme preview pack: every skin's stylesheet. The colour skins are colour only – no fonts, no art – so today
 * the preview is stylesheets and nothing else. Should a skin reference a font or art again, the builder carries it
 * (fonts as the same WOFF2 files as the full pack, art as PNG of at most 512 px) within what the service checks when the
 * pack is registered: stylesheets, PNG/WebP ≤ 512 px and WOFF2 fonts (≤ 128 KiB each, ≤ 16 fonts, ≤ 512 KiB together)
 * only – no banners, frames or scripts.
 */
const PREVIEW_FONT_MAX = 128 * 1024;
const PREVIEW_FONTS_MAX = 16;
const PREVIEW_FONTS_TOTAL = 512 * 1024;
function previewFiles() {
  const files = [];
  const art = new Map();
  const fonts = new Map();
  const all = skinFiles();
  const bytesOf = new Map(all.map((f) => [f.path, f.bytes]));
  for (const f of all.filter((x) => x.path.startsWith('skins/'))) {
    let css = new TextDecoder().decode(f.bytes);
    for (const m of css.matchAll(/url\((['"]?)pack:(fonts\/[a-z0-9._-]+\.woff2)\1\)/g)) fonts.set(m[2], bytesOf.get(m[2]));
    css = css.replace(/url\((['"]?)pack:assets\/([a-z0-9._-]+)\.svg\1\)/g, (_, q, name) => {
      art.set(`assets/${name}.png`, join(DESIGN, 'themes', 'assets', `${name}.svg`));
      return `url('pack:assets/${name}.png')`;
    });
    if (/pack:(?!assets\/[a-z0-9._-]+\.png|fonts\/[a-z0-9._-]+\.woff2)/.test(css)) throw new Error(`${f.path}: the preview would reference a file it can't carry`);
    files.push({ path: f.path, bytes: enc.encode(css) });
  }
  let total = 0;
  for (const [path, bytes] of fonts) {
    const woff2 = bytes && bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'wOF2';
    if (!woff2) throw new Error(`${path}: not a WOFF2 font`);
    if (bytes.length > PREVIEW_FONT_MAX) throw new Error(`${path}: ${bytes.length} bytes – a preview font may have at most ${PREVIEW_FONT_MAX}`);
    total += bytes.length;
    files.push({ path, bytes });
  }
  if (fonts.size > PREVIEW_FONTS_MAX || total > PREVIEW_FONTS_TOTAL) throw new Error(`preview fonts: ${fonts.size} files, ${total} bytes – over the service's limits`);
  for (const [path, svg] of art) files.push({ path, bytes: rasterize(svg, 512) });
  // no contents.json: a preview pack holds stylesheets, fonts and images only – the page finds the skins by their paths
  return files;
}

/** Writes a pack source folder (refuses to overwrite a non-empty folder). */
function writeSource(dir, files) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  for (const f of files) {
    const target = join(dir, ...f.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
  }
  console.log(`${files.length} files → ${dir}`);
}

/**
 * The public preview media into `dir` (pictures only): every premium banner, nameplate and frame the
 * catalog shows (monthly drops only once they are out) and every colour skin. Nothing else may end up in it.
 */
async function previewsMedia(dir) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const files = [
    ...await renderItemPreviews({ design: DESIGN, banners: plusBanners.filter((b) => !b.drop), frames: plusFrames, out: dir }),
    ...renderSkinPreviews({ skins: skinFiles().filter((f) => f.path.startsWith('skins/')).map((f) => ({ id: basename(f.path, '.css'), css: new TextDecoder().decode(f.bytes) })), out: dir }),
    ...await handheldPreviews(dir),
    ...(HH?.looks ? renderLaunchPreviews({ looks: HH.looks, out: dir }) : []),
  ];
  for (const f of files) if (!/^(banners|nameplates|frames|skins|stickers|wraps|launch)\/[a-z0-9][a-z0-9-]*\.(png|webp)$/.test(f.path)) throw new Error(`not a preview picture: ${f.path}`);
  console.log(`${files.length} preview pictures → ${dir}`);
  return files;
}

/**
 * "Your handheld"'s preview pictures: every souldew+ sticker on its die-cut border and a window onto every souldew+ wrap
 * (the skin card's picture) – what a non-member's sheet shows. Pictures only, and never the art pixel for pixel: the
 * previews are public (anyone may fetch them, no account), and a sticker IS its pixel art – an exact ×6 copy would be the
 * sticker itself, ready for a patched client's atlas. So each is a product shot (scripts/handheld/preview-shot.mjs):
 * turned a few degrees, resampled smoothly, with a light sheen – the real look, not a copy of the file.
 */
async function handheldPreviews(dir) {
  if (!HH) return [];
  const { wrapArt } = await import('../web/lib/handheld/wrap.mjs');
  const out = [];
  const put = (path, w, h, rgba) => {
    const bytes = encodePng(w, h, rgba, 4);
    const target = join(dir, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    out.push({ path, bytes: new Uint8Array(bytes) });
  };
  for (const d of HH.stickers) {
    const p = productShot(stickerPicture(HH.atlas, d.id, 6), { angle: -6, seed: d.id });
    put(`stickers/${d.id}.png`, p.w, p.h, p.rgba);
  }
  for (const w of HH.wraps) {
    const recipe = B.BANNERS.find((b) => b.id === w.banner);
    const art = wrapArt(w, recipe, [{ key: 't', w: 112, h: 74, cx: w.cx + 20, base: 72, word: null }], { reduced: true });
    const r = art.rects.t, k = 2;
    const rgba = new Uint8ClampedArray(r.w * k * r.h * k * 4);
    const src = new Uint8ClampedArray(art.px.buffer);
    for (let y = 0; y < r.h * k; y++) for (let x = 0; x < r.w * k; x++) {
      const s = ((r.y + Math.floor(y / k)) * art.w + r.x + Math.floor(x / k)) * 4, o = (y * r.w * k + x) * 4;
      rgba[o] = src[s]; rgba[o + 1] = src[s + 1]; rgba[o + 2] = src[s + 2]; rgba[o + 3] = 255;
    }
    const shot = productShot({ w: r.w * k, h: r.h * k, rgba }, { angle: 4, seed: w.id, opaque: true });
    put(`wraps/${w.id}.png`, shot.w, shot.h, shot.rgba);
  }
  return out;
}

if (SOURCE) writeSource(SOURCE, packFiles().files);
if (PREVIEW_SOURCE) writeSource(PREVIEW_SOURCE, previewFiles());
if (PREVIEWS_SOURCE) await previewsMedia(PREVIEWS_SOURCE);

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  const version = opt('version', '0.0.1');
  const keyFile = join(OUT, 'dev-signing.key');
  const signer = await makeSigner(existsSync(keyFile) ? b64decode(readFileSync(keyFile, 'utf8').trim()) : null);
  if (!existsSync(keyFile)) writeFileSync(keyFile, b64encode(await signer.pkcs8()) + '\n', { mode: 0o600 });
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  /** signs the manifest, seals every file the way the service does for one account, writes the access answer */
  const seal = async ({ id, kind, title, files, dir, accessFile, kid, extra }) => {
    const { manifest, manifestBytes } = await buildManifest({ id, version, kind, title, files });
    const signature = await signer.sign(manifestBytes);
    let size = 0;
    for (const f of files) {
      const env = await sealFile({ pack: id, version, path: f.path, wm: 'wm_dev', kid, key, bytes: f.bytes });
      const target = join(OUT, `sealed-${dir}`, ...f.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, env);
      size += env.length;
    }
    const access = {
      packId: id, version, manifest: b64url(manifestBytes), signature: b64url(signature), keyId: kid, watermark: 'wm_dev', key: b64url(key),
      files: manifest.files.map((f) => ({ path: f.path, url: `souldew-dev:${dir}/${f.path}` })), publicKey: b64url(signer.publicKey), ...extra,
    };
    writeFileSync(join(OUT, accessFile), JSON.stringify(access, null, 2) + '\n', { mode: 0o600 });
    console.log(`${kind} pack ${id}@${version}: ${files.length} files, ${kb(size)} sealed → ${join(OUT, `sealed-${dir}`)}`);
  };
  const { files, contents } = packFiles();
  await seal({ id: 'souldew-plus', kind: 'mixed', title: 'souldew+ (dev)', files, dir: 'pack', accessFile: 'access.json', kid: '1',
    extra: { until: new Date(Date.now() + DAYS * 86400e3).toISOString() } });
  await seal({ id: 'skins-preview', kind: 'preview', title: 'Skin preview (dev)', files: previewFiles(), dir: 'preview', accessFile: 'access-preview.json',
    kid: `pv_${b64url(globalThis.crypto.getRandomValues(new Uint8Array(16))).slice(0, 22)}`, extra: { preview: true } });
  // the public preview media: plain files (anyone may have them), a manifest signed like every pack
  if (!args.includes('--no-previews')) {
    const pdir = join(OUT, 'previews');
    if (existsSync(pdir)) rmSync(pdir, { recursive: true, force: true });
    const media = await previewsMedia(pdir);
    const { manifestBytes } = await buildManifest({ id: 'souldew-previews', version, kind: 'previews', title: 'souldew+ previews (dev)', files: media });
    writeFileSync(join(OUT, 'access-previews.json'), JSON.stringify({ manifest: b64url(manifestBytes), signature: b64url(await signer.sign(manifestBytes)), publicKey: b64url(signer.publicKey) }, null, 2) + '\n');
  }
  console.log(`  skins ${contents.skins.length} · banners ${plusBanners.length} · frames ${plusFrames.length}${HH ? ` · handheld: ${HH.stickers.length} stickers, ${HH.wraps.length} wraps` : ''}`);
  console.log(`  start the server with SLS_PLUS_DEV_PACK=${OUT}`);
}
