// souldew+ pack client (renderer). Gets the pack access from the account client, has the local server download and cache
// the ENCRYPTED files (one envelope per file, API.md §10), verifies the signed manifest and decrypts + checks every file
// here in the page, and loads the CSS / data / signed modules into memory only when ALL of them passed. Nothing premium
// is ever stored in plain form, and nothing from a pack runs in the Node or main process.
//
// The account client plugs in with setPackAccessProvider(fn). fn({ purpose: 'pack' | 'preview' }) resolves to
//   { packId, version, manifest, signature, keyId, watermark, key, files: [{ path, url }], until }
//                                     – purpose 'pack': the account owns souldew+ (the service's download answer + key)
//   { …same…, expiresAt, preview: true } – purpose 'preview': a 15-minute live theme preview (key for this preview only)
//   { key, keyId, until, offline: true } – the service is unreachable; the last entitlement kept in safeStorage
//   null                               – signed out / no membership (the cache is wiped)
// and throws when it can't tell (counts as offline). For 'preview' it throws with e.code from the service
// ('rate_limited', 'limit_reached', 'signed_out', 'none') so Settings can say why.
import { openPack, packError, text } from './format.mjs';
import { trustedKeys } from './keys.mjs';
import { state, update, setContent } from '../state.mjs';
import { cleanLooks } from '../../handheld/looks.mjs';

export const GRACE_MS = 7 * 24 * 3600 * 1000;
const RECHECK_MS = 6 * 3600 * 1000;
const RETRY_CODES = ['decrypt', 'hash', 'envelope', 'watermark', 'missing'];

const headers = { 'x-soullink': '1' };
async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    // the local server checks the manifest signature before it downloads or stores anything (server/lib/pluspack.mjs)
    const code = res.headers.get('content-type')?.includes('json') ? (await res.json().catch(() => ({})))?.code : null;
    throw packError(code === 'plusSignature' ? 'signature' : res.status === 404 ? 'none' : 'server', `${method} ${url}: ${res.status}`);
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : new Uint8Array(await res.arrayBuffer());
}

/** Without an account client: the dev pack, when the local server was started with one (SLS_PLUS_DEV_PACK). */
async function devProvider({ purpose = 'pack' } = {}) {
  let previewOnly = false;
  try {
    previewOnly = localStorage.getItem('sl-plus-dev-preview') === '1'; // try the non-member flow with the test pack
  } catch {
    // storage blocked
  }
  if (previewOnly && purpose === 'pack') return null;
  try {
    return await call('GET', `/api/plus/dev/access?purpose=${purpose === 'preview' ? 'preview' : 'pack'}`);
  } catch {
    return null;
  }
}

/** The dev pack's access (or null) – what the app hands a signed-out player (web/lib/account.mjs cosmeticsPackAccess). */
export const devPackAccess = devProvider;

let provider = devProvider;
/**
 * The account client's hook (see the top of this file). Passing null restores the dev / signed-out default.
 * A provider answers null only when the player is REALLY signed out or without souldew+ – that wipes the cache. While
 * the account isn't known yet (the saved sign-in is still being read) it waits instead (the app's does).
 */
export function setPackAccessProvider(fn) {
  provider = typeof fn === 'function' ? fn : devProvider;
}
export async function getPackAccess(opts = {}) {
  return provider(opts);
}

/** The keys a pack must be signed with: the pinned production key, plus a dev key only when the local server offers one. */
async function keys() {
  const devKey = await call('GET', '/api/plus/dev/key').then((r) => r?.publicKey || null).catch(() => null);
  return trustedKeys(devKey);
}

let inflight = null;
let timer = 0;
let preview = null; // { until, timer } while a live theme preview is in memory
const clearContent = () => {
  if (!preview) setContent(null); // a running preview keeps its skins until it ends
};

async function wipe(error = null) {
  clearContent();
  try {
    await call('DELETE', '/api/plus/pack');
  } catch {
    // the server wipes an expired cache on its own as well
  }
  update({ entitled: false, until: null, packVersion: null, error });
}

