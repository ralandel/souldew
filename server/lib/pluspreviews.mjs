// souldew+ PREVIEW MEDIA (souldew-accounts API.md §10.6): pictures of every premium banner, nameplate, avatar frame,
// the handheld's stickers and wraps and colour skin – a PNG still and a short animated WebP each – so anyone, signed in or not, sees what
// souldew+ holds before buying it. They hold no recipe or code (scripts/plus-previews.mjs renders them offline), and the
// service hands them to anyone, but they come in a pack signed with the pack key like every other: nothing is shown
// before the manifest's signature (pinned key) and the file's SHA-256 check out.
//
//   GET /api/plus/previews            { version, files: { '<kind>/<id>.<png|webp>': true, … } } or { none: true }
//   GET /api/plus/previews/file?path= one verified picture (image/png | image/webp), cached on disk by its hash
//
// The manifest is asked for at most every 10 minutes (kept on disk for offline use); a picture is downloaded once.
// Dev: SLS_PLUS_DEV_PACK=<folder> with previews/ and access-previews.json (scripts/plus-dev-pack.mjs --out).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { manifestSigned } from './pluspack.mjs';
import { writeFileAtomic, httpError } from './fsutil.mjs';
import { accountsBase } from './accounts/contract.mjs';
import { EDITION } from '../../shared/edition.mjs';

// launch/: the 3D launch looks' still and loop (your-colours, gold, holo, clear-shell-<colour> – the souldew+ page's launch
// cards, views/launchlooks.mjs); an older pack's 2D launch pictures there are simply never asked for
export const PREVIEWS_PATH_RE = /^(banners|nameplates|frames|launch|skins|stickers|wraps)\/[a-z0-9][a-z0-9-]{0,47}\.(png|webp)$/;
export const PREVIEW_FILE_MAX = 512 * 1024;
const MANIFEST_MAX = 1024 * 1024;
const REFRESH_MS = 10 * 60e3;
const TYPES = { png: 'image/png', webp: 'image/webp' };
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The previews manifest, checked: signed with a pinned key (or the dev key), kind "previews", and nothing in it but
 * PNG / WebP pictures at <kind>/<id>.<ext> – no stylesheet, script or data. Returns { version, files: Map(path → sha) }.
 */
export function readPreviewsManifest(manifestB64, signatureB64, devKey = null) {
  if (typeof manifestB64 !== 'string' || typeof signatureB64 !== 'string' || manifestB64.length > MANIFEST_MAX * 1.4) throw httpError(502, 'Bad previews', 'plusPreviews');
  if (!manifestSigned(manifestB64, signatureB64, devKey)) throw httpError(502, 'The previews are not signed by souldew', 'plusPreviews');
  let m;
  try {
    m = JSON.parse(Buffer.from(manifestB64, 'base64url').toString('utf8'));
  } catch {
    throw httpError(502, 'Bad previews', 'plusPreviews');
  }
  if (!m || m.format !== 1 || m.kind !== 'previews' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(m.version) || !Array.isArray(m.files) || m.files.length > 2000) {
    throw httpError(502, 'Bad previews', 'plusPreviews');
  }
  const files = new Map();
  for (const f of m.files) {
    if (!f || !PREVIEWS_PATH_RE.test(f.path) || f.executable || !/^[0-9a-f]{64}$/.test(f.sha256) || !(f.size > 0 && f.size <= PREVIEW_FILE_MAX)) {
      throw httpError(502, `Bad preview file ${String(f?.path).slice(0, 80)}`, 'plusPreviews');
    }
    files.set(f.path, f.sha256);
  }
  return { id: m.id, version: m.version, files };
}

