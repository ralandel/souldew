// souldew+ pack cache and lifecycle: the server's encrypted per-file cache (allow-listed downloads, small updates,
// offline grace, wipe) and the page's pack client on top of it (load, not a member, membership ended, the pack key
// changed, offline within / beyond the grace period, a pack that doesn't verify, a damaged download, the live preview).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlusPack, packUrlAllowed, GRACE_MS } from '../server/lib/pluspack.mjs';
import { buildManifest, sealFile, makeSigner, b64url } from '../web/lib/cosmetics/pack/format.mjs';
// the tests sign with throwaway keys (never the owner's) and trust them through the keys module
// (the server checks the manifest signature before it stores anything, the page checks everything again)
import * as K from '../web/lib/cosmetics/pack/keys.mjs';

const PINNED = [...K.PRODUCTION_KEYS];
const trustKey = (p) => K.PRODUCTION_KEYS.push(b64url(p.signer.publicKey));
afterEach(() => K.PRODUCTION_KEYS.splice(0, K.PRODUCTION_KEYS.length, ...PINNED));

const enc = new TextEncoder();
const DAY = 86400e3;
const BASE = 'https://accounts.souldew.app/v1/packs/souldew-plus';
const NO_ENV = {}; // no SLS_ACCOUNTS_URL: the production service

