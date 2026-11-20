// Play with friends, end to end: two souldew apps (two local servers with their own scratch data folders, as two
// players have them) signed in to the fake accounts service as two friends. The host invites the friend into a run it
// created; the service only carries the invite (name, game, a long friend code – never the run's room key); the friend's
// app accepts, joins with the existing invite-code handshake (over an in-memory relay), the host allows it, and the
// friend's server imports the very same run. Also: cancelling, "Ask to join", and that a friend invite can't be used
// by anybody else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(new URL('node_modules/htm/preact/standalone.module.js', ROOT).href, ctx);
    return spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx);
  },
});

const { startFakeAccounts, rawGet } = await import('./fixtures/fakeaccounts.mjs');

/** In-memory MQTT broker shared by both "pages" (the relay the invite-code handshake runs over). */
function fakeMqtt() {
  const clients = new Set();
  const log = [];
  const mod = {
    connect() {
      const c = new EventEmitter();
      c.connected = false;
      c.subs = [];
      c.subscribe = (pattern) => c.subs.push(pattern.replace(/#$/, ''));
      c.publish = (topic, payload) => {
        const buf = Buffer.from(payload);
        log.push({ topic, buf });
        for (const o of clients) if (o.connected && o.subs.some((p) => topic.startsWith(p))) setTimeout(() => o.emit('message', topic, buf), 1);
      };
      c.end = () => {
        c.connected = false;
        clients.delete(c);
      };
      clients.add(c);
      setTimeout(() => {
        c.connected = true;
        c.emit('connect');
      }, 1);
      return c;
    },
  };
  return { importer: async () => mod, log };
}

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

let fake;
const apps = [];
const dirs = [];
async function startApp(name) {
  const dir = mkdtempSync(join(tmpdir(), `souldew-inv-${name}-`));
  dirs.push(dir);
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('server/index.mjs', ROOT))], {
    env: { ...process.env, SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1', SLS_ACCOUNTS_URL: fake.base, SLS_ACCOUNTS_DEV_ENT_KEY: fake.ent.publicKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  const H = { 'x-soullink': '1', 'content-type': 'application/json' };
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await until(() => fetch(`${base}/api/status`, { headers: H }).then((r) => r.ok, () => false));
  const a = {
    name, dir, base, child, log: () => out,
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p, b) => call('DELETE', p, b),
    async signIn(user) {
      const { body } = await a.post('/api/account/login');
      fake.nextLogin = user.id;
      const b = await fake.browse(body.url);
      assert.equal(b.done, '/auth/done?r=ok', `${name} signed in`);
    },
  };
  apps.push(a);
  return a;
}

let host;
let guest;
let robin;
let kim;
let broker;
let fi;
let ic;
const RUN = 'c0ffee42';
const SECRET = 'ROOM-SECRET-7f3a9c1e5d2b';

before(async () => {
  fake = await startFakeAccounts();
  robin = fake.addUser({ handle: 'robin', display_name: 'Robin' });
  kim = fake.addUser({ handle: 'kimchi', display_name: 'Kim' });
  fake.befriend(robin.id, kim.id);
  [host, guest] = await Promise.all([startApp('host'), startApp('guest')]);
  // the host's run (as the wizard writes it – no ROM needed to invite)
  mkdirSync(join(host.dir, 'runs', RUN), { recursive: true });
  writeFileSync(join(host.dir, 'runs', RUN, 'run.json'), JSON.stringify({
    id: RUN, name: 'Emerald with Kim', mode: 'soullink', room: 'room-c0ffee42-abcdef', secret: SECRET, createdAt: new Date().toISOString(),
    players: { p1: { name: 'Robin' }, p2: { name: 'Kim' } }, game: { id: 'pokemon-emerald', system: 'gba', code: 'BPEE', title: 'POKEMON EMER' },
    randomizer: { enabled: false, values: {}, seeds: { p1: '1', p2: '2' } }, outputs: {}, rules: {},
  }));
  await host.signIn(robin);
  await guest.signIn(kim);
  broker = fakeMqtt();
  // the host's page: its relative API calls go to the host's server
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => realFetch(typeof url === 'string' && url.startsWith('/') ? host.base + url : url, opts);
  fi = await import('../web/lib/friendinvite.mjs');
  ic = await import('../web/lib/invitecode.mjs');
});

after(async () => {
  // the apps write their data folders until they have really exited – wait for that, then remove them
  await Promise.all(apps.map((a) => new Promise((res) => {
    if (a.child.exitCode !== null || a.child.signalCode !== null) return res();
    a.child.once('exit', res);
    a.child.kill();
  })));
  await fake?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const kimCard = () => ({ id: kim.id, name: 'Kim', handle: 'kimchi' });

test('invite a friend → their app accepts, joins with the existing handshake, the host allows → both have the same run', async () => {
  const manifest = (await host.get(`/api/runs/${RUN}`)).body;
  assert.equal(manifest.pack.secret, SECRET);
  const [entry] = await fi.inviteFriends(manifest, [kimCard()], { gameTitle: 'Emerald', taken: () => ['p1'], importers: { mqtt: broker.importer } });
  assert.match(entry.id, /^inv_/);
  assert.ok(ic.isFriendCode(entry.code), 'a long friend code, not a 6-digit one');

  // what the service got: the run's name, game and mode and the code – never the room key
  const sent = fake.log.find((l) => l.method === 'POST' && l.path === '/v1/invites');
  assert.deepEqual(Object.keys(sent.body).sort(), ['invite_code', 'run', 'to', 'ttl_minutes']);
  assert.deepEqual(sent.body.run, { name: 'Emerald with Kim', game: 'Emerald', mode: 'soullink', system: 'gba' });
  assert.equal(sent.body.ttl_minutes, 15, 'it lives as long as a code');
  assert.ok(!fake.log.some((l) => JSON.stringify(l.body).includes(SECRET)), 'the room key never reaches the service');

  // the friend's app: a notification (pending counter, the inbox), then Join
  const inbox = await until(async () => (await guest.get('/api/account/invites')).body.incoming.find((i) => i.id === entry.id));
  assert.equal(inbox.from.handle, 'robin');
  assert.equal(inbox.code, undefined, 'no code in a list');
  assert.equal((await guest.put('/api/account/presence', { state: 'library' })).body.ok, true);
  const pending = await until(async () => (await guest.get('/api/account')).body.pending?.invites >= 1 && (await guest.get('/api/account')).body.pending);
  assert.ok(pending.invites >= 1, 'the Friends badge counts it');
  const accepted = (await guest.post(`/api/account/invites/${entry.id}/accept`)).body;
  assert.equal(accepted.code, entry.code);

  // the existing join flow, with the invite's code
  const states = [];
  const job = ic.joinWithCode(accepted.code, { name: 'Kim', importers: { mqtt: broker.importer }, onState: (p, info) => states.push([p, info]) });
  await until(() => entry.state?.phase === 'request');
  assert.equal(entry.state.request.name, 'Kim');
  assert.equal(await fi.allowFriend(entry.id), true);
  const pack = await job.promise;
  assert.equal(pack.secret, SECRET);
  assert.deepEqual(states.find(([p]) => p === 'received')[1], { slot: 'p2', taken: ['p1'] }, 'the host suggests the free seat');
  assert.ok(!broker.log.some((m) => m.buf.includes(Buffer.from(SECRET))), 'the relay only ever saw it sealed');

  // the friend's server imports it exactly as an invite file would
  const imported = (await guest.post('/api/runs/import', { pack })).body;
  assert.equal(imported.id, RUN);
  const a = JSON.parse(readFileSync(join(host.dir, 'runs', RUN, 'run.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(guest.dir, 'runs', RUN, 'run.json'), 'utf8'));
  assert.deepEqual([b.id, b.room, b.secret, b.imported], [a.id, a.room, a.secret, true], 'same run, same room – the sync is peer to peer as before');
  await until(() => entry.state?.phase === 'done');
});

test('a cancelled invite is gone for the friend; its code answers nobody', async () => {
  const manifest = (await host.get(`/api/runs/${RUN}`)).body;
  const [entry] = await fi.inviteFriends(manifest, [kimCard()], { gameTitle: 'Emerald', importers: { mqtt: broker.importer } });
  await until(async () => (await guest.get('/api/account/invites')).body.incoming.some((i) => i.id === entry.id));
  await fi.cancelInvite(entry.id);
  assert.ok(!(await guest.get('/api/account/invites')).body.incoming.some((i) => i.id === entry.id));
  const r = await guest.post(`/api/account/invites/${entry.id}/accept`);
  assert.equal(r.status, 404);
  const job = ic.joinWithCode(entry.code, { name: 'Kim', importers: { mqtt: broker.importer }, noHostMs: 400, iterations: 1000 });
  await assert.rejects(job.promise, (e) => ['no-host', 'expired'].includes(e.code));
});

test('a friend invite reaches only that friend: others can’t see or accept it, and a stranger can’t be invited', async () => {
  const noor = fake.addUser({ handle: 'noor_exe', display_name: 'Noor' });
  const manifest = (await host.get(`/api/runs/${RUN}`)).body;
  const [entry] = await fi.inviteFriends(manifest, [kimCard()], { importers: { mqtt: broker.importer } });
  const third = await startApp('third');
  await third.signIn(noor);
  assert.ok(!(await third.get('/api/account/invites')).body.incoming.some((i) => i.id === entry.id));
  assert.equal((await third.post(`/api/account/invites/${entry.id}/accept`)).status, 404, 'not a recipient: indistinguishable from nothing');
  await assert.rejects(fi.inviteFriends(manifest, [{ id: noor.id, name: 'Noor' }], { importers: { mqtt: broker.importer } }), (e) => e.vars?.code === 'not_friends' || /friends/i.test(e.message));
  await fi.cancelInvite(entry.id);
  third.child.kill();
});

test('ask to join: only for a run the friend opened for it; the owner lets them in with a fresh invite', async () => {
  // the friend (Kim) is in a run without "ask to join" → Robin can't ask
  await guest.put('/api/account/presence', { state: 'in_run', game: { title: 'Emerald', system: 'gba' }, run: { name: 'Kim & Lou', mode: 'soullink', freeSlot: true, joinable: false } });
  await until(() => fake.presence.get(kim.id)?.state === 'in_run');
  assert.equal((await host.post('/api/account/join-requests', { to: kim.id })).body.vars.code, 'conflict');
  // the host (Robin) opens his run for it; Kim asks
  await host.put('/api/account/presence', { state: 'in_run', game: { title: 'Emerald', system: 'gba' }, run: { name: 'Emerald with Kim', mode: 'soullink', freeSlot: true, joinable: true } });
  await until(() => fake.presence.get(robin.id)?.run?.joinable === true, 15000);
  const jr = (await guest.post('/api/account/join-requests', { to: robin.id })).body;
  assert.match(jr.id, /^jr_/);
  const incoming = await until(async () => (await host.get('/api/account/invites')).body.joinIncoming.find((j) => j.id === jr.id));
  assert.equal(incoming.from.handle, 'kimchi');
  const manifest = (await host.get(`/api/runs/${RUN}`)).body;
  const entry = await fi.letIn(incoming, manifest, { gameTitle: 'Emerald', importers: { mqtt: broker.importer } });
  const inv = await until(async () => (await guest.get('/api/account/invites')).body.incoming.find((i) => i.id === entry.id));
  const code = (await guest.post(`/api/account/invites/${inv.id}/accept`)).body.code;
  assert.equal(code, entry.code);
  const job = ic.joinWithCode(code, { name: 'Kim', importers: { mqtt: broker.importer } });
  await until(() => entry.state?.phase === 'request');
  await fi.allowFriend(entry.id);
  assert.equal((await job.promise).id, RUN);
});

test('the browser hand-off of a second app goes to that app’s own loopback only', async () => {
  // signed in, a second sign-in is refused (it would replace the session without ending it) – sign out first
  assert.equal((await guest.post('/api/account/login')).status, 409);
  await guest.post('/api/account/logout');
  const { body } = await guest.post('/api/account/login');
  const redirect = new URL(body.url).searchParams.get('redirect_uri');
  assert.equal(redirect, `${guest.base}/auth/done`);
  // a code meant for the guest, delivered to the host's loopback: the host has no such sign-in waiting
  fake.nextLogin = kim.id;
  const r = await fetch(body.url, { redirect: 'manual' });
  const loop = new URL(r.headers.get('location'));
  const wrong = await rawGet(`${host.base}/auth/done${loop.search}`, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  assert.match(wrong.headers.location, /^\/auth\/done\?r=none&n=/);
  await guest.post('/api/account/login/cancel');
});
