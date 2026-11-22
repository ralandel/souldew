// Every answer of the accounts service is rebuilt here before the page sees it (API.md objects → the page's shapes):
// known fields only, each checked – texts as plain text with their contract's length, ids and catalog ids by pattern,
// times as numbers, enums from their lists. Avatars become an address of this local server (/api/account/avatar),
// which fetches only the two allowed picture sources (shared/social.mjs safeAvatarUrl) – so the page itself never
// loads anything from outside, and its CSP stays as it is.
import {
  cleanText, safeAvatarUrl, safeHex, oneOf, int, time, id as cleanId, normalizeHandle, normalizeFriendCode,
  PROFILE_VISIBILITY, PRESENCE_VISIBILITY, PRESENCE_STATES, STATUS_MAX, NAME_MAX, TRUSTED_MAX, FAVORITE_MAX, RUN_NAME_MAX,
  SHOWCASE_LAYOUTS, DEFAULT_SHOWCASE_LAYOUT,
} from '../../../shared/social.mjs';
import { SPECIES_MAX, TRUSTED_NOTE_MAX } from '../../../shared/trustedlines.mjs';

const KINDS = ['banner', 'frame', 'nameplate', 'title', 'trophy'];
// API.md §8.0: supporter = badge only; plus and patron = souldew+ (patron adds its own badge, nothing else)
const TIERS = ['none', 'supporter', 'plus', 'patron'];
const BADGES = ['supporter', 'plus', 'patron'];
/** souldew+ is tier plus OR patron (never decided from anything else). */
export const isPlusTier = (tier) => tier === 'plus' || tier === 'patron';
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/** A catalog id (banner, frame, title …): lower-case words with dashes, or null. */
export const catalogId = (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) ? v : null);
/** An invite code as the contract allows it (§6.2) – the app's own codes are 6 digits or 22 URL-safe characters. */
export const inviteCode = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v) ? v : null);

/** The local address of an avatar (or null): the page's <img> asks this server, which fetches the checked source. */
export function avatarRef(url, service) {
  const safe = safeAvatarUrl(url, service);
  return safe ? `/api/account/avatar?src=${encodeURIComponent(safe)}` : null;
}

// API.md §13: the wall's tiers, highest first (patron is shown as "Legend")
export const THANKS_TIERS = ['legend', 'plus', 'supporter', 'coffee'];
export const THANKS_MAX = 500;

/**
 * The Thank you wall (§13) → { updated, total, counts: { legend, plus, supporter, coffee }, people: [{ name, tier, since,
 * avatar, banner, frame }] }: names as plain text, avatars as this server's proxy address, looks as catalog ids, since as
 * "YYYY-MM". The total never undercounts what is listed. null when it isn't a wall at all.
 */
export function cleanThanks(v, service) {
  const o = obj(v);
  if (!o || !obj(o.counts) || !Array.isArray(o.people)) return null;
  const counts = Object.fromEntries(THANKS_TIERS.map((k) => [k, int(o.counts[k], 0, 1e7) ?? 0]));
  const people = arr(o.people, THANKS_MAX).map((x) => {
    const q = obj(x);
    const name = cleanText(q?.name, NAME_MAX);
    const tier = oneOf(q?.tier, THANKS_TIERS, null);
    if (!name || !tier) return null;
    return { name, tier, since: typeof q.since === 'string' && /^20\d\d-(0[1-9]|1[0-2])$/.test(q.since) ? q.since : null,
      avatar: avatarRef(q.avatar, service), banner: catalogId(q.banner), frame: catalogId(q.frame) };
  }).filter(Boolean);
  // a tier never shows fewer supporters than it names
  for (const k of THANKS_TIERS) counts[k] = Math.max(counts[k], people.filter((p) => p.tier === k).length);
  const sum = THANKS_TIERS.reduce((n, k) => n + counts[k], 0);
  return { updated: time(o.updated), total: Math.max(int(o.total, 0, 1e8) ?? 0, sum), counts, people };
}

const badges = (v) => [...new Set(arr(v, 8).filter((b) => BADGES.includes(b)))];

