// "Playing now" (docs/PRIVACY.md): the page's timer (web/lib/presence.mjs) and the local server's heartbeat
// (server/lib/presence.mjs) – only while a game runs, stopped when it closes, the setting obeyed at once, nothing but
// sid/system/mode/version sent, silent when offline – and the /api/presence route against a mock bot (never the real one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { presenceLoop, presenceSystem, presenceBody } from '../web/lib/presence.mjs';
import { createPresence, presenceOf } from '../server/lib/presence.mjs';
import { LIVE_RUNS_URL, LIVE_RUNS_FALLBACK_URL } from '../server/lib/liveruns.mjs';
import { EDITION } from '../shared/edition.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'souldew-presence-'));
process.env.SLS_DATA_DIR = DATA;

/** Fake timers: intervals and timeouts that only run when the test says so. */
function fakeTimers() {
  let id = 0;
  const jobs = new Map();
  const t = {
    setInterval: (fn, ms) => { jobs.set(++id, { fn, ms, every: true }); return id; },
    clearInterval: (i) => jobs.delete(i),
    setTimeout: (fn, ms) => { jobs.set(++id, { fn, ms, every: false }); return id; },
    clearTimeout: (i) => jobs.delete(i),
    /** runs every job due within `ms` once (an interval as often as it fits) */
    run(ms) {
      for (const [i, j] of [...jobs]) {
        if (j.every) for (let k = 0; k < Math.floor(ms / j.ms); k++) j.fn();
        else if (j.ms <= ms) { jobs.delete(i); j.fn(); }
      }
    },
    get count() { return jobs.size; },
  };
  return t;
}

// ---- the page --------------------------------------------------------------------------------------------------
test('page: heartbeats only while a game runs – one at the start, then every minute; one stop when it closes', () => {
  const sent = [];
  const timers = fakeTimers();
  const loop = presenceLoop({ send: (s) => sent.push(s), timers });
  loop.set(null); // nothing running: nothing sent
  assert.deepEqual(sent, []);
  loop.set({ system: 'gbc', mode: 'nuzlocke' });
  assert.deepEqual(sent, [{ system: 'gb', mode: 'nuzlocke' }]); // GBC counts as GB
  loop.set({ system: 'gbc', mode: 'nuzlocke' }); // the same again (a re-render): nothing new
  assert.equal(sent.length, 1);
  timers.run(3 * 60_000);
  assert.equal(sent.length, 4);
  loop.set(null); // the game closed
  assert.deepEqual(sent.at(-1), null);
  assert.equal(timers.count, 0, 'no timer left');
  timers.run(10 * 60_000);
  assert.equal(sent.length, 5, 'nothing after the stop');
  loop.set(null);
  assert.equal(sent.length, 5, 'only one stop');
});

test('page: another game or mode restarts the beat; unknown systems are not counted', () => {
  const sent = [];
  const loop = presenceLoop({ send: (s) => sent.push(s), timers: fakeTimers() });
  loop.set({ system: 'gba', mode: 'soullink' });
  loop.set({ system: 'nds', mode: 'solo' });
  assert.deepEqual(sent, [{ system: 'gba', mode: 'soullink' }, { system: 'nds', mode: 'solo' }]);
  loop.set({ system: 'n64', mode: 'solo' }); // not a souldew system → treated as nothing running
  assert.deepEqual(sent.at(-1), null);
  assert.equal(presenceSystem('3ds'), '3ds');
  assert.equal(presenceSystem('psx'), null);
  assert.deepEqual(presenceBody(null), { playing: false });
  assert.deepEqual(presenceBody({ system: 'gba', mode: 'solo' }), { system: 'gba', mode: 'solo' });
});

