// souldew+ asset protection, the parts around the pack (audit of 18.11.26): the member's pack key is bound to the
// signed-in session (key id <epoch>_<session tag>), a data folder copied to another computer opens nothing, and the dev
// paths are gone from a packaged build.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createPlusPack } from '../server/lib/pluspack.mjs';
import { createPlusPreviews } from '../server/lib/pluspreviews.mjs';
import { createTokenStore } from '../server/lib/accounts/store.mjs';
import { buildManifest, sealFile, makeSigner, b64url, openFile, parseManifest, KID_RE } from '../web/lib/cosmetics/pack/format.mjs';
import * as K from '../web/lib/cosmetics/pack/keys.mjs';

const PINNED = [...K.PRODUCTION_KEYS];
afterEach(() => K.PRODUCTION_KEYS.splice(0, K.PRODUCTION_KEYS.length, ...PINNED));
const enc = new TextEncoder();
const BASE = 'https://accounts.souldew.app/v1/packs/souldew-plus';
const NO_ENV = {};
const SESSION_A = '7_AbCdEfGhIjKlMnOp';
const SESSION_B = '7_ZyXwVuTsRqPoNmLk';

async function makePack(kid, key = globalThis.crypto.getRandomValues(new Uint8Array(32))) {
  const signer = await makeSigner();
  const files = [{ path: 'banners.json', bytes: enc.encode('[]') }, { path: 'handheld/looks.json', bytes: enc.encode('{"v":1}') }];
  const { manifest, manifestBytes } = await buildManifest({ id: 'souldew-plus', version: '1.0.0', kind: 'mixed', title: 'Test', files });
  const sealed = new Map();
  for (const f of files) sealed.set(`${BASE}/1.0.0/file?path=${encodeURIComponent(f.path)}&k=${kid}`, await sealFile({ pack: 'souldew-plus', version: '1.0.0', path: f.path, wm: 'wm_acct', kid, key, bytes: f.bytes }));
  return {
    signer, key, kid, manifest, sealed,
    answer: {
      packId: 'souldew-plus', version: '1.0.0', manifest: b64url(manifestBytes), signature: b64url(await signer.sign(manifestBytes)), keyId: kid, watermark: 'wm_acct',
      files: manifest.files.map((f) => ({ path: f.path, url: `${BASE}/1.0.0/file?path=${encodeURIComponent(f.path)}&k=${kid}` })),
    },
  };
}
const bodyOf = (bytes) => ({ ok: true, status: 200, headers: new Map([['content-length', String(bytes.length)]]), body: (async function* chunks() { yield bytes; })() });
const fakeFetch = (p) => async (url) => (p.sealed.has(url) ? bodyOf(p.sealed.get(url)) : { ok: false, status: 404, headers: new Map(), body: null });

test('key ids: a member\'s key is bound to the session (<epoch>_<16-char session tag>); the plain epoch of an older service still reads', () => {
  for (const ok of [SESSION_A, '1', '123456789_A-_b0123456789AB', 'pv_abcdefghijklmnopqrstuv']) assert.ok(KID_RE.test(ok), ok);
  for (const bad of ['7_short', '7_AbCdEfGhIjKlMnOp_', '7-AbCdEfGhIjKlMnOp', '_AbCdEfGhIjKlMnOp', '7_AbCdEfGh/jKlMnOp', '1234567890_AbCdEfGhIjKlMnOp', '', 'x']) assert.equal(KID_RE.test(bad), false, bad);
});

test('session-bound key: the cache takes the new key id, the page opens the files – and another session\'s envelope is refused', async () => {
  const p = await makePack(SESSION_A);
  K.PRODUCTION_KEYS.push(b64url(p.signer.publicKey));
  const dir = mkdtempSync(join(tmpdir(), 'souldew-plus-sess-'));
  const plus = createPlusPack({ dir, devDir: '', fetchImpl: fakeFetch(p), env: NO_ENV });
  const meta = await plus.fetch({ ...p.answer, until: null });
  assert.equal(meta.keyId, SESSION_A);
  const entry = parseManifest(Buffer.from(p.answer.manifest, 'base64url')).files.find((f) => f.path === 'banners.json');
  const opened = await openFile(plus.file('banners.json'), p.key, { pack: 'souldew-plus', kid: SESSION_A, entry });
  assert.equal(new TextDecoder().decode(opened.bytes), '[]');
  // the same account signed in elsewhere has its own key id (and key): this computer's envelope isn't for it
  await assert.rejects(openFile(plus.file('banners.json'), p.key, { pack: 'souldew-plus', kid: SESSION_B, entry }), { code: 'envelope' });
  await assert.rejects(openFile(plus.file('banners.json'), globalThis.crypto.getRandomValues(new Uint8Array(32)), { pack: 'souldew-plus', kid: SESSION_A, entry }), { code: 'decrypt' });
  // a key id that isn't one is refused before anything is downloaded
  await assert.rejects(plus.fetch({ ...p.answer, keyId: '7_../../etc' }), { code: 'plusAnswer' });
});

