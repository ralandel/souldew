// The first start of 3.0 on a 2.x data folder (server/lib/upgrade.mjs): the version noted, the "What's new" cards for
// a player who knows the app, a backup of the player's data – not the ROMs or caches – before anything is migrated,
// once, only with enough free space, and its place in Settings › About.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'sls-upgrade-'));
process.env.SLS_DATA_DIR = join(TMP, 'server');
const U = await import('../server/lib/upgrade.mjs');

const MB = 1048576;
/** A data folder as 2.8.3 leaves it: settings, a run with its built game and save, states, the browser's storage, caches. */
function data283(dir, config = { onboarded: true, playerName: 'Sam', lang: 'de', theme: 'deutan', ctrRenderer: 'compat' }) {
  const put = (rel, body, mode) => {
    mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...rel.split('/')), body, mode ? { mode } : undefined);
  };
  if (config) put('config.json', JSON.stringify(config));
  put('trophies.json', '{"schema":1}');
  put('live-runs.json', '{"token":"x"}', 0o600);
  put('runs/abcd1234/run.json', '{"id":"abcd1234"}');
  put('runs/abcd1234/doc.json', '{}');
  put('runs/abcd1234/host-key.pem', 'KEY', 0o600);
  put('runs/abcd1234/Sam - Red Version.gb', Buffer.alloc(1 * MB));
  put('runs/abcd1234/Sam - Red Version.sav', Buffer.alloc(32768, 1));
  put('runs/.trash/dead0000-x/run.json', '{}');
  put('Saves/states/0123456789abcdef-1.state', Buffer.alloc(60000, 2));
  put('Saves/states/0123456789abcdef-1.json', '{"core":"gambatte-native"}');
  put('Local Storage/leveldb/000003.log', 'sl-doc-abcd1234');
  put('IndexedDB/http_localhost_47390.indexeddb.leveldb/CURRENT', 'MANIFEST');
  put('Library/Pokemon - Red.gb', Buffer.alloc(1 * MB));
  put('Cache/Cache_Data/data_1', Buffer.alloc(100000));
  put('GPUCache/data_0', 'x');
  put('ctr/updates/abc/sd/x.app', 'update');
  put('ctr/saves/e966/Azahar/sdmc/Nintendo 3DS/0/0/title/00040000/00164800/data/00000001/main', 'game save');
  put('ctr/saves/e966/Azahar/sdmc/Nintendo 3DS/0/0/title/0004000e/00164800/content/00000000.app', 'installed update');
  put('ctr/saves/e966/Azahar/shaders/vulkan/pipeline/x.bin', 'cache');
  put('tools/mgba/x', 'tool');
  put('SingletonLock', 'lock');
}
const filesIn = (dir) => {
  const out = [];
  const walk = (rel) => {
    for (const n of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out.sort();
};

test('versionStep: 2.x (nothing noted), the same major, a new install, a later 4.0', () => {
  assert.deepEqual(U.versionStep({ onboarded: true, lang: 'de' }, '3.0.0'), { from: '2.x', to: 3, major: true, patch: { appVersion: '3.0.0', whatsNew: '3.0' } });
  assert.deepEqual(U.versionStep({ lang: 'de' }, '3.0.0').patch, { appVersion: '3.0.0' }, 'never onboarded: the welcome tour, not the cards');
  assert.deepEqual(U.versionStep({}, '3.0.0'), { from: null, to: 3, major: false, patch: { appVersion: '3.0.0' } }, 'a new install');
  assert.equal(U.versionStep({ gpuStart: { backend: 'vulkan', pending: 1 } }, '3.0.0').from, null, 'only the graphics marker: still new');
  assert.deepEqual(U.versionStep({ onboarded: true, appVersion: '3.0.0' }, '3.0.0').patch, {}, 'nothing to do on the next start');
  assert.deepEqual(U.versionStep({ onboarded: true, appVersion: '3.0.0' }, '3.0.1'), { from: '3.0.0', to: 3, major: false, patch: { appVersion: '3.0.1' } });
  // back on 2.8.3 for a while (it keeps keys it doesn't know) and 3.0 again: no second round
  assert.equal(U.versionStep({ onboarded: true, appVersion: '3.0.0', upgradeBackups: { 3: { name: 'pre-3.0-x' } } }, '3.0.0').major, false);
  assert.deepEqual(U.versionStep({ onboarded: true, appVersion: '3.4.2' }, '4.0.0').patch, { appVersion: '4.0.0', whatsNew: '4.0' });
  // a config written for a new install (the e2e scripts, tests): nothing in the folder shows the app ever ran
  assert.deepEqual(U.versionStep({ onboarded: true, lang: 'de' }, '3.0.0', false), { from: null, to: 3, major: false, patch: { appVersion: '3.0.0' } });
  const fresh = join(TMP, 'fresh');
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(fresh, 'config.json'), '{"onboarded":true}');
  assert.equal(U.ranBefore(fresh), false);
  let cfg = { onboarded: true };
  assert.equal(U.upgradeStep({ dataDir: fresh, config: cfg, current: '3.0.0', save: (p) => (cfg = { ...cfg, ...p }), log: () => assert.fail('no backup') }).major, false);
  assert.deepEqual(cfg, { onboarded: true, appVersion: '3.0.0' }, 'no cards, no backup');
  writeFileSync(join(fresh, 'library-index.json'), '{}');
  assert.equal(U.ranBefore(fresh), true, 'what every 2.x start leaves');
});

test('backup: runs, saves, states, settings, trophies and the browser storage – not ROMs, the library, caches, tools or installed updates', () => {
  const dir = join(TMP, 'plan');
  data283(dir);
  const made = U.makeBackup(dir, { label: '3.0', now: Date.UTC(2026, 10, 19, 12), free: 50 * 1024 * MB });
  assert.equal(made.name, 'pre-3.0-2026-11-19');
  assert.equal(made.path, join(dir, 'backups', 'pre-3.0-2026-11-19'));
  assert.deepEqual(filesIn(made.path), [
    'IndexedDB/http_localhost_47390.indexeddb.leveldb/CURRENT',
    'Local Storage/leveldb/000003.log',
    'Saves/states/0123456789abcdef-1.json',
    'Saves/states/0123456789abcdef-1.state',
    'config.json',
    'ctr/saves/e966/Azahar/sdmc/Nintendo 3DS/0/0/title/00040000/00164800/data/00000001/main',
    'live-runs.json',
    'runs/abcd1234/Sam - Red Version.sav',
    'runs/abcd1234/doc.json',
    'runs/abcd1234/host-key.pem',
    'runs/abcd1234/run.json',
    'trophies.json',
  ]);
  assert.deepEqual(readFileSync(join(made.path, 'runs/abcd1234/Sam - Red Version.sav')), Buffer.alloc(32768, 1), 'byte for byte');
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(made.path, 'live-runs.json')).mode & 0o777, 0o600, 'a private file stays private');
    assert.equal(statSync(join(made.path, 'runs/abcd1234/host-key.pem')).mode & 0o777, 0o600);
  }
  assert.equal(made.files, 12);
  assert.ok(made.bytes < 200000, `small: ${made.bytes}`);
  // a second backup the same day doesn't replace the first
  assert.equal(U.makeBackup(dir, { label: '3.0', now: Date.UTC(2026, 10, 19, 13), free: 50 * 1024 * MB }).name, 'pre-3.0-2026-11-19-2');
  // and a backup never copies backups
  assert.ok(!filesIn(join(dir, 'backups', 'pre-3.0-2026-11-19-2')).some((f) => f.startsWith('backups/')));
});

