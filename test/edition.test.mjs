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
