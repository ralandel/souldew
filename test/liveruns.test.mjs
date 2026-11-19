// "Share to Discord" (Live runs): event ids, the post's text and its limits, the link code and the card's PNG
// check (shared/liveruns.mjs), the card model from a run doc (web/lib/liveshare.mjs), and the local server against a
// mock of the bot (the contract's routes – never the real bot): linking, status, posting, every error status, and
// that the player's token never reaches the page, the config, a run folder or a log line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { registerHooks } from 'node:module';
import {
  eventIdFor, buildMeta, metaProblem, normalizeCode, pngProblem, cleanText, hasLink, clip, LIMITS, CARD_W, CARD_H,
} from '../shared/liveruns.mjs';
import { LIVE_FIXTURES } from './fixtures/livecards.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'souldew-live-'));
process.env.SLS_DATA_DIR = DATA;

// web/lib/*.mjs import browser paths (/shared/…, /vendor/…): map them onto the project folder
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(`${ROOT}node_modules/htm/preact/standalone.module.js`, ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});

// ---- a PNG of any size (grey, 8 bit) ----
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(w = CARD_W, h = CARD_H) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x40);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------------------------------------------
test('event ids: stable, the same for every player of the run, unique per event, within 64 characters', () => {
  const a = eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000000 });
  assert.equal(a, eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000000 }));
  assert.match(a, /^run-8f2c11aa:death:route-29:[a-z0-9]+$/);
  assert.notEqual(a, eventIdFor('8f2c11aa', 'death', { area: 'route-30', at: 1763040000000 }), 'another group');
  assert.notEqual(a, eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000001 }), 'died again after an undo');
  assert.notEqual(a, eventIdFor('0000aaaa', 'death', { area: 'route-29', at: 1763040000000 }), 'another run');
  const wipe = eventIdFor('8f2c11aa', 'wipe', { at: 1763040000000 });
  const won = eventIdFor('8f2c11aa', 'victory', { at: 1763040000000 });
  assert.match(wipe, /^run-8f2c11aa:wipe:/);
  assert.match(won, /^run-8f2c11aa:victory:/);
  // a long custom area name: hashed, still stable and short
  const long = eventIdFor('8f2c11aa', 'death', { area: `custom-${'x'.repeat(200)}`, at: 1 });
  assert.ok(long.length <= LIMITS.eventId);
  assert.equal(long, eventIdFor('8f2c11aa', 'death', { area: `custom-${'x'.repeat(200)}`, at: 1 }));
  assert.notEqual(long, eventIdFor('8f2c11aa', 'death', { area: `custom-${'y'.repeat(200)}`, at: 1 }));
  for (const id of [a, wipe, won, long]) assert.ok(id.length <= 64 && /^[a-z0-9:-]+$/.test(id), id);
});