test('backup: not enough free space (with room left for the games) – nothing written, and why', () => {
  const dir = join(TMP, 'space');
  data283(dir);
  const plan = U.backupPlan(dir);
  const res = U.makeBackup(dir, { label: '3.0', free: plan.bytes + U.HEADROOM - 1 });
  assert.equal(res.skipped, 'space');
  assert.equal(res.need, plan.bytes);
  assert.equal(existsSync(join(dir, 'backups')), false);
  assert.equal(U.makeBackup(dir, { label: '3.0', free: plan.bytes + U.HEADROOM }).name.startsWith('pre-3.0-'), true, 'just enough');
});

test('upgradeStep: once – noted in the config, also when skipped; a copy cut off before is cleared; a log line either way', () => {
  const dir = join(TMP, 'step');
  data283(dir);
  let config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const save = (p) => (config = { ...config, ...p });
  const lines = [];
  mkdirSync(join(dir, 'backups', '.pre-3.0-2026-11-18.partial', 'runs'), { recursive: true });
  const first = U.upgradeStep({ dataDir: dir, config, current: '3.0.0', save, log: (l) => lines.push(l), now: Date.UTC(2026, 10, 19), free: 50 * 1024 * MB });
  assert.equal(first.major, true);
  assert.equal(first.backup.name, 'pre-3.0-2026-11-19');
  assert.equal(first.backup.from, '2.x');
  assert.equal(config.appVersion, '3.0.0');
  assert.equal(config.whatsNew, '3.0');
  assert.equal(config.upgradeBackups[3].name, 'pre-3.0-2026-11-19');
  assert.deepEqual(readdirSync(join(dir, 'backups')), ['pre-3.0-2026-11-19'], 'the cut-off copy is gone');
  assert.match(lines[0], /^\[upgrade\] backup before 3\.0: 12 files/);
  // the next start: nothing again
  const again = U.upgradeStep({ dataDir: dir, config, current: '3.0.0', save, log: (l) => lines.push(l), free: 50 * 1024 * MB });
  assert.equal(again.major, false);
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
  assert.equal(lines.length, 1);

  // no space: skipped, noted (a backup made later wouldn't be from before 3.0), the log says why; data untouched
  const dir2 = join(TMP, 'step2');
  data283(dir2);
  let c2 = { onboarded: true };
  const r2 = U.upgradeStep({ dataDir: dir2, config: c2, current: '3.0.0', save: (p) => (c2 = { ...c2, ...p }), log: (l) => lines.push(l), free: 1000 });
  assert.equal(r2.backup.skipped, 'space');
  assert.equal(c2.upgradeBackups[3].skipped, 'space');
  assert.match(lines.at(-1), /^\[upgrade\] no backup before 3\.0: .* MB needed, 0 MB free/);
  assert.equal(U.upgradeStep({ dataDir: dir2, config: c2, current: '3.0.0', save: () => assert.fail('nothing to save'), log: () => assert.fail('quiet') }).backup.skipped, 'space');
  // development (the data folder is the project folder): the version is noted, nothing copied
  const dir3 = join(TMP, 'step3');
  data283(dir3);
  let c3 = { onboarded: true };
  U.upgradeStep({ dataDir: dir3, config: c3, current: '3.0.0', save: (p) => (c3 = { ...c3, ...p }), backups: false, log: () => {} });
  assert.equal(c3.appVersion, '3.0.0');
  assert.equal(existsSync(join(dir3, 'backups')), false);
  // what the page sees: no path, only the folder's name
  assert.deepEqual(U.backupInfo(config.upgradeBackups[3]), { name: 'pre-3.0-2026-11-19', bytes: first.backup.bytes, files: 12, at: Date.UTC(2026, 10, 19), from: '2.x' });
  assert.deepEqual(U.backupInfo(c2.upgradeBackups[3]), { skipped: 'space', need: r2.backup.need, free: 1000, at: r2.backup.at });
});

