// "Your handheld": the device in your own launch animation – one skin ("wrap") for every device, stickers per device,
// up to 12 saved designs and "Surprise me at start". Nobody else ever sees it (it isn't on the profile, the server checks
// nothing), so it is a local setting: config.json `handheld`, written through POST /api/config like the launch animation.
// The pure rules live here so the server (which keeps the shape only), the page (web/views/handheld.mjs) and the launch
// (web/views/launchstage.mjs) share them, and test/handheld.test.mjs checks them without a page.
//
// The catalog below is PUBLIC data (names, tiers, finishes – what a locked card says). The art isn't: the free and earned
// stickers and the free Plain Dusk wrap ship with the app (web/assets/handheld/, web/lib/handheld/wrap.mjs); the
// souldew+ stickers and wraps arrive in the souldew+ pack like the banners (web/lib/cosmetics/README.md).

/** The four handhelds that keep their own stickers. A GB Color plays with the GB's stickers. */
export const HH_DEVICES = ['gba', 'nds', '3ds', 'gb'];
export const devKey = (sys) => (sys === 'gbc' ? 'gb' : HH_DEVICES.includes(sys) ? sys : null);

export const STICKER_MAX = 8; // per device
export const DESIGN_MAX = 12;
export const SCALE_MIN = 0.7;
export const SCALE_MAX = 1.6;
export const NAME_MAX = 28;
export const HH_BYTES_MAX = 32 * 1024;
const U_MAX = 120; // mm from a face's centre – no face is that big, the clamp only keeps junk out

/** The launch animation family (design round 4): the free look and the souldew+ ones. Rare start isn't a pick. */
export const LAUNCH_LOOKS = [
  { id: 'your-colours', tier: 'free', look: 'theme' },
  { id: 'clear-shell', tier: 'plus', look: 'clear' },
  { id: 'gold', tier: 'plus', look: 'gold', cart: 'gold' },
  { id: 'holo', tier: 'plus', look: 'theme', cart: 'holo' },
];
export const LAUNCH_DEFAULT = 'your-colours';
/** Full ≈ 2.9 s, Quick 1.4 s, Off: no launch animation. */
export const LAUNCH_PACES = ['full', 'quick', 'off'];
export const CLEAR_TINTS = { atomic: '#7a55d6', smoke: '#3b3b46', ice: '#a9d8f2', jungle: '#5e9a4c' };
/** One start in this many is a Rare start for members. */
export const RARE_ODDS = 64;

/** Any stored launchAnimation (the 2.x cartridge, the earlier souldew+ animations, junk) → a family id. */
export const cleanLaunchLook = (v) => (LAUNCH_LOOKS.some((l) => l.id === v) ? v : LAUNCH_DEFAULT);
export const cleanLaunchPace = (v) => (LAUNCH_PACES.includes(v) ? v : 'full');
export const cleanClearTint = (v) => (CLEAR_TINTS[v] ? v : 'atomic');
export const launchLook = (id) => LAUNCH_LOOKS.find((l) => l.id === id) || LAUNCH_LOOKS[0];

// ---- what each membership gets (owner's decision, 18.11.26) -------------------------------------------------------------
// free (signed out, or no paid tier): the 2D launch animation (the module slides into the console – views/cartinsert.mjs),
//   On / Off; no 3D launch, no "Your handheld" in the library. The handheld only shows on the souldew+ page.
// supporter (tier 1): the 3D launch in "Your colours", Full / Quick / Off; "Your handheld" with the free skin (Plain Dusk),
//   the 11 free stickers, the earned ones once their trophy is there, and ONE saved design. No souldew+ skins, stickers,
//   finishes or shells (Gold / Clear / Holo), no Rare start, no Surprise me.
// member (souldew+, and the Legend – the same plus a badge): everything. souldew+ ITEMS still need the pack on this
//   computer (its art is in it): `plus` is the pack's word, `tier` the account's.
// A membership that ends or drops keeps every setting: the launch plays what the tier allows now, the rest waits.

/** The account tier ('none' | 'supporter' | 'plus' | 'patron', verified) → the launch tier: 'free' | 'supporter' | 'member'. */
export function launchTier({ signedIn = false, tier = 'none', entitled = false } = {}) {
  if (entitled) return 'member'; // the souldew+ pack is loaded and verified – that is souldew+ whatever else is known
  if (!signedIn) return 'free';
  if (tier === 'plus' || tier === 'patron') return 'member';
  return tier === 'supporter' ? 'supporter' : 'free';
}