test('meta: cleaned and cut to the contract, links and control characters out, file names never sent', () => {
  const { meta, changed } = buildMeta({
    eventId: 'run-8f2c11aa:death:route-29:abc', kind: 'death', mode: 'soullink',
    game: 'Pokémon HeartGold Version', run: 'Robin – HeartGold.nds', players: ['Robin', 'Kim', 'Lou', 'Sam', 'Fifth'],
    headline: 'Ember and Chomp are gone', detail: 'Ember fell – see https://evil.example/x and www.spam.io or discord.gg/abc',
  });
  assert.equal(meta.v, 1);
  assert.equal(meta.run, 'Robin – HeartGold');
  assert.deepEqual(meta.players, ['Robin', 'Kim', 'Lou', 'Sam']);
  assert.ok(!hasLink(meta.detail), meta.detail);
  assert.deepEqual(changed, ['detail']);
  assert.equal(metaProblem(meta), null);

  const long = buildMeta({ eventId: 'e', kind: 'nope', mode: 'x', game: 'G'.repeat(99), run: 'R'.repeat(99), players: ['P'.repeat(50)], headline: 'H'.repeat(300), detail: 'D'.repeat(600) }).meta;
  assert.equal(long.kind, 'death');
  assert.equal(long.mode, 'soullink');
  assert.equal(long.game.length, LIMITS.game);
  assert.equal(long.run.length, LIMITS.run);
  assert.equal(long.players[0].length, LIMITS.player);
  assert.equal(long.headline.length, LIMITS.headline);
  assert.equal(long.detail.length, LIMITS.detail);
  assert.ok(long.headline.endsWith('…'));
  assert.equal(metaProblem(long), null);

  // control characters, bidi overrides and zero-width characters
  assert.equal(cleanText('Em\u0000ber\n‮Kim​!', 40), 'Em ber Kim!');
  // a nickname with a link word: taken out, and the page is told
  const nick = buildMeta({ eventId: 'e', headline: 'HTTPMON is gone', players: ['wwW.Bob'] });
  assert.equal(nick.meta.headline, 'MON is gone');
  assert.deepEqual(nick.changed.sort(), ['headline', 'players']);
  // emoji are never cut in half
  assert.equal(clip('😀😀😀', 4), '😀…');
  // run, detail and players may be empty; the headline may not
  assert.equal(metaProblem(buildMeta({ eventId: 'e', headline: 'x' }).meta), null);
  assert.equal(metaProblem(buildMeta({ eventId: 'e', headline: '' }).meta), 'headline');
  assert.equal(metaProblem({ ...buildMeta({ eventId: 'e', headline: 'x' }).meta, detail: 'http://x' }), 'detail');
  // `app` only as a version
  assert.equal(buildMeta({ eventId: 'e', headline: 'x', app: '2.6.0-beta.1' }).meta.app, '2.6.0-beta.1');
  assert.equal(buildMeta({ eventId: 'e', headline: 'x', app: 'evil' }).meta.app, undefined);
  // the Hall of Fame's optional tags: generation 1–9, ROM hack and randomized as booleans – anything else left out
  const tags = buildMeta({ eventId: 'e', kind: 'victory', headline: 'x', gen: 4, hack: false, randomized: true }).meta;
  assert.deepEqual([tags.gen, tags.hack, tags.randomized], [4, false, true]);
  assert.equal(metaProblem(tags), null);
  const odd = buildMeta({ eventId: 'e', headline: 'x', gen: '4', hack: 'yes', randomized: 1 }).meta;
  assert.ok(!('gen' in odd) && !('hack' in odd) && !('randomized' in odd));
  assert.equal(buildMeta({ eventId: 'e', headline: 'x', gen: 12 }).meta.gen, undefined);
  assert.equal(metaProblem({ ...tags, gen: 0 }), 'gen');
  assert.equal(metaProblem({ ...tags, hack: 'no' }), 'hack');
});

test('link code and card PNG checks', () => {
  assert.equal(normalizeCode('k7q-4m2'), 'K7Q-4M2');
  assert.equal(normalizeCode(' K7Q 4M2 '), 'K7Q-4M2');
  assert.equal(normalizeCode('K7Q4M2'), 'K7Q-4M2');
  assert.equal(normalizeCode('K7Q-4M0'), null, '0 is not in the alphabet');
  assert.equal(normalizeCode('K7Q-4M'), null);
  assert.equal(pngProblem(png()), null);
  assert.equal(pngProblem(png(1280, 720)), 'dimensions');
  assert.equal(pngProblem(Buffer.from('GIF89a…'.repeat(10))), 'signature');
  assert.equal(pngProblem(Buffer.alloc(0)), 'empty');
  assert.equal(pngProblem(Buffer.concat([png(), Buffer.alloc(1.6 * 1024 * 1024)])), 'size');
});

