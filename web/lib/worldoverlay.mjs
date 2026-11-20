// Shared World, the player page's half (docs/MULTIPLAYER.md › 9): the partners drawn over the game's picture, their
// names, the Pokémon following each of them (and you), the emote bubbles, and the little menu when you walk up to a
// partner and press A (Trade / Battle / Wave / Rock-paper-scissors / emotes) – with the rock-paper-scissors picker.
// Nothing is written into the game: souldew reads where the camera is (every picture: the native player sends those
// few bytes with each frame, web/lib/nativeplayer.mjs WATCH; the browser player reads its memory directly) and draws
// the partners' sprites – taken from this computer's ROM – on a canvas exactly on top of the picture.
//
// The play view (web/lib/sharedworld.mjs) drives it through window.__world: config(), partner(), gone(), wave(),
// emote(), rps(), rpsRound(). This page tells it the local player's state ('emu-world', ~15 a second), what was picked
// in the menu ('emu-world-act') and in the rock-paper-scissors picker ('emu-world-rps').
import {
  worldTable, watchRanges, rangeReader, chainReaders, readCamera, readPlayer, readLocalSprite, drawable, OverworldLearner,
  Track, unpackState, screenPos, facedPartner, gfxFor, kindFor, animFor, readMapView, blockReader, popupRect, GBA_KEY, TILE,
  Follower, followerHidden, readConnections, inLocalFrame, APress, startOnce, PictureClock, pixelSnapper, StepGate,
} from '/shared/world.mjs';
import { findMonIcons, monIcon, iconIndex, dexToInternal, NAT } from '/shared/worldicons.mjs';
import { ART, HAND_ART, artSize } from '/lib/worldart.mjs';
import { WORLD_CSS, drawBubble, createWorldUi } from '/lib/worldui.mjs';
import { gen3Avatar, animFrame, liveFrame, avatarPalette } from '/shared/worldsprites.mjs';
import { mapTop, coverMask, aboveTopLayer } from '/shared/worldmap.mjs';
import { togetherLayer, standIn, emptyTogether, POP_MS } from '/lib/togetheroverlay.mjs';
import {
  gbSheet, sheetFrames, GB_ANIMS, gen1Icon, gen2Icon, gen2MonPalette, gen2ObjPalette, DMG_SHADES, DMG_OBP0, samplePalette, paint, gbMapView,
  grassMask, gameFollower, gameFollowerTile,
} from '/shared/worldgb.mjs';

const STATE_MS = 66; // the local state to the play view (it decides what goes out)
const WAVE_MS = 2600; // an emote bubble
const HAND_MS = 2400; // the hands of a rock-paper-scissors round
const A_CONFIRM_MS = 110; // after A: the game's own answer (a sign, a person) takes over first
const A_CONFIRM_GB_MS = 250; // (the Game Boy games run their overworld every other frame: they answer later)
const RETRO_A = 1 << 8; // libretro joypad bit of A (nativeplayer's input)


// a little four-point star over a shiny follower (party icons have no shiny colours in Gen 3) – original pixel art
const SPARKLE = ['..#..', '..#..', '##o##', '..#..', '..#..'];

/**
 * Installs window.__world in a player page. `host`: { system, romUrl, read(addr, len), rect() → the picture's box in
 * CSS pixels, watch?(ranges) (native: per-picture bytes), watchedNow?() (native: the newest of those bytes), pause(),
 * resume(), paused(), post(msg), keyButton?(e) }.
 */
export function installWorld(host) {
  let st = null; // everything once config() turned it on
  // (one overlay per page: a config() while the first start still runs waits for it – shared/world.mjs startOnce)
  const begin = startOnce((cfg) => start(host, cfg).catch((e) => (console.warn('shared world', e), null)));
  const api = {
    /** From the play view: { me, players: { slot: { name, color } }, enabled, actions: { slot: { trade, battle, why } }, labels } */
    async config(cfg) {
      if (!st) st = await begin(cfg);
      st?.setConfig(cfg);
      return !!st?.t;
    },
    partner: (slot, wire) => st?.partner(slot, wire),
    gone: (slot) => st?.gone(slot),
    wave: (slot) => st?.emote(slot, 'wave'),
    /** An emote bubble over a player (`slot` may be the local one): 'wave' | 'heart' | 'excl' | 'quest' | 'gg' */
    emote: (slot, name) => st?.emote(slot, name),
    /** The rock-paper-scissors game this page shows (shared/rps.mjs view + names), or null: the picker closes */
    rps: (view) => st?.rps?.(view),
    /** A round's hands over both players' heads: { hands: { slot: 0–2 }, winner } */
    rpsRound: (round) => st?.rpsRound?.(round),
    /** Playing together (web/lib/togetheroverlay.mjs): { battles, pops, tombs, ping } from the play view */
    together: (data) => st?.together?.(data),
    /** Can this page show a rock-paper-scissors game right now (Shared World on, the overworld on screen)? */
    canPresent: () => !!st?.canPresent?.(),
    /** Does this game get souldew's follower for you? (HeartGold/SoulSilver walk your Pokémon themselves) */
    ownFollower: () => st?.ownFollower !== false,
    /** nativeplayer: the WATCHED bytes of the picture that comes next */
    onWatched: (bytes) => st?.onWatched(bytes),
    /** nativeplayer: the DS's 3D depth in the rectangles named (MSG_DEPTH), for the picture whose bytes come next */
    onDepth: (bytes) => st?.onDepth?.(bytes),
    /** nativeplayer: the buttons as sent to the game (libretro bits) */
    input: (bits) => st?.input(bits),
    /** nativeplayer: another host runs the game now (a seamless link session began or ended) – WATCH goes out again */
    rewatch: () => st?.rewatch?.(),
    /** Is the A menu open? (the game is paused then, but the controller stays with this page) */
    menuOpen: () => !!st?.menuOpen?.(),
    /** tests / diagnostics */
    state: () => st?.debug() || null,
    /** diagnostics: trace(true) records every drawn picture's sprite positions, trace() hands them over (and clears) */
    trace: (on) => st?.trace?.(on) ?? null,
    /** tests: the picture the overlay was drawn for (the native player's last one) */
    picture: () => host.picture?.() || null,
    stop: () => st?.stop(),
  };
  window.__world = api;
  return api;
}

const UNSUPPORTED = (more = {}) => ({ t: null, setConfig() {}, partner() {}, gone() {}, emote() {}, onWatched() {}, input() {}, debug: () => ({ supported: false, ...more }), stop() {} });

