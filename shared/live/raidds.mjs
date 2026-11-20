// Raid drivers for the DS games (shared/live/raidhp.mjs, docs/MULTIPLAYER.md › "Raid"): Gen 4 (Platinum, HeartGold)
// and Gen 5 (Black 2). Same contract as the Game Boy / GBA drivers: view → the opponent's party, who is out, whether
// the game waits for the player (quiet); writes → the battle's HP, the party copy, the HP bar. Everything here was
// measured in the running games (the souldew engine, melonDS) – Gen 4 with the pret/pokeplatinum and pokeheartgold
// decompilations, Gen 5 without one (its heap blocks name their source files: btl_main, btl_client, btlv_gauge …).
// Only main RAM (0x02000000 + 4 MB) is read or written – what the app mirrors.

const u16 = (b, o = 0) => b[o] | (b[o + 1] << 8);
const u32 = (b, o = 0) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s32 = (b, o = 0) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const le = (n, bytes) => {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) b[i] = (n >>> (8 * i)) & 255;
  return b;
};
const ram = (a) => a >= 0x02000000 && a < 0x02400000;
const r32 = (read, a) => {
  const b = read(a, 4);
  return b ? u32(b) : null;
};
/** The game's own "in a battle" word (addresses.json inBattle: 0x2100/0x2101 in battle, 0x2800 on the overworld). */
function battleWord(entry, read) {
  const ib = entry?.inBattle;
  const f = ib && read(Number(ib.addr), 2);
  return !!f && (ib.inBattleValues || ['0x2100', '0x2101']).map(Number).includes(u16(f));
}

// ---- Gen 4 ----------------------------------------------------------------------------------------------------------
//
// BattleContext.battleMons[b].curHP (s32, BattleMon +0x4C) is the HP the battle works with: damage is applied to it, the
// faint check reads it, the HP bar message is built from it. After every change the battle copies it into the party
// Pokémon (BattleMon_CopyToParty), and a Pokémon sent out takes its HP from there – party +0x8E, in the PID-encrypted
// battle-stats block (no checksum covers it; flags bit 0 = the game holds it decrypted right now: then plain).
// The opponent's HP bar (BattlerData's HealthBox) keeps its own HP and redraws only through a client command; its pixels
// are in VRAM. So the driver hands the game the same UpdateHPGauge command the battle sends after a hit (the HP the bar
// shows → the new one), and the bar slides there itself – the queue entry first (the battle waits for it), the message,
// its command byte last. Checked live: Platinum vs Barry (Chimchar 19 → 10, then Tackle 10 → 5; 1 HP → the game's own
// faint, exp, "Player defeated Barry"), HeartGold vs Bug Catcher Al (Weedle written to 30 % came out with 9/31; written
// 0 it was never sent out).
//
// Quiet: the battle waits for the player's command (command 5), the player's battler is in one of its menus (state 1 or
// 3–12 – not 2: the first turn's "Go! X!"), no opponent battler has a command, a running HP bar task or a queue entry,
// and no opponent's party struct is decrypted right now.

const G4 = {
  platinum_us: { saveDataPtr: 0x02101d40, ctxFromSave: 0x44878, sysFromSave: 0x417fc },
  heartgold_us: { saveDataPtr: 0x02111880, ctxFromSave: 0x470d4, sysFromSave: 0x44008 },
};
const CTX = { command: 0x08, selectedPartySlot: 0x219c, ioQueue: 0x2200, battleMons: 0x2d40 };
const BMON4 = 0xc0; // BattleMon: species +0, level +0x34, curHP +0x4C, maxHP +0x50, personality +0x68, gender +0x7E
const SYS = { battleType: 0x2c, battleCtx: 0x30, battlers: 0x34, maxBattlers: 0x44, parties: 0x68, trainerIDs: 0xa0 };
const BD = { hbTask: 0x38, hbCurHP: 0x50, data: 0x94 }; // BattlerData: the HealthBox's task and HP, the command buffer
const MON4 = 236;
const BT4 = { TRAINER: 1, LINK: 4, MULTI: 8, TAG: 16, FRONTIER: 128 };
const menuUp = (c) => c === 1 || (c >= 3 && c <= 12);
const UPDATE_HP_GAUGE = 24;