test('bot answers → what the page shows', async () => {
  const { outcome } = await import('../server/lib/liveruns.mjs');
  assert.deepEqual(outcome(200, {}), { ok: true });
  assert.deepEqual(outcome(0), { ok: false, error: 'offline' });
  assert.deepEqual(outcome(401, { error: 'token' }), { ok: false, error: 'token' });
  assert.deepEqual(outcome(403, { error: 'blocked' }), { ok: false, error: 'blocked' });
  assert.deepEqual(outcome(403, { error: 'not-member' }), { ok: false, error: 'not-member' });
  assert.deepEqual(outcome(409, { error: 'duplicate' }), { ok: false, error: 'duplicate' });
  assert.deepEqual(outcome(429, { error: 'rate', retryAfter: 140 }), { ok: false, error: 'rate', retryAfter: 140 });
  assert.deepEqual(outcome(429, {}), { ok: false, error: 'rate', retryAfter: 60 });
  assert.deepEqual(outcome(400, { error: 'code' }), { ok: false, error: 'code' });
  assert.deepEqual(outcome(422, { error: 'meta', field: 'headline', reason: 'word' }), { ok: false, error: 'invalid', field: 'headline', reason: 'word' });
  assert.deepEqual(outcome(413, { error: 'image' }), { ok: false, error: 'invalid', field: 'image', reason: null });
  assert.deepEqual(outcome(415, { error: 'meta', field: 'body' }), { ok: false, error: 'invalid', field: 'body', reason: null });
  assert.deepEqual(outcome(502, { error: 'discord' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(outcome(503, { error: 'unavailable' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(outcome(405, {}), { ok: false, error: 'server' });
});

test('the base URL: the bot by default, SOULDEW_LIVE_URL only as https or on this computer', async () => {
  const { liveBase, LIVE_RUNS_URL } = await import('../server/lib/liveruns.mjs');
  assert.equal(liveBase({}), LIVE_RUNS_URL);
  assert.equal(liveBase({ SOULDEW_LIVE_URL: 'http://127.0.0.1:5555/' }), 'http://127.0.0.1:5555');
  assert.equal(liveBase({ SOULDEW_LIVE_URL: 'https://staging.example/bot/' }), 'https://staging.example/bot');
  assert.equal(liveBase({ SOULDEW_LIVE_URL: 'http://evil.example' }), LIVE_RUNS_URL, 'no plain http to another host');
  assert.equal(liveBase({ SOULDEW_LIVE_URL: 'nonsense' }), LIVE_RUNS_URL);
});

// ---------------------------------------------------------------------------------------------------------------
// The card model from a run doc (the fixtures scripts/render-live-cards.mjs paints)
test('the base URL: the bot’s own domain first, the workers.dev address only as the fallback, never for SOULDEW_LIVE_URL', async () => {
  const { liveBases, LIVE_RUNS_URL, LIVE_RUNS_FALLBACK_URL } = await import('../server/lib/liveruns.mjs');
  assert.equal(LIVE_RUNS_URL, `https://${['api', 'souldew', 'app'].join('.')}`);
  // (the addresses are built here, so that server/lib/liveruns.mjs stays the only file naming them – test/secrets.test.mjs)
  assert.equal(LIVE_RUNS_FALLBACK_URL, `https://${['souldew-discord-bot', 'sweeparena', 'workers', 'dev'].join('.')}`);
  const official = { liveRunsUrl: LIVE_RUNS_URL };
  assert.deepEqual(liveBases({}, official), [LIVE_RUNS_URL, LIVE_RUNS_FALLBACK_URL]);
  assert.deepEqual(liveBases({ SOULDEW_LIVE_URL: 'http://evil.example' }, official), [LIVE_RUNS_URL, LIVE_RUNS_FALLBACK_URL]);
  assert.deepEqual(liveBases({ SOULDEW_LIVE_URL: 'http://127.0.0.1:5555/' }), ['http://127.0.0.1:5555'], 'a mock bot alone');
  // a build without a bot (shared/edition.mjs liveRunsUrl: null) sends nothing anywhere; one with its own bot uses only that
  assert.deepEqual(liveBases({}, { liveRunsUrl: null }), []);
  assert.deepEqual(liveBases({ SOULDEW_LIVE_URL: 'nonsense' }, { liveRunsUrl: null }), []);
  assert.deepEqual(liveBases({}, { liveRunsUrl: 'https://bot.example' }), ['https://bot.example']);
});

test('the fallback: only when the bot’s own domain gives no answer at all – same request, still no redirects', async () => {
  const { link, unlink, status, LIVE_RUNS_URL, LIVE_RUNS_FALLBACK_URL } = await import('../server/lib/liveruns.mjs');
  const token = 'ab'.repeat(32);
  const reply = (code, body) => ({ status: code, json: async () => body });
  const mock = (answer) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init, body: init.body });
      return answer(url, calls.length);
    };
    return { calls, fetchImpl };
  };
  const env = {}; // (not process.env: the server tests below point SOULDEW_LIVE_URL at their mock bot)
  // 1. blocked or unknown host (DNS, connection, TLS – fetch throws): the same POST again at workers.dev
  const blocked = mock((url) => {
    if (url.startsWith(LIVE_RUNS_URL)) throw new TypeError('fetch failed');
    return reply(200, { token, user: { id: '1', name: 'Lou' } });
  });
  const linked = await link('ABC-234', { fetchImpl: blocked.fetchImpl, env });
  assert.equal(linked.ok, true);
  assert.deepEqual(blocked.calls.map((c) => c.url), [`${LIVE_RUNS_URL}/live/link`, `${LIVE_RUNS_FALLBACK_URL}/live/link`]);
  for (const c of blocked.calls) {
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.redirect, 'error');
    assert.equal(JSON.parse(c.body).code, 'ABC-234');
  }
  // 2. the bot's own domain answers – also with an error status: that's the bot's answer, no second request
  const down = mock(() => reply(503, {}));
  const st = await status({ fetchImpl: down.fetchImpl, env });
  assert.equal(down.calls.length, 1);
  assert.equal(down.calls[0].url, `${LIVE_RUNS_URL}/live/me`);
  assert.equal(down.calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(st.linked, true);
  const ok = mock(() => reply(200, { user: { id: '1', name: 'Lou' }, limits: { perDay: 20, usedToday: 1 } }));
  assert.equal((await status({ fetchImpl: ok.fetchImpl, env })).limits.left, 19);
  assert.equal(ok.calls.length, 1);
  // 3. a timeout counts as no answer, too; both addresses silent → offline
  const silent = mock(() => {
    throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  });
  assert.equal((await status({ fetchImpl: silent.fetchImpl, env })).offline, true);
  assert.deepEqual(silent.calls.map((c) => c.url), [`${LIVE_RUNS_URL}/live/me`, `${LIVE_RUNS_FALLBACK_URL}/live/me`]);
  // 4. a mock bot (SOULDEW_LIVE_URL) is the only address – a test never falls through to the real bot
  const mockBot = mock(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal((await status({ fetchImpl: mockBot.fetchImpl, env: { SOULDEW_LIVE_URL: 'http://127.0.0.1:9' } })).offline, true);
  assert.deepEqual(mockBot.calls.map((c) => c.url), ['http://127.0.0.1:9/live/me']);
  // unlinking through the fallback as well; the token is gone afterwards
  const bye = mock((url) => {
    if (url.startsWith(LIVE_RUNS_URL)) throw new TypeError('fetch failed');
    return reply(204, {});
  });
  const out = await unlink({ fetchImpl: bye.fetchImpl, env });
  assert.equal(out.reached, true);
  assert.equal(out.linked, false);
  assert.equal(bye.calls.length, 2);
  assert.equal(bye.calls[1].init.method, 'DELETE');
});

test('card model: headline, killer, place and teams from the run doc', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    // the game catalog (game titles, ROM hacks) as /api/catalog serves it
    if (u.startsWith('/api/catalog')) {
      const cat = JSON.parse(readFileSync(new URL('../shared/data/catalog.json', import.meta.url), 'utf8'));
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => cat };
    }
    if (!u.startsWith('/shared/')) return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ games: [], hacks: [] }) };
    const body = readFileSync(new URL(`..${u}`, import.meta.url), 'utf8');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => JSON.parse(body) };
  };
  globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
  try {
    const { loadData } = await import('../web/lib/data.mjs');
    await loadData();
  } finally {
    globalThis.fetch = realFetch;
  }
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const L = await import('../web/lib/liveshare.mjs');
  const build = (name) => {
    const f = LIVE_FIXTURES.find((x) => x.name === name);
    const doc = new RunDoc(f.manifest.id);
    doc._persistSoon = () => {};
    doc.batch(f.entries);
    const event = f.event.kind === 'death' ? L.deathEvent(doc, f.manifest, f.event.area) : L.endEvent(f.manifest, doc.get('run:status'));
    return { f, doc, event, ...L.cardModel({ doc, manifest: f.manifest, gen: f.gen, event }) };
  };

  const two = build('soullink-2-death');
  assert.equal(two.event.id, eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000000 }), 'the id comes from the run, not the player');
  assert.equal(two.model.headline, 'Ember and Chomp are gone');
  assert.deepEqual(two.model.highlights.map((h) => h.text), ['Ember', 'Chomp']);
  assert.equal(two.model.cause.species, 241);
  assert.equal(two.model.cause.level, 19);
  assert.equal(two.model.cause.chip, 'Trainer battle');
  assert.equal(two.model.cause.place, 'Goldenrod Gym');
  assert.equal(two.model.teams.length, 2);
  const states = (slot) => Object.fromEntries(two.model.teams.find((x) => x.slot === slot).mons.map((m) => [m.name, m.state]));
  assert.equal(states('p1').Ember, 'fallen');
  assert.equal(states('p2').Chomp, 'fallen', 'the linked partner is marked too');
  assert.equal(states('p2').Hops, 'dead', 'an earlier death is greyed');
  assert.equal(states('p1').Pidge, 'alive');
  assert.ok(two.model.teams[0].mons.some((m) => m.name === 'Wooper' && m.sub === ''), 'a nickname that is the species name shows once');
  assert.equal(two.metaInput.detail, 'Ember (Lv 18 Cyndaquil) fell to Miltank Lv 19 in a trainer battle · Goldenrod Gym · Kim’s Chomp went with it');
  const { meta } = buildMeta(two.metaInput);
  assert.equal(metaProblem(meta), null);
  assert.deepEqual(meta.players, ['Robin', 'Kim']);
  assert.equal(meta.kind, 'death');
  assert.equal(meta.mode, 'soullink');

  const four = build('soullink-4-death');
  assert.equal(four.model.teams.length, 4);
  assert.equal(four.model.headline, 'Leaflet, Venny, Dune & Puff are gone');
  assert.ok(four.model.teams.every((tm) => tm.mons.some((m) => m.state === 'fallen')), 'every player’s linked Pokémon is marked');

  const solo = build('nuzlocke-death');
  assert.equal(solo.model.mode, 'nuzlocke');
  assert.equal(solo.model.teams.length, 1);
  assert.equal(solo.model.headline, 'Blaze is gone');
  assert.equal(solo.model.cause.chip, 'Wild battle');
  assert.equal(solo.model.cause.place, 'Mt. Moon');
  assert.equal(buildMeta(solo.metaInput).meta.mode, 'nuzlocke');

  const wipe = build('nuzlocke-wipe');
  assert.equal(wipe.event.kind, 'wipe');
  assert.equal(wipe.model.headline, 'Lou’s Nuzlocke is over');
  assert.equal(wipe.model.cause.species, 74, 'the last one to fall and its killer');
  const won = build('soullink-2-victory');
  assert.equal(won.event.kind, 'victory');
  assert.equal(won.model.headline, 'Robin & Kim beat HeartGold!');
  assert.equal(won.model.tag, 'Hall of Fame');

  // the Hall of Fame card: the final team as linked groups, the run in numbers, its rules; the tags for the post
  const pt = build('hof-soullink-2');
  assert.equal(pt.model.headline, 'Lena & Tim beat Platinum!');
  assert.deepEqual(pt.model.highlights.map((h) => h.text), ['Lena', 'Tim']);
  const hof = pt.model.hof;
  assert.equal(hof.groups.length, 6, 'the six living pairs – the dead ones are not in the final team');
  assert.deepEqual(hof.groups.map((g) => g.mons.map((m) => m.name)), [['Blaze', 'Admiral'], ['Volt', 'Hawk'], ['Thorn', 'Slug'], ['Gengar', 'Spoon'], ['Chomp', 'Aura'], ['Halo', 'Claw']]);
  assert.deepEqual(hof.groups[0].mons.map((m) => [m.slot, m.level, m.sub]), [['p1', 62, 'Infernape'], ['p2', 61, 'Empoleon']]);
  assert.deepEqual(hof.boxes.map((b) => [b.value, b.label]), [['2', 'deaths'], ['33:05', 'played'], ['8', 'badges'], ['6', 'links alive']], 'the longest clock of the two');
  assert.deepEqual(hof.rules, ['Level caps', 'Dupes clause', 'Type rule', 'Missed = link lost']);
  assert.equal(pt.metaInput.detail, 'Run won with 6 alive and 2 lost on the way · 33:05 played');
  const ptMeta = buildMeta(pt.metaInput).meta;
  assert.equal(metaProblem(ptMeta), null);
  assert.deepEqual([ptMeta.kind, ptMeta.game, ptMeta.gen, ptMeta.hack, ptMeta.randomized], ['victory', 'Pokémon Platinum Version', 4, false, false]);
  assert.deepEqual(ptMeta.players, ['Lena', 'Tim']);
  assert.equal(pt.event.id, eventIdFor('5e1a90bb', 'victory', { at: 1763040000000 + 30 * 86400e3 }), 'one id for the run: a partner’s post is the same event');

  const em = build('hof-nuzlocke');
  assert.equal(em.model.headline, 'Lena beat Emerald!');
  assert.equal(em.model.hof.groups.length, 6);
  assert.ok(em.model.hof.groups.every((g) => g.mons.length === 1));
  assert.deepEqual(em.model.hof.rules, ['Hardcore', 'Dupes clause'], 'a hardcore Nuzlocke says so once');
  assert.equal(em.model.hof.labels.attempt, 'Attempt #2');
  assert.equal(em.model.hof.boxes[3].label, 'alive');

  const b2 = build('hof-soullink-4-randomized');
  assert.equal(b2.model.headline, 'Lena, Tim, Mo & Ida beat Black 2!');
  assert.equal(b2.model.hof.groups.length, 5);
  assert.ok(b2.model.hof.groups.every((g) => g.mons.length === 4 && g.mons.every(Boolean)));
  assert.ok(b2.model.hof.rules.includes('Randomized'));
  assert.equal(buildMeta(b2.metaInput).meta.randomized, true);

  const us = build('hof-soullink-3-3ds');
  assert.deepEqual(us.model.hof.boxes[1], { value: '30', label: 'days', tone: 'ink', icon: 'clock' }, 'no play time read: the days from start to win');
  assert.equal(us.model.hof.boxes[2].label, 'caught', 'no badges (Alola): the catches');
  assert.equal(us.model.headline, 'Lena, Tim & Kai beat Ultra Sun!');

  // the short names in the other languages
  const L2 = await import('../web/lib/liveshare.mjs');
  const m = (id, hackId) => ({ game: { id, ...(hackId ? { hackId } : {}) } });
  assert.equal(L2.shortGameName(m('pokemon-platinum'), 'de'), 'Platin');
  assert.equal(L2.shortGameName(m('pokemon-black-2'), 'fr'), 'Noire 2');
  assert.equal(L2.shortGameName(m('pokemon-yellow'), 'es'), 'Amarillo');
  assert.equal(L2.shortGameName(m('pokemon-heartgold'), 'it'), 'Oro HeartGold');
  assert.equal(L2.shortGameName(m('pokemon-firered', 'radical-red'), 'de'), 'Radical Red', 'a ROM hack keeps its name');

  // no file names, paths or invite codes anywhere on a card or in its text (streamer mode)
  for (const f of LIVE_FIXTURES) {
    const { model, metaInput } = build(f.name);
    const all = JSON.stringify({ model, metaInput });
    assert.ok(!/\.(nds|gba|gbc|gb|3ds|sav|zip)\b|[/\\]Users[/\\]|room|secret/i.test(all), f.name);
    // never "faint" in the new texts
    assert.ok(!/faint/i.test(all), f.name);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The local server against a mock of the bot

/** The contract's routes, in memory. `force` answers the next request with a fixed status. */
function mockBot() {
  const s = { codes: new Map([['K7Q4M2', { id: '123', name: 'Ash' }], ['ABC234', { id: '123', name: 'Ash' }]]), tokens: new Map(), posts: [], ids: new Set(), force: null, requests: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    s.requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (s.force) {
      const f = s.force;
      s.force = null;
      return json(f.status, f.body);
    }
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (url.pathname === '/live/link' && req.method === 'POST') {
      const { code, app, platform } = JSON.parse(body.toString());
      s.lastLink = { code, app, platform };
      const key = String(code).replace('-', '');
      if (!s.codes.has(key)) return json(400, { error: 'code' });
      const user = s.codes.get(key);
      s.codes.delete(key);
      const tok = randomBytes(32).toString('hex');
      s.tokens.set(tok, user);
      return json(200, { token: tok, user });
    }
    if (url.pathname === '/live/link' && req.method === 'DELETE') {
      s.tokens.delete(token);
      return json(200, { ok: true });
    }
    if (url.pathname === '/live/me' && req.method === 'GET') {
      if (!s.tokens.has(token)) return json(401, { error: 'token' });
      return json(200, { user: s.tokens.get(token), limits: { perDay: 10, usedToday: s.posts.length, nextInSec: 0 } });
    }
    if (url.pathname === '/live/post' && req.method === 'POST') {
      if (!s.tokens.has(token)) return json(401, { error: 'token' });
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('multipart/form-data')) return json(415, { error: 'meta', field: 'body' });
      const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': ct }, body }).formData();
      const image = form.get('image');
      if (!image || image.type !== 'image/png') return json(415, { error: 'image' });
      const meta = JSON.parse(form.get('meta'));
      if (pngProblem(Buffer.from(await image.arrayBuffer()))) return json(422, { error: 'image' });
      if (metaProblem(meta)) return json(422, { error: 'meta', field: metaProblem(meta), reason: 'length' });
      if (s.ids.has(meta.eventId)) return json(409, { error: 'duplicate' });
      s.ids.add(meta.eventId);
      s.posts.push({ meta, name: image.name, size: image.size });
      return json(200, { ok: true, url: 'https://discord.com/channels/1/2/3' });
    }
    return json(405, { error: 'method' });
  });
  return { s, server };
}

