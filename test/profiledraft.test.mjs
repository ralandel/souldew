// The profile editor's session (web/lib/profiledraft.mjs, views/profileedit.mjs – design 3.0 "B · Parts drawer"): one
// draft for the whole edit, "n changes not saved", "Back to saved" per part, the trophy cabinet's places, Save sending
// only what changed – and never blocked by a souldew+ item tried on (that part stays as saved). Plus the leave guard
// (web/lib/leaveguard.mjs): leaving with unsaved changes asks once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const D = await import('../web/lib/profiledraft.mjs');
const { setLeaveGuard, leaveHeld } = await import('../web/lib/leaveguard.mjs');

const me = {
  name: 'Robin', status: 'grinding Victory Road', banner: 'plain-dusk', frame: null, nameplate: null, title: 'win-nuzlocke', accent: 'tide',
  showcase: { trophies: ['hardcore-win', 'badges16'], trusted: { species: 260, line: 258, note: 'carried me', teams: 5, topLevel: 58, fell: 1 }, trustedText: null, favoriteGame: 'Emerald' },
  showcaseLayout: undefined, privacy: { profile: 'friends', presence: 'friends', showRuns: true },
};

test('the draft starts from the saved profile: three places, the line without its numbers, the display case by default', () => {
  const d = D.draftFrom(me);
  assert.deepEqual(d.trophies, ['hardcore-win', 'badges16', null]);
  assert.deepEqual(d.trusted, { species: 260, line: 258 });
  assert.equal(d.note, 'carried me');
  assert.equal(d.layout, 'case', 'no layout from the service: the display case');
  assert.equal(D.draftFrom({ ...me, showcaseLayout: 'shelf' }).layout, 'shelf');
  assert.equal(D.draftFrom({ ...me, showcaseLayout: 'compact' }).layout, 'case', 'an unknown layout: the default');
  assert.deepEqual([d.vis, d.runs, d.presence], ['friends', true, 'friends']);
  // the old free-text "most trusted" is kept as it was until a line replaces it
  const old = D.draftFrom({ ...me, showcase: { trophies: [], trusted: null, trustedText: 'Breloom – the E4', favoriteGame: null } });
  assert.equal(old.trusted, null);
  assert.equal(old.legacy, 'Breloom – the E4');
});

test('every part is in the list once, in four groups; the dots follow the list', () => {
  assert.deepEqual(D.GROUPS.map(([g]) => g), ['look', 'about', 'showcase', 'privacy']);
  assert.deepEqual(D.ORDER, ['banner', 'frame', 'nameplate', 'accent', 'name', 'title', 'layout', 'trophies', 'trusted', 'fav', 'privacy']);
  assert.deepEqual(Object.keys(D.PARTS).sort(), [...D.ORDER].sort());
  assert.deepEqual(D.ORDER.filter((id) => D.PARTS[id].wide), ['banner', 'frame', 'nameplate', 'trophies', 'trusted'], 'big grids widen the drawer');
});

test('changes: counted per part, "Back to saved" undoes just that part', () => {
  const initial = D.draftFrom(me);
  let d = { ...initial, banner: 'firefly-meadow', status: 'one more badge', note: 'my rock' };
  assert.deepEqual(D.changedParts(initial, d), ['banner', 'name', 'trusted']);
  assert.equal(D.partChanged(initial, d, 'frame'), false);
  d = D.revertPart(initial, d, 'name');
  assert.equal(d.status, initial.status);
  assert.deepEqual(D.changedParts(initial, d), ['banner', 'trusted']);
  // picking the saved value again is no change
  assert.deepEqual(D.changedParts(initial, { ...d, banner: 'plain-dusk', note: 'carried me' }), []);
});