/**
 * What a launch tier may use → { tier, three (the 3D launch and "Your handheld"), plus (souldew+ skins, stickers,
 * finishes, shells – needs the pack too), rare (the 1-in-64 Rare start – automatic, no setting), surprise (Surprise me at start), designMax,
 * earned (earned stickers play – they are 3D only) }.
 */
export function launchRights(tier, { entitled = false } = {}) {
  const t = ['free', 'supporter', 'member'].includes(tier) ? tier : 'free';
  const member = t === 'member';
  return {
    tier: t, three: t !== 'free', plus: member && !!entitled, rare: member, surprise: member,
    designMax: member ? DESIGN_MAX : t === 'supporter' ? 1 : 0, earned: t !== 'free',
  };
}

/** The look a launch tier plays: a souldew+ look without souldew+ plays "Your colours" (the choice is kept). */
export const playableLookFor = (id, rights) => (launchLook(id).tier === 'plus' && !rights?.plus ? LAUNCH_DEFAULT : launchLook(id).id);

export const FINISHES = { vinyl: { plus: false }, holo: { plus: true }, glitter: { plus: true } };

/**
 * The 54 stickers: 11 free, 40 souldew+, 3 earned. tier: free | plus | earned (free for everyone who has the trophy, never
 * sold). size: s (clusters) | m | l (a lid or a GBA back; a double cell in the editor). finishes: the ones that suit the
 * design (vinyl for all; holo / glitter are souldew+ – a free sticker in holo is a souldew+ finish). Rounds 1–6 are the
 * cute and cosy ones; round 7 (RIP … Finish Flag, set: 'fun') the cool and funny ones for the Nuzlocke / SoulLink / stream
 * crowd – the editor shows the souldew+ ones as two groups by set, so 40 stay easy to look through.
 */