const FILES = (css = '--shell: #1f2a20;') => [
  { path: 'contents.json', bytes: enc.encode(JSON.stringify({ skins: [{ id: 'moss', css: 'skins/moss.css' }], banners: 'banners.json', launch: { module: 'launch.mjs', ids: ['gust'] } })) },
  { path: 'skins/moss.css', bytes: enc.encode(`html[data-skin='moss'] { ${css} } .x { background: url('pack:assets/a.svg') }`) },
  { path: 'assets/a.svg', bytes: enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>') },
  { path: 'banners.json', bytes: enc.encode(JSON.stringify([{ id: 'night-marsh', name: 'Night Marsh', pal: { a: '#000000' }, layers: [] }])) },
  { path: 'launch.mjs', bytes: enc.encode('export const ANIMS = [];') },
];

/** A pack as the service hands it out: the download answer + the sealed files behind its URLs. */
async function makePack({ version = '1.0.0', kid = '1', key = globalThis.crypto.getRandomValues(new Uint8Array(32)), signer, files = FILES(), id = 'souldew-plus', kind = 'mixed' } = {}) {
  signer ||= await makeSigner();
  const { manifest, manifestBytes } = await buildManifest({ id, version, kind, title: 'Test', files });
  const signature = await signer.sign(manifestBytes);
  const sealed = new Map();
  for (const f of files) sealed.set(`${BASE}/${version}/file?path=${encodeURIComponent(f.path)}&k=${kid}`, await sealFile({ pack: id, version, path: f.path, wm: 'wm_acct', kid, key, bytes: f.bytes }));
  const answer = {
    packId: id, version, manifest: b64url(manifestBytes), signature: b64url(signature), keyId: kid, watermark: 'wm_acct',
    files: manifest.files.map((f) => ({ path: f.path, url: `${BASE}/${version}/file?path=${encodeURIComponent(f.path)}&k=${kid}` })),
  };
  return { signer, key, kid, version, manifest, sealed, answer };
}

const bodyOf = (bytes) => ({ ok: true, status: 200, headers: new Map([['content-length', String(bytes.length)]]), body: (async function* chunks() { yield bytes; })() });
const fakeFetch = (packs, log = []) => async (url) => {
  log.push(url);
  for (const p of [].concat(packs)) if (p.sealed.has(url)) return bodyOf(p.sealed.get(url));
  return { ok: false, status: 404, headers: new Map(), body: null };
};

// ------------------------------------------------------------------ server cache
test('pack URLs: the accounts service origin only, or the configured local service (no SSRF)', () => {
  assert.ok(packUrlAllowed(`${BASE}/1.0.0/file?path=a`, { env: NO_ENV }));
  for (const u of ['https://packs.souldew.app/x', 'https://souldew.app/x', 'https://evil.souldew.app/x', 'http://accounts.souldew.app/x', 'https://souldew.app.evil.com/x', 'https://evil.com/souldew.app', 'https://127.0.0.1/x', 'http://127.0.0.1:8788/x',
    'https://user:pw@accounts.souldew.app/x', 'https://accounts.souldew.app:8443/x', 'file:///etc/passwd', 'souldew-dev:pack/a.css', '', null]) {
    assert.equal(packUrlAllowed(u, { env: NO_ENV }), false, String(u));
  }
  // a test service on this computer (SLS_ACCOUNTS_URL): exactly its origin, nothing else on loopback
  const env = { SLS_ACCOUNTS_URL: 'http://127.0.0.1:8788' };
  assert.ok(packUrlAllowed('http://127.0.0.1:8788/v1/packs/x/1.0.0/file?path=a', { env }));
  assert.equal(packUrlAllowed('http://127.0.0.1:8789/x', { env }), false);
  assert.equal(packUrlAllowed('http://localhost:8788/x', { env }), false);
  // SLS_ACCOUNTS_URL itself is only taken for https or loopback http
  assert.equal(packUrlAllowed('http://evil.com/x', { env: { SLS_ACCOUNTS_URL: 'http://evil.com' } }), false);
  assert.ok(packUrlAllowed('souldew-dev:pack/skins/a.css', { dev: true, env: NO_ENV }), 'the dev pack only with SLS_PLUS_DEV_PACK');
  assert.equal(packUrlAllowed('souldew-dev:pack/../../etc/passwd', { dev: true, env: NO_ENV }), false);
});

test('server cache: per-file download, meta, file, touch only forward, wipe; the bytes stay encrypted', async () => {
  const p = await makePack();
  trustKey(p);
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  let now = Date.parse('2026-11-17T12:00:00Z');
  const plus = createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(p), now: () => now, env: NO_ENV });
  assert.deepEqual(plus.meta(), { none: true });
  await assert.rejects(plus.fetch({ ...p.answer, files: [{ ...p.answer.files[0], url: 'https://evil.com/p' }, ...p.answer.files.slice(1)] }), { code: 'plusUrl' });
  await assert.rejects(plus.fetch({ ...p.answer, files: p.answer.files.slice(1) }), { code: 'plusAnswer' }, 'every manifest file must be listed');
  const meta = await plus.fetch({ ...p.answer, until: '2026-12-17T00:00:00Z' });
  assert.equal(meta.version, '1.0.0');
  assert.equal(meta.downloaded, 5);
  assert.deepEqual(meta.paths.sort(), p.manifest.files.map((f) => f.path).sort());
  for (const f of p.answer.files) assert.deepEqual(new Uint8Array(plus.file(f.path)), p.sealed.get(f.url), 'cached as downloaded – never decrypted on the server');
  for (const name of readdirSync(join(dir, 'files'))) assert.ok(!readFileSync(join(dir, 'files', name)).includes(Buffer.from('--shell')), 'no plain CSS on disk');
  await assert.rejects(async () => plus.file('../pack.json'), { code: 'plusNone' });
  now += DAY;
  assert.equal(plus.touch({ lastOnline: new Date(now).toISOString() }).lastOnline, new Date(now).toISOString());
  assert.equal(plus.touch({ lastOnline: new Date(now - 5 * DAY).toISOString() }).lastOnline, new Date(now).toISOString(), 'never backwards');
  assert.equal(plus.touch({ lastOnline: new Date(now + 30 * DAY).toISOString() }).lastOnline, new Date(now).toISOString(), 'never past the clock');
  plus.wipe();
  assert.ok(!existsSync(join(dir, 'pack.json')) && !existsSync(join(dir, 'files')));
  await assert.rejects(async () => plus.file('contents.json'), { code: 'plusNone' });
});

