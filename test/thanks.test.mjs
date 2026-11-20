// The Thank you page (web/views/thanks.mjs, web/lib/thanks.mjs) and its server side (server/lib/accounts: GET
// /api/account/thanks, cleanThanks, the opt-in) against the fake accounts service (test/fixtures/fakeaccounts.mjs –
// API.md §13, never the real one): what the page may show (only opted-in people by name, nothing but name / picture /
// banner / frame / tier / month), the live feed (asked on open, every minute while visible, never while hidden, ETag both
// ways, offline → the last wall "as of …"), who is new, and asking a new supporter once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { startFakeAccounts } = await import('./fixtures/fakeaccounts.mjs');
const fake = await startFakeAccounts();
const clean = await import('../server/lib/accounts/clean.mjs');
const { createAccounts, mePatch } = await import('../server/lib/accounts/index.mjs');
const lib = await import('../web/lib/thanks.mjs');

after(() => fake.close());

const SVC = 'https://accounts.souldew.app';
const WALL = {
  updated: '2026-11-19T18:00:00Z', total: 9, counts: { legend: 1, plus: 2, supporter: 3, coffee: 3 },
  people: [
    { name: 'Lena', tier: 'legend', since: '2026-11', avatar: `${SVC}/v1/avatars/u_abcdefghijABCDEFGHIJ12/0123456789abcdef0123456789abcdef.png?size=128`, banner: 'night-train', frame: 'brass-ring' },
    { name: 'Mo', tier: 'plus', since: '2026-10' },
    { name: 'Ida', tier: 'coffee', since: '2026-11' },
  ],
};

// ---- what the page gets ----------------------------------------------------------------------------------------------

test('cleanThanks: only known fields, plain text names, proxied avatars, catalog ids, months – and never fewer counted than named', () => {
  const w = clean.cleanThanks({
    ...WALL, secret: 1,
    people: [...WALL.people,
      { name: '<img src=x onerror=alert(1)>‮', tier: 'supporter', since: '2026-13', avatar: 'https://evil.example/a.png', banner: 'Night Train', frame: '../x', discord_id: '80351110224678912', email: 'a@b.c' },
      { name: 'Nobody', tier: 'admin' }, { name: '', tier: 'plus' }, null, 'x'],
    counts: { legend: 1, plus: 2, supporter: 0, coffee: 'many' },
  }, SVC);
  assert.deepEqual(Object.keys(w).sort(), ['counts', 'people', 'total', 'updated']);
  assert.equal(w.updated, Date.parse('2026-11-19T18:00:00Z'));
  assert.equal(w.people.length, 4, 'unknown tiers and nameless entries are dropped');
  const lena = w.people[0];
  assert.deepEqual(Object.keys(lena).sort(), ['avatar', 'banner', 'frame', 'name', 'since', 'tier']);
  assert.ok(lena.avatar.startsWith('/api/account/avatar?src='), 'the page loads pictures from this computer only');
  const odd = w.people[3];
  assert.equal(odd.name, '<img src=x onerror=alert(1)>', 'kept as text – the page renders text, never HTML');
  assert.deepEqual([odd.since, odd.avatar, odd.banner, odd.frame], [null, null, null, null]);
  assert.ok(!JSON.stringify(w).includes('80351110224678912') && !JSON.stringify(w).includes('a@b.c'));
  assert.equal(w.counts.supporter, 1, 'a tier counts at least the people it names');
  assert.equal(w.counts.coffee, 1);
  assert.equal(w.total, 9);
  assert.equal(clean.cleanThanks({ total: 3 }, SVC), null);
  assert.equal(clean.cleanThanks(null, SVC), null);
  assert.equal(clean.cleanThanks({ counts: {}, people: Array.from({ length: 900 }, (_, i) => ({ name: `P${i}`, tier: 'coffee' })) }, SVC).people.length, clean.THANKS_MAX);
});

