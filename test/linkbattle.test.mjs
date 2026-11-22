// Link battle results and wagers (shared/linkbattle.mjs, web/lib/wager.mjs, web/lib/wagerpay.mjs): the money of every
// generation's games (BCD, big-endian, XOR with the save key, the DS trainer block), the outcome as each game keeps it
// (the readings below are the ones the recorded link battles of scripts/link-e2e.mjs showed), the result every player
// must agree on, the payments and that a payment goes into a save exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as L from '../shared/linkbattle.mjs';

// web/lib/*.mjs import browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve: (spec, ctx, next) => next(/^\/(shared|vendor)\//.test(spec) ? new URL(`.${spec}`, ROOT).href : spec, ctx),
});
const W = await import('../web/lib/wager.mjs');
const { WagerPay } = await import('../web/lib/wagerpay.mjs');

/** A console's bus as a sparse map: read(addr, len) / write(addr, bytes) – what the fast player's mirror offers. */
function bus(init = {}) {
  const m = new Map();
  const put = (addr, bytes) => bytes.forEach((b, i) => m.set(addr + i, b & 0xff));
  for (const [a, b] of Object.entries(init)) put(Number(a), b);
  return { m, put, read: (addr, len) => Uint8Array.from({ length: len }, (_, i) => m.get(addr + i) ?? 0), write: (addr, bytes) => (put(addr, [...bytes]), true) };
}
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

/** A Platinum game records block (0x1BC bytes) with these link battle wins/losses, encrypted as the game does. */
function records4(wins, losses, modifier = 0x1234) {
  const b = new Uint8Array(0x1bc);
  b.set(le32(485), 0); // (steps: not encrypted)
  b.set(le32(63), 4);
  b.set(le32(wins), 21 * 4);
  b.set(le32(losses), 22 * 4);
  let sum = 0;
  for (let o = 4; o < 0x1b8; o++) sum += b[o];
  sum &= 0xffff;
  b[0x1b8] = sum & 0xff; b[0x1b9] = sum >> 8; b[0x1ba] = modifier & 0xff; b[0x1bb] = modifier >> 8;
  let x = (sum + (modifier << 16)) >>> 0;
  for (let o = 4; o < 0x1b8; o += 2) {
    x = (Math.imul(x, 0x41c64e6d) + 0x6073) >>> 0;
    const v = (b[o] | (b[o + 1] << 8)) ^ (x >>> 16);
    b[o] = v & 0xff; b[o + 1] = v >> 8;
  }
  return b;
}

/** A HeartGold/SoulSilver game stats block (0x1C0 bytes): wins/losses/draws (22–24), encrypted from +8 as the game does. */
function records4hgss(wins, losses, draws, modifier = 0x2468) {
  const b = new Uint8Array(0x1c0);
  b.set(le32(1200), 0); b.set(le32(30), 4); // (steps walked and biked: not encrypted)
  b.set(le32(9), 8);
  b.set(le32(wins), 22 * 4); b.set(le32(losses), 23 * 4); b.set(le32(draws), 24 * 4);
  let sum = 0;
  for (let o = 8; o < 0x1bc; o++) sum += b[o];
  sum &= 0xffff;
  b[0x1bc] = sum & 0xff; b[0x1bd] = sum >> 8; b[0x1be] = modifier & 0xff; b[0x1bf] = modifier >> 8;
  let x = (sum + (modifier << 16)) >>> 0;
  for (let o = 8; o < 0x1bc; o += 2) {
    x = (Math.imul(x, 0x41c64e6d) + 0x6073) >>> 0;
    const v = (b[o] | (b[o + 1] << 8)) ^ (x >>> 16);
    b[o] = v & 0xff; b[o + 1] = v >> 8;
  }
  return b;
}

test('money: Gen 1 BCD, Gen 2 big-endian, Gen 3 XOR with the save key – both ways', () => {
  assert.equal(L.bcdDecode([0x00, 0x31, 0x75]), 3175); // (Red's ₽3,175 in the recorded battle)
  assert.deepEqual(L.bcdEncode(3175), [0x00, 0x31, 0x75]);
  assert.deepEqual(L.bcdEncode(999999), [0x99, 0x99, 0x99]);
  assert.deepEqual(L.bcdEncode(1234567), [0x99, 0x99, 0x99], 'capped');
  assert.equal(L.bcdDecode([0x0a, 0, 0]), null, 'not BCD');
  assert.equal(L.be24Decode([0x00, 0x0b, 0xb8]), 3000); // (Crystal's ₽3,000)
  assert.deepEqual(L.be24Encode(5000), [0x00, 0x13, 0x88]);
  // Emerald as read live in the recorded battle: money 7edf8138 with the key c6d48138 is ₽3,000
  const key = 0x3881d4c6;
  assert.equal(L.xorDecode(Uint8Array.from([0x7e, 0xdf, 0x81, 0x38]), key), 3000);
  assert.deepEqual(L.xorEncode(3000, key), [0x7e, 0xdf, 0x81, 0x38]);
  assert.equal(L.xorDecode(Uint8Array.from(L.xorEncode(5000, 0)), 0), 5000, 'Ruby/Sapphire: no key');
  assert.equal(L.moneyText(2000, 'en'), '₽2,000');
  assert.equal(L.moneyText(2000, 'de'), '₽2.000');
});