test('server cache: an update downloads only the files that changed; a new key downloads everything', async () => {
  const signer = await makeSigner();
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const v1 = await makePack({ signer, key });
  const v2 = await makePack({ signer, key, version: '1.1.0', files: FILES('--shell: #000000;') });
  const v2k = await makePack({ signer, key, version: '1.1.0', kid: '2', files: FILES('--shell: #000000;') });
  trustKey(v1);
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  const log = [];
  const plus = createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch([v1, v2, v2k], log), env: NO_ENV });
  assert.equal((await plus.fetch(v1.answer)).downloaded, 5);
  assert.equal((await plus.fetch(v2.answer)).downloaded, 1, 'only skins/moss.css changed');
  assert.equal(readdirSync(join(dir, 'files')).length, 5, 'the old version of the changed file is gone');
  assert.equal((await plus.fetch(v2k.answer)).downloaded, 5, 'another key: nothing can be reused');
  assert.equal(readdirSync(join(dir, 'files')).length, 5);
});

test('server cache: wiped once the offline grace (7 days) is over, also when the clock jumps', async () => {
  const p = await makePack();
  trustKey(p);
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  let now = Date.parse('2026-11-17T12:00:00Z');
  const plus = createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(p), now: () => now, env: NO_ENV });
  await plus.fetch(p.answer);
  now += GRACE_MS - 1000;
  assert.ok(!plus.meta().none, 'still inside the grace period');
  now += 2000;
  assert.ok(plus.meta().none, 'grace over → wiped');
  assert.ok(!existsSync(join(dir, 'files')));
  await plus.fetch(p.answer);
  now -= 30 * DAY; // the clock was set back far
  assert.ok(plus.meta().none);
  // set back a little, day after day, to stay inside the window: the latest time seen counts (security review #4)
  await plus.fetch(p.answer);
  now += 6 * DAY;
  assert.ok(!plus.meta().none, 'day 6');
  now -= 6 * DAY;
  assert.ok(plus.meta().none, 'the clock went back behind a time already seen → wiped');
  // past the membership's end it goes as well, even inside the grace
  await plus.fetch({ ...p.answer, until: new Date(now + DAY).toISOString() });
  now += 2 * DAY;
  assert.ok(plus.meta().none, 'membership ended → wiped');
});

test('server cache: nothing is downloaded or stored for a manifest the pinned key did not sign (security review #8)', async () => {
  const p = await makePack();
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  const log = [];
  const plus = createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(p, log), env: NO_ENV });
  await assert.rejects(plus.fetch(p.answer), { code: 'plusSignature' }, 'signed with a key the app does not pin');
  await assert.rejects(plus.fetch({ ...p.answer, signature: b64url(new Uint8Array(64)) }), { code: 'plusSignature' });
  assert.deepEqual(log, [], 'not a single download');
  assert.ok(!existsSync(join(dir, 'files')) && !existsSync(join(dir, 'pack.json')), 'nothing on disk');
  trustKey(p);
  // signed, but for another pack than the answer names
  await assert.rejects(plus.fetch({ ...p.answer, packId: 'other-pack' }), { code: 'plusAnswer' });
  assert.equal((await plus.fetch(p.answer)).downloaded, 5);
});

test('server cache: refuses non-envelopes, oversized and failed downloads; a preview file is never stored', async () => {
  const p = await makePack();
  trustKey(p);
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  const html = async () => bodyOf(enc.encode('<html>login</html> and some more bytes'));
  await assert.rejects(createPlusPack({ dir, devDir: '', fetchImpl: html, env: NO_ENV }).fetch(p.answer), { code: 'plusFormat' });
  await assert.rejects(createPlusPack({ dir, devDir: '', fetchImpl: async () => ({ ok: false, status: 403, headers: new Map() }), env: NO_ENV }).fetch(p.answer), { code: 'plusDownload' });
  const big = async () => ({ ok: true, status: 200, headers: new Map([['content-length', String(200 * 1024 * 1024)]]), body: (async function* g() {})() });
  await assert.rejects(createPlusPack({ dir, devDir: '', fetchImpl: big, env: NO_ENV }).fetch(p.answer), { code: 'plusTooLarge' });
  assert.ok(createPlusPack({ dir, devDir: '', env: NO_ENV }).meta().none);
  const plus = createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(p), env: NO_ENV });
  const one = await plus.fetchOne({ url: p.answer.files[0].url });
  assert.deepEqual(new Uint8Array(one), p.sealed.get(p.answer.files[0].url));
  assert.ok(plus.meta().none, 'nothing written for a preview');
  await assert.rejects(plus.fetchOne({ url: 'https://evil.com/x' }), { code: 'plusUrl' });
});

