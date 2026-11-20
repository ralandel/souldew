// "A skin changes the look only" – proven on the REAL app: every main view rendered in Electron with classic and with
// every souldew+ skin of a pack, comparing every element's box, the visible text and the generated text
// (test/fixtures/skin-proof-runner.mjs). The automated form of the design's proof.py. Signed in (a fake accounts
// service) the same for Friends, the profile and the sidebar's account chip – plus their text contrast in every skin and
// the profile's banner (only the avatar overlaps it, 1024–1440 px) – and for the live theme PREVIEW pack, whose skins
// must lay out exactly like the full ones. Light skins: no field, popover, menu, hint, toast or dialog on a dark ground.
//
// Skins are premium content and not in this repository, so the test needs a pack: SLS_PLUS_PROOF_PACK=<dev pack folder>
// (scripts/plus-dev-pack.mjs), or the design sources next to the checkout (../design-plus/design/plus), from which it
// builds one – from their last COMMIT (git archive), never the working files another worktree is in the middle of
// editing. When those sources name other souldew+ stickers or wraps than this checkout (shared/handheld.mjs: the two
// are from different rounds), it is skipped and says which. Without a pack – or without a display on Linux – skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = join(ROOT, '..', 'design-plus', 'design', 'plus');
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const havePack = !!process.env.SLS_PLUS_PROOF_PACK || existsSync(join(DESIGN, 'themes', 'skins.json'));
const skip = noDisplay ? 'no display' : !havePack ? 'no souldew+ pack (set SLS_PLUS_PROOF_PACK)' : false;

const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

/**
 * The design sources as last committed: `dir` exported (git archive) into `into`. Uncommitted edits there are left out.
 * Not a git checkout: the folder as it is.
 */
function committedDesign(dir, into) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (top.status !== 0) return { design: dir, rev: null };
  const prefix = git(dir, 'rev-parse', '--show-prefix').stdout.trim().replace(/\/$/, '');
  const rev = git(dir, 'rev-parse', '--short', 'HEAD').stdout.trim();
  const tar = join(into, 'design.tar');
  const a = git(top.stdout.trim(), 'archive', '--format=tar', '-o', tar, 'HEAD', '--', prefix || '.');
  assert.equal(a.status, 0, `git archive of the design sources: ${a.stderr}`);
  const x = spawnSync('tar', ['-xf', tar, '-C', into], { encoding: 'utf8' });
  assert.equal(x.status, 0, `unpacking the design sources: ${x.stderr}`);
  const dirty = git(dir, 'status', '--porcelain', '--', '.').stdout.trim();
  return { design: join(into, prefix), rev, dirty: !!dirty };
}

test('skins never change a box or a text on the real app views', { skip, timeout: 1500000 }, async (t) => {
  let pack = process.env.SLS_PLUS_PROOF_PACK;
  const temp = [];
  t.after(() => { for (const d of temp) rmSync(d, { recursive: true, force: true }); });
  if (!pack) {
    const src = mkdtempSync(join(tmpdir(), 'souldew-proof-design-'));
    pack = mkdtempSync(join(tmpdir(), 'souldew-proof-pack-'));
    temp.push(src, pack);
    const { design, rev, dirty } = committedDesign(DESIGN, src);
    if (dirty) t.diagnostic(`design sources: commit ${rev} – their uncommitted edits are left out`);
    const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'plus-dev-pack.mjs'), '--design', design, '--out', pack, '--no-previews'], { encoding: 'utf8' });
    if (b.status === 3) {
      t.skip(`the design sources${rev ? ` (commit ${rev})` : ''} don't match this checkout – ${b.stderr.trim()}; set SLS_PLUS_PROOF_PACK to a matching pack`);
      return;
    }
    assert.equal(b.status, 0, b.stderr);
  }
  const data = mkdtempSync(join(tmpdir(), 'souldew-proof-data-'));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'Proof', bootAnimation: false, nagOff: true }));
  const out = join(data, 'proof.json');
  const electron = (await import('electron')).default;
  const r = spawnSync(electron, [join(ROOT, 'test', 'fixtures', 'skin-proof-runner.mjs'), out], {
    env: { ...process.env, SLS_DATA_DIR: data, SLS_PLUS_DEV_PACK: pack, ELECTRON_ENABLE_LOGGING: '' }, encoding: 'utf8', timeout: 1440000,
  });
  assert.ok(existsSync(out), `the runner wrote no result (exit ${r.status}): ${String(r.stderr).slice(-2000)}`);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  // the data folder (with proof.json) stays only when something failed – it is the evidence
  if (res.ok) temp.push(data);
  else t.diagnostic(`the proof's result: ${out}`);
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.skins, 16, `${res.skins} skins in the pack – the colour skins, no editions`);
  assert.equal(res.previewSkins, res.skins, 'the preview pack carries every skin');
  // colour skins are colour only: no fonts travel with the preview (or the full pack)
  assert.deepEqual(res.previewFonts, [], `preview fonts: ${res.previewFonts}`);
  // 12 views signed out (with the souldew+ page), Friends + profile + library + souldew+ + Thank you signed in, a
  // friend's card, 14 views with the preview pack
  assert.equal(res.views, 32);
  assert.deepEqual(res.diffs, [], `${res.diffs.length} differences: ${JSON.stringify(res.diffs.slice(0, 5))}`);
  assert.ok(res.boxes > 10000, `${res.boxes} element boxes compared`);
  // no skin brings a display face any more, so no text may be set narrower anywhere
  assert.deepEqual(res.glyphRuns, []);
  // readable: the account chip, Friends and the profile in classic and every skin
  assert.ok(res.contrast.checked > 1000, `${res.contrast.checked} texts checked`);
  assert.deepEqual(res.contrast.fails, [], `${res.contrast.fails.length} texts below 4.5:1 (3:1 large): ${JSON.stringify(res.contrast.fails.slice(0, 8))}`);
  // the profile header (design A): the banner is overlapped by the avatar only, at every width and in every skin
  assert.equal(res.banner.length, 3 * (res.skins + 1));
  for (const b of res.banner) {
    assert.equal(b.error, undefined, `${b.width} ${b.skin}: ${b.error}`);
    assert.deepEqual(b.hits, [], `${b.width} px, ${b.skin}: over the banner – ${b.hits.join(', ')}`);
    assert.ok(b.avatarOverhang > 0, `${b.width} px, ${b.skin}: the avatar overhangs the banner`);
  }
  // light skins: no field, popover, menu, hint, toast or dialog on a dark ground (every view, the profile editor)
  assert.equal(res.surfaces.lightSkins, 5, 'Soft Light, Sunbleached, Glacier, Sakura, Cartridge Grey');
  assert.ok(res.surfaces.checked > 200, `${res.surfaces.checked} surfaces checked`);
  assert.deepEqual(res.surfaces.dark, [], `${res.surfaces.dark.length} dark surfaces in light skins: ${JSON.stringify(res.surfaces.dark.slice(0, 8))}`);
  const mins = Object.values(res.contrast.min).filter((x) => x != null);
  console.log(`skin proof: ${res.skins} skins × ${res.views} views (${res.previewSkins} as preview), ${res.boxes} element boxes, 0 differences, ${res.glyphRuns.length} title glyph runs; `
    + `${res.contrast.checked} texts ≥ 4.5:1 (lowest ${Math.min(...mins).toFixed(2)}); banner clear at 1024/1280/1440`);
});