async function start(host, cfg) {
  if (host.system === 'nds') return (await import('/lib/worldds.mjs')).startDs(host, cfg);
  if (host.system === 'gb' || host.system === 'gbc') return startGb(host);
  if (host.system !== 'gba') return UNSUPPORTED();
  const [{ findEntry }, addresses, rom, dex] = await Promise.all([
    import('/shared/live/parse.mjs'),
    fetch('/shared/data/addresses.json').then((r) => r.json()),
    fetch(host.romUrl).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)),
    fetch('/shared/data/gen3_index_to_dex.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const code = rom && rom.length > 0xc0 ? String.fromCharCode(...rom.subarray(0xac, 0xb0)) : cfg.code || '';
  // (with the header title: a hack that kept the base game's code – Pokémon Quetzal – has an entry of its own, without
  // a world table: its overworld isn't Emerald's, so no partners are drawn into it)
  const title = rom && rom.length > 0xc0 ? String.fromCharCode(...rom.subarray(0xa0, 0xac)).replace(/\0+$/, '') : cfg.title || '';
  const entry = findEntry(addresses, { platform: 'gba', code, title });
  const t = worldTable(entry, rom ? rom[0xbc] : 0, code);
  if (!t || !rom) return UNSUPPORTED({ code });
  return world(host, t, rom, dex);
}

/**
 * Red/Blue/Yellow and Gold/Silver/Crystal (shared/worldgb.mjs): the game by its header, its world table – for a hack
 * built from the pret disassemblies whose WRAM moved (Crystal Legacy …) with the moved addresses
 * (shared/live/romwram.mjs, the same reading the live tracker uses) – and its ROM tables checked before they're used.
 */
async function startGb(host) {
  const [{ findEntry }, { identifyRom }, { gbWramShift, shiftEntry }, { gbRomTables }, addresses, rom] = await Promise.all([
    import('/shared/live/parse.mjs'),
    import('/shared/romid.mjs'),
    import('/shared/live/romwram.mjs'),
    import('/shared/worldgb.mjs'),
    fetch('/shared/data/addresses.json').then((r) => r.json()),
    fetch(host.romUrl).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)),
  ]);
  const head = rom && rom.length > 0x150 ? identifyRom(rom.subarray(0, 0x200), host.system) : null;
  const found = head ? findEntry(addresses, { platform: head.system, code: head.code, title: head.title }) : null;
  if (!found?.world || !rom) return UNSUPPORTED({ title: head?.title });
  const anchor = found.gen === 1 ? { curMapAddr: found.world.curMapAddr } : { mapGroupAddr: found.world.mapGroupAddr };
  const shift = gbWramShift(rom, found, anchor);
  const entry = shift ? shiftEntry(found, shift) : found;
  const t0 = worldTable(entry);
  // (a hack keeps its graphics elsewhere: the tables are found again by their shape, or not used)
  const t = t0 && { ...t0, rom: gbRomTables(rom, t0), hack: !!shift };
  if (!t) return UNSUPPORTED({ title: head.title });
  return world(host, t, rom, null);
}

