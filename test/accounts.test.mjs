// The souldew account in the app (server/lib/accounts, shared/social.mjs) against a fake of the accounts service
// (test/fixtures/fakeaccounts.mjs – souldew-accounts docs/API.md, never the real one): sign-in with PKCE and the
// loopback hand-off incl. state / verifier mismatches and the loopback's hardening, token storage, refresh rotation,
// revoked and offline sessions, sign-out, the profile round trip, friends, presence visibility, export / delete – and
// that nothing changes (and nothing is sent) while signed out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATA = mkdtempSync(join(tmpdir(), 'souldew-acct-'));
process.env.SLS_DATA_DIR = DATA;
const { startFakeAccounts, rawGet } = await import('./fixtures/fakeaccounts.mjs');
const fake = await startFakeAccounts();
process.env.SLS_ACCOUNTS_URL = fake.base;
process.env.SLS_ACCOUNTS_DEV_ENT_KEY = fake.ent.publicKey; // the fake's entitlement key (server/lib/accounts/enttoken.mjs)

const social = await import('../shared/social.mjs');
const clean = await import('../server/lib/accounts/clean.mjs');
const { createSession, pkceChallenge, sameSecret } = await import('../server/lib/accounts/session.mjs');
const { createTokenStore } = await import('../server/lib/accounts/store.mjs');
const { accountsBase, ACCOUNTS_URL } = await import('../server/lib/accounts/contract.mjs');
const { mePatch, imageType } = await import('../server/lib/accounts/index.mjs');
const { statsFrom, shortGameTitle } = await import('../server/lib/accounts/stats.mjs');
const { startServer } = await import('../server/app.mjs');
const { privateRequestError } = await import('../server/lib/guard.mjs');

const robin = fake.addUser({ handle: 'robin', display_name: 'Robin' });
const kim = fake.addUser({ handle: 'kimchi', display_name: 'Kim' });
const noor = fake.addUser({ handle: 'noor_exe', display_name: 'Noor' });
fake.befriend(robin.id, kim.id);

/** A fake keychain: "encrypts" by XOR (the point is only that the file never holds the plain text). */
const keychain = { available: () => true, encrypt: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)), decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString() };

const servers = [];
async function app(opts = {}) {
  const { server, port } = await startServer({ port: 0, background: false, ...opts });
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  const H = { 'x-soullink': '1', 'content-type': 'application/json' };
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, body: data, text };
  };
  const a = {
    base, port, server,
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p, b) => call('DELETE', p, b),
    /** The whole sign-in as a player does it: button → system browser → Discord (skipped) → back to the app. */
    async signIn(user) {
      const { body } = await a.post('/api/account/login');
      fake.nextLogin = user.id;
      const b = await fake.browse(body.url);
      return { ...b, url: body.url };
    },
  };
  return a;
}
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};
const quiet = async (fn) => {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
};

after(async () => {
  for (const s of servers) s.close();
  await fake.close();
  rmSync(DATA, { recursive: true, force: true });
});

// ---- pure parts ----------------------------------------------------------------------------------------------------

test('shared/social: avatar sources, handles, friend codes, plain text', () => {
  const svc = 'https://accounts.souldew.app';
  assert.equal(social.safeAvatarUrl(`${svc}/v1/avatars/u_abcdefghijABCDEFGHIJ12/a1b2c3d4.png?size=128`, svc), `${svc}/v1/avatars/u_abcdefghijABCDEFGHIJ12/a1b2c3d4.png?size=128`);
  assert.equal(social.safeAvatarUrl('https://cdn.discordapp.com/avatars/80351110224678912/0123456789abcdef0123456789abcdef.png?size=64'),
    'https://cdn.discordapp.com/avatars/80351110224678912/0123456789abcdef0123456789abcdef.png?size=64');
  assert.ok(social.safeAvatarUrl('https://cdn.discordapp.com/embed/avatars/3.png'));
  for (const bad of [
    'https://evil.example/v1/avatars/u_abcdefghij/aa.png', 'http://cdn.discordapp.com/avatars/1234567/0123456789abcdef0123456789abcdef.png',
    'https://cdn.discordapp.com:8443/avatars/80351110224678912/0123456789abcdef0123456789abcdef.png', 'https://user:pw@cdn.discordapp.com/embed/avatars/1.png',
    'https://cdn.discordapp.com/attachments/1/2/x.png', 'https://cdn.discordapp.com/avatars/80351110224678912/../../x.png', 'javascript:alert(1)',
    'data:image/png;base64,AAAA', 'https://cdn.discordapp.com.evil.example/embed/avatars/1.png', `${svc}/v1/avatars/u_abcdefghij/aa.png?size=128&x=1`,
    `${svc}/v1/me`, 'https://cdn.discordapp.com/embed/avatars/1.png?size=13', null, 42,
  ]) assert.equal(social.safeAvatarUrl(bad, svc), null, String(bad));
  assert.equal(social.normalizeHandle('@Ash_K'), 'ash_k');
  assert.equal(social.normalizeHandle('ab'), null);
  assert.equal(social.normalizeHandle('robin.dew'), null);
  assert.equal(social.normalizeFriendCode('sd-7k2q-m9xd'), 'SD-7K2Q-M9XD');
  assert.equal(social.normalizeFriendCode('7K2Q M9XD'), 'SD-7K2Q-M9XD');
  assert.equal(social.normalizeFriendCode('SD-7K2Q-M9X'), null);
  assert.deepEqual(social.parseFriendQuery('SD-7K2Q-M9XD'), { friend_code: 'SD-7K2Q-M9XD' });
  assert.deepEqual(social.parseFriendQuery('@kimchi'), { handle: 'kimchi' });
  assert.deepEqual(social.parseFriendQuery('abcd1234'), { handle: 'abcd1234' }, 'eight characters without a dash read as a handle first');
  assert.equal(social.parseFriendQuery('<img src=x>'), null);
  assert.equal(social.cleanText('a‮b​c\n d\u0007', 80), 'abc d');
  assert.equal(social.cleanText('x'.repeat(100), 60).length, 60);
  assert.equal(social.cleanText({ toString: () => 'x' }), '');
  assert.equal(social.safeHex('#5F8A4E'), '#5f8a4e');
  for (const bad of ['red', '#fff', '#5f8a4e;background:url(x)', 'var(--x)', '#5f8a4e00']) assert.equal(social.safeHex(bad), null, bad);
  assert.equal(social.presenceSystem('gbc'), 'gb');
  assert.equal(social.withoutFileNames('Robin – Emerald.gba'), 'Robin');
  assert.equal(social.withoutFileNames('Kim & Lou /Users/kim/roms/hg.nds'), 'Kim & Lou');
  assert.equal(social.withoutFileNames('Emerald with Tom'), 'Emerald with Tom');
});