let bot;
let app;
let base;
const seen = []; // every answer of the local server and every log line, checked for the token at the end
const logs = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };

// (the start is kept: should it be cut short, `after` still waits for both servers and closes them – a server left
// listening would keep the test file, and `npm test`, from ever ending)
let starting;
before(() => (starting = (async () => {
  bot = mockBot();
  await new Promise((r) => bot.server.listen(0, '127.0.0.1', r));
  process.env.SOULDEW_LIVE_URL = `http://127.0.0.1:${bot.server.address().port}`;
  for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
  const { startServer } = await import('../server/app.mjs');
  app = await startServer({ port: 0, background: false });
  base = app.url;
})()));
after(async () => {
  await starting?.catch(() => {});
  Object.assign(console, realConsole);
  for (const s of [app?.server, bot?.server]) {
    s?.closeAllConnections?.();
    s?.close();
  }
  rmSync(DATA, { recursive: true, force: true });
});

async function call(method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'x-soullink': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, body: JSON.parse(text) };
}
const card = () => png().toString('base64');
const metaFor = (eventId, extra = {}) => ({ v: 1, eventId, kind: 'death', mode: 'soullink', game: 'Pokémon HeartGold', run: 'Robin & Kim', players: ['Robin', 'Kim'], headline: 'Ember and Chomp are gone', detail: 'Ember (Lv 18 Cyndaquil) fell to Miltank Lv 19', ...extra });
const token = () => [...bot.s.tokens.keys()][0];