test('money: found, changed and read back in every generation; refused where the memory doesn\'t look right', async () => {
  // Gen 1 Red
  const red = bus({ 0xd347: [0x00, 0x31, 0x75] });
  assert.equal(await L.readMoney('redblue', red.read), 3175);
  assert.deepEqual(await L.addMoney('redblue', red.read, red.write, 2000), { ok: true, before: 3175, after: 5175 });
  assert.deepEqual([...red.read(0xd347, 3)], [0x00, 0x51, 0x75]);
  assert.equal((await L.addMoney('redblue', red.read, red.write, -9000)).after, 0, 'never below 0');
  // Gen 2 Crystal
  const cr = bus({ 0xd84e: [0x00, 0x0b, 0xb8] });
  assert.equal((await L.addMoney('crystal', cr.read, cr.write, -1000)).after, 2000);
  assert.deepEqual([...cr.read(0xd84e, 3)], [0x00, 0x07, 0xd0]);
  // Gen 3 Emerald: through the save block pointers, XORed with SaveBlock2's key
  const sb1 = 0x02025a00, sb2 = 0x02024a00, key = 0x3881d4c6;
  const em = bus({ 0x03005d8c: le32(sb1), 0x03005d90: le32(sb2), [sb2 + 0xac]: le32(key), [sb1 + 0x490]: L.xorEncode(3000, key) });
  assert.equal(await L.readMoney('emerald', em.read), 3000);
  assert.equal((await L.addMoney('emerald', em.read, em.write, 2000)).after, 5000);
  assert.equal(L.xorDecode(em.read(sb1 + 0x490, 4), key), 5000);
  const lost = bus({ 0x03005d8c: le32(0x08000000), 0x03005d90: le32(sb2) });
  assert.deepEqual(await L.addMoney('emerald', lost.read, lost.write, 100), { error: 'notFound' }, 'a pointer outside EWRAM: nothing written');
  // Ruby/Sapphire: a fixed SaveBlock1, plain
  const rs = bus({ [0x02025734 + 0x490]: le32(3000) });
  assert.equal((await L.addMoney('rs', rs.read, rs.write, 500)).after, 3500);
  // Gen 4 Platinum: the save data's trainer block, only when its game records decode (the pointer is right)
  const save = 0x0227e148;
  const pt = bus({ 0x02101d40: le32(save), [save + 0x90]: le32(3500), [save + 0x61c4]: records4(0, 0) });
  assert.equal(await L.readMoney('platinum', pt.read), null, 'no trainer yet: the save isn\'t loaded');
  pt.put(save + 0x7c, [0x2b, 0x01]);
  assert.equal(await L.readMoney('platinum', pt.read), 3500);
  assert.equal((await L.addMoney('platinum', pt.read, pt.write, -2000)).after, 1500);
  const ptBad = bus({ 0x02101d40: le32(save), [save + 0x90]: le32(3500), [save + 0x7c]: [0x2b, 0x01] });
  assert.equal(await L.readMoney('platinum', ptBad.read), null);
  // Diamond/Pearl (general block +0x214, money +0x78) and HeartGold/SoulSilver (+0x10)
  const dp = bus({ 0x02106fc0: le32(save), [save + 0x28c]: le32(3000), [save + 0x278]: [0x2b, 0x01] });
  assert.equal((await L.addMoney('dp', dp.read, dp.write, 2000)).after, 5000);
  const hg = bus({ 0x02111880: le32(save), [save + 0x88]: le32(3000), [save + 0x74]: [0x2b, 0x01], [save + 0x4b4c]: records4hgss(0, 0, 0) });
  assert.equal((await L.addMoney('hgss', hg.read, hg.write, -2000)).after, 1000);
  // Gen 5: the save data in RAM in the battery save's layout – Black's at 0x0221BBAC (fixed), Black 2's behind the main
  // pointer (+0x920); the money is the misc block's first word, read only with a named trainer
  const bk = bus({ [0x0221bbac + 0x21200]: le32(4000), [0x0221bbac + 0x19404]: [0x41, 0x00] });
  assert.equal(await L.readMoney('black', bk.read), 4000);
  assert.equal((await L.addMoney('black', bk.read, bk.write, -1500)).after, 2500);
  const b2 = bus({ 0x02000024: le32(0x0221e1a0), [0x0221e1a0 + 0x920 + 0x21100]: le32(3000) });
  assert.equal(await L.readMoney('black2', b2.read), null, 'no trainer yet (the title screen)');
  b2.put(0x0221e1a0 + 0x920 + 0x19404, [0x42, 0x00]);
  assert.equal(await L.readMoney('black2', b2.read), 3000);
  // a write that doesn't stick is not a payment
  const stuck = bus({ 0xd347: [0x00, 0x31, 0x75] });
  assert.deepEqual(await L.addMoney('redblue', stuck.read, () => true, 100), { error: 'write' });
});

test('games: the seat\'s game from its cartridge header (and the live tracker\'s entry); unknown languages and hacks: none', () => {
  const gba = (code) => { const b = new Uint8Array(0x20); b.set([...'POKEMON EMER'].map((c) => c.charCodeAt(0)), 0); b.set([...code].map((c) => c.charCodeAt(0)), 0x0c); return b; };
  assert.equal(L.gameOf('gba', gba('BPEE')), 'emerald');
  assert.equal(L.gameOf('gba', gba('AXPE')), 'rs');
  assert.equal(L.gameOf('gba', gba('AXVD')), 'rs');
  assert.equal(L.gameOf('gba', gba('BPRD')), 'frlgEu');
  assert.equal(L.gameOf('gba', gba('BPED')), null, 'German Emerald: tracked live (its RAM is the English game\'s), but its link battles were never recorded – no wagers yet');
  const gb = (title, maker = '') => { const b = new Uint8Array(0x1c); b.set([...title].map((c) => c.charCodeAt(0)), 0); b.set([...maker].map((c) => c.charCodeAt(0)), 0x0b); return b; };
  assert.equal(L.gameOf('gb', gb('POKEMON RED')), 'redblue');
  assert.equal(L.gameOf('gbc', gb('PM_CRYSTAL', 'BYTE')), 'crystal');
  assert.equal(L.gameOf('gbc', gb('POKEMON_SLV', 'AAXE')), 'goldsilver');
  assert.equal(L.gameOf('gbc', gb('POKEMON_SLV', 'AAXD')), null);
  const nds = new Uint8Array(0x10); nds.set([...'CPUE'].map((c) => c.charCodeAt(0)), 0x0c);
  assert.equal(L.gameOf('nds', nds), 'platinum');
  for (const [code, game] of [['ADAE', 'dp'], ['APAE', 'dp'], ['IPKE', 'hgss'], ['IPGE', 'hgss'], ['CPUD', null], ['IPKD', null]]) {
    nds.set([...code].map((c) => c.charCodeAt(0)), 0x0c);
    assert.equal(L.gameOf('nds', nds), game, code);
  }
  assert.equal(L.gameOfEntry({ id: 'soulsilver_us' }), 'hgss');
  assert.equal(L.gameOfEntry({ id: 'pearl_us' }), 'dp');
  for (const [code, game] of [['IRBO', 'black'], ['IRAO', 'white'], ['IREO', 'black2'], ['IRDO', null], ['IRBD', null]]) {
    nds.set([...code].map((c) => c.charCodeAt(0)), 0x0c);
    assert.equal(L.gameOf('nds', nds), game, code);
  }
  // (White 2: no link battle of it recorded yet – no results and no wagers until one is; its money table stays for the
  // cheats, checked live in a running White 2)
  assert.equal(L.gameOfEntry({ id: 'white2_us' }), 'white2');
  assert.equal(L.gameOfEntry({ id: 'white_us' }), 'white');
  assert.ok(!L.wagerGame('pokemon-white-2') && L.wagerGame('pokemon-white') && L.GAMES.white2.money);
  assert.equal(L.gameOfEntry({ id: 'emerald_us' }), 'emerald');
  assert.equal(L.gameOfEntry({ id: 'crystal_us', wram: { delta: 11 } }), null, 'a hack whose RAM moved');
  assert.equal(L.gameOfEntry({ id: 'heartgold_us~IPKD', scanOnly: true }), null);
  assert.ok(L.wagerGame('pokemon-emerald') && L.wagerGame('pokemon-firered-de') && !L.wagerGame('pokemon-emerald-de') && L.wagerGame('pokemon-heartgold') && L.wagerGame('pokemon-diamond') && !L.wagerGame('pokemon-platinum-de') && L.wagerGame('pokemon-black-2'));
  assert.deepEqual(L.battleFormats('gba', 2), ['single', 'double']);
  assert.deepEqual(L.battleFormats('gb', 2), ['single']);
  assert.deepEqual(L.battleFormats('gba', 4), ['multi']);
  assert.deepEqual(L.battleFormats('nds', 4), []);
});