/** UserCard (§3.1) → { id, handle, name, avatar, frame, nameplate, accent, title, badges }. null without a valid id. */
export function cleanCard(u, service) {
  const o = obj(u);
  const uid = cleanId(o?.id);
  if (!uid) return null;
  return {
    id: uid,
    handle: normalizeHandle(o.handle) || '',
    name: cleanText(o.display_name, NAME_MAX) || normalizeHandle(o.handle) || '',
    avatar: avatarRef(o.avatar_url, service),
    frame: catalogId(o.frame), nameplate: catalogId(o.nameplate), accent: catalogId(o.accent), title: catalogId(o.title),
    badges: badges(o.badges),
    // a limited card (API.md §3.1: someone who isn't your friend yet, or in the block list) – shown by handle only
    ...(o.limited === true ? { limited: true } : {}),
  };
}

/**
 * "Most trusted" (§2.2): a Pokémon line – { species, line, note, teams, topLevel, fell } – or null. The numbers are null
 * when the owner doesn't share them (others only see them with "Show my runs on my profile"); all three or none.
 */
export function cleanTrusted(v) {
  const o = obj(v);
  const species = int(o?.species, 1, SPECIES_MAX);
  if (!species) return null;
  const teams = int(o.teams, 0, 10000);
  const topLevel = int(o.top_level, 1, 100);
  const fell = int(o.fell, 0, 10000);
  const numbers = teams !== null && topLevel !== null && fell !== null;
  return { species, line: int(o.line, 1, SPECIES_MAX) || species, note: cleanText(o.note, TRUSTED_NOTE_MAX) || null,
    teams: numbers ? teams : null, topLevel: numbers ? topLevel : null, fell: numbers ? fell : null };
}

function cleanShowcase(v) {
  const o = obj(v) || {};
  const trusted = cleanTrusted(o.trusted);
  return {
    trophies: [...new Set(arr(o.trophies, 3).map(catalogId).filter(Boolean))],
    trusted,
    // the old free text, before it became a line: shown as it was, kept until a line replaces it
    trustedText: trusted ? null : cleanText(typeof o.trusted === 'string' ? o.trusted : o.trusted_text, TRUSTED_MAX) || null,
    favoriteGame: cleanText(o.favorite_game, FAVORITE_MAX) || null,
  };
}

/** The showcase's layout (§2.2 showcase_layout) – 'case' when the service sends none. */
export const cleanLayout = (v) => oneOf(v, SHOWCASE_LAYOUTS, DEFAULT_SHOWCASE_LAYOUT);

const TOTALS = ['runs_started', 'runs_completed', 'runs_failed', 'soullink_runs', 'nuzlocke_runs', 'badges_earned', 'pokemon_caught', 'deaths', 'playtime_minutes'];
const camel = (k) => k.replace(/_([a-z])/g, (m, c) => c.toUpperCase());

/** Uploaded stats (§2.5) → { totals: { runsStarted, … }, recentRuns: [...] } or null. */
export function cleanStats(v) {
  const o = obj(v);
  if (!o) return null;
  const t = obj(o.totals) || {};
  const totals = Object.fromEntries(TOTALS.map((k) => [camel(k), int(t[k], 0, 10000000)]));
  const recentRuns = arr(o.recent_runs, 5).map(obj).filter(Boolean).map((r) => ({
    name: cleanText(r.name, RUN_NAME_MAX), game: cleanText(r.game, 60), mode: oneOf(r.mode, ['soullink', 'nuzlocke', 'solo'], 'soullink'),
    result: oneOf(r.result, ['active', 'won', 'lost', 'abandoned'], 'active'), badges: int(r.badges, 0, 16), deaths: int(r.deaths, 0, 100000), endedAt: time(r.ended_at),
  }));
  return { totals, recentRuns };
}

function cleanEntitlementSummary(v) {
  const o = obj(v) || {};
  return { tier: oneOf(o.tier, TIERS, 'none'), until: time(o.until), badges: badges(o.badges) };
}

