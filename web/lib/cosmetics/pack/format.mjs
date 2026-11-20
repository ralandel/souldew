// souldew+ premium pack: the format and its cryptography – the accounts service's contract (souldew-accounts
// docs/API.md §10), one format end to end. Isomorphic (WebCrypto only), so the renderer, the dev pack builder
// (scripts/plus-dev-pack.mjs) and the tests share one implementation. Nothing in here touches the DOM, the network or
// the disk.
//
//   manifest  – built and signed ONCE, offline, by the owner's pack tool (souldew-accounts tools/pack-build.mjs) with
//               the pack signing key; the same bytes for every account (UTF-8 JSON):
//               { format: 1, id, version, kind, title, created, files: [{ path, sha256, size, type, executable }] }
//               The Ed25519 signature covers the manifest's exact bytes, and through its hashes every byte of every file.
//   envelope  – one per file, made by the service for one account at download time (AES-256-GCM, a fresh nonce each):
//               "SDP1" | u16 headerLength (big-endian) | header (UTF-8 JSON) | ciphertext+tag
//               header = { v: 1, pack, version, path, wm, kid, nonce }   – the header is the GCM additional data
//               plaintext = the file; text files (.css .js .mjs .json .txt) end with the trailer "\n/*sdwm:<wm>*/\n"
//
// Order of trust on the way in (openPack): the manifest's signature against a PINNED key → the manifest's shape → for
// every file: framing, header bound to this pack / path / key id, GCM tag, watermark trailer, size, SHA-256 → only when
// ALL files passed is anything handed out. A pack is used whole or not at all.

export const FORMAT = 1;
const ENVELOPE_MAGIC = 'SDP1';
export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// 'previews': the public preview media (pictures only – scripts/plus-previews.mjs, API.md §10.6)
export const KINDS = ['skins', 'banners', 'frames', 'launch', 'mixed', 'preview', 'previews'];
/** Same table as the service and the pack tool: extension → media type. */
export const TYPES = {
  css: 'text/css', json: 'application/json', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', woff2: 'font/woff2',
  mjs: 'text/javascript', js: 'text/javascript', txt: 'text/plain',
};
/** Files that carry the per-account watermark trailer (images and fonts can't). */
export const WATERMARKED = /\.(css|js|mjs|json|txt)$/;
/** Hard caps (the service's): refused before any work is done. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 2000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 2048;
const WM_RE = /^wm_[A-Za-z0-9_-]{1,40}$/;
// a member's key id: the account's key epoch and, since the key is bound to the signed-in session, that session's tag
// (<epoch>_<16 chars>; the plain epoch of an older service is still read); a live preview's: its grant id
export const KID_RE = /^(\d{1,9}(_[A-Za-z0-9_-]{16})?|pv_[A-Za-z0-9_-]{22})$/;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw packError('crypto', 'WebCrypto is not available');
  return s;
};

export function packError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ------------------------------------------------------------------ bytes helpers
export function b64encode(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export const b64url = (bytes) => b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** base64 or base64url → bytes; null for anything that isn't */
export function b64decode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
export const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) {
  return hex(await subtle().digest('SHA-256', bytes));
}
const bytesOf = (v) => (typeof v === 'string' ? b64decode(v) : v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null);
function endsWith(b, tail) {
  if (b.length < tail.length) return false;
  for (let i = 0; i < tail.length; i++) if (b[b.length - tail.length + i] !== tail[i]) return false;
  return true;
}
export const trailerOf = (wm) => enc.encode(`\n/*sdwm:${wm}*/\n`);

// ------------------------------------------------------------------ manifest
/** One path segment: letters, digits, . _ - (the service's validPackPath), never . or .. */
export function validPackPath(p) {
  return typeof p === 'string' && p.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(p) && !p.split('/').some((s) => s === '.' || s === '..');
}
const extOf = (p) => p.split('.').pop().toLowerCase();

