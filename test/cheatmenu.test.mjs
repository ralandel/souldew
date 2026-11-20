// The cheats menu of 3.0 (shared/live/cheats.mjs CHEATS, web/views/cheatmenu.mjs): Poké Balls, healing items and money
// next to the Rare Candies and Max Repels, an amount to pick, offered only in the games each was checked in (the ROM
// test matrix: scripts/rom-matrix.mjs --cheats), which ones a run allows (shared/rules.mjs cheatSet – the host's call),
// the log (named for every player, readable by an older partner's app), trophies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry } from '../shared/live/parse.mjs';
import {
  CHEATS, CHEAT_GROUPS, CHEAT_AMOUNTS, MONEY_STEPS, MONEY_MAX, MASTER_BALL, ULTRA_BALL, POKE_BALL, FULL_RESTORE, REVIVE, MAX_REVIVE,
  applyCheat, addItem, cheatSupported, cheatsFor, checkedLive, bagLayoutKey, cheatAllowed, cheatBlock, moneySupported, moneyCheat, readMoneyFor,
} from '../shared/live/cheats.mjs';
import { DEFAULT_RULES, NEW_RUN_RULES, LEGACY_CHEAT_GROUPS, cheatGroups, cheatSetOf, rulesWithDefaults } from '../shared/rules.mjs';
import { SOULLINK_RULE_KEYS, soulLinkDefaults, soulLinkRulesFrom } from '../shared/hostrules.mjs';
import { GB_GIFT_ITEMS } from '../shared/giftitems.mjs';
import { worldTable } from '../shared/world.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/')) return next(ROOT + spec.slice(1), ctx);
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const M = await import('../web/views/cheatmenu.mjs');
const T = await import('../shared/trophies.mjs');

const TABLE = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url)));
const API = JSON.parse(readFileSync(new URL('../shared/data/pokeapi.json', import.meta.url)));
const entry = (h) => findEntry(TABLE, h);

