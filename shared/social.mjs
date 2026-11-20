// Accounts, profiles and friends: the checks both sides of the app use on what the accounts service sends and what
// the player types (pure functions – the local server cleans every answer of the service with them before the page
// sees it, and the page checks its input with the same rules before sending).
//
// Everything other players wrote (names, status lines, run names) is plain text: control and direction-override
// characters go, whitespace collapses, length is capped – and the page renders it as text only, never as HTML.
// Pictures come from one place only: Discord's own avatar CDN.

export const AVATAR_HOST = 'cdn.discordapp.com';
export const STATUS_MAX = 60;
export const NAME_MAX = 32;
export const TRUSTED_MAX = 80; // the old free-text "most trusted" (read only now – it is a Pokémon line, shared/trustedlines.mjs)
export const FAVORITE_MAX = 40;
export const RUN_NAME_MAX = 40;

// C0/C1 controls, zero-width and bidi override characters (they can make a name read backwards or hide text)
// eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

/**
 * A game's short name for profiles, presence and invites: without "Pokémon", the word "Version" and a subtitle after a
 * colon – but with whatever else follows "Version": "Pokémon Emerald Version" → "Emerald", "Pokémon Black Version 2" →
 * "Black 2", "Pokémon Yellow Version: Special Pikachu Edition" → "Yellow", "Pokémon Ultra Sun" → "Ultra Sun".
 */
export function shortGameName(title) {
  return String(title || '').replace(/^Pok[eé]mon\s+/i, '').replace(/:.*$/s, '').replace(/\s+Version\b/gi, '').replace(/\s+/g, ' ').trim();
}

/** Plain text of at most `max` characters (by code point) – never null. */
export function cleanText(v, max = 80) {
  if (typeof v !== 'string') return '';
  const s = v.normalize('NFC').replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim();
  return Array.from(s).slice(0, max).join('');
}

/**
 * An avatar picture the app may show, or null. Two forms only (API.md §2.9): the accounts service's own avatar proxy
 * – <service>/v1/avatars/u_<id>/<hash>.png?size=64|128|256, which keeps Discord ids away from other players – and a
 * picture straight from Discord's CDN, https://cdn.discordapp.com/avatars/<user id>/<hash>.<png|webp|gif> or a default
 * avatar (/embed/avatars/<n>.png), optionally ?size=<power of two>. Anything else (another host, a port, user info, a
 * path that leaves those folders, a data: or javascript: URL) is dropped – the page then shows the placeholder.
 * `service`: the accounts service's base URL in use (server/lib/accounts/contract.mjs accountsBase).
 */
export function safeAvatarUrl(v, service = null) {
  if (typeof v !== 'string' || v.length > 400) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => k !== 'size') || keys.length > 1) return null;
  const size = u.searchParams.get('size');
  if (u.protocol === 'https:' && u.hostname === AVATAR_HOST && !u.port) {
    const custom = /^\/avatars\/\d{5,25}\/(?:a_)?[a-f0-9]{32}\.(?:png|webp|gif|jpg)$/.test(u.pathname);
    const fallback = /^\/embed\/avatars\/\d\.png$/.test(u.pathname);
    if ((!custom && !fallback) || (size !== null && !/^(16|32|64|128|256|512|1024)$/.test(size))) return null;
    return `https://${AVATAR_HOST}${u.pathname}${size ? `?size=${size}` : ''}`;
  }
  if (!service) return null;
  let s;
  try {
    s = new URL(service);
  } catch {
    return null;
  }
  const prefix = s.pathname.replace(/\/+$/, '');
  if (u.origin !== s.origin || !u.pathname.startsWith(`${prefix}/v1/avatars/`)) return null;
  if (!/^\/v1\/avatars\/u_[A-Za-z0-9_-]{8,40}\/[A-Za-z0-9_]{6,64}\.png$/.test(u.pathname.slice(prefix.length))) return null;
  if (size !== null && !/^(64|128|256)$/.test(size)) return null;
  return `${u.origin}${u.pathname}${size ? `?size=${size}` : ''}`;
}

