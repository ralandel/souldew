// souldew+ preview media on this computer (server/lib/pluspreviews.mjs): everyone – signed in or not – sees the
// pictures of every premium item, but only pictures whose manifest is signed with a trusted pack key and whose bytes
// match it; nothing but PNG / WebP at <kind>/<id> gets through, and the service's answer is cached for offline use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, makeSigner, b64url } from '../web/lib/cosmetics/pack/format.mjs';
import { createPlusPreviews, readPreviewsManifest } from '../server/lib/pluspreviews.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8X'), Buffer.alloc(40, 3)]);
const MEDIA = { 'banners/night-marsh.png': PNG, 'banners/night-marsh.webp': WEBP, 'frames/corona.png': PNG, 'skins/sakura.webp': WEBP };

async function signed(files, { kind = 'previews', signer } = {}) {
  const s = signer || (await makeSigner());
  const { manifestBytes } = await buildManifest({ id: 'souldew-previews', version: '1.0.0', kind, title: 'previews', files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: new Uint8Array(bytes) })) });
  return { manifest: b64url(manifestBytes), signature: b64url(await s.sign(manifestBytes)), publicKey: b64url(s.publicKey), signer: s };
}

/** a fake accounts service: GET /v1/previews and the pictures */
function service(answer, files, calls = []) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/v1/previews') return answer ? new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 });
    const m = /^\/v1\/previews\/1\.0\.0\/(.+)$/.exec(u.pathname);
    if (m && files[m[1]]) return new Response(files[m[1]], { status: 200 });
    return new Response('no', { status: 404 });
  };
}

test('the manifest: a trusted signature, kind "previews", pictures at <kind>/<id>.png|webp only', async () => {
  const a = await signed(MEDIA);
  const p = readPreviewsManifest(a.manifest, a.signature, a.publicKey);
  assert.equal(p.version, '1.0.0');
  assert.deepEqual([...p.files.keys()].sort(), Object.keys(MEDIA).sort());
  assert.throws(() => readPreviewsManifest(a.manifest, a.signature, null), /not signed by souldew/, 'an untrusted key (no dev key) is refused');
  const other = await signed(MEDIA);
  assert.throws(() => readPreviewsManifest(a.manifest, other.signature, a.publicKey), /not signed/);
  for (const bad of [{ 'banners.json': Buffer.from('[]') }, { 'frames.mjs': Buffer.from('export {}') }, { 'skins/x.css': Buffer.from('html{}') }, { 'banners/sub/x.png': PNG }]) {
    const b = await signed(bad, { signer: a.signer });
    assert.throws(() => readPreviewsManifest(b.manifest, b.signature, a.publicKey), /Bad preview file/, Object.keys(bad)[0]);
  }
  const wrongKind = await signed(MEDIA, { kind: 'mixed', signer: a.signer });
  assert.throws(() => readPreviewsManifest(wrongKind.manifest, wrongKind.signature, a.publicKey), /Bad previews/);
});

test('from the service: verified pictures with their own type, cached on disk; a changed byte is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-previews-'));
  const a = await signed(MEDIA);
  const calls = [];
  const env = { SLS_ACCOUNTS_URL: 'http://127.0.0.1:8788', SLS_PLUS_DEV_KEY: a.publicKey };
  // the production key list doesn't know this throwaway key: trust it the way dev mode does (a dev folder) …
  const devDir = mkdtempSync(join(tmpdir(), 'souldew-previews-dev-'));
  writeFileSync(join(devDir, 'access.json'), JSON.stringify({ publicKey: a.publicKey }));
  writeFileSync(join(devDir, 'access-previews.json'), JSON.stringify({ manifest: a.manifest, signature: a.signature, publicKey: a.publicKey }));
  mkdirSync(join(devDir, 'previews', 'banners'), { recursive: true });
  mkdirSync(join(devDir, 'previews', 'frames'), { recursive: true });
  mkdirSync(join(devDir, 'previews', 'skins'), { recursive: true });
  for (const [p, b] of Object.entries(MEDIA)) writeFileSync(join(devDir, 'previews', ...p.split('/')), b);
  const pv = createPlusPreviews({ dir, devDir, env, fetchImpl: service(null, {}, calls) });
  const st = await pv.state();
  assert.equal(st.version, '1.0.0');
  assert.equal(st.files['frames/corona.png'], true);
  const f = await pv.file('skins/sakura.webp');
  assert.equal(f.type, 'image/webp');
  assert.deepEqual(Buffer.from(f.bytes), WEBP);
  assert.equal(readdirSync(join(dir, 'previews')).length, 1, 'cached by its hash');
  await assert.rejects(pv.file('banners/nope.png'), /No such preview/);
  await assert.rejects(pv.file('../access.json'), /No such preview/);
  // a picture that doesn't match the signed manifest
  writeFileSync(join(devDir, 'previews', 'frames', 'corona.png'), Buffer.concat([PNG, Buffer.from('x')]));
  await assert.rejects(pv.file('frames/corona.png'), /does not match/);
  assert.equal(calls.length, 0, 'dev mode never asks the service');
  rmSync(dir, { recursive: true, force: true });
  rmSync(devDir, { recursive: true, force: true });
});

test('the real service path: GET /v1/previews and the pictures from the same origin; offline → the last good manifest', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'souldew-previews-')), 'plus'); // not there yet, as on a fresh install
  const a = await signed(MEDIA);
  const calls = [];
  const env = { SLS_ACCOUNTS_URL: 'http://127.0.0.1:8788' };
  // the throwaway key stands in for the pinned production key here
  const keys = await import('../web/lib/cosmetics/pack/keys.mjs');
  const pinned = keys.PRODUCTION_KEYS;
  pinned.push(a.publicKey);
  try {
    let now = 0;
    const pv = createPlusPreviews({ dir, env, now: () => now, fetchImpl: service({ pack_id: 'souldew-previews', version: '1.0.0', manifest: a.manifest, signature: a.signature }, MEDIA, calls) });
    assert.equal((await pv.state()).version, '1.0.0');
    assert.deepEqual(Buffer.from((await pv.file('banners/night-marsh.png')).bytes), PNG);
    assert.ok(calls.includes('http://127.0.0.1:8788/v1/previews/1.0.0/banners/night-marsh.png'));
    assert.ok(existsSync(join(dir, 'previews.json')), 'kept for offline use');
    // a forged answer is refused even from the right host
    const forged = createPlusPreviews({ dir: mkdtempSync(join(tmpdir(), 'souldew-previews-')), env, fetchImpl: service({ manifest: a.manifest, signature: (await signed(MEDIA)).signature }, MEDIA) });
    assert.deepEqual(await forged.state(), { none: true });
    // offline later: the manifest on disk (checked again) still works, cached pictures too
    now = 60 * 60e3;
    const offline = createPlusPreviews({ dir, env, now: () => now, fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal((await offline.state()).version, '1.0.0');
    assert.deepEqual(Buffer.from((await offline.file('banners/night-marsh.png')).bytes), PNG);
  } finally {
    pinned.splice(pinned.indexOf(a.publicKey), 1);
    rmSync(dir, { recursive: true, force: true });
  }
});