test('the opt-in: cleanMe reads it (unanswered = null) and thanks_tier, the page’s patch sends it', () => {
  const base = { id: 'u_abc', handle: 'ash_k', display_name: 'Ash' };
  assert.equal(clean.cleanMe({ ...base, privacy: {} }, SVC).privacy.showOnThanks, null);
  assert.equal(clean.cleanMe({ ...base, privacy: { show_on_thanks: false } }, SVC).privacy.showOnThanks, false);
  assert.equal(clean.cleanMe({ ...base, privacy: { show_on_thanks: true } }, SVC).privacy.showOnThanks, true);
  assert.equal(clean.cleanMe({ ...base, privacy: { show_on_thanks: 'yes' } }, SVC).privacy.showOnThanks, null);
  assert.equal(clean.cleanMe({ ...base, thanks_tier: 'legend' }, SVC).thanksTier, 'legend');
  assert.equal(clean.cleanMe({ ...base, thanks_tier: 'patron' }, SVC).thanksTier, null);
  assert.equal(clean.cleanMe(base, SVC).thanksTier, null, 'a service before the wall: never asked');
  assert.deepEqual(mePatch({ privacy: { showOnThanks: true } }), { privacy: { show_on_thanks: true } });
  assert.throws(() => mePatch({ privacy: { showOnThanks: 'on' } }), /Nothing to change/);
});

test('tierGroups: highest first, only tiers with supporters, "and N more" for the quiet ones', () => {
  const g = lib.tierGroups(clean.cleanThanks(WALL, SVC));
  assert.deepEqual(g.map((x) => [x.tier, x.count, x.people.length, x.more]), [['legend', 1, 1, 0], ['plus', 2, 1, 1], ['supporter', 3, 0, 3], ['coffee', 3, 1, 2]]);
  assert.deepEqual(lib.tierGroups({ counts: { legend: 0, plus: 0, supporter: 0, coffee: 0 }, people: [] }), []);
  assert.deepEqual(lib.tierGroups(null), []);
});

test('arrivals: new names and moves up a tier – not the ones who stayed or moved down', () => {
  const prev = { people: [{ name: 'Lena', tier: 'plus' }, { name: 'Mo', tier: 'plus' }, { name: 'Ida', tier: 'legend' }] };
  const next = { people: [{ name: 'Lena', tier: 'legend' }, { name: 'Mo', tier: 'plus' }, { name: 'Ida', tier: 'supporter' }, { name: 'Kai', tier: 'coffee' }] };
  assert.deepEqual(lib.arrivals(prev, next), [{ name: 'Lena', tier: 'legend' }, { name: 'Kai', tier: 'coffee' }]);
  assert.deepEqual(lib.arrivals(null, next), [], 'the first wall of a visit announces nobody');
  assert.equal(lib.sinceDate('2026-11').getUTCMonth(), 10);
  assert.equal(lib.sinceDate('soon'), null);
});

// ---- the live feed -------------------------------------------------------------------------------------------------

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { pending.set(++seq, { fn, ms }); return seq; },
    clearTimeout: (id) => pending.delete(id),
    pending,
    /** runs the one planned timer (there is at most one), returns its delay */
    async fire() {
      const [[id, { fn, ms }]] = [...pending];
      pending.delete(id);
      await fn();
      return ms;
    },
  };
}
function fakeVisibility(hidden = false) {
  const subs = new Set();
  return { hidden: () => hidden, on: (fn) => { subs.add(fn); return () => subs.delete(fn); }, set(h) { hidden = h; subs.forEach((f) => f()); }, get subs() { return subs.size; } };
}
const settle = () => new Promise((r) => setImmediate(r));