/** A souldew handle as typed ("@Ash_K") → "ash_k", or null (API.md §0.6: 3–20 of a–z, 0–9, _). */
export function normalizeHandle(v) {
  const s = String(v ?? '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(s) ? s : null;
}

// Crockford base32: no I, L, O, U – typed look-alikes are read as what they look like
const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
/** A friend code as typed ("sd-7k2q-m9xd", "7K2Q M9XD") → "SD-7K2Q-M9XD", or null (API.md §2.4). */
export function normalizeFriendCode(v) {
  let s = String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (s.length === 10 && s.startsWith('SD')) s = s.slice(2);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return CROCKFORD.test(s) ? `SD-${s.slice(0, 4)}-${s.slice(4)}` : null;
}

/**
 * "add by handle or friend code": what the typed text is. → { handle } | { friend_code } | null. A code is what starts
 * with SD or has a dash or space in it (codes are shown as SD-XXXX-XXXX); everything else is a handle first.
 */
export function parseFriendQuery(v) {
  const raw = String(v ?? '').trim();
  const code = normalizeFriendCode(raw);
  if (code && ((/^sd/i.test(raw) && raw.replace(/[-\s]/g, '').length === 10) || /[-\s]/.test(raw))) return { friend_code: code };
  const handle = normalizeHandle(raw);
  if (handle) return { handle };
  return code ? { friend_code: code } : null;
}

/**
 * How the profile shows its showcase (API.md §2.2 showcase_layout), the owner's choice: 'case' – a full-width display
 * case under the numbers; 'lcd' – a trainer card on the handheld's screen in the side column; 'shelf' – the compact
 * side column.
 */
export const SHOWCASE_LAYOUTS = ['case', 'lcd', 'shelf'];
export const DEFAULT_SHOWCASE_LAYOUT = 'case';
export const PROFILE_VISIBILITY = ['link', 'friends', 'nobody'];
export const PRESENCE_VISIBILITY = ['friends', 'nobody', 'offline'];
/** What a player is doing (API.md §5.1), plus what the service reports for a friend who is away. */
export const PRESENCE_STATES = ['offline', 'online', 'library', 'playing', 'in_run'];
/** The systems a presence can name: a Game Boy Color game counts as gb. */
export const presenceSystem = (sys) => ({ gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', '3ds': '3ds' }[sys] || null);
/** An accent colour of the curated palette: #rrggbb only – never anything that could end a CSS declaration. */
export const safeHex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
/**
 * The curated accent palette (profile accent colour). The accounts service's palette is generated from / checked against
 * this list (souldew-accounts tools/catalog-seed.mjs) – keys and colours must stay identical on both sides.
 */
export const ACCENTS = [
  { key: 'moss', hex: '#5f8a4e' }, { key: 'fern', hex: '#3f7d5c' }, { key: 'tide', hex: '#2f7f9e' },
  { key: 'glacier', hex: '#6fb3c9' }, { key: 'ink', hex: '#2d3a55' }, { key: 'dusk', hex: '#6b5a9e' },
  { key: 'sakura', hex: '#d9739a' }, { key: 'berry', hex: '#9b3d5c' }, { key: 'ember', hex: '#c4572f' },
  { key: 'copper', hex: '#b06a3b' }, { key: 'amber', hex: '#d49a2a' }, { key: 'slate', hex: '#5b6b7a' },
];
export const DEFAULT_ACCENT = 'moss';

// file names and paths the service refuses in run names, game titles and locations (API.md §0.6): a run named after
// its ROM ("Robin – Emerald.gba") would be rejected – such words are left out before anything is sent
const FILE_WORD = /\S*(?:[\\/]\S*|\.(?:gba|gbc|gb|nds|3ds|cia|cxi|cci|zcci|zcxi|3dsx|sav|dsv|srm|state|zip|7z|rar|xdelta|vcdiff|bps|ups|ips|json)\b)\S*/gi;
/** Plain text without file names or paths (see above), at most `max` characters. */
export const withoutFileNames = (v, max = 60) => cleanText(cleanText(v, 400).replace(FILE_WORD, ' ').replace(/\s+[–-]\s*$/, ''), max);

/** One of `list`, or `fallback`. */
export const oneOf = (v, list, fallback = null) => (list.includes(v) ? v : fallback);

/** An integer within [min, max], or null. */
export function int(v, min = 0, max = 1e9) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** A time the service sent (ms since 1970, or an ISO string) → ms, or null. Years 2020–2100 only. */
export function time(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n > 1577836800000 && n < 4102444800000 ? n : null;
}

/** An opaque id of the service (account, invite, request …): short, URL-safe – so it can go into a path as is. */
export function id(v, max = 64) {
  return typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v) ? v : null;
}
