// souldew 3.0 account gaps: offline at once when the app quits (bounded), "Unlink membership" (pack cache wiped, the
// verified tier gone), the session list with "sign out this device", the own badges from the verified token only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

process.env.SLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'souldew-gaps-'));
const { startFakeAccounts } = await import('./fixtures/fakeaccounts.mjs');
const fake = await startFakeAccounts();
process.env.SLS_ACCOUNTS_URL = fake.base;
process.env.SLS_ACCOUNTS_DEV_ENT_KEY = fake.ent.publicKey;
const { startServer } = await import('../server/app.mjs');
const { createAccounts, cleanSession } = await import('../server/lib/accounts/index.mjs');

const H = { 'x-soullink': '1', 'content-type': 'application/json' };
const servers = [];
after(() => {
  for (const s of servers) s.close();
  fake.close?.();
});

async function start() {
  const s = await startServer({ port: 0, background: false });
  servers.push(s.server);
  const base = `http://127.0.0.1:${s.port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: text };
    }
  };
  const signIn = async (user) => {
    await call('POST', '/api/account/logout', {});
    const l = await call('POST', '/api/account/login', {});
    fake.nextLogin = user.id;
    assert.equal((await fake.browse(l.body.url)).done, '/auth/done?r=ok');
  };
  return { ...s, base, call, signIn };
}

test('quitting: "offline" goes out at once (no 180 s of a ghost online), and it never holds the app up', async () => {
  const u = fake.addUser({ handle: 'quitter' });
  const a = await start();
  await a.signIn(u);
  await a.call('GET', '/api/account');
  await a.call('PUT', '/api/account/presence', { state: 'library' });
  const until = Date.now() + 3000;
  while (!fake.presence.has(u.id) && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
  assert.ok(fake.presence.has(u.id), 'online');
  const t0 = Date.now();
  assert.equal(await a.goOffline(), true, 'the service confirmed it');
  assert.ok(!fake.presence.has(u.id), 'gone for friends right away');
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(await a.goOffline(), false, 'nothing to say twice');

  // a service that never answers: bounded by the timeout
  const hang = createServer(() => {}); // accepts, never answers
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  servers.push(hang);
  const acc = createAccounts({ secure: null, port: () => 47113, env: { SLS_ACCOUNTS_URL: fake.base, SLS_ACCOUNTS_DEV_ENT_KEY: fake.ent.publicKey }, packaged: false,
    fetchImpl: (url, opts) => (opts?.method === 'DELETE' ? fetch(`http://127.0.0.1:${hang.address().port}/v1/presence`, opts) : fetch(url, opts)) });
  const v = fake.addUser({ handle: 'slowquit', privacy: { presence: 'friends' } });
  const { url } = acc.session.startLogin();
  fake.nextLogin = v.id;
  const loc = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await acc.session.finishLogin({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state') });
  acc.setReport({ state: 'library' });
  const until2 = Date.now() + 3000;
  while (!fake.presence.has(v.id) && Date.now() < until2) await new Promise((r) => setTimeout(r, 30));
  const t1 = Date.now();
  assert.equal(await acc.goOffline(300), false, 'no answer → given up');
  assert.ok(Date.now() - t1 < 1000, `bounded (${Date.now() - t1} ms)`);
  acc.close();
});

test('unlink membership: the service unlinks, the pack cache goes at once, the verified tier and badges are gone', async () => {
  const u = fake.addUser({ handle: 'unlinker', entitlement: { tier: 'patron', until: null, badges: ['plus', 'patron'] } });
  const a = await start();
  await a.signIn(u);
  const me = (await a.call('GET', '/api/account')).body.me;
  assert.deepEqual([me.entitlement.tier, me.badges], ['patron', ['plus', 'patron']], 'the own badges: from the verified token');
  const ent = (await a.call('GET', '/api/account/entitlements')).body;
  assert.equal(ent.verified, true);
  // a cached (encrypted) pack on disk
  const dir = join(process.env.SLS_DATA_DIR, 'plus');
  mkdirSync(join(dir, 'files'), { recursive: true });
  writeFileSync(join(dir, 'files', `${'a'.repeat(64)}.sdp`), 'SDP1');
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ packId: 'p', version: '1.0.0', keyId: ent.packKeyId, files: { 'a.css': { file: `${'a'.repeat(64)}.sdp` } }, lastOnline: new Date().toISOString() }));
  const r = await a.call('DELETE', '/api/account/link');
  assert.deepEqual(r.body, { ok: true, tier: 'none' });
  assert.ok(!existsSync(join(dir, 'pack.json')) && !existsSync(join(dir, 'files')), 'the encrypted cache is wiped');
  const after2 = (await a.call('GET', '/api/account')).body.me;
  assert.deepEqual([after2.entitlement.tier, after2.badges], ['none', []]);
  const ent2 = (await a.call('GET', '/api/account/entitlements')).body;
  assert.deepEqual([ent2.tier, ent2.packKey, ent2.packKeyId !== ent.packKeyId], ['none', null, true], 'pack key rotated');
});