/** The manifest is data from outside – even signed, its shape is checked strictly (the service does the same). */
export function checkManifest(m) {
  const bad = (why) => packError('manifest', `manifest invalid: ${why}`);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('not an object');
  if (m.format !== FORMAT) throw bad(`unknown format ${String(m.format).slice(0, 20)}`);
  if (!PACK_ID_RE.test(m.id || '') || !VERSION_RE.test(m.version || '') || !KINDS.includes(m.kind)) throw bad('id/version/kind');
  if (typeof m.title !== 'string' || m.title.length > 80 || typeof m.created !== 'string') throw bad('title/created');
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > MAX_FILES) throw bad('files');
  const seen = new Set();
  let total = 0;
  for (const f of m.files) {
    if (!f || !validPackPath(f.path) || seen.has(f.path)) throw bad(`path ${String(f?.path).slice(0, 60)}`);
    seen.add(f.path);
    const ext = extOf(f.path);
    if (!Object.hasOwn(TYPES, ext) || TYPES[ext] !== f.type) throw bad(`type of ${f.path}`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw bad(`sha256 of ${f.path}`);
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw bad(`size of ${f.path}`);
    if (f.executable !== (ext === 'js' || ext === 'mjs')) throw bad(`executable flag of ${f.path}`);
    total += f.size;
  }
  if (total > MAX_PACK_BYTES) throw bad('pack too large');
  return m;
}

export function parseManifest(bytes) {
  const b = bytesOf(bytes);
  if (!b || b.length > MAX_MANIFEST_BYTES) throw packError('manifest', 'manifest missing or too large');
  let m;
  try {
    m = JSON.parse(dec.decode(b));
  } catch {
    throw packError('manifest', 'manifest is not JSON');
  }
  return checkManifest(m);
}

/**
 * Builds a manifest exactly like the owner's pack tool does (tests and the dev pack builder – production manifests are
 * built and signed by souldew-accounts tools/pack-build.mjs, never by the app). files: [{ path, bytes }].
 */
export async function buildManifest({ id, version, kind, title, created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), files }) {
  const list = [];
  for (const f of files) {
    const ext = extOf(f.path);
    list.push({ path: f.path, sha256: await sha256(f.bytes), size: f.bytes.length, type: TYPES[ext], executable: ext === 'js' || ext === 'mjs' });
  }
  const manifest = checkManifest({ format: FORMAT, id, version, kind, title, created, files: list });
  return { manifest, manifestBytes: enc.encode(JSON.stringify(manifest, null, 2)) };
}

// ------------------------------------------------------------------ signatures
/**
 * True when `sig` is a valid Ed25519 signature of `bytes` by ANY of `keys` (raw 32-byte public keys, or base64/base64url
 * text). Keys that don't decode to 32 bytes (the placeholder before a production key is configured) never verify.
 */
export async function verifySignature(bytes, sig, keys) {
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return false;
  for (const k of keys || []) {
    const raw = typeof k === 'string' ? b64decode(k) : k;
    if (!(raw instanceof Uint8Array) || raw.length !== 32) continue;
    try {
      const pub = await subtle().importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
      if (await subtle().verify({ name: 'Ed25519' }, pub, sig, bytes)) return true;
    } catch {
      // a malformed key is simply not a match
    }
  }
  return false;
}

/** Ed25519 key pair for the dev builder and the tests: { publicKey (raw 32 bytes), pkcs8(), sign(bytes) } */
export async function makeSigner(pkcs8) {
  const s = subtle();
  let priv, pubRaw;
  if (pkcs8) {
    priv = await s.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
    pubRaw = b64decode((await s.exportKey('jwk', priv)).x);
  } else {
    const kp = await s.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    priv = kp.privateKey;
    pubRaw = new Uint8Array(await s.exportKey('raw', kp.publicKey));
  }
  return {
    publicKey: pubRaw,
    pkcs8: async () => new Uint8Array(await s.exportKey('pkcs8', priv)),
    sign: async (bytes) => new Uint8Array(await s.sign({ name: 'Ed25519' }, priv, bytes)),
  };
}

// ------------------------------------------------------------------ per-file envelopes
/**
 * Encrypts one file for one account, exactly as the service's file endpoint does (dev pack builder and tests only).
 * { pack, version, path, wm, kid, key (32 bytes), bytes }
 */
export async function sealFile({ pack, version, path, wm, kid, key, bytes }) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw packError('key', 'the pack key must be 32 bytes');
  let plain = bytes;
  if (WATERMARKED.test(path)) {
    const t = trailerOf(wm);
    plain = new Uint8Array(bytes.length + t.length);
    plain.set(bytes);
    plain.set(t, bytes.length);
  }
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const header = enc.encode(JSON.stringify({ v: 1, pack, version, path, wm, kid, nonce: b64url(nonce) }));
  const k = await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, k, plain));
  const out = new Uint8Array(6 + header.length + ct.length);
  out.set(enc.encode(ENVELOPE_MAGIC), 0);
  out[4] = (header.length >> 8) & 0xff;
  out[5] = header.length & 0xff;
  out.set(header, 6);
  out.set(ct, 6 + header.length);
  return out;
}