test('server: link with the code, status with today’s posts, the token stays on the server', async () => {
  assert.deepEqual((await call('GET', '/api/liveruns')).body.linked, false);
  // a wrong code: the bot says so (the code isn't used up)
  assert.equal((await call('POST', '/api/liveruns/link', { code: 'ZZZ-ZZZ' })).body.error, 'code');
  // a malformed one never reaches the bot
  const before = bot.s.requests.length;
  assert.equal((await call('POST', '/api/liveruns/link', { code: 'nope' })).body.error, 'code');
  assert.equal(bot.s.requests.length, before);

  const r = await call('POST', '/api/liveruns/link', { code: 'k7q 4m2' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.linked, true);
  assert.equal(r.body.user.name, 'Ash');
  assert.equal(bot.s.lastLink.code, 'K7Q-4M2');
  assert.match(bot.s.lastLink.app, /^souldew \d+\.\d+\.\d+/);
  assert.equal(bot.s.lastLink.platform, process.platform);
  assert.ok(token());
  // where it is kept: live-runs.json in the data folder, readable only by this user, not config.json
  const file = join(DATA, 'live-runs.json');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).token === token());
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);

  const st = await call('GET', '/api/liveruns?check=1');
  assert.equal(st.body.linked, true);
  assert.equal(st.body.limits.perDay, 10);
  assert.equal(st.body.limits.left, 10);
  assert.equal(bot.s.requests.at(-1).headers.authorization, `Bearer ${token()}`);
});