test('outcome, Gen 1: wBattleResult once the link battle is over (the recorded Red battle: seat 1 wins)', () => {
  // readings as the recorded battle showed them: before, in the Colosseum battle (wIsInBattle 2, LINK_STATE_BATTLING),
  // the battle's end screen, back in the Colosseum
  const seq = [[0, 0, 0], [0, 0, 4], [0, 2, 4], [1, 2, 4], [1, 0, 4], [1, 0, 1]]; // [result, inBattle, link]
  const w0 = new L.BattleWatch('redblue');
  const w1 = new L.BattleWatch('redblue');
  const s1 = [[0, 0, 0], [0, 0, 4], [0, 2, 4], [0, 2, 4], [0, 0, 4], [0, 0, 1]];
  seq.forEach(([result, inBattle, link]) => w0.step({ result, inBattle, link }));
  s1.forEach(([result, inBattle, link]) => w1.step({ result, inBattle, link }));
  assert.deepEqual(w0.counts, { w: 0, l: 1, d: 0 });
  assert.deepEqual(w1.counts, { w: 1, l: 0, d: 0 });
  // a wild battle (no link) is never counted
  const wild = new L.BattleWatch('redblue');
  [[0, 1, 0], [0, 0, 0]].forEach(([result, inBattle, link]) => wild.step({ result, inBattle, link }));
  assert.deepEqual(wild.counts, { w: 0, l: 0, d: 0 });
  assert.deepEqual(new L.BattleWatch('yellow').ranges().map((r) => r.addr), [0xcf0b, 0xd056, 0xd12a]);
});

test('outcome, Gen 3: gBattleOutcome of a link battle – single (Emerald wins) and multi (2 vs 2), a forfeit, stale outcomes', () => {
  const run = (game, seq) => { const w = new L.BattleWatch(game); seq.forEach(([outcome, flags]) => w.step({ outcome, flags })); return w; };
  // the recorded single battle: Emerald (seat 0) 1, Sapphire (seat 1) 2; the outcome of an earlier wild battle before
  const e = run('emerald', [[1, 0x04], [1, 0x00], [0, 0x0a], [0, 0x2e], [1, 0x2e], [1, 0x0e]]);
  const s = run('rs', [[0, 0x00], [0, 0x0a], [0, 0x2a], [2, 0x2a], [2, 0x0a]]);
  assert.deepEqual([e.counts, s.counts], [{ w: 1, l: 0, d: 0 }, { w: 0, l: 1, d: 0 }]);
  assert.equal(e.multi, false);
  // the recorded multi battle: flags 0x4b/0x6f (MULTI), seats 0+1 lose, 2+3 win
  const m = [[2, 0x6f], [2, 0x6b], [1, 0x6b], [1, 0x6b]].map(([o, f]) => run('emerald', [[0, 0x4b], [0, f], [o, f], [o, f & ~0x20]]));
  assert.deepEqual(m.map((w) => w.counts.w), [0, 0, 1, 1]);
  assert.ok(m.every((w) => w.multi));
  // a forfeit (bit 7): the outcome stands; a draw
  assert.deepEqual(run('frlg', [[0, 0x0a], [0x82, 0x0a]]).counts, { w: 0, l: 1, d: 0 });
  assert.deepEqual(run('frlg', [[0, 0x0a], [3, 0x0a]]).counts, { w: 0, l: 0, d: 1 });
  // two battles in one session
  assert.deepEqual(run('emerald', [[0, 0x2e], [1, 0x2e], [0, 0x2e], [2, 0x2e]]).counts, { w: 1, l: 1, d: 0 });
  // feed(): the bytes as read
  const w = new L.BattleWatch('emerald');
  w.feed([Uint8Array.of(0), Uint8Array.from(le32(0x2e))]);
  assert.equal(w.feed([Uint8Array.of(1), Uint8Array.from(le32(0x2e))]), 'win');
  assert.equal(w.feed([null, null]), null, 'a failed read changes nothing');
});

