// #89: a wrong read must never end a run – a team with none of the last team's Pokémon is held back (shared/live/teamguard.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamGuard, SWAP_HOLD_MS } from '../shared/live/teamguard.mjs';

const mon = (key, hp = 20, maxHp = 20) => ({ key, species: 1, hp, maxHp });
const team = [mon('a'), mon('b'), mon('c')];

test('a team that keeps one Pokémon of the last one goes through at once (a catch, a PC move, a trade)', () => {
  const g = new TeamGuard();
  assert.equal(g.see(team, { now: 0 }), team, 'the first team is taken as it comes');
  const caught = [...team, mon('d')];
  assert.equal(g.see(caught, { now: 1 }), caught);
  const swapped = [mon('d'), mon('e')]; // a, b, c put away one by one – each poll kept one of them
  assert.equal(g.see([mon('b'), mon('c'), mon('d')], { now: 2 }).length, 3);
  assert.equal(g.see([mon('c'), mon('d')], { now: 3 }).length, 2);
  assert.equal(g.see(swapped, { now: 4 }), swapped);
  assert.deepEqual(g.see([], { now: 5 }), [], 'no team (title screen) is no swap');
});

test('#89: the beaten trainer\'s team (every Pokémon at 0 HP) is never taken for the player\'s', () => {
  const g = new TeamGuard();
  g.see(team, { now: 0 });
  const foe = [mon('x', 0, 30), mon('y', 0, 25)];
  for (let t = 0; t <= 10 * SWAP_HOLD_MS; t += 700) assert.equal(g.see(foe, { now: t }), null, `held at ${t} ms`);
  // the real team comes back: it goes through, the held one is forgotten
  assert.equal(g.see(team, { now: 10 * SWAP_HOLD_MS + 700 }), team);
  assert.equal(g.pending, null);
});

test('a whole new team during a battle waits; outside battles it counts after a while (a loaded state, another save)', () => {
  const g = new TeamGuard();
  g.see(team, { now: 0 });
  const other = [mon('p'), mon('q', 5, 30)];
  assert.equal(g.see(other, { now: 0, inBattle: true }), null);
  assert.equal(g.see(other, { now: SWAP_HOLD_MS * 2, inBattle: true }), null, 'a battle\'s time doesn\'t count');
  const out = SWAP_HOLD_MS * 2 + 700;
  assert.equal(g.see(other, { now: out }), null);
  // (counted from the last poll in the battle)
  assert.equal(g.see(other, { now: SWAP_HOLD_MS * 3 - 1 }), null);
  assert.equal(g.see(other, { now: SWAP_HOLD_MS * 3 }), other);
  assert.equal(g.see([mon('q')], { now: SWAP_HOLD_MS * 3 + 1 }).length, 1, 'and is the team from then on');
  // another misread meanwhile starts its wait anew
  g.see([mon('r')], { now: 0 });
  assert.equal(g.held, 1);
  g.reset();
  assert.deepEqual(g.see([mon('z')], { now: 1 }), [mon('z')], 'after a reset the next team is taken as it comes');
});
