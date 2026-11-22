// Gen 4 live tracking in every language (#11, a German HeartGold): the badges – and with them the level cap – come
// from the save data in RAM, also where the party is only found by scanning (no pointer for that language).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findEntry, readLiveParty, readLiveBattle, playerBattle, LiveTables } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const TABLE = L('addresses.json');
const T = new LiveTables({ gen4: L('gen4.json') });

const TID = 4242;
const SID = 777;

/** RAM as a plain 4 MB array (the scan reads all of it at once). */
function ram() {
  const m = new Uint8Array(0x400000);
  const at = (a) => a - 0x02000000;
  return {
    m,
    read: (a, n) => (a >= 0x02000000 && a + n <= 0x02400000 ? m.slice(at(a), at(a) + n) : null),
    put: (a, bytes) => m.set(bytes, at(a)),
    u32: (a, v) => new DataView(m.buffer).setUint32(at(a), v >>> 0, true),
    u16: (a, v) => new DataView(m.buffer).setUint16(at(a), v, true),
  };
}

function pk4({ pid = 0x1234abcd, species = 152, level = 12, tid = TID, sid = SID, metLevel = 5, hp = 30, maxHp = 34, form = 0 } = {}) {
  const d = new Uint8Array(236);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, tid, true);
  dv.setUint16(0x0e, sid, true);
  d[0x40] = form << 3;
  dv.setUint16(0x46, 126, true);
  d[0x84] = metLevel;
  d[0x8c] = level;
  dv.setUint16(0x8e, hp, true);
  dv.setUint16(0x90, maxHp, true);
  return encryptPK4(d);
}

/**
 * A Gen 4 save image in RAM at `base`, laid out like the .sav (PKHeX): the general block at +general, the trainer data
 * at general + trainer (TID +0x10, SID +0x12, badges +0x1A, HGSS Kanto +0x1F), the party in front of its mons at
 * base + partyMonsOffset − 8 ({ capacity 6, count, mons }).
 */
function saveImage(r, entry, base, { mons, johto = 0, kanto = 0, tid = TID, sid = SID }) {
  const general = base + parseInt(entry.badges.generalOffsetFromSaveBase, 16);
  const trainer = general + parseInt(entry.badges.trainerOffset, 16);
  r.u16(trainer + 0x10, tid);
  r.u16(trainer + 0x12, sid);
  r.m[trainer + 0x1a - 0x02000000] = johto;
  if (entry.badges.kantoOffset) r.m[general + parseInt(entry.badges.kantoOffset, 16) - 0x02000000] = kanto;
  partyAt(r, base + parseInt(entry.partyMonsOffset, 16) - 8, mons);
}
function partyAt(r, core, mons) {
  r.u32(core, 6);
  r.u32(core + 4, mons.length);
  mons.forEach((m, i) => r.put(core + 8 + i * 236, m));
}

test('HeartGold (English): Johto and Kanto badges from the save data, only for the team’s own trainer', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  const base = 0x0227c218;
  const r = ram();
  r.u32(0x02111880, base);
  saveImage(r, e, base, { mons: [pk4()], johto: 0b11111111, kanto: 0b00000101 });
  assert.equal(readLiveParty(e, r.read, T, {}).badges, 10, '8 Johto + 2 Kanto');
  saveImage(r, e, base, { mons: [pk4()], johto: 0b00000001 });
  assert.equal(readLiveParty(e, r.read, T, {}).badges, 1, 'Falkner');
  // another trainer's data there (a wrong place, the save not loaded yet): no badge count rather than a wrong one
  saveImage(r, e, base, { mons: [pk4()], johto: 0b00000111, tid: 1 });
  assert.equal(readLiveParty(e, r.read, T, {}).badges, undefined);
});

for (const [code, base] of [['IPKD', 0x0227d4a0], ['IPKF', 0x0227d500], ['IPGS', 0x0227d4c0], ['IPKI', 0x0227d4e0]]) {
  test(`HeartGold/SoulSilver ${code}: badges and PC read where the party was found by scanning (#11)`, () => {
    const e = findEntry(TABLE, { platform: 'nds', code });
    assert.ok(e.scanOnly, 'no pointer for this language: the party is searched for');
    const r = ram();
    saveImage(r, e, base, { mons: [pk4(), pk4({ pid: 0x55556666, species: 16, metLevel: 3, level: 4 })], johto: 0b00000001 });
    const state = {};
    let res = readLiveParty(e, r.read, T, state);
    assert.deepEqual(res.party.map((m) => m.species), [152, 16]);
    assert.equal(res.badges, 1, 'the first badge – the level cap moves on to the second gym');
    assert.deepEqual(res.boxes, [], 'the PC is read too (empty)');
    assert.equal(state.saveBase, base);
    // the next polls go to the remembered place and keep reading the badges
    r.m[base + 0x10 + 0x7e - 0x02000000] = 0b00000011;
    res = readLiveParty(e, r.read, T, state);
    assert.equal(res.badges, 2);
  });
}