test('dev key: only with a dev pack, or a test service on this computer – never with the production service', () => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  const k = b64url(new Uint8Array(32).fill(7));
  assert.throws(() => createPlusPack({ dir, devDir: '', env: { SLS_PLUS_DEV_KEY: k } }).devKey(), { code: 'plusNoDev' });
  assert.throws(() => createPlusPack({ dir, devDir: '', env: { SLS_PLUS_DEV_KEY: k, SLS_ACCOUNTS_URL: 'https://accounts.souldew.app' } }).devKey(), { code: 'plusNoDev' });
  assert.equal(createPlusPack({ dir, devDir: '', env: { SLS_PLUS_DEV_KEY: k, SLS_ACCOUNTS_URL: 'http://127.0.0.1:8790' } }).devKey().publicKey, k);
});

// ------------------------------------------------------------------ page client on top of the real server module
let server;
let serverNow;
const realNow = Date.now;
function installFetch(packs, { devKey = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-'));
  serverNow = realNow();
  const log = [];
  const state = { broken: null };
  const fetchImpl = async (url) => {
    log.push(url);
    for (const p of [].concat(packs)) {
      if (!p.sealed.has(url)) continue;
      const b = p.sealed.get(url);
      if (state.broken === url) {
        const x = b.slice();
        x[x.length - 3] ^= 1;
        return bodyOf(x);
      }
      return bodyOf(b);
    }
    return { ok: false, status: 404, headers: new Map() };
  };
  server = createPlusPack({ dir, devDir: '', now: () => serverNow, fetchImpl, env: NO_ENV });
  const json = (v) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => v });
  const bytes = (b) => ({ ok: true, status: 200, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) });
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const m = opts.method || 'GET';
    try {
      if (url === '/api/plus/dev/key') return devKey ? json({ publicKey: devKey }) : { ok: false, status: 404, headers: { get: () => '' } };
      if (url === '/api/plus/pack/meta' && m === 'GET') return json(server.meta());
      if (url === '/api/plus/pack/meta' && m === 'POST') return json(server.touch(body));
      if (url === '/api/plus/pack/fetch') return json(await server.fetch(body));
      if (url === '/api/plus/pack' && m === 'DELETE') return json(server.wipe());
      if (url.startsWith('/api/plus/pack/file?')) return bytes(server.file(new URL(url, 'http://x').searchParams.get('path')));
      if (url === '/api/plus/fetch') return bytes(await server.fetchOne(body));
    } catch (e) {
      return { ok: false, status: e.status || 500, headers: { get: () => 'application/json' }, json: async () => ({ code: e.code }) };
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({}) };
  };
  return { log, state };
}

const C = await import('../web/lib/cosmetics/pack/client.mjs');
const S = await import('../web/lib/cosmetics/state.mjs');
const access = (p, extra = {}) => ({ ...p.answer, key: b64url(p.key), until: new Date(realNow() + 30 * DAY).toISOString(), ...extra });
async function trusting(p, fn) {
  K.PRODUCTION_KEYS.push(b64url(p.signer.publicKey));
  try {
    await fn();
  } finally {
    K.PRODUCTION_KEYS.pop();
    C.setPackAccessProvider(async () => null);
    await C.forgetPack();
  }
}

beforeEach(() => { Date.now = realNow; });