test('outcome, Gen 2 and 4: the games\' own counts before and after (Crystal loses to Silver; Platinum seat 0 wins)', async () => {
  // Crystal's sLinkBattleStats after the recorded battle (save offset 0x3260): 0 wins, 1 loss, 0 draws; Silver's (0x31BA)
  const crystal = new Uint8Array(0x8000); crystal.set([0, 0, 0, 1, 0, 0], 0x3260);
  const silver = new Uint8Array(0x8000); silver.set([0, 1, 0, 0, 0, 0], 0x31ba);
  const before = new Uint8Array(0x8000);
  assert.deepEqual(L.countsBetween(L.sramTotals('crystal', before), L.sramTotals('crystal', crystal)), { w: 0, l: 1, d: 0 });
  assert.deepEqual(L.countsBetween(L.sramTotals('goldsilver', before), L.sramTotals('goldsilver', silver)), { w: 1, l: 0, d: 0 });
  assert.equal(L.sramTotals('crystal', new Uint8Array(16)), null);
  // Platinum's encrypted game records (decoded as the game does; a broken block isn't read)
  assert.deepEqual(L.decodeRecords4(records4(3, 1)), { wins: 3, losses: 1 });
  const broken = records4(3, 1); broken[0x60] ^= 1;
  assert.equal(L.decodeRecords4(broken), null);
  const save = 0x0227e148;
  const pt = bus({ 0x02101d40: le32(save), [save + 0x61c4]: records4(0, 0) });
  assert.equal(await L.totals('platinum', { read: pt.read }), null, 'no trainer yet: the save isn\'t loaded');
  pt.put(save + 0x7c, [0x2b, 0x01]);
  const a = await L.totals('platinum', { read: pt.read });
  pt.put(save + 0x61c4, records4(1, 0, 0x4321)); // (the game encrypts again with a new seed)
  assert.deepEqual(L.countsBetween(a, await L.totals('platinum', { read: pt.read })), { w: 1, l: 0, d: 0 });
  assert.equal(L.countsBetween({ w: 5, l: 0, d: 0 }, { w: 1, l: 0, d: 0 }), null, 'fewer than before: a reset, not a result');
});

test('outcome, Diamond/Pearl and HeartGold/SoulSilver: their records, plain and encrypted, before and after', async () => {
  // HG/SS: wins, losses and draws (22–24), encrypted from +8 with the sum at +0x1BC
  assert.deepEqual(L.decodeRecords(records4hgss(2, 1, 1), 'hgss'), { wins: 2, losses: 1, draws: 1 });
  const bad = records4hgss(2, 1, 1); bad[0x40] ^= 4;
  assert.equal(L.decodeRecords(bad, 'hgss'), null, 'its byte sum doesn\'t match');
  assert.equal(L.decodeRecords(records4(3, 1), 'hgss'), null, 'a Platinum block isn\'t HG/SS\'s');
  // D/P: plain u32 records (21, 22)
  const dp = new Uint8Array(0xb0); dp.set(le32(4), 21 * 4); dp.set(le32(2), 22 * 4);
  assert.deepEqual(L.decodeRecords(dp, 'dp'), { wins: 4, losses: 2, draws: 0 });
  const junk = new Uint8Array(0xb0).fill(0xff);
  assert.equal(L.decodeRecords(junk, 'dp'), null, 'counts beyond the games\' cap: not a records block');
  // through the save data pointer, with the trainer named (the save is loaded)
  for (const [game, ptr, off, name, block, block2] of [
    ['hgss', 0x02111880, 0x4b4c, 0x74, records4hgss(0, 0, 0), records4hgss(0, 1, 0, 0x1357)],
    ['dp', 0x02106fc0, 0x611c, 0x278, new Uint8Array(0xb0), (() => { const b = new Uint8Array(0xb0); b.set(le32(1), 21 * 4); return b; })()],
  ]) {
    const save = 0x0226d300;
    const g = bus({ [ptr]: le32(save), [save + off]: block });
    assert.equal(await L.totals(game, { read: g.read }), null, `${game}: no trainer yet`);
    g.put(save + name, [0x2b, 0x01]);
    const a = await L.totals(game, { read: g.read });
    g.put(save + off, block2);
    assert.deepEqual(L.countsBetween(a, await L.totals(game, { read: g.read })), game === 'hgss' ? { w: 0, l: 1, d: 0 } : { w: 1, l: 0, d: 0 });
  }
});

/** A Gen 5 trainer card records block (0x1E0): u32 records from +4, encrypted with the seed in the last word. */
function records5(rec, seed = 0x13579bdf) {
  const b = new Uint8Array(0x1e0);
  for (const [id, v] of Object.entries(rec)) b.set(le32(v), 4 + Number(id) * 4);
  b.set(le32(seed), 0x1dc);
  let x = seed;
  for (let o = 4; o < 0x1dc; o += 2) {
    x = (Math.imul(x, 0x41c64e6d) + 0x6073) >>> 0;
    const v = (b[o] | (b[o + 1] << 8)) ^ (x >>> 16);
    b[o] = v & 0xff; b[o + 1] = v >> 8;
  }
  return b;
}

test('outcome, Gen 5: the trainer card records (12 battles, 13 wins, 14 losses) – as Black\'s recorded Union Room battle left them', async () => {
  // the winner's and the loser's records before and after the battle, as read from the link host
  const before = { 0: 4, 3: 7, 4: 5, 5: 2, 6: 1, 10: 1, 24: 6, 26: 153, 29: 1 };
  const won = { ...before, 3: 8, 12: 1, 13: 1, 24: 7 };
  const lost = { ...before, 0: 2, 3: 8, 12: 1, 14: 1 };
  assert.deepEqual(L.decodeRecords(records5(won), 'gen5'), { wins: 1, losses: 0, draws: 0 });
  assert.deepEqual(L.decodeRecords(records5(lost, 0x2468ace0), 'gen5'), { wins: 0, losses: 1, draws: 0 });
  // Black: the save data at 0x0221BBAC; Black 2: behind the main pointer
  const base = 0x0221bbac;
  const bk = bus({ [base + 0x1da00]: records5(before), [base + 0x19404]: [0x41, 0x00] });
  const a = await L.totals('black', { read: bk.read });
  bk.put(base + 0x1da00, records5(won, 0x0badcafe)); // (the game encrypts again with another seed)
  assert.deepEqual(L.countsBetween(a, await L.totals('black', { read: bk.read })), { w: 1, l: 0, d: 0 });
  const b2 = bus({ 0x02000024: le32(0x0221e1a0), [0x0221e1a0 + 0x920 + 0x1da00]: records5(before) });
  assert.equal(await L.totals('black2', { read: b2.read }), null, 'no trainer yet');
  b2.put(0x0221e1a0 + 0x920 + 0x19404, [0x42, 0x00]);
  assert.deepEqual(await L.totals('black2', { read: b2.read }), { w: 0, l: 0, d: 0 });
  // the overworld: anything but the battle flag's battle values
  assert.equal(await L.fieldIdle('black', bus({ 0x021d0798: [0x00, 0x28], [base + 0x19404]: [0x41, 0x00] }).read), true);
  assert.equal(await L.fieldIdle('black', bus({ 0x021d0798: [0x00, 0x21], [base + 0x19404]: [0x41, 0x00] }).read), false);
});