test('Platinum and Diamond/Pearl in other languages: badges from the scanned save data', () => {
  for (const [code, base] of [['CPUD', 0x02270000], ['ADAF', 0x02280000], ['APAS', 0x02281000]]) {
    const e = findEntry(TABLE, { platform: 'nds', code });
    assert.ok(e.scanOnly, code);
    const r = ram();
    saveImage(r, e, base, { mons: [pk4()], johto: 0b00000111 });
    assert.equal(readLiveParty(e, r.read, T, {}).badges, 3, code);
  }
});

test('scanned Gen 4: no save data that isn’t the team’s own – no badges, no PC (not a wrong count)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKD' });
  const r = ram();
  // a lone copy of the party (a battle's) with nothing of the save around it
  partyAt(r, 0x02250000, [pk4()]);
  r.put(0x02250000 - 0xa0 + 0x10 + 0x7e, [0xff]); // whatever is where badges would be
  const res = readLiveParty(e, r.read, T, {});
  assert.equal(res.party.length, 1);
  assert.equal(res.badges, undefined);
  assert.equal(res.boxes, null);
});

test('scanned Gen 4: a copy of the party lower in RAM – the module-params pointer leads to the save’s own party', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKD' });
  const r = ram();
  const base = 0x0227d4a0;
  saveImage(r, e, base, { mons: [pk4({ level: 13 })], johto: 0b00000001 });
  partyAt(r, 0x02150000, [pk4({ level: 13 })]); // the scan finds this one first
  r.u32(0x02000ba8, 0x02111900); // NitroSDK module params → .bss; +0x20: the SaveData pointer
  r.u32(0x02111920, base);
  const state = {};
  const res = readLiveParty(e, r.read, T, state);
  assert.equal(res.badges, 1);
  assert.equal(state.partyAddr, base + 0xa0, 'the save’s party from now on');
});

/** Polls the party and the battle `n` times (the heap search takes a few polls) → the last battle. */
function battlePolls(e, r, state, n = 8) {
  let fight = null;
  for (let i = 0; i < n; i++) fight = readLiveBattle(e, r.read, T, state, readLiveParty(e, r.read, T, state).party);
  return fight;
}

test('Platinum, HeartGold: the catching demo (Dawn\'s starter vs. Bidoof, Lyra\'s Marill vs. Rattata) is no battle of the player\'s', () => {
  // Platinum: FieldBattleDTO_NewCatchingTutorial – the counterpart's starter (Lv. 5) and a Bidoof (Lv. 2), both another trainer's
  const pt = findEntry(TABLE, { platform: 'nds', code: 'CPUE' });
  let r = ram();
  const base = 0x02270000;
  r.u32(0x02101d40, base);
  saveImage(r, pt, base, { mons: [pk4({ pid: 0x0a0a0001, species: 390, level: 9 })] });
  r.u16(0x0224a55a, 0x2100); // in battle (the demo is flagged like any battle)
  partyAt(r, 0x02300000, [pk4({ pid: 0x5eed0001, species: 393, level: 5, tid: 1, sid: 2 })]);
  partyAt(r, 0x02301000, [pk4({ pid: 0x5eed0002, species: 399, level: 2, tid: 3, sid: 4, hp: 12, maxHp: 12 })]);
  let fight = battlePolls(pt, r, {});
  assert.equal(fight.tutorial, true);
  assert.equal(fight.enemy.species, 399);
  assert.equal(playerBattle(fight), null, 'the tracker skips it');
  // a real battle: the player's party copy is there – a trainer's lone Bidoof isn't the demo then
  partyAt(r, 0x02302000, [pk4({ pid: 0x0a0a0001, species: 390, level: 9, hp: 20 })]);
  fight = battlePolls(pt, r, {});
  assert.equal(fight.tutorial, undefined);
  // HeartGold: BattleSetup_New_Tutorial – Marill (Lv. 5) and Rattata (Lv. 2)
  const hg = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  r = ram();
  const hb = 0x0227c218;
  r.u32(0x02111880, hb);
  saveImage(r, hg, hb, { mons: [pk4({ pid: 0x0a0a0001, species: 155, level: 9 })] });
  r.u16(0x02246f48, 0x2100);
  partyAt(r, 0x02300000, [pk4({ pid: 0x5eed0003, species: 183, level: 5, tid: 1, sid: 2 })]);
  partyAt(r, 0x02301000, [pk4({ pid: 0x5eed0004, species: 19, level: 2, tid: 3, sid: 4 })]);
  fight = battlePolls(hg, r, {});
  assert.equal(fight.tutorial, true);
  assert.equal(fight.enemy.species, 19);
});

