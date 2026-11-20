// Regression tests for the independent security review of the souldew 3.0 accounts / souldew+ integration (commit
// d39a98f): each test is one of the review's exploit scripts, asserting the FIXED behaviour. #2 (pack code in the
// renderer) needs Chromium – test/cosmetics-sandbox.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { EDITION } from '../shared/edition.mjs';

process.env.SLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'souldew-secrev-'));
const { startFakeAccounts, rawGet } = await import('./fixtures/fakeaccounts.mjs');
const fake = await startFakeAccounts();
process.env.SLS_ACCOUNTS_URL = fake.base;
process.env.SLS_ACCOUNTS_DEV_ENT_KEY = fake.ent.publicKey;
const { startServer, withoutDevSwitches } = await import('../server/app.mjs');
const { createAccounts } = await import('../server/lib/accounts/index.mjs');
const { createPlusPack } = await import('../server/lib/pluspack.mjs');
const { RENDERER_COOKIE } = await import('../server/lib/guard.mjs');

const keychain = { available: () => true, encrypt: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)), decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString() };
const H = { 'x-soullink': '1', 'content-type': 'application/json' };
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' };
const SECRET = 'r'.repeat(43);
const servers = [];
after(() => {
  for (const s of servers) s.close();
  fake.close?.();
});
const quiet = async (fn) => {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

async function start(opts = {}) {
  const s = await startServer({ port: 0, background: false, secureStore: keychain, ...opts });
  servers.push(s.server);
  const base = `http://127.0.0.1:${s.port}`;
  const call = async (method, p, body, headers = H) => {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: text };
    }
  };
  return { ...s, base, call };
}

test('#1 another local program: the account and souldew+ routes need the app window’s secret; no sign-in on top; no URL handed out', async () => {
  const victim = fake.addUser({ handle: 'victim1', display_name: 'Victim', entitlement: { tier: 'plus', until: null, badges: ['plus'] } });
  let opened = null;
  const app = await start({ rendererSecret: SECRET, openExternal: (u) => { opened = u; } });
  const win = { ...H, cookie: `${RENDERER_COOKIE}=${SECRET}` }; // the app window (electron/main.mjs sets the cookie)
  // the app window signs in: the system browser gets the address, the caller doesn't
  const l = await app.call('POST', '/api/account/login', {}, win);
  assert.equal(l.status, 200);
  assert.deepEqual(l.body, { opened: true }, 'the sign-in address (its state) is never handed to the caller');
  fake.nextLogin = victim.id;
  assert.equal((await fake.browse(opened)).done, '/auth/done?r=ok');
  assert.equal((await app.call('GET', '/api/account', undefined, win)).body.me.handle, 'victim1');
  // "another program": the static app header, no secret – or a wrong one
  for (const headers of [H, { ...H, cookie: `${RENDERER_COOKIE}=${'x'.repeat(43)}` }, { ...H, cookie: `${RENDERER_COOKIE}=` }]) {
    for (const [m, p, b] of [['GET', '/api/account/entitlements'], ['GET', '/api/account/export'], ['GET', '/api/account'], ['DELETE', '/api/account', { confirm: 'victim1' }],
      ['POST', '/api/account/login', {}], ['POST', '/api/account/logout', {}], ['GET', '/api/plus/pack/meta'], ['POST', '/api/plus/pack/fetch', {}], ['DELETE', '/api/plus/pack']]) {
      const r = await app.call(m, p, b, headers);
      assert.equal(r.status, 403, `${m} ${p}`);
    }
  }
  assert.ok(fake.users.has(victim.id), 'the account still exists');
  // the rest of the app's API is unchanged for the app's own pages (the OBS overlay, the browser build)
  assert.equal((await app.call('GET', '/api/status')).status, 200);
  // the window itself: a second sign-in on top of this one is refused (it would replace the session without ending it)
  const again = await quiet(() => app.call('POST', '/api/account/login', {}, win));
  assert.deepEqual([again.status, again.body.vars?.code], [409, 'signed_in']);
  // deleting needs the window's secret AND the typed handle
  assert.equal((await quiet(() => app.call('DELETE', '/api/account', { confirm: 'someone' }, win))).status, 400);
  assert.equal((await app.call('DELETE', '/api/account', { confirm: 'victim1' }, win)).status, 200);
});