test('client: a member loads the pack – content in memory, entitled, nothing premium before that', async () => {
  const p = await makePack();
  installFetch(p);
  await trusting(p, async () => {
    C.setPackAccessProvider(async () => access(p));
    assert.equal(S.has('skins', 'moss'), false);
    await C.refreshPack();
    const st = C.packState();
    assert.deepEqual({ entitled: st.entitled, preview: st.preview, packVersion: st.packVersion, error: st.error }, { entitled: true, preview: false, packVersion: '1.0.0', error: null });
    assert.ok(S.has('skins', 'moss') && S.owned('skins', 'moss'));
    assert.ok(S.content.banners.has('night-marsh') && S.content.banners.has('lcd-grid'), 'pack banners next to the free ones');
    // an older pack still carries the 2D launch animations (launch.mjs): it loads, and they are left alone
    assert.equal(S.content.launchIds, undefined);
    assert.equal(S.content.launchModule, undefined);
  });
});

test('client: the dev key is trusted only when the local server offers it', async () => {
  const p = await makePack();
  installFetch(p, { devKey: b64url((await makeSigner()).publicKey) });
  C.setPackAccessProvider(async () => access(p));
  await C.refreshPack();
  assert.equal(C.packState().error, 'signature', 'another dev key: refused');
  await C.forgetPack();
});

test('client: signed out / no membership → cache wiped, only free content', async () => {
  const p = await makePack();
  installFetch(p);
  await trusting(p, async () => {
    C.setPackAccessProvider(async () => access(p));
    await C.refreshPack();
    C.setPackAccessProvider(async () => null);
    await C.refreshPack();
    assert.equal(C.packState().entitled, false);
    assert.ok(server.meta().none, 'cache wiped');
    assert.equal(S.has('skins', 'moss'), false);
    assert.ok(S.content.banners.has('lcd-grid') && !S.content.banners.has('night-marsh'));
  });
});

test('client: membership ended (until in the past) → wiped, error "expired"', async () => {
  const p = await makePack();
  installFetch(p);
  await trusting(p, async () => {
    C.setPackAccessProvider(async () => access(p));
    await C.refreshPack();
    C.setPackAccessProvider(async () => access(p, { until: new Date(realNow() - 1000).toISOString() }));
    await C.refreshPack();
    assert.equal(C.packState().entitled, false);
    assert.equal(C.packState().error, 'expired');
    assert.ok(server.meta().none);
  });
});

test('client: pack_key_id changed (sign out everywhere, unlink) → the cache is wiped and loaded again for the new key', async () => {
  const signer = await makeSigner();
  const p1 = await makePack({ signer, kid: '1' });
  const p2 = await makePack({ signer, kid: '2' });
  const { log } = installFetch([p1, p2]);
  await trusting(p1, async () => {
    C.setPackAccessProvider(async () => access(p1));
    await C.refreshPack();
    const before = log.length;
    C.setPackAccessProvider(async () => access(p2));
    await C.refreshPack();
    assert.equal(C.packState().entitled, true);
    assert.equal(server.meta().keyId, '2');
    assert.equal(log.length - before, 5, 'everything downloaded again for the new key');
    // offline with an old key in hand: the cache (now for key 2) is not opened with it – wiped
    C.setPackAccessProvider(async () => ({ key: b64url(p1.key), keyId: '1', offline: true }));
    await C.refreshPack();
    assert.equal(C.packState().entitled, false);
    assert.ok(server.meta().none);
  });
});

test('client: offline grace – works from the cache for 7 days, then the cache is wiped', async () => {
  const p = await makePack();
  const { log } = installFetch(p);
  await trusting(p, async () => {
    C.setPackAccessProvider(async () => access(p));
    await C.refreshPack();
    assert.equal(log.length, 5);
    // the service is unreachable: the account client hands out the key it kept (safeStorage)
    C.setPackAccessProvider(async () => ({ key: b64url(p.key), keyId: p.kid, until: null, offline: true }));
    serverNow = realNow() + 6 * DAY;
    Date.now = () => serverNow;
    await C.refreshPack();
    assert.equal(C.packState().entitled, true, 'day 6 offline: still entitled');
    assert.equal(C.packState().error, 'offline');
    assert.equal(log.length, 5, 'no download while offline');
    // the provider throwing counts as offline too – but without a key the cache can't be read
    C.setPackAccessProvider(async () => { throw new Error('ENOTFOUND'); });
    await C.refreshPack();
    assert.equal(C.packState().error, 'offline');
    assert.ok(!server.meta().none, 'kept for when the key is back');
    serverNow = realNow() + 8 * DAY;
    Date.now = () => serverNow;
    C.setPackAccessProvider(async () => ({ key: b64url(p.key), keyId: p.kid, offline: true }));
    await C.refreshPack();
    assert.equal(C.packState().entitled, false, 'day 8 offline: over');
    assert.ok(server.meta().none, 'wiped');
    assert.equal(S.has('skins', 'moss'), false);
  });
});