/** The Gen 4 keystream word `word` of a party Pokémon's battle-stats block (seeded by its PID). */
function partyKey(pid, word) {
  let s = pid >>> 0;
  let k = 0;
  for (let i = 0; i <= word; i++) {
    s = (Math.imul(s, 0x41c64e6d) + 0x6073) >>> 0;
    k = s >>> 16;
  }
  return k;
}
function readMon4(read, addr) {
  const b = read(addr, 0x92);
  if (!b) return null;
  const pid = u32(b, 0);
  const flags = u16(b, 4);
  const key = (w) => (flags & 1 ? 0 : partyKey(pid, w));
  return { pid, flags, hp: u16(b, 0x8e) ^ key(3), level: (u16(b, 0x8c) ^ key(2)) & 0xff, maxHp: u16(b, 0x90) ^ key(4), hpKey: key(3) };
}

function findSys(g, read, saveBase, ctx, state) {
  const ok = (sys) => {
    const b = sys && read(sys, 0xa8);
    if (!b || u32(b, SYS.battleCtx) !== ctx) return false;
    const n = u32(b, SYS.maxBattlers);
    if (n < 2 || n > 4) return false;
    for (let i = 0; i < n; i++) if (!ram(u32(b, SYS.battlers + 4 * i))) return false;
    return ram(u32(b, SYS.parties + 4));
  };
  if (state.sys && ok(state.sys)) return state.sys;
  if (ok(saveBase + g.sysFromSave)) return (state.sys = saveBase + g.sysFromSave);
  // elsewhere: the pointer to the context below it (once per battle)
  if (state.sysScan === ctx) return null;
  state.sysScan = ctx;
  const from = Math.max(0x02000000, ctx - 0x40000);
  const b = read(from, ctx - from);
  if (!b) return null;
  for (let o = b.length - 4; o >= 0; o -= 4) if (u32(b, o) === ctx && ok(from + o - SYS.battleCtx)) return (state.sys = from + o - SYS.battleCtx);
  return null;
}

function locate4(entry, read, state) {
  const g = G4[entry.id];
  if (!battleWord(entry, read)) return null;
  const saveBase = r32(read, g.saveDataPtr);
  if (!ram(saveBase)) return null;
  const ctx = saveBase + g.ctxFromSave;
  const c = read(ctx, 0x10);
  if (!c || u32(c, CTX.command) > 50) return null;
  const sys = findSys(g, read, saveBase, ctx, state);
  if (!sys) return null;
  const s = read(sys, 0xa8);
  if (!s) return null;
  const battleType = u32(s, SYS.battleType);
  const maxBattlers = u32(s, SYS.maxBattlers);
  const twoFoes = (battleType & (BT4.MULTI | BT4.TAG)) !== 0;
  const slots = [];
  for (const pi of twoFoes ? [1, 3] : [1]) {
    const pa = u32(s, SYS.parties + 4 * pi);
    const pb = ram(pa) && read(pa, 8);
    if (!pb) return null;
    const n = u32(pb, 4);
    if (n < 1 || n > 6) return null;
    for (let k = 0; k < n; k++) slots.push({ party: pi, slot: k, addr: pa + 8 + k * MON4 });
  }
  return { ctx, sys, s, command: u32(c, CTX.command), ccs: [...c.subarray(0, 4)], battleType, maxBattlers, twoFoes, slots, foeBattlers: maxBattlers > 2 ? [1, 3] : [1] };
}