test('feed: asks on open, then every minute while visible – with the version it has; nothing while hidden', async () => {
  const timers = fakeTimers();
  const vis = fakeVisibility();
  let clock = 1_000_000;
  const asked = [];
  const saved = [];
  const states = [];
  const answers = [{ thanks: { counts: { plus: 1 }, people: [{ name: 'Mo', tier: 'plus' }] }, version: 'v1', fetchedAt: 5 }, { unchanged: true, version: 'v1', fetchedAt: 6 },
    { thanks: { counts: { plus: 1, legend: 1 }, people: [{ name: 'Mo', tier: 'plus' }, { name: 'Lena', tier: 'legend' }] }, version: 'v2', fetchedAt: 7 }];
  const feed = lib.createThanksFeed({ load: async (have) => { asked.push(have); return answers.shift(); }, onUpdate: (s) => states.push(s), timers, visibility: vis, now: () => clock, save: (e) => saved.push(e) });
  feed.start();
  await settle();
  assert.deepEqual(asked, [null], 'on open, without a version');
  assert.equal(states.at(-1).thanks.people[0].name, 'Mo');
  assert.deepEqual(states.at(-1).arrivals, []);
  assert.equal(saved.length, 1, 'kept for offline');
  assert.equal(timers.pending.size, 1);
  clock += 60000;
  assert.equal(await timers.fire(), lib.POLL_MS);
  assert.deepEqual(asked, [null, 'v1'], 'the next ask names the version: unchanged costs nothing');
  assert.equal(saved.length, 1, 'unchanged: nothing to keep');
  // hidden: the planned ask goes, nothing is asked
  vis.set(true);
  assert.equal(timers.pending.size, 0);
  clock += 5 * 60000;
  // visible again after more than a minute: asks at once
  vis.set(false);
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0].ms, 0);
  await timers.fire();
  assert.deepEqual(asked, [null, 'v1', 'v1']);
  assert.deepEqual(states.at(-1).arrivals, [{ name: 'Lena', tier: 'legend' }], 'someone new while the page was open');
  // visible again soon after: waits for the rest of the minute
  vis.set(true);
  clock += 20000;
  vis.set(false);
  assert.equal([...timers.pending.values()][0].ms, 40000);
  feed.stop();
  assert.equal(timers.pending.size, 0, 'stopped: nothing planned');
  assert.equal(vis.subs, 0, 'and no listener left behind');
});

test('feed: offline keeps the last wall (from this computer, or the last answer) and says so; back online it is live', async () => {
  const timers = fakeTimers();
  const vis = fakeVisibility();
  const states = [];
  let online = false;
  const cached = { thanks: { counts: { coffee: 2 }, people: [{ name: 'Ida', tier: 'coffee' }] }, version: 'old', fetchedAt: 123 };
  const feed = lib.createThanksFeed({
    cached, timers, visibility: vis, save: () => {}, onUpdate: (s) => states.push(s),
    load: async (have) => {
      if (!online) throw Object.assign(new Error('The account service can’t be reached'), { code: 'acctOffline' });
      return have === 'old' ? { unchanged: true, version: 'old', fetchedAt: 999 } : null;
    },
  });
  feed.start();
  assert.equal(states[0].thanks.people[0].name, 'Ida', 'the kept wall shows at once');
  assert.equal(states[0].stale, true);
  await settle();
  assert.equal(states.at(-1).stale, true);
  assert.equal(states.at(-1).error, 'acctOffline');
  assert.equal(states.at(-1).fetchedAt, 123, '"as of" the kept wall');
  assert.equal(states.at(-1).thanks.people[0].name, 'Ida');
  online = true;
  await timers.fire();
  assert.equal(states.at(-1).stale, false);
  assert.equal(states.at(-1).error, null);
  assert.equal(states.at(-1).fetchedAt, 999);
  assert.deepEqual(states.at(-1).arrivals, []);
  feed.stop();
});