/** Me (§2.1) → the own account as the page shows it. The Discord id stays out (the page has no use for it). */
export function cleanMe(v, service) {
  const o = obj(v);
  const card = cleanCard(o, service);
  if (!card) return null;
  const p = obj(o.privacy) || {};
  const d = obj(o.discord) || {};
  return {
    ...card,
    nameIsCustom: o.display_name_is_custom === true,
    discord: { username: cleanText(d.username, 40), globalName: cleanText(d.global_name, NAME_MAX) },
    friendCode: normalizeFriendCode(o.friend_code),
    banner: catalogId(o.banner),
    status: cleanText(o.status, STATUS_MAX) || null,
    showcase: cleanShowcase(o.showcase),
    showcaseLayout: cleanLayout(o.showcase_layout),
    privacy: {
      profile: oneOf(p.profile, PROFILE_VISIBILITY, 'friends'), presence: oneOf(p.presence, PRESENCE_VISIBILITY, 'friends'),
      showLocation: p.show_location === true, showRuns: p.show_runs === true, friendRequests: oneOf(p.friend_requests, ['everyone', 'nobody'], 'everyone'),
      // the Thank you wall (§2.1): null = never answered (off – the app asks a new supporter once), false, true
      showOnThanks: p.show_on_thanks === true ? true : p.show_on_thanks === false ? false : null,
    },
    // where the account stands on the Thank you wall right now (null: no live support, or a service before §13)
    thanksTier: oneOf(o.thanks_tier, THANKS_TIERS, null),
    stats: cleanStats(o.stats),
    entitlement: cleanEntitlementSummary(o.entitlement),
    // the own badges are the entitlement's (§8.0) – shown on the own profile like on everyone else's card
    badges: card.badges.length ? card.badges : cleanEntitlementSummary(o.entitlement).badges,
    locked: arr(o.locked, 5).filter((k) => ['banner', 'frame', 'nameplate', 'title'].includes(k)),
    createdAt: time(o.created_at),
  };
}

/** Another player's profile (§3.1). */
export function cleanProfile(v, service) {
  const o = obj(v);
  const card = cleanCard(o, service);
  if (!card) return null;
  return {
    ...card,
    banner: catalogId(o.banner),
    status: cleanText(o.status, STATUS_MAX) || null,
    showcase: cleanShowcase(o.showcase),
    showcaseLayout: cleanLayout(o.showcase_layout),
    stats: cleanStats(o.stats),
    relationship: oneOf(o.relationship, ['self', 'friend', 'request_sent', 'request_received', 'none'], 'none'),
    memberSince: time(o.member_since),
  };
}

export function cleanFriend(v, service) {
  const user = cleanCard(obj(v)?.user, service);
  return user ? { user, since: time(v.since) } : null;
}

export function cleanRequest(v, service) {
  const o = obj(v);
  const rid = cleanId(o?.id);
  if (!rid) return null;
  return { id: rid, from: cleanCard(o.from, service), to: cleanCard(o.to, service), createdAt: time(o.created_at), expiresAt: time(o.expires_at) };
}

const SYSTEMS = ['gb', 'gba', 'nds', '3ds'];
function cleanRunRef(v) {
  const o = obj(v);
  if (!o) return null;
  return { name: cleanText(o.name, RUN_NAME_MAX), game: cleanText(o.game, 60), mode: oneOf(o.mode, ['soullink', 'nuzlocke', 'together'], 'soullink'), system: oneOf(o.system, SYSTEMS, null) };
}

/** A friend's presence (§5.3). Away / hidden friends come as { userId, state: 'offline' }. */
export function cleanPresence(v) {
  const o = obj(v);
  const userId = cleanId(o?.user_id);
  if (!userId) return null;
  const state = oneOf(o.state, PRESENCE_STATES, 'offline');
  if (state === 'offline') return { userId, state, updatedAt: time(o.updated_at) };
  const g = obj(o.game);
  const r = obj(o.run);
  return {
    userId, state,
    game: g && (state === 'playing' || state === 'in_run') ? { title: cleanText(g.title, 60), system: oneOf(g.system, SYSTEMS, null) } : null,
    run: r && state === 'in_run' ? { name: cleanText(r.name, RUN_NAME_MAX), mode: oneOf(r.mode, ['soullink', 'nuzlocke', 'together'], 'soullink'), freeSlot: r.free_slot === true, joinable: r.joinable === true } : null,
    location: cleanText(o.location, 40) || null,
    updatedAt: time(o.updated_at),
  };
}