test('Platinum: the trainer\'s Pokémon that is out comes from the battle\'s own BattleMon – the AI picks the next one, not the party order', () => {
  const pt = findEntry(TABLE, { platform: 'nds', code: 'CPUE' });
  const r = ram();
  const base = 0x02270000;
  r.u32(0x02101d40, base);
  const me = { pid: 0x0a0a0001, species: 390, level: 14 };
  saveImage(r, pt, base, { mons: [pk4(me)] });
  r.u16(0x0224a55a, 0x2100);
  partyAt(r, 0x02302000, [pk4({ ...me, hp: 20 })]); // the battle's copy of the player's party
  const foes = [
    { pid: 0x7e000001, species: 396, level: 12, tid: 9, sid: 9 },
    { pid: 0x7e000002, species: 399, level: 12, tid: 9, sid: 9 },
    { pid: 0x7e000003, species: 403, level: 14, tid: 9, sid: 9 },
  ];
  const copy = (hps) => partyAt(r, 0x02300000, foes.map((f, i) => pk4({ ...f, hp: hps[i], maxHp: 34 })));
  // battler 1's BattleMon (0xC0 each from battler 0's, whose personality sits at saveBase + battleActive)
  const b1 = base + parseInt(pt.battleActive.pidOffsetFromSaveBase, 16) - 0x68 + 0xc0;
  const out = (f, hp) => {
    r.u16(b1, f.species);
    r.m[b1 + 0x34 - 0x02000000] = f.level;
    r.u32(b1 + 0x4c, hp);
    r.u32(b1 + 0x50, 34);
    r.u32(b1 + 0x68, f.pid);
  };
  copy([34, 34, 34]);
  out(foes[0], 34);
  const state = {};
  assert.equal(battlePolls(pt, r, state).enemy.species, 396, 'the lead');
  // the lead is down, the trainer hasn't sent the next one yet: still the lead (at 0 HP), not a guess
  copy([0, 34, 34]);
  out(foes[0], 0);
  assert.equal(battlePolls(pt, r, state, 1).enemy.species, 396);
  // the AI sends its third Pokémon – not the second in the party
  out(foes[2], 34);
  assert.equal(battlePolls(pt, r, state, 1).enemy.species, 403);
  // only one is left standing: that one is next for sure
  copy([0, 34, 0]);
  out(foes[2], 0);
  assert.equal(battlePolls(pt, r, state, 1).enemy.species, 399);
});

test('#89 German HeartGold: after a trainer battle the beaten trainer\'s party in the heap is never taken for the team', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKD' });
  const r = ram();
  const base = 0x0227d4a0;
  const mine = [pk4({ pid: 0x0a0a0001, species: 155, level: 14 }), pk4({ pid: 0x0a0a0002, species: 16, level: 12 })];
  saveImage(r, e, base, { mons: mine, johto: 0b00000001 });
  // the trainer's party, lower in RAM than the save: its Pokémon belong to someone else and are all down
  const foeCore = 0x02150000;
  partyAt(r, foeCore, [pk4({ pid: 0x7e000001, species: 74, level: 12, tid: 9, sid: 9, hp: 0 }), pk4({ pid: 0x7e000002, species: 95, level: 14, tid: 9, sid: 9, hp: 0 })]);
  const state = {};
  assert.deepEqual(readLiveParty(e, r.read, T, state).party.map((m) => m.species), [155, 16], 'the scan takes the save\'s party, not the lowest one');
  assert.equal(state.partyAddr, base + 0xa0);
  // the game rewrites the party after the battle (count 0 for a moment) – the next search must not settle on the foe's
  r.u32(base + 0xa0 + 4, 0);
  state.lastScan = 0;
  assert.equal(readLiveParty(e, r.read, T, state), null, 'no team for that poll rather than the opponent\'s');
  state.lastScan = 0;
  assert.equal(readLiveParty(e, r.read, T, state), null);
  r.u32(base + 0xa0 + 4, 2);
  state.lastScan = 0;
  assert.deepEqual(readLiveParty(e, r.read, T, state).party.map((m) => m.species), [155, 16], 'and the team again once it is back');
  // with the module params pointing at the save data, the save's party is read straight away
  r.u32(0x02000ba8, 0x02111900);
  r.u32(0x02111920, base);
  const s2 = {};
  assert.deepEqual(readLiveParty(e, r.read, T, s2).party.map((m) => m.species), [155, 16]);
  assert.equal(s2.saveBase, base);
});