test('result: two seats, a multi battle, several battles, a draw – and counts that don\'t fit are no result', () => {
  assert.deepEqual(L.summarize(['p1', 'p2'], { p1: { w: 1, l: 0, d: 0 }, p2: { w: 0, l: 1, d: 0 } }),
    { valid: true, battles: 1, winners: ['p1'], losers: ['p2'], draw: false, score: [1, 0] });
  assert.deepEqual(L.summarize(['p1', 'p2'], { p1: { w: 1, l: 2, d: 0 }, p2: { w: 2, l: 1, d: 0 } }).winners, ['p2']);
  assert.equal(L.summarize(['p1', 'p2'], { p1: { w: 1, l: 1, d: 0 }, p2: { w: 1, l: 1, d: 0 } }).draw, true);
  assert.equal(L.summarize(['p1', 'p2'], { p1: { w: 1, l: 0, d: 0 }, p2: { w: 1, l: 0, d: 0 } }).valid, false, 'both won: a misread');
  assert.equal(L.summarize(['p1', 'p2'], { p1: { w: 0, l: 0, d: 0 }, p2: { w: 0, l: 0, d: 0 } }).battles, 0);
  const multi = { p1: { w: 0, l: 1, d: 0 }, p2: { w: 0, l: 1, d: 0 }, p3: { w: 1, l: 0, d: 0 }, p4: { w: 1, l: 0, d: 0 } };
  const m = L.summarize(['p1', 'p2', 'p3', 'p4'], multi, { multi: true });
  assert.deepEqual([m.winners, m.losers, m.multi], [['p3', 'p4'], ['p1', 'p2'], true]);
  assert.equal(L.summarize(['p1', 'p2', 'p3', 'p4'], multi).valid, false, 'four seats without a multi battle: who fought whom isn\'t known');
  assert.equal(L.summarize(['p1', 'p2', 'p3', 'p4'], { ...multi, p4: { w: 0, l: 1, d: 0 } }, { multi: true }).valid, false);
  // the hash: the same for the same result, another for anything else
  const r = { sid: 'abc123', seats: ['p1', 'p2'], per: { p1: { w: 1, l: 0, d: 0 }, p2: { w: 0, l: 1, d: 0 } }, wager: 2000 };
  assert.equal(L.resultHash(r), L.resultHash({ ...r, per: { p2: { d: 0, l: 1, w: 0 }, p1: { w: 1, d: 0, l: 0 } } }));
  assert.notEqual(L.resultHash(r), L.resultHash({ ...r, wager: 1000 }));
  assert.notEqual(L.resultHash(r), L.resultHash({ ...r, sid: 'abc124' }));
  // payments: the loser to the winner; per team in a multi battle; nothing for a draw or no wager
  assert.deepEqual(L.payments(L.summarize(r.seats, r.per), 2000), [{ from: 'p2', to: 'p1', amount: 2000 }]);
  const pm = L.payments(m, 1000);
  assert.deepEqual(pm, [{ from: 'p1', to: 'p3', amount: 1000 }, { from: 'p2', to: 'p4', amount: 1000 }]);
  assert.deepEqual([L.deltaOf(pm, 'p1'), L.deltaOf(pm, 'p4')], [-1000, 1000]);
  assert.deepEqual(L.payments({ valid: true, draw: true, winners: [], losers: [] }, 1000), []);
  assert.deepEqual(L.payments(L.summarize(r.seats, r.per), 0), []);
});

/** A run document as web/lib/doc.mjs offers it (get / set / scan). */
function memDoc() {
  const m = new Map();
  return {
    m, get: (k, d = undefined) => (m.has(k) ? m.get(k) : d), set: (k, v) => (v === null ? m.delete(k) : m.set(k, structuredClone(v))),
    scan: (p) => Object.fromEntries([...m].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v])), // (as RunDoc: without the prefix)
  };
}
const won = { per: { p1: { w: 1, l: 0, d: 0 }, p2: { w: 0, l: 1, d: 0 } }, multi: false };
const entry = (o) => W.resultEntry({ sid: 'abc123', seats: ['p1', 'p2'], host: 'p1', kind: 'battle', found: won, wager: 2000, money: { p1: 3000, p2: 5000 }, ...o });
/** This computer's own results (web/lib/wager.mjs keepOwnResult) – a browser storage of its own per test. */
function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
/** Both sides' entries as their souldew writes them – `own` (for WagerPay): what this computer read itself. */
const ownOf = (e = entry({})) => (sid) => (sid === e.sid ? e : null);

test('wager: only when every seat\'s souldew knows wagers (capability), lowered to every accept, the rule\'s cap and the money', () => {
  const base = { offer: 5000, seats: ['p1', 'p2'], host: 'p1', accepts: { p2: 5000 }, caps: { p1: true, p2: true } };
  assert.equal(W.agreedWager(base), 5000);
  assert.equal(W.agreedWager({ ...base, caps: { p1: true } }), 0, 'a partner on an older 3.0 build: no wager');
  assert.equal(W.agreedWager({ ...base, accepts: { p2: 1200 } }), 1200, 'the partner has less');
  assert.equal(W.agreedWager({ ...base, cap: 1000 }), 1000, 'the run\'s limit');
  assert.equal(W.agreedWager({ ...base, offer: 0 }), 0);
  // the stake: never more than any seat had when the session started
  assert.equal(entry({}).wager, 2000);
  assert.equal(entry({ money: { p1: 1500, p2: 5000 } }).wager, 1500);
  assert.equal(entry({ money: { p1: null, p2: 5000 } }).wager, 0, 'a seat\'s money unknown: no wager');
  assert.deepEqual(W.wagerRules({}), { on: true, cap: 0 });
  assert.deepEqual(W.wagerRules({ linkWagers: 'off' }).on, false);
  assert.deepEqual(W.wagerRules({ linkBattles: 'off' }).on, false, 'no link battles, no wagers');
  assert.deepEqual(W.wagerRules({ linkWagerCap: 5000 }).cap, 5000);
});

