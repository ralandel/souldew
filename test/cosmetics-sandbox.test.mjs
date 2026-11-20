// Security review #3 (exploit 2): souldew+ pack code runs in a module worker inside a sandboxed iframe with an opaque
// origin and connect-src 'none' (web/lib/cosmetics/sandbox.mjs) – it can't read the account (export, entitlements),
// can't write the app's config, can't reach the sync relays or the internet. The frames host still works in there.
// Real Chromium (Electron, hidden window, muted); skipped on Linux without a display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

test('pack code in the sandboxed iframe: no account, no config, no network – and the frames host still answers', { skip: noDisplay ? 'no display' : false, timeout: 120000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'souldew-sandbox-'));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'Proof', bootAnimation: false, nagOff: true }));
  const out = join(data, 'result.json');
  const electron = (await import('electron')).default;
  const env = { ...process.env, SLS_DATA_DIR: data, ELECTRON_ENABLE_LOGGING: '' };
  delete env.SLS_ACCOUNTS_URL;
  const r = spawnSync(electron, [join(ROOT, 'test', 'fixtures', 'sandbox-runner.mjs'), out], { env, encoding: 'utf8', timeout: 110000 });
  assert.ok(existsSync(out), `no result (exit ${r.status}): ${String(r.stderr).slice(-1500)}`);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.pageAccount, 200, 'the app window itself has the secret');
  const sb = res.sandbox;
  assert.ok(!sb.timeout && !sb.error, JSON.stringify(sb));
  assert.equal(sb.probe.origin, 'null', 'an opaque origin');
  for (const k of ['exportData', 'entitlements', 'status', 'configWrite', 'outside', 'relay']) assert.equal(sb.probe[k], 'blocked', k);
  assert.ok(sb.readyIds > 0, 'the free frames are compiled in the sandbox');
  assert.ok(sb.drawn.w > 0 && sb.drawn.pixels > 50, `a frame was drawn into the page's canvas: ${JSON.stringify(sb.drawn)}`);
  assert.equal(sb.iframe.sandbox, 'allow-scripts');
  assert.ok(sb.iframeGone, 'terminate removes the iframe');
  assert.equal(res.playerName, 'Proof', 'the config was not written');
  assert.match(res.sandboxCsp, /connect-src 'none'/);
  assert.match(res.sandboxCsp, /default-src 'none'/);
});