test('clean: answers become plain shapes – unknown fields, bad avatars, raw colours and odd enums are dropped', () => {
  const svc = 'https://accounts.souldew.app';
  const card = clean.cleanCard({ id: 'u_abc', handle: 'Ash_K', display_name: '<img src=x onerror=alert(1)>‮', avatar_url: 'https://evil.example/a.png', frame: 'brass ring', accent: 'moss', badges: ['plus', 'admin'], secret: 1 }, svc);
  assert.deepEqual(card, { id: 'u_abc', handle: 'ash_k', name: '<img src=x onerror=alert(1)>', avatar: null, frame: null, nameplate: null, accent: 'moss', title: null, badges: ['plus'] });
  assert.equal(clean.cleanCard({ id: '../../v1/me' }, svc), null, 'an id that would leave its path segment');
  const me = clean.cleanMe({ id: 'u_abc', handle: 'ash_k', display_name: 'Ash', avatar_url: `${svc}/v1/avatars/u_abcdefghijABCD/abc123.png?size=128`,
    discord: { id: '80351110224678912', username: 'ash' }, friend_code: 'SD-7K2Q-M9XD', privacy: { profile: 'everyone', presence: 'offline', show_runs: 'yes' },
    entitlement: { tier: 'god', badges: ['plus'] }, stats: { totals: { runs_started: 3, deaths: -1 }, recent_runs: [{ name: 'A', mode: 'x', result: 'won', badges: 99 }] } }, svc);
  assert.equal(me.avatar, `/api/account/avatar?src=${encodeURIComponent(`${svc}/v1/avatars/u_abcdefghijABCD/abc123.png?size=128`)}`);
  assert.ok(!JSON.stringify(me).includes('80351110224678912'), 'the Discord id stays on the server side');
  assert.deepEqual(me.privacy, { profile: 'friends', presence: 'offline', showLocation: false, showRuns: false, friendRequests: 'everyone', showOnThanks: null });
  assert.equal(me.entitlement.tier, 'none');
  assert.equal(me.stats.totals.runsStarted, 3);
  assert.equal(me.stats.totals.deaths, null);
  assert.deepEqual(me.stats.recentRuns[0], { name: 'A', game: '', mode: 'soullink', result: 'won', badges: null, deaths: null, endedAt: null });
  const cat = clean.cleanCatalog({ cosmetics: [{ kind: 'banner', id: 'night-train', tier: 'plus' }, { kind: 'skin', id: 'x' }], accents: [{ key: 'moss', hex: '#5f8a4e' }, { key: 'evil', hex: 'red;}' }] });
  assert.deepEqual(cat, { cosmetics: [{ kind: 'banner', id: 'night-train', tier: 'plus' }], accents: [{ key: 'moss', hex: '#5f8a4e' }] });
  const inv = clean.cleanInvite({ id: 'inv_x', from: { id: 'u_a', handle: 'robin' }, run: { name: 'R', game: 'Emerald', mode: 'soullink', system: 'gba', room: 'secret' }, invite_code: 'Fabc', status: 'weird' }, svc);
  assert.deepEqual(inv.run, { name: 'R', game: 'Emerald', mode: 'soullink', system: 'gba' });
  assert.equal(inv.status, 'pending');
  assert.equal(inv.code, 'Fabc');
  assert.equal(clean.cleanPresence({ user_id: 'u_a', state: 'offline', game: { title: 'x' }, location: 'Route 1' }).location, undefined, 'away friends carry nothing');
  assert.deepEqual(mePatch({ name: 'R', accent: 'url(x)', status: 'hi‮', privacy: { profile: 'link', showRuns: true, admin: true }, hack: 1 }),
    { display_name: 'R', status: 'hi', privacy: { profile: 'link', show_runs: true } });
  assert.throws(() => mePatch({ hack: 1 }), /Nothing to change/);
  assert.equal(imageType(Buffer.from('<svg onload=alert(1)>          ')), null);
  assert.equal(shortGameTitle('Pokémon Yellow Version: Special Pikachu Edition'), 'Yellow');
  // whatever follows "Version" stays: the sequels are not their originals
  assert.equal(shortGameTitle('Pokémon Black Version 2'), 'Black 2');
  assert.equal(shortGameTitle('Pokémon White Version 2'), 'White 2');
  assert.equal(shortGameTitle('Pokémon Black Version'), 'Black');
  assert.equal(shortGameTitle('Pokémon Ultra Sun'), 'Ultra Sun');
});

test('the service address: https, or http only on this computer; the default otherwise', () => {
  assert.equal(accountsBase({}), ACCOUNTS_URL);
  assert.equal(accountsBase({ SLS_ACCOUNTS_URL: 'http://127.0.0.1:8788' }), 'http://127.0.0.1:8788');
  assert.equal(accountsBase({ SLS_ACCOUNTS_URL: 'https://staging.example/x/' }), 'https://staging.example/x');
  for (const bad of ['http://evil.example', 'https://u:p@accounts.souldew.app', 'file:///etc/passwd', 'not a url', 'https://a.example/?x=1']) assert.equal(accountsBase({ SLS_ACCOUNTS_URL: bad }), ACCOUNTS_URL, bad);
});

test('opt-in stats: summary numbers only, in the contract’s shape', () => {
  const digests = [
    { id: 'a', name: 'Robin & Kim', mode: 'soullink', gameId: 'pokemon-heartgold', status: { state: 'won', at: Date.parse('2026-10-01') }, badges: 16, catches: [{}, {}, {}], deaths: [{}], createdAt: '2026-09-01' },
    { id: 'b', name: 'Crystal Hardcore', mode: 'nuzlocke', gameId: 'pokemon-crystal', status: { state: 'failed', at: Date.parse('2026-07-01') }, badges: 2, catches: [{}], deaths: [{}, {}], createdAt: '2026-06-01' },
  ];
  const s = statsFrom(digests, () => 90);
  assert.deepEqual(s.totals, { runs_started: 2, runs_completed: 1, runs_failed: 1, soullink_runs: 1, nuzlocke_runs: 1, badges_earned: 18, pokemon_caught: 4, deaths: 3, playtime_minutes: 180 });
  assert.deepEqual(s.recent_runs[0], { name: 'Robin & Kim', game: 'HeartGold', mode: 'soullink', result: 'won', badges: 16, deaths: 1, ended_at: '2026-10-01T00:00:00.000Z' });
  assert.equal(s.recent_runs[1].result, 'lost');
  assert.ok(!JSON.stringify(s).match(/\/Users|\.sav|\.nds|room|secret/i));
});

// ---- the session (in process, against the fake) ----------------------------------------------------------------------

