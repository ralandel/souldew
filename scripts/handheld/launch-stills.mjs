// The souldew+ launch looks' stills that ship with the app (web/assets/handheld/launch/<name>.webp, 480×300, ≈ 8 KB each):
// what the souldew+ page's launch cards show to someone without the pack until the previews (the accounts service's
// launch/<name>.png|webp – a still and a loop) carry them. Pictures only, the same public pictures as the previews.
// Made from the previews folder plus-dev-pack.mjs writes (--previews-source <dir>, or <out>/previews):
//   node scripts/handheld/launch-stills.mjs <previews dir>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** the looks this computer can't draw without the pack ("Your colours" is drawn live) */
export const SHIPPED_STILLS = ['gold', 'holo', 'clear-shell-atomic', 'clear-shell-smoke', 'clear-shell-ice', 'clear-shell-jungle'];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) throw new Error('usage: node scripts/handheld/launch-stills.mjs <previews dir>');
  const out = join(ROOT, 'web', 'assets', 'handheld', 'launch');
  mkdirSync(out, { recursive: true });
  for (const n of SHIPPED_STILLS) {
    const png = join(src, 'launch', `${n}.png`);
    if (!existsSync(png)) throw new Error(`no ${png} – run plus-dev-pack.mjs with the handheld looks first`);
    const r = spawnSync('cwebp', ['-quiet', '-q', '80', '-m', '6', '-alpha_q', '90', '-resize', '480', '300', png, '-o', join(out, `${n}.webp`)]);
    if (r.error || r.status !== 0) throw new Error(`cwebp failed for ${n} (brew install webp)`);
  }
  console.log(`${SHIPPED_STILLS.length} launch stills → ${out}`);
}