// ---- the server's heartbeat -----------------------------------------------------------------------------------
function fakeBot({ fail = false, every } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (fail) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ ok: true, ...(every ? { every } : {}) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const ENV = { SOULDEW_LIVE_URL: 'http://127.0.0.1:9' }; // a test address – never the real bot

test('server: exactly sid, system, mode and version – a new random id per game, a stop when it closes', async () => {
  const bot = fakeBot();
  let clock = 1_000_000;
  const p = createPresence({ fetchImpl: bot.fetchImpl, env: ENV, version: () => '2.7.4', now: () => clock, timers: fakeTimers() });
  assert.equal(p.active, false);
  const r = await p.beat({ system: 'gba', mode: 'soullink', rom: 'Pokemon Emerald.gba', player: 'Robin' });
  assert.equal(r.sent, true);
  assert.equal(p.active, true);
  const first = bot.calls[0];
  assert.equal(first.url, 'http://127.0.0.1:9/presence');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.redirect, 'error');
  assert.equal(first.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(first.body).sort(), ['mode', 'sid', 'system', 'v']);
  assert.match(first.body.sid, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual({ ...first.body, sid: 'x' }, { sid: 'x', system: 'gba', mode: 'soullink', v: '2.7.4' });
  assert.ok(!JSON.stringify(first.body).includes('Emerald') && !JSON.stringify(first.body).includes('Robin'));

  await p.beat({ system: 'gba', mode: 'soullink' }); // again right away (reload, two pages): not sent
  assert.equal(bot.calls.length, 1);
  clock += 60_000;
  await p.beat({ system: 'gba', mode: 'soullink' });
  assert.equal(bot.calls.length, 2);
  assert.equal(bot.calls[1].body.sid, first.body.sid, 'the same game keeps its id');

  assert.equal(await p.stop(), true);
  assert.deepEqual(bot.calls[2].body, { sid: first.body.sid, stop: true });
  assert.equal(p.active, false);
  assert.equal(await p.stop(), false, 'nothing to stop');
  assert.equal(bot.calls.length, 3);

  await p.beat({ system: 'nds', mode: 'solo' });
  assert.notEqual(bot.calls[3].body.sid, first.body.sid, 'the next game gets a new id');
});

test('server: the setting is obeyed at once – off: nothing sent, switched off while playing: one stop', async () => {
  const bot = fakeBot();
  let on = false;
  let clock = 0;
  const p = createPresence({ enabled: () => on, fetchImpl: bot.fetchImpl, env: ENV, version: () => '2.7.4', now: () => clock, timers: fakeTimers() });
  assert.equal((await p.beat({ system: 'gba', mode: 'solo' })).sent, false);
  assert.equal(bot.calls.length, 0);
  on = true;
  await p.beat({ system: 'gba', mode: 'solo' });
  assert.equal(bot.calls.length, 1);
  on = false;
  clock += 60_000;
  await p.beat({ system: 'gba', mode: 'solo' }); // the next minute's report: the setting is off now
  assert.equal(bot.calls.length, 2);
  assert.equal(bot.calls[1].body.stop, true);
  clock += 60_000;
  await p.beat({ system: 'gba', mode: 'solo' });
  assert.equal(bot.calls.length, 2, 'nothing more while off');
});

test('server: offline is silent – no throw, the fallback address tried once, the next minute tries again', async () => {
  const bot = fakeBot({ fail: true });
  let clock = 0;
  // (with the official bot as the build's bot – this build has none, see the route test)
  const p = createPresence({ fetchImpl: bot.fetchImpl, env: {}, edition: { liveRunsUrl: LIVE_RUNS_URL }, version: () => '2.7.4', now: () => clock, timers: fakeTimers() });
  const r = await p.beat({ system: '3ds', mode: 'nuzlocke' });
  assert.equal(r.sent, false);
  assert.deepEqual(bot.calls.map((c) => c.url), [`${LIVE_RUNS_URL}/presence`, `${LIVE_RUNS_FALLBACK_URL}/presence`]);
  clock += 60_000;
  await p.beat({ system: '3ds', mode: 'nuzlocke' });
  assert.equal(bot.calls.length, 4);
  assert.equal(await p.stop(), false);
});

test('server: a slower beat asked by the bot – the page\'s minute reports in between are not sent', async () => {
  const bot = fakeBot({ every: 120 });
  let clock = 0;
  const p = createPresence({ fetchImpl: bot.fetchImpl, env: ENV, version: () => '2.7.4', now: () => clock, timers: fakeTimers() });
  for (let i = 0; i < 5; i++) {
    await p.beat({ system: 'gba', mode: 'solo' });
    clock += 60_000;
  }
  assert.equal(bot.calls.length, 3); // minutes 0, 2, 4
});

test('server: the page goes quiet (crashed, reloaded) → stopped after 3 minutes; the bot may ask for a slower beat', async () => {
  const bot = fakeBot({ every: 120 });
  const timers = fakeTimers();
  const p = createPresence({ fetchImpl: bot.fetchImpl, env: ENV, version: () => '2.7.4', now: () => 0, timers });
  const r = await p.beat({ system: 'gb', mode: 'soullink' });
  assert.equal(r.every, 120_000);
  assert.equal(bot.calls.length, 1);
  timers.run(3 * 60_000);
  await new Promise((res) => setImmediate(res));
  assert.equal(p.active, false);
  assert.equal(bot.calls.at(-1).body.stop, true);
});

test('server: only known systems and modes', () => {
  assert.deepEqual(presenceOf({ system: 'gbc', mode: 'solo' }), { system: 'gb', mode: 'solo' });
  assert.equal(presenceOf({ system: 'gba', mode: 'party' }), null);
  assert.equal(presenceOf({ system: 'wii', mode: 'solo' }), null);
  assert.equal(presenceOf(null), null);
});

// ---- the route ---------------------------------------------------------------------------------------------------
let bot;
let app;
let starting;
const seen = [];
before(() => (starting = (async () => {
  bot = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ path: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true,"every":60}');
  });
  await new Promise((r) => bot.listen(0, '127.0.0.1', r));
  process.env.SOULDEW_LIVE_URL = `http://127.0.0.1:${bot.address().port}`;
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'config.json'), JSON.stringify({ onboarded: true }));
  const { startServer } = await import('../server/app.mjs');
  app = await startServer({ port: 0, background: false });
})()));
after(async () => {
  await starting?.catch(() => {});
  for (const s of [app?.server, bot]) {
    s?.closeAllConnections?.();
    s?.close();
  }
  rmSync(DATA, { recursive: true, force: true });
});
const call = async (method, path, body) => {
  const r = await fetch(`${app.url}${path}`, { method, headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('route: /api/presence forwards while on, the setting shows in the status, switching off stops at once', async () => {
  await starting;
  if (!EDITION.presence) {
    // this build sends no heartbeat at all (shared/edition.mjs → presence: false): off in the status, whatever the setting
    assert.equal((await call('GET', '/api/status')).body.config.presence, false);
    await call('POST', '/api/config', { presence: true });
    assert.equal((await call('GET', '/api/status')).body.config.presence, false);
    assert.equal((await call('POST', '/api/presence', { system: 'nds', mode: 'soullink' })).body.sent, false);
    assert.equal(seen.length, 0, 'nothing ever reaches the bot');
    return;
  }
  assert.equal((await call('GET', '/api/status')).body.config.presence, true, 'on unless switched off');
  const r = await call('POST', '/api/presence', { system: 'nds', mode: 'soullink' });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/presence');
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['mode', 'sid', 'system', 'v']);
  assert.equal(seen[0].body.system, 'nds');

  await call('POST', '/api/config', { presence: false });
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(seen.at(-1).body, { sid: seen[0].body.sid, stop: true }, 'switched off: the bot hears stop right away');
  assert.equal((await call('GET', '/api/status')).body.config.presence, false);
  const n = seen.length;
  assert.equal((await call('POST', '/api/presence', { system: 'nds', mode: 'soullink' })).body.sent, false);
  assert.equal(seen.length, n, 'nothing while off');

  await call('POST', '/api/config', { presence: true });
  await call('POST', '/api/presence', { system: 'gba', mode: 'solo' });
  assert.equal(seen.length, n + 1);
  await call('POST', '/api/presence', { playing: false });
  assert.equal(seen.at(-1).body.stop, true);
  assert.equal((await call('POST', '/api/presence', { system: 'gba', mode: 'junk' })).body.sent, false);
});