/** Sign in through the session API directly (the loopback part is tested on the real server below). */
async function sessionFor(user, opts = {}) {
  const changes = [];
  const store = opts.store || createTokenStore(null);
  const s = createSession({ store, port: () => 47999, onChange: (x) => changes.push(x), env: process.env, toAccount: (a) => (a ? { id: a.id, handle: a.handle } : null), ...opts });
  const { url } = s.startLogin();
  const u = new URL(url);
  fake.nextLogin = user.id;
  const r = await fetch(url, { redirect: 'manual' });
  const back = new URL(r.headers.get('location'));
  return { s, store, changes, url: u, back, finish: (o = {}) => s.finishLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state'), ...o }) };
}

test('sign-in: PKCE S256, a fresh state, the loopback on 127.0.0.1 – and the code is good once', async () => {
  const { s, url, back, finish } = await sessionFor(robin);
  assert.equal(url.pathname, '/auth/discord/start');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:47999/auth/done');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['code_challenge', 'code_challenge_method', 'redirect_uri', 'state'], 'no verifier, no token in the URL');
  assert.equal(back.origin, 'http://127.0.0.1:47999');
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'RFC 7636 test vector');
  assert.ok(sameSecret('abc', 'abc') && !sameSecret('abc', 'abd') && !sameSecret('abc', 'abcd') && !sameSecret(null, 'x'));
  assert.equal(s.publicState().pending, true);
  const tokenCall = () => fake.log.filter((l) => l.path === '/auth/token').at(-1).body;
  assert.deepEqual(await finish(), { ok: true });
  const body = tokenCall();
  assert.equal(body.grant_type, 'login_code');
  assert.equal(body.redirect_uri, 'http://127.0.0.1:47999/auth/done');
  assert.match(body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.device_name, { darwin: 'souldew on a Mac', win32: 'souldew on Windows', linux: 'souldew on Linux' }[process.platform], 'the kind of computer, never its host name');
  const st = s.publicState();
  assert.equal(st.signedIn, true);
  assert.equal(st.pending, false);
  assert.equal(st.account.handle, 'robin');
  assert.ok(!/access|refresh|token/i.test(JSON.stringify(st)), 'the page’s state has no token');
  assert.deepEqual(await finish(), { ok: false, error: 'none' }, 'the same code again: nothing is waiting any more');
});

test('sign-in: a wrong state is ignored (the real one still works), a wrong verifier burns the code, "Cancel" on Discord', async () => {
  const one = await sessionFor(robin);
  assert.deepEqual(await one.finish({ state: 'x'.repeat(43) }), { ok: false, error: 'mismatch' });
  assert.equal(one.s.publicState().pending, true, 'a forged hand-off must not cancel the real sign-in');
  assert.deepEqual(await one.finish(), { ok: true });

  // somebody else's code + our state (or our code replayed with another verifier): the service refuses, and burns it
  const two = await sessionFor(kim);
  const three = await sessionFor(kim);
  assert.deepEqual(await two.s.finishLogin({ code: three.back.searchParams.get('code'), state: two.back.searchParams.get('state') }), { ok: false, error: 'failed' });
  assert.deepEqual(await three.finish(), { ok: false, error: 'failed' }, 'the code was burned by the wrong verifier');
  assert.equal(two.s.signedIn || three.s.signedIn, false);

  fake.denyNext = true;
  const four = await sessionFor(kim);
  assert.equal(four.back.searchParams.get('error'), 'access_denied');
  assert.deepEqual(await four.s.finishLogin({ state: four.back.searchParams.get('state'), error: 'access_denied' }), { ok: false, error: 'denied' });

  const five = await sessionFor(kim, { now: (() => { let n = Date.now(); return () => (n += 8 * 60000); })() });
  assert.deepEqual(await five.finish(), { ok: false, error: 'expired' }, 'a sign-in left open for more than 15 minutes (start + confirmation page)');
  assert.deepEqual(await (await sessionFor(kim)).s.finishLogin({ code: 'short', state: 'nope' }), { ok: false, error: 'mismatch' });
});