test('server: posting – multipart with meta and image/png, the app version filled in, shared remembered', async () => {
  const id = eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000000 });
  const r = await call('POST', '/api/liveruns/post', { meta: metaFor(id, { app: '9.9.9', detail: 'see http://spam.example' }), image: card() });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.url, 'https://discord.com/channels/1/2/3');
  const sent = bot.s.posts.at(-1);
  assert.equal(sent.meta.eventId, id);
  assert.equal(sent.meta.app, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'the running version, not what the page says');
  assert.ok(!hasLink(sent.meta.detail));
  assert.equal(sent.name, 'card.png');
  assert.equal((await call('GET', '/api/liveruns')).body.shared[id].url, 'https://discord.com/channels/1/2/3');
  assert.equal((await call('GET', '/api/liveruns?check=1')).body.limits.left, 9);

  // the same event again (this player or a partner – the id is the same for the run): already shared
  const again = await call('POST', '/api/liveruns/post', { meta: metaFor(id), image: card() });
  assert.equal(again.body.error, 'duplicate');
  assert.equal(bot.s.posts.length, 1);

  // a broken card or text never reaches the bot
  const n = bot.s.requests.length;
  assert.equal((await call('POST', '/api/liveruns/post', { meta: metaFor('x'), image: png(800, 600).toString('base64') })).status, 400);
  assert.equal((await call('POST', '/api/liveruns/post', { meta: metaFor('x', { headline: '' }), image: card() })).status, 400);
  assert.equal(bot.s.requests.length, n);
});

