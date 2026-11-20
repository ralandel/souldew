// A SoulLink's rules are the host's call (2.8.2): the player who created the run sets them for everyone, and only they
// can change them later. "Host" is the computer that created the run – its manifest isn't `imported` – and the run
// names the host's player (`host`, older runs: p1).
//
// The rules live in the shared run document (web/lib/doc.mjs), where every player can write every key. So the host
// signs them: at creation the host's computer gets an Ed25519 key pair for the run (server/lib/hostkey.mjs – the
// private key stays in the run folder), the public key travels in the run pack (`hostKey`, next to `host`), and the
// doc's `rules` value carries `rev` (the doc timestamp it was written at) and `sig`. Every 2.8.2 app takes a `rules`
// entry from the link only with a valid signature of the run's host for exactly that timestamp (web/lib/hostrules.mjs)
// – a change from another player, a 2.8.1 app or a forged update is dropped, and a signed value replayed under a newer
// timestamp is too. Runs from before: the host's 2.8.2 app makes the key when it first opens the run, signs the rules
// as they stand and announces the key in the doc (`run:host`), where the others pick it up once.
//
// Older apps read the pack as before (they ignore `host`/`hostKey` and the two extra fields in the rules): no new pack
// format.
import { ALL_SLOTS, runMode } from './slots.mjs';
import { DEFAULT_RULES, NEW_RUN_RULES } from './rules.mjs';

/** The doc key that announces the run's host: { slot, key } (runs from before 2.8.2 learn the key from it). */
export const HOST_DOC_KEY = 'run:host';

/** Every rule of a SoulLink – what the host sets in the wizard and on the board (all of them in the shared `rules`). */
export const SOULLINK_RULE_KEYS = ['typeClause', 'dupes', 'missedDupes', 'failKillsPair', 'shinyClause', 'gifts', 'levelCaps', 'cheats', 'cheatSet',
  'lives', 'livesPool', 'typeHelp', 'autoAssign', 'autoDeath', 'startAtBalls', 'linkTrades', 'linkBattles', 'linkBattleDeaths',
  'linkWagers', 'linkWagerCap', 'itemGifts', 'raids', 'raidDeaths', 'saveImports'];

/** A new SoulLink's rules (the wizard's start): the defaults of every rule – a new run's where they differ (NEW_RUN_RULES). */
export const soulLinkDefaults = () => Object.fromEntries(SOULLINK_RULE_KEYS.map((k) => [k, k in NEW_RUN_RULES ? NEW_RUN_RULES[k] : DEFAULT_RULES[k]]));

/**
 * A SoulLink's rules to start a new run from (a new attempt: the old run's), every rule present: the old values where
 * they are valid, the defaults elsewhere.
 */
export function soulLinkRulesFrom(old) {
  const o = old && typeof old === 'object' && !Array.isArray(old) ? old : {};
  const r = soulLinkDefaults();
  for (const k of SOULLINK_RULE_KEYS) if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
  // `giftsCount` (true/false) came before `gifts`
  if (o.gifts === undefined && o.giftsCount !== undefined) r.gifts = o.giftsCount ? 'area' : 'free';
  // a run from before 3.0 had no choice of cheats: its new attempt keeps the two it allowed (shared/rules.mjs cheatGroups)
  if (old && typeof old === 'object' && !Array.isArray(old) && (o.cheatSet === undefined || o.cheatSet === null)) r.cheatSet = null;
  return r;
}

/** The signature's fields in a stored rules value. */
export const SIG_FIELDS = ['rev', 'sig'];

/** The rules without the host's signature. */
export function unsigned(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return rules ?? null;
  const out = { ...rules };
  for (const k of SIG_FIELDS) delete out[k];
  return out;
}

/** The run's host player: `host` of the manifest (or pack), else p1 – the creator before 2.8.2 always was. */
export function hostSlotOf(m) {
  return ALL_SLOTS.includes(m?.host) ? m.host : 'p1';
}

/** Can this computer change the rules of run `m`? A solo run: yes. A SoulLink: only on the computer that created it. */
export const canEditRules = (m) => !!m && (runMode(m) === 'nuzlocke' || !m.imported);

/** A public host key as the pack carries it: the raw 32 bytes, base64url. */
export const isHostKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k);

/** JSON with the object keys sorted (both sides must sign the same bytes). */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** What the host signs: the run and the rules with their `rev` (no `sig`). */
export function rulesPayload(runId, value) {
  const { sig, ...rest } = value || {}; // eslint-disable-line no-unused-vars
  return `souldew-rules@1\n${runId}\n${canonical(rest)}`;
}

/** Has the stored value the host's signature for doc timestamp `t` (the shape only – verifyHostRules checks it)? */
export function signedFor(value, t) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.sig === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value.sig)
    && Number.isFinite(value.rev) && value.rev === t;
}

const fromB64url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/**
 * Did the host of run `runId` (public key `key`) write these rules at doc timestamp `t`? Resolves to true / false –
 * or null when this browser can't check Ed25519 signatures at all (the caller decides).
 */
export async function verifyHostRules(runId, key, value, t) {
  if (!isHostKey(key) || !signedFor(value, t)) return false;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  let pub;
  try {
    pub = await subtle.importKey('raw', fromB64url(key), { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return null; // no Ed25519 in this browser
  }
  try {
    return await subtle.verify({ name: 'Ed25519' }, pub, fromB64url(value.sig), new TextEncoder().encode(rulesPayload(runId, value)));
  } catch {
    return false;
  }
}