test('the trophy cabinet: a click fills the place and moves on to the next empty one; a trophy shown twice swaps', () => {
  let t = D.placeTrophy(['a', 'b', null], 2, 'c');
  assert.deepEqual(t, ['a', 'b', 'c']);
  assert.equal(D.nextSlot(t, 2), 2, 'all full: stays');
  t = D.placeTrophy(t, 0, 'c'); // c was in place 3 → swaps with a
  assert.deepEqual(t, ['c', 'b', 'a']);
  t = D.placeTrophy(t, 1, null); // × takes it out
  assert.deepEqual(t, ['c', null, 'a']);
  assert.equal(D.nextSlot(t, 0), 1);
  assert.equal(D.nextSlot([null, null, null], 0), 1);
  assert.equal(D.nextSlot(['a', null, null], 2), 1, 'the next empty one, wrapping round');
});

test('Save sends only what changed, in the page’s shape (layout and privacy included); nothing changed → null', () => {
  const initial = D.draftFrom(me);
  assert.equal(D.savePatch(initial, initial), null);
  const d = { ...initial, banner: 'firefly-meadow', layout: 'lcd', trophies: [null, 'badges16', 'win-soul-link'], vis: 'link', runs: false, name: '  ', status: ' ' };
  assert.deepEqual(D.savePatch(initial, d), {
    banner: 'firefly-meadow', name: null, status: null,
    showcase: { trophies: ['badges16', 'win-soul-link'], trusted: { species: 260, line: 258, note: 'carried me' }, trustedText: null, favoriteGame: 'Emerald' },
    showcaseLayout: 'lcd', privacy: { profile: 'link', showRuns: false },
  });
  // a picked line replaces the old free text; removing it clears both
  const old = D.draftFrom({ ...me, showcase: { trophies: [], trusted: null, trustedText: 'Breloom', favoriteGame: null } });
  assert.deepEqual(D.savePatch(old, { ...old, trusted: { species: 286, line: 285 }, legacy: null }).showcase.trusted, { species: 286, line: 285, note: null });
  assert.equal(D.savePatch(old, { ...old, legacy: null }).showcase.trustedText, null);
  assert.equal(D.savePatch(old, { ...old, fav: 'Crystal' }).showcase.trustedText, 'Breloom', 'kept as it was');
});

test('souldew+ tried on without the membership never blocks Save: that part keeps the saved free item, the rest saves', () => {
  const initial = D.draftFrom(me);
  const d = { ...initial, banner: 'night-train', frame: 'brass-ring', accent: 'ember' };
  assert.deepEqual(D.savePatch(initial, d, { locked: ['banner', 'frame'] }), { accent: 'ember' });
  assert.equal(D.savePatch(initial, { ...initial, banner: 'night-train' }, { locked: ['banner'] }), null, 'only the locked pick: nothing to send');
  assert.deepEqual(D.LOCKABLE, ['banner', 'frame', 'nameplate']);
});

test('leaving with unsaved changes asks once; staying in the editor, or nothing changed, never asks', () => {
  assert.equal(D.leaveAsks('#/library', true), true);
  assert.equal(D.leaveAsks('#/profile', true), true, 'the profile page itself is leaving the edit state');
  assert.equal(D.leaveAsks('#/profile?edit=trophies', true), false);
  assert.equal(D.leaveAsks('#/library', false), false);
  assert.equal(D.leaveAsks('#/profile?id=u_kim', true), true);
});

test('the leave guard: holds while registered, asks through the screen, removed with its own remover only', () => {
  assert.equal(leaveHeld('#/library'), false, 'no guard');
  let asked = 0;
  const off = setLeaveGuard((next) => {
    if (!D.leaveAsks(next, true)) return false;
    asked++;
    return true;
  });
  assert.equal(leaveHeld('#/library'), true);
  assert.equal(leaveHeld('#/profile?edit=1'), false);
  assert.equal(asked, 1);
  const other = setLeaveGuard(() => true);
  off(); // an old remover doesn't remove the newer guard
  assert.equal(leaveHeld('#/x'), true);
  other();
  assert.equal(leaveHeld('#/x'), false);
  // a guard that throws never traps the player
  const bad = setLeaveGuard(() => { throw new Error('boom'); });
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(leaveHeld('#/x'), false);
  } finally {
    console.error = err;
    bad();
  }
});
