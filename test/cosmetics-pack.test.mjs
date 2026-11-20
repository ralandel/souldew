// souldew+ pack format (the accounts service's: a signed manifest + one AES-256-GCM envelope per file): the signature
// (valid / invalid / tampered / wrong key / no production key yet), the per-file envelopes (wrong key, edited
// ciphertext, edited header, another file's or another pack's envelope, the watermark trailer), the file hashes, the
// manifest's shape – and an envelope made exactly the way the Worker makes it opens here (interoperability).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createCipheriv, randomBytes } from 'node:crypto';
import {
  buildManifest, sealFile, openFile, openPack, parseEnvelope, verifySignature, makeSigner, checkManifest, b64url, b64decode, sha256, FORMAT,
} from '../web/lib/cosmetics/pack/format.mjs';
import { PRODUCTION_KEYS, trustedKeys } from '../web/lib/cosmetics/pack/keys.mjs';

const enc = new TextEncoder();
const files = [
  { path: 'contents.json', bytes: enc.encode(JSON.stringify({ skins: [{ id: 'moss', css: 'skins/moss.css' }], banners: 'banners.json' })) },
  { path: 'skins/moss.css', bytes: enc.encode("html[data-skin='moss'] { --shell: #1f2a20; }") },
  { path: 'banners.json', bytes: enc.encode('[{"id":"x","pal":{},"layers":[]}]') },
  { path: 'assets/a.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
];
const randKey = () => webcrypto.getRandomValues(new Uint8Array(32));
const WM = 'wm_acct42';

async function fixture({ kid = '3' } = {}) {
  const signer = await makeSigner();
  const { manifest, manifestBytes } = await buildManifest({ id: 'souldew-plus', version: '1.0.0', kind: 'mixed', title: 'Test', files });
  const sig = await signer.sign(manifestBytes);
  const key = randKey();
  const envs = new Map();
  for (const f of files) envs.set(f.path, await sealFile({ pack: 'souldew-plus', version: '1.0.0', path: f.path, wm: WM, kid, key, bytes: f.bytes }));
  const open = (patch = {}) => openPack({ manifest: manifestBytes, signature: sig, keys: [signer.publicKey], key, kid, envelope: (p) => envs.get(p), ...patch });
  return { signer, manifest, manifestBytes, sig, key, envs, kid, open };
}

test('a valid pack opens: every file, the watermark, the manifest', async () => {
  const f = await fixture();
  const p = await f.open({ signature: b64url(f.sig), manifest: b64url(f.manifestBytes), key: b64url(f.key), keys: [b64url(f.signer.publicKey)] });
  assert.deepEqual([...p.files.keys()], files.map((x) => x.path));
  assert.equal(new TextDecoder().decode(p.files.get('skins/moss.css')), "html[data-skin='moss'] { --shell: #1f2a20; }", 'the trailer is stripped');
  assert.deepEqual([...p.watermarks], [WM]);
  assert.equal(p.manifest.format, FORMAT);
});

test('signature: valid, invalid, tampered manifest, wrong key – checked before anything else', async () => {
  const f = await fixture();
  const keys = [f.signer.publicKey];
  assert.equal(await verifySignature(f.manifestBytes, f.sig, keys), true);
  const bad = f.sig.slice();
  bad[10] ^= 1;
  assert.equal(await verifySignature(f.manifestBytes, bad, keys), false, 'flipped signature bit');
  const edited = f.manifestBytes.slice();
  edited[edited.length - 3] ^= 1;
  assert.equal(await verifySignature(edited, f.sig, keys), false, 'edited manifest');
  const other = await makeSigner();
  assert.equal(await verifySignature(f.manifestBytes, f.sig, [other.publicKey]), false, 'another key');
  assert.equal(await verifySignature(f.manifestBytes, f.sig.subarray(0, 63), keys), false, 'short signature');
  let asked = 0;
  await assert.rejects(f.open({ keys: [other.publicKey], envelope: () => { asked++; return null; } }), { code: 'signature' });
  assert.equal(asked, 0, 'no file is even looked at before the signature holds');
  await assert.rejects(f.open({ signature: 'not base64 !' }), { code: 'signature' });
});

test('only the pinned production key (or a dev key passed in) verifies; a throwaway key does not', async () => {
  const f = await fixture();
  assert.ok(PRODUCTION_KEYS.length > 0 && PRODUCTION_KEYS.every((k) => b64decode(k)?.length === 32), 'the owner’s pack key is pinned');
  assert.equal(await verifySignature(f.manifestBytes, f.sig, trustedKeys()), false);
  assert.equal(await verifySignature(f.manifestBytes, f.sig, trustedKeys(b64url(f.signer.publicKey))), true, 'the dev key only when passed in');
  await assert.rejects(f.open({ keys: trustedKeys() }), { code: 'signature' });
});

test('the service must have issued exactly this pack (id / version)', async () => {
  const f = await fixture();
  await assert.rejects(f.open({ expect: { id: 'souldew-plus', version: '0.9.0' } }), { code: 'manifest' });
  await assert.rejects(f.open({ expect: { id: 'other-pack' } }), { code: 'manifest' });
  await f.open({ expect: { id: 'souldew-plus', version: '1.0.0' } });
});

test('envelopes: wrong key, edited ciphertext, edited header, swapped files, other key id, other pack', async () => {
  const f = await fixture();
  const entry = f.manifest.files[1];
  const env = f.envs.get(entry.path);
  const o = { pack: 'souldew-plus', kid: '3', entry };
  assert.equal(new TextDecoder().decode((await openFile(env, f.key, o)).bytes), "html[data-skin='moss'] { --shell: #1f2a20; }");
  await assert.rejects(openFile(env, randKey(), o), { code: 'decrypt' });
  const ct = env.slice();
  ct[ct.length - 20] ^= 0x40;
  await assert.rejects(openFile(ct, f.key, o), { code: 'decrypt' });
  // the header (watermark, path, key id) is the GCM additional data: edit it and the tag fails
  const { headerBytes } = parseEnvelope(env);
  const text = new TextDecoder().decode(headerBytes);
  const swapped = env.slice();
  swapped.set(enc.encode(text.replace('wm_acct42', 'wm_acct43')), 6);
  await assert.rejects(openFile(swapped, f.key, o), { code: 'decrypt' });
  // another file's envelope under this path, another key epoch, another pack: refused before decrypting
  await assert.rejects(openFile(f.envs.get('banners.json'), f.key, o), { code: 'envelope' });
  await assert.rejects(openFile(env, f.key, { ...o, kid: '4' }), { code: 'envelope' });
  await assert.rejects(openFile(env, f.key, { ...o, pack: 'other-pack' }), { code: 'envelope' });
  await assert.rejects(f.open({ envelope: (p) => (p === 'banners.json' ? f.envs.get('contents.json') : f.envs.get(p)) }), { code: 'envelope' });
  await assert.rejects(openFile(env, f.key.subarray(0, 16), o), { code: 'key' });
  await assert.rejects(openFile(enc.encode('PK\u0003\u0004 not a pack at all, longer than 22 bytes'), f.key, o), { code: 'envelope' });
  await assert.rejects(openFile(env.subarray(0, 12), f.key, o), { code: 'envelope' });
});

test('file hashes and the watermark trailer: a changed file, a missing file, no trailer – all refused, nothing used', async () => {
  const f = await fixture();
  const reseal = (path, bytes) => sealFile({ pack: 'souldew-plus', version: '1.0.0', path, wm: WM, kid: f.kid, key: f.key, bytes });
  // a different CSS sealed correctly – the manifest's hash catches it
  const changed = await reseal('skins/moss.css', enc.encode("html[data-skin='moss'] { --shell: #ff0000; }"));
  await assert.rejects(f.open({ envelope: (p) => (p === 'skins/moss.css' ? changed : f.envs.get(p)) }), { code: 'hash' });
  await assert.rejects(f.open({ envelope: (p) => (p === 'banners.json' ? null : f.envs.get(p)) }), { code: 'missing' });
  // a text file without the trailer: made like the Worker would for an image, but under the css path
  const noTrailer = await (async () => {
    const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const header = enc.encode(JSON.stringify({ v: 1, pack: 'souldew-plus', version: '1.0.0', path: 'skins/moss.css', wm: WM, kid: f.kid, nonce: b64url(nonce) }));
    const k = await webcrypto.subtle.importKey('raw', f.key, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, k, files[1].bytes));
    const out = new Uint8Array(6 + header.length + ct.length);
    out.set(enc.encode('SDP1'));
    out[5] = header.length;
    out.set(header, 6);
    out.set(ct, 6 + header.length);
    return out;
  })();
  await assert.rejects(f.open({ envelope: (p) => (p === 'skins/moss.css' ? noTrailer : f.envs.get(p)) }), { code: 'watermark' });
});

