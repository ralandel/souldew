// The signed souldew+ entitlement (accounts API.md §8.2, SECURITY.md §4). The service answers GET /v1/entitlements with
// plain JSON fields AND a token – a compact JWS (EdDSA / Ed25519, typ "souldew-ent+jwt") signed with the service's
// entitlement key. Only the token counts: every souldew+ decision of the app (pack key and pack access, the preview
// offer, the badges shown for the own account) is made from its VERIFIED claims, never from the JSON next to it.
//
// The public key is pinned here, like the pack keys (web/lib/cosmetics/pack/keys.mjs): the owner's entitlement key
// (souldew-accounts: node tools/keygen.mjs entitlement – the Worker's ENTITLEMENT_SIGNING_KEY), public half as base64url,
// kid k59fr__FUE5V. An entry that isn't a real key never verifies anything (fail closed), and scripts/check-pinned-keys.mjs
// stops a release while one is there. Rotation: add the new key next to the old one, ship, switch the Worker's
// ENTITLEMENT_SIGNING_KEY, drop the old one later.
//
// A development / test key is trusted only when SLS_ACCOUNTS_DEV_ENT_KEY is set AND the app is not a packaged build AND
// SLS_ACCOUNTS_URL points at a service on this computer (wrangler dev, the test fixture) – a player's installed app can
// never be talked into another key.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { accountsBase } from './contract.mjs';

export const PRODUCTION_ENTITLEMENT_KEYS = ['mP7NpP8pV7QjDJITvGFUgPNLUBjObblQQtUHWMyJjsM'];
export const ENT_TYP = 'souldew-ent+jwt';
export const ENT_AUD = 'souldew-entitlement';
/** How far the computer's clock may be off from the service's (both ways) before a token counts as expired / not yet valid. */
export const SKEW_S = 300;
const TIERS = ['none', 'supporter', 'plus', 'patron'];
const BADGES = { none: [], supporter: ['supporter'], plus: ['plus'], patron: ['plus', 'patron'] };
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/** Same key id as the Worker: the first 12 characters of base64url(SHA-256(raw public key)). */
export const kidOf = (raw) => createHash('sha256').update(raw).digest('base64url').slice(0, 12);

/** A public key as text (base64url or base64 of the raw 32 bytes) → { kid, key } or null (placeholder, wrong length). */
export function publicKey(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_+/-]{43}=?$/.test(text)) return null;
  const raw = Buffer.from(text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
  if (raw.length !== 32) return null;
  try {
    return { kid: kidOf(raw), key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }) };
  } catch {
    return null;
  }
}

/** Is this a packaged build (the installed app)? Electron says so; without it: is this file inside the app's resources? */
export function isPackagedBuild(file = fileURLToPath(import.meta.url)) {
  const res = process.resourcesPath;
  return typeof res === 'string' && !!res && file.startsWith(res);
}

/** The keys to trust: the pinned production keys, plus the dev key under the conditions at the top of this file. */
export function entitlementKeys({ env = process.env, packaged = isPackagedBuild() } = {}) {
  const keys = PRODUCTION_ENTITLEMENT_KEYS.map(publicKey).filter(Boolean);
  const dev = env.SLS_ACCOUNTS_DEV_ENT_KEY;
  if (dev && !packaged && LOOPBACK.includes(new URL(accountsBase(env)).hostname)) {
    const k = publicKey(dev);
    if (k) keys.push(k);
  }
  return keys;
}

const fail = (reason) => ({ ok: false, reason });
const json = (part) => {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Verifies an entitlement token. → { ok: true, claims } or { ok: false, reason }.
 *   keys      entitlementKeys()
 *   iss       the service's address (accountsBase) – the token's iss must be exactly it
 *   sub       the signed-in account's id; sid: this computer's session id (when the token names one, it must match)
 *   now       seconds, the reference clock (the service's Date header when online, this computer's clock offline)
 *   offline   true: a kept token re-checked without the service – `exp` (1 hour) doesn't count, `grace_until` does
 * The claims handed back are normalised: tier one of the four tiers, badges derived from the tier (§8.0), until /
 * grace_until / exp / iat in seconds (until may be null), packKeyId a string or null.
 */
export function verifyEntitlementToken(token, { keys, iss, sub, sid = null, now, offline = false, skew = SKEW_S } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return fail('format');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return fail('format');
  const header = json(parts[0]);
  if (!header || header.alg !== 'EdDSA' || header.typ !== ENT_TYP || typeof header.kid !== 'string') return fail('header');
  const key = (keys || []).find((k) => k.kid === header.kid);
  if (!key) return fail('key'); // signed with a key this app doesn't trust (or the production key isn't pinned yet)
  let good = false;
  try {
    good = cryptoVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key.key, Buffer.from(parts[2], 'base64url'));
  } catch {
    good = false;
  }
  if (!good) return fail('signature');
  const c = json(parts[1]);
  if (!c) return fail('claims');
  if (c.aud !== ENT_AUD) return fail('aud');
  if (typeof iss !== 'string' || c.iss !== iss) return fail('iss');
  if (typeof sub !== 'string' || c.sub !== sub) return fail('sub');
  if (typeof sid !== 'string' || c.sid !== sid) return fail('sid'); // issued to this computer's session, not copied from another
  if (!TIERS.includes(c.tier)) return fail('tier');
  const iat = num(c.iat);
  const exp = num(c.exp);
  const grace = num(c.grace_until);
  const until = c.until === null ? null : num(c.until);
  if (iat === null || exp === null || grace === null || (c.until !== null && until === null) || exp < iat) return fail('claims');
  if (!Number.isFinite(now)) return fail('clock');
  if (iat > now + skew) return fail('future'); // issued "later" than now: a clock far behind, or a token from elsewhere
  if (offline) {
    if (now > grace + skew) return fail('grace');
  } else if (now > exp + skew) return fail('expired');
  // the badges follow from the tier (§8.0) – a token can't carry a badge its tier doesn't give
  const badges = BADGES[c.tier].filter((b) => !Array.isArray(c.badges) || c.badges.includes(b));
  return {
    ok: true,
    claims: {
      tier: c.tier, badges, until, graceUntil: grace, iat, exp, sub: c.sub, sid: typeof c.sid === 'string' ? c.sid : null,
      packKeyId: typeof c.pack_key_id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(c.pack_key_id) ? c.pack_key_id : null,
    },
  };
}

/** The service's clock from an answer's Date header (seconds), when it is a sane date; else null. */
export function serviceClock(headers) {
  const d = Date.parse(headers?.get?.('date') || '');
  return Number.isFinite(d) ? Math.floor(d / 1000) : null;
}
