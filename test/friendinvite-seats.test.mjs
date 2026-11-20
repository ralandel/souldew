// "Invite friends" on a run's invite panel offers only the seats still free (web/lib/friendinvite.mjs seatsLeft): the
// run's seats minus the ones somebody has and minus this app's invites that are open or already handed out a seat.
// Before, the picker let the host send up to three invites into any run – in a 2-seat run the extra friends found every
// seat gone after "Allow".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(new URL('node_modules/htm/preact/standalone.module.js', ROOT).href, ctx);
    return spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx);
  },
});
const { seatsLeft } = await import('../web/lib/friendinvite.mjs');

const run = (n, id = 'r1') => ({ id, mode: 'soullink', players: Object.fromEntries(['p1', 'p2', 'p3', 'p4'].slice(0, n).map((s) => [s, { name: s }])) });
const inv = (phase, slot = null, runId = 'r1') => ({ runId, state: { phase, ...(slot ? { seat: { slot } } : {}) } });

test('a fresh run: every seat but the host’s', () => {
  assert.equal(seatsLeft(run(2), ['p1'], []), 1);
  assert.equal(seatsLeft(run(3), ['p1'], []), 2);
  assert.equal(seatsLeft(run(4), ['p1'], []), 3);
});

test('open invites hold a seat; ended ones give it back; a seat handed out counts once', () => {
  assert.equal(seatsLeft(run(2), ['p1'], [inv('waiting')]), 0, 'a 2-seat run with one invite out is full');
  assert.equal(seatsLeft(run(4), ['p1'], [inv('waiting'), inv('request')]), 1);
  assert.equal(seatsLeft(run(4), ['p1'], [inv('expired'), inv('cancelled'), inv('error'), inv('locked'), inv('conflict')]), 3);
  assert.equal(seatsLeft(run(4), ['p1', 'p2'], [inv('done', 'p2')]), 2, 'Kim joined (p2, also known as taken) – not counted twice');
  assert.equal(seatsLeft(run(4), ['p1'], [inv('sending', 'p3'), inv('done', 'p2')]), 1, 'seats handed out but not yet seen');
  assert.equal(seatsLeft(run(4), ['p1'], [inv('done')]), 3, 'a finished invite without a seat hint holds nothing');
});

test('only this run’s invites count; never below zero; Nuzlocke and missing runs have none', () => {
  assert.equal(seatsLeft(run(3), ['p1'], [inv('waiting', null, 'other'), inv('waiting', null, 'other')]), 2);
  assert.equal(seatsLeft(run(2), ['p1', 'p2'], [inv('waiting'), inv('waiting')]), 0);
  assert.equal(seatsLeft({ id: 'n', mode: 'nuzlocke', players: { p1: {} } }, ['p1'], []), 0);
  assert.equal(seatsLeft(null), 0);
  assert.equal(seatsLeft(run(2), ['p9', 'p1'], []), 1, 'unknown slots are ignored');
});
