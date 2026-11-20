// Pre-builds the app's sticker atlas for "Your handheld" (the free and the earned stickers) into web/assets/handheld/:
//   stickers.png      the art with its ink outline (RGBA, one pixel per art pixel)
//   stickers-cut.png  the die-cut border as a distance field (grey, 4 texels per art pixel)
//   stickers.json     the layout: each sticker's place and die-cut mask
// Commit the result. The souldew+ stickers are built the same way into the pack (scripts/plus-dev-pack.mjs --handheld).
//   node scripts/build-handheld-atlas.mjs [--check]     --check: fail when the committed files are out of date
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAtlas } from '../web/lib/handheld/atlas.mjs';
import { STICKERS } from '../shared/handheld.mjs';
import { DESIGNS } from './handheld/stickers-app.mjs';
import { atlasFiles } from './handheld/png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'assets', 'handheld');
const want = STICKERS.filter((s) => s.tier !== 'plus').map((s) => s.id).sort();
const have = DESIGNS.map((d) => d.id).sort();
if (JSON.stringify(want) !== JSON.stringify(have)) throw new Error(`the app's sticker art doesn't match the catalog: ${have.join(',')} ≠ ${want.join(',')}`);

const t0 = performance.now();
const files = await atlasFiles(buildAtlas(DESIGNS));
const names = { art: 'stickers.png', cut: 'stickers-cut.png', layout: 'stickers.json' };
if (process.argv.includes('--check')) {
  const stale = Object.entries(names).filter(([k, n]) => !existsSync(join(OUT, n)) || !readFileSync(join(OUT, n)).equals(files[k]));
  if (stale.length) {
    console.error(`out of date: ${stale.map(([, n]) => n).join(', ')} – run node scripts/build-handheld-atlas.mjs`);
    process.exit(1);
  }
  console.log('sticker atlas up to date');
} else {
  mkdirSync(OUT, { recursive: true });
  for (const [k, n] of Object.entries(names)) writeFileSync(join(OUT, n), files[k]);
  console.log(`${DESIGNS.length} stickers → web/assets/handheld/ (${Object.entries(names).map(([k, n]) => `${n} ${(files[k].length / 1024).toFixed(1)} KB`).join(', ')}) in ${Math.round(performance.now() - t0)} ms`);
}
