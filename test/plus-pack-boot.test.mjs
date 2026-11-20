// souldew+ pack at start: the account is read in the background (the saved sign-in may wait for the keychain), so right
// after start the player only LOOKS signed out. The pack must not be wiped then (it was: refreshPack() at boot ended in
// DELETE /api/plus/pack, and every member downloaded the pack again at every start). It is removed only once the account
// is known and really signed out, or the membership really ended.
// The page's real account client (web/lib/account.mjs) and pack client (web/lib/cosmetics/pack/client.mjs) on top of the
// real server cache (server/lib/pluspack.mjs); the account routes of the local server are simulated.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { createPlusPack } from '../server/lib/pluspack.mjs';
import { buildManifest, sealFile, makeSigner, b64url } from '../web/lib/cosmetics/pack/format.mjs';
import * as K from '../web/lib/cosmetics/pack/keys.mjs';

const ROOT = new URL('../', import.meta.url);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(new URL('node_modules/htm/preact/standalone.module.js', ROOT).href, ctx);
    return spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx);
  },
});

const C = await import('../web/lib/cosmetics/pack/client.mjs');
const S = await import('../web/lib/cosmetics/state.mjs');
let boots = 0;
/** A fresh start of the page's account client (its own module instance: nothing known yet). */
const bootAccount = () => import(`../web/lib/account.mjs?boot=${++boots}`);

const PINNED = [...K.PRODUCTION_KEYS];
afterEach(async () => {
  C.setPackAccessProvider(async () => null);
  await C.forgetPack();
  K.PRODUCTION_KEYS.splice(0, K.PRODUCTION_KEYS.length, ...PINNED);
});

const enc = new TextEncoder();
const DAY = 86400e3;
const BASE = 'https://accounts.souldew.app/v1/packs/souldew-plus';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const FILES = [
  { path: 'contents.json', bytes: enc.encode(JSON.stringify({ skins: [{ id: 'moss', css: 'skins/moss.css' }] })) },
  { path: 'skins/moss.css', bytes: enc.encode("html[data-skin='moss'] { --shell: #1f2a20; }") },
];