test('refresh: rotation on expiry, one refresh at a time, the new token stored before use; reuse ends the whole session', async () => {
  fake.accessTtl = 1; // the access token runs out right away (refreshed 60 s early anyway)
  const { s, store, finish } = await sessionFor(robin);
  await finish();
  const first = (await store.load()).refresh;
  const before = fake.log.filter((l) => l.body?.grant_type === 'refresh_token').length;
  const results = await Promise.all([s.request('/v1/me'), s.request('/v1/friends'), s.request('/v1/pending')]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.equal(fake.log.filter((l) => l.body?.grant_type === 'refresh_token').length - before, 1, 'three calls, one refresh');
  const second = (await store.load()).refresh;
  assert.notEqual(second, first, 'rotated');
  // a stolen copy of the old refresh token is used by somebody else: the service revokes the family
  const stolen = await fetch(`${fake.base}/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: first }) });
  assert.equal(stolen.status, 401);
  assert.equal((await stolen.json()).error.code, 'refresh_reused');
  const r = await s.request('/v1/me');
  assert.equal(r.status, 401);
  assert.equal(s.signedIn, false);
  assert.equal(s.publicState().condition, 'expired', 'the page says why');
  assert.equal(await store.load(), null, 'tokens gone');
  fake.accessTtl = 900;
});

test('revoked elsewhere ("sign out everywhere" on another device): signed out here with a notice', async () => {
  const a = await sessionFor(kim);
  await a.finish();
  const b = await sessionFor(kim);
  await b.finish();
  assert.equal((await b.s.signOut({ everywhere: true })).ok, true);
  const r = await a.s.request('/v1/me');
  assert.equal(r.status, 401);
  assert.equal(a.s.publicState().signedIn, false);
  assert.equal(a.s.publicState().condition, 'expired');
});

test('offline: no answer keeps the session and says so; it comes back by itself', async () => {
  const { s, finish } = await sessionFor(robin);
  await finish();
  fake.offlinePaths.add('/v1/me');
  const r = await s.request('/v1/me');
  assert.equal(r.status, 0);
  assert.equal(s.publicState().signedIn, true);
  assert.equal(s.publicState().condition, 'offline');
  fake.offlinePaths.delete('/v1/me');
  assert.equal((await s.request('/v1/me')).status, 200);
  assert.equal(s.publicState().condition, null);
});

test('token store: only through the keychain, never plain; without one in memory only', async () => {
  const file = join(DATA, 'acct-test.bin');
  const store = createTokenStore(keychain, { file });
  const { finish } = await sessionFor(robin, { store });
  await finish();
  const saved = await store.load(); // (after the write the sign-in queued)
  const raw = readFileSync(file);
  assert.ok(saved.refresh && !raw.includes(Buffer.from(saved.refresh)) && !raw.includes(Buffer.from(saved.access)), 'the file holds no token in plain text');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const mem = createTokenStore({ available: () => false, encrypt: () => { throw new Error('no'); }, decrypt: () => { throw new Error('no'); } }, { file: join(DATA, 'never.bin') });
  assert.equal(mem.persistent(), true, 'not asked yet: the keychain is asked only for something to keep or read');
  assert.equal(await mem.save({ refresh: 'x'.repeat(40) }), false);
  assert.equal(mem.persistent(), false);
  assert.equal(existsSync(join(DATA, 'never.bin')), false, 'no keychain: nothing written');
  assert.equal((await mem.load()).refresh, 'x'.repeat(40));
  const broken = createTokenStore({ available: () => true, encrypt: keychain.encrypt, decrypt: () => { throw new Error('other user'); } }, { file });
  await assert.rejects(broken.load(), { code: 'unreadable' }, 'a blob this keychain can’t open is "signed out" – the session says why (sign in again)');
  assert.equal(existsSync(file), false, '… and it goes, so the keychain isn’t asked again at every start');
});

// ---- the local server: routes, loopback, the page's view -----------------------------------------------------------

test('loopback hand-off on the local server: a real navigation to 127.0.0.1:<port> with our state – nothing else', async () => {
  const a = await app();
  const { body: login } = await a.post('/api/account/login');
  assert.equal(new URL(login.url).searchParams.get('redirect_uri'), `http://127.0.0.1:${a.port}/auth/done`);
  fake.nextLogin = robin.id;
  const r1 = await fetch(login.url, { redirect: 'manual' });
  const loop = new URL(r1.headers.get('location'));
  const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' };
  const url = (q) => `http://127.0.0.1:${a.port}/auth/done?${q}`;
  const q = loop.search.slice(1);
  // turned away before the code is even looked at
  assert.equal((await rawGet(`http://localhost:${a.port}/auth/done?${q}`, nav)).status, 403, 'another host name');
  assert.equal((await rawGet(url(q), { ...nav, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status, 403, 'a page’s fetch()');
  assert.equal((await rawGet(url(q), { ...nav, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })).status, 403, 'an <img>');
  assert.equal((await rawGet(url(q), { ...nav, origin: 'https://evil.example' })).status, 403, 'an Origin header');
  assert.equal((await rawGet(url(`${q}&code=x`), nav)).status, 400, 'a repeated parameter');
  assert.equal((await rawGet(url(`${q}&next=https://evil.example`), nav)).status, 400, 'an extra parameter');
  const post = await fetch(url(q), { method: 'POST', headers: { 'x-soullink': '1' } });
  assert.equal(post.status, 405);
  // our code with a forged state: not used, the sign-in keeps waiting
  const forged = await rawGet(url(`code=${loop.searchParams.get('code')}&state=${'A'.repeat(43)}`), nav);
  assert.equal(forged.status, 303);
  assert.match(forged.headers.location, /^\/auth\/done\?r=mismatch&n=[A-Za-z0-9_-]{24}$/);
  assert.equal((await a.get('/api/account')).body.session.pending, true);
  // the real one
  const ok = await rawGet(loop.href, nav);
  assert.equal(ok.status, 303);
  assert.match(ok.headers.location, /^\/auth\/done\?r=ok&n=[A-Za-z0-9_-]{24}$/, 'the code leaves the address bar');
  assert.equal(ok.headers['cache-control'], 'no-store');
  // a page of its own can't show "You're signed in": without the one-time nonce (or with a used one) it's "bad"
  assert.equal((await rawGet(url('r=ok'), nav)).status, 400);
  assert.equal((await rawGet(url('r=ok&n=AAAAAAAAAAAAAAAAAAAAAAAA'), nav)).status, 400);
  const page = await rawGet(new URL(ok.headers.location, loop).href, nav);
  assert.equal(page.status, 200);
  assert.match(page.body, /You’re signed in/);
  assert.match(page.body, /close this tab/);
  assert.ok(!/<script/i.test(page.body), 'no script on the page');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.ok(!page.body.includes(loop.searchParams.get('code')));
  assert.equal((await rawGet(new URL(ok.headers.location, loop).href, nav)).status, 400, 'the nonce works once');
  // replayed: nothing is waiting any more
  assert.match((await rawGet(loop.href, nav)).headers.location, /^\/auth\/done\?r=none&n=/);
  assert.equal((await rawGet(url('r=<script>'), nav)).status, 400);
  const st = (await a.get('/api/account')).body;
  assert.equal(st.session.signedIn, true);
  assert.equal(st.me.handle, 'robin');
  await a.post('/api/account/logout');
});

test('the page never gets a token; the account API is for the app’s own pages only', async () => {
  const a = await app();
  await a.signIn(robin);
  const st = await a.get('/api/account');
  const tokens = [...fake.access.keys()].slice(-3);
  assert.ok(!tokens.some((t) => st.text.includes(t.split('.')[0])), 'no access token');
  assert.ok(!/refresh_token|access_token|"refresh"|"access"/.test(st.text));
  assert.equal(privateRequestError({ method: 'GET', headers: { 'sec-fetch-site': 'none' } }, '/api/account'), 'App request required');
  assert.equal(privateRequestError({ method: 'GET', headers: { 'sec-fetch-site': 'none' } }, '/api/account/friends'), 'App request required');
  const cross = await fetch(`${a.base}/api/account`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403, 'another website can’t read the account');
  const noHeader = await fetch(`${a.base}/api/account/logout`, { method: 'POST' });
  assert.equal(noHeader.status, 403, 'nor sign the player out');
  // nothing of the session lands in the data folder without a keychain, nor in config.json
  const files = [];
  const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name))));
  walk(DATA);
  for (const f of files) for (const t of tokens) assert.ok(!readFileSync(f, 'utf8').includes(t), `${f} has a token`);
  assert.ok(!existsSync(join(DATA, 'account.bin')));
  await a.post('/api/account/logout');
});

test('a keychain keeps the session over a restart – encrypted', async () => {
  const a = await app({ secureStore: keychain });
  await a.signIn(kim);
  assert.equal((await a.get('/api/account')).body.session.persistent, true);
  const file = join(DATA, 'account.bin');
  assert.ok(existsSync(file));
  const text = readFileSync(file, 'latin1');
  assert.ok(!text.includes('kimchi') && !text.includes('refresh'), 'not readable as text');
  a.server.close();
  const b = await app({ secureStore: keychain });
  // read in the background after the start: "signed out" until it is there
  let st = (await b.get('/api/account')).body;
  for (let i = 0; i < 50 && !st.session.signedIn; i++) {
    await new Promise((res) => setTimeout(res, 20));
    st = (await b.get('/api/account')).body;
  }
  assert.equal(st.session.signedIn, true);
  assert.equal(st.me.handle, 'kimchi');
  await b.post('/api/account/logout');
  assert.ok(!existsSync(file), 'signing out removes it');
});

test('showcase: the layout is saved on the service and friends see it; a most trusted line, the old free text kept as it was', async () => {
  const a = await app();
  await a.signIn(robin);
  assert.equal((await a.get('/api/account')).body.me.showcaseLayout, 'case', 'the display case until the player picks another');
  const r = await a.patch('/api/account/me', { showcaseLayout: 'lcd' });
  assert.equal(r.status, 200);
  assert.equal(r.body.showcaseLayout, 'lcd');
  assert.equal(fake.log.filter((l) => l.method === 'PATCH' && l.path === '/v1/me').at(-1).body.showcase_layout, 'lcd');
  assert.equal(fake.users.get(robin.id).showcase_layout, 'lcd');
  assert.equal((await a.get('/api/account')).body.me.showcaseLayout, 'lcd', 'kept');
  for (const bad of ['grid', '', null, 3]) {
    const x = await quiet(() => a.patch('/api/account/me', { showcaseLayout: bad }));
    assert.deepEqual([x.status, x.body.vars?.field], [400, 'showcase_layout'], String(bad));
  }
  // a friend's profile comes with their layout and their line – its numbers only when their runs are shared
  fake.users.get(kim.id).showcase = { trophies: [], trusted: { species: 130, line: 129, note: 'never again', teams: 4, top_level: 61, fell: 1 }, favorite_game: null };
  fake.users.get(kim.id).showcase_layout = 'shelf';
  let p = (await a.get(`/api/account/users/${kim.id}`)).body;
  assert.equal(p.showcaseLayout, 'shelf');
  assert.deepEqual(p.showcase.trusted, { species: 130, line: 129, note: 'never again', teams: null, topLevel: null, fell: null });
  fake.users.get(kim.id).privacy.show_runs = true;
  p = (await a.get(`/api/account/users/${kim.id}`)).body;
  assert.deepEqual([p.showcase.trusted.teams, p.showcase.trusted.topLevel, p.showcase.trusted.fell], [4, 61, 1]);
  // the old free text: shown as it was, and sent back unchanged when the showcase is saved without a new line
  fake.users.get(robin.id).showcase = { trophies: [], trusted: 'Breloom line – carried us through the E4', favorite_game: 'Emerald' };
  const me = (await a.patch('/api/account/me', { status: 'hi' })).body;
  assert.equal(me.showcase.trusted, null);
  assert.equal(me.showcase.trustedText, 'Breloom line – carried us through the E4');
  const kept = await a.patch('/api/account/me', { showcase: { ...me.showcase, favoriteGame: 'Crystal' } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(fake.log.filter((l) => l.method === 'PATCH' && l.path === '/v1/me').at(-1).body.showcase.trusted, 'Breloom line – carried us through the E4');
  assert.equal(kept.body.showcase.trustedText, 'Breloom line – carried us through the E4');
  // a picked line replaces it
  const line = await a.patch('/api/account/me', { showcase: { trophies: [], trusted: { species: 260, line: 258, note: '' }, trustedText: 'ignored', favoriteGame: null } });
  assert.deepEqual(line.body.showcase.trusted, { species: 260, line: 258, note: null, teams: null, topLevel: null, fell: null });
  assert.equal(line.body.showcase.trustedText, null);
  await a.patch('/api/account/me', { showcaseLayout: 'case' });
});

test('showcase layout: a service that doesn’t store layouts yet (before migration 0004) – the layout stays on this computer, the rest saves', async () => {
  const a = await app();
  await a.signIn(robin);
  fake.noLayouts = true;
  try {
    // the field is refused by the old service: saved without it, kept locally, shown on the own profile
    const r = await a.patch('/api/account/me', { showcaseLayout: 'lcd', status: 'layout test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.showcaseLayout, 'lcd');
    assert.equal(r.body.status, 'layout test');
    const sent = fake.log.filter((l) => l.method === 'PATCH' && l.path === '/v1/me');
    assert.equal(sent.at(-1).body.showcase_layout, undefined, 'the retry leaves the field out');
    assert.equal(sent.at(-1).body.status, 'layout test');
    // only the layout: nothing goes to the service again, the profile keeps it
    const only = await a.patch('/api/account/me', { showcaseLayout: 'shelf' });
    assert.equal(only.status, 200, JSON.stringify(only.body));
    assert.equal(only.body.showcaseLayout, 'shelf');
    assert.equal((await a.get('/api/account')).body.me.showcaseLayout, 'shelf', 'a fresh read keeps the local layout');
    // other refusals still come through as errors
    const bad = await quiet(() => a.patch('/api/account/me', { showcaseLayout: 'lcd', status: '<b>no</b>' }));
    assert.equal(bad.status, 400);
  } finally {
    fake.noLayouts = false;
  }
  // a service that stores layouts wins again
  assert.equal((await a.patch('/api/account/me', { showcaseLayout: 'case', status: null })).body.showcaseLayout, 'case');
});

test('showcase: the most trusted line goes out with its numbers only when the runs are shared', () => {
  const numbers = (line) => (line === 258 ? { teams: 5, top_level: 58, fell: 1 } : null);
  const body = { showcase: { trophies: ['badges16'], trusted: { species: 260, line: 258, note: 'carried me' }, favoriteGame: 'Emerald' } };
  assert.deepEqual(mePatch(body, { numbers }).showcase.trusted, { species: 260, line: 258, note: 'carried me', teams: 5, top_level: 58, fell: 1 });
  assert.deepEqual(mePatch(body).showcase.trusted, { species: 260, line: 258, note: 'carried me' }, 'not shared: no numbers');
  // a line the runs don't know (picked by search): no numbers either
  assert.deepEqual(mePatch({ showcase: { trophies: [], trusted: { species: 1, line: 1 } } }, { numbers }).showcase.trusted, { species: 1, line: 1, note: null });
  // out of range / not a species → nothing; markup in the note is refused like any text
  assert.equal(mePatch({ showcase: { trophies: [], trusted: { species: 4000 } } }).showcase.trusted, null);
  assert.throws(() => mePatch({ showcase: { trophies: [], trusted: { species: 25, line: 25, note: '<b>x</b>' } } }), (e) => e.vars?.field === 'showcase.trusted.note');
  assert.throws(() => mePatch({ showcaseLayout: 'wall' }), (e) => e.vars?.field === 'showcase_layout');
  assert.deepEqual(mePatch({ showcaseLayout: 'shelf' }), { showcase_layout: 'shelf' });
});

test('profile: edit round trip – only known fields go out, the service’s rules come back as the page’s errors', async () => {
  const a = await app();
  await a.signIn(robin);
  // text the service would refuse (API.md §0.6: no < or >, a letter or digit) is refused here already
  const angle = await quiet(() => a.patch('/api/account/me', { status: '<b>grinding</b>' }));
  assert.deepEqual([angle.status, angle.body.vars.code, angle.body.vars.field], [400, 'text_rejected', 'status']);
  assert.equal((await quiet(() => a.patch('/api/account/me', { status: '– … –' }))).body.vars.code, 'text_rejected');
  const r = await a.patch('/api/account/me', {
    status: 'grinding   Victory Road', accent: 'dusk', title: 'win-nuzlocke', banner: 'dusk-ridge',
    showcase: { trophies: ['win-nuzlocke', 'badges16', 'win-nuzlocke'], trusted: { species: 286, line: 285, note: 'carried   us', teams: 99 }, favoriteGame: 'Emerald' },
    privacy: { profile: 'link', presence: 'friends', showLocation: true }, isAdmin: true,
  });
  assert.equal(r.status, 200);
  const sent = fake.log.filter((l) => l.method === 'PATCH' && l.path === '/v1/me').at(-1).body;
  assert.deepEqual(Object.keys(sent).sort(), ['accent', 'banner', 'privacy', 'showcase', 'status', 'title']);
  // the most trusted line: species, line and the note – the page's own numbers never go out (runs aren't shared here)
  assert.deepEqual(sent.showcase, { trophies: ['win-nuzlocke', 'badges16'], trusted: { species: 286, line: 285, note: 'carried us' }, favorite_game: 'Emerald' });
  assert.equal(r.body.status, 'grinding Victory Road', 'single spaces, as the service stores it');
  assert.equal(r.body.accent, 'dusk');
  assert.equal(fake.users.get(robin.id).privacy.profile, 'link');
  assert.equal((await a.get('/api/account')).body.me.showcase.favoriteGame, 'Emerald');
  // a premium banner without souldew+ → the service says no, the page gets a code it can translate
  const plus = await quiet(() => a.patch('/api/account/me', { banner: 'night-train' }));
  assert.equal(plus.status, 403);
  assert.deepEqual([plus.body.code, plus.body.vars.code], ['acct', 'not_entitled']);
  const filtered = await quiet(() => a.patch('/api/account/me', { status: 'join discord.gg/xyz' }));
  assert.deepEqual([filtered.status, filtered.body.vars.code, filtered.body.vars.field], [400, 'text_rejected', 'status']);
  assert.equal((await quiet(() => a.patch('/api/account/me', { accent: 'red;}' }))).status, 400, 'a raw colour never leaves the app');
  // handle, friend code
  assert.equal((await a.put('/api/account/handle', { handle: '@Robin_Dew' })).body.handle, 'robin_dew');
  assert.equal((await quiet(() => a.put('/api/account/handle', { handle: 'kimchi' }))).body.vars.code, 'handle_taken');
  const oldCode = (await a.get('/api/account')).body.me.friendCode;
  assert.notEqual((await a.post('/api/account/friend-code')).body.friendCode, oldCode);
  await a.put('/api/account/handle', { handle: 'robin' });
  await a.post('/api/account/logout');
});

test('friends: request by handle or code, accept, list with presence, remove, block, report – ids checked', async () => {
  const a = await app();
  const b = await app();
  await a.signIn(noor);
  await b.signIn(kim);
  assert.deepEqual((await a.post('/api/account/friends/requests', { query: '@kimchi' })).body, { status: 'sent' });
  const inc = (await b.get('/api/account/friends')).body.incoming;
  assert.equal(inc.length, 1);
  assert.equal(inc[0].from.handle, 'noor_exe');
  assert.equal((await b.post(`/api/account/friends/requests/${inc[0].id}/accept`)).status, 200);
  assert.ok((await a.get('/api/account/friends')).body.friends.some((f) => f.user.handle === 'kimchi' && f.presence.state === 'offline'));
  // by friend code (a code that exists nowhere → "nobody found")
  const missing = await quiet(() => a.post('/api/account/friends/requests', { query: 'SD-ZZZZ-ZZZZ' }));
  assert.deepEqual([missing.status, missing.body.vars.code], [404, 'not_found']);
  assert.equal((await quiet(() => a.post('/api/account/friends/requests', { query: '<script>' }))).status, 400, 'not a handle or a code: nothing is sent');
  const code = fake.users.get(robin.id).friend_code;
  assert.equal((await a.post('/api/account/friends/requests', { query: code.toLowerCase() })).body.status, 'sent');
  // ids are checked before they become part of a service path
  assert.equal((await quiet(() => a.del('/api/account/friends/..%2F..%2Fv1%2Fme'))).status, 404);
  assert.equal((await quiet(() => a.post('/api/account/blocks', { userId: '../me' }))).status, 400);
  // report, remove, block
  assert.equal((await a.post('/api/account/reports', { userId: kim.id, target: 'status', reason: 'spam', note: 'line1\nline2‮', extra: 1 })).status, 200);
  assert.deepEqual(fake.reports.at(-1), { user_id: kim.id, target: 'status', reason: 'spam', note: 'line1\nline2', by: noor.id });
  assert.equal((await a.del(`/api/account/friends/${kim.id}`)).status, 200);
  assert.ok(!(await a.get('/api/account/friends')).body.friends.some((f) => f.user.id === kim.id));
  assert.equal((await a.post('/api/account/blocks', { userId: kim.id })).status, 200);
  assert.equal((await quiet(() => b.get(`/api/account/users/${noor.id}`))).status, 404, 'blocked: invisible both ways');
  await a.del(`/api/account/blocks/${kim.id}`);
  await a.post('/api/account/logout');
  await b.post('/api/account/logout');
});

test('presence: what the player does goes out only as far as the privacy settings allow', async () => {
  const a = await app();
  await a.signIn(robin);
  await a.patch('/api/account/me', { privacy: { presence: 'friends', showLocation: false } });
  const mark = fake.log.length;
  await a.put('/api/account/presence', { state: 'in_run', game: { title: 'Emerald', system: 'gba' }, run: { name: 'Emerald with Kim', mode: 'soullink', freeSlot: true, joinable: true }, location: 'Route 104', extra: 'x' });
  const put = await until(() => fake.log.slice(mark).find((l) => l.method === 'PUT' && l.path === '/v1/presence'));
  assert.deepEqual(put.body, { state: 'in_run', game: { title: 'Emerald', system: 'gba' }, run: { name: 'Emerald with Kim', mode: 'soullink', free_slot: true, joinable: true } }, 'no location without "show where I am"');
  // a friend sees it
  const k = await app();
  await k.signIn(kim);
  const seen = (await k.get('/api/account/friends')).body.friends.find((f) => f.user.id === robin.id).presence;
  assert.deepEqual([seen.state, seen.game.title, seen.run.freeSlot], ['in_run', 'Emerald', true]);
  // appear offline: nothing about the player is sent any more – only the counters are asked for
  const mark2 = fake.log.length;
  await a.patch('/api/account/me', { privacy: { presence: 'offline' } });
  await a.put('/api/account/presence', { state: 'playing', game: { title: 'Crystal', system: 'gbc' } });
  await until(() => fake.log.slice(mark2).some((l) => l.path === '/v1/pending'));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!fake.log.slice(mark2).some((l) => l.method === 'PUT' && l.path === '/v1/presence'), 'no heartbeat while appearing offline');
  assert.ok(fake.log.slice(mark2).some((l) => l.method === 'DELETE' && l.path === '/v1/presence'), 'gone at once');
  assert.equal((await k.get('/api/account/friends')).body.friends.find((f) => f.user.id === robin.id).presence.state, 'offline');
  await a.patch('/api/account/me', { privacy: { presence: 'friends' } });
  await a.post('/api/account/logout');
  await k.post('/api/account/logout');
});

test('export, deletion, entitlements and pack access', async () => {
  const a = await app();
  const temp = fake.addUser({ handle: 'tempo', display_name: 'Tempo' });
  fake.memberships.set('payer@example.com', 'plus');
  await a.signIn(temp);
  assert.equal((await a.get('/api/account/export')).body.account.handle, 'tempo');
  // §8.3: the service always says "submitted" – the result is read from the entitlement
  assert.deepEqual((await a.post('/api/account/link-email', { email: 'nobody@example.com' })).body, { submitted: true, linked: false, tier: 'none', badges: [], until: null });
  const linked = (await a.post('/api/account/link-email', { email: 'payer@example.com' })).body;
  assert.deepEqual([linked.submitted, linked.linked, linked.tier], [true, true, 'plus']);
  assert.equal((await a.get('/api/account')).body.me.entitlement.tier, 'plus');
  const ent = (await a.get('/api/account/entitlements')).body;
  assert.equal(ent.tier, 'plus');
  assert.match(ent.packKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await a.get('/api/account/packs')).body.items[0].entitled, true);
  // offline: the kept entitlement (encrypted with the session) keeps the cosmetics working for the grace days
  fake.offlinePaths.add('/v1/entitlements');
  const kept = (await a.get('/api/account/entitlements')).body;
  fake.offlinePaths.delete('/v1/entitlements');
  assert.deepEqual([kept.offline, kept.tier, kept.packKey, kept.token, kept.verified], [true, 'plus', ent.packKey, undefined, true], 'offline: the kept token verified again; no token is handed out');
  assert.equal(ent.token, undefined, 'the page never gets the token, only its verified claims');
  assert.equal((await quiet(() => a.post('/api/account/link-email', { email: 'not an email' }))).status, 400);
  assert.equal((await quiet(() => a.del('/api/account', { confirm: 'robin' }))).status, 400, 'deleting needs the own handle');
  assert.equal((await a.del('/api/account', { confirm: '@tempo' })).status, 200);
  const st = (await a.get('/api/account')).body.session;
  assert.equal(st.signedIn, false);
  assert.ok(!fake.users.has(temp.id));
});

test('souldew+: patron is souldew+, the live preview answer is cleaned, a rotated or lost pack key wipes the pack cache', async () => {
  const a = await app();
  const pat = fake.addUser({ handle: 'patty', display_name: 'Patty' });
  fake.memberships.set('patron@example.com', 'patron');
  await a.signIn(pat);
  // a non-member's live preview: own key, the end time, file URLs only on the service
  const pv = (await a.post('/api/account/packs/skins-preview/preview')).body;
  assert.match(pv.key, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pv.packKeyId, /^pv_[A-Za-z0-9_-]{22}$/);
  assert.ok(Date.parse(pv.expiresAt) > Date.now());
  assert.equal(pv.offlineGrace, false);
  assert.deepEqual(pv.files.map((f) => f.path), ['skins/ember.css'], 'a URL to another host is dropped');
  const ent0 = (await a.get('/api/account/entitlements')).body;
  assert.deepEqual([ent0.tier, ent0.preview?.packId], ['none', 'skins-preview'], '"Preview" state from the service');
  assert.equal(ent0.packKey, null);
  const packs = (await a.get('/api/account/packs')).body.items;
  assert.deepEqual(packs.map((p) => [p.id, p.kind, p.previewable]), [['skins-autumn', 'skins', false], ['skins-preview', 'preview', true]]);
  // patron (tier 3) = souldew+ with the patron badge
  const linked = (await a.post('/api/account/link-email', { email: 'patron@example.com' })).body;
  assert.deepEqual([linked.linked, linked.tier, linked.badges], [true, 'patron', ['plus', 'patron']]);
  const ent = (await a.get('/api/account/entitlements')).body;
  assert.match(ent.packKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ent.packKeyId, '1');
  assert.ok((await a.get('/api/account/packs')).body.items[0].entitled);
  // an encrypted pack cache on disk (as the pack client leaves it)
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const plusDir = join(DATA, 'plus');
  const plant = () => {
    mkdirSync(join(plusDir, 'files'), { recursive: true });
    writeFileSync(join(plusDir, 'pack.json'), JSON.stringify({ packId: 'skins-autumn', keyId: '1', files: {} }));
    writeFileSync(join(plusDir, 'files', `${'a'.repeat(64)}.sdp`), 'SDP1');
  };
  plant();
  await a.get('/api/account/entitlements');
  assert.ok(existsSync(join(plusDir, 'pack.json')), 'same key: kept');
  // §8.5 unlink: the key rotates and the tier is gone → the cache goes
  await a.del('/api/account/link');
  assert.ok(!existsSync(join(plusDir, 'pack.json')) && !existsSync(join(plusDir, 'files')), 'wiped on unlink');
  // the key rotated elsewhere (sign out everywhere on another device): the next entitlement read wipes too
  fake.memberships.set('patron2@example.com', 'patron');
  await a.post('/api/account/link-email', { email: 'patron2@example.com' });
  await a.get('/api/account/entitlements');
  plant();
  fake.users.get(pat.id).keyEpoch = 7;
  assert.equal((await a.get('/api/account/entitlements')).body.packKeyId, '7');
  assert.ok(!existsSync(join(plusDir, 'pack.json')), 'wiped when pack_key_id changed');
  // signing out takes it as well
  plant();
  await a.post('/api/account/logout');
  assert.ok(!existsSync(join(plusDir, 'pack.json')), 'wiped on sign-out');
  // the preview limit comes through with the service's code
  await a.signIn(pat);
  fake.previewCount.set(pat.id, 10);
  const limited = await quiet(() => a.post('/api/account/packs/skins-preview/preview'));
  assert.deepEqual([limited.status, limited.body.vars?.code], [429, 'rate_limited']);
  await a.post('/api/account/logout');
});

test('avatars: fetched by the local server from the allowed source only, and only when it is a picture', async () => {
  const a = await app();
  await a.signIn(robin);
  const me = (await a.get('/api/account')).body.me;
  const img = await fetch(a.base + me.avatar, { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image' } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  for (const src of ['https://evil.example/a.png', `${fake.base}/v1/me`, 'http://169.254.169.254/latest/meta-data/']) {
    const r = await fetch(`${a.base}/api/account/avatar?src=${encodeURIComponent(src)}`, { headers: { 'x-soullink': '1' } });
    assert.equal(r.status, 400, src);
  }
  await a.post('/api/account/logout');
  const signedOut = await fetch(a.base + me.avatar, { headers: { 'x-soullink': '1' } });
  assert.equal(signedOut.status, 404, 'signed out: no picture is fetched');
});

test('signed out: nothing leaves the computer and the rest of the app answers as before', async () => {
  const a = await app();
  const mark = fake.log.length;
  const st = (await a.get('/api/account')).body;
  assert.equal(st.session.signedIn, false);
  assert.equal(st.me, null);
  await a.put('/api/account/presence', { state: 'library' });
  for (const p of ['/api/account/friends', '/api/account/invites', '/api/account/entitlements', '/api/account/choices']) {
    const r = await quiet(() => a.get(p));
    assert.deepEqual([r.status, r.body.code], [401, 'acctSignedOut'], p);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fake.log.length, mark, 'not a single request to the accounts service');
  // the app's own API is untouched
  const s = await a.get('/api/status');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.body.runs));
  assert.equal((await a.get('/api/account/diagnostics')).body.signedIn, false);
});

test('short game names (profile stats, presence, invites): every game keeps a name of its own', () => {
  const games = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'shared', 'data', 'catalog.json'), 'utf8')).games.filter((g) => !g.variantOf);
  const names = new Map();
  for (const g of games) {
    const n = social.shortGameName(g.title);
    assert.ok(n && !/Pok[eé]mon|Version/i.test(n), `${g.title} → ${n}`);
    assert.equal(shortGameTitle(g.title), n, 'the server uploads the same name the page shows');
    assert.ok(!names.has(n) || names.get(n) === g.title, `${g.title} and ${names.get(n)} both become "${n}"`);
    names.set(n, g.title);
  }
  assert.equal(social.shortGameName('Pokémon Black Version 2'), 'Black 2');
  assert.equal(social.shortGameName('Pokémon White Version 2'), 'White 2');
});

