// The anonymous daily usage ping (server/lib/usage.mjs, docs/PRIVACY.md): once a day, only the documented fields, no
// install id (a fresh day id each day, memory only), the switch obeyed, only a packaged app, silent offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUsage, pingFor, isoWeek, localDay, firstUseOf } from '../server/lib/usage.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'souldew-usage-'));
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);

function setup({ on = true, allowed = true, start = at(2026, 11, 22), answer = () => new Response('{"ok":true}', { status: 200 }), config = null } = {}) {
  const d = dir();
  const configPath = join(d, 'config.json');
  if (config) writeFileSync(configPath, JSON.stringify(config));
  let clock = start;
  const sent = [];
  const u = createUsage({
    enabled: () => on, allowed, file: join(d, 'usage.json'), configPath, platform: 'darwin', arch: 'arm64', version: () => '3.0.1',
    env: { SOULDEW_LIVE_URL: 'http://127.0.0.1:9/mock' }, now: () => clock,
    fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return answer(); },
  });
  return { u, sent, d, setClock: (c) => { clock = c; }, setOn: (v) => { on = v; } };
}

test('ISO weeks and local days', () => {
  assert.equal(isoWeek('2026-11-22'), '2026-W47');
  assert.equal(isoWeek('2026-11-23'), '2026-W48');
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
  assert.equal(localDay(at(2026, 1, 5)), '2026-01-05');
});

test('a new install: one ping today with exactly the documented fields, new = true; nothing more that day', async () => {
  const s = setup();
  assert.deepEqual(await s.u.tick(), { sent: true, reason: 'sent' });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].url, 'http://127.0.0.1:9/mock/usage');
  const b = s.sent[0].body;
  assert.deepEqual(Object.keys(b).sort(), ['active28', 'active7', 'arch', 'day_id', 'first_week', 'new', 'os', 'v']);
  assert.match(b.day_id, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual({ ...b, day_id: null }, { day_id: null, v: '3.0.1', os: 'mac', arch: 'arm64', first_week: '2026-W47', active7: 1, active28: 1, new: true });
  s.setClock(at(2026, 11, 22, 20));
  assert.equal((await s.u.tick()).reason, 'done');
  assert.equal(s.sent.length, 1);
  // what stays on this computer: dates only
  assert.deepEqual(JSON.parse(readFileSync(join(s.d, 'usage.json'), 'utf8')), { firstUse: '2026-11-22', days: ['2026-11-22'], sent: '2026-11-22', wasNew: true });
  rmSync(s.d, { recursive: true });
});

test('the next days: a fresh day id each day, active days counted over 7 and 28 days, not new any more', async () => {
  const s = setup();
  await s.u.tick();
  for (const day of [23, 24, 26]) {
    s.setClock(at(2026, 11, day));
    await s.u.tick();
  }
  s.setClock(at(2026, 12, 20));
  await s.u.tick();
  const bodies = s.sent.map((x) => x.body);
  assert.equal(new Set(bodies.map((b) => b.day_id)).size, bodies.length, 'never the same id twice');
  assert.deepEqual(bodies.map((b) => [b.active7, b.active28, b.new, b.first_week]), [
    [1, 1, true, '2026-W47'], [2, 2, false, '2026-W47'], [3, 3, false, '2026-W47'], [4, 4, false, '2026-W47'],
    [1, 4, false, '2026-W47'], // 20 Dec: 23, 24 and 26 Nov are within the last 28 days (22 Nov no longer), nothing within 7
  ]);
  rmSync(s.d, { recursive: true });
});

test('an install from before this ping: first week from its config file, not new', async () => {
  const d = dir();
  const cfg = join(d, 'config.json');
  writeFileSync(cfg, '{"onboarded":true}');
  // (birth time can't be set back portably; an onboarded config made today counts from today, not as new)
  assert.equal(firstUseOf(cfg, localDay(new Date())), localDay(new Date()));
  assert.equal(firstUseOf(join(d, 'none.json'), '2026-11-22'), null);
  const p = pingFor(null, { today: '2026-11-22', version: '3.0.1', platform: 'win32', arch: 'x64', existing: '2026-10-01' });
  assert.equal(p.body.first_week, '2026-W40');
  assert.equal(p.body.new, false);
  assert.equal(p.body.os, 'win');
  assert.equal(pingFor(null, { today: '2026-11-22', version: '3.0.1', platform: 'linux', arch: 'ia32' }), null, 'a processor the bot does not count');
  utimesSync(cfg, new Date(), new Date());
  rmSync(d, { recursive: true });
});

test('the switch: off → nothing sent and nothing recorded; a development server never sends', async () => {
  const off = setup({ on: false });
  assert.equal((await off.u.tick()).reason, 'off');
  assert.equal(off.sent.length, 0);
  assert.equal(existsSync(join(off.d, 'usage.json')), false);
  const dev = setup({ allowed: false });
  assert.equal((await dev.u.tick()).reason, 'not-packaged');
  assert.equal(dev.sent.length, 0);
  dev.u.start(); // no timers either
  dev.u.stop();
  rmSync(off.d, { recursive: true });
  rmSync(dev.d, { recursive: true });
});

test('offline: silent, tried again later the same day with the same day id; a bot error 4xx ends the day', async () => {
  let fail = true;
  const s = setup({ answer: () => { if (fail) throw new TypeError('offline'); return new Response('{"ok":true}'); } });
  assert.deepEqual(await s.u.tick(), { sent: false, reason: 'offline' });
  fail = false;
  s.setClock(at(2026, 11, 22, 14));
  assert.equal((await s.u.tick()).reason, 'sent');
  assert.equal(s.sent[0].body.day_id, s.sent[1].body.day_id, 'a retry on the same day counts once at the bot');
  const bad = setup({ answer: () => new Response('{"error":"v"}', { status: 400 }) });
  assert.equal((await bad.u.tick()).reason, 'status 400');
  bad.setClock(at(2026, 11, 22, 18));
  assert.equal((await bad.u.tick()).reason, 'done');
  rmSync(s.d, { recursive: true });
  rmSync(bad.d, { recursive: true });
});