/** Envelope framing → { header, headerBytes, body }. Checks the shape only. */
export function parseEnvelope(bytes) {
  const b = bytesOf(bytes);
  if (!b || b.length < 6 + 16 || dec.decode(b.subarray(0, 4)) !== ENVELOPE_MAGIC) throw packError('envelope', 'not a souldew+ file envelope');
  if (b.length > MAX_FILE_BYTES + MAX_HEADER_BYTES + 1024) throw packError('envelope', 'file too large');
  const hLen = (b[4] << 8) | b[5];
  if (hLen < 2 || hLen > MAX_HEADER_BYTES || 6 + hLen + 16 > b.length) throw packError('envelope', 'bad envelope header length');
  const headerBytes = b.subarray(6, 6 + hLen);
  let header;
  try {
    header = JSON.parse(dec.decode(headerBytes));
  } catch {
    throw packError('envelope', 'bad envelope header');
  }
  if (!header || header.v !== 1 || typeof header.pack !== 'string' || typeof header.path !== 'string' || !VERSION_RE.test(header.version || '')
    || !WM_RE.test(header.wm || '') || !KID_RE.test(header.kid || '') || b64decode(header.nonce)?.length !== 12) throw packError('envelope', 'unsupported envelope header');
  return { header, headerBytes, body: b.subarray(6 + hLen) };
}

/**
 * Opens one file: the envelope must be for this pack, this path and this key id; the GCM tag must hold; text files must
 * end with the trailer of the header's watermark (stripped); size and SHA-256 must equal the manifest entry.
 * expect: { pack, kid, entry: { path, sha256, size } }. Returns { bytes, wm, version }.
 */
export async function openFile(envelope, keyBytes, { pack, kid, entry }) {
  const { header, headerBytes, body } = parseEnvelope(envelope);
  if (header.pack !== pack || header.path !== entry.path || header.kid !== String(kid)) throw packError('envelope', `envelope is not for ${entry.path}`);
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) throw packError('key', 'the pack key must be 32 bytes');
  let plain;
  try {
    const k = await subtle().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: b64decode(header.nonce), additionalData: headerBytes }, k, body));
  } catch {
    throw packError('decrypt', `${entry.path} could not be decrypted (wrong key or damaged download)`);
  }
  if (WATERMARKED.test(entry.path)) {
    const t = trailerOf(header.wm);
    if (!endsWith(plain, t)) throw packError('watermark', `${entry.path} has no valid watermark`);
    plain = plain.subarray(0, plain.length - t.length);
  }
  if (plain.length !== entry.size || (await sha256(plain)) !== entry.sha256) throw packError('hash', `${entry.path} does not match its hash`);
  return { bytes: plain.slice(), wm: header.wm, version: header.version };
}

/**
 * The whole way in. { manifest (bytes or base64url), signature (base64/base64url or bytes), keys (pinned), key (account
 * or preview key, 32 bytes or base64url), kid, envelope(path) → bytes (may be async), expect: { id, version } }.
 * Returns { manifest, files: Map(path → Uint8Array), watermarks: Set } – only after every file verified.
 */
export async function openPack({ manifest, signature, keys, key, kid, envelope, expect = {} }) {
  const manifestBytes = bytesOf(manifest);
  const sig = bytesOf(signature);
  if (!manifestBytes || !sig) throw packError('signature', 'manifest or signature missing');
  // the signature first: nothing of an unsigned manifest is even parsed
  if (!(await verifySignature(manifestBytes, sig, keys))) throw packError('signature', 'the pack signature is not valid');
  const m = parseManifest(manifestBytes);
  if ((expect.id && m.id !== expect.id) || (expect.version && m.version !== expect.version)) throw packError('manifest', 'not the pack the account service issued');
  const keyBytes = bytesOf(key);
  const files = new Map();
  const watermarks = new Set();
  for (const entry of m.files) {
    const env = await envelope(entry.path);
    if (!env) throw packError('missing', `${entry.path} is missing`);
    const f = await openFile(env, keyBytes, { pack: m.id, kid, entry });
    files.set(entry.path, f.bytes);
    if (WATERMARKED.test(entry.path)) watermarks.add(f.wm);
  }
  return { manifest: m, files, watermarks };
}

export const text = (bytes) => dec.decode(bytes);