export const STICKERS = [
  { id: 'heart', name: 'Pixel Heart', tier: 'free', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'moon', name: 'Night Moon', tier: 'free', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'sparkle', name: 'Sparkle', tier: 'free', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'logo', name: 'souldew', tier: 'free', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'star', name: 'Tiny Star', tier: 'free', size: 's', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'dot', name: 'Dot', tier: 'free', size: 's', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'dew', name: 'Dew Drop', tier: 'free', size: 's', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'cloud', name: 'Cloud', tier: 'free', size: 'm', finishes: ['vinyl'] },
  { id: 'rip', name: 'RIP', set: 'fun', tier: 'free', size: 'm', finishes: ['vinyl'] },
  { id: 'one-hp', name: '1 HP', set: 'fun', tier: 'free', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'gg', name: 'GG', set: 'fun', tier: 'free', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'crescent', name: 'Crescent', tier: 'plus', size: 's', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'train', name: 'Night Train', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'campfire', name: 'Campfire', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'jar', name: 'Firefly Jar', tier: 'plus', size: 'm', finishes: ['vinyl', 'glitter'] },
  { id: 'blossom', name: 'Blossom', tier: 'plus', size: 'm', finishes: ['vinyl', 'glitter'] },
  { id: 'lighthouse', name: 'Lighthouse', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'aurora', name: 'Aurora', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'mushroom', name: 'Glow Cap', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'owl', name: 'Owl', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'plane', name: 'Paper Plane', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'mug', name: 'Cocoa', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'cat', name: 'Sleeping Cat', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'lantern', name: 'Lantern', tier: 'plus', size: 'm', finishes: ['vinyl', 'glitter'] },
  { id: 'rainbow', name: 'Rainbow', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'comet', name: 'Comet', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'snowflake', name: 'Snowflake', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'gem', name: 'Crystal', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'compass', name: 'Compass', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'ridge', name: 'Night Ridge', tier: 'plus', size: 'l', finishes: ['vinyl'] },
  { id: 'campsite', name: 'Campsite', tier: 'plus', size: 'l', finishes: ['vinyl'] },
  { id: 'pennant', name: 'souldew Pennant', tier: 'plus', size: 'l', finishes: ['vinyl', 'holo'] },
  { id: 'pennant-s', name: 'souldew Pennant, short', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'patch', name: 'Dawn Patch', tier: 'plus', size: 'l', finishes: ['vinyl'] },
  { id: 'skill-issue', name: 'Skill Issue', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'rng', name: 'Snake Eyes', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'crit', name: 'Crit!', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'blow', name: 'Blow On It', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'grass', name: 'Touch Grass', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'duck', name: 'Rubber Duck', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl', 'glitter'] },
  { id: 'shades', name: 'Cool Skull', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'flame-skull', name: 'Flame Skull', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'bolt', name: 'Bolt', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'hardcore', name: 'Hardcore', set: 'fun', tier: 'plus', size: 'l', finishes: ['vinyl'] },
  { id: 'arcade', name: 'Arcade Stick', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'floppy', name: 'Floppy', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'glitch', name: 'Glitch', set: 'fun', tier: 'plus', size: 'l', finishes: ['vinyl', 'holo'] },
  { id: 'stripe', name: 'souldew Racing Stripe', set: 'fun', tier: 'plus', size: 'l', finishes: ['vinyl', 'holo'] },
  { id: 'verified', name: 'Verified Nuzlocker', set: 'fun', tier: 'plus', size: 'l', finishes: ['vinyl', 'holo', 'glitter'] },
  { id: 'live', name: 'LIVE', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'flag', name: 'Finish Flag', set: 'fun', tier: 'plus', size: 'm', finishes: ['vinyl'] },
  { id: 'thread', name: 'Red Thread', tier: 'earned', trophy: 'winSoulLink', size: 'm', finishes: ['vinyl', 'holo'] },
  { id: 'signpost', name: 'Long Road', tier: 'earned', trophy: 'badges16', size: 'm', finishes: ['vinyl'] },
  { id: 'laurel', name: 'Laurel', tier: 'earned', trophy: 'deathlessWin', size: 'm', finishes: ['vinyl', 'glitter'] },
];
export const stickerById = (id) => STICKERS.find((s) => s.id === id) || null;
/** a sticker's set: 'cosy' (rounds 1–6) | 'fun' (round 7, the cool and funny ones) */
export const stickerSet = (s) => (s?.set === 'fun' ? 'fun' : 'cosy');

/** The skins: each one IS a banner (its art comes from the banner engine), printed as satin or gloss vinyl. */
export const WRAPS = [
  { id: 'plain-dusk', name: 'Plain Dusk', banner: 'plain-dusk', tier: 'free', finish: 'satin' },
  { id: 'night-train', name: 'The Night Train', banner: 'night-train', tier: 'plus', finish: 'satin' },
  { id: 'aurora-fjord', name: 'Aurora Fjord', banner: 'aurora-fjord', tier: 'plus', finish: 'gloss' },
  { id: 'cherry-orchard', name: 'Cherry Orchard', banner: 'cherry-orchard', tier: 'plus', finish: 'satin' },
  { id: 'firefly-meadow', name: 'Firefly Meadow', banner: 'firefly-meadow', tier: 'plus', finish: 'satin' },
  { id: 'golden-wheat', name: 'Golden Wheat', banner: 'golden-wheat', tier: 'plus', finish: 'satin' },
  { id: 'coral-shelf', name: 'Coral Shelf', banner: 'coral-shelf', tier: 'plus', finish: 'gloss' },
];
export const wrapById = (id) => WRAPS.find((w) => w.id === id) || null;

/** The four things you earn instead of buy – each tied to one hard trophy (shared/trophies.mjs ids). */
export const UNLOCKS = [
  { kind: 'banner', id: 'summit-dawn', name: 'Summit Dawn', trophy: 'hardcoreWin' },
  { kind: 'sticker', id: 'thread', name: 'Red Thread', trophy: 'winSoulLink' },
  { kind: 'sticker', id: 'signpost', name: 'Long Road', trophy: 'badges16' },
  { kind: 'sticker', id: 'laurel', name: 'Laurel', trophy: 'deathlessWin' },
];

/** The faces a sticker can sit on, per device (web/lib/handheld/geometry.mjs builds them). */
export const REGIONS = {
  nds: ['lid:top', 'lid:bottom', 'deck:top', 'base:bottom'],
  '3ds': ['lid:top', 'lid:bottom', 'deck:top', 'base:bottom'],
  gba: ['body:top', 'body:bottom', 'cover:bottom'],
  gb: ['body:top', 'body:bottom', 'cover:bottom'],
};

const num = (v, lo, hi, d = 0) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const round = (v, k = 1000) => Math.round(v * k) / k;
/** an angle in (−π, π] */
const angle = (r) => {
  if (!Number.isFinite(r)) return 0;
  let a = r % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return round(a, 10000);
};

/** One placed sticker → its clean form, or null (unknown id, a face this device hasn't, a finish it doesn't come in). */
export function cleanSticker(st, dev) {
  if (!st || typeof st !== 'object') return null;
  const s = stickerById(st.id);
  if (!s || !REGIONS[dev]?.includes(st.region)) return null;
  const U = Array.isArray(st.U) ? st.U : [];
  return {
    id: s.id,
    finish: s.finishes.includes(st.finish) ? st.finish : 'vinyl',
    region: st.region,
    U: [round(num(Number(U[0]), -U_MAX, U_MAX)), round(num(Number(U[1]), -U_MAX, U_MAX))],
    rot: angle(Number(st.rot)),
    scale: round(num(Number(st.scale), SCALE_MIN, SCALE_MAX, 1), 1000),
  };
}

/** { gba: [...], nds: [...], … } – known devices only, at most STICKER_MAX each (the first ones stuck on stay). */
export function cleanLayout(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const dev of HH_DEVICES) {
    const list = Array.isArray(raw[dev]) ? raw[dev].map((x) => cleanSticker(x, dev)).filter(Boolean).slice(0, STICKER_MAX) : [];
    if (list.length) out[dev] = list;
  }
  return out;
}

