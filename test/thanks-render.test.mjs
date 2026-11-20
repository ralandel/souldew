// The Thank you page rendered in the real app (test/fixtures/thanks-runner.mjs: Electron, hidden, muted, a scratch data
// folder, the fake accounts service): the one-time ask for a new supporter (and never again), only opted-in people by
// name, "and N more", the live moment for someone new, and "Offline – as of …". With a souldew+ dev pack
// (SLS_PLUS_DEV_PACK) also two light and two dark skins and a bigger interface size; THANKS_SHOTS=<folder> keeps PNGs.
// Without a display on Linux: skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

test('Thank you page: ask once, opted-in names only, the live moment, offline "as of"', { skip: noDisplay ? 'no display' : false, timeout: 300000 }, async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'souldew-thanks-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'Robin', bootAnimation: false, nagOff: true, whatsNew: null }));
  const out = join(data, 'result.json');
  const electron = (await import('electron')).default;
  const r = spawnSync(electron, [join(ROOT, 'test', 'fixtures', 'thanks-runner.mjs'), out], {
    env: { ...process.env, SLS_DATA_DIR: data, ELECTRON_ENABLE_LOGGING: '' }, encoding: 'utf8', timeout: 280000,
  });
  assert.ok(existsSync(out), `the runner wrote no result (exit ${r.status}): ${String(r.stderr).slice(-2000)}`);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(res.error, undefined, res.error);
  const s = res.steps;

  // asked once, with a preview and two equal answers
  assert.equal(s.ask.title, 'Thank you for supporting souldew! 💧');
  assert.match(s.ask.preview, /Robin/);
  assert.deepEqual(s.ask.buttons, ['Yes, show me', 'No thanks']);
  assert.equal(s.answered, true, '"Yes" reached the service');
  assert.equal(s.askedAgain, false, 'never asked again');

  // only who said yes, by tier; everyone counted
  const names = s.page.names;
  for (const n of ['Lena', 'Marisol', 'Mo', 'Jun', 'Aria', 'Kai', 'Ida', 'Tomás', 'Robin', 'Pip', 'Sam', 'Oskar', 'Wren']) assert.ok(names.includes(n), n);
  for (const n of ['Quiet Legend', 'Said No']) assert.ok(!names.includes(n) && !s.page.text.includes(n), `${n} must not appear`);
  assert.deepEqual(s.page.tiers.map((x) => x[0]), ['legend', 'plus', 'supporter', 'coffee']);
  assert.deepEqual(s.page.tiers.map((x) => x[1]), ['4', '8', '22', '12']);
  assert.match(s.page.tiers[0][2], /and 2 more who support quietly/);
  assert.equal(s.page.total, '46');
  assert.match(s.page.live, /Live/);
  assert.equal(s.page.overflow, false, 'no sideways scrolling');
  assert.ok(names.indexOf('Lena') < names.indexOf('Marisol'), 'longest support first within a tier');

  // someone new while the page is open
  assert.equal(s.moment, 'New: Fen joined the Legends 🏆');
  assert.deepEqual(s.fresh, ['Fen']);
  // offline: the last wall stays
  assert.match(s.offline.live, /Offline – as of/);
  assert.ok(s.offline.names.includes('Fen'));
  if (s.skins) {
    assert.equal(s.skins.length, 4, 'two light and two dark skins');
    assert.equal(s.zoomOverflow, false, 'a bigger interface size: no sideways scrolling');
  }
  if (res.shots.length) t.diagnostic(`screenshots: ${res.shots.join(', ')}`);
});