test('#2 (env) an installed app ignores SLS_ACCOUNTS_URL / dev packs / dev keys; a session never goes to another service', async () => {
  assert.deepEqual(Object.keys(withoutDevSwitches({ SLS_ACCOUNTS_URL: 'x', SLS_PLUS_DEV_PACK: 'x', SLS_PLUS_DEV_KEY: 'x', SLS_ACCOUNTS_DEV_ENT_KEY: 'x', HOME: '/h' })), ['HOME']);
  const user = fake.addUser({ handle: 'traveller' });
  const a = await start();
  await a.call('POST', '/api/account/logout', {});
  const l = await a.call('POST', '/api/account/login', {});
  fake.nextLogin = user.id;
  await fake.browse(l.body.url);
  assert.equal((await a.call('GET', '/api/account')).body.session.signedIn, true);
  // an "evil" service records what it is sent; the app starts again pointed at it
  const got = [];
  const evil = createServer((req, res) => {
    got.push(req.url);
    res.writeHead(500).end('{}');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  servers.push(evil);
  const before = process.env.SLS_ACCOUNTS_URL;
  process.env.SLS_ACCOUNTS_URL = `http://127.0.0.1:${evil.address().port}`;
  const dev = mkdtempSync(join(tmpdir(), 'souldew-devpack-'));
  writeFileSync(join(dev, 'access.json'), JSON.stringify({ publicKey: 'A'.repeat(43) }));
  process.env.SLS_PLUS_DEV_PACK = dev;
  try {
    // development: the stored session belongs to the other service → dropped, nothing sent anywhere
    const b = await start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await b.call('GET', '/api/account')).body.session.signedIn, false, 'a session kept for another service is dropped');
    assert.deepEqual(got, [], 'not a single request (no refresh token) to the other address');
    // packaged: the switches are gone – the production service, no dev pack, no dev key
    const c = await start({ packaged: true });
    assert.equal((await c.call('GET', '/api/status')).body.plusDev, false);
    assert.equal((await quiet(() => c.call('GET', '/api/plus/dev/key'))).status, 404);
    // (souldew Renaissance: no account at all – no service, not even the official one)
    assert.equal((await c.call('GET', '/api/account')).body.service, EDITION.accounts ? 'accounts.souldew.app' : '');
  } finally {
    process.env.SLS_ACCOUNTS_URL = before;
    delete process.env.SLS_PLUS_DEV_PACK;
  }
});

