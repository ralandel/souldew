// A hand-entered "Caught" links the Pokémon of the game it is (the board's encounter dialog): until then live tracking
// didn't know the Pokémon in the game belonged to it – "in box" only, no level, no death (ticket #37).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const OR = { id: 'or', mode: 'soullink', game: { id: 'pokemon-omega-ruby', system: '3ds' }, players: { p1: { name: 'Lena' }, p2: { name: 'Tim' } } };
const mon = (o) => ({ key: 'k', species: 255, nickname: 'Torchic', level: 5, hp: 20, maxHp: 20, metLocation: 170, metLevel: 5, ...o });

test('linkCandidates: the inbox\'s Pokémon of that species first, then untracked team members – none filed already', () => {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  // the starter is filed; a Zigzagoon and a Wurmple wait in the inbox (the area was occupied / no place known)
  R.applySnapshot(d, OR, 6, 'p1', { source: 'live', party: [mon({ key: 's' })] });
  const zig = mon({ key: 'z', species: 263, nickname: 'Ziggy', level: 3, metLocation: null });
  const wurm = mon({ key: 'w', species: 265, nickname: 'Wurmple', level: 2, metLocation: null });
  const res = R.applySnapshot(d, OR, 6, 'p1', { source: 'live', party: [mon({ key: 's' }), zig, wurm] });
  assert.deepEqual(R.linkCandidates(d, 'p1', 263, res.inbox).map((c) => [c.key, c.nickname, c.level]), [['z', 'Ziggy', 3]]);
  // without the inbox (a partner's slot): the live team's untracked members
  assert.deepEqual(R.linkCandidates(d, 'p1', 265, []).map((c) => c.key), ['w']);
  assert.deepEqual(R.linkCandidates(d, 'p1', 255, res.inbox), [], 'the starter is filed already');
  assert.deepEqual(R.linkCandidates(d, 'p1', 25, res.inbox), [], 'another species: nothing');
  // linked by the dialog: the encounter takes the key – live tracking follows it, it leaves the inbox
  d.set('area:custom-a', { name: 'Route 101', order: 1 });
  R.setEncounter(d, OR, 'custom-a', 'p1', { outcome: 'caught', species: 263, nickname: 'Ziggy', level: 3, key: 'z' }, { by: 'p1' });
  assert.deepEqual(R.linkCandidates(d, 'p1', 263, res.inbox), []);
  const next = R.applySnapshot(d, OR, 6, 'p1', { source: 'live', party: [mon({ key: 's' }), { ...zig, level: 4 }, wurm] });
  assert.deepEqual(next.inbox.map((i) => i.mon.key), ['w']);
  assert.equal(d.get('enc:custom-a:p1').level, 4, 'its level up arrives');
});