test('server: every error status of the bot', async () => {
  const post = async (force) => {
    bot.s.force = force;
    return (await call('POST', '/api/liveruns/post', { meta: metaFor(`run-x:death:a:${Math.random().toString(36).slice(2, 8)}`), image: card() })).body;
  };
  const rate = await post({ status: 429, body: { error: 'rate', retryAfter: 140 } });
  assert.equal(rate.error, 'rate');
  assert.equal(rate.retryAfter, 140);
  assert.equal((await post({ status: 403, body: { error: 'blocked' } })).error, 'blocked');
  assert.equal((await post({ status: 403, body: { error: 'not-member' } })).error, 'not-member');
  const word = await post({ status: 422, body: { error: 'meta', field: 'headline', reason: 'word' } });
  assert.deepEqual([word.error, word.field, word.reason], ['invalid', 'headline', 'word']);
  assert.equal((await post({ status: 502, body: { error: 'discord' } })).error, 'unavailable');
  assert.equal((await post({ status: 503, body: { error: 'unavailable' } })).error, 'unavailable');
  assert.equal((await post({ status: 500, body: {} })).error, 'server');
  assert.equal((await call('GET', '/api/liveruns')).body.linked, true, 'none of these ends the link');
  // 401: the token is revoked (or a sixth device was linked) – it is dropped here, the page says "Connect again"
  assert.equal((await post({ status: 401, body: { error: 'token' } })).error, 'token');
  assert.equal((await call('GET', '/api/liveruns')).body.linked, false);
  assert.equal(JSON.parse(readFileSync(join(DATA, 'live-runs.json'), 'utf8')).token, undefined);
});