function view4(entry, read, state) {
  const L = locate4(entry, read, state);
  if (!L) {
    if (state.inBattle) state.battleNo = (state.battleNo || 0) + 1;
    state.inBattle = false;
    state.sys = null;
    return null;
  }
  const { ctx, s, command, ccs, battleType, maxBattlers, twoFoes, slots, foeBattlers } = L;
  const sel = read(ctx + CTX.selectedPartySlot, 4);
  const bm = read(ctx + CTX.battleMons, BMON4 * 4);
  if (!sel || !bm) return null;
  const foes = [];
  for (const [idx, x] of slots.entries()) {
    const m = readMon4(read, x.addr);
    if (!m || !(m.maxHp > 0) || m.hp > m.maxHp) return null;
    foes.push({ idx, hp: m.hp, maxHp: m.maxHp, level: m.level, pid: m.pid, busy: (m.flags & 3) !== 0 });
  }
  const active = [];
  for (const b of foeBattlers) {
    const i = slots.findIndex((x) => x.party === (twoFoes ? b : 1) && x.slot === sel[b]);
    const o = b * BMON4;
    if (i < 0 || !u16(bm, o) || u32(bm, o + 0x68) !== foes[i].pid) continue; // (not sent out yet)
    active.push(i);
    foes[i].hp = s32(bm, o + 0x4c);
    foes[i].maxHp = u32(bm, o + 0x50);
    foes[i].level = bm[o + 0x34];
  }
  let quiet = command === 5 && (menuUp(ccs[0]) || (maxBattlers > 2 && menuUp(ccs[2])));
  const q = read(ctx + CTX.ioQueue, 4 * 16);
  for (const b of foeBattlers) {
    const bd = u32(s, SYS.battlers + 4 * b);
    const d = ram(bd) && read(bd, BD.data + 1);
    if (!d || d[BD.data] !== 0 || u32(d, BD.hbTask) !== 0) quiet = false;
    if (!q || q.subarray(b * 16, b * 16 + 16).some((x) => x)) quiet = false;
  }
  if (foes.some((f) => f.busy)) quiet = false;
  const t = read(L.sys + SYS.trainerIDs, 8);
  const trainer = (battleType & BT4.TRAINER) !== 0 && (battleType & (BT4.LINK | BT4.FRONTIER)) === 0;
  state.inBattle = true;
  return {
    trainer, quiet, key: `g4:${state.battleNo || 0}:${t ? u16(t, 2) : 0}:${foes.map((f) => f.pid.toString(16)).join('.')}`,
    trainerId: trainer && t ? u16(t, 2) : null, foes: foes.map(({ pid, busy, ...f }) => f), active,
    debug: { command, ccs, battleType, ctx, sys: L.sys }, // (for diagnostics and the lab's proofs)
  };
}

function writes4(entry, read, state, v, idx, hp) {
  const L = locate4(entry, read, state);
  const x = L?.slots[idx];
  if (!x) return [];
  const { ctx, s, twoFoes, foeBattlers } = L;
  const m = readMon4(read, x.addr);
  if (!m) return [];
  let n = Math.max(0, Math.min(hp | 0, m.maxHp));
  const out = [];
  const sel = read(ctx + CTX.selectedPartySlot, 4);
  const b = sel && foeBattlers.find((k) => (twoFoes ? k : 1) === x.party && sel[k] === x.slot && r32(read, ctx + CTX.battleMons + k * BMON4 + 0x68) === m.pid);
  if (b !== undefined && b !== false) {
    n = Math.max(1, n); // (the one out: never 0 – the game's own hit knocks it out)
    const o = ctx + CTX.battleMons + b * BMON4;
    const mon = read(o, BMON4);
    out.push({ addr: o + 0x4c, bytes: le(n, 4) });
    const bd = u32(s, SYS.battlers + 4 * b);
    const d = mon && read(bd, BD.data + 1);
    const qa = ctx + CTX.ioQueue + b * 16;
    const q = read(qa, 16);
    const free = q ? q.findIndex((z) => z === 0) : -1;
    const shown = d ? s32(d, BD.hbCurHP) : n;
    if (d && shown !== n && d[BD.data] === 0 && u32(d, BD.hbTask) === 0 && free >= 0) {
      // HPGaugeUpdateMessage { u8 command; u8 level; s16 curHP; u16 maxHP; u8 pad; u8 gender; s32 hpCalcTemp; … }
      const msg = new Uint8Array(16);
      msg[0] = UPDATE_HP_GAUGE;
      msg[1] = mon[0x34];
      msg.set(le(shown & 0xffff, 2), 2);
      msg.set(le(u32(mon, 0x50) & 0xffff, 2), 4);
      msg[7] = mon[0x7e] & 0x0f;
      msg.set(le(n - shown, 4), 8);
      out.push({ addr: qa + free, bytes: Uint8Array.of(UPDATE_HP_GAUGE) }, { addr: bd + BD.data + 1, bytes: msg.subarray(1) }, { addr: bd + BD.data, bytes: msg.subarray(0, 1) });
    }
  }
  out.unshift({ addr: x.addr + 0x8e, bytes: le(n ^ m.hpKey, 2) }); // the party copy (sent-out Pokémon start from it; 0 = skipped)
  return out;
}

