// Upgrading from 2.x to 3.0 (checked with real 2.8.3 data, see CHANGELOG 3.0.0): save states of the previous Game Boy
// player survive the automatic slots, and a SoulLink partner still on 2.x is recognised – Trade/Battle say why instead
// of running into "didn't answer", and the run's log tells the 2.x player (whose app shows it as a notice) to update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const S = await import('../server/lib/statefiles.mjs');
const { RunDoc } = await import('../web/lib/doc.mjs');
const H = await import('../web/lib/together.mjs');
const R = await import('../web/lib/run.mjs');

// ---- save states ------------------------------------------------------------------------------------------------------
const KEY = '0123456789abcdef';
function state(dir, slot, core, at) {
  for (const [ext, body] of [['state', `${core}@${at}`], ['jpg', 'jpg'], ['json', JSON.stringify({ core, party: [] })]]) {
    const p = S.statePath(dir, KEY, slot, ext);
    writeFileSync(p, body);
    utimesSync(p, at / 1000, at / 1000);
  }
}
const body = (dir, slot) => (existsSync(S.statePath(dir, KEY, slot, 'state')) ? readFileSync(S.statePath(dir, KEY, slot, 'state'), 'utf8') : null);

test('states: the previous Game Boy player\'s "where you left off" becomes a backup on the first 3.0 game, never replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-states-'));
  try {
    const t = Date.now() - 3600e3;
    // as 2.8.3 left them: a backup and "where you left off" a minute apart – both Gambatte
    state(dir, 98, 'gambatte-native', t);
    state(dir, 99, 'gambatte-native', t + 60e3);
    S.rotateAutoState(dir, KEY); // 3.0's first automatic state is about to be written
    assert.equal(body(dir, 99), null, 'slot 99 is free for the new state');
    assert.equal(body(dir, 98), `gambatte-native@${t + 60e3}`, 'the newest Gambatte state is backup 1');
    assert.equal(body(dir, 97), `gambatte-native@${t}`, 'the older one moved on');
    assert.equal(JSON.parse(readFileSync(S.statePath(dir, KEY, 98, 'json'), 'utf8')).core, 'gambatte-native', 'its info (the note in the panel) went with it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('states: a backup of a retired core that falls off the end is kept aside; the usual 10-minute rule stays for the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-states-'));
  try {
    const t = Date.now() - 7200e3;
    state(dir, 96, 'gambatte-native', t);
    state(dir, 97, 'sameboy-dmg-native', t + 600e3);
    state(dir, 98, 'sameboy-dmg-native', t + 1200e3);
    state(dir, 99, 'sameboy-dmg-native', t + 1800e3);
    S.rotateAutoState(dir, KEY);
    const kept = readdirSync(join(dir, S.KEPT_DIR)).sort();
    assert.deepEqual(kept, [`${KEY}-96-${t}.jpg`, `${KEY}-96-${t}.json`, `${KEY}-96-${t}.state`], 'kept with its picture and info');
    assert.equal(readFileSync(join(dir, S.KEPT_DIR, `${KEY}-96-${t}.state`), 'utf8'), `gambatte-native@${t}`);
    assert.equal(body(dir, 96), `sameboy-dmg-native@${t + 600e3}`);
    // a SameBoy "where you left off" two minutes after the newest backup: replaced, as before (no new backup)
    state(dir, 99, 'sameboy-dmg-native', Date.now() - 60e3);
    state(dir, 98, 'sameboy-dmg-native', Date.now() - 180e3);
    S.rotateAutoState(dir, KEY);
    assert.ok(body(dir, 99), 'left for the write to replace');
    // a SameBoy one falling off the end is gone, as before
    const dir2 = mkdtempSync(join(tmpdir(), 'sls-states-'));
    state(dir2, 96, 'sameboy-native', t);
    state(dir2, 97, 'sameboy-native', t + 600e3);
    state(dir2, 98, 'sameboy-native', t + 1200e3);
    state(dir2, 99, 'sameboy-native', t + 1800e3);
    S.rotateAutoState(dir2, KEY);
    assert.equal(existsSync(join(dir2, S.KEPT_DIR)), false);
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a partner still on 2.x -------------------------------------------------------------------------------------------
const PAIR = { id: 'run1', mode: 'soullink', game: { code: 'CPUE', system: 'nds' }, players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } } };
function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}
/** My hub (p1) with a partner p2 whose app is 3.0 (`talks`: answers with statuses) or 2.x (silent on the world channel). */
function hubWith({ talks, p2p = true, manifest = PAIR, doc = mkDoc() }) {
  let t = 1e12;
  const listeners = new Set();
  const link = {
    slot: 'p1', others: ['p2'], status: { partners: { p2: { p2p } } }, stopped: false,
    onWorld: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    sendWorld: () => new Set(p2p ? ['p2'] : []),
    sendMessage: () => {},
  };
  const hub = new H.TogetherHub(link, { doc, manifest, now: () => t });
  clearInterval(hub.timer);
  const tick = (ms) => {
    t += ms;
    if (talks) for (const fn of listeners) fn({ t: 'tg', op: 'st', v: 1, b: 0, here: null, caps: ['gift', 'ping', 'watch'], from: 'p2' });
    hub.tick();
  };
  return { hub, link, doc, tick };
}

