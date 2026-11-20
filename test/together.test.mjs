// Playing together (docs/MULTIPLAYER.md › 9 "Playing together"): who is in a battle, gifts from one bag to the other
// (what may be given, the bag writes per generation, the protocol's order, rollback and doubles), "come to me", and
// that partners on builds from before are left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const TG = await import('../shared/together.mjs');
const GI = await import('../shared/giftitems.mjs');
const C = await import('../shared/live/cheats.mjs');
const { findEntry } = await import('../shared/live/parse.mjs');
const TABLE = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url)));
const entry = (header) => findEntry(TABLE, header);

/** Sparse bus memory (as test/cheats.test.mjs): unwritten bytes read as 0, later writes win. */
function memory() {
  const blocks = [];
  const mem = {
    writes: 0,
    poke(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
    read(addr, len) {
      const out = new Uint8Array(len);
      for (const b of blocks) {
        for (let i = 0; i < len; i++) {
          const o = addr + i - b.addr;
          if (o >= 0 && o < b.bytes.length) out[i] = b.bytes[o];
        }
      }
      return out;
    },
    write(addr, bytes) {
      mem.writes++;
      mem.poke(addr, bytes);
      return true;
    },
  };
  return mem;
}
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const slot = (id, qty) => [...le16(id), ...le16(qty)];

// ---- what may be given ---------------------------------------------------------------------------------------------
test('gifts: ordinary items only – never the Master Ball, Gen 1 by its list (no key items, fossils, badges, TMs/HMs)', () => {
  for (const gen of [1, 2, 3, 4, 5, 6, 7]) assert.equal(GI.giftable(gen, GI.MASTER_BALL, gen === 1 ? null : 'balls'), false, `gen ${gen}`);
  // Gen 1 (pokered): Potion 0x14, Rare Candy 0x28 yes; Bicycle 0x06, Old Amber 0x1F, Helix Fossil 0x2A, Safari Ball 0x08,
  // Exp. All 0x4B, HM01 0xC4, TM01 0xC9, a badge 0x15 no
  assert.ok(GI.giftable(1, 0x14) && GI.giftable(1, 0x28));
  for (const id of [0x06, 0x1f, 0x2a, 0x08, 0x4b, 0xc4, 0xc9, 0x15]) assert.equal(GI.giftable(1, id), false, id.toString(16));
  // Gen 2 (pokecrystal): Potion 0x12, Leftovers 0x92, Max Elixer 0x15 (PokeAPI says Elixir – pret is right) yes; GS Ball
  // 0x73, a TM 0xBF, mail 0x9E no
  assert.ok(GI.giftable(2, 0x12, 'items') && GI.giftable(2, 0x92, 'items'));
  assert.equal(GI.gbItemKey(2, 0x15), 'max-elixir');
  for (const id of [0x73, 0xbf, 0x9e]) assert.equal(GI.giftable(2, id, 'items'), false);
  // Gen 3+: from the pockets of ordinary items – never from Gen 1's pocket-less bag, never a key item pocket
  assert.ok(GI.giftable(3, 13, 'items') && GI.giftable(4, 17, 'medicine') && GI.giftable(7, 150, 'berries'));
  assert.equal(GI.giftable(3, 13, null), false);
  assert.equal(GI.giftable(4, 428, 'key'), false);
  assert.equal(GI.giftable(8, 13, 'items'), false);
  // the list: each item once, counts > 0
  assert.deepEqual(GI.giftList(3, [{ item: 13, count: 5, pocket: 'items' }, { item: 1, count: 1, pocket: 'balls' }, { item: 4, count: 0, pocket: 'balls' }, { item: 13, count: 2, pocket: 'items' }]),
    [{ item: 13, count: 5, pocket: 'items' }]);
});

// ---- the bag, per generation ---------------------------------------------------------------------------------------
test('bag: Gen 1 – the list, an item taken off its stack, a stack that runs out leaves no gap (the terminator moves up)', () => {
  const e = entry({ platform: 'gb', title: 'POKEMON RED' });
  const m = memory();
  m.poke(0xd31d, [3, 0x14, 5, 0x06, 1, 0x28, 2, 0xff]); // Potion ×5, Bicycle, Rare Candy ×2
  m.poke(0xd347, [0, 0x30, 0]);
  assert.deepEqual(C.bagItems(e, m.read), [{ item: 0x14, count: 5, pocket: null }, { item: 0x06, count: 1, pocket: null }, { item: 0x28, count: 2, pocket: null }]);
  assert.deepEqual(GI.giftList(1, C.bagItems(e, m.read)).map((x) => x.item), [0x14, 0x28], 'the Bicycle stays out');
  assert.deepEqual(C.removeItem(e, m, {}, 0x14, 2), { ok: true, before: 5, after: 3, removed: 2 });
  assert.deepEqual(Array.from(m.read(0xd31d, 8)), [3, 0x14, 3, 0x06, 1, 0x28, 2, 0xff]);
  assert.deepEqual(C.removeItem(e, m, {}, 0x14, 3), { ok: true, before: 3, after: 0, removed: 3 });
  assert.deepEqual(Array.from(m.read(0xd31d, 6)), [2, 0x06, 1, 0x28, 2, 0xff]);
  assert.deepEqual(C.removeItem(e, m, {}, 0x28, 5), { error: 'short', before: 2 });
  assert.deepEqual(C.removeItem(e, m, {}, 0x14, 1), { error: 'missing' });
  // room: a stack within 99, or one of the 20 places
  assert.equal(C.bagRoom(e, m.read, {}, 0x28, 97), true);
  assert.equal(C.bagRoom(e, m.read, {}, 0x28, 98), false);
  assert.equal(C.bagRoom(e, m.read, {}, 0x14, 99), true);
  // broken memory: nothing read, nothing written
  const bad = memory();
  bad.poke(0xd31d, [30, 0x14, 5]);
  assert.equal(C.bagItems(e, bad.read), null);
  assert.deepEqual(C.removeItem(e, bad, {}, 0x14, 1), { error: 'notFound' });
  assert.equal(bad.writes, 0);
});

test('bag: Gen 2 – Items and the Poké Ball pocket behind the key items', () => {
  const e = entry({ platform: 'gbc', title: 'PM_CRYSTAL' });
  const m = memory();
  m.poke(0xd892, [1, 0x12, 4, 0xff]); // Potion ×4
  m.poke(0xd8bc, [1, 0x07, 0xff]); // key items: Bicycle
  m.poke(0xd8bc + 27, [2, 0x05, 10, 0x01, 1, 0xff]); // Poké Ball ×10, Master Ball
  const items = C.bagItems(e, m.read);
  assert.deepEqual(items, [{ item: 0x12, count: 4, pocket: 'items' }, { item: 0x05, count: 10, pocket: 'balls' }, { item: 0x01, count: 1, pocket: 'balls' }]);
  assert.deepEqual(GI.giftList(2, items).map((x) => x.item), [0x12, 0x05]);
  assert.equal(C.removeItem(e, m, {}, 0x05, 10, { pocket: 'balls' }).ok, true);
  assert.deepEqual(Array.from(m.read(0xd8bc + 27, 4)), [1, 0x01, 1, 0xff]);
  // the ball pocket holds 12
  assert.equal(C.bagRoom(e, m.read, {}, 0x04, 5, { pocket: 'balls' }), true);
  assert.equal(C.addItem(e, m, {}, 0x04, 5, { pocket: 'balls' }).ok, true);
  assert.deepEqual(Array.from(m.read(0xd8bc + 27, 6)), [2, 0x01, 1, 0x04, 5, 0xff]);
});

test('bag: Gen 3 – quantities XOR the key; a stack that runs out moves the rest up and leaves the encrypted 0', () => {
  const e = entry({ platform: 'gba', code: 'BPEE' });
  const key = 0x1234abcd;
  const k = key & 0xffff;
  const sb1 = 0x02025a00;
  const sb2 = 0x02024a00;
  const m = memory();
  m.poke(0x03005d8c, le32(sb1));
  m.poke(0x03005d90, le32(sb2));
  m.poke(sb2 + 0xac, le32(key));
  m.poke(sb1 + 0x490, le32((3000 ^ key) >>> 0));
  m.poke(sb1 + 0x560, [...slot(13, 5 ^ k), ...slot(68, 10 ^ k), ...slot(0, k)]);
  m.poke(sb1 + 0x650, [...slot(4, 10 ^ k), ...slot(1, 1 ^ k)]);
  for (let i = 3; i < 30; i++) m.poke(sb1 + 0x560 + i * 4, slot(0, k));
  for (let i = 2; i < 16; i++) m.poke(sb1 + 0x650 + i * 4, slot(0, k));
  assert.deepEqual(GI.giftList(3, C.bagItems(e, m.read)), [{ item: 13, count: 5, pocket: 'items' }, { item: 68, count: 10, pocket: 'items' }, { item: 4, count: 10, pocket: 'balls' }]);
  assert.deepEqual(C.removeItem(e, m, {}, 13, 5, { pocket: 'items' }), { ok: true, before: 5, after: 0, removed: 5 });
  const u16 = (a) => { const b = m.read(a, 2); return b[0] | (b[1] << 8); };
  assert.deepEqual([u16(sb1 + 0x560), u16(sb1 + 0x562) ^ k], [68, 10], 'Rare Candy moved up');
  assert.deepEqual([u16(sb1 + 0x564), u16(sb1 + 0x566)], [0, k], 'the slot behind it: empty, quantity 0 encrypted');
  assert.equal(C.bagItems(e, m.read).length, 3, 'still a bag');
  // added on the other side into the same pocket
  assert.equal(C.bagRoom(e, m.read, {}, 13, 3, { pocket: 'items' }), true);
  assert.equal(C.addItem(e, m, {}, 13, 3, { pocket: 'items' }).added, 3);
});

test('bag: Gen 4 – Medicine, 999 a stack, the TM pocket never read', () => {
  const e = entry({ platform: 'nds', code: 'IPKE' });
  const saveBase = 0x0227c2c8;
  const bag = saveBase + 0x10 + 0x644;
  const m = memory();
  m.poke(bag + 0x294, slot(468, 1));
  m.poke(bag + 0x35c, slot(425, 1));
  m.poke(bag + 0x520, [...slot(17, 2), ...slot(50, 3)]); // Potion ×2, Rare Candy ×3
  const st = { saveBase };
  assert.deepEqual(GI.giftList(4, C.bagItems(e, m.read, st)), [{ item: 17, count: 2, pocket: 'medicine' }, { item: 50, count: 3, pocket: 'medicine' }]);
  assert.equal(C.removeItem(e, m, st, 17, 2, { pocket: 'medicine' }).ok, true);
  assert.deepEqual(Array.from(m.read(bag + 0x520, 8)), [...slot(50, 3), 0, 0, 0, 0]);
  assert.equal(C.bagRoom(e, m.read, st, 50, 996, { pocket: 'medicine' }), true);
  assert.equal(C.bagRoom(e, m.read, st, 50, 997, { pocket: 'medicine' }), false);
  // the TM pocket is never read for a gift
  assert.ok(!C.bagItems(e, m.read, st).some((x) => x.item === 425));
});

test('bag: Gen 7 (Sun) – a u32 slot: the count changes, the sort index and NEW mark stay; a stack that runs out moves the rest up', () => {
  const e = findEntry(TABLE, { platform: '3ds', titleId: '0004000000164800' });
  const base = 0x330d5934;
  const m = memory();
  const g7 = (id, qty, sort = 0, isNew = false) => le32((id | (qty << 10) | (sort << 20) | (isNew ? 0x40000000 : 0)) >>> 0);
  m.poke(base + 0x6b8, g7(845, 1, 0, true)); // a key item: never read for a gift
  m.poke(base + 0x000, [...g7(4, 10, 3), ...g7(13, 2, 5, true)]); // Items: Poké Ball ×10 (sort 3), Potion ×2 (sort 5, NEW)
  m.poke(base + 0xde0, [0xb48, 0x000, 0x998, 0xc48, 0x6b8, 0xd68].flatMap((o) => le32(base + o)));
  const items = C.bagItems(e, m.read, {});
  assert.deepEqual(GI.giftList(7, items), [{ item: 4, count: 10, pocket: 'items' }, { item: 13, count: 2, pocket: 'items' }]);
  const u32 = (a) => { const b = m.read(a, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  assert.equal(C.removeItem(e, m, {}, 4, 3, { pocket: 'items' }).ok, true);
  assert.equal(u32(base), (4 | (7 << 10) | (3 << 20)) >>> 0, 'count 7, sort index kept');
  assert.equal(C.removeItem(e, m, {}, 4, 7, { pocket: 'items' }).ok, true);
  assert.equal(u32(base), (13 | (2 << 10) | (5 << 20) | 0x40000000) >>> 0, 'the Potion moved up as it was');
  assert.equal(u32(base + 4), 0);
  assert.deepEqual(C.removeItem(e, m, {}, 845, 1, { pocket: 'key' }), { error: 'unsupported' }, 'the key pocket: never');
});

// ---- the protocol -----------------------------------------------------------------------------------------------------
/** A pretend bag: { item@pocket: count }, plus switches to make it fail. */
function fakeBag(gen, items = {}) {
  const b = {
    gen, items: { ...items }, why: null, failAdd: false, failRemove: false, slowAdd: null, cap: 99,
    check: () => b.why,
    has: (item, n, pocket) => (b.items[`${item}@${pocket}`] || 0) >= n,
    room: (item, n, pocket) => (b.items[`${item}@${pocket}`] || 0) + n <= b.cap,
    remove(item, n, pocket) {
      if (b.failRemove) return { error: 'write' };
      const k = `${item}@${pocket}`;
      if ((b.items[k] || 0) < n) return { error: 'short' };
      b.items[k] -= n;
      return { ok: true, removed: n };
    },
    add(item, n, pocket) {
      if (b.failAdd) return { error: 'full' };
      const k = `${item}@${pocket}`;
      const go = () => { b.items[k] = (b.items[k] || 0) + n; return { ok: true, added: n }; };
      return b.slowAdd ? b.slowAdd.then(go) : go();
    },
  };
  return b;
}

/** Two desks on one channel with one shared run doc; `drop(m)` loses messages. */
function pair({ items = { '13@items': 5 }, gen = 3 } = {}) {
  let t = 1000;
  const q = [];
  const doc = new Map();
  const logs = [];
  const ledger = (me) => ({
    sent: (g) => doc.set(`gift:${g.id}`, { from: g.from, to: g.to, gen: g.gen, item: g.item, n: g.n, pocket: g.pocket }),
    decided: (id) => doc.get(`giftgot:${id}`) || null,
    decide: (id, o) => { if (!doc.has(`giftgot:${id}`)) doc.set(`giftgot:${id}`, { ok: o.ok, why: o.why || null }); },
    done: (g) => logs.push(['done', me, g.id]),
    returned: (g) => doc.set(`gift:${g.id}`, { ...doc.get(`gift:${g.id}`), back: true }),
    open: () => [...doc].filter(([k, r]) => k.startsWith('gift:') && r.from === me && !r.back && !doc.has(`giftgot:${k.slice(5)}`)).map(([k, r]) => ({ id: k.slice(5), ...r })),
  });
  const bags = { p1: fakeBag(gen, items), p2: fakeBag(gen) };
  let n = 0;
  const desks = {};
  for (const me of ['p1', 'p2']) desks[me] = new TG.GiftDesk({ me, now: () => t, send: (m) => q.push({ ...m, from: me }), bag: bags[me], ledger: ledger(me), id: () => `gift${++n}aa` });
  const flush = async (drop = () => false) => {
    while (q.length) {
      const m = q.shift();
      if (drop(m)) continue;
      for (const s of ['p1', 'p2']) if (s !== m.from) await desks[s].receive(m);
    }
  };
  const tick = async (ms, drop) => {
    t += ms;
    for (const s of ['p1', 'p2']) desks[s].tick();
    await flush(drop);
  };
  return { desks, bags, doc, q, flush, tick, logs, now: () => t };
}
const gift = (d) => [...d.gifts.values()][0];

test('gift: both confirm, the giver’s bag first, then the receiver’s – one record, one log line', async () => {
  const { desks, bags, doc, flush, logs } = pair();
  const g = desks.p1.offer('p2', { item: 13, n: 3, pocket: 'items' });
  assert.equal(g.phase, 'asked');
  await flush();
  assert.equal(gift(desks.p2).phase, 'offered', 'nothing moves before the receiver says yes');
  assert.deepEqual([bags.p1.items['13@items'], bags.p2.items['13@items']], [5, undefined]);
  desks.p2.answer(g.id, true);
  await flush();
  assert.deepEqual([bags.p1.items['13@items'], bags.p2.items['13@items']], [2, 3]);
  assert.deepEqual([gift(desks.p1).phase, gift(desks.p2).phase], ['done', 'done']);
  assert.deepEqual(doc.get(`giftgot:${g.id}`), { ok: true, why: null });
  assert.ok(doc.get(`gift:${g.id}`), 'the giver’s record');
  assert.deepEqual(logs, [['done', 'p2', g.id]], 'the receiver tells its ledger once');
});

test('gift: declined, refused (no room, a battle) or the rule off – nothing moves', async () => {
  let p = pair();
  let g = p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' });
  await p.flush();
  p.desks.p2.answer(g.id, false);
  await p.flush();
  assert.equal(gift(p.desks.p1).phase, 'declined');
  assert.equal(p.bags.p1.items['13@items'], 5);

  p = pair();
  p.bags.p2.cap = 0; // no room
  g = p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' });
  await p.flush();
  p.desks.p2.answer(g.id, true);
  await p.flush();
  assert.deepEqual([gift(p.desks.p1).phase, gift(p.desks.p1).why], ['refused', 'full']);
  assert.equal(p.bags.p1.items['13@items'], 5);

  p = pair();
  p.bags.p1.why = 'battle';
  assert.deepEqual(p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' }), { error: 'battle' });
  p.bags.p1.why = null;
  p.desks.p2.allowed = () => false;
  g = p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' });
  await p.flush();
  assert.deepEqual([gift(p.desks.p1).phase, gift(p.desks.p1).why], ['refused', 'off'], 'the receiver checks the rule too');
  p.desks.p1.allowed = () => false;
  assert.deepEqual(p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' }), { error: 'off' });
  // only what may be given, only what the bag has
  p.desks.p1.allowed = () => true;
  assert.deepEqual(p.desks.p1.offer('p2', { item: 1, n: 1, pocket: 'balls' }), { error: 'item' });
  assert.deepEqual(p.desks.p1.offer('p2', { item: 13, n: 9, pocket: 'items' }), { error: 'short' });
});

test('gift: between versions only items both games have (HeartGold → Platinum: not, Emerald → FireRed: the shared ones)', async () => {
  assert.equal(GI.sameItems(4, 'hgss', 'platinum', 17), false);
  assert.equal(GI.sameItems(4, 'hgss', 'hgss', 500), true);
  assert.equal(GI.sameItems(3, 'rse', 'frlg', 13), true);
  assert.equal(GI.sameItems(3, 'rse', 'frlg', 375), false);
  assert.equal(GI.sameItems(2, 'gb2', 'gb2', 0x12), true);
  assert.equal(C.bagFamily(entry({ platform: 'nds', code: 'IPKE' })), 'hgss');
  assert.equal(C.bagFamily(entry({ platform: 'gba', code: 'BPRE' })), 'frlg');
  assert.equal(C.bagFamily(entry({ platform: 'gba', code: 'BPEE' })), 'rse');
  const p = pair({ gen: 4, items: { '17@medicine': 3 } });
  p.bags.p1.fam = 'hgss';
  p.bags.p2.fam = 'platinum';
  const g = p.desks.p1.offer('p2', { item: 17, n: 1, pocket: 'medicine' });
  await p.flush();
  p.desks.p2.answer(g.id, true);
  await p.flush();
  assert.deepEqual([gift(p.desks.p1).phase, gift(p.desks.p1).why, p.bags.p1.items['17@medicine']], ['refused', 'game', 3]);
});

test('gift: the receiver can’t add it after all – the giver gets it back', async () => {
  const { desks, bags, doc, flush } = pair();
  const g = desks.p1.offer('p2', { item: 13, n: 2, pocket: 'items' });
  await flush();
  desks.p2.answer(g.id, true);
  bags.p2.failAdd = true; // (the bag changed between "yes" and the write)
  await flush();
  assert.deepEqual([gift(desks.p1).phase, bags.p1.items['13@items'], bags.p2.items['13@items']], ['returned', 5, undefined]);
  assert.deepEqual(doc.get(`giftgot:${g.id}`), { ok: false, why: 'full' });
  assert.equal(doc.get(`gift:${g.id}`).back, true);
});

test('gift: the giver’s own write fails – the receiver hears it, nothing was added', async () => {
  const { desks, bags, flush } = pair();
  const g = desks.p1.offer('p2', { item: 13, n: 2, pocket: 'items' });
  await flush();
  bags.p1.failRemove = true;
  desks.p2.answer(g.id, true);
  await flush();
  assert.deepEqual([gift(desks.p1).phase, gift(desks.p2).phase], ['failed', 'withdrawn']);
  assert.deepEqual([bags.p1.items['13@items'], bags.p2.items['13@items']], [5, undefined]);
});

test('gift: "go" sent twice, or the answer lost – added once; the giver learns it from the run doc', async () => {
  const { desks, bags, doc, q, flush, tick } = pair();
  const g = desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' });
  await flush();
  desks.p2.answer(g.id, true);
  // the receiver's "done" is lost on the way
  await flush((m) => m.op === 'g-done');
  assert.deepEqual([gift(desks.p1).phase, bags.p2.items['13@items']], ['sent', 1]);
  // a repeated "go": answered from the doc, not added again
  q.push({ t: 'tg', op: 'g-go', id: g.id, to: 'p2', from: 'p1' });
  await flush((m) => m.op === 'g-done');
  assert.equal(bags.p2.items['13@items'], 1);
  // the giver's next look at the doc (the record synced)
  await tick(500);
  assert.equal(gift(desks.p1).phase, 'done');
  assert.ok(doc.get(`giftgot:${g.id}`).ok);
});

test('gift: no word at all after "go" – never taken back on silence (a pulled cable copies nothing); asked until an answer', async () => {
  const p = pair();
  const g = p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' });
  await p.flush();
  p.desks.p2.answer(g.id, true);
  // the receiver's app is gone right after "yes": every message to it is lost, and it forgot the gift (a restart)
  await p.flush((m) => m.from === 'p1' && m.op === 'g-go');
  p.desks.p2.gifts.clear();
  for (let i = 0; i < 6; i++) await p.tick(TG.TG.gift.returnMs, (m) => m.from === 'p1' || m.from === 'p2');
  assert.deepEqual([gift(p.desks.p1).phase, p.bags.p1.items['13@items']], ['unconfirmed', 4], 'out of the bag, not back – nobody said');
  // it comes back: asked, it knows nothing of the gift → decided "not added" right then → the giver takes it back
  await p.tick(TG.TG.gift.queryMs);
  assert.deepEqual(p.doc.get(`giftgot:${g.id}`), { ok: false, why: 'unknown' });
  assert.deepEqual([gift(p.desks.p1).phase, p.bags.p1.items['13@items'], p.bags.p2.items['13@items']], ['returned', 5, undefined]);
});

test('gift: a "go" that comes too late is refused and the item goes back; a late one after that changes nothing', async () => {
  const p = pair();
  const g = p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' });
  await p.flush();
  p.desks.p2.answer(g.id, true);
  const held = [];
  await p.flush((m) => (m.op === 'g-go' ? (held.push(m), true) : false));
  await p.tick(TG.TG.gift.goMs + 1); // the receiver gave up waiting: decided, the giver hears "fail"
  assert.deepEqual([gift(p.desks.p1).phase, p.bags.p1.items['13@items']], ['returned', 5]);
  p.q.push(...held); // the old "go" turns up
  await p.flush();
  assert.equal(p.bags.p2.items['13@items'], undefined, 'never added');
});

test('gift: the giver’s app restarts while one is on its way – restored from the run doc, asked about, settled', async () => {
  const p = pair();
  const g = p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' });
  await p.flush();
  p.desks.p2.answer(g.id, true);
  // out of p1's bag (recorded), then p1's app closes before "go" reaches p2
  await p.flush((m) => m.op === 'g-go');
  assert.equal(p.bags.p1.items['13@items'], 4);
  const fresh = new TG.GiftDesk({ me: 'p1', now: p.now, send: (m) => p.q.push({ ...m, from: 'p1' }), bag: p.bags.p1, ledger: p.desks.p1.ledger, id: () => 'xx' });
  p.desks.p1 = fresh;
  fresh.restore();
  assert.equal(gift(fresh).phase, 'sent', 'restored from the doc');
  await p.tick(10); // asked right away – p2 still waits for "go": no answer yet
  assert.equal(gift(fresh).phase, 'unconfirmed');
  await p.tick(TG.TG.gift.goMs); // p2 stops waiting: "not added" – p1 takes it back
  assert.deepEqual([gift(fresh).phase, p.bags.p1.items['13@items'], p.bags.p2.items['13@items']], ['returned', 5, undefined]);
  // decided gifts aren't restored again
  const again = new TG.GiftDesk({ me: 'p1', now: p.now, send: () => {}, bag: p.bags.p1, ledger: fresh.ledger });
  again.restore();
  assert.equal(again.gifts.size, 0);
});

test('gift: one at a time per pair, offers limited on both ends, junk ignored', async () => {
  const p = pair({ items: { '13@items': 50 } });
  const g = p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' });
  assert.deepEqual(p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' }), { error: 'busy' });
  p.desks.p1.cancel(g.id);
  await p.flush();
  assert.equal(gift(p.desks.p2).phase, 'withdrawn');
  const r = [];
  for (let i = 0; i < 6; i++) {
    for (const d of Object.values(p.desks)) for (const x of d.gifts.values()) x.end = x.end || 'x';
    r.push(p.desks.p1.offer('p2', { item: 13, n: 1, pocket: 'items' })?.error || 'ok');
  }
  assert.ok(r.filter((x) => x === 'limit').length >= 3, r.join());
  // a flood from a modified client: a handful shown
  const before = p.desks.p2.gifts.size;
  for (let i = 0; i < 30; i++) await p.desks.p2.receive({ t: 'tg', op: 'g-ask', id: `flood${i}xx`, to: 'p2', from: 'p1', gen: 3, item: 13, n: 1, pocket: 'items' });
  assert.ok(p.desks.p2.gifts.size - before <= TG.TG.gift.burst + 1);
  for (const bad of [{ op: 'g-ask', id: 'x', gen: 3, item: 13, n: 1 }, { op: 'g-ask', id: 'okay123', gen: 3, item: 1, n: 1, pocket: 'balls' }, { op: 'g-ask', id: 'okay124', gen: 3, item: 13, n: 500, pocket: 'items' }, { op: 'g-go', id: 'nothere1' }, { op: 'boom', id: 'okay125' }]) {
    const n = p.desks.p2.gifts.size;
    await p.desks.p2.receive({ t: 'tg', to: 'p2', from: 'p1', ...bad });
    assert.equal(p.desks.p2.gifts.size, n, JSON.stringify(bad));
  }
  // a third player can't speak for a gift between two others
  const h = [...p.desks.p2.gifts.values()].find((x) => x.phase === 'offered');
  if (h) {
    await p.desks.p2.receive({ t: 'tg', op: 'g-x', id: h.id, to: 'p2', from: 'p3' });
    assert.equal(h.phase, 'offered');
  }
});

// ---- status, ping, the arrow ---------------------------------------------------------------------------------------
test('status: a battle in a small message, older or broken messages read as nothing', () => {
  const battle = { kind: 'trainer', enemy: { species: 263, level: 4, hp: 11, maxHp: 19, shiny: false, moves: [33, 39] }, active: { index: 0, hp: 18, maxHp: 21 } };
  const m = TG.packStatus({ battle, here: { gen: 3, id: 16, name: 'Route 101' } });
  assert.ok(JSON.stringify(m.b).length < 64 && JSON.stringify(m).length < 170, JSON.stringify(m));
  const back = TG.unpackStatus({ ...JSON.parse(JSON.stringify(m)), from: 'p2' });
  assert.deepEqual(back.battle, { kind: 'trainer', enemy: { species: 263, level: 4, hp: 11, maxHp: 19, shiny: false, form: 0 }, active: { index: 0, hp: 18, maxHp: 21 } });
  assert.deepEqual(back.here, { gen: 3, id: 16, name: 'Route 101' });
  assert.deepEqual(back.caps, ['gift', 'ping', 'watch']);
  assert.equal(TG.unpackStatus({ t: 'tg', op: 'st', v: 1, b: 0 }).battle, null, 'no battle');
  // a later version's extra fields: ignored; missing ones: defaults
  assert.deepEqual(TG.unpackStatus({ t: 'tg', op: 'st', v: 2, b: 0, caps: ['gift', 'teleport'], extra: 1 }).caps, ['gift']);
  for (const bad of [null, { t: 'tg', op: 'st' }, { t: 'p', op: 'st', v: 1 }, { t: 'tg', op: 'st', v: 1, b: { k: 'wild', e: ['x'] } }]) {
    const r = TG.unpackStatus(bad);
    assert.ok(r === null || r.battle === null, JSON.stringify(bad));
  }
  // the key: the same battle twice is no news, an HP change is
  assert.equal(TG.statusKey(TG.packStatus({ battle })), TG.statusKey(TG.packStatus({ battle })));
  assert.notEqual(TG.statusKey(TG.packStatus({ battle })), TG.statusKey(TG.packStatus({ battle: { ...battle, enemy: { ...battle.enemy, hp: 3 } } })));
});

test('ping: position and place; arrived within two tiles on its map; the arrow at the edge toward it', () => {
  const m = TG.packPing({ id: 'abcdef12', fam: 2, map: 0x0010, x: 160, y: 96, size: [20, 20], here: { gen: 3, id: 9, name: 'Route 110' } });
  const p = TG.unpackPing(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(p, { id: 'abcdef12', fam: 2, map: 16, x: 160, y: 96, size: [20, 20], here: { gen: 3, id: 9, name: 'Route 110' } });
  // without Shared World: only the place
  assert.deepEqual(TG.unpackPing({ t: 'tg', op: 'ping', id: 'abcdef13', here: { g: 2, i: 4, n: 'Route 29' } }), { id: 'abcdef13', here: { gen: 2, id: 4, name: 'Route 29' } });
  assert.equal(TG.unpackPing({ t: 'tg', op: 'ping', id: '<b>' }), null);
  assert.equal(TG.pingArrived(p, { fam: 2, map: 16, x: 160 + 32, y: 96 }), true);
  assert.equal(TG.pingArrived(p, { fam: 2, map: 16, x: 160 + 48, y: 96 }), false);
  assert.equal(TG.pingArrived(p, { fam: 2, map: 17, x: 160, y: 96 }), false);
  assert.equal(TG.pingArrived({ id: 'x', here: null }, { fam: 2, map: 16, x: 0, y: 0 }), false, 'no position: only time clears it');
  const screen = { w: 240, h: 160 };
  const right = TG.edgeArrow({ x: 600, y: 72 }, screen);
  assert.deepEqual([right.onScreen, Math.round(right.x), Math.round(right.y), Math.round(right.angle * 100)], [false, 230, 80, 0]);
  const up = TG.edgeArrow({ x: 112, y: -400 }, screen);
  assert.deepEqual([Math.round(up.x), Math.round(up.y)], [120, 10]);
  assert.equal(TG.edgeArrow({ x: 50, y: 50 }, screen).onScreen, true);
});

test('older builds: a status, a ping or a gift message is ignored by their Shared World and their rock-paper-scissors', async () => {
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  globalThis.dispatchEvent ??= () => true;
  globalThis.CustomEvent ??= class { constructor(type, o) { this.type = type; this.detail = o?.detail; } };
  const { SharedWorld } = await import('../web/lib/sharedworld.mjs');
  let worldIn = null;
  const calls = [];
  const fake = { config: () => true, partner: (...a) => calls.push(['partner', ...a]), gone: (...a) => calls.push(['gone', ...a]), emote: (...a) => calls.push(['emote', ...a]) };
  const sync = { others: ['p2'], status: { partners: { p2: {} } }, onWorld: (f) => ((worldIn = f), () => {}), sendWorld: () => new Set(['p2']) };
  const w = new SharedWorld({ sync, me: 'p1', frame: () => ({ contentWindow: { __world: fake } }) });
  clearInterval(w.timer);
  for (const m of [TG.packStatus({}), TG.packPing({ id: 'abcdef12' }), { t: 'tg', op: 'g-ask', id: 'abcdef12', to: 'p1', gen: 3, item: 13, n: 1, pocket: 'items' }]) worldIn({ ...m, from: 'p2' });
  assert.deepEqual(calls, []);
  w.stop();
  const R = await import('../shared/rps.mjs');
  const hub = new R.RpsHub({ me: 'p1', send: () => {} });
  await hub.receive({ ...TG.packStatus({}), from: 'p2' });
  assert.equal(hub.games.size, 0);
});