test('the own badges never come from the profile JSON: an unverifiable token shows none', async () => {
  const u = fake.addUser({ handle: 'pretender', entitlement: { tier: 'plus', until: null, badges: ['plus'] } });
  const a = await start();
  fake.entClaims = { aud: 'souldew-app' }; // a token the app can't accept (from the first look on)
  try {
    await a.signIn(u);
    const { warn } = console;
    console.warn = () => {};
    const me = (await a.call('GET', '/api/account')).body.me;
    console.warn = warn;
    assert.deepEqual([me.entitlement.tier, me.badges], ['none', []], '/v1/me says plus – unverified, so not shown');
    const ent = (await a.call('GET', '/api/account/entitlements')).body;
    assert.deepEqual([ent.tier, ent.packKey, ent.verified, ent.unverified], ['none', null, false, 'aud']);
  } finally {
    fake.entClaims = null;
  }
});

test('sessions: the list marks this computer; another device is signed out; this one is an ordinary sign-out', async () => {
  const u = fake.addUser({ handle: 'traveller2' });
  const a = await start();
  const b = await start(); // a second "device" (its own data folder is the same here – the session lives in memory per server)
  await a.signIn(u);
  const list = (await a.call('GET', '/api/account/sessions')).body.items;
  assert.equal(list.filter((x) => x.current).length, 1);
  assert.match(list[0].id, /^ses_/);
  assert.equal(list.find((x) => x.current).platform, { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform] || null);
  // another session of the same account (a second sign-in elsewhere)
  const l = await b.call('POST', '/api/account/login', {});
  fake.nextLogin = u.id;
  await fake.browse(l.body.url);
  const both = (await a.call('GET', '/api/account/sessions')).body.items;
  assert.equal(both.length, 2);
  const otherId = both.find((x) => !x.current).id;
  assert.deepEqual((await a.call('DELETE', `/api/account/sessions/${otherId}`)).body, { ok: true });
  assert.equal((await a.call('GET', '/api/account/sessions')).body.items.length, 1);
  assert.equal((await b.call('GET', '/api/account/friends')).status, 401, 'the other device is signed out');
  const mine = both.find((x) => x.current).id;
  const out = (await a.call('DELETE', `/api/account/sessions/${mine}`)).body;
  assert.equal(out.current, true);
  assert.equal((await a.call('GET', '/api/account')).body.session.signedIn, false);
  // cleaning
  assert.equal(cleanSession({ id: 'nope' }), null);
  assert.deepEqual(cleanSession({ id: 'ses_abc', device_name: 'souldew on a Mac<script>', platform: 'amiga', created_at: 'x', current: false }, 'ses_abc'),
    { id: 'ses_abc', device: 'souldew on a Mac<script>'.slice(0, 40), platform: null, createdAt: null, lastUsedAt: null, current: true });
});