test('the server: the first start on 2.8.3 data makes the backup before migrating; status, About and the cards', async () => {
  const dir = process.env.SLS_DATA_DIR;
  data283(dir);
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
  try {
    const backups = readdirSync(join(dir, 'backups'));
    assert.equal(backups.length, 1);
    // the backup holds the config as 2.8.3 left it – before 3.0 added anything (the stream migration, the version)
    const before = JSON.parse(readFileSync(join(dir, 'backups', backups[0], 'config.json'), 'utf8'));
    assert.deepEqual(before, { onboarded: true, playerName: 'Sam', lang: 'de', theme: 'deutan', ctrRenderer: 'compat' });
    const st = await fetch(`${url}/api/status`, { headers: { 'x-soullink': '1' } }).then((r) => r.json());
    assert.ok(st.config, JSON.stringify(st).slice(0, 300));
    assert.equal(st.config.whatsNew, '3.0');
    assert.equal(st.upgradeBackup.name, backups[0]);
    assert.equal(JSON.stringify(st.upgradeBackup).includes(dir), false, 'no data folder path for the page');
    assert.equal(st.config.theme, 'deutan');
    // the page can close the cards, not open them
    assert.equal((await (await post('/api/config', { whatsNew: '4.0' })).json()).whatsNew, '3.0');
    assert.equal((await (await post('/api/config', { whatsNew: null })).json()).whatsNew, null);
    assert.equal((await fetch(`${url}/api/status`, { headers: { 'x-soullink': '1' } }).then((r) => r.json())).config.whatsNew, null);
    // "Open backup folder": only the folder the config names
    rmSync(join(dir, 'backups', backups[0]), { recursive: true });
    const gone = await post('/api/backup/reveal', { path: '/etc' });
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).code, 'backupGone');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