test('avatars: a picture without a length is read no further than a picture may be (512 KB) – an endless answer is dropped', async () => {
  const { readCapped } = await import('../server/lib/accounts/index.mjs');
  let pulled = 0;
  const endless = () => new Response(new ReadableStream({ pull: (c) => { pulled++; c.enqueue(new Uint8Array(64 * 1024)); } }));
  assert.equal(await readCapped(endless(), 512 * 1024), null);
  assert.ok(pulled <= 12, `stopped right after the cap (${pulled} chunks)`);
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
  const small = new Response(new ReadableStream({ start: (c) => { c.enqueue(png.subarray(0, 4)); c.enqueue(png.subarray(4)); c.close(); } }));
  assert.deepEqual([...(await readCapped(small, 512 * 1024))], [...png], 'a picture in pieces: whole');
  assert.equal(await readCapped(new Response(new Uint8Array(600 * 1024)), 512 * 1024), null);
  // the proxy reads through it
  const src = readFileSync(new URL('../server/lib/accounts/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /const buf = await readCapped\(r, AVATAR_MAX\)/);
  assert.doesNotMatch(src.slice(src.indexOf('async function avatar(')), /^[^\n]*Buffer\.from\(await r\.arrayBuffer\(\)\)[^\n]*$/m);
});

test('souldew+ trial (§8.6): offered, started, shown as a trial (not a thank-you), once only; an old app reads the new source kind', async () => {
  const a = await app();
  const tri = fake.addUser({ handle: 'trialist', display_name: 'Lena' });
  await a.signIn(tri);
  let me = (await a.get('/api/account')).body.me;
  await until(async () => (me = (await a.get('/api/account')).body.me).entitlement.trial);
  assert.deepEqual(me.entitlement.trial, { state: 'available', days: 7, until: null, reason: null, only: false });
  const r = await a.post('/api/account/trial');
  assert.equal(r.status, 200);
  assert.equal(r.body.tier, 'plus');
  assert.equal(r.body.trial.state, 'running');
  assert.equal(r.body.trial.only, true);
  me = (await a.get('/api/account')).body.me;
  assert.equal(me.entitlement.tier, 'plus');
  assert.equal(me.entitlement.trial.only, true);
  const ent = (await a.get('/api/account/entitlements')).body;
  assert.deepEqual(ent.sources.map((x) => x.kind), ['trial']);
  assert.match(ent.packKey, /^[A-Za-z0-9_-]{43}$/, 'a trial is souldew+: the pack key comes');
  const again = await quiet(() => a.post('/api/account/trial'));
  assert.equal(again.status, 409);
  assert.equal(again.body.vars.code, 'trial_used');
  // offline: still a trial (the page says "Trial · ends …", never "thank you")
  fake.offlinePaths.add('/v1/entitlements');
  const kept = (await a.get('/api/account/entitlements')).body;
  fake.offlinePaths.delete('/v1/entitlements');
  assert.deepEqual([kept.offline, kept.tier, kept.trial?.only], [true, 'plus', true]);
  // souldew 3.0.0 mapped unknown kinds to 'bmc' – 'trial' is known now, anything newer still counts as a source
  assert.equal(clean.cleanEntitlements({ sources: [{ kind: 'trial', tier: 'plus', until: '2026-12-01T00:00:00Z' }, { kind: 'future', tier: 'plus' }] }).sources.map((x) => x.kind).join(), 'trial,bmc');
  assert.equal(clean.cleanTrial({ state: 'running' }), null, 'a running trial without an end is not believed');
  assert.deepEqual(clean.cleanTrial({ state: 'unavailable', reason: 'account_age', until: 'x' }), { state: 'unavailable', days: 7, until: null, reason: 'account_age' });
});

test('trial: refused for a young Discord account – the reason reaches the page', async () => {
  const a = await app();
  const young = fake.addUser({ handle: 'youngone' });
  young.trialOffer = 'unavailable:account_age';
  await a.signIn(young);
  const r = await quiet(() => a.post('/api/account/trial'));
  assert.equal(r.status, 403);
  assert.equal(r.body.vars.code, 'trial_unavailable');
  assert.equal(r.body.vars.reason, 'account_age');
});

test('Find a SoulLink partner (§14): the form goes out cleaned, the Discord link comes back; an open post brings its link', async () => {
  const a = await app();
  const sam = fake.addUser({ handle: 'sam_links', display_name: 'Sam' });
  await a.signIn(sam);
  const post = { game: '  Emerald ', partners: 2, lang: 'English, UTC+1', schedule: 'Weekday   evenings', rules: 'Set mode\r\nLevel caps\n\n', extra: 'dropped' };
  const r = await a.post('/api/account/lfg', post);
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/);
  assert.deepEqual(fake.lfgPosts.at(-1), { by: sam.id, game: 'Emerald', partners: 2, rules: 'Set mode\nLevel caps', lang: 'English, UTC+1', schedule: 'Weekday evenings' });
  assert.equal((await quiet(() => a.post('/api/account/lfg', { ...post, partners: 4 }))).status, 400);
  assert.equal((await quiet(() => a.post('/api/account/lfg', { ...post, schedule: ' ' }))).status, 400);
  fake.lfgAnswer = { status: 409, code: 'lfg_active', extra: { url: 'https://discord.com/channels/1570873327566852146/1570873327566852150/1573924615737049999' } };
  const open = await quiet(() => a.post('/api/account/lfg', post));
  assert.equal(open.status, 409);
  assert.equal(open.body.vars.code, 'lfg_active');
  assert.match(open.body.vars.url, /1573924615737049999$/);
  fake.lfgAnswer = { status: 409, code: 'lfg_active', extra: { url: 'https://evil.example/x' } };
  assert.equal((await quiet(() => a.post('/api/account/lfg', post))).body.vars.url, undefined, 'only Discord message links pass');
  fake.lfgAnswer = { status: 201, body: { url: 'https://evil.example/x' } };
  assert.equal((await quiet(() => a.post('/api/account/lfg', post))).status, 502);
  fake.lfgAnswer = null;
  // signed out: nothing goes out
  await a.post('/api/account/logout');
  const n = fake.lfgPosts.length;
  assert.equal((await quiet(() => a.post('/api/account/lfg', post))).status, 401);
  assert.equal(fake.lfgPosts.length, n);
});
