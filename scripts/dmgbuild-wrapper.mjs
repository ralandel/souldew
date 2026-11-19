#!/usr/bin/env node
// electron-builder's dmgbuild, with one addition: the DMG's hidden files (background, volume icon, Finder
// settings) get positions below the visible window. Finder shows them when "show hidden files" is on (⌘⇧.),
// and without a position they land on top of the artwork. electron-builder's config only allows file/link
// entries, so `npm run dist` points CUSTOM_DMGBUILD_PATH here and this adds dmgbuild's "position" entries.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HIDDEN = [
  { x: 120, y: 760, type: 'position', path: '.background.tiff' },
  { x: 300, y: 760, type: 'position', path: '.VolumeIcon.icns' },
  { x: 480, y: 760, type: 'position', path: '.DS_Store' },
];

const args = process.argv.slice(2);
const at = args.indexOf('-s');
if (at >= 0 && args[at + 1]) {
  const file = args[at + 1];
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const names = new Set((settings.contents || []).map((c) => c.path));
  settings.contents = [...(settings.contents || []), ...HIDDEN.filter((h) => !names.has(h.path))];
  writeFileSync(file, JSON.stringify(settings, null, 2));
}

// the real dmgbuild that electron-builder downloaded into its cache
const cache = join(homedir(), 'Library', 'Caches', 'electron-builder');
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
let real = null;
for (const tool of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('dmg-builder@')).sort().reverse() : []) {
  for (const dir of readdirSync(join(cache, tool))) {
    const bin = join(cache, tool, dir, 'dmgbuild');
    if (dir.startsWith(`dmgbuild-bundle-${arch}`) && !dir.endsWith('.tar.gz') && existsSync(bin)) real = real || bin;
  }
}
// Not there (a fresh machine, e.g. the release workflow's macOS runner): download it the way electron-builder does,
// with the release, file and SHA-256 it names itself – read from its own source, so they follow its upgrades.
if (!real) real = await downloadDmgbuild().catch((e) => (console.error('dmgbuild download failed:', e.message), null));
if (!real) {
  console.error('dmgbuild not found in the electron-builder cache – run `npx electron-builder --mac dmg --arm64` once without CUSTOM_DMGBUILD_PATH so it downloads it');
  process.exit(1);
}

/** electron-builder's dmgbuild bundle for this arch, downloaded (checksum-verified) into its cache → the binary, or null. */
async function downloadDmgbuild() {
  const dmgUtil = createRequire(import.meta.url).resolve('dmg-builder/out/dmgUtil.js');
  const src = readFileSync(dmgUtil, 'utf8');
  const releaseName = /releaseName:\s*"(dmg-builder@[^"]+)"/.exec(src)?.[1];
  const checksums = Object.fromEntries([...src.matchAll(/"(dmgbuild-bundle-[\w.-]+\.tar\.gz)":\s*"([0-9a-f]{64})"/g)].map((m) => [m[1], m[2]]));
  const file = Object.keys(checksums).find((f) => f.startsWith(`dmgbuild-bundle-${arch}-`));
  if (!releaseName || !file) throw new Error('electron-builder no longer names its dmgbuild bundle the expected way');
  const { downloadBuilderToolset } = createRequire(dmgUtil)('app-builder-lib/out/util/electronGet');
  const dir = await downloadBuilderToolset({ releaseName, filenameWithExt: file, checksums });
  const bin = join(dir, 'dmgbuild');
  return existsSync(bin) ? bin : null;
}
const r = spawnSync(real, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