test('older partner: a direct connection without one status for three heartbeats is a 2.x app – never before, never a 3.0 one', () => {
  const old = hubWith({ talks: false });
  old.tick(0);
  assert.equal(old.hub.olderApp('p2'), false, 'just connected: not known yet');
  old.tick(H.OLDER_APP_MS - 1000);
  assert.equal(old.hub.olderApp('p2'), false, 'a slow first heartbeat is no reason');
  old.tick(1000);
  assert.equal(old.hub.olderApp('p2'), true);
  // the connection drops: unknown again (the board says "not online" / "no connection" then)
  old.link.status.partners.p2.p2p = false;
  old.tick(500);
  assert.equal(old.hub.olderApp('p2'), false);

  const cur = hubWith({ talks: true });
  for (let i = 0; i < 10; i++) cur.tick(5000);
  assert.equal(cur.hub.olderApp('p2'), false, 'a 3.0 partner sends its status');
  const relay = hubWith({ talks: false, p2p: false });
  for (let i = 0; i < 10; i++) relay.tick(5000);
  assert.equal(relay.hub.olderApp('p2'), false, 'without a direct connection nothing is known');
});

test('older partner: one log line for them (shown as a notice in their 2.x app), the same for every 3.0 player; none in a solo run', () => {
  const doc = mkDoc();
  const a = hubWith({ talks: false, doc });
  a.tick(0);
  a.tick(H.OLDER_APP_MS);
  const lines = R.feedList(doc).filter((f) => f.about === 'p2');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].slot, 'p1', 'written by me – a 2.x app shows a partner\'s new log line as a notice');
  assert.match(lines[0].text, /^Tim is on an older souldew – .*souldew 3\.0.*Settings › About/);
  assert.equal(lines[0].msg.key, 'feed.olderApp');
  // another 3.0 player of the run (other device) writes the same entry, not a second one
  const b = hubWith({ talks: false, doc });
  b.tick(0);
  b.tick(H.OLDER_APP_MS);
  a.tick(30000);
  assert.equal(R.feedList(doc).filter((f) => f.about === 'p2').length, 1);
  // a solo Nuzlocke has nobody to tell (and no partner to begin with)
  const solo = hubWith({ talks: false, manifest: { ...PAIR, mode: 'nuzlocke', players: { p1: { name: 'Sam' } } } });
  solo.tick(0);
  solo.tick(H.OLDER_APP_MS);
  assert.equal(R.feedList(solo.doc).length, 0);
});