const cleanSkin = (v) => (wrapById(v) ? v : null);
const DESIGN_ID = /^d[a-z0-9]{1,23}$/;
const cleanName = (v, fallback) => {
  // eslint-disable-next-line no-control-regex -- control characters are what it removes
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return Array.from(s).slice(0, NAME_MAX).join('') || fallback;
};

function cleanDesign(d, i) {
  if (!d || typeof d !== 'object' || !DESIGN_ID.test(d.id)) return null;
  return { id: d.id, name: cleanName(d.name, `Design ${i + 1}`), skin: cleanSkin(d.skin), stickers: cleanLayout(d.stickers), at: Number.isFinite(d.at) ? d.at : 0 };
}

/** An empty handheld: the theme colour, no stickers, no designs. */
export const emptyHandheld = () => ({ v: 1, skin: null, stickers: {}, designs: [], active: null, surprise: false });

/**
 * Anything (config.json, a POST body, an imported file) → a clean handheld: known ids only, ≤ 8 stickers per device,
 * ≤ 12 designs with unique ids, numbers clamped. Older shapes migrate: the design sketch's per-handheld `favourites`
 * move out (they belong in config `favourites`, see `migrateFavourites`), a missing version is version 1.
 * Too big after cleaning (it can't be, with the limits – but a hand-edited file might try): the designs go first.
 */
export function cleanHandheld(raw) {
  const out = emptyHandheld();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  out.skin = cleanSkin(raw.skin);
  out.stickers = cleanLayout(raw.stickers);
  const seen = new Set();
  out.designs = (Array.isArray(raw.designs) ? raw.designs : []).map(cleanDesign).filter((d) => d && !seen.has(d.id) && seen.add(d.id)).slice(0, DESIGN_MAX);
  out.active = out.designs.some((d) => d.id === raw.active) ? raw.active : null;
  out.surprise = raw.surprise === true;
  while (JSON.stringify(out).length > HH_BYTES_MAX && out.designs.length) out.designs.pop();
  if (!out.designs.some((d) => d.id === out.active)) out.active = null;
  return out;
}

/** The design sketch kept favourites inside the handheld; they go to config `favourites` (one object for every kind). */
export function migrateFavourites(raw, favourites = {}) {
  const old = raw?.favourites;
  if (!old || typeof old !== 'object') return favourites;
  const out = { ...favourites };
  for (const kind of ['skin', 'sticker', 'design']) {
    if (!Array.isArray(old[kind])) continue;
    out[kind] = [...new Set([...(out[kind] || []), ...old[kind].filter((x) => typeof x === 'string')])];
  }
  return out;
}

// ---- ownership ------------------------------------------------------------------------------------------------------

