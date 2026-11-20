// A run opens without waiting for the scan of its game file (server/lib/romloc.mjs via GET /api/rom/locations): a DS
// game takes seconds, a slow PC the first time much longer – and the run's doc, its sync with the others and their link
// sessions all waited for it. A Windows partner joining a Platinum run over two computers stayed offline past the
// test's minute (scripts/link-e2e.mjs --join: "timeout: the page"); the ROM's own data now comes in afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunData } = await import('../web/lib/data.mjs');

const RUN = { id: 'a18fdf39', mode: 'soullink', game: { id: 'pokemon-platinum', system: 'nds' }, players: { p1: { name: 'A' }, p2: { name: 'B' } },
  outputs: { p2: { rom: 'B - POKEMON PL.nds', sha1: 'x' } } };
const SCAN = { types: { species: { 25: ['electric'] }, labels: {} }, species: null, vanilla: true, data: null };

/** fetch as the page sees it: the run's player data (none – not randomized) and the ROM scan, which may never answer. */
function fakeFetch({ scan = SCAN, hang = false } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('/api/rom/locations')) {
      if (hang) return new Promise(() => {});
      return new Response(JSON.stringify(scan), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'none' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls };
}

async function withFetch(f, body) {
  const old = globalThis.fetch;
  globalThis.fetch = f.fn;
  try {
    return await body();
  } finally {
    globalThis.fetch = old;
  }
}

test('run data without the ROM: load() is done while the scan of the game file never answers', async () => {
  const f = fakeFetch({ hang: true });
  const rd = await withFetch(f, () => Promise.race([
    new RunData().load(RUN, { rom: false }),
    new Promise((_, no) => setTimeout(() => no(new Error('load waited for the ROM scan')), 2000)),
  ]));
  assert.equal(rd.gen, 4);
  assert.equal(rd.romTypes, null);
  assert.equal(rd.romVanilla, null);
  assert.ok(!f.calls.some((u) => u.startsWith('/api/rom/locations')), 'no scan asked for');
});

test('run data: romFetch + withRom bring the ROM\'s own data in as a new object (what depends on it updates)', async () => {
  const f = fakeFetch({ scan: { ...SCAN, types: { species: { 25: ['fire'] }, labels: {} }, vanilla: false } });
  const rd = await withFetch(f, () => new RunData().load(RUN, { rom: false }));
  const j = await withFetch(f, () => rd.romFetch(RUN));
  assert.equal(f.calls.filter((u) => u.startsWith('/api/rom/locations')).length, 1);
  assert.match(f.calls.find((u) => u.startsWith('/api/rom/locations')), /B%2520-%2520POKEMON%2520PL\.nds/, 'this computer\'s own game file');
  const next = rd.withRom(j);
  assert.notEqual(next, rd);
  assert.ok(next instanceof RunData);
  assert.deepEqual(next.types(25, 'p2'), ['fire'], 'the game\'s own types');
  assert.equal(next.romVanilla, false);
  assert.equal(rd.romTypes, null, 'the old object is left as it was');
  assert.equal(next.gen, rd.gen);
  assert.equal(next.byId, rd.byId);
});

test('run data: load() with the ROM (the default) still reads it; no game file of this computer: nothing to scan', async () => {
  const f = fakeFetch();
  const rd = await withFetch(f, () => new RunData().load(RUN));
  assert.deepEqual(rd.types(25, 'p2'), ['electric']);
  assert.equal(rd.romVanilla, true);
  const g = fakeFetch();
  const none = await withFetch(g, () => new RunData().romFetch({ ...RUN, outputs: {} }));
  assert.equal(none, null);
  assert.ok(!g.calls.some((u) => u.startsWith('/api/rom/locations')));
});

test('the app opens a run without waiting for the ROM scan, and takes its result only for the same run', () => {
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  const open = app.slice(app.indexOf('const d = await new RunDoc(runId).load();'), app.indexOf('return () => {\n      cancelled = true;'));
  assert.match(open, /new RunData\(\)\.load\(m, \{ rom: false \}\)/);
  assert.ok(open.indexOf('setDoc(d)') < open.indexOf('rd.romFetch(m)'), 'the doc is there before the scan is asked for');
  assert.doesNotMatch(open, /await rd\.romFetch/);
  assert.match(open, /!cancelled && j\) setRunData\(\(cur\) => \(cur === rd \? rd\.withRom\(j\) : cur\)\)/);
});