// ---- Gen 5 (Black 2) ---------------------------------------------------------------------------------------------
//
// *(0x021DD87C) is the battle's main struct; main+0xC8 the clients' Pokémon container (the screen's), main+0x1B0 the
// server's (the battle logic's). Each: four parties of { BTL_POKEPARAM* mons[6] (battle order: the one out first);
// u32 count } at +4, and +0x84 + side × 0x30 the side's Pokémon in party order. BTL_POKEPARAM (one per Pokémon in each
// container): species +0x0C, max HP +0x0E, HP +0x10 (u16), level +0x18, +0 → its party copy (PID first). The server's
// HP is what the battle uses, the client's what the screen plays back (the server sends "HP minus n") – both are always
// written together, only while they agree. The party copies are never read for HP in battle: not written.
// The HP bar (the btlv_gauge.c heap block: per gauge { pos @−4, HP @0, max HP @+4, damage @+0x20, flags @+0x28 }) is
// drawn from its own HP: the driver sets damage = shown − new and the "HP changed" flag, and the gauge redraws itself
// the next frame the way it does after a hit. Checked live in Hugh's first battle: 20 → 10 (the bar at half the next
// frame, Tackle 10 → 5 animated from 10), 1 HP → "The foe's Oshawott fainted!", exp, "Player defeated Hugh"; a party
// member set to 0 never came out, one set to 30 % came out with 6/20.
//
// Quiet (single battles only – doubles, triples and rotation battles never read as waiting): the player's client's
// main proc is the input handler and its sub proc the action or the move menu, server and client HP agree for every
// Pokémon, the bar isn't moving.

const B2 = {
  mainPtr: 0x021dd87c, pokeconPtr: 0x021dd880, procInput: 0x021b23b9, subMenus: [0x021b3629, 0x021b3c01],
  cMain: 0xc8, sMain: 0x1b0, client0: 0x10, party: 4, partySize: 0x1c, order: 0x84, orderSide: 0x30,
};
const GAUGE_TAG = [...'btlv_gauge.c\0'].map((c) => c.charCodeAt(0));
const heap5 = (p) => p >= 0x02200000 && p < 0x02400000;

function sideMons(read, C, S, side) {
  const count = r32(read, C + B2.party + side * B2.partySize + 0x18);
  if (count === null || count < 1 || count > 6) return null;
  const cl = read(C + B2.order + side * B2.orderSide, 4 * count);
  const sv = read(S + B2.order + side * B2.orderSide, 4 * count);
  if (!cl || !sv) return null;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = u32(cl, i * 4);
    const b = u32(sv, i * 4);
    if (!heap5(a) || !heap5(b)) return null;
    out.push({ cl: a, sv: b });
  }
  return out;
}
function readBpp(read, a) {
  const b = read(a, 0x1c);
  if (!b) return null;
  const pp = u32(b, 0);
  return { pid: heap5(pp) ? r32(read, pp) : null, species: u16(b, 0x0c), maxHp: u16(b, 0x0e), hp: u16(b, 0x10), level: b[0x18] };
}
function indexOfTag(b, from) {
  outer: for (let i = from; i + GAUGE_TAG.length <= b.length; i++) {
    if (b[i] !== GAUGE_TAG[0]) continue;
    for (let k = 1; k < GAUGE_TAG.length; k++) if (b[i + k] !== GAUGE_TAG[k]) continue outer;
    return i;
  }
  return -1;
}
/** The opponent's gauge (single battle: position 1) in the btlv_gauge.c heap block – found once per battle. */
function findGauge(read, state, pos, maxHp, now = Date.now()) {
  const g = state.gauge;
  if (g && g.pos === pos) {
    const b = read(g.addr - 4, 12);
    if (b && u32(b, 0) === pos && u32(b, 8) === maxHp && u32(b, 4) <= maxHp) return g.addr;
  }
  if (state.gaugeScan && now - state.gaugeScan < 2000) return null;
  state.gaugeScan = now;
  for (let base = 0x02200000; base < 0x02400000; base += 0x80000) {
    const mem = read(base, Math.min(0x80000 + 0x400, 0x02400000 - base));
    if (!mem) continue;
    for (let i = indexOfTag(mem, 0); i >= 0; i = indexOfTag(mem, i + 1)) {
      const data = base + i + 0x18;
      const blk = read(data, 0x300);
      if (!blk) continue;
      for (let o = 4; o + 8 <= blk.length; o += 4) {
        if (u32(blk, o - 4) === pos && u32(blk, o + 4) === maxHp && u32(blk, o) <= maxHp) {
          state.gauge = { pos, addr: data + o };
          return data + o;
        }
      }
    }
  }
  return null;
}
function trainerIdOf(read, setup) {
  const p = r32(read, setup + 0x4c);
  const b = heap5(p) && read(p, 8);
  if (!b) return null;
  const id = u32(b, 0);
  return id > 0 && id < 1000 && u32(b, 4) < 256 ? id : null;
}