test('feed: a hidden page asks nothing on open, and the local cache survives broken storage', async () => {
  const timers = fakeTimers();
  const vis = fakeVisibility(true);
  let asked = 0;
  const feed = lib.createThanksFeed({ load: async () => { asked++; return null; }, timers, visibility: vis, save: () => {} });
  feed.start();
  await settle();
  assert.equal(asked, 0);
  assert.equal(timers.pending.size, 0);
  feed.stop();
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  assert.equal(lib.loadCachedThanks(broken), null);
  assert.doesNotThrow(() => lib.saveCachedThanks({ thanks: WALL }, broken));
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  lib.saveCachedThanks({ thanks: WALL, version: 'v', fetchedAt: 1 }, store);
  assert.equal(lib.loadCachedThanks(store).thanks.total, 9);
  store.setItem('sl-thanks', '{"thanks":{"people":"x"}}');
  assert.equal(lib.loadCachedThanks(store), null, 'a broken copy is ignored');
});

// ---- asking once -----------------------------------------------------------------------------------------------------

test('ask once: a supporter who never answered, not busy, not asked here before – and never again', () => {
  const me = (o = {}) => ({ id: 'u_1', thanksTier: 'supporter', privacy: { showOnThanks: null }, ...o });
  assert.equal(lib.shouldAskThanks({ signedIn: true, me: me() }), true);
  for (const tier of ['legend', 'plus', 'coffee']) assert.equal(lib.shouldAskThanks({ signedIn: true, me: me({ thanksTier: tier }) }), true, tier);
  assert.equal(lib.shouldAskThanks({ signedIn: true, me: me({ thanksTier: null }) }), false, 'no live support (or a gift): not asked');
  assert.equal(lib.shouldAskThanks({ signedIn: true, me: me({ privacy: { showOnThanks: false } }) }), false, 'said no');
  assert.equal(lib.shouldAskThanks({ signedIn: true, me: me({ privacy: { showOnThanks: true } }) }), false, 'said yes');
  assert.equal(lib.shouldAskThanks({ signedIn: true, me: me({ privacy: undefined }) }), false);
  assert.equal(lib.shouldAskThanks({ signedIn: false, me: me() }), false);
  assert.equal(lib.shouldAskThanks({ signedIn: true, me: me(), busy: true }), false, 'not during a game or another dialog');
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  assert.equal(lib.askedHere('u_1', store), false);
  lib.rememberAsked('u_1', store);
  assert.equal(lib.askedHere('u_1', store), true);
  assert.equal(lib.askedHere('u_2', store), false, 'per account');
  assert.equal(lib.shouldAskThanks({ signedIn: true, me: me(), askedBefore: lib.askedHere('u_1', store) }), false, 'asked on this computer: never again');
  assert.equal(lib.askedHere('u_1', { getItem: () => { throw new Error('x'); } }), false);
});

// ---- the local server's route against the fake service ------------------------------------------------------------