test('wager: a result counts once every seat read the same; a desync, a dropout or different results void it', () => {
  const doc = memDoc();
  doc.set('lb:abc123:p1', entry({}));
  assert.equal(W.outcomeOf(W.sessionsIn(doc).abc123).state, 'pending', 'only one side yet');
  doc.set('lb:abc123:p2', entry({}));
  const o = W.outcomeOf(W.sessionsIn(doc).abc123);
  assert.equal(o.state, 'agreed');
  assert.deepEqual(o.pays, [{ from: 'p2', to: 'p1', amount: 2000 }]);
  assert.deepEqual(W.headToHead(doc, 'p1', 'p2'), { a: 1, b: 0, draws: 0 });
  assert.deepEqual(W.headToHead(doc, 'p2', 'p1'), { a: 0, b: 1, draws: 0 });
  // the other computer read something else
  doc.set('lb:abc123:p2', entry({ found: { per: { p1: { w: 0, l: 1, d: 0 }, p2: { w: 1, l: 0, d: 0 } } } }));
  assert.deepEqual([W.outcomeOf(W.sessionsIn(doc).abc123).state, W.outcomeOf(W.sessionsIn(doc).abc123).why], ['void', 'differs']);
  // out of step: void, whatever the other side read
  doc.set('lb:abc123:p2', entry({ reason: 'desync' }));
  assert.equal(W.outcomeOf(W.sessionsIn(doc).abc123).state, 'void');
  assert.deepEqual(W.owedTo(doc, 'p2', { boot: 'b1', own: ownOf(entry({ reason: 'desync' })) }), [], 'nothing to pay');
  assert.deepEqual(W.owedTo(doc, 'p1', { boot: 'b1', own: ownOf() }), [], 'nor to be paid');
  assert.deepEqual(W.headToHead(doc, 'p1', 'p2'), { a: 0, b: 0, draws: 0 }, 'and nothing on the record');
  doc.set('lb:abc123:p2', entry({ reason: 'rejoin' }));
  assert.equal(W.outcomeOf(W.sessionsIn(doc).abc123).why, 'rejoin');
});

test('wager: money only follows this computer\'s own result – never entries a partner wrote, under any slot', async () => {
  const store = memStore();
  const doc = Object.assign(memDoc(), { runId: 'run1' });
  // p1's souldew was changed: it writes a matching pair – p2 lost ₽999,999 – under its own slot and under p2's
  const forged = (o) => W.resultEntry({ sid: 'f00d01', seats: ['p1', 'p2'], host: 'p1', kind: 'battle', found: won, wager: 999999, money: { p1: 999999, p2: 999999 }, ...o });
  doc.set('lb:f00d01:p1', forged({}));
  doc.set('lb:f00d01:p2', forged({}));
  assert.equal(W.outcomeOf(W.sessionsIn(doc).f00d01).state, 'agreed', '(the entries alone agree)');
  assert.deepEqual(W.owedTo(doc, 'p2', { boot: 'b1', own: (sid) => W.ownResultOf('run1', sid, store) }), [], 'p2\'s computer never read that battle: nothing');
  const tim = bus({ 0xd347: [0x00, 0x50, 0x00], 0xd057: [0], 0xd12b: [0], 0xd163: [2] }); // Red, ₽5,000, in the overworld
  const pay = new WagerPay({ doc, me: 'p2', own: (sid) => W.ownResultOf('run1', sid, store) });
  await pay.tick({ game: 'redblue', read: tim.read, write: tim.write });
  assert.equal(L.bcdDecode(tim.read(0xd347, 3)), 5000, 'not a ₽ taken');
  assert.equal(doc.get('lbpay:f00d01:p2'), undefined);
  // a real session: p2 read a draw-free win for p2 (₽500); p1 writes a pair that says p2 lost ₽999,999 instead
  const real = (o) => W.resultEntry({ sid: 'beef02', seats: ['p1', 'p2'], host: 'p1', kind: 'battle', found: { per: { p1: { w: 0, l: 1, d: 0 }, p2: { w: 1, l: 0, d: 0 } } }, wager: 500, money: { p1: 3000, p2: 5000 }, ...o });
  W.recordResult(doc, 'p2', real({}), store);
  assert.deepEqual(doc.get('lb:beef02:p2').h, real({}).h, 'into the run for the partners, too');
  doc.set('lb:beef02:p1', forged({ sid: 'beef02' }));
  doc.set('lb:beef02:p2', forged({ sid: 'beef02' })); // (over p2's own entry in the run)
  const trusted = (sid) => W.ownResultOf('run1', sid, store);
  assert.deepEqual(W.owedTo(doc, 'p2', { boot: 'b1', own: trusted }), [], 'the partner\'s word against this computer\'s: void, nobody pays');
  // honest: the partner's entry arrives late (a reconnect) – then it counts, with what this computer read
  doc.set('lb:beef02:p1', null);
  doc.set('lb:beef02:p2', real({}));
  assert.deepEqual(W.owedTo(doc, 'p2', { boot: 'b1', own: trusted }), [], 'still waiting for p1');
  doc.set('lb:beef02:p1', real({}));
  assert.deepEqual(W.owedTo(doc, 'p2', { boot: 'b1', own: trusted }).map((o) => [o.sid, o.delta]), [['beef02', 500]]);
  // the same matching entries, but p2's own result kept says something else (its computer read p2 losing): void
  W.keepOwnResult('run1', real({ found: won }), store);
  assert.deepEqual(W.owedTo(doc, 'p2', { boot: 'b1', own: trusted }), []);
  // kept apart per run, survives a reload (it is the browser storage), and only the newest sessions
  assert.equal(W.ownResultOf('run2', 'beef02', store), null);
  for (let i = 0; i < 205; i++) W.keepOwnResult('run3', { sid: `a${String(i).padStart(5, '0')}`, at: i }, store);
  assert.equal(W.ownResultOf('run3', 'a00000', store), null, 'the oldest dropped');
  assert.equal(W.ownResultOf('run3', 'a00204', store).at, 204);
});