/** Turns the verified files into in-memory content. */
export function contentFrom(files, { skinsByPath = false } = {}) {
  const json = (p) => (files.has(p) ? JSON.parse(text(files.get(p))) : null);
  const contents = skinsByPath
    ? { skins: [...files.keys()].map((p) => /^skins\/([a-z0-9-]{1,40})\.css$/.exec(p)).filter(Boolean).map((m) => ({ id: m[1], css: m[0] })) }
    : json('contents.json') || {};
  const skinCss = [];
  for (const s of contents.skins || []) if (files.has(s.css) && /^[a-z0-9-]{1,40}$/.test(s.id)) skinCss.push([s.id, text(files.get(s.css))]);
  const assets = [...files].filter(([p]) => /^(fonts|assets)\//.test(p));
  return {
    banners: contents.banners ? json(contents.banners) || [] : [],
    skinCss,
    files: assets,
    framesModule: contents.frames?.module && files.has(contents.frames.module) ? text(files.get(contents.frames.module)) : null,
    frameIds: contents.frames?.ids || [],
    handheld: handheldFrom(contents.handheld, files, json),
  };
}

/**
 * "Your handheld"'s souldew+ part (web/lib/handheld): the wraps' compositions (data, run by the public banner engine
 * with the pack's banner recipes), the souldew+ stickers' pre-built atlas – its layout and two PNGs (bytes, decoded
 * by the page when the handheld is first drawn) – and the souldew+ looks (Gold, Clear shell, Holo label, the Rare start,
 * the holo / glitter finishes: handheld/looks.json, checked by looks.mjs cleanLooks). A pack without them (an older
 * one) simply has none.
 */
function handheldFrom(h, files, json) {
  if (!h || typeof h !== 'object') return null;
  const bytes = (p) => (typeof p === 'string' && files.has(p) ? files.get(p) : null);
  const wraps = h.wraps ? json(h.wraps) : null;
  const layout = h.stickers ? json(h.stickers) : null;
  return {
    wraps: Array.isArray(wraps) ? wraps : [],
    stickers: layout && bytes(h.art) && bytes(h.cut) ? { layout, art: bytes(h.art), cut: bytes(h.cut) } : null,
    looks: h.looks ? cleanLooks(json(h.looks)) : null,
  };
}

const fetchAnswer = (access) => call('POST', '/api/plus/pack/fetch', {
  packId: access.packId, version: access.version, manifest: access.manifest, signature: access.signature, keyId: access.keyId,
  watermark: access.watermark, files: access.files, until: access.until || null,
});
const openCached = async (meta, key, expect) => openPack({
  manifest: meta.manifest, signature: meta.signature, keys: await keys(), key, kid: meta.keyId, expect,
  envelope: (path) => call('GET', `/api/plus/pack/file?path=${encodeURIComponent(path)}`),
});

async function run() {
  update({ loading: true });
  try {
    let access = null;
    let offline = false;
    try {
      access = await provider({ purpose: 'pack' });
    } catch {
      offline = true;
    }
    if (access?.offline) offline = true;
    let meta = await call('GET', '/api/plus/pack/meta').catch(() => ({ none: true }));
    if (!access && !offline) return wipe(null); // signed out or no souldew+
    let pack;
    if (offline) {
      // the server has already dropped a cache older than the grace period
      if (meta.none) {
        clearContent();
        return update({ entitled: false, until: null, packVersion: null, error: 'offline' });
      }
      if (!(Date.now() - Date.parse(meta.lastOnline) <= GRACE_MS)) return wipe('expired');
      if (!access?.key) return update({ error: 'offline' }); // can't decrypt without the account's key – keep the cache for later
      if (access.keyId && access.keyId !== meta.keyId) return wipe('key'); // the key changed before we went offline
      pack = await openCached(meta, access.key, { id: meta.packId, version: meta.version });
    } else {
      if (access.until && Date.parse(access.until) < Date.now()) return wipe('expired');
      // the pack key changed (sign out everywhere, membership unlinked or taken over): everything cached goes first
      if (!meta.none && meta.keyId !== access.keyId) {
        await call('DELETE', '/api/plus/pack');
        meta = { none: true };
      }
      const same = !meta.none && meta.packId === access.packId && meta.version === access.version && meta.signature === access.signature;
      meta = same ? await call('POST', '/api/plus/pack/meta', { lastOnline: new Date().toISOString(), until: access.until || null }) : await fetchAnswer(access);
      const expect = { id: access.packId, version: access.version };
      try {
        pack = await openCached(meta, access.key, expect);
      } catch (e) {
        if (!RETRY_CODES.includes(e.code)) throw e;
        // a damaged download (or a cache for another key): everything once more, from scratch
        await call('DELETE', '/api/plus/pack');
        meta = await fetchAnswer(access);
        pack = await openCached(meta, access.key, expect);
      }
    }
    setContent(contentFrom(pack.files));
    update({ entitled: true, until: access?.until || meta.until || null, packVersion: pack.manifest.version, error: offline ? 'offline' : null });
  } catch (e) {
    const code = e?.code || 'error';
    if (code === 'signature' || code === 'manifest') await wipe(code); // never keep a pack that doesn't verify
    else {
      clearContent();
      update({ entitled: false, error: code === 'server' || code === 'none' ? 'download' : code });
    }
  } finally {
    update({ loading: false });
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  if (typeof setTimeout !== 'function') return;
  // re-check the membership now and then, and right when it is due to end
  const untilIn = state.until ? Date.parse(state.until) - Date.now() + 1000 : Infinity;
  const ms = Math.max(5000, Math.min(RECHECK_MS, untilIn));
  timer = setTimeout(() => refreshPack(), ms);
  timer?.unref?.();
}

/** Loads (or re-checks) the pack. Concurrent calls share one run. */
export function refreshPack() {
  if (!inflight) inflight = run().finally(() => { inflight = null; });
  return inflight;
}

/** Signed out / "remove souldew+ from this computer": forget everything now (a running preview too). */
export async function forgetPack() {
  clearTimeout(timer);
  endPackPreview();
  await wipe(null);
}

// ------------------------------------------------------------------ live theme preview (API.md §10.4)
let previewing = null;
/**
 * Starts a 15-minute live theme preview for a non-member: the preview pack (skin stylesheets, small images) is fetched
 * through the local server WITHOUT being stored, verified like any pack, and kept in memory until `expiresAt` – then it
 * is dropped and the app goes back to its own look. Resolves to { until }; rejects with e.code ('rate_limited',
 * 'limit_reached', 'signed_out', 'none', 'signature', …).
 */
export function startPackPreview() {
  if (state.entitled) return Promise.resolve({ until: null, member: true });
  if (preview && Date.parse(preview.until) > Date.now()) return Promise.resolve({ until: preview.until });
  previewing ||= (async () => {
    update({ previewLoading: true });
    try {
      const access = await provider({ purpose: 'preview' });
      if (!access) throw packError('signed_out', 'Sign in to preview');
      const until = access.expiresAt;
      if (!(Date.parse(until) > Date.now())) throw packError('expired', 'The preview has ended');
      const urls = new Map((access.files || []).map((f) => [f.path, f.url]));
      const pack = await openPack({
        manifest: access.manifest, signature: access.signature, keys: await keys(), key: access.key, kid: access.keyId,
        expect: { id: access.packId, version: access.version },
        envelope: (path) => (urls.has(path) ? call('POST', '/api/plus/fetch', { url: urls.get(path) }) : null),
      });
      if (pack.manifest.kind !== 'preview') throw packError('manifest', 'not a preview pack');
      if (state.entitled) return { until: null, member: true }; // became a member meanwhile – nothing to preview
      // a preview pack has no contents.json (stylesheets and images only): its skins are skins/<id>.css
      const c = contentFrom(pack.files, { skinsByPath: true });
      // a preview only ever carries skins: banners and frames are never part of it
      setContent({ skinCss: c.skinCss, files: c.files });
      clearTimeout(preview?.timer);
      preview = { until, timer: setTimeout(() => endPackPreview(), Math.max(0, Date.parse(until) - Date.now())) };
      update({ preview: true, previewUntil: until });
      return { until };
    } finally {
      update({ previewLoading: false });
      previewing = null;
    }
  })();
  return previewing;
}

/** Ends the live preview now (its time is up, sign-out): key and content are dropped, the app's own look is back. */
export function endPackPreview() {
  if (!preview) return;
  clearTimeout(preview.timer);
  preview = null;
  if (!state.entitled) setContent(null);
  update({ preview: false, previewUntil: null });
}

export function packState() {
  return {
    entitled: state.entitled, preview: state.preview, previewUntil: state.previewUntil || null, previewLoading: !!state.previewLoading,
    until: state.until, packVersion: state.packVersion, loading: state.loading, error: state.error,
  };
}