function view5(entry, read, state) {
  if (!battleWord(entry, read)) {
    state.battle = null;
    return null;
  }
  const main = r32(read, B2.mainPtr);
  if (!heap5(main)) return null;
  const C = main + B2.cMain;
  const S = main + B2.sMain;
  if (r32(read, B2.pokeconPtr) !== C || r32(read, C) !== main || r32(read, S) !== main) return null;
  const setup = r32(read, main);
  const head = heap5(setup) && read(setup, 8);
  if (!head) return null;
  const rule = u32(head, 4); // 0 single, 1 double, 2 triple, 3 rotation
  const foeSlots = sideMons(read, C, S, 1);
  const mySlots = sideMons(read, C, S, 0);
  if (!foeSlots || !mySlots) return null;
  const foes = [];
  let inSync = true;
  for (const [idx, x] of foeSlots.entries()) {
    const c = readBpp(read, x.cl);
    const sv = readBpp(read, x.sv);
    if (!c || !sv || !c.species || c.species > 649 || !c.maxHp || c.maxHp > 999 || c.hp > c.maxHp) return null;
    if (c.hp !== sv.hp) inSync = false;
    foes.push({ idx, hp: sv.hp, maxHp: sv.maxHp, level: c.level, pid: c.pid, shownHp: c.hp });
  }
  for (const x of mySlots) {
    const c = readBpp(read, x.cl);
    const sv = readBpp(read, x.sv);
    if (!c || !sv || c.hp !== sv.hp) inSync = false;
  }
  const nOut = rule === 1 ? 2 : rule === 2 ? 3 : 1;
  const order = read(C + B2.party + B2.partySize, 4 * nOut);
  const active = [];
  if (order) for (let k = 0; k < nOut; k++) {
    const i = foeSlots.findIndex((x) => x.cl === u32(order, k * 4));
    if (i >= 0) active.push(i);
  }
  const wild = u32(head, 0) === 0;
  const trainerId = wild ? null : trainerIdOf(read, setup);
  const key = `g5:${main.toString(16)}:${setup.toString(16)}:${trainerId ?? 'w'}:${foes.map((f) => (f.pid >>> 0).toString(16)).join(',')}`;
  if (state.battle !== key) Object.assign(state, { battle: key, gauge: null, gaugeScan: 0 });
  const c0 = r32(read, main + B2.client0);
  const procs = heap5(c0) ? read(c0 + 0xd0, 12) : null;
  let quiet = !!procs && u32(procs, 0) === B2.procInput && B2.subMenus.includes(u32(procs, 8)) && inSync && rule === 0;
  if (quiet && active.length === 1) {
    const f = foes[active[0]];
    const G = findGauge(read, state, 1, f.maxHp);
    const g = G && read(G, 0x2c);
    if (!g || g[0x28] & 1 || u32(g, 0) !== f.shownHp) quiet = false;
  }
  return { trainer: !wild, quiet, key, trainerId, foes: foes.map(({ pid, shownHp, ...f }) => f), active };
}

function writes5(entry, read, state, v, idx, hp) {
  const main = r32(read, B2.mainPtr);
  if (!heap5(main)) return [];
  const s = sideMons(read, main + B2.cMain, main + B2.sMain, 1)?.[idx];
  const c = s && readBpp(read, s.cl);
  if (!c) return [];
  const isOut = (v?.active || []).includes(idx);
  let n = Math.max(0, Math.min(c.maxHp, Math.round(hp)));
  if (isOut) n = Math.max(1, n);
  const out = [{ addr: s.sv + 0x10, bytes: le(n, 2) }, { addr: s.cl + 0x10, bytes: le(n, 2) }];
  if (isOut) {
    const G = findGauge(read, state, 1, c.maxHp);
    const g = G && read(G, 0x2c);
    const dmg = g ? (u32(g, 0) - n) | 0 : 0;
    if (g && dmg) out.push({ addr: G + 0x20, bytes: le(dmg >>> 0, 4) }, { addr: G + 0x28, bytes: Uint8Array.of(g[0x28] | 1) });
  }
  return out;
}

export const DS_DRIVERS = [
  { id: 'gen4', table: (entry) => G4[entry?.id] || null, view: (entry, read, state) => view4(entry, read, state), writes: (entry, read, state, T, v, idx, hp) => writes4(entry, read, state, v, idx, hp) },
  { id: 'gen5', table: (entry) => (entry?.id === 'black2_us' ? B2 : null), view: (entry, read, state) => view5(entry, read, state), writes: (entry, read, state, T, v, idx, hp) => writes5(entry, read, state, v, idx, hp) },
];