test('wager: the money goes into each game once – again only into a game started anew before it saved', async () => {
  const doc = memDoc();
  doc.set('lb:abc123:p1', entry({}));
  doc.set('lb:abc123:p2', entry({}));
  const tim = bus({ 0xd347: [0x00, 0x50, 0x00], 0xd057: [0], 0xd12b: [0], 0xd163: [2] }); // Red, ₽5,000, two Pokémon, in the overworld
  const paid = [];
  const pay = new WagerPay({ doc, me: 'p2', onPaid: (o) => paid.push(o), own: ownOf() });
  const tick = (o = {}) => pay.tick({ game: 'redblue', read: tim.read, write: tim.write, ...o });
  await tick({ busyGame: true });
  assert.equal(L.bcdDecode(tim.read(0xd347, 3)), 5000, 'not during a battle or a link');
  tim.put(0xd057, [2]);
  await tick();
  assert.equal(L.bcdDecode(tim.read(0xd347, 3)), 5000, 'not while the game says it is in a battle');
  tim.put(0xd057, [0]);
  await tick();
  assert.equal(L.bcdDecode(tim.read(0xd347, 3)), 3000);
  assert.equal(doc.get('lbpay:abc123:p2').status, 'written');
  assert.equal(paid.length, 1);
  pay.check.at = 0;
  await tick(); // (read back once the mirror caught up)
  assert.equal(doc.get('lbpay:abc123:p2').checked, true);
  await tick();
  assert.equal(L.bcdDecode(tim.read(0xd347, 3)), 3000, 'never twice in the same game');
  // reset before saving: the save it boots from never had it – it goes in again, once
  tim.put(0xd347, [0x00, 0x50, 0x00]);
  pay.restarted();
  await tick();
  assert.equal(L.bcdDecode(tim.read(0xd347, 3)), 3000);
  pay.check.at = 0;
  await tick();
  pay.saved(); // the game saved: done for good
  assert.equal(doc.get('lbpay:abc123:p2').status, 'saved');
  pay.restarted();
  await tick();
  assert.equal(L.bcdDecode(tim.read(0xd347, 3)), 3000);
  // the winner's game: +₽2,000; a write that didn't land (the money still the old sum) goes in again
  const sam = bus({ 0xd347: [0x00, 0x30, 0x00], 0xd057: [0], 0xd12b: [0], 0xd163: [1] });
  const pay1 = new WagerPay({ doc, me: 'p1', own: ownOf() });
  await pay1.tick({ game: 'redblue', read: sam.read, write: sam.write });
  assert.equal(L.bcdDecode(sam.read(0xd347, 3)), 5000);
  sam.put(0xd347, [0x00, 0x30, 0x00]); // (as if the write had gone to where the money was a frame earlier)
  pay1.check.at = 0;
  assert.deepEqual(await pay1.tick({ game: 'redblue', read: sam.read, write: sam.write }), { retry: true });
  await pay1.tick({ game: 'redblue', read: sam.read, write: sam.write });
  assert.equal(L.bcdDecode(sam.read(0xd347, 3)), 5000);
});

test('wager: the result card says "paid" only once the money went into the game (Gen 1: still in the Colosseum = to pay)', async () => {
  const doc = memDoc();
  doc.set('lb:abc123:p1', entry({}));
  doc.set('lb:abc123:p2', entry({}));
  const o = W.outcomeOf(W.sessionsIn(doc).abc123);
  assert.equal(o.state, 'agreed');
  const before = W.wagerStatus(doc, 'abc123', 'p2', o.pays);
  assert.ok(before.delta < 0, 'p2 lost');
  assert.equal(before.settled, false, 'nothing taken yet: the game is still linked / in the Colosseum');
  assert.equal(W.wagerStatus(doc, 'abc123', 'p1', o.pays).settled, false);
  // the overworld: WagerPay takes it (Red: wIsInBattle and wLinkState 0)
  const tim = bus({ 0xd347: [0x00, 0x50, 0x00], 0xd057: [0], 0xd12b: [4], 0xd163: [2] }); // wLinkState 4: still in the Colosseum
  const pay = new WagerPay({ doc, me: 'p2', own: ownOf() });
  await pay.tick({ game: 'redblue', read: tim.read, write: tim.write });
  assert.equal(W.wagerStatus(doc, 'abc123', 'p2', o.pays).settled, false, 'the Colosseum is no overworld');
  tim.put(0xd12b, [0]); // switched off and on, Continue: walking again
  await pay.tick({ game: 'redblue', read: tim.read, write: tim.write });
  assert.deepEqual(W.wagerStatus(doc, 'abc123', 'p2', o.pays), { delta: before.delta, settled: true });
  assert.deepEqual(W.wagerStatus(doc, 'abc123', 'p3', o.pays), { delta: 0, settled: false }, 'not in it');
});

test('a game left in link mode after its session (Gen 2 Colosseum: it fights the partner\'s team again, alone) says so', () => {
  // Red: wLinkState; Gold/Silver and Crystal: wLinkMode (pret pokegold/pokecrystal.sym); Emerald: a BATTLE_TYPE_LINK battle
  assert.equal(L.gameLinked('redblue', bus({ 0xd12b: [0] }).read), false, 'the overworld');
  assert.equal(L.gameLinked('redblue', bus({ 0xd12b: [4] }).read), true, 'still in the Colosseum');
  assert.equal(L.gameLinked('yellow', bus({ 0xd12a: [1] }).read), true);
  assert.equal(L.gameLinked('crystal', bus({ 0xc2dc: [0] }).read), false);
  assert.equal(L.gameLinked('crystal', bus({ 0xc2dc: [2] }).read), true, 'Crystal in the Colosseum');
  assert.equal(L.gameLinked('goldsilver', bus({ 0xd042: [2] }).read), true, 'Silver in the Colosseum');
  assert.equal(L.gameLinked('goldsilver', bus({ 0xd116: [2] }).read), false, 'a battle of its own (wBattleMode) is no link');
  const em = bus({ 0x02022fec: [2, 0, 0, 0] });
  assert.equal(L.gameLinked('emerald', em.read, { inBattle: true }), true);
  assert.equal(L.gameLinked('emerald', em.read, { inBattle: false }), false, 'the flags stay from the last battle: the overworld isn\'t linked');
  assert.equal(L.gameLinked('emerald', bus({ 0x02022fec: [8, 0, 0, 0] }).read, { inBattle: true }), false, 'a trainer battle');
  assert.equal(L.gameLinked('platinum', bus({}).read), false);
  assert.equal(L.gameLinked(null, bus({}).read), false);
});

