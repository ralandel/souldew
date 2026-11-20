// This build's identity (shared/edition.mjs) – kept in step with package.json, and apart from the official app's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EDITION, syncOrigins } from '../shared/edition.mjs';
import { LINKS } from '../shared/links.mjs';
import { BROKERS, P2P_CONFIG } from '../web/lib/sync.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json carries the same name and app id as the edition', () => {
  assert.equal(pkg.build.productName, EDITION.name);
  assert.equal(pkg.build.appId, EDITION.appId);
  assert.equal(pkg.build.nsis.shortcutName, EDITION.name);
  assert.equal(pkg.build.nsis.uninstallDisplayName, EDITION.name);
});

test('installs, data and network never collide with the official souldew app', () => {
  // official: appId studio.soullink.app, Windows folder Programs\souldew (= package name), data folder "SoulLink Studio",
  // .deb package souldew, desktop file souldew.desktop, port 47390, Trystero app id soullink-studio-v1, topics slstudio/…
  assert.notEqual(EDITION.appId, 'studio.soullink.app');
  assert.notEqual(pkg.name, 'souldew');
  assert.notEqual(EDITION.dataFolder, 'SoulLink Studio');
  assert.notEqual(pkg.desktopName, 'souldew.desktop');
  assert.notEqual(pkg.build.linux.executableName, 'souldew');
  assert.notEqual(EDITION.port, 47390);
  assert.notEqual(EDITION.netId, 'soullink-studio-v1');
  assert.ok(!EDITION.topicRoot.startsWith('slstudio'));
});

test('sync uses only the edition servers', () => {
  assert.ok(EDITION.brokers.length >= 1);
  for (const u of [...EDITION.brokers, ...EDITION.signalRelays]) assert.equal(new URL(u).protocol, 'wss:', u);
  assert.deepEqual(BROKERS, EDITION.brokers);
  assert.deepEqual(P2P_CONFIG.relayConfig.urls, EDITION.signalRelays);
  assert.deepEqual(P2P_CONFIG.rtcConfig.iceServers, EDITION.iceServers);
  // the VPS broker's ACL only lets `souldew/#` through
  assert.match(EDITION.topicRoot, /^souldew\/[a-z0-9-]+$/);
  assert.ok(syncOrigins().length >= 1);
});

test('the official online services stay off unless the edition names them', () => {
  assert.equal(EDITION.liveRunsUrl, null);
  assert.equal(EDITION.presence, false);
  for (const [k, u] of Object.entries(LINKS)) if (k !== 'coffee') assert.ok(!/souldewapp|souldew\.app/.test(u), `${k}: ${u}`);
  assert.equal(pkg.updates.repo, 'ralandel/souldew');
});

test('no souldew account (3.0): the server says so, every other account route is refused, nothing goes out', async () => {
  assert.equal(EDITION.accounts, false);
  const { createAccounts } = await import('../server/lib/accounts/index.mjs');
  const calls = [];
  const a = createAccounts({ port: () => 1, env: {}, fetchImpl: async (u) => { calls.push(u); throw new Error('no network'); } });
  assert.equal(a.off, true);
  const find = (method, path) => a.routes.find((r) => r.method === method && r.pattern.test(path));
  const status = await find('GET', '/api/account').handler();
  assert.equal(status.session.signedIn, false);
  assert.equal(status.session.off, true);
  assert.equal(status.session.loaded, true, 'final: the page never waits for a keychain');
  assert.equal(status.service, '');
  for (const [m, p] of [['POST', '/api/account/login'], ['GET', '/api/account/friends'], ['POST', '/api/account/presence']]) {
    assert.throws(() => find(m, p).handler(), (e) => e.status === 404 && e.code === 'acctOff', `${m} ${p}`);
  }
  assert.equal(find('GET', '/api/account/diagnostics'), undefined, 'diagnostics stay with the server');
  assert.deepEqual(a.diagnostics(), { signedIn: false, tier: null, off: true });
  await a.loadSession();
  assert.equal(await a.goOffline(), false);
  assert.deepEqual(calls, []);
});

test('Play together and the 3.0 multiplayer modules take every slot of 8', async () => {
  const { MODES } = await import('../shared/slots.mjs');
  assert.ok(MODES.includes('together'));
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(read('web/lib/linksession.mjs'), /const SLOT_RE = \/\^p\[1-8\]\$\/;/);
  assert.match(read('shared/raid.mjs'), /const SLOTS = ALL_SLOTS;/);
  assert.match(read('web/views/playtogether.mjs'), /length: MAX_PLAYERS - 1/);
});