const INVITE_STATUS = ['pending', 'accepted', 'declined', 'cancelled', 'expired'];
/** An invite (§6.1). `code` only where the contract hands it out (the sender's view, the accept answer). */
export function cleanInvite(v, service, code = null) {
  const o = obj(v);
  const iid = cleanId(o?.id);
  if (!iid) return null;
  const out = {
    id: iid, from: cleanCard(o.from, service), run: cleanRunRef(o.run), status: oneOf(o.status, INVITE_STATUS, 'pending'),
    createdAt: time(o.created_at), expiresAt: time(o.expires_at),
    recipients: arr(o.recipients, 8).map((r) => ({ user: cleanCard(obj(r)?.user, service), status: oneOf(obj(r)?.status, INVITE_STATUS, 'pending') })).filter((r) => r.user),
  };
  const c = inviteCode(code ?? o.invite_code);
  if (c) out.code = c;
  return out;
}

export function cleanJoinRequest(v, service) {
  const o = obj(v);
  const jid = cleanId(o?.id);
  if (!jid) return null;
  return {
    id: jid, from: cleanCard(o.from, service), to: cleanCard(o.to, service), status: oneOf(o.status, INVITE_STATUS, 'pending'),
    inviteId: cleanId(o.invite_id), createdAt: time(o.created_at), expiresAt: time(o.expires_at),
  };
}

/** The catalog (§2.8): cosmetics by kind and tier, and the accent palette (#rrggbb only). */
export function cleanCatalog(v) {
  const o = obj(v) || {};
  return {
    cosmetics: arr(o.cosmetics, 2000).map(obj).filter(Boolean).map((c) => ({ kind: oneOf(c.kind, KINDS, null), id: catalogId(c.id), tier: oneOf(c.tier, ['free', 'supporter', 'plus'], 'plus') }))
      .filter((c) => c.kind && c.id),
    accents: arr(o.accents, 64).map(obj).filter(Boolean).map((a) => ({ key: catalogId(a.key), hex: safeHex(a.hex) })).filter((a) => a.key && a.hex),
  };
}

const B64URL = /^[A-Za-z0-9_-]+$/;
/** §8.6: the 7-day souldew+ trial – available | running (until) | used (until) | unavailable (reason); null when absent. */
export function cleanTrial(v) {
  const t = obj(v);
  const state = oneOf(t?.state, ['available', 'running', 'used', 'unavailable'], null);
  if (!state) return null;
  const until = time(t.until);
  if ((state === 'running' || state === 'used') && !until) return null;
  return { state, days: int(t.days, 1, 31) ?? 7, until: state === 'running' || state === 'used' ? until : null, reason: oneOf(t.reason, ['member', 'had_plus', 'account_age'], null) };
}
/** Entitlements (§8.2) – the token and pack key go to the page only through getPackAccess() (web/lib/account.mjs). */
export function cleanEntitlements(v) {
  const o = obj(v) || {};
  return {
    ...cleanEntitlementSummary(o),
    // (an unknown future kind still counts as a source – it reads as 'bmc', as 3.0.0 did with 'trial')
    sources: arr(o.sources, 10).map(obj).filter(Boolean).map((s) => ({ kind: oneOf(s.kind, ['bmc', 'grant', 'discord', 'trial'], 'bmc'), tier: oneOf(s.tier, TIERS, 'none'), status: cleanText(s.status, 20) || null, until: time(s.until) })),
    token: typeof o.token === 'string' && o.token.length < 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(o.token) ? o.token : null,
    packKey: typeof o.pack_key === 'string' && o.pack_key.length === 43 && B64URL.test(o.pack_key) ? o.pack_key : null,
    packKeyId: typeof o.pack_key_id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(o.pack_key_id) ? o.pack_key_id : null,
    offlineGraceDays: int(o.offline_grace_days, 0, 60) ?? 7,
    // §10.4: the running live theme preview, or null
    preview: obj(o.preview) && /^pv_[A-Za-z0-9_-]{22}$/.test(o.preview.id || '') && catalogId(o.preview.pack_id) && time(o.preview.expires_at)
      ? { id: o.preview.id, packId: o.preview.pack_id, expiresAt: time(o.preview.expires_at) } : null,
    trial: cleanTrial(o.trial),
  };
}