test('#4 entitlement: only a verified token counts; offline its grace_until, never a clock set back', async () => {
  const DAY = 86400000;
  let clock = Date.now();
  const acc = createAccounts({ secure: null, port: () => 47111, env: { SLS_ACCOUNTS_URL: fake.base, SLS_ACCOUNTS_DEV_ENT_KEY: fake.ent.publicKey }, now: () => clock, packaged: false });
  const u = fake.addUser({ handle: 'member4', entitlement: { tier: 'plus', until: null, badges: ['plus'] } });
  const { url } = acc.session.startLogin();
  fake.nextLogin = u.id;
  const loc = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  assert.deepEqual(await acc.session.finishLogin({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state') }), { ok: true });
  const route = (m, p) => acc.routes.find((r) => r.method === m && r.pattern.test(p));
  const ent = () => quiet(() => route('GET', '/api/account/entitlements').handler({}, [], null)).then((e) => ({ tier: e.tier, key: !!e.packKey, offline: !!e.offline, verified: e.verified, token: e.token }), (e) => ({ error: e.code }));
  assert.deepEqual(await ent(), { tier: 'plus', key: true, offline: false, verified: true, token: undefined });
  // the JSON says patron, the signed token says none: the token wins
  fake.entClaims = { tier: 'none', badges: [] };
  assert.deepEqual(await ent(), { tier: 'none', key: false, offline: false, verified: true, token: undefined });
  // a token for another account / session, or signed with another key: not verified → nothing
  fake.entClaims = { sub: 'u_someoneelse' };
  assert.deepEqual(await ent(), { tier: 'none', key: false, offline: false, verified: false, token: undefined });
  fake.entClaims = { sid: 'ses_other' };
  assert.equal((await ent()).verified, false);
  fake.entClaims = null;
  assert.deepEqual(await ent(), { tier: 'plus', key: true, offline: false, verified: true, token: undefined });
  // the membership ends and the player cuts the service off
  fake.offlinePaths.add('/v1/entitlements');
  fake.offlinePaths.add('/auth/token');
  try {
    clock += 6 * DAY;
    assert.deepEqual(await ent(), { tier: 'plus', key: true, offline: true, verified: true, token: undefined }, 'day 6: inside the token’s grace');
    clock += 30 * DAY;
    assert.deepEqual(await ent(), { error: 'acctOffline' }, 'day 36: the grace is over');
    clock -= 400 * DAY;
    assert.deepEqual(await ent(), { error: 'acctOffline' }, 'a clock set back a year revives nothing');
  } finally {
    fake.offlinePaths.delete('/v1/entitlements');
    fake.offlinePaths.delete('/auth/token');
  }
  // a fresh token, then the clock goes back a little (inside the window): behind the latest time seen → expired
  clock = Date.now();
  assert.equal((await ent()).tier, 'plus');
  fake.offlinePaths.add('/v1/entitlements');
  try {
    clock += 3 * DAY;
    assert.equal((await ent()).offline, true);
    clock -= 2 * DAY;
    assert.deepEqual(await ent(), { error: 'acctOffline' }, 'the clock went back behind a time already seen');
  } finally {
    fake.offlinePaths.delete('/v1/entitlements');
  }
  acc.close();
});

test('#5 a web page can neither cancel a pending sign-in nor show “You’re signed in”', async () => {
  const user = fake.addUser({ handle: 'patient' });
  const a = await start();
  await a.call('POST', '/api/account/logout', {});
  const l = await a.call('POST', '/api/account/login', {});
  for (let i = 0; i < 25; i++) assert.equal((await rawGet(`${a.base}/auth/done?state=x${i}`, NAV)).status, 303);
  assert.equal((await a.call('GET', '/api/account')).body.session.pending, true, 'still waiting for the real browser');
  fake.nextLogin = user.id;
  const b = await fake.browse(l.body.url);
  assert.equal(b.done, '/auth/done?r=ok', 'the real hand-off still works');
  const spoof = await rawGet(`${a.base}/auth/done?r=ok`, NAV);
  assert.equal(spoof.status, 400);
  assert.ok(!/signed in/i.test(spoof.body), 'no "signed in" page without the loopback’s one-time nonce');
});

test('#6 "appear offline" stays offline when /v1/me can’t be read after a restart', async () => {
  const u = fake.addUser({ handle: 'shy', privacy: { presence: 'offline' } });
  let a = await start();
  await a.call('POST', '/api/account/logout', {});
  const l = await a.call('POST', '/api/account/login', {});
  fake.nextLogin = u.id;
  await fake.browse(l.body.url);
  await a.call('GET', '/api/account');
  await new Promise((r) => a.server.close(r));
  fake.offlinePaths.add('/v1/me');
  try {
    a = await start();
    const mark = fake.log.length;
    await a.call('PUT', '/api/account/presence', { state: 'in_run', game: { title: 'Emerald', system: 'gba' }, run: { name: 'Secret run with Tom', mode: 'soullink' } });
    await new Promise((r) => setTimeout(r, 1200));
    assert.deepEqual(fake.log.slice(mark).filter((x) => x.path === '/v1/presence' && x.method === 'PUT'), [], 'nothing about the game went out');
  } finally {
    fake.offlinePaths.delete('/v1/me');
  }
  // unknown privacy (nothing kept, profile unreadable) counts as hidden too
  const fresh = fake.addUser({ handle: 'unknownpriv' });
  const acc = createAccounts({ secure: null, port: () => 47112, env: { SLS_ACCOUNTS_URL: fake.base }, packaged: false });
  const { url } = acc.session.startLogin();
  fake.nextLogin = fresh.id;
  const loc = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await acc.session.finishLogin({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state') });
  fake.offlinePaths.add('/v1/me');
  try {
    const mark = fake.log.length;
    acc.setReport({ state: 'playing', game: { title: 'Emerald', system: 'gba' } });
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(fake.log.slice(mark).filter((x) => x.path === '/v1/presence' && x.method === 'PUT'), []);
  } finally {
    fake.offlinePaths.delete('/v1/me');
    acc.close();
  }
});

test('#7 signed out, not even the public catalog is fetched – the app’s own palette instead', async () => {
  const a = await start();
  await a.call('POST', '/api/account/logout', {});
  const mark = fake.log.length;
  const cat = await a.call('GET', '/api/account/catalog');
  assert.equal(cat.status, 200);
  assert.equal(cat.body.local, true);
  assert.ok(cat.body.accents.length > 5);
  assert.deepEqual(cat.body.cosmetics, []);
  assert.equal(fake.log.length, mark, 'no request to the accounts service');
});

test('#8 an unsigned pack is never downloaded or stored; pack URLs only on the accounts service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  let fetched = 0;
  const manifest = Buffer.from(JSON.stringify({ id: 'evil-pack', version: '1.0.0', files: [{ path: 'x.css', sha256: 'a'.repeat(64) }] })).toString('base64url');
  const pack = createPlusPack({ dir, devDir: '', env: { SLS_ACCOUNTS_URL: fake.base }, fetchImpl: async () => { fetched++; return new Response(Buffer.concat([Buffer.from('SDP1'), Buffer.alloc(4096, 0x41)])); } });
  await assert.rejects(pack.fetch({ packId: 'evil-pack', version: '1.0.0', keyId: '1', manifest, signature: 'A'.repeat(86), files: [{ path: 'x.css', url: `${fake.base}/whatever` }] }), { code: 'plusSignature' });
  assert.equal(fetched, 0);
  assert.ok(!existsSync(join(dir, 'files')) || readdirSync(join(dir, 'files')).length === 0);
  assert.ok(!existsSync(join(dir, 'pack.json')));
  const prod = createPlusPack({ dir: mkdtempSync(join(tmpdir(), 'souldew-plus-')), devDir: '', env: {} });
  await assert.rejects(prod.fetchOne({ url: 'https://cdn.souldew.app/x' }), { code: 'plusUrl' }, 'another souldew.app host');
});

test('#9 the release gate: a packaged build stops while a pinned souldew+ key is a placeholder', async () => {
  const { pinnedKeyProblems } = await import('../scripts/check-pinned-keys.mjs');
  assert.deepEqual(pinnedKeyProblems(), [], 'the owner’s pack and entitlement keys are pinned');
  const real = 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik';
  assert.deepEqual(pinnedKeyProblems({ pack: [real], entitlement: [real] }), []);
  assert.equal(pinnedKeyProblems({ pack: ['REPLACE_WITH_PRODUCTION_PACK_PUBLIC_KEY'], entitlement: [real] }).length, 1, 'a placeholder fails');
  assert.equal(pinnedKeyProblems({ pack: [], entitlement: [real] }).length, 1, 'an empty list fails too');
});