async function makePack() {
  const signer = await makeSigner();
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const kid = '1';
  const version = '1.0.0';
  const { manifest, manifestBytes } = await buildManifest({ id: 'souldew-plus', version, kind: 'mixed', title: 'Test', files: FILES });
  const signature = await signer.sign(manifestBytes);
  const sealed = new Map();
  for (const f of FILES) sealed.set(`${BASE}/${version}/file?path=${encodeURIComponent(f.path)}&k=${kid}`, await sealFile({ pack: 'souldew-plus', version, path: f.path, wm: 'wm_acct', kid, key, bytes: f.bytes }));
  const answer = {
    packId: 'souldew-plus', version, manifest: b64url(manifestBytes), signature: b64url(signature), keyId: kid, watermark: 'wm_acct',
    files: manifest.files.map((f) => ({ path: f.path, url: `${BASE}/${version}/file?path=${encodeURIComponent(f.path)}&k=${kid}` })),
  };
  K.PRODUCTION_KEYS.push(b64url(signer.publicKey));
  return { key, kid, sealed, answer };
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const bytes = (b) => new Response(b, { headers: { 'content-type': 'application/octet-stream' } });

/**
 * The local server as the page sees it: the account (read in the background – `account.loaded`), the member's
 * entitlement and pack download answer, and the real encrypted pack cache. `log` = every page call, `downloads` =
 * every file the server fetched from the service.
 */
function localServer(p) {
  const downloads = [];
  const fetchImpl = async (url) => {
    downloads.push(url);
    const b = p.sealed.get(url);
    if (!b) return { ok: false, status: 404, headers: new Map() };
    return { ok: true, status: 200, headers: new Map([['content-length', String(b.length)]]), body: (async function* chunks() { yield b; })() };
  };
  const cache = createPlusPack({ dir: mkdtempSync(join(tmpdir(), 'souldew-plus-boot-')), devDir: '', fetchImpl, env: {} });
  const account = { loaded: false, signedIn: true, tier: 'plus', until: Date.now() + 30 * DAY };
  const log = [];
  globalThis.fetch = async (url, opts = {}) => {
    const m = opts.method || 'GET';
    log.push(`${m} ${url}`);
    const body = opts.body ? JSON.parse(opts.body) : {};
    try {
      if (url === '/api/account') {
        const signedIn = account.loaded && account.signedIn;
        return json({ session: { signedIn, loaded: account.loaded, persistent: true, condition: null, pending: false, account: signedIn ? { id: 'u_kim', handle: 'kimchi' } : null }, me: null, brief: null, pending: null, service: 'accounts.souldew.app' });
      }
      if (url === '/api/account/entitlements') {
        const plus = account.tier === 'plus';
        return json({ tier: account.tier, until: plus ? account.until : null, packKey: plus ? b64url(p.key) : null, packKeyId: plus ? p.kid : null });
      }
      if (url === '/api/account/packs') return json({ items: [{ id: 'souldew-plus', kind: 'mixed', entitled: account.tier === 'plus' }] });
      if (url === '/api/account/packs/souldew-plus/download') return json({ ...p.answer, packKeyId: p.kid, watermarkId: p.answer.watermark });
      if (url === '/api/plus/pack/meta' && m === 'GET') return json(cache.meta());
      if (url === '/api/plus/pack/meta' && m === 'POST') return json(cache.touch(body));
      if (url === '/api/plus/pack/fetch') return json(await cache.fetch(body));
      if (url === '/api/plus/pack' && m === 'DELETE') return json(cache.wipe());
      if (url.startsWith('/api/plus/pack/file?')) return bytes(cache.file(new URL(url, 'http://x').searchParams.get('path')));
    } catch (e) {
      return json({ code: e.code }, e.status || 500);
    }
    return json({}, 404); // /api/plus/dev/* – an installed app has no dev pack
  };
  return { cache, account, log, downloads, deletes: () => log.filter((l) => l === 'DELETE /api/plus/pack').length };
}

/** As app.mjs boots: the pack through the account, the dev pack (here: none) for a signed-out player. */
const appProvider = (A) => (o) => A.cosmeticsPackAccess({ ...o, signedOut: C.devPackAccess });

/** The member's pack from the session before (on disk, encrypted). */
async function cachedFromLastTime(srv, p) {
  await srv.cache.fetch({ ...p.answer, until: new Date(srv.account.until).toISOString() });
  srv.downloads.length = 0;
}

test('a souldew+ member at start: no DELETE while the account is still being read – the cached pack is kept and used', async () => {
  const p = await makePack();
  const srv = localServer(p);
  await cachedFromLastTime(srv, p);
  const A = await bootAccount();
  C.setPackAccessProvider(appProvider(A));
  const boot = C.refreshPack(); // app.mjs bootUp
  await tick(60);
  // the keychain is still asking: the page has heard "signed out" – and does nothing with it
  assert.equal(A.accountState().session.signedIn, false);
  assert.equal(A.accountKnown(), false);
  assert.equal(srv.deletes(), 0, 'no DELETE /api/plus/pack');
  assert.ok(!srv.cache.meta().none, 'the cache is still there');
  assert.ok(!srv.log.includes('GET /api/account/entitlements'), 'no decision yet');
  // the saved sign-in is read: the server tells the page (event 'account')
  srv.account.loaded = true;
  A.accountEvent({ kind: 'session' });
  await boot;
  assert.equal(A.accountKnown(), true);
  assert.equal(A.signedIn(), true);
  assert.equal(srv.deletes(), 0, 'still no DELETE');
  assert.deepEqual(srv.downloads, [], 'nothing downloaded again – the cache was used');
  assert.ok(srv.log.includes('POST /api/plus/pack/meta'), 'the same pack: only its membership confirmation was refreshed');
  const st = C.packState();
  assert.deepEqual({ entitled: st.entitled, packVersion: st.packVersion, error: st.error }, { entitled: true, packVersion: '1.0.0', error: null });
  assert.ok(S.has('skins', 'moss') && S.owned('skins', 'moss'), 'the cached pack is in use');
});

test('the event that says "known" can be missed (event stream not connected yet): the page asks again by itself', async () => {
  const p = await makePack();
  const srv = localServer(p);
  await cachedFromLastTime(srv, p);
  const A = await bootAccount();
  C.setPackAccessProvider(appProvider(A));
  const boot = C.refreshPack();
  await tick(60);
  srv.account.loaded = true; // … and no event reaches the page
  // The re-check timer is unref()'d (it must never keep the app's server alive); in the browser that means nothing,
  // here Node would see an empty event loop and end the test – a plain interval keeps it running meanwhile.
  const keepAlive = setInterval(() => {}, 100);
  try { await boot; } finally { clearInterval(keepAlive); } // the account client's own re-check (about a second)
  assert.equal(srv.deletes(), 0);
  assert.deepEqual(srv.downloads, []);
  assert.equal(C.packState().entitled, true);
});

test('a reload asked for while one is on its way is not lost (its answer may be older than the news)', async () => {
  const p = await makePack();
  const srv = localServer(p);
  const A = await bootAccount();
  const first = A.reloadAccount(); // the boot's: the server still reads the saved sign-in
  srv.account.loaded = true; // the read finishes while that answer is on its way …
  A.accountEvent({ kind: 'session' }); // … and the event comes before it is back
  await first;
  await tick(20);
  assert.equal(A.accountKnown(), true);
  assert.equal(A.signedIn(), true);
});

test('a real sign-out (the account is known and signed out): the pack is removed', async () => {
  const p = await makePack();
  const srv = localServer(p);
  srv.account.loaded = true;
  const A = await bootAccount();
  C.setPackAccessProvider(appProvider(A));
  await C.refreshPack();
  assert.equal(C.packState().entitled, true);
  assert.equal(srv.deletes(), 0);
  // signed out (here, or everywhere from another device): the server says so, the page reloads its account view
  srv.account.signedIn = false;
  A.accountEvent({ kind: 'session' });
  await tick(20);
  assert.equal(A.accountKnown(), true);
  assert.equal(A.signedIn(), false);
  await C.refreshPack(); // the next check (sign-out effect, the 6-hour check)
  assert.equal(srv.deletes(), 1, 'DELETE /api/plus/pack');
  assert.ok(srv.cache.meta().none, 'the cache is gone');
  assert.equal(C.packState().entitled, false);
  assert.equal(S.has('skins', 'moss'), false);
});

test('signed out at start for real (nothing saved): known – the old cache is removed', async () => {
  const p = await makePack();
  const srv = localServer(p);
  await cachedFromLastTime(srv, p);
  srv.account.signedIn = false;
  const A = await bootAccount();
  C.setPackAccessProvider(appProvider(A));
  const boot = C.refreshPack();
  await tick(60);
  assert.equal(srv.deletes(), 0, 'not while unknown');
  srv.account.loaded = true;
  A.accountEvent({ kind: 'session' });
  await boot;
  assert.equal(srv.deletes(), 1);
  assert.ok(srv.cache.meta().none);
});

test('the membership ended (the verified tier is no longer souldew+): the pack is removed', async () => {
  const p = await makePack();
  const srv = localServer(p);
  srv.account.loaded = true;
  const A = await bootAccount();
  C.setPackAccessProvider(appProvider(A));
  await C.refreshPack();
  assert.equal(C.packState().entitled, true);
  srv.account.tier = 'none';
  await C.refreshPack();
  assert.equal(srv.deletes(), 1);
  assert.ok(srv.cache.meta().none);
  assert.equal(C.packState().entitled, false);
  assert.equal(S.has('skins', 'moss'), false);
});

test('the membership ended (its end date passed): the pack is removed, "expired"', async () => {
  const p = await makePack();
  const srv = localServer(p);
  srv.account.loaded = true;
  const A = await bootAccount();
  C.setPackAccessProvider(appProvider(A));
  await C.refreshPack();
  assert.equal(C.packState().entitled, true);
  srv.account.until = Date.now() - 1000;
  await C.refreshPack();
  assert.equal(srv.deletes(), 1);
  assert.ok(srv.cache.meta().none);
  assert.equal(C.packState().error, 'expired');
});

test('the app wires it this way: the account provider before the boot refresh, nothing in the shell before the account is known', () => {
  const app = readFileSync(new URL('web/app.mjs', ROOT), 'utf8');
  const boot = app.slice(app.indexOf('const bootUp = useCallback'), app.indexOf('const lang = await setLang'));
  assert.match(boot, /setPackAccessProvider\(\(o\) => cosmeticsPackAccess\(\{ \.\.\.o, signedOut: devPackAccess \}\)\);\s*(\/\/[^\n]*\n\s*)*refreshPack\(\)/, 'the provider is set before the boot refresh');
  const social = readFileSync(new URL('web/lib/socialapp.mjs', ROOT), 'utf8');
  assert.ok(!/setPackAccessProvider/.test(social), 'the shell no longer swaps in the signed-out default while the account is unknown');
  assert.match(social, /if \(!acct\.known\) return;\s*if \(on\) refreshPack\(\)[^\n]*\n\s*else if \(wasOn\.current\) forgetPack\(\)/, 'refresh / forget only once the account is known');
});