test('a data folder copied to another computer opens nothing: the key is in this computer\'s keychain, the cache only holds envelopes', async () => {
  // two computers' keychains (Electron safeStorage: macOS Keychain / DPAPI / Secret Service – a key per user and machine)
  const keychain = () => {
    const k = randomBytes(32);
    return {
      available: () => true,
      encrypt: (s) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', k, iv); const b = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
      decrypt: (buf) => { const d = createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'); },
    };
  };
  const p = await makePack(SESSION_A);
  K.PRODUCTION_KEYS.push(b64url(p.signer.publicKey));
  const mine = mkdtempSync(join(tmpdir(), 'souldew-member-'));
  // the member's computer: tokens + the entitlement with the pack key in account.bin (encrypted by the keychain) …
  const store = createTokenStore(keychain(), { file: join(mine, 'account.bin') });
  assert.equal(await store.save({ refresh: 'r', extra: { entitlement: { packKey: b64url(p.key), packKeyId: SESSION_A } } }), true);
  // … and the encrypted pack cache
  await createPlusPack({ dir: join(mine, 'plus'), devDir: '', fetchImpl: fakeFetch(p), env: NO_ENV }).fetch({ ...p.answer, until: null });
  // copied whole to a friend's computer
  const theirs = mkdtempSync(join(tmpdir(), 'souldew-copy-'));
  cpSync(mine, theirs, { recursive: true });
  const copied = createTokenStore(keychain(), { file: join(theirs, 'account.bin') });
  await assert.rejects(copied.load(), { code: 'unreadable' }, 'their keychain can\'t open the session: signed out, no pack key');
  const cache = createPlusPack({ dir: join(theirs, 'plus'), devDir: '', env: NO_ENV });
  const env = cache.file('banners.json');
  assert.ok(Buffer.from(env).subarray(0, 4).toString('latin1') === 'SDP1' && !Buffer.from(env).includes('[]'), 'only the envelope is on disk');
  // and without the key not one file opens (the page's pack client wipes the cache when the account says "signed out")
  const entry = parseManifest(Buffer.from(p.answer.manifest, 'base64url')).files.find((f) => f.path === 'banners.json');
  await assert.rejects(openFile(env, globalThis.crypto.getRandomValues(new Uint8Array(32)), { pack: 'souldew-plus', kid: SESSION_A, entry }), { code: 'decrypt' });
});

test('packaged build: no dev pack, no dev key, no dev URLs – even with every dev switch set', async () => {
  const dev = mkdtempSync(join(tmpdir(), 'souldew-devpack-'));
  writeFileSync(join(dev, 'access.json'), JSON.stringify({ publicKey: 'A'.repeat(43) }));
  writeFileSync(join(dev, 'access-preview.json'), JSON.stringify({ publicKey: 'A'.repeat(43) }));
  const env = { SLS_PLUS_DEV_PACK: dev, SLS_PLUS_DEV_KEY: 'B'.repeat(43), SLS_ACCOUNTS_URL: 'http://127.0.0.1:8788' };
  const dir = mkdtempSync(join(tmpdir(), 'souldew-packaged-'));
  const packaged = createPlusPack({ dir, devDir: dev, env, packaged: true });
  assert.equal(packaged.dev, false);
  assert.throws(() => packaged.devAccess('pack'), { status: 404 });
  assert.throws(() => packaged.devAccess('preview'), { status: 404 });
  assert.throws(() => packaged.devKey(), { status: 404 });
  await assert.rejects(packaged.fetchOne({ url: 'souldew-dev:preview/skins/moss.css' }), { code: 'plusUrl' });
  // the same switches in development do open them (so the test above means something)
  const devBuild = createPlusPack({ dir, devDir: dev, env, packaged: false });
  assert.equal(devBuild.dev, true);
  assert.equal(devBuild.devKey().publicKey, 'A'.repeat(43));
  // the preview media don't read the dev folder in a packaged build either: they ask the service
  const asked = [];
  const pv = createPlusPreviews({ dir, devDir: dev, env, packaged: true, fetchImpl: async (u) => { asked.push(String(u)); return { ok: false, status: 503, headers: new Map() }; } });
  assert.deepEqual(await pv.state(), { none: true });
  assert.equal(asked.length, 1, 'the service was asked, not the dev folder');
});
