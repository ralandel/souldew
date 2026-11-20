// Playing together, the app's hub (web/lib/together.mjs) and the overlay's helpers (web/lib/togetheroverlay.mjs,
// web/lib/togetherart.mjs): statuses and the battle, partners on older builds, "come to me" with its limits and
// arrival, catches and deaths read from the run's log only (nothing made up), the tombstone written by the player
// whose Pokémon died, gifts end to end through the run doc, the rule, the log line.
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
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const H = await import('../web/lib/together.mjs');
const TG = await import('../shared/together.mjs');
const O = await import('../web/lib/togetheroverlay.mjs');
const A = await import('../web/lib/togetherart.mjs');

const PAIR = { id: 'run1', game: { code: 'BPEE', system: 'gba' }, players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } } };
function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}

/** Two hubs on one channel and one (instantly synced) run doc; `drop(m)` loses messages. */
function table({ doc = mkDoc(), manifest = PAIR } = {}) {
  let t = Date.now();
  const hubs = {};
  const links = {};
  const q = [];
  for (const me of ['p1', 'p2']) {
    const listeners = new Set();
    links[me] = {
      slot: me, others: me === 'p1' ? ['p2'] : ['p1'], status: { partners: { [me === 'p1' ? 'p2' : 'p1']: {} } }, stopped: false,
      onWorld: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      sendWorld: (m) => (q.push({ ...m, from: me }), new Set(links[me].others)),
      sendMessage: () => {},
      listeners,
    };
  }
  for (const me of ['p1', 'p2']) {
    hubs[me] = new H.TogetherHub(links[me], { doc, manifest, now: () => t });
    clearInterval(hubs[me].timer);
  }
  const flush = async (drop = () => false) => {
    while (q.length) {
      const m = q.shift();
      if (drop(m)) continue;
      for (const s of ['p1', 'p2']) if (s !== m.from) for (const fn of links[s].listeners) fn(m);
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  const tick = async (ms) => {
    t += ms;
    for (const s of ['p1', 'p2']) hubs[s].tick();
    await flush();
  };
  return { hubs, links, doc, q, flush, tick, now: () => t, set: (v) => (t = v) };
}

test('status: a battle goes out at once, HP at most twice a second, a heartbeat; a silent partner is gone', async () => {
  const { hubs, q, flush, tick } = table();
  const battle = { kind: 'wild', enemy: { species: 263, level: 3, hp: 12, maxHp: 12 }, active: { index: 0, hp: 20, maxHp: 20 } };
  hubs.p1.setLocal({ battle, here: { gen: 3, id: 16, name: 'Route 101' } });
  await flush();
  assert.equal(hubs.p2.battleOf('p1').enemy.species, 263);
  assert.deepEqual(hubs.p2.placeOf('p1'), { gen: 3, id: 16, name: 'Route 101' });
  assert.ok(hubs.p2.can('p1', 'gift'));
  // the HP drops twice in the same moment: one message now, the newest with the next tick
  hubs.p1.setLocal({ battle: { ...battle, enemy: { ...battle.enemy, hp: 8 } }, here: null });
  hubs.p1.setLocal({ battle: { ...battle, enemy: { ...battle.enemy, hp: 4 } }, here: null });
  assert.equal(q.length, 0, 'held back');
  await tick(TG.TG.battleMinMs);
  assert.equal(hubs.p2.battleOf('p1').enemy.hp, 4);
  // the battle ends: right away
  hubs.p1.setLocal({ battle: null, here: null });
  await flush();
  assert.equal(hubs.p2.battleOf('p1'), null);
  // p1 goes quiet (closed the game): its status is gone after a while, and with it what it could do
  hubs.p1.stop();
  hubs.p1.tick = () => {};
  for (let i = 0; i < 5; i++) await tick(TG.TG.staleMs / 4);
  assert.equal(hubs.p2.status('p1'), null);
  assert.equal(hubs.p2.giftWhy('p1'), 'old', 'connected, but no status: an older souldew');
});

test('a partner on an older build: "in a battle" from the run doc’s where:<slot> while their live data is fresh – no HP', () => {
  const { hubs, doc, now } = table();
  doc.set('where:p1', { gen: 3, id: 16, name: 'Route 101', at: now(), fight: { kind: 'trainer', species: 286, level: 5 } });
  doc.set('live:p1', { party: [{ key: 'k', species: 255, level: 6, hp: 17, maxHp: 21, moves: [10, 45] }], at: now() });
  const b = hubs.p2.battleOf('p1');
  assert.deepEqual([b.kind, b.enemy.species, b.enemy.hp, b.mon.species], ['trainer', 286, undefined, 255]);
  assert.equal(hubs.p2.placeOf('p1').name, 'Route 101');
  // their app closed long ago: no battle any more
  doc.set('live:p1', { party: [], at: now() - 120000 });
  assert.equal(hubs.p2.battleOf('p1'), null);
});

test('come to me: position and place to every partner, limited, cleared on arrival or after a while', async () => {
  const { hubs, flush, tick } = table();
  hubs.p1.setPosition(() => ({ fam: 2, map: 0x0010, x: 160, y: 96, size: [20, 20] }));
  hubs.p1.setLocal({ here: { gen: 3, id: 9, name: 'Oldale Town' } });
  const r = hubs.p1.ping();
  await flush();
  assert.ok(r.id);
  const p = hubs.p2.pingOf('p1');
  assert.deepEqual([p.map, p.x, p.y, p.here.name], [16, 160, 96, 'Oldale Town']);
  // limited: two, then one every 20 s
  assert.ok(hubs.p1.ping().id);
  assert.deepEqual(hubs.p1.ping(), { error: 'limit' });
  await flush();
  // p2 walks up: two tiles away is there
  hubs.p2.setPosition(() => ({ fam: 2, map: 16, x: 160 + 32, y: 96 }));
  await tick(500);
  assert.equal(hubs.p2.pingOf('p1'), null, 'arrived');
  // a new one far away: runs out after a while
  await tick(TG.TG.ping.everyMs);
  hubs.p1.ping();
  hubs.p2.setPosition(() => ({ fam: 2, map: 17, x: 0, y: 0 }));
  await flush();
  assert.ok(hubs.p2.pingOf('p1'));
  await tick(TG.TG.ping.keepMs);
  assert.equal(hubs.p2.pingOf('p1'), null);
  // taken back
  await tick(TG.TG.ping.everyMs * 2);
  hubs.p1.ping();
  await flush();
  hubs.p1.unping();
  await flush();
  assert.equal(hubs.p2.pingOf('p1'), null);
});

test('catches and deaths come from the run’s log only – fresh entries; the tombstone is written by the player whose Pokémon died', async () => {
  const { hubs, doc, now } = table();
  doc.set('feed:old1', { at: now() - 10 * 60000, type: 'catch', slot: 'p1', species: 263 });
  assert.equal(hubs.p2.popsNow().length, 0, 'an old entry is no news');
  // a catch of p1's, as the run records it (here entered by hand)
  R.setEncounter(doc, PAIR, 'route101', 'p1', { outcome: 'caught', species: 263, level: 3, shiny: true });
  const pops = hubs.p2.popsNow();
  assert.deepEqual(pops.map((p) => [p.slot, p.species, p.shiny]), [['p1', 263, true]]);
  // nothing else makes one: a party change, a doc key of another kind
  doc.set('live:p1', { party: [{ species: 25 }], at: now() });
  assert.equal(hubs.p2.popsNow().length, 1);
  // p1's Pokémon dies: p1's app writes where p1 stood (it knows); p2's app writes nothing
  hubs.p1.setPosition(() => ({ fam: 2, map: 3, x: 99, y: 64, size: [20, 20] }));
  hubs.p2.setPosition(() => ({ fam: 2, map: 3, x: 0, y: 0 }));
  R.markDead(doc, PAIR, 'route101', { slot: 'p1', cause: 'test' });
  const tombs = hubs.p2.tombs();
  assert.equal(tombs.length, 1);
  assert.deepEqual([tombs[0].slot, tombs[0].map, tombs[0].x, tombs[0].y, tombs[0].species, tombs[0].size], ['p1', 3, 96, 64, 263, [20, 20]], 'on its tile');
  // gone after a while
  const t = mkDoc();
  t.set('tomb:p1:x', { fam: 2, map: 3, x: 0, y: 0, at: now() - TG.TG.tombMs - 1 });
  assert.equal(table({ doc: t }).hubs.p2.tombs().length, 0);
});

test('gifts through the hub: the rule, the reasons, the run doc and one log line', async () => {
  const { hubs, doc, flush, tick } = table();
  const bags = {};
  for (const me of ['p1', 'p2']) {
    const items = me === 'p1' ? { '13@items': 5 } : {};
    bags[me] = items;
    hubs[me].setBag({
      gen: 3, check: () => null, list: () => Object.entries(items).map(([k, count]) => ({ item: +k.split('@')[0], pocket: k.split('@')[1], count })),
      has: (item, n, pocket) => (items[`${item}@${pocket}`] || 0) >= n, room: () => true,
      remove: (item, n, pocket) => ((items[`${item}@${pocket}`] -= n), { ok: true }),
      add: (item, n, pocket) => ((items[`${item}@${pocket}`] = (items[`${item}@${pocket}`] || 0) + n), { ok: true, added: n }),
    });
  }
  hubs.p1.setLocal({});
  hubs.p2.setLocal({});
  await flush();
  assert.equal(hubs.p1.giftWhy('p2'), null);
  const g = hubs.p1.offer('p2', { item: 13, n: 2, pocket: 'items' });
  await flush();
  hubs.p2.desk.answer(g.id, true);
  await flush();
  assert.deepEqual([bags.p1['13@items'], bags.p2['13@items']], [3, 2]);
  assert.ok(doc.get(`gift:${g.id}`) && doc.get(`giftgot:${g.id}`).ok);
  const lines = R.feedList(doc).filter((f) => f.type === 'gift');
  assert.equal(lines.length, 1, 'one line, by the giver');
  assert.equal(lines[0].slot, 'p1');
  assert.match(R.feedText(doc, PAIR, lines[0]), /^gave Tim a gift: 2 × /);
  // the host switches gifts off: no button, both ends refuse
  doc.set('rules', { itemGifts: 'off' });
  assert.equal(hubs.p1.giftWhy('p2'), 'off');
  assert.deepEqual(hubs.p1.offer('p2', { item: 13, n: 1, pocket: 'items' }), { error: 'off' });
  assert.equal(H.giftsAllowed(doc, { ...PAIR, mode: 'nuzlocke' }), false, 'a solo run has nobody to give to');
  // my game closed: no bag – the reason says so
  doc.set('rules', {});
  hubs.p1.setBag(null);
  assert.equal(hubs.p1.giftWhy('p2'), 'nogame');
  await tick(10);
});

test('my game for gifts: the reasons it can’t give or take right now', () => {
  const entry = { id: 'red_us', gen: 1, platform: 'gb' };
  assert.equal(H.gameWhy({ entry, live: true, link: true }), 'link');
  assert.equal(H.gameWhy({ entry, live: false }), 'waiting');
  assert.equal(H.gameWhy({ entry, live: true, inBattle: true }), 'battle');
  assert.equal(H.gameWhy({ entry, read: () => new Uint8Array(4), live: true }), null, 'no screen tables (Gen 1 today): not in a battle is enough');
  // a bag that refuses part of a gift: the stack is full near its limit → nothing added
  const bag = H.makeBag(() => ({ entry, state: {}, mem: { read: () => null, write: () => true }, why: null }));
  assert.equal(bag.check(), null);
  assert.equal(bag.list(), null, 'no readable bag');
});

test('overlay: a partner in a battle stands where it began; the art; the arrow for each direction', () => {
  const tr = { buf: [{ fam: 2, map: 3, x: 64, y: 32, facing: 4, hidden: false }, { fam: 2, map: 3, x: 80, y: 32, facing: 4, hidden: false }, { fam: 2, hidden: true }] };
  const hidden = { fam: 2, hidden: true };
  assert.equal(O.standIn(hidden, tr, null, false), hidden, 'not in a battle: hidden as before');
  const s = O.standIn(hidden, tr, null, true);
  assert.deepEqual([s.x, s.y, s.moving, s.battling], [80, 32, false, true]);
  assert.equal(O.standIn(hidden, tr, () => null, true), hidden, 'another map: nothing');
  assert.equal(O.standIn(hidden, { buf: [hidden] }, null, true), hidden);
  // the art: every row of a mask as long as the first
  for (const [name, rows] of Object.entries({ ...A.TOGETHER_ART, tomb: A.TOMB_ROWS, ...A.ARROWS })) assert.ok(rows.every((r) => r.length === rows[0].length), name);
  assert.deepEqual(A.TOMB_SIZE, [11, 11]);
  assert.equal(A.tombPixels().length, 11 * 11 * 4);
  assert.equal(A.arrowFor(0), A.ARROWS.E);
  assert.equal(A.arrowFor(Math.PI / 2), A.ARROWS.S, 'south: y grows downward');
  assert.equal(A.arrowFor(-Math.PI / 2), A.ARROWS.N);
  assert.equal(A.arrowFor(Math.PI), A.ARROWS.W);
  assert.equal(A.arrowFor(Math.PI / 4), A.ARROWS.SE);
  assert.equal(A.arrowFor(-3 * Math.PI / 4), A.ARROWS.NW);
});

test('overlay on a Game Boy picture (160×144, the player at 64, 64): tombstones and the arrow by the same hooks', () => {
  const t = { fam: 11, anchor: { x: 64, y: 64 }, screen: { w: 160, h: 144 } };
  const L = O.togetherLayer(t);
  const cam = { map: 3, cx: 5 * 16, cy: 4 * 16 };
  const tombs = [{ id: 'p2:x', slot: 'p2', fam: 11, map: 3, x: 6 * 16, y: 4 * 16 }, { id: 'p2:y', slot: 'p2', fam: 2, map: 3, x: 6 * 16, y: 4 * 16 }];
  assert.deepEqual(L.tombSprites(cam, null, tombs).map((x) => [x.id, x.pos]), [['p2:x', { x: 80, y: 64 }]], 'only its own game family, on its tile');
  const drawn = [];
  const ctx = { fillRect: (x, y) => drawn.push([x, y]), set fillStyle(v) {} };
  const r = L.drawPing(ctx, cam, null, { fam: 11, map: 3, x: 40 * 16, y: 4 * 16 }, '#fff', 0);
  assert.equal(r.dir, 'edge');
  assert.ok(r.x > 140 && r.x <= 160 && drawn.length > 0, JSON.stringify(r));
  assert.equal(L.drawPing(ctx, cam, null, { fam: 11, map: 9, x: 0, y: 0 }, '#fff', 0), null, 'another map, not connected: none');
});