export function createPlusPreviews({ dir, devDir = process.env.SLS_PLUS_DEV_PACK || '', fetchImpl = globalThis.fetch, now = () => Date.now(), env = process.env, packaged = false } = {}) {
  const dev = devDir && !packaged ? resolve(devDir) : '';
  const metaFile = join(dir, 'previews.json');
  const filesDir = join(dir, 'previews');
  let mem = null; // { version, files: Map, manifest, signature, checkedAt, base }
  let pending = null;

  const devKey = () => {
    try {
      return JSON.parse(readFileSync(join(dev, 'access.json'), 'utf8')).publicKey || null;
    } catch {
      return null;
    }
  };
  /** a throwaway key for a local service (e2e: SLS_PLUS_DEV_KEY with SLS_ACCOUNTS_URL on this computer) – never packaged */
  const envKey = () => {
    const k = env.SLS_PLUS_DEV_KEY;
    const host = new URL(accountsBase(env)).hostname;
    return k && !packaged && /^[A-Za-z0-9_-]{43}$/.test(k) && ['127.0.0.1', 'localhost', '[::1]'].includes(host) ? k : null;
  };
  function fromAnswer(a, base) {
    const key = dev ? (a.publicKey || devKey()) : envKey();
    const p = readPreviewsManifest(a.manifest, a.signature, key);
    return { ...p, manifest: a.manifest, signature: a.signature, base, key, checkedAt: now() };
  }
  async function refresh() {
    if (dev) {
      const f = join(dev, 'access-previews.json');
      if (!existsSync(f)) return null;
      return fromAnswer(JSON.parse(readFileSync(f, 'utf8')), null);
    }
    // a build without the souldew account never asks its service – there are no previews (shared/edition.mjs)
    if (EDITION.accounts === false && !env.SLS_ACCOUNTS_URL) return null;
    const base = accountsBase(env);
    const r = await fetchImpl(`${base}/v1/previews`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (!r.ok) throw httpError(502, 'Previews unavailable', 'plusPreviews');
    const a = await r.json();
    const p = fromAnswer(a, base);
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(metaFile, JSON.stringify({ manifest: a.manifest, signature: a.signature, base }));
    return p;
  }
  /** the verified manifest (fresh at most every 10 minutes; the last good one when the service can't be reached) */
  async function current() {
    if (mem && now() - mem.checkedAt < REFRESH_MS) return mem;
    if (!pending) {
      pending = refresh().then((p) => {
        mem = p;
        return p;
      }, (e) => {
        if (e?.status !== 502 || !/unavailable/i.test(e.message)) console.warn('souldew+ previews:', e?.message || e);
        // offline: the last verified manifest on disk (checked again), if any
        if (!mem && existsSync(metaFile)) {
          try {
            const d = JSON.parse(readFileSync(metaFile, 'utf8'));
            mem = { ...fromAnswer(d, d.base), checkedAt: now() - REFRESH_MS + 60e3 };
          } catch {
            mem = null;
          }
        }
        return mem;
      }).finally(() => { pending = null; });
    }
    return pending;
  }

  return {
    async state() {
      const p = await current();
      if (!p) return { none: true };
      return { version: p.version, files: Object.fromEntries([...p.files.keys()].map((k) => [k, true])) };
    },
    /** one verified picture: { bytes, type } */
    async file(path) {
      const p = await current();
      const want = p && typeof path === 'string' ? p.files.get(path) : null;
      if (!want) throw httpError(404, 'No such preview', 'plusPreviews');
      const type = TYPES[path.split('.').pop()];
      const cached = join(filesDir, `${want}.${path.split('.').pop()}`);
      if (existsSync(cached)) {
        const b = readFileSync(cached);
        if (sha(b) === want) return { bytes: b, type };
        rmSync(cached, { force: true });
      }
      let bytes;
      if (dev) {
        bytes = readFileSync(join(dev, 'previews', ...path.split('/')));
      } else {
        const url = `${p.base}/v1/previews/${p.version}/${path}`;
        if (new URL(url).origin !== new URL(accountsBase(env)).origin) throw httpError(400, 'Preview URL not allowed', 'plusUrl');
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw httpError(502, 'Preview unavailable', 'plusPreviews');
        bytes = Buffer.from(await r.arrayBuffer());
      }
      if (bytes.length > PREVIEW_FILE_MAX || sha(bytes) !== want) throw httpError(502, 'The preview does not match its signature', 'plusPreviews');
      mkdirSync(filesDir, { recursive: true });
      writeFileAtomic(cached, bytes);
      // pictures of older preview versions go
      const keep = new Set([...p.files].map(([k, h]) => `${h}.${k.split('.').pop()}`));
      for (const n of readdirSync(filesDir)) if (!keep.has(n) && /^[0-9a-f]{64}\.(png|webp)$/.test(n)) rmSync(join(filesDir, n), { force: true });
      return { bytes, type };
    },
  };
}

/** GET /api/plus/previews/file – the picture with its own type, cacheable (its path names one signed version) */
export async function servePreview(previews, res, url) {
  const { bytes, type } = await previews.file(url.searchParams.get('path'));
  res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
  res.end(bytes);
}