/** { member, trophies: Set of trophy ids | null (unknown: an earned sticker plays) } → can this sticker play? */
export function ownsSticker(s, { member = false, trophies = null } = {}) {
  if (!s) return false;
  if (s.tier === 'free') return true;
  if (s.tier === 'plus') return !!member;
  return !trophies || trophies.has(s.trophy);
}
export const ownsWrap = (w, { member = false } = {}) => !!w && (w.tier === 'free' || !!member);

// ---- the editor's sheet -------------------------------------------------------------------------------------------------
// The filter row (All · ★ Favourites · Owned · souldew+ · Earned – shared/favourites.mjs filterChips) runs over the skins and
// the stickers together; the stickers then show in four groups: free, the souldew+ ones in their two sets, earned.

/** every skin and sticker with what the filter row asks of it: { ...item, kind, owned, plus, earned } */
export function sheetItems(own = {}) {
  return [
    ...WRAPS.map((w) => ({ ...w, kind: 'skin', owned: ownsWrap(w, own), plus: w.tier === 'plus', earned: false })),
    ...STICKERS.map((s) => ({ ...s, kind: 'sticker', owned: ownsSticker(s, own), plus: s.tier === 'plus', earned: s.tier === 'earned' })),
  ];
}
/** the chip counts for filterChips */
export const sheetCounts = (items, isFav) => ({
  all: items.length, favs: items.filter(isFav).length, owned: items.filter((x) => x.owned).length, plus: items.filter((x) => x.plus).length, earned: items.filter((x) => x.earned).length,
});
/** does an item show under this filter? */
export const sheetPass = (it, filter, isFav) => filter === 'all' || (filter === 'favs' && isFav(it)) || (filter === 'owned' && it.owned) || (filter === 'plus' && it.plus) || (filter === 'earned' && it.earned);

export const STICKER_GROUPS = ['free', 'plus-cosy', 'plus-fun', 'earned'];
export const stickerGroup = (s) => (s.tier === 'plus' ? `plus-${stickerSet(s)}` : s.tier);
/** the stickers that show → [{ key, list }] in the sheet's order, empty groups left out */
export const groupStickers = (list) => STICKER_GROUPS.map((key) => ({ key, list: list.filter((s) => stickerGroup(s) === key) })).filter((g) => g.list.length > 0);

/**
 * What a design (or the current look) holds that this account can't play right now – it stays in the design:
 * { plus: souldew+ skin / stickers / finishes, earned: earned stickers whose trophy is missing, empty: devices without
 * stickers (they play bare) }.
 */
export function designNotes(d, { member = false, trophies = null } = {}) {
  const sk = wrapById(d?.skin);
  const all = Object.values(d?.stickers || {}).flat();
  const plus = (sk?.tier === 'plus' && !member ? 1 : 0)
    + (member ? 0 : all.filter((x) => stickerById(x.id)?.tier === 'plus' || FINISHES[x.finish]?.plus).length);
  const earned = all.filter((x) => { const s = stickerById(x.id); return s?.tier === 'earned' && trophies && !trophies.has(s.trophy); }).length;
  const empty = HH_DEVICES.filter((k) => !(d?.stickers?.[k] || []).length);
  return { plus, earned, empty };
}

/**
 * What the launch plays: the look itself, or – with "Surprise me at start" and two designs or more – one saved design at
 * random (only the ★ ones once any are starred: `favDesigns`). Then only what this account owns: a souldew+ skin falls
 * back to the theme colour, souldew+ stickers drop out, holo / glitter become vinyl, an earned sticker plays once its
 * trophy is there. A device without stickers in that design plays bare. The design itself keeps everything.
 * → { skin: id | null, stickers: { dev: [...] }, design: id | null }
 */
export function lookToPlay(doc, { member = false, trophies = null, favDesigns = [], rnd = Math.random, surprise = true } = {}) {
  const h = cleanHandheld(doc);
  let src = h;
  let design = h.active;
  // `surprise`: may this account use Surprise me (souldew+)? Without it the look on the device plays – the switch is kept
  if (surprise && h.surprise && h.designs.length > 1) {
    const fav = h.designs.filter((d) => favDesigns.includes(d.id));
    const pool = fav.length ? fav : h.designs;
    src = pool[Math.floor(rnd() * pool.length) % pool.length];
    design = src.id;
  }
  const own = { member, trophies };
  const skin = ownsWrap(wrapById(src.skin), own) ? src.skin : null;
  const stickers = {};
  for (const [k, list] of Object.entries(src.stickers || {})) {
    const l = list.filter((st) => ownsSticker(stickerById(st.id), own)).map((st) => (FINISHES[st.finish]?.plus && !member ? { ...st, finish: 'vinyl' } : st));
    if (l.length) stickers[k] = l;
  }
  return { skin, stickers, design };
}