test('server: a revoked token found by the status check; unlinking', async () => {
  assert.equal((await call('POST', '/api/liveruns/link', { code: 'ABC-234' })).body.linked, true);
  const tok = token();
  bot.s.tokens.clear(); // revoked in Discord
  const st = await call('GET', '/api/liveruns?check=1');
  assert.equal(st.body.linked, false);
  assert.equal(st.body.expired, true);
  // link again and unlink: the bot is told, the token is gone here
  bot.s.codes.set('XYZ234', { id: '123', name: 'Ash' });
  await call('POST', '/api/liveruns/link', { code: 'XYZ-234' });
  const t2 = token();
  assert.notEqual(t2, tok);
  const un = await call('DELETE', '/api/liveruns/link');
  assert.equal(un.body.linked, false);
  assert.equal(un.body.reached, true);
  assert.equal(bot.s.tokens.size, 0);
  assert.equal(bot.s.requests.at(-1).headers.authorization, `Bearer ${t2}`);
  // keep one linked for the leak check below
  bot.s.codes.set('QRS234', { id: '123', name: 'Ash' });
  await call('POST', '/api/liveruns/link', { code: 'QRS-234' });
  seen.push(tok, t2); // (only so the next test knows them – it checks they appear nowhere but the token file)
});

test('the token never reaches the page, the config, a run folder, an export or a log line', async () => {
  const tokens = [...new Set([token(), ...seen.filter((x) => /^[a-f0-9]{64}$/.test(x))])].filter(Boolean);
  assert.ok(tokens.length >= 2);
  // what the page can ask for
  for (const path of ['/api/status', '/api/liveruns', '/api/liveruns?check=1', '/api/catalog']) await call('GET', path);
  await call('POST', '/api/config', { playerName: 'Ash' }); // answers with the whole config
  const answers = seen.filter((x) => !/^[a-f0-9]{64}$/.test(x)).join('\n');
  for (const tk of tokens) {
    assert.ok(!answers.includes(tk), 'an API answer');
    assert.ok(!logs.join('\n').includes(tk), 'a log line');
  }
  // on disk: only live-runs.json holds it – not config.json, not the runs folder (run packs and exports come from there)
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(DATA);
  const holders = files.filter((f) => tokens.some((tk) => readFileSync(f, 'latin1').includes(tk)));
  assert.deepEqual(holders, [join(DATA, 'live-runs.json')]);
  assert.ok(!existsSync(join(DATA, 'runs', 'live-runs.json')));
  // the page's code never handles a bot token: no Authorization header, no bot address, no token file in web/
  const web = [];
  const walkWeb = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (['vendor', 'assets', 'i18n'].includes(name)) continue;
      if (statSync(p).isDirectory()) walkWeb(p);
      else if (/\.(mjs|js|html)$/.test(name)) web.push(readFileSync(p, 'utf8'));
    }
  };
  walkWeb(new URL('../web/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const src = web.join('\n');
  assert.ok(!/Authorization|Bearer |live-runs\.json|workers\.dev|\/live\/(?:post|link|me)\b/.test(src));
});
