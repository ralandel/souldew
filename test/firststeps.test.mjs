// "First steps" can be put away: hidden everywhere (the card and the rail pill read the same remembered flag), every
// open step can be skipped, and "Show first steps again" (Settings › General, Help) brings all of it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const bus = new EventTarget();
let changes = 0;
globalThis.addEventListener ??= bus.addEventListener.bind(bus);
globalThis.removeEventListener ??= bus.removeEventListener.bind(bus);
globalThis.dispatchEvent ??= bus.dispatchEvent.bind(bus);
addEventListener('sl-firststeps-change', () => changes++);

const FS = await import('../web/views/firststeps.mjs');

test('hide: remembered, and every listener (card, rail pill, Settings, Help) hears it', () => {
  const before = changes;
  FS.hideFirstSteps();
  assert.equal(store.get('sl-firststeps-hidden'), 'true');
  assert.ok(changes > before, 'the pill re-renders and disappears with the card');
});

test('skip: a step that does not fit is set aside, once', () => {
  FS.skipFirstStep('partner');
  FS.skipFirstStep('partner');
  FS.skipFirstStep('catch');
  assert.deepEqual(JSON.parse(store.get('sl-firststeps-skipped')), ['partner', 'catch']);
});

test('"Show first steps again" brings the card, the pill and the skipped steps back', () => {
  FS.showFirstSteps();
  assert.equal(store.has('sl-firststeps-hidden'), false);
  assert.equal(store.has('sl-firststeps-skipped'), false);
});