// ---- saved designs ----------------------------------------------------------------------------------------------------
// Every operation takes the handheld and returns a new one (the old is left alone) – the editor keeps the old ones for
// Undo. `now` and `id` are passed in so the tests are deterministic.

export const newDesignId = (now = Date.now(), rnd = Math.random) => `d${now.toString(36)}${Math.floor(rnd() * 1296).toString(36)}`.slice(0, 24);
const lookOf = (d) => JSON.stringify([d.skin || null, cleanLayout(d.stickers)]);
/** Has the look changed since the worn design was saved? */
export const designDirty = (h) => { const a = h.designs.find((d) => d.id === h.active); return !!a && lookOf(a) !== lookOf(h); };

/** "Save this look" / "Save as new": a new design from the current look, worn at once. null when `max` (12; a
 * Supporter: 1) are saved – designs kept from an earlier membership stay, they only stop new ones. */
export function saveAsNew(h, { name, id = newDesignId(), now = Date.now(), max = DESIGN_MAX } = {}) {
  if (h.designs.length >= Math.min(max, DESIGN_MAX)) return null;
  const d = { id, name: cleanName(name, `Design ${h.designs.length + 1}`), skin: h.skin, stickers: cleanLayout(h.stickers), at: now };
  return { ...h, designs: [...h.designs, d], active: d.id };
}
/** "Save changes to …": the worn design takes the current look. */
export function overwriteDesign(h, { now = Date.now() } = {}) {
  if (!h.designs.some((d) => d.id === h.active)) return h;
  return { ...h, designs: h.designs.map((d) => (d.id === h.active ? { ...d, skin: h.skin, stickers: cleanLayout(h.stickers), at: now } : d)) };
}
export function renameDesign(h, id, name) {
  const nm = cleanName(name, '');
  if (!nm) return h;
  return { ...h, designs: h.designs.map((d) => (d.id === id ? { ...d, name: nm } : d)) };
}
/** A copy right after the original, worn at once. null when 12 are saved. */
export function duplicateDesign(h, id, { copyName = (n) => `${n} copy`, newId = newDesignId(), now = Date.now(), max = DESIGN_MAX } = {}) {
  if (h.designs.length >= Math.min(max, DESIGN_MAX)) return null;
  const i = h.designs.findIndex((d) => d.id === id);
  if (i < 0) return h;
  const c = { ...h.designs[i], id: newId, name: cleanName(copyName(h.designs[i].name), h.designs[i].name), at: now };
  return { ...h, designs: [...h.designs.slice(0, i + 1), c, ...h.designs.slice(i + 1)], active: c.id, skin: c.skin, stickers: c.stickers };
}
/** Delete (the editor offers Undo with the old handheld). The look on the device stays as it is. */
export function deleteDesign(h, id) {
  const designs = h.designs.filter((d) => d.id !== id);
  return { ...h, designs, active: h.active === id ? null : h.active, surprise: designs.length > 1 ? h.surprise : false };
}
/** Put a design on: its skin and every device's stickers (a device it has none for is left bare). */
export function applyDesign(h, id) {
  const d = h.designs.find((x) => x.id === id);
  if (!d) return h;
  return { ...h, skin: d.skin, stickers: cleanLayout(d.stickers), active: d.id };
}

// ---- export / import -------------------------------------------------------------------------------------------------

export const HH_FILE_KIND = 'souldew-handheld';
/** The look as a small file (skin, stickers, designs, Surprise me) – no favourites, nothing else of the config. */
export const exportHandheld = (h) => ({ kind: HH_FILE_KIND, v: 1, handheld: cleanHandheld(h) });
/** A file's text → a clean handheld, or null when it isn't one. Unknown ids are dropped (a newer app's stickers). */
export function importHandheld(text) {
  if (typeof text !== 'string' || text.length > HH_BYTES_MAX * 2) return null;
  try {
    const j = JSON.parse(text);
    if (!j || j.kind !== HH_FILE_KIND || !j.handheld) return null;
    return cleanHandheld(j.handheld);
  } catch {
    return null;
  }
}