function routeOf(acc, method, path) {
  const r = acc.routes.find((x) => x.method === method && x.pattern.test(path));
  return (url = path, body) => {
    const u = new URL(url, 'http://127.0.0.1');
    const req = { headers: body ? { 'content-type': 'application/json' } : {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    return r.handler(req, u.pathname.match(r.pattern), u);
  };
}
function fakeRes() {
  const res = { status: 0, headers: null, body: null, writeHead(s, h) { res.status = s; res.headers = h; }, end(b) { res.body = b; } };
  return res;
}

test('/api/account/thanks: signed out works, only opted-in names, ETag to the service, ?have → unchanged, offline → stale', async () => {
  const lena = fake.addUser({ handle: 'lena', display_name: 'Lena', entitlement: { tier: 'patron', until: null, badges: ['plus', 'patron'] }, banner: 'night-train', frame: 'brass-ring', privacy: { show_on_thanks: true }, thanksSince: '2026-09' });
  const quiet = fake.addUser({ handle: 'quiet', display_name: 'Quiet Person', entitlement: { tier: 'plus', until: null, badges: ['plus'] } });
  const no = fake.addUser({ handle: 'nope', display_name: 'Said No', entitlement: { tier: 'supporter', until: null, badges: ['supporter'] }, privacy: { show_on_thanks: false } });
  const cup = fake.addUser({ handle: 'cup', display_name: 'Cup', coffee: true, privacy: { show_on_thanks: true }, banner: 'tall-grass' });
  fake.thanksAnonymous = { supporter: 4 };
  let clock = 1_800_000_000_000;
  const sent = [];
  const acc = createAccounts({ secure: null, port: () => 47114, env: { SLS_ACCOUNTS_URL: fake.base }, packaged: false, now: () => clock,
    fetchImpl: (url, opts) => { if (String(url).endsWith('/v1/thanks')) sent.push(opts?.headers?.['If-None-Match'] || null); return fetch(url, opts); } });
  const get = routeOf(acc, 'GET', '/api/account/thanks');

  const first = await get();
  assert.equal(first.stale, false);
  const w = first.thanks;
  const names = w.people.map((p) => p.name);
  assert.ok(names.includes('Lena') && names.includes('Cup'));
  assert.ok(!names.includes('Quiet Person') && !names.includes('Said No'), 'only who said yes');
  assert.ok(w.counts.supporter >= 5 && w.counts.plus >= 1 && w.counts.legend >= 1 && w.counts.coffee >= 1, 'everyone is counted');
  const l = w.people.find((p) => p.name === 'Lena');
  assert.equal(l.tier, 'legend');
  assert.equal(l.since, '2026-09');
  assert.equal(l.banner, 'night-train');
  const c = w.people.find((p) => p.name === 'Cup');
  assert.equal(c.banner, null, 'a souldew+ banner a coffee doesn’t cover is not shown');
  assert.ok(!JSON.stringify(w).includes(lena.id) || l.avatar.includes(encodeURIComponent(lena.id)), 'ids only inside the avatar address');
  assert.ok(!JSON.stringify(w).includes(lena.discord.id) && !JSON.stringify(w).includes('quiet') && !JSON.stringify(w).includes(no.handle));
  assert.equal(sent.length, 1);
  assert.equal(sent[0], null);

  // the page already shows this version
  assert.deepEqual(Object.keys(await get(`/api/account/thanks?have=${first.version}`)).sort(), ['fetchedAt', 'stale', 'unchanged', 'version']);
  assert.equal(sent.length, 1, 'within 30 s the service isn’t asked again');
  clock += 31000;
  const again = await get(`/api/account/thanks?have=${first.version}`);
  assert.equal(again.unchanged, true);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /^W\/"[A-Za-z0-9_-]+"$/, 'the service is asked with its ETag (304, no body)');

  // the service rebuilds its wall every minute with a new `updated`: same people, same counts → still unchanged (this
  // used to hang on the real clock's second – the page's version and the fake's ETag both included `updated`)
  fake.thanksUpdated = Date.parse('2026-11-19T18:00:00Z');
  clock += 31000;
  assert.equal((await get(`/api/account/thanks?have=${first.version}`)).unchanged, true);
  fake.thanksUpdated = Date.parse('2026-11-19T18:01:00Z');
  clock += 31000;
  assert.equal((await get(`/api/account/thanks?have=${first.version}`)).unchanged, true, 'a new build time alone changes nothing');
  fake.thanksUpdated = null;

  // someone opts in: the next read has them
  quiet.privacy.show_on_thanks = true;
  clock += 31000;
  const later = await get(`/api/account/thanks?have=${first.version}`);
  assert.ok(later.thanks.people.some((p) => p.name === 'Quiet Person'));
  assert.notEqual(later.version, first.version);

  // signed out the wall's own pictures may be shown – nothing else
  const res = fakeRes();
  await acc.avatar({ method: 'GET' }, res, new URL(`http://127.0.0.1${l.avatar}`));
  assert.equal(res.status, 200, 'a picture on the wall');
  const other = fake.addUser({ handle: 'other', display_name: 'Other' });
  const otherSrc = `${fake.base}/v1/avatars/${other.id}/${other.avatar_hash}.png?size=128`;
  const res2 = fakeRes();
  await acc.avatar({ method: 'GET' }, res2, new URL(`http://127.0.0.1/api/account/avatar?src=${encodeURIComponent(otherSrc)}`));
  assert.equal(res2.status, 404, 'not on the wall, signed out: not fetched');

  // the service is down: the last wall, marked stale
  fake.thanksDown = true;
  clock += 31000;
  const down = await get(`/api/account/thanks?have=${later.version}`);
  assert.equal(down.unchanged, true);
  assert.equal(down.stale, true);
  const full = await get('/api/account/thanks');
  assert.equal(full.stale, true);
  assert.ok(full.thanks.people.length > 0);
  fake.thanksDown = false;

  // a service before the wall: a clear "not yet" for a computer that never saw one
  fake.noThanks = true;
  const fresh = createAccounts({ secure: null, port: () => 47115, env: { SLS_ACCOUNTS_URL: fake.base }, packaged: false });
  await assert.rejects(() => routeOf(fresh, 'GET', '/api/account/thanks')(), (e) => e.status === 404 && e.code === 'thanksMissing');
  fake.noThanks = false;
  fake.thanksAnonymous = null;
  for (const u of [lena, quiet, no, cup, other]) fake.users.delete(u.id);
});

test('the opt-in round trip: signed in, PATCH privacy.showOnThanks reaches the service and comes back', async () => {
  const sup = fake.addUser({ handle: 'newfan', display_name: 'New Fan', entitlement: { tier: 'supporter', until: null, badges: ['supporter'] } });
  // the wall's reads can be held (a slow network): a read that started before the opt-in must not count as fresh after it
  let hold = null;
  let wallReads = 0;
  const fetchImpl = async (url, opts) => {
    if (String(url).endsWith('/v1/thanks')) {
      wallReads++;
      if (hold) await hold.promise;
    }
    return fetch(url, opts);
  };
  const acc = createAccounts({ secure: null, port: () => 47116, env: { SLS_ACCOUNTS_URL: fake.base, SLS_ACCOUNTS_DEV_ENT_KEY: fake.ent.publicKey }, packaged: false, fetchImpl });
  const { url } = acc.session.startLogin();
  fake.nextLogin = sup.id;
  const loc = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await acc.session.finishLogin({ code: loc.searchParams.get('code'), state: loc.searchParams.get('state') });
  const me = await routeOf(acc, 'GET', '/api/account')();
  assert.equal(me.me.thanksTier, 'supporter');
  assert.equal(me.me.privacy.showOnThanks, null, 'never answered → the app asks once');
  // a look at the wall is under way (held) when the player opts in
  const wallRoute = routeOf(acc, 'GET', '/api/account/thanks');
  hold = Promise.withResolvers();
  const slow = wallRoute();
  const reads = async (n) => {
    for (let i = 0; i < 500 && wallReads < n; i++) await new Promise((r) => setImmediate(r));
    return wallReads;
  };
  assert.equal(await reads(1), 1);
  const after = await routeOf(acc, 'PATCH', '/api/account/me')('/api/account/me', { privacy: { showOnThanks: true } });
  assert.equal(after.privacy.showOnThanks, true);
  assert.equal(sup.privacy.show_on_thanks, true);
  // the next look doesn't wait on (or reuse) the read from before the change: it asks again
  const next = wallRoute();
  assert.equal(await reads(2), 2, 'a new read, not the one from before the change');
  hold.resolve();
  hold = null;
  await slow;
  const wall = await next;
  assert.ok(wall.thanks.people.some((p) => p.name === 'New Fan'), 'the wall is read again after the change');
  assert.ok((await wallRoute()).thanks.people.some((p) => p.name === 'New Fan'), 'and the older read finishing late doesn’t bring the old wall back');
  const off = await routeOf(acc, 'PATCH', '/api/account/me')('/api/account/me', { privacy: { showOnThanks: false } });
  assert.equal(off.privacy.showOnThanks, false);
  acc.close();
  fake.users.delete(sup.id);
});