test('interoperability: an envelope built with node:crypto exactly like the Worker (src/routes/packs.ts) opens', async () => {
  const f = await fixture();
  const entry = f.manifest.files[0];
  const wm = 'wm_AbCdEfGhIjKlMnOpQrStUv';
  const nonce = randomBytes(12);
  const header = Buffer.from(JSON.stringify({ v: 1, pack: 'souldew-plus', version: '1.0.0', path: entry.path, wm, kid: 'pv_0123456789abcdefABCDEF', nonce: nonce.toString('base64url') }));
  const c = createCipheriv('aes-256-gcm', f.key, nonce);
  c.setAAD(header);
  const plain = Buffer.concat([files[0].bytes, Buffer.from(`\n/*sdwm:${wm}*/\n`)]);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const env = Buffer.concat([Buffer.from('SDP1'), Buffer.from([header.length >> 8, header.length & 255]), header, ct]);
  const r = await openFile(new Uint8Array(env), f.key, { pack: 'souldew-plus', kid: 'pv_0123456789abcdefABCDEF', entry });
  assert.equal(r.wm, wm);
  assert.deepEqual(r.bytes, files[0].bytes);
});

test('manifest shape: format, ids, paths, types, sizes, hashes, executable flags are checked even when signed', async () => {
  const ok = { format: FORMAT, id: 'souldew-plus', version: '1.0.0', kind: 'mixed', title: 't', created: '2026-11-17T00:00:00Z',
    files: [{ path: 'skins/a.css', size: 1, sha256: await sha256(new Uint8Array(1)), type: 'text/css', executable: false }] };
  assert.doesNotThrow(() => checkManifest(ok));
  const bad = (patch, file) => assert.throws(() => checkManifest({ ...ok, ...patch, ...(file ? { files: [{ ...ok.files[0], ...file }] } : {}) }), { code: 'manifest' });
  bad({ format: 2 });
  bad({ id: 'Bad_Id' });
  bad({ version: '1.0' });
  bad({ kind: 'themes' });
  bad({ files: [] });
  bad({ files: [ok.files[0], ok.files[0]] });
  bad(null, { path: '../etc/passwd.css' });
  bad(null, { path: '/abs.css' });
  bad(null, { path: 'a\\b.css' });
  bad(null, { path: 'a.exe', type: 'application/octet-stream' });
  bad(null, { type: 'text/plain' });
  bad(null, { size: -1 });
  bad(null, { size: 9 * 1024 * 1024 });
  bad(null, { sha256: 'xyz' });
  bad(null, { executable: true });
  bad(null, { path: 'frames.mjs', type: 'text/javascript', executable: false });
});