function world(host, t, rom, dex) {
  const style = document.createElement('style');
  style.textContent = WORLD_CSS;
  document.head.append(style);
  const layer = document.createElement('div');
  layer.className = 'sw-layer';
  const canvas = document.createElement('canvas');
  canvas.width = t.screen.w;
  canvas.height = t.screen.h;
  canvas.style.opacity = '0';
  layer.append(canvas);
  document.body.append(layer);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  let cfg = { me: null, players: {}, enabled: false, actions: {}, labels: {}, lead: null, follow: true };
  const tracks = new Map(); // slot → Track
  const avatars = new Map(); // gfx id → { w, h, frames: [canvas], anims } | null
  const anim = new Map(); // slot → { time, lastX, lastY }
  const bubbles = new Map(); // slot (or the local one) → { art, start, until, lose, draw }
  // the Pokémon following each player: their lead (from their messages; yours from the play view), its trail
  const icons = findMonIcons(rom); // (the icon tables, found by their palette tags – any language, randomized or not)
  const toInternal = dexToInternal(dex?.map);
  const iconCache = new Map();
  const leads = new Map(); // slot → { species, shiny, form } | null
  const sizes = new Map(); // slot → their map's [w, h] (a partner north or west of a connection)
  const followers = new Map(); // slot → Follower
  const ownFollower = new Follower();
  const connCache = new Map();
  let conns = null; // this map's size and connections, this picture
  let frameMap = null; // the map whose frame the followers' paths are in, and its size
  let frameSize = null;
  let fdraw = {}; // diagnostics: the followers drawn this picture
  let ownLast = null; // diagnostics: your own follower this picture
  let trace = null; // diagnostics (trace(true)): per drawn picture where each sprite went – [{ v, t, p, f, cam, me, at }]
  let traced = {}; // (this picture's: slot → [x, y] drawn, 'f:slot' its follower)
  const spriteCache = {};
  const frameCache = new Map();
  // the Game Boy games (shared/worldgb.mjs): sprites and icons as colour numbers, coloured with the palette of the moment
  const gb = t.gen <= 2;
  const gbSheets = new Map(); // gfx → { idx: [6 frames], pal } | null
  const gbIcons = new Map();
  let gbObj = null; // Gen 1: the object colours as the picture shows them (sampled from your own sprite)
  let gbPalKey = '';
  let gbOwnFollows = false; // Yellow: the game's own Pikachu walks behind you
  const learner = new OverworldLearner();
  // the game's pictures set the time everything is drawn at (shared/world.mjs PictureClock): partners and followers
  // step with the game's own sprites, not with the screen's refresh between two pictures
  const clock = new PictureClock();
  let drawT = 0; // this picture's time
  const gate = new StepGate(); // (partners step when your picture does – shared/world.mjs StepGate)
  let partT = 0; // the time partners are drawn at
  let scripted = 0; // (Gen 2: pictures in a row a script runs)
  const snap = pixelSnapper(); // (whole pixels that step evenly – shared/world.mjs wholePx)
  let watched = null; // { ranges, sb1, spriteId, bytes } – the native player's per-picture bytes
  let watchKey = '';
  let cam = null;
  let shown = 0; // opacity
  const aPress = new APress(); // walking up to a partner and pressing A
  let aTimer = 0;
  let lastState = 0;
  let raf = 0;
  let stopped = false;
  let inputBits = 0;
  let lastSprite = null; // the local player's sprite as last drawn
  let near = 0; // partners on the picture
  let lastLocalGfx = null; // the local player's avatar (for the head line of their bubble)
  // occlusion (shared/worldmap.mjs): the top layer per map layout, its tilesets decoded once; per picture the blocks
  const tops = new Map(); // layout address → mapTop | null
  const tilesets = new Map();
  let occ = null; // { blockAt, mask, layout } this picture, or null (unknown game, no map yet)
  let popup = null; // the map-name popup's rectangle this picture
  let covered = {}; // diagnostics: hidden pixels per partner slot ('me': the local player's redraw)
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');
  // the tags, the A menu and the rock-paper-scissors picker (web/lib/worldui.mjs): over the partner's tile
  const ui = createWorldUi({
    host, layer, screen: t.screen, getCfg: () => cfg,
    anchor: (slot) => {
      const p = tracks.get(slot)?.sample(partT || performance.now());
      const pos = p && cam ? screenPos(t, cam, p) : null;
      return pos ? { x: pos.x + TILE / 2, top: pos.y - 20, bottom: pos.y + TILE + 6 } : null;
    },
    canModal: () => drawable(t, cam, learner.cb2),
    onClosed: () => aPress.swallow(), // (the A that chose doesn't open it again)
  });
  const { tags, tagFor, openMenu, closeMenu } = ui;
  // playing together: partners in a battle, catches, tombstones, "come here" (web/lib/togetheroverlay.mjs)
  const tl = togetherLayer(t);
  let tg = emptyTogether();
  let tgDrawn = {};

  const toCanvas = (rgba, w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    return c;
  };
  /** Gen 1: OBP0's colours (sampled, else the original Game Boy's); Gen 2: the overworld OBJ palette of the time of day. */
  const gbPalette = (pal) => {
    if (t.gen === 1) return gbObj || DMG_OBP0.map((sh) => DMG_SHADES[sh]);
    const tod = (host.read(t.ram.timeOfDayPal, 1) || [1])[0] & 3;
    return gen2ObjPalette(rom, t, pal, tod) || DMG_OBP0.map((sh) => DMG_SHADES[sh]);
  };
  const gbAvatar = (gfx) => {
    if (!gbSheets.has(gfx)) {
      const sh = gbSheet(rom, t, ['walk', 'bike', 'surf'][gfx >> 1] || 'walk', gfx & 1);
      gbSheets.set(gfx, sh ? { idx: sheetFrames(rom, sh.off), pal: sh.pal } : null);
    }
    const s = gbSheets.get(gfx);
    if (!s) return null;
    const pal = gbPalette(s.pal);
    const key = `${gfx}:${pal.join('|')}`;
    if (!avatars.has(key)) {
      if (avatars.size > 48) avatars.clear();
      const rgba = s.idx.map((f) => paint(f, pal));
      let vtop = 16;
      for (const f of s.idx.slice(0, 3)) for (let i = 0; i < f.length; i++) if (f[i]) { vtop = Math.min(vtop, i >> 4); break; }
      avatars.set(key, { w: 16, h: 16, vtop, idx: s.idx, pal, rgba, frames: rgba.map((f) => toCanvas(f, 16, 16)), anims: GB_ANIMS });
    }
    return avatars.get(key);
  };
  const avatarFor = (gfx) => {
    if (gb) return gbAvatar(gfx);
    if (!avatars.has(gfx)) {
      const a = gen3Avatar(rom, t, gfx, spriteCache);
      // vtop: the first row with a pixel in any standing frame – the head, where the name and the bubble go
      let vtop = a ? a.h : 0;
      for (const f of a ? a.frames.slice(0, 3) : []) for (let i = 3; i < f.length; i += 4) if (f[i]) { vtop = Math.min(vtop, Math.floor((i >> 2) / a.w)); break; }
      avatars.set(gfx, a ? { ...a, vtop, rgba: a.frames, frames: a.frames.map((f) => toCanvas(f, a.w, a.h)) } : null);
    }
    return avatars.get(gfx);
  };

  /** The follower's picture for a lead { species, shiny, form }: the party icon as two canvases, or null. */
  const iconFor = (lead) => {
    if (gb) return gbIconFor(lead);
    if (!lead || !icons) return null;
    const idx = iconIndex(toInternal, lead.species, lead.form);
    if (!idx) return null;
    const key = `${idx}:${lead.species === NAT.DEOXYS ? 1 : 0}`;
    if (!iconCache.has(key)) {
      const ic = monIcon(rom, icons, idx, { deoxys: lead.species === NAT.DEOXYS, cache: iconCache });
      iconCache.set(`c:${key}`, ic ? { ...ic, rgba: ic.frames, frames: ic.frames.map((f) => toCanvas(f, ic.w, ic.h)) } : null);
    }
    return iconCache.get(`c:${key}`) || null;
  };

  /**
   * The Game Boy follower: its party menu icon from the ROM – Gen 1 one of the game's generic icons in the colours of
   * the overworld sprites, Gen 2 the Pokémon's own icon in the Pokémon's own colours (its shiny ones too).
   */
  function gbIconFor(lead) {
    if (!lead) return null;
    const ic = t.gen === 1 ? gen1Icon(rom, t, lead.species, gbIcons) : gen2Icon(rom, t, lead.species, gbIcons);
    if (!ic) return null;
    const pal = (t.gen === 2 && gen2MonPalette(rom, t, lead.species, lead.shiny)) || gbPalette(0);
    const key = `c:${lead.species}:${lead.shiny ? 1 : 0}:${pal.join('|')}`;
    if (!gbIcons.has(key)) {
      if (gbIcons.size > 64) gbIcons.clear();
      const rgba = ic.frames.map((f) => paint(f, pal));
      gbIcons.set(key, { ...ic, idx: ic.frames, rgba, frames: rgba.map((f) => toCanvas(f, ic.w, ic.h)) });
    }
    return gbIcons.get(key);
  }

  /**
   * Gen 1 colours from the picture: every overworld sprite has OBP0, so the partners look like your own sprite – on the
   * original Game Boy, in a Game Boy Color's colours for Red/Blue, in Yellow's, and through every fade.
   */
  function gbSample(read) {
    const pic = host.picture?.();
    const spr = pic && readLocalSprite(t, read);
    const me = spr && cam ? readPlayer(t, read, cam) : null;
    if (!me) return;
    const s = gbAvatar(gfxFor(t, me.kind, me.gender));
    if (!s) return;
    const at = (x, y) => {
      if (x < 0 || y < 0 || x >= pic.w || y >= pic.h) return null;
      const i = y * pic.w + x;
      if (pic.fmt === 0) return [pic.px[i * 4 + 2], pic.px[i * 4 + 1], pic.px[i * 4]];
      const v = pic.px[i * 2] | (pic.px[i * 2 + 1] << 8);
      return [Math.round(((v >> 11) * 255) / 31), Math.round((((v >> 5) & 63) * 255) / 63), Math.round(((v & 31) * 255) / 31)];
    };
    const seen = samplePalette(s.idx[spr.img], spr.flip, spr.x, spr.y, at);
    if (!seen) return;
    const base = gbObj || DMG_OBP0.map((sh) => DMG_SHADES[sh]);
    const pal = [base[0], seen[1] || base[1], seen[2] || base[2], seen[3] || base[3]];
    const key = pal.join('|');
    if (key !== gbPalKey) (gbPalKey = key), (gbObj = pal);
  }

  // ---- reading the game ---------------------------------------------------------------------------------------------
  /** Anything to draw: the partners (the switch), or just your own follower (its own switch, with a lead to show). */
  const active = () => cfg.enabled || (cfg.follow && !!cfg.lead && !!icons);
  const mirror = (addr, len) => host.read(addr, len);
  /** This picture's bytes where the native player sent them, else the memory (mirror or the browser emulator's own). */
  const reader = () => (watched?.bytes ? chainReaders(rangeReader(watched.ranges, watched.bytes), mirror) : mirror);
  function rewatch() {
    if (!host.watch) return;
    if (gb) {
      const key = `gb:${active()}`;
      if (key === watchKey) return;
      watchKey = key;
      const ranges = active() ? watchRanges(t) : [];
      watched = ranges.length ? { ranges, bytes: null, total: ranges.reduce((n, r) => n + r[1], 0) } : null;
      if (!host.watch(ranges)) watchKey = '';
      return;
    }
    const p = t.saveBlock1Ptr ? host.read(t.saveBlock1Ptr, 4) : null;
    const sb1 = t.saveBlock1 || (p && p.length === 4 ? (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0 : 0);
    const av = host.read(t.playerAvatar + 4, 2);
    const spriteId = av && av.length ? av[0] : null;
    const objId = av && av.length > 1 ? av[1] : null;
    const key = `${sb1}:${spriteId}:${objId}:${active()}`;
    if (key === watchKey) return;
    watchKey = key;
    if (!active()) {
      watched = null;
      if (!host.watch([])) watchKey = '';
      return;
    }
    const ranges = watchRanges(t, sb1 >= 0x02000000 && sb1 < 0x02040000 ? sb1 : 0, spriteId, objId);
    watched = { ranges, bytes: null, total: ranges.reduce((n, r) => n + r[1], 0) };
    if (!host.watch(ranges)) watchKey = ''; // (the game isn't running yet: again later)
  }

  // ---- drawing ----------------------------------------------------------------------------------------------------------
  function placeLayer() {
    const r = host.rect();
    if (!r || !r.width) return false;
    const s = layer.style;
    const v = [`${r.left}px`, `${r.top}px`, `${r.width}px`, `${r.height}px`];
    if (s.left !== v[0] || s.top !== v[1] || s.width !== v[2] || s.height !== v[3]) Object.assign(s, { left: v[0], top: v[1], width: v[2], height: v[3] });
    return r;
  }

  /** The top layer of the map the game shows now (built on the first picture of a map, then kept). */
  function readOcclusion(read) {
    if (gb) {
      const v = gbMapView(t, read, rom, tilesets);
      return v ? { gb: true, ...v, layout: v.key } : null;
    }
    const v = readMapView(t, read);
    if (!v) return null;
    if (!tops.has(v.layout)) {
      if (tops.size > 32) (tops.clear(), tilesets.clear());
      tops.set(v.layout, mapTop(rom, t.family, v.layout, tilesets));
    }
    const top = tops.get(v.layout);
    return top ? { blockAt: blockReader(v, read), mask: top.mask, layout: v.layout } : null;
  }

  /**
   * A sprite at picture pixels (x, y), minus what the map's top layer draws over it there (a tree top, a roof, the
   * leaves of a plant) – unless it stands on a bridge (`elev`: its elevation; such sprites are drawn above BG1).
   * `img`: the frame as a canvas, `rgba` its pixels (for the cut-out). Returns the hidden pixel count.
   */
  function drawSprite(img, rgba, w, h, x, y, flip, elev, grass = false) {
    // (the Game Boy games: only a sprite standing in tall grass, its lower half – shared/worldgb.mjs grassMask)
    const mask = !occ || !rgba ? null : occ.gb
      ? (grass && w === 16 && h === 16 ? grassMask(occ, x - t.anchor.x + cam.cx, y - t.anchor.y + cam.cy) : null)
      : !aboveTopLayer(elev | 0) ? coverMask({ x: x - t.anchor.x + cam.cx, y: y - t.anchor.y + cam.cy, w, h }, occ.blockAt, occ.mask) : null;
    if (mask) {
      const out = new ImageData(w, h);
      const d = out.data;
      let n = 0;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const i = r * w + c;
          if (mask[i]) {
            n++;
            continue;
          }
          const j = (r * w + (flip ? w - 1 - c : c)) * 4;
          d[i * 4] = rgba[j];
          d[i * 4 + 1] = rgba[j + 1];
          d[i * 4 + 2] = rgba[j + 2];
          d[i * 4 + 3] = rgba[j + 3];
        }
      }
      if (scratch.width !== w || scratch.height !== h) (scratch.width = w, scratch.height = h);
      sctx.putImageData(out, 0, 0);
      ctx.drawImage(scratch, x, y);
      return n;
    }
    if (flip) {
      ctx.save();
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    } else ctx.drawImage(img, x, y);
    return 0;
  }

  /** Is the tile under world pixels (x, y) tall grass (the Game Boy games)? */
  const grassAt = (x, y) => !!occ?.gb && occ.grassAt(Math.round(x / TILE), Math.round(y / TILE));

  let ticks = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    render(now);
  }
  /** One picture of the overlay – every animation frame, and again right when the native player shows a new picture. */
  function render(now, fresh = false) {
    traced = {};
    if (fresh) clock.picture(now, watched?.frameNo ?? null);
    drawT = clock.at(now);
    draw(drawT, fresh);
    if (trace && trace.length < 40000) {
      trace.push({ v: document.timeline?.currentTime ?? null, t: Math.round(now * 100) / 100, d: Math.round(drawT * 100) / 100, p: fresh ? 1 : 0, f: watched?.frameNo ?? null,
        cam: cam ? [cam.cx, cam.cy] : null, at: traced });
    }
  }
  function draw(now, fresh = false) {
    if (!(++ticks % 30)) rewatch();
    const read = reader();
    cam = readCamera(t, read, gb && watched?.before ? rangeReader(watched.ranges, watched.before) : null);
    partT = gate.at(now, fresh, cam?.cx, cam?.cy, cam?.map);
    if (!t.overworldCb2 && !gb) learner.feed(cam);
    if (gb) {
      // Gen 1: the colours of the moment, from your own sprite on the picture; Yellow: is its Pikachu following you?
      if (t.gen === 1 && !(ticks % 12) && drawable(t, cam)) gbSample(read);
      gbOwnFollows = gameFollower(t, read);
    }
    // this map's size and the maps connected to it (partners next door are drawn across the edge)
    conns = cam ? readConnections(t, read, rom, cam.map, connCache) : null;
    // crossing into a connected map: everything in your map's frame moves by where the old map lies in the new one –
    // the followers' paths along with it (they started again on their players, as after a door)
    if (cam && frameMap !== null && cam.map !== frameMap) {
      const o = conns && conns.map === cam.map ? inLocalFrame(conns, { map: frameMap, x: 0, y: 0 }, frameSize) : null;
      if (o) {
        ownFollower.rekey(`L${cam.map}`, o.x, o.y);
        for (const f of followers.values()) if (f.key === `L${frameMap}`) f.rekey(`L${cam.map}`, o.x, o.y);
      }
    }
    if (cam) {
      frameMap = cam.map;
      if (conns && conns.map === cam.map) frameSize = [conns.w, conns.h];
    }
    // the partners see us even while our switch is off (it says what *we* see)
    if (now - lastState >= STATE_MS - 4) { // (on the pictures' clock: every 4th picture)
      lastState = now;
      sendState(read, cfg.enabled && drawable(t, cam, learner.cb2));
    }
    const rect = placeLayer();
    // (Gold, Silver and Crystal run a script for 4–6 frames when a step ends here and there: the partners and the
    // followers blinked away each time – a script that runs on for more than 8 pictures holds the player, as before)
    if (fresh) scripted = cam?.scripted ? scripted + 1 : 0;
    const can = drawable(t, cam?.scripted && scripted <= 8 ? { ...cam, locked: false } : cam, learner.cb2);
    const me = cam ? readPlayer(t, read, cam) : null;
    // the trails go on while nothing is drawn (a menu here): the followers are where they belong when it closes
    const list = [];
    for (const [slot, tr] of tracks) {
      const conv = conns ? (st) => inLocalFrame(conns, st, sizes.get(slot)) : null;
      const s0 = tr.sample(partT, conv);
      // (a partner in a battle stays where it began, with a ⚔ – their follower is in the battle with them)
      const s = standIn(s0, tr, conv, !!tg.battles[slot]);
      const at = s && !s.hidden ? snap(slot, s.x, s.y) : null;
      const pos = can && cfg.enabled && s ? screenPos(t, cam, at ? { ...s, x: at[0], y: at[1] } : s) : null;
      list.push({ slot, s, pos });
      followTrail(slot, s0, conv ? `L${cam?.map}` : s0?.map);
    }
    // (Yellow's own Pikachu already walks behind you there: no second follower)
    const own = cfg.follow && cfg.lead && me && !followerHidden(me) && !gbOwnFollows ? ownFollower.update(`L${cam.map}`, me.x, me.y, me.facing) : null;
    if (!own) ownFollower.trail = [];
    ownLast = own;
    if (!rect || !active() || !host.ready()) {
      near = 0;
      canvas.style.opacity = '0';
      for (const el of tags.values()) el.style.opacity = '0';
      return;
    }
    const target = can ? 1 - (cam.fade || 0) / 16 : 0;
    shown = target; // (the CSS transition smooths it)
    canvas.style.opacity = String(Math.round(shown * 100) / 100);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // the followers, as sprites of their own between the others
    fdraw = {};
    const sprites = list.filter((p) => p.pos).map((p) => ({ ...p, kind: 'partner' }));
    if (can) {
      for (const p of list) {
        const f = cfg.enabled ? followers.get(p.slot)?.last : null;
        if (f && !f.hidden && p.s && !followerHidden(p.s) && (p.s.local || p.s.map === cam.map)) addFollower(sprites, p.slot, f, leads.get(p.slot), p.s.elev);
      }
      if (own && !own.hidden) addFollower(sprites, cfg.me, own, cfg.lead, me.elev);
      if (cfg.enabled) sprites.push(...tl.tombSprites(cam, conns, tg.tombs));
    }
    // the partners behind the local player first, then the player's own sprite again (only where it covers one of
    // them), then those in front: depth as in the game, by the feet's line
    const spr = can ? readLocalSprite(t, read) : null;
    // (a Game Boy draws your own sprite over every other one – it has the first OAM entries: it goes last)
    const localFeet = gb ? Infinity : spr ? spr.y + spr.h : t.anchor.y + TILE;
    // (on one line: a tombstone on the ground first, then the followers, then the players)
    const order = { tomb: 0, follower: 1 };
    const drawn = sprites.sort((a, b) => a.pos.y - b.pos.y || (order[a.kind] ?? 2) - (order[b.kind] ?? 2));
    occ = can && drawn.length ? readOcclusion(read) : null; // (nobody here: no tilesets to decode either)
    popup = can ? popupRect(t, read, popup) : null;
    covered = {};
    // the map-name popup (BG0, over everything) isn't a lock: nothing of ours is drawn on its rectangle
    ctx.save();
    if (popup) {
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(popup.x, popup.y, popup.w, popup.h);
      ctx.clip('evenodd');
    }
    let localDone = false;
    for (const p of drawn) {
      if (!localDone && p.pos.y + TILE > localFeet) {
        drawLocal(spr, drawn, me);
        localDone = true;
      }
      if (p.kind === 'follower') drawFollower(p, now);
      else if (p.kind === 'tomb') tl.drawTomb(p, drawSprite);
      else drawPartner(p, now);
    }
    if (!localDone) drawLocal(spr, drawn, me);
    // names and bubbles
    const underPopup = (x, y) => !!popup && x >= popup.x - 4 && x < popup.x + popup.w + 4 && y >= popup.y - 4 && y < popup.y + popup.h + 4;
    for (const p of list) {
      const el = tagFor(p.slot);
      if (!el) continue;
      const vis = !!p.pos && can && !underPopup(p.pos.x + TILE / 2, p.pos.y - 8);
      el.style.opacity = vis ? String(Math.round(shown * 100) / 100) : '0';
      el.style.pointerEvents = vis ? 'auto' : 'none';
      const b0 = bubbles.get(p.slot);
      // (in a battle: the ⚔ bubble stays while it lasts – an emote shows over it for its moment)
      const b = vis && b0 && now < b0.until ? b0 : vis && p.s.battling ? { art: 'battle', start: -1e9, until: Infinity } : null;
      const talking = !!b;
      const a = vis ? avatarFor(gfxFor(t, p.s.kind, p.s.gender)) : null;
      const head = vis ? p.pos.y + TILE - (a?.h || 32) + (a?.vtop || 0) + (t.spriteDy || 0) : 0;
      const pop = vis ? tg.pops.find((x) => x.slot === p.slot) : null;
      const popIc = pop ? iconFor(pop) : null;
      const lift = (talking ? 19 + (artSize(b.art)[1] - 8) : 1) + (popIc ? popIc.bottom - popIc.top + 14 : 0);
      if (vis) {
        // the name just above the head – above the bubble (and a catch) while there is one
        el.style.left = `${((p.pos.x + TILE / 2) / t.screen.w) * 100}%`;
        el.style.top = `${((head - lift) / t.screen.h) * 100}%`;
      }
      if (talking) bubble(p.slot, b, p.pos.x + TILE / 2, head - 1, now);
      if (popIc) tl.drawPop(ctx, popIc, p.pos.x + TILE / 2, head - (talking ? 17 + (artSize(b.art)[1] - 8) : 0), now - pop.atPage);
    }
    const mine = bubbles.get(cfg.me);
    if (can && mine && now < mine.until) {
      const la = lastLocalGfx !== null ? avatarFor(lastLocalGfx) : null;
      const head = spr ? spr.y + (la?.vtop || 0) : t.anchor.y - 8;
      bubble(cfg.me, mine, spr ? spr.x + spr.w / 2 : t.anchor.x + 8, head - 1, now);
    }
    // a partner's "come here": an arrow at the edge toward them (or over the spot when it's on the picture)
    tgDrawn = { ping: can && cfg.enabled && tg.ping ? tl.drawPing(ctx, cam, conns, tg.ping, cfg.players[tg.ping.slot]?.color || '#ebe6da', now) : null,
      tombs: drawn.filter((p) => p.kind === 'tomb').map((p) => p.id), battling: list.filter((p) => p.pos && p.s?.battling).map((p) => p.slot),
      pops: tg.pops.filter((x) => list.some((p) => p.pos && p.slot === x.slot)).map((x) => `${x.slot}:${x.species}`) };
    ctx.restore();
    interact(now, read, can, list);
    near = list.filter((p) => p.pos).length;
  }

  function bubble(slot, b, x, y, now) {
    // (the losing hand fades a moment after both show)
    drawBubble(ctx, x, y, cfg.players[slot]?.color || '#fff', now - b.start, b.art, !!b.lose && now - b.start > 500);
  }

  /** A partner's follower walks their (interpolated) path; it goes back onto them when they're gone or out of frame. */
  function followTrail(slot, s, key) {
    const lead = leads.get(slot);
    let f = followers.get(slot);
    if (!lead || !s || s.hidden || s.away || s.fam !== t.fam || followerHidden(s)) {
      if (f) f.last = null;
      if (f && (!s || s.hidden || s.away)) followers.delete(slot);
      return;
    }
    if (!f) followers.set(slot, (f = new Follower()));
    f.last = f.update(key, s.x, s.y, s.facing);
  }

  function addFollower(list, slot, f, lead, elev) {
    const ic = iconFor(lead);
    if (!ic) return;
    const [fx, fy] = snap(`f:${slot}`, f.x, f.y);
    const pos = { x: t.anchor.x + (fx - cam.cx), y: t.anchor.y + (fy - cam.cy) };
    if (pos.x < -48 || pos.y < -48 || pos.x > t.screen.w + 32 || pos.y > t.screen.h + 48) return;
    list.push({ kind: 'follower', slot, pos, f, ic, lead, elev });
  }

  /** A follower: the party icon standing on its tile (its lowest pixel on the tile's bottom row), facing its way. */
  function drawFollower(p, now) {
    const { ic, f } = p;
    // the icons look left: walking right they're mirrored (and so is the box their pixels fill)
    const left = f.flip ? ic.w - 1 - ic.right : ic.left;
    const right = f.flip ? ic.w - 1 - ic.left : ic.right;
    const x = Math.round(p.pos.x + TILE / 2 - (left + right + 1) / 2);
    const y = Math.round(p.pos.y + TILE - 1 - ic.bottom) + (t.spriteDy || 0);
    const fr = f.frame & 1;
    const n = drawSprite(ic.frames[fr], ic.rgba[fr], ic.w, ic.h, x, y, f.flip, p.elev, gb && grassAt(f.x, f.y));
    p.box = { x: x + left, y: y + ic.top, w: right - left + 1, h: ic.bottom - ic.top + 1 };
    fdraw[p.slot] = { species: p.lead.species, x: Math.round(p.pos.x), y: Math.round(p.pos.y), flip: f.flip, frame: fr, moving: f.moving, covered: n };
    traced[`f:${p.slot}`] = [x + left, y, fr]; // (its pixels' left edge: a mirrored icon starts elsewhere)
    // a shiny one sparkles now and then (a Gen 2 icon has its shiny colours; Gen 1 has no shiny ones)
    if (p.lead.shiny && !gb) {
      const k = (now % 2400) / 2400;
      if (k < 0.22) {
        const sx = x + right - 3 - Math.round(k * 6);
        const sy = y + ic.top - 1;
        SPARKLE.forEach((row, j) => [...row].forEach((ch, i) => {
          if (ch === '.') return;
          ctx.fillStyle = ch === 'o' ? '#ffffff' : '#ffe9a8';
          ctx.fillRect(sx + i, sy + j, 1, 1);
        }));
      }
    }
  }

  function drawPartner(p, now) {
    const s = p.s;
    const a = avatarFor(gfxFor(t, s.kind, s.gender));
    if (!a) return;
    const k = anim.get(p.slot) || { time: 0, x: s.x, y: s.y };
    const d = Math.abs(s.x - k.x) + Math.abs(s.y - k.y);
    // the animation advances with the distance walked (in the game's frames at that speed), so feet and ground match
    const speed = Math.max(1, s.speed || 1);
    if (s.moving) k.time += Math.max(d / speed, 0);
    else k.time = 0;
    k.x = s.x;
    k.y = s.y;
    anim.set(p.slot, k);
    const kind = kindFor(t, s.kind);
    const c = animFrame(a, animFor({ ...s, kind }, s.speed || 0), Math.floor(k.time));
    const i = a.frames[c.img] ? c.img : 0;
    const x = Math.round(p.pos.x + TILE / 2 - a.w / 2);
    const y = Math.round(p.pos.y + TILE - a.h) + (t.spriteDy || 0);
    covered[p.slot] = drawSprite(a.frames[i], a.rgba[i], a.w, a.h, x, y, c.flip, s.elev, gb && grassAt(s.x, s.y));
    traced[p.slot] = [x, y, i];
    p.box = { x, y, w: a.w, h: a.h };
  }

  /**
   * The local player's own sprite, again – only when a partner or a follower behind them overlaps it (their exact
   * current frame): your own follower walking behind you goes behind your legs, not over them.
   */
  function drawLocal(spr, drawn, me) {
    if (!spr) return;
    lastSprite = spr;
    const over = drawn.some((p) => p.box && (gb || p.pos.y + TILE <= spr.y + spr.h) && p.box.x < spr.x + spr.w && p.box.x + p.box.w > spr.x && p.box.y < spr.y + spr.h && p.box.y + p.box.h > spr.y);
    if (!over || !me) return;
    if (gb) {
      // the frame the game shows (its sheet, the phase, the flip) – and its lower half behind the grass like the game's
      const a = gbAvatar(gfxFor(t, me.kind, me.gender));
      if (a?.frames[spr.img]) covered.me = drawSprite(a.frames[spr.img], a.rgba[spr.img], 16, 16, spr.x, spr.y, spr.flip, 0, spr.grass);
      return;
    }
    const pal = me && avatarPalette(rom, t, gfxFor(t, me.kind, me.gender), spriteCache);
    const px = pal && liveFrame(rom, spr, pal, frameCache);
    if (!px) return;
    const key = `c:${spr.images}:${spr.animNum}:${spr.cmd}`;
    if (!frameCache.has(key)) frameCache.set(key, toCanvas(px, spr.w, spr.h));
    // (the game hides the same pixels of the real one: drawn again in full it would stand on top of a tree top)
    covered.me = drawSprite(frameCache.get(key), px, spr.w, spr.h, spr.x, spr.y, spr.flip, me.elev);
  }

  // ---- the local player for the partners --------------------------------------------------------------------------
  function sendState(read, can) {
    const me = cam ? readPlayer(t, read, cam) : null;
    if (me) lastLocalGfx = gfxFor(t, me.kind, me.gender);
    // the partners see us wherever we stand on the overworld – also while a menu or a message is open here
    // (not FR/LG's replay of your last steps after loading: those aren't where you are)
    const onOverworld = !!me && !!cam && !cam.battle && !cam.replay && cam.fade < 16 && (t.overworldCb2 || learner.cb2 ? cam.cb2 === (t.overworldCb2 || learner.cb2) : true);
    // (and the size of this map: a partner on the map north or west of it places us by it)
    const size = conns && cam && conns.map === cam.map ? [conns.w, conns.h] : null;
    // (Yellow's Pikachu walking behind you in the game: your partners see that one follow you, as you do)
    // (age: how long ago the picture these bytes belong to showed – the play view stamps the state with that moment,
    // so the partners see your steps evenly spaced however late this message goes out)
    const age = Math.max(0, Math.min(200, performance.now() - (clock.t ?? performance.now())));
    host.post({ type: 'emu-world', st: onOverworld ? { ...me, fam: t.fam } : { hidden: true, fam: t.fam }, size, drawn: can, near, age, gameLead: gbOwnFollows ? { species: 25, shiny: false, form: 0 } : null });
  }

  // ---- walking up to a partner ----------------------------------------------------------------------------------------
  const aConfirmMs = gb ? A_CONFIRM_GB_MS : A_CONFIRM_MS;
  // The browser player: the game's held keys, read with every picture. (The fast player tells the buttons themselves:
  // input() → confirmA, independent of how often pictures are drawn.)
  function interact(now, read, can, list) {
    aPress.sample(!!((cam?.keys || 0) & GBA_KEY.A), now);
    if (aPress.direct) return;
    if (ui.menu || !can) {
      aPress.cancel();
      return;
    }
    if (aPress.due(now, aConfirmMs)) tryMenu(read, cam, list);
  }

  /**
   * The fast player: A went down `aConfirmMs` ago – what the game shows right now (the newest bytes it sent, not the
   * last picture drawn: that may be older than the press) decides whether it answered the button itself.
   */
  function confirmA() {
    aTimer = 0;
    if (stopped || !aPress.pending) return;
    aPress.cancel();
    const now = performance.now();
    const fresh = host.watchedNow?.();
    const read = watched && fresh && fresh.length === 4 + watched.total ? chainReaders(rangeReader(watched.ranges, fresh.subarray(4)), mirror) : reader();
    const c = readCamera(t, read);
    if (ui.modal() || !cfg.enabled || !host.ready() || !drawable(t, c, learner.cb2)) return;
    const list = [...tracks].map(([slot, tr]) => {
      const s = tr.sample(now, conns ? (st) => inLocalFrame(conns, st, sizes.get(slot)) : null);
      return { slot, s, pos: s ? screenPos(t, c, s) : null };
    });
    tryMenu(read, c, list);
  }
  function armA() {
    clearTimeout(aTimer);
    aTimer = setTimeout(confirmA, aConfirmMs);
  }

  /** A was pressed (and the game didn't take it over): the menu of the partner faced, if one stands there. */
  function tryMenu(read, cam, list) {
    if (cam.locked) return; // the game answered the button itself (a sign, someone standing there)
    const me = readPlayer(t, read, cam);
    if (!me || me.x !== me.tx * TILE || me.y !== me.ty * TILE) return; // only standing still
    // (Yellow: its own Pikachu on that tile – the game talks to Pikachu, the partner waits)
    const pika = gb ? gameFollowerTile(t, read) : null;
    if (pika && pika[0] === me.tx + ({ 3: -1, 4: 1 }[me.facing] || 0) && pika[1] === me.ty + ({ 1: 1, 2: -1 }[me.facing] || 0)) return;
    const faced = facedPartner(t, me, list.filter((p) => p.pos).map((p) => ({ slot: p.slot, state: p.s })));
    if (faced) openMenu(faced);
  }

  raf = requestAnimationFrame(frame);
  return {
    t,
    setConfig(c) {
      cfg = { ...cfg, ...c, players: c.players || cfg.players, labels: c.labels || cfg.labels, actions: c.actions || cfg.actions };
      ui.prune();
      if (!cfg.enabled) closeMenu();
      watchKey = '';
      rewatch();
    },
    partner(slot, wire) {
      if (stopped || slot === cfg.me) return;
      const at = performance.now(); // (this page's clock – the play view's starts elsewhere)
      const s = unpackState(wire);
      if (!s) return;
      if (!tracks.has(slot)) tracks.set(slot, new Track());
      tracks.get(slot).push(s, at);
      if (trace && trace.length < 40000) trace.push({ w: wire, rx: Math.round(performance.now() * 100) / 100, slot }); // (diagnostics: what came in, when)
      // what changes seldom comes now and then: who follows them, how big their map is
      if (s.ext && 'follower' in s.ext) leads.set(slot, s.ext.follower);
      if (s.ext?.size) sizes.set(slot, s.ext.size);
    },
    gone(slot) {
      tracks.delete(slot);
      anim.delete(slot);
      followers.delete(slot);
      leads.delete(slot);
      sizes.delete(slot);
      ui.gone(slot);
    },
    emote(slot, name) {
      if (!ART[name]) return;
      const now = performance.now();
      bubbles.set(slot, { art: name, start: now, until: now + WAVE_MS });
    },
    rps(v) {
      // (the page's own clock for the countdown: the play view's runs elsewhere)
      if (v && v.phase === 'pick') v = { ...v, untilPage: performance.now() + Math.max(0, v.leftMs ?? 10000) };
      ui.rpsView(v);
    },
    together(d) {
      // (a catch's age, from the play view's clock to this page's)
      const now = performance.now();
      tg = { ...emptyTogether(), ...d, pops: (d?.pops || []).map((x) => ({ ...x, atPage: now - Math.max(0, x.age || 0) })).filter((x) => now - x.atPage < POP_MS) };
    },
    rpsRound(r) {
      const now = performance.now();
      for (const [slot, hand] of Object.entries(r?.hands || {})) {
        if (!HAND_ART[hand]) continue;
        bubbles.set(slot, { art: HAND_ART[hand], start: now, until: now + HAND_MS, lose: !!r.winner && r.winner !== slot });
      }
    },
    canPresent: () => !stopped && cfg.enabled && !!cam && drawable(t, cam, learner.cb2),
    onWatched(bytes) {
      // (bytes still on their way for the list before: another length – and a moved SaveBlock1 is checked by readCamera)
      if (!watched || !bytes || bytes.length !== 4 + watched.total) return;
      // a Game Boy shows the scroll its RAM had one frame before the picture (measured, world-e2e --frames): the
      // bytes of the frame before go with this picture
      if (gb) {
        // (by the host's frame number in front of them: a picture sent twice doesn't shift them, a frame without a
        // picture leaves the older bytes standing in)
        const f = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
        const cur = bytes.slice(4);
        if (f !== watched.frame) {
          watched.before = watched.prev ? watched.bytes : null; // (the frame before that: Gen 1's first frame of a step)
          watched.bytes = watched.prev || cur;
          watched.at = watched.prevAt ?? f;
          watched.prev = cur;
          watched.prevAt = f;
          watched.frame = f;
        }
      } else watched.bytes = bytes.subarray(4);
      watched.frameNo = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
      if (!stopped) render(performance.now(), true); // (the picture these bytes belong to is being drawn right now)
    },
    input(bits) {
      inputBits = bits >>> 0;
      // (A went down: the menu's check runs when the game had time to answer – even if no picture shows the press)
      if (aPress.input(!!(inputBits & RETRO_A), performance.now())) {
        if (ui.modal()) aPress.cancel();
        else armA();
      }
    },
    rewatch() {
      watchKey = '';
      watched = null;
      rewatch();
    },
    menuOpen: () => ui.modal(),
    trace(on) {
      if (on === true) trace = [];
      else if (on === false) trace = null;
      const out = trace;
      if (on === undefined && trace) trace = [];
      return out;
    },
    debug() {
      const now = performance.now();
      const me0 = gb && cam ? readPlayer(t, reader(), cam) : null;
      return {
        supported: true, game: t.id, enabled: cfg.enabled, follow: cfg.follow, lead: cfg.lead, cam, shown, drawable: drawable(t, cam, learner.cb2), learned: learner.cb2, perFrame: !!watched?.bytes,
        ...ui.debug(),
        bubbles: Object.fromEntries([...bubbles].filter(([, b]) => now < b.until).map(([slot, b]) => [slot, b.art])),
        local: cam ? readPlayer(t, reader(), cam) : null, sprite: lastSprite, icons: !!icons,
        followers: fdraw, own: ownLast, conns, together: tgDrawn,
        occlusion: occ ? { layout: occ.layout, covered } : null, popup,
        ...(gb ? { gb: { palette: gbObj, ownFollows: gbOwnFollows, grass: me0 && occ?.gb ? occ.grassAt(me0.tx, me0.ty) : null } } : {}),
        ranges: watched?.ranges || null,
        renders: ticks, // (tests: how often the overlay draws – the pictures it gets and the page's animation frames)
        frames: gb && watched ? { shown: watched.frame, bytes: watched.at } : null,
        partners: Object.fromEntries([...tracks].map(([slot, tr]) => {
          const conv = conns ? (st) => inLocalFrame(conns, st, sizes.get(slot)) : null;
          const s = tr.sample(now, conv);
          return [slot, { s, pos: s && cam ? screenPos(t, cam, s) : null, delay: Math.round(tr.delay), lead: leads.get(slot) ?? null }];
        })),
      };
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      ui.stop();
      clearTimeout(aTimer);
      layer.remove();
      style.remove();
      host.watch?.([]);
    },
  };
}