test('the run applies nothing of a game that says it is still linked (web/app.mjs, like the session itself)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  assert.match(src, /snap\.linkedGame && snap\.source === 'live' && !getRules\(doc, manifest\)\?\.linkBattleDeaths\) return null/);
  const play = (await import('node:fs')).readFileSync(new URL('../web/views/play.mjs', import.meta.url), 'utf8');
  assert.match(play, /gameLinked\(g0, e\.read, \{ inBattle: !!seen \}\)/);
});

test('wager: never into a game on its title screen – Gen 1/2 read as "idle" there, before Continue loads the save', async () => {
  // (seen in the e2e: Crystal switched off and on after the Colosseum – the wager went into RAM at ₽0 and was gone
  // when the save loaded; the winner's game never got it)
  assert.equal(await L.fieldIdle('crystal', bus({ 0xdcd7: [0] }).read), false, 'no team yet: the title screen');
  assert.equal(await L.fieldIdle('crystal', bus({ 0xdcd7: [2] }).read), true, 'Continue: the save is loaded');
  assert.equal(await L.fieldIdle('goldsilver', bus({ 0xda22: [0xff] }).read), false, 'garbage is no team');
  assert.equal(await L.fieldIdle('redblue', bus({ 0xd163: [0] }).read), false);
  assert.equal(await L.fieldIdle('yellow', bus({ 0xd162: [6] }).read), true);
  // Gen 3: Emerald and FR/LG load the save at boot – the title screen and the Continue menu hold nobody (no lock, no
  // fade): only the overworld's own callback counts (shared/world.mjs readCamera `field`; null where it isn't known)
  const cam = { battle: false, locked: false, help: false, replay: false, fade: 0 };
  assert.equal(await L.fieldIdle('emerald', bus({}).read, { cam: { ...cam, field: false } }), false, 'the main menu');
  assert.equal(await L.fieldIdle('emerald', bus({}).read, { cam: { ...cam, field: true } }), true, 'the overworld');
  assert.equal(await L.fieldIdle('frlgEu', bus({}).read, { cam: { ...cam, field: null } }), true, 'callback unknown: as before');
  const doc = memDoc();
  doc.set('lb:abc123:p1', entry({}));
  doc.set('lb:abc123:p2', entry({}));
  const tim = bus({ 0xd347: [0, 0, 0], 0xd057: [0], 0xd12b: [0], 0xd163: [0] }); // reset: WRAM cleared, money ₽0
  const pay = new WagerPay({ doc, me: 'p2', own: ownOf() });
  await pay.tick({ game: 'redblue', read: tim.read, write: tim.write });
  assert.equal(doc.get('lbpay:abc123:p2'), undefined, 'nothing written on the title screen');
  tim.put(0xd347, [0x00, 0x50, 0x00]);
  tim.put(0xd163, [2]); // Continue
  await pay.tick({ game: 'redblue', read: tim.read, write: tim.write });
  assert.equal(L.bcdDecode(tim.read(0xd347, 3)), 3000, 'paid from the loaded ₽5,000');
});

test('wager: the check after the write reads the core (the fast player\'s fresh) – a write the game lost goes in again', async () => {
  const doc = memDoc();
  doc.set('lb:abc123:p1', entry({}));
  doc.set('lb:abc123:p2', entry({}));
  // the fast player: the page's copy takes the write at once; the core lost it (it never comes back in a change)
  const core = bus({ 0xd347: [0x00, 0x30, 0x00], 0xd057: [0], 0xd12b: [0], 0xd163: [1] });
  const mirror = bus({ 0xd347: [0x00, 0x30, 0x00], 0xd057: [0], 0xd12b: [0], 0xd163: [1] });
  let fresh = 0;
  const io = {
    game: 'redblue', read: mirror.read, write: (a, b) => (mirror.put(a, [...b]), true),
    fresh: async () => (fresh++, core.m.forEach((v, a) => mirror.put(a, [v])), true),
  };
  const pay = new WagerPay({ doc, me: 'p1', own: ownOf() });
  await pay.tick(io);
  assert.equal(L.bcdDecode(mirror.read(0xd347, 3)), 5000, '(the page\'s copy says paid)');
  pay.check.at = 0;
  assert.deepEqual(await pay.tick(io), { retry: true }, 'the core still holds ₽3,000: in again');
  assert.equal(fresh, 1);
  assert.equal(doc.get('lbpay:abc123:p1'), undefined);
  // no answer for the whole memory: asked again later, nothing decided meanwhile
  await pay.tick({ ...io, write: (a, b) => (mirror.put(a, [...b]), core.put(a, [...b]), true) });
  pay.check.at = 0;
  assert.equal(await pay.tick({ ...io, fresh: async () => false }), null);
  assert.equal(doc.get('lbpay:abc123:p1').checked, undefined);
  assert.deepEqual(await pay.tick(io), { checked: true, now: 5000 });
});

test('wagers in other languages: the English version can – said instead of left out (a French Platinum)', async () => {
  const { wagerGame, wagerNeedsEnglish } = await import('../shared/linkbattle.mjs');
  for (const id of ['pokemon-platinum-eu', 'pokemon-heartgold-de', 'pokemon-soulsilver-eu', 'pokemon-emerald-de']) {
    assert.equal(wagerGame(id), false, id);
    assert.equal(wagerNeedsEnglish(id), true, id);
  }
  // a language whose addresses are known, a game without wagers at all, the English one: nothing to say
  for (const id of ['pokemon-ruby-de', 'pokemon-platinum', 'pokemon-x', 'pokemon-omega-ruby', 'pokemon-white-2-de']) assert.equal(wagerNeedsEnglish(id), false, id);
});