test('client: a pack that does not verify is wiped and never used', async () => {
  const p = await makePack();
  installFetch(p);
  // signed with a throwaway key, not the pinned production key: nothing verifies
  C.setPackAccessProvider(async () => access(p));
  await C.refreshPack();
  assert.equal(C.packState().entitled, false);
  assert.equal(C.packState().error, 'signature');
  assert.ok(server.meta().none);
  assert.equal(S.has('skins', 'moss'), false);
});

test('client: a damaged download is fetched once more from scratch; a wrong key fails cleanly; nothing half-used', async () => {
  const p = await makePack();
  const { log, state } = installFetch(p);
  await trusting(p, async () => {
    state.broken = p.answer.files[3].url;
    C.setPackAccessProvider(async () => access(p));
    await C.refreshPack();
    assert.equal(C.packState().error, 'decrypt');
    assert.equal(log.length, 10, 'one retry of the whole pack, then it stops');
    assert.equal(S.has('skins', 'moss'), false, 'the files that were fine are not used either');
    state.broken = null;
    await C.refreshPack();
    assert.equal(C.packState().entitled, true);
    C.setPackAccessProvider(async () => access(p, { key: b64url(new Uint8Array(32)) }));
    await C.refreshPack();
    assert.equal(C.packState().entitled, false);
    assert.equal(S.has('skins', 'moss'), false);
  });
});

test('client: a live preview – skins only, in memory, nothing owned, nothing stored, gone at expires_at', async () => {
  const signer = await makeSigner();
  const pv = await makePack({ signer, id: 'skins-preview', kind: 'preview', kid: 'pv_0123456789abcdefABCDEF',
    files: [FILES()[1], FILES()[2]] }); // stylesheets and images only – no contents.json
  installFetch(pv);
  await trusting(pv, async () => {
    let until = new Date(realNow() + 15 * 60e3).toISOString();
    C.setPackAccessProvider(async ({ purpose }) => (purpose === 'preview' ? { ...access(pv), until: null, expiresAt: until, preview: true } : null));
    await C.refreshPack();
    assert.equal(C.packState().preview, false, 'never started on its own');
    await C.startPackPreview();
    assert.equal(C.packState().preview, true);
    assert.equal(C.packState().previewUntil, until);
    assert.equal(C.packState().entitled, false);
    assert.ok(S.has('skins', 'moss'));
    assert.equal(S.owned('skins', 'moss'), false);
    assert.ok(server.meta().none, 'nothing on disk');
    await C.refreshPack(); // the membership check of a non-member keeps the preview
    assert.ok(S.has('skins', 'moss'));
    C.endPackPreview();
    assert.equal(C.packState().preview, false);
    assert.equal(S.has('skins', 'moss'), false);
    // the time runs out by itself
    until = new Date(realNow() + 80).toISOString();
    await C.startPackPreview();
    assert.ok(S.has('skins', 'moss'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(C.packState().preview, false);
    assert.equal(S.has('skins', 'moss'), false);
    // the service says no: the reason comes through
    C.setPackAccessProvider(async () => { throw Object.assign(new Error('x'), { code: 'rate_limited' }); });
    await assert.rejects(C.startPackPreview(), { code: 'rate_limited' });
    // a full pack can't pose as a preview
    const full = await makePack({ signer });
    installFetch(full);
    C.setPackAccessProvider(async () => ({ ...access(full), expiresAt: new Date(realNow() + 60e3).toISOString(), preview: true }));
    await assert.rejects(C.startPackPreview(), { code: 'manifest' });
  });
});