function memory() {
  const blocks = [];
  const mem = {
    writes: 0,
    poke(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
    read(addr, len) {
      const out = new Uint8Array(len);
      for (const b of blocks) for (let i = 0; i < len; i++) { const o = addr + i - b.addr; if (o >= 0 && o < b.bytes.length) out[i] = b.bytes[o]; }
      return out;
    },
    write(addr, bytes) { mem.writes++; mem.poke(addr, bytes); return true; },
  };
  return mem;
}
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const slot = (id, qty) => [...le16(id), ...le16(qty)];
const u16 = (m, a) => { const b = m.read(a, 2); return b[0] | (b[1] << 8); };
const u32 = (m, a) => { const b = m.read(a, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
const g7 = (id, qty, sort = 0, isNew = false) => le32((id | (qty << 10) | (sort << 20) | (isNew ? 0x40000000 : 0)) >>> 0);

const RED = entry({ platform: 'gb', title: 'POKEMON RED' });
const YELLOW = entry({ platform: 'gb', title: 'POKEMON YELLOW' });
const GOLD = entry({ platform: 'gbc', title: 'POKEMON_GLD', code: 'AAUE' });
const CRYSTAL = entry({ platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' });
const RUBY = entry({ platform: 'gba', code: 'AXVE' });
const EMERALD = entry({ platform: 'gba', code: 'BPEE' });
const EMERALD_DE = entry({ platform: 'gba', code: 'BPED' });
const FR = entry({ platform: 'gba', code: 'BPRE' });
const FR_DE = entry({ platform: 'gba', code: 'BPRD' });
const HG = entry({ platform: 'nds', code: 'IPKE' });
const DIAMOND = entry({ platform: 'nds', code: 'ADAE' });
const PLATINUM = entry({ platform: 'nds', code: 'CPUE' });
const BLACK = entry({ platform: 'nds', code: 'IRBO' });
const WHITE = entry({ platform: 'nds', code: 'IRAO' });
const BLACK2 = entry({ platform: 'nds', code: 'IREO' });
const ctr = (titleId) => entry({ platform: '3ds', titleId });
const SUN = ctr('0004000000164800');
const UM = ctr('00040000001B5100');
const XY = ctr('0004000000055D00');
const ORAS = ctr('000400000011C400');
const NEW_ITEMS = ['masterBall', 'ultraBall', 'pokeBall', 'fullRestore', 'revive', 'maxRevive'];

// ---- the cheats and their items ------------------------------------------------------------------------------

test('the items: their number in every generation is the PokeAPI item of that name (pret for Gen 1/2)', () => {
  for (const [id, c] of Object.entries(CHEATS)) {
    if (c.money) continue;
    for (const gen of [3, 4, 5, 6, 7]) assert.equal(API.items[`gen${gen}`][c.items[gen]], c.key, `${id} gen ${gen}`);
    // Gen 1/2: the gift list's names (pret item constants) – the Master Ball is never a gift, so it isn't on that list
    for (const gen of [1, 2]) if (c.key !== 'master-ball') assert.equal(GB_GIFT_ITEMS[gen][c.items[gen]], c.key, `${id} gen ${gen}`);
    assert.equal(API.items.names.en[c.key], c.en, `${id}: its English name for an older app's log`);
  }
  assert.deepEqual([MASTER_BALL[1], MASTER_BALL[2], ULTRA_BALL[1], ULTRA_BALL[2], POKE_BALL[1], POKE_BALL[2]], [1, 1, 2, 2, 4, 5]);
  assert.deepEqual([FULL_RESTORE[3], REVIVE[3], MAX_REVIVE[3], FULL_RESTORE[7], REVIVE[7], MAX_REVIVE[7]], [19, 24, 25, 23, 28, 29]);
  assert.deepEqual(Object.keys(CHEATS), ['rareCandy', 'maxRepel', ...NEW_ITEMS, 'money']);
  // every cheat belongs to a group a run can allow
  assert.ok(Object.values(CHEATS).every((c) => CHEAT_GROUPS.includes(c.group)));
  assert.deepEqual(CHEAT_AMOUNTS, [1, 10, 99]);
  assert.deepEqual(MONEY_STEPS, [1000, 10000, 100000, 'max']);
  assert.equal(MONEY_MAX, 999999);
});

test('which games get the new cheats: only bag layouts they were checked in – Rare Candies and Max Repels stay everywhere', () => {
  const checked = { RED, YELLOW, GOLD, CRYSTAL, RUBY, EMERALD, EMERALD_DE, FR, FR_DE, HG, DIAMOND, PLATINUM, BLACK, WHITE, BLACK2, SUN, UM,
    SILVER: entry({ platform: 'gbc', title: 'POKEMON_SLV', code: 'AAXE' }), BLUE: entry({ platform: 'gb', title: 'POKEMON BLUE' }),
    SAPPHIRE_DE: entry({ platform: 'gba', code: 'AXPD' }), LG: entry({ platform: 'gba', code: 'BPGE' }), LG_ES: entry({ platform: 'gba', code: 'BPGS' }),
    SS: entry({ platform: 'nds', code: 'IPGE' }), PEARL: entry({ platform: 'nds', code: 'APAE' }), WHITE2: entry({ platform: 'nds', code: 'IRDO' }),
    MOON: ctr('0004000000175E00'), US: ctr('00040000001B5000') };
  for (const [name, e] of Object.entries(checked)) {
    assert.ok(checkedLive(e), name);
    for (const id of NEW_ITEMS) assert.ok(cheatSupported(e, id), `${name} ${id}`);
  }
  // not checked in a running game: X/Y, Omega Ruby/Alpha Sapphire – the first two cheats only
  for (const [name, e] of Object.entries({ XY, ORAS })) {
    assert.equal(checkedLive(e), false, name);
    assert.deepEqual(cheatsFor(e), ['rareCandy', 'maxRepel'], name);
    for (const id of NEW_ITEMS) assert.equal(cheatSupported(e, id), false, `${name} ${id}`);
    assert.deepEqual(applyCheat('masterBall', e, memory(), {}), { error: 'unsupported' }, `${name}: not written untried`);
  }
  // another-language DS game (found through its own party search), a Game Boy hack with moved RAM, a found GBA build
  const hgDe = entry({ platform: 'nds', code: 'IPKD' });
  assert.match(hgDe.id, /~/);
  assert.equal(bagLayoutKey(hgDe), 'ds:hgss~lang');
  assert.deepEqual(cheatsFor(hgDe), ['rareCandy', 'maxRepel']);
  const moved = { ...CRYSTAL, wram: { delta: 11, moved: { '0xD892': 1 } } };
  assert.deepEqual(cheatsFor(moved), ['rareCandy', 'maxRepel'], 'a Game Boy hack with moved RAM (Crystal Legacy)');
  assert.equal(bagLayoutKey(moved), 'gb:crystal_us~moved');
  const goldMoved = { ...GOLD, wram: { delta: 11, moved: { '0xD5B7': 1 } } };
  assert.deepEqual(cheatsFor(goldMoved), ['rareCandy', 'maxRepel']);
  const found = { ...EMERALD, id: 'emerald_us', scan3: true, retail3: true };
  assert.equal(bagLayoutKey(found), 'gba:emerald~found');
  assert.deepEqual(cheatsFor(found), ['rareCandy', 'maxRepel']);
  // the layout names
  assert.deepEqual([RED, GOLD, RUBY, EMERALD_DE, FR, FR_DE, HG, BLACK2, UM].map(bagLayoutKey),
    ['gb:red_us', 'gb:gold_us', 'gba:ruby', 'gba:emerald', 'gba:firered', 'gba:firered-eu', 'ds:hgss', 'ds:bw', 'ctr:usum']);
  assert.equal(bagLayoutKey(null), '');
  // the ROM test matrix may try anything the layout knows
  assert.ok(cheatSupported(ORAS, 'masterBall', { untried: true }));
  assert.ok(cheatSupported(XY, 'fullRestore', { untried: true }));
});

test('money: offered where it was checked – the Game Boy, GBA and DS games with a known money address (Gen 3 in both languages), not the 3DS games', () => {
  for (const e of [RED, YELLOW, GOLD, CRYSTAL, RUBY, EMERALD, EMERALD_DE, FR, FR_DE, HG, DIAMOND, PLATINUM, BLACK, WHITE, BLACK2, entry({ platform: 'nds', code: 'IRDO' })]) {
    assert.ok(moneySupported(e), e.id);
    assert.ok(cheatsFor(e).includes('money'), e.id);
  }
  for (const e of [SUN, UM, XY, ORAS, entry({ platform: 'nds', code: 'IPKD' }), { ...EMERALD, scan3: true, retail3: true }, { ...GOLD, wram: { delta: 11, moved: { '0xD5B7': 1 } } }]) {
    assert.equal(moneySupported(e), false, e.id);
  }
  assert.equal(moneySupported(null), false);
});

// ---- items: pockets, amounts, caps --------------------------------------------------------------------------

test('Gen 1: every item into the one bag, the amount picked, 99 a stack', async () => {
  const m = memory();
  m.poke(0xd31d, [1, 0x14, 2, 0xff]); // Potion ×2
  m.poke(0xd347, [0x00, 0x30, 0x00]); // ₽3000 (BCD)
  assert.deepEqual(applyCheat('masterBall', RED, m, {}, { amount: 1 }), { ok: true, before: 0, after: 1, added: 1 });
  assert.deepEqual(applyCheat('masterBall', RED, m, {}, { amount: 10 }), { ok: true, before: 1, after: 11, added: 10 });
  assert.deepEqual(applyCheat('masterBall', RED, m, {}, { amount: 99 }), { ok: true, before: 11, after: 99, added: 88 });
  assert.deepEqual(applyCheat('masterBall', RED, m, {}, { amount: 1 }), { error: 'max', before: 99 });
  for (const id of ['ultraBall', 'pokeBall', 'fullRestore', 'revive', 'maxRevive']) assert.equal(applyCheat(id, RED, m, {}).ok, true, id);
  assert.deepEqual([...m.read(0xd31d, 16)], [7, 0x14, 2, 0x01, 99, 0x02, 10, 0x04, 10, 0x10, 10, 0x35, 10, 0x36, 10, 0xff]);
  // without an amount: the cheat's own (one Master Ball, ten of the others)
  const n = memory();
  n.poke(0xd31d, [0, 0xff]);
  n.poke(0xd347, [0, 0, 0]);
  assert.equal(applyCheat('masterBall', RED, n, {}).added, 1);
  assert.equal(applyCheat('fullRestore', RED, n, {}).added, 10);
  assert.equal(applyCheat('rareCandy', RED, n, {}).added, 99);
});

test('Gen 2: the balls into the Ball pocket – its 12 slots, never past them into the PC’s items – the rest into Items', () => {
  const m = memory();
  m.poke(0xd5b7, [0, 0xff]);
  m.poke(0xd5e1, [0, 0xff]);
  const balls = 0xd5e1 + 27;
  m.poke(balls, [0, 0xff]);
  assert.equal(applyCheat('ultraBall', GOLD, m, {}, { amount: 10 }).ok, true);
  assert.equal(applyCheat('fullRestore', GOLD, m, {}, { amount: 1 }).ok, true);
  assert.deepEqual([...m.read(balls, 4)], [1, 0x02, 10, 0xff]);
  assert.deepEqual([...m.read(0xd5b7, 4)], [1, 0x0e, 1, 0xff]);
  // a full Ball pocket: 12 kinds of ball – no thirteenth (it would overwrite the PC's item count behind it)
  const full = memory();
  full.poke(0xd5b7, [0, 0xff]);
  full.poke(0xd5e1, [0, 0xff]);
  full.poke(balls, [12, ...Array.from({ length: 12 }, (_, i) => [0x9d + i, 1]).flat(), 0xff]);
  full.poke(balls + 26, [3]); // the PC's item count right behind
  assert.deepEqual(applyCheat('masterBall', GOLD, full, {}), { error: 'full' });
  assert.equal(full.writes, 0);
  // more than 12 in the count: not the pocket
  const bad = memory();
  bad.poke(0xd5b7, [0, 0xff]);
  bad.poke(0xd5e1, [0, 0xff]);
  bad.poke(balls, [13, ...Array.from({ length: 13 }, () => [0x05, 1]).flat(), 0xff]);
  assert.deepEqual(applyCheat('pokeBall', GOLD, bad, {}), { error: 'notFound' });
});

/** A Gen 3 bag behind the save block pointers (Emerald / FireRed), quantities XOR the key's low half, money XOR all of it. */
function gen3(L, { key = 0x1234abcd, sb1 = 0x02025a00, sb2 = 0x02024a00, money = 3000, entry = null } = {}) {
  const m = memory();
  // (`entry`: the game's main callback is its overworld's – a player standing in the overworld, shared/world.mjs readCamera)
  const t = entry && worldTable(entry);
  if (t?.fieldCb2s) m.poke(t.main + 4, le32(t.fieldCb2s[0]));
  const k = key & 0xffff;
  m.poke(L.sb1Ptr, le32(sb1));
  m.poke(L.sb2Ptr, le32(sb2));
  m.poke(sb2 + L.keyOff, le32(key));
  m.poke(sb1 + L.money, le32((money ^ key) >>> 0));
  m.poke(sb1 + L.items, [...slot(13, 5 ^ k), ...slot(0, k)]);
  m.poke(sb1 + L.balls, [...slot(0, k)]);
  return { m, sb1, k, key };
}
const EM = { sb1Ptr: 0x03005d8c, sb2Ptr: 0x03005d90, keyOff: 0xac, money: 0x490, items: 0x560, balls: 0x650 };
const FRL = { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, keyOff: 0xf20, money: 0x290, items: 0x310, balls: 0x430 };

test('Gen 3: balls into the Poké Ball pocket, healing items into Items – encrypted like the game keeps them', () => {
  for (const [e, L] of [[EMERALD, EM], [EMERALD_DE, EM], [FR, FRL]]) {
    const { m, sb1, k } = gen3(L, { entry: e });
    assert.deepEqual(applyCheat('masterBall', e, m, {}, { amount: 10 }), { ok: true, before: 0, after: 10, added: 10 }, e.id);
    assert.deepEqual([u16(m, sb1 + L.balls), u16(m, sb1 + L.balls + 2) ^ k], [1, 10]);
    assert.deepEqual(applyCheat('maxRevive', e, m, {}, { amount: 99 }), { ok: true, before: 0, after: 99, added: 99 });
    assert.deepEqual([u16(m, sb1 + L.items + 4), u16(m, sb1 + L.items + 6) ^ k], [25, 99]);
    assert.deepEqual(applyCheat('maxRevive', e, m, {}, { amount: 1 }), { error: 'max', before: 99 });
  }
  // Ruby/Sapphire: plain quantities
  const sb1 = 0x02025734;
  const m = memory();
  m.poke(sb1 + 0x490, le32(3000));
  m.poke(sb1 + 0x600, slot(4, 3));
  m.poke(worldTable(RUBY).main + 4, le32(worldTable(RUBY).fieldCb2s[0])); // (standing in the overworld)
  assert.deepEqual(applyCheat('pokeBall', RUBY, m, {}, { amount: 99 }), { ok: true, before: 3, after: 99, added: 96 });
  assert.equal(u16(m, sb1 + 0x602), 99);
});

test('Gen 3: a cheat only while you stand in the overworld – never during a fade, a menu or text, a battle or a replay', async () => {
  // Emerald and FireRed/LeafGreen move their save blocks on a map change (behind a fade): a bag found a moment earlier
  // would be written where the game no longer reads (the same check wagers are paid by)
  for (const [e, L] of [[EMERALD, EM], [FR, FRL]]) {
    const t = worldTable(e);
    const hold = {
      fade: [t.paletteFade + 4, [0x00, 0x04, 0, 0x80]], // (the palette fade running, half way)
      locked: [t.lock, [1]], // (a menu, a text, a script)
      battle: [t.inBattle.addr, [t.inBattle.mask]],
      ...(t.help ? { help: [t.help, [1]] } : {}),
      ...(t.questLog ? { replay: [t.questLog, [2]] } : {}),
    };
    for (const [why, [addr, on]] of Object.entries(hold)) {
      const { m, sb1, k } = gen3(L, { entry: e });
      m.poke(addr, on);
      assert.deepEqual(applyCheat('masterBall', e, m, {}, { amount: 10 }), { error: 'busy' }, `${e.id}: ${why}`);
      assert.deepEqual(await applyCheat('money', e, m, {}, { amount: 1000 }), { error: 'busy' }, `${e.id}: ${why} (money)`);
      assert.equal(m.writes, 0, `${e.id}: nothing written (${why})`);
      m.poke(addr, on.map(() => 0)); // let go: it goes in
      assert.deepEqual(applyCheat('masterBall', e, m, {}, { amount: 10 }), { ok: true, before: 0, after: 10, added: 10 }, `${e.id}: after ${why}`);
      assert.deepEqual([u16(m, sb1 + L.balls), u16(m, sb1 + L.balls + 2) ^ k], [1, 10]);
    }
    // the save block pointer moving (out of the RAM it can be in): no camera, no cheat
    const { m } = gen3(L, { entry: e });
    m.poke(L.sb1Ptr, le32(0));
    assert.deepEqual(applyCheat('masterBall', e, m, {}, { amount: 10 }), { error: 'busy' });
  }
  // the title screen and the Continue menu (checked live in Emerald, fast player): the save is loaded at boot, nothing
  // holds the player – but the main callback isn't the overworld's, and New Game would throw the cheat away
  for (const [e, L] of [[EMERALD, EM], [EMERALD_DE, EM], [FR, FRL]]) {
    const t = worldTable(e);
    const { m, sb1, k } = gen3(L, { entry: e });
    m.poke(t.main + 4, le32(0x0800aa91)); // (another callback: the title screen's, the main menu's)
    assert.deepEqual(applyCheat('masterBall', e, m, {}, { amount: 10 }), { error: 'busy' }, `${e.id}: main menu`);
    assert.deepEqual(await applyCheat('money', e, m, {}, { amount: 1000 }), { error: 'busy' }, `${e.id}: main menu (money)`);
    assert.equal(m.writes, 0);
    // every revision's overworld counts – the cheats read no ROM header (FireRed / LeafGreen 1.1: another address)
    for (const cb2 of t.fieldCb2s) {
      m.poke(t.main + 4, le32(cb2));
      assert.equal(applyCheat('masterBall', e, m, {}, { amount: 1 }).ok, true, `${e.id}: ${cb2.toString(16)}`);
    }
    assert.deepEqual([u16(m, sb1 + L.balls), u16(m, sb1 + L.balls + 2) ^ k], [1, t.fieldCb2s.length]);
  }
  assert.equal(worldTable(FR).fieldCb2s.length, 2, 'FireRed 1.0 and 1.1');
  // a language whose overworld callback isn't known (FireRed French): no callback check, the rest as before
  const FR_FR = entry({ platform: 'gba', code: 'BPRF' });
  assert.equal(worldTable(FR_FR).fieldCb2s, null);
  // the toast says what to do
  assert.match(M.cheatFailText('masterBall', { error: 'busy' }, { gen: 3 }).text, /Try again in a moment/);
  // the other generations (their bag doesn't move) and a game without a Shared World table: as before
  assert.equal(applyCheat('masterBall', RED, memory(), {}).error, 'notFound');
});

/** A Gen 4/5 bag: a key item, a TM, a Potion in Medicine. */
function dsBag(m, bag, { key, tm, medicine }, { tmItem = 425 } = {}) {
  m.poke(bag + key, slot(468, 1));
  m.poke(bag + tm, slot(tmItem, 1));
  m.poke(bag + medicine, slot(17, 2));
}

test('Gen 4: balls into the Poké Ball pocket, healing items into Medicine, 999 a stack; Gen 5 keeps the balls with the items', () => {
  const saveBase = 0x0227c2c8;
  const bag = saveBase + 0x10 + 0x644;
  const m = memory();
  dsBag(m, bag, { key: 0x294, tm: 0x35c, medicine: 0x520 });
  assert.deepEqual(applyCheat('ultraBall', HG, m, { saveBase }, { amount: 99 }), { ok: true, before: 0, after: 99, added: 99 });
  assert.deepEqual([u16(m, bag + 0x6c0), u16(m, bag + 0x6c2)], [2, 99]);
  assert.deepEqual(applyCheat('fullRestore', HG, m, { saveBase }, { amount: 10 }), { ok: true, before: 0, after: 10, added: 10 });
  assert.deepEqual([u16(m, bag + 0x524), u16(m, bag + 0x526)], [23, 10]);
  m.poke(bag + 0x6c2, le16(950));
  assert.deepEqual(applyCheat('ultraBall', HG, m, { saveBase }, { amount: 99 }), { ok: true, before: 950, after: 999, added: 49 });
  // Black: the balls go into Items (no pocket of their own), Revives into Medicine
  const partyAddr = 0x022349ac;
  const b5 = partyAddr - 0xa00;
  const n = memory();
  dsBag(n, b5, { key: 0x4d8, tm: 0x624, medicine: 0x7d8 }, { tmItem: 618 });
  assert.equal(applyCheat('masterBall', BLACK, n, { partyAddr }, { amount: 1 }).ok, true);
  assert.equal(applyCheat('revive', BLACK, n, { partyAddr }, { amount: 10 }).ok, true);
  assert.deepEqual([u16(n, b5), u16(n, b5 + 2), u16(n, b5 + 0x7d8 + 4), u16(n, b5 + 0x7d8 + 6)], [1, 1, 28, 10]);
});

test('an empty DS bag takes a cheat only where its place is confirmed: the save data’s own pointer or address, the checked party there, a trainer block', async () => {
  // Diamond right after the starter: the save data through the game's pointer, the party at +0x2AC, a name and ₽3000
  const saveBase = 0x02270000;
  const dp = (o = {}) => {
    const m = memory();
    m.poke(saveBase + 0x214 + 0x64, o.name ?? [0x2b, 0x01]);
    m.poke(saveBase + 0x214 + 0x78, le32(o.money ?? 3000));
    return m;
  };
  const state = { saveBase, partyAddr: saveBase + 0x2ac - 8 };
  const m = dp();
  assert.deepEqual(applyCheat('rareCandy', DIAMOND, m, state, { amount: 10 }), { ok: true, before: 0, after: 10, added: 10 });
  assert.deepEqual([u16(m, saveBase + 0x214 + 0x624 + 0x51c), u16(m, saveBase + 0x214 + 0x624 + 0x51e)], [50, 10]);
  assert.equal(applyCheat('pokeBall', DIAMOND, m, state, { amount: 10 }).ok, true);
  // refused – "pick up or buy any item first" – and nothing written: no pointer (a searched party), a party elsewhere
  // than the save data keeps it, no trainer name, money that isn't money
  const refused = [
    ['a searched party', dp(), { partyAddr: state.partyAddr }],
    ['the party elsewhere', dp(), { saveBase, partyAddr: state.partyAddr + 0x100 }],
    ['no party read', dp(), { saveBase }],
    ['no trainer name', dp({ name: [0, 0] }), state],
    ['a name that is a terminator', dp({ name: [0xff, 0xff] }), state],
    ['money past ₽999,999', dp({ money: 1000000 }), state],
  ];
  for (const [why, mem, st] of refused) {
    assert.deepEqual(applyCheat('rareCandy', DIAMOND, mem, st), { error: 'notFound', why: 'empty' }, why);
    assert.equal(mem.writes, 0, why);
  }
  // not even an empty bag (a TM where none can be): the plain notFound
  const broken = dp();
  broken.poke(saveBase + 0x214 + 0x624 + 0x35c, slot(17, 1));
  assert.deepEqual(applyCheat('rareCandy', DIAMOND, broken, state), { error: 'notFound' });
  // the add-a-Rare-Candy path of before stays as it was (no empty bag)
  assert.deepEqual(addItem(DIAMOND, dp(), state, 50, 1), { error: 'notFound' });
  // Black before the Town Map: the party at the game's own address, the trainer's name and the money at their places
  const partyAddr = 0x022349ac;
  const save5 = partyAddr - 0x18e00;
  const bw = (o = {}) => {
    const b = memory();
    b.poke(save5 + 0x19404, o.name ?? [0x2b, 0x01]);
    b.poke(save5 + (o.moneyAt ?? 0x21200), le32(o.money ?? 3000));
    return b;
  };
  const b = bw();
  assert.deepEqual(applyCheat('revive', BLACK, b, { partyAddr }, { amount: 10 }), { ok: true, before: 0, after: 10, added: 10 });
  assert.deepEqual([u16(b, partyAddr - 0xa00 + 0x7d8), u16(b, partyAddr - 0xa00 + 0x7da)], [28, 10]);
  assert.deepEqual(await moneyCheatOf(BLACK, b, partyAddr), 4000, 'the money too');
  // Black 2: its misc block earlier
  assert.equal(applyCheat('masterBall', BLACK2, bw({ moneyAt: 0x21100 }), { partyAddr }).ok, true);
  for (const [why, mem, e] of [['no name', bw({ name: [0, 0] }), BLACK], ['money that isn’t money', bw({ moneyAt: 0x21100, money: 0x01000000 }), BLACK2],
    ['another language (a searched party)', bw(), { ...BLACK, id: 'black_us~IRBD' }]]) {
    assert.deepEqual(applyCheat('rareCandy', e, mem, { partyAddr }), { error: 'notFound', why: 'empty' }, why);
    assert.equal(mem.writes, 0, why);
  }
  // the menu says what to do
  assert.match(M.cheatFailText('rareCandy', { error: 'notFound', why: 'empty' }, { gen: 4 }).text, /^Your bag is still empty[^\n]*Pick up or buy any item first/);
});
const moneyCheatOf = async (e, m, partyAddr) => (await moneyCheat(e, m, { partyAddr }, 1000)).after;

test('Sun/Moon, Ultra Sun/Ultra Moon: the balls into Items, healing items into Medicine (NEW, not in Free Space)', () => {
  const base = 0x330d5934;
  const m = memory();
  m.poke(base + 0x6b8, g7(845, 1, 0, true));
  m.poke(base + 0xde0, [0xb48, 0x000, 0x998, 0xc48, 0x6b8, 0xd68].flatMap((o) => le32(base + o)));
  assert.deepEqual(applyCheat('masterBall', SUN, m, {}, { amount: 99 }), { ok: true, before: 0, after: 99, added: 99 });
  assert.equal(u32(m, base), (1 | (99 << 10) | 0x40000000) >>> 0);
  assert.deepEqual(applyCheat('maxRevive', SUN, m, {}, { amount: 10 }), { ok: true, before: 0, after: 10, added: 10 });
  assert.equal(u32(m, base + 0xb48), (29 | (10 << 10) | 0x40000000) >>> 0);
  // a healing item never into Items, a ball never into Medicine
  assert.deepEqual(addItem(SUN, m, {}, 4, 1), { error: 'unsupported' });
  assert.deepEqual(addItem(SUN, m, {}, 23, 1, { pocket: 'balls' }), { error: 'unsupported' });
  const ub = 0x33011934;
  const um = memory();
  um.poke(ub + 0x6ac, g7(845, 1));
  um.poke(ub + 0xe28, [0xb74, 0x000, 0x9c4, 0xc64, 0x6ac, 0xd70, 0xdfc].flatMap((o) => le32(ub + o)));
  assert.equal(applyCheat('ultraBall', UM, um, {}, { amount: 10 }).ok, true);
  assert.equal(applyCheat('fullRestore', UM, um, {}, { amount: 1 }).ok, true);
  assert.deepEqual([u32(um, ub), u32(um, ub + 0xb74)], [(2 | (10 << 10) | 0x40000000) >>> 0, (23 | (1 << 10) | 0x40000000) >>> 0]);
});

test('an amount out of range falls back to the cheat’s own; more than 999 is never asked for', () => {
  const m = memory();
  m.poke(0xd31d, [0, 0xff]);
  m.poke(0xd347, [0, 0, 0]);
  assert.equal(applyCheat('revive', RED, m, {}, { amount: 0 }).added, 10);
  assert.equal(applyCheat('revive', RED, m, {}, { amount: 'lots' }).after, 20);
  const saveBase = 0x0227c2c8;
  const n = memory();
  dsBag(n, saveBase + 0x10 + 0x644, { key: 0x294, tm: 0x35c, medicine: 0x520 });
  assert.equal(applyCheat('revive', HG, n, { saveBase }, { amount: 5000 }).added, 999);
});

// ---- money ---------------------------------------------------------------------------------------------------

test('money, Gen 1: BCD behind the bag – added, set to the most, read back; nothing without a bag', async () => {
  const m = memory();
  m.poke(0xd31d, [0, 0xff]);
  m.poke(0xd347, [0x00, 0x30, 0x00]); // ₽3000
  assert.equal(await readMoneyFor(RED, m.read, {}), 3000);
  assert.deepEqual(await moneyCheat(RED, m, {}, 10000), { ok: true, before: 3000, after: 13000, added: 10000 });
  assert.deepEqual([...m.read(0xd347, 3)], [0x01, 0x30, 0x00]);
  assert.deepEqual(await applyCheat('money', RED, m, {}, { amount: 'max' }), { ok: true, before: 13000, after: 999999, added: 986999 });
  assert.deepEqual([...m.read(0xd347, 3)], [0x99, 0x99, 0x99]);
  assert.deepEqual(await moneyCheat(RED, m, {}, 1000), { error: 'max', before: 999999 });
  // Yellow: its own addresses; a broken bag (no terminator) – the money isn't touched either
  const y = memory();
  y.poke(0xd31c, [1, 0x14, 2, 0x00]);
  y.poke(0xd346, [0x00, 0x30, 0x00]);
  assert.deepEqual(await moneyCheat(YELLOW, y, {}, 1000), { error: 'notFound' });
  assert.equal(y.writes, 0);
  // money that isn't BCD
  const z = memory();
  z.poke(0xd31d, [0, 0xff]);
  z.poke(0xd347, [0xab, 0, 0]);
  assert.deepEqual(await moneyCheat(RED, z, {}, 1000), { error: 'notFound' });
  // an amount that isn't one
  assert.deepEqual(await moneyCheat(RED, m, {}, -5), { error: 'unsupported' });
});

test('money, Gen 2: three bytes big-endian (Gold), capped at ₽999,999', async () => {
  const m = memory();
  m.poke(0xd5b7, [0, 0xff]);
  m.poke(0xd5e1, [0, 0xff]);
  m.poke(0xd573, [0x00, 0x0b, 0xb8]); // ₽3000
  assert.deepEqual(await moneyCheat(GOLD, m, {}, 100000), { ok: true, before: 3000, after: 103000, added: 100000 });
  assert.deepEqual([...m.read(0xd573, 3)], [0x01, 0x92, 0x58]);
  m.poke(0xd573, [0x0f, 0x42, 0x0f]); // ₽999,951
  assert.deepEqual(await moneyCheat(GOLD, m, {}, 1000), { ok: true, before: 999951, after: 999999, added: 48 });
});

test('money, Gen 3: SaveBlock1 + money, XORed with the whole key (Emerald, FireRed, both languages); Ruby plain', async () => {
  for (const [e, L] of [[EMERALD, EM], [EMERALD_DE, EM], [FR, FRL]]) {
    const { m, sb1, key } = gen3(L, { money: 2400 });
    assert.equal(await readMoneyFor(e, m.read, {}), 2400, e.id);
    assert.deepEqual(await moneyCheat(e, m, {}, 'max'), { ok: true, before: 2400, after: 999999, added: 997599 });
    assert.equal((u32(m, sb1 + L.money) ^ key) >>> 0, 999999);
    // the key half the bag uses must agree: a wrong key (the money makes no sense) – nothing written
    const w = gen3(L);
    w.m.poke(0x02024a00 + L.keyOff, le32(0x0badf00d));
    assert.deepEqual(await moneyCheat(e, w.m, {}, 1000), { error: 'notFound' });
    assert.equal(w.m.writes, 0);
  }
  const g = memory();
  const FR_EU = { ...FRL, sb1Ptr: 0x03004f58, sb2Ptr: 0x03004f5c };
  const de = gen3(FR_EU);
  assert.equal((await moneyCheat(FR_DE, de.m, {}, 1000)).after, 4000);
  g.poke(0x02025734 + 0x490, le32(3000));
  assert.deepEqual(await moneyCheat(RUBY, g, {}, 1000), { ok: true, before: 3000, after: 4000, added: 1000 });
});

/** Game records that decode (shared/linkbattle.mjs decodeRecords): all counts 0, encrypted with sum 0 and modifier 0. */
function records({ size, from, to }) {
  const b = new Uint8Array(size);
  let x = 0;
  for (let o = from; o < to; o += 2) {
    x = (Math.imul(x, 0x41c64e6d) + 0x6073) >>> 0;
    b[o] = (x >>> 16) & 0xff;
    b[o + 1] = x >>> 24;
  }
  return b;
}

test('money, Gen 4/5: where the save data says – and only where the party reader found the same save data', async () => {
  // HeartGold: the save data pointer, the game records' sum, a trainer name, the money in the trainer block
  const save = 0x0227c2c8;
  const m = memory();
  m.poke(0x02111880, le32(save));
  dsBag(m, save + 0x10 + 0x644, { key: 0x294, tm: 0x35c, medicine: 0x520 });
  m.poke(save + 0x10 + 0x64, [0x2b, 0x01]); // a trainer name
  m.poke(save + 0x10 + 0x78, le32(2400));
  m.poke(save + 0x10 + 0x4b3c, records({ size: 0x1c0, from: 8, to: 0x1bc }));
  assert.deepEqual(await moneyCheat(HG, m, { saveBase: save }, 10000), { ok: true, before: 2400, after: 12400, added: 10000 });
  assert.equal(u32(m, save + 0x10 + 0x78), 12400);
  // the party reader followed other save data: not this money
  assert.deepEqual(await moneyCheat(HG, m, { saveBase: save + 0x40000 }, 10000), { error: 'notFound' });
  // Black: the save data at its address, the money 0x8400 past the party block the live reader found
  const s5 = 0x0221bbac;
  const partyAddr = s5 + 0x18e00;
  const n = memory();
  dsBag(n, partyAddr - 0xa00, { key: 0x4d8, tm: 0x624, medicine: 0x7d8 }, { tmItem: 618 });
  n.poke(s5 + 0x19404, [0x2b, 0x01]);
  n.poke(s5 + 0x21200, le32(5000));
  assert.deepEqual(await moneyCheat(BLACK, n, { partyAddr }, 'max'), { ok: true, before: 5000, after: 999999, added: 994999 });
  assert.deepEqual(await moneyCheat(BLACK, n, { partyAddr: partyAddr + 0x20 }, 1000), { error: 'notFound' }, 'another party: not this money');
  assert.deepEqual(await moneyCheat(BLACK, n, {}, 1000), { error: 'notFound' }, 'no party read yet');
});

test('money: a refused or unchanged write is no success; the 3DS-style later answer works too', async () => {
  const m = memory();
  m.poke(0xd31d, [0, 0xff]);
  m.poke(0xd347, [0x00, 0x30, 0x00]);
  assert.deepEqual(await moneyCheat(RED, { read: m.read, write: () => false }, {}, 1000), { error: 'write' });
  assert.deepEqual(await moneyCheat(RED, { read: m.read, write: () => true }, {}, 1000), { error: 'write' });
  assert.deepEqual(await moneyCheat(RED, { read: m.read, write: () => ({ ok: false, why: 'changed' }) }, {}, 1000), { error: 'changed' });
  const later = { read: m.read, write: (a, b) => new Promise((r) => setTimeout(() => r(m.write(a, b)), 5)) };
  assert.deepEqual(await moneyCheat(RED, later, {}, 1000), { ok: true, before: 3000, after: 4000, added: 1000 });
});

// ---- the run's rules ------------------------------------------------------------------------------------------

test('rules: cheats off by default; a new run allows every cheat unless the host picks some (cheatSet), a run from before 3.0 its two', () => {
  assert.equal(DEFAULT_RULES.cheats, false);
  assert.equal(DEFAULT_RULES.cheatSet, null, 'none: a run from before 3.0');
  assert.equal(NEW_RUN_RULES.cheatSet, 'all');
  assert.deepEqual(cheatGroups({ cheats: false, cheatSet: 'all' }), []);
  // a run from before 3.0 (or a host on 2.x): no cheatSet – what its rule said then, Rare Candies and Max Repels
  assert.deepEqual(LEGACY_CHEAT_GROUPS, ['rareCandy', 'maxRepel']);
  assert.deepEqual(cheatGroups({ cheats: true }), LEGACY_CHEAT_GROUPS);
  assert.deepEqual(Object.keys(CHEATS).filter((id) => cheatAllowed({ cheats: true }, id)), ['rareCandy', 'maxRepel']);
  assert.deepEqual(cheatGroups({ cheats: true, cheatSet: 'all' }), CHEAT_GROUPS);
  assert.deepEqual(cheatGroups({ cheats: true, cheatSet: 'money,rareCandy,nonsense' }), ['rareCandy', 'money'], 'the editor’s order, unknown ones dropped');
  assert.deepEqual(cheatGroups({ cheats: true, cheatSet: '' }), []);
  assert.equal(cheatSetOf(['money', 'rareCandy']), 'rareCandy,money');
  assert.equal(cheatSetOf([...CHEAT_GROUPS].reverse()), 'all');
  const rc = { cheats: true, cheatSet: 'rareCandy,maxRepel' };
  assert.deepEqual(Object.keys(CHEATS).filter((id) => cheatAllowed(rc, id)), ['rareCandy', 'maxRepel']);
  const balls = { cheats: true, cheatSet: 'balls' };
  assert.deepEqual(Object.keys(CHEATS).filter((id) => cheatAllowed(balls, id)), ['ultraBall', 'pokeBall'], 'the Master Ball is a group of its own');
  assert.equal(cheatAllowed({ cheats: true }, 'nonsense'), false);
  // stored rules keep it as they are; none stays none in both modes
  assert.equal(rulesWithDefaults({ cheats: true }, 'soullink').cheatSet, null);
  assert.equal(rulesWithDefaults({ cheats: true }, 'nuzlocke').cheatSet, null);
  assert.equal(rulesWithDefaults({ cheats: true, cheatSet: 'money' }, 'nuzlocke').cheatSet, 'money');
  // a SoulLink's rules: a new one starts with all of them; the host sets it with the others; a new attempt keeps it
  assert.ok(SOULLINK_RULE_KEYS.includes('cheatSet'));
  assert.equal(soulLinkDefaults().cheatSet, 'all');
  assert.equal(soulLinkRulesFrom({ cheats: true, cheatSet: 'money' }).cheatSet, 'money');
  assert.equal(soulLinkRulesFrom({ cheats: true }).cheatSet, null, 'a new attempt of a run from before 3.0 keeps its two cheats');
  assert.equal(soulLinkRulesFrom(null).cheatSet, 'all');
  // the play screen: a cheat the run doesn't allow is 'off', a link session blocks every cheat
  const ok = { supported: true, allowed: true, live: true, inBattle: false };
  assert.equal(cheatBlock({ ...ok, linked: true }), 'linked');
  assert.equal(cheatBlock({ ...ok, allowed: false, linked: true }), 'off');
});

// ---- the log --------------------------------------------------------------------------------------------------

const PAIR = { id: 'run1', game: { code: 'IPKE', system: 'nds' }, players: { p1: { name: 'Tim' }, p2: { name: 'Robin' } } };
const SOLO = { id: 'run1', game: { code: 'IPKE', system: 'nds' }, mode: 'nuzlocke', players: { p1: { name: 'Lou' } } };
function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}

/** How a 2.8 app renders a log line (its web/lib/run.mjs renderMsg: areas, species and nested messages only). */
function oldRender(m) {
  const vars = {};
  for (const [k, v] of Object.entries(m.vars || {})) vars[k] = v && typeof v === 'object' ? (v.species !== undefined ? `#${v.species}` : v.key ? oldRender(v) : '') : v;
  // (its t(): the key unknown → the default, {var} filled in, the plural form by `count`)
  const def = m.def.includes('|') ? m.def.split('|')[vars.count === 1 ? 0 : 1] : m.def;
  return def.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

test('the log: every item cheat named with its amount; money with what it is now – also for an older partner’s app', () => {
  const d = mkDoc({ cheats: true, cheatSet: 'all' });
  assert.equal(R.logCheat(d, PAIR, 'p1', { added: 10, cheat: 'masterBall', gen: 4 }), true);
  const of = (cheat) => R.feedList(d).find((x) => x.cheat === cheat); // (entries of the same millisecond: by their cheat)
  let f = of('masterBall');
  assert.deepEqual([f.type, f.slot, f.cheat, f.count], ['cheat', 'p1', 'masterBall', 10]);
  assert.equal(R.feedText(d, PAIR, f), 'used a cheat: 10 × #1', '(the names aren’t loaded in this test – the app names it)');
  assert.equal(oldRender(f.msg), 'used a cheat: 10 × Master Ball');
  assert.deepEqual(f.msg.vars.what, { item: 1, gen: 4, n: 10, itemKey: 'master-ball', key: 'cheat.legacy', def: '10 × Master Ball', vars: {} });
  // one: just the name
  R.logCheat(d, PAIR, 'p2', { added: 1, cheat: 'fullRestore', gen: 1 });
  f = of('fullRestore');
  assert.equal(oldRender(f.msg), 'used a cheat: Full Restore');
  assert.equal(f.msg.vars.what.item, 0x10);
  // money: how much and how much now
  R.logCheat(d, PAIR, 'p1', { added: 10000, cheat: 'money', gen: 3, after: 13000 });
  f = of('money');
  assert.deepEqual([f.cheat, f.count], ['money', 10000]);
  assert.equal(R.feedText(d, PAIR, f), 'used a cheat: +₽10,000 money (now ₽13,000)');
  assert.equal(oldRender(f.msg), 'used a cheat: +₽10,000 money (now ₽13,000)');
  // Rare Candies and Max Repels keep the lines older apps know, with the amount picked
  R.logCheat(d, PAIR, 'p1', { added: 10, cheat: 'rareCandy' });
  f = of('rareCandy');
  assert.equal(f.text, 'used a cheat: 10 Rare Candies');
  assert.equal(oldRender(f.msg), 'used a cheat: 10 Rare Candies');
  // solo
  const s = mkDoc({ cheats: true, cheatSet: 'all' });
  R.logCheat(s, SOLO, 'p1', { added: 99, cheat: 'revive', gen: 5 });
  assert.equal(oldRender(R.feedList(s)[0].msg), 'Cheat used: 99 × Revive');
  // nothing added, nothing logged
  assert.equal(R.logCheat(s, SOLO, 'p1', { added: 0, cheat: 'revive', gen: 5 }), false);
});

test('the log refuses a cheat the run’s rules don’t allow – the host picked others, or a run from before 3.0', () => {
  const old = mkDoc({ cheats: true });
  assert.equal(R.logCheat(old, PAIR, 'p1', { added: 1, cheat: 'masterBall', gen: 4 }), false, 'a run from before: its two cheats only');
  assert.equal(R.logCheat(old, PAIR, 'p1', { added: 10, cheat: 'maxRepel' }), true);
  const d = mkDoc({ cheats: true, cheatSet: 'rareCandy,maxRepel' });
  assert.equal(R.logCheat(d, PAIR, 'p1', { added: 1, cheat: 'masterBall', gen: 4 }), false);
  assert.equal(R.logCheat(d, PAIR, 'p1', { added: 1000, cheat: 'money', after: 4000 }), false);
  assert.equal(R.logCheat(d, PAIR, 'p1', { added: 99, cheat: 'rareCandy' }), true);
  assert.equal(R.feedList(d).length, 1);
  assert.equal(R.logCheat(mkDoc(), PAIR, 'p1', { added: 1, cheat: 'masterBall', gen: 4 }), false, 'cheats off');
});

test('changing which cheats are allowed is logged for everyone, naming them', () => {
  const d = mkDoc({ cheatSet: 'all' });
  const before = R.rules(d, PAIR);
  R.logRulesChange(d, PAIR, 'p1', before, { ...before, cheats: true, cheatSet: 'rareCandy,money' });
  const texts = R.feedList(d).map((f) => f.text).sort();
  assert.deepEqual(texts, ['allowed cheats for this run', 'set the cheats allowed for this run: Rare Candies, Money']);
  // all of them: the switch alone; a change while on: the list
  const e = mkDoc({ cheatSet: 'all' });
  R.logRulesChange(e, PAIR, 'p1', before, { ...before, cheats: true });
  assert.deepEqual(R.feedList(e).map((f) => f.text), ['allowed cheats for this run']);
  const on = { ...before, cheats: true };
  R.logRulesChange(e, PAIR, 'p1', on, { ...on, cheatSet: 'masterBall' });
  const f = R.feedList(e).find((x) => x.text !== 'allowed cheats for this run');
  assert.equal(f.text, 'set the cheats allowed for this run: Master Balls');
  assert.equal(oldRender(f.msg), 'set the cheats allowed for this run: Master Balls');
  // switched off: the old line only
  const g = mkDoc();
  R.logRulesChange(g, SOLO, 'p1', { ...on, cheatSet: 'money' }, { ...on, cheats: false, cheatSet: 'money' });
  assert.deepEqual(R.feedList(g).map((x) => x.text), ['Cheats turned off for this run']);
});

// ---- trophies -------------------------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 1, 12);
let seq = 0;
const docOf = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { v, t: ++seq, by: 'x' }]));
const run = (id) => ({ id, name: id, mode: 'nuzlocke', createdAt: new Date(T0).toISOString(), players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-firered', system: 'gba' }, randomizer: { enabled: true } });
const evalOf = (digests) => Object.fromEntries(T.evaluate(T.context(digests, [], {})).map((s) => [s.id, s]));

test('trophies: money and every item cheat spoil Honest Work; Candy Crush counts the candies picked; a Master Ball from the cheats catches no Route 1 Legend', () => {
  const won = (id, extra) => T.digestRun(run(id), docOf({ 'run:status': { state: 'won', at: T0 + 9000 }, ...extra }), 'p1');
  const money = won('cccc0001', { 'feed:m': { type: 'cheat', slot: 'p1', cheat: 'money', count: 1000, at: T0 } });
  assert.deepEqual([money.cheats, money.cheatUses], [0, 1]);
  assert.equal(evalOf([money]).noCheatWin.ok, false);
  const candy = won('cccc0002', { 'feed:a': { type: 'cheat', slot: 'p1', cheat: 'rareCandy', count: 10, at: T0 }, 'feed:b': { type: 'cheat', slot: 'p1', cheat: 'rareCandy', count: 1, at: T0 + 1 } });
  assert.equal(candy.cheats, 11);
  // a legendary at level 5 in a randomized run: before the first Master Ball from the cheats it counts, after it not
  const legend = (id, at, ball) => T.digestRun(run(id), docOf({
    'enc:r1:p1': { outcome: 'caught', species: 150, level: 5, metLevel: 5, at },
    ...(ball !== null ? { 'feed:m': { type: 'cheat', slot: 'p1', cheat: 'masterBall', count: 1, at: ball } } : {}),
  }), 'p1');
  assert.equal(evalOf([legend('cccc0003', T0 + 100, null)]).randoLegend.ok, true);
  assert.equal(evalOf([legend('cccc0004', T0 + 100, T0 + 500)]).randoLegend.ok, true, 'caught before the ball came');
  assert.equal(evalOf([legend('cccc0005', T0 + 900, T0 + 500)]).randoLegend.ok, false, 'caught after');
  assert.equal(legend('cccc0005', T0 + 900, T0 + 500).masterBallAt, T0 + 500);
  // other balls don't matter for it
  const ultra = T.digestRun(run('cccc0006'), docOf({ 'enc:r1:p1': { outcome: 'caught', species: 150, level: 5, metLevel: 5, at: T0 + 900 }, 'feed:u': { type: 'cheat', slot: 'p1', cheat: 'ultraBall', count: 99, at: T0 } }), 'p1');
  assert.equal(evalOf([ultra]).randoLegend.ok, true);
});

// ---- the menu's texts -----------------------------------------------------------------------------------------

test('the menu’s question, answer and failure – with a details line for a report', () => {
  assert.equal(M.cheatConfirmText({ id: 'masterBall', amount: 10 }), 'Add 10 × Master Ball to your bag?');
  assert.equal(M.cheatConfirmText({ id: 'revive', amount: 1 }), 'Add Revive to your bag?');
  assert.equal(M.cheatConfirmText({ id: 'money', amount: 10000 }), 'Add ₽10,000 to your money?');
  assert.equal(M.cheatConfirmText({ id: 'money', amount: 'max' }), 'Set your money to ₽999,999, the most the game holds?');
  assert.equal(M.cheatDoneText('ultraBall', { added: 99 }), '+99 × Ultra Ball in your bag');
  assert.equal(M.cheatDoneText('money', { added: 1000, after: 4000 }), '+₽1,000 – you have ₽4,000 now');
  const full = M.cheatFailText('pokeBall', { error: 'full' }, { gen: 2, where: 'gold_us · gb:gold_us · 10' });
  assert.equal(full.title, 'No Poké Ball added');
  assert.equal(full.text, 'The bag pocket is full – make room and try again.\nDetails: full · gold_us · gb:gold_us · 10');
  const ctrMissing = M.cheatFailText('fullRestore', { error: 'notFound', why: 'missing' }, { gen: 7, where: 'usum' });
  assert.match(ctrMissing.text, /not where this game keeps it[^\n]*\nDetails: notFound · missing · usum$/);
  assert.match(M.cheatFailText('money', { error: 'notFound' }).text, /^Your money wasn’t found/);
  assert.equal(M.cheatFailText('money', { error: 'max', before: 999999 }).text.split('\n')[0], 'You already have the most money the game holds (₽999,999).');
  assert.equal(M.cheatFailText('revive', { error: 'max', before: 99 }).text.split('\n')[0], 'Your bag already holds as many of this item as the game allows (99 × Revive).');
  assert.match(M.cheatFailText('revive', { error: 'write', why: 'range' }).text, /^The game’s memory couldn’t be changed\.\nDetails: write · range$/);
});
