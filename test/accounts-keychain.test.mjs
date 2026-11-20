// The souldew account and the keychain (server/lib/accounts/store.mjs, session.mjs, electron/main.mjs secureStore):
// the keychain is asked only when there is a saved sign-in to read or a sign-in to keep, never at start for a player
// who isn't signed in, and never on the way to the server or the window – an unsigned macOS build is a "new app" to
// its keychain item after every update, and each touch means a password prompt the app must not wait for.
// A fake safeStorage counts every call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATA = mkdtempSync(join(tmpdir(), 'souldew-keychain-'));
process.env.SLS_DATA_DIR = DATA;
// an accounts service that isn't there: every call is "offline" (the session itself is what these tests look at)
const SERVICE = 'http://127.0.0.1:9';
process.env.SLS_ACCOUNTS_URL = SERVICE;

const { createTokenStore, accountFile } = await import('../server/lib/accounts/store.mjs');
const { createSession } = await import('../server/lib/accounts/session.mjs');
const { startServer } = await import('../server/app.mjs');

after(() => rmSync(DATA, { recursive: true, force: true }));

const FILE = accountFile();
const tick = (ms = 0) => new Promise((res) => setTimeout(res, ms));

/** A fake Electron safeStorage (the async shape of macOS). `gate` holds every answer back (a keychain prompt that is open). */
function fakeKeychain({ deny = false, none = false } = {}) {
  const calls = { available: 0, encrypt: 0, decrypt: 0 };
  let open = null;
  const gate = { promise: Promise.resolve(), hold() { this.promise = new Promise((res) => (open = res)); }, release() { open?.(); } };
  const secure = {
    calls, gate,
    async available() {
      calls.available++;
      await gate.promise;
      return !none;
    },
    async encrypt(text) {
      calls.encrypt++;
      await gate.promise;
      if (deny) throw new Error('Error while encrypting the text provided to safeStorage.encryptStringAsync.');
      return Buffer.from(Buffer.from(text).map((b) => b ^ 0x5a));
    },
    async decrypt(buf) {
      calls.decrypt++;
      await gate.promise;
      // macOS "Deny": Electron rejects – "safeStorage.decryptStringAsync is temporarily unavailable"
      if (deny) throw new Error('safeStorage.decryptStringAsync is temporarily unavailable. Please try again.');
      return Buffer.from(buf.map((x) => x ^ 0x5a)).toString();
    },
  };
  return secure;
}

const SESSION = { access: 'a'.repeat(24), accessExp: Date.now() + 3600e3, refresh: 'r'.repeat(24), sid: null, service: SERVICE, account: { id: 'u_kim', handle: 'kimchi', name: 'Kim' } };
async function writeSaved(obj = SESSION) {
  const store = createTokenStore(fakeKeychain(), { file: FILE });
  assert.equal(await store.save(obj), true);
  assert.ok(existsSync(FILE));
}
const offline = async () => {
  throw new TypeError('fetch failed');
};

test('no saved sign-in: the keychain is never asked – not at start, not for the page, not for a request', async () => {
  rmSync(FILE, { force: true });
  const secure = fakeKeychain();
  const store = createTokenStore(secure, { file: FILE });
  const changes = [];
  let told = 0;
  const s = createSession({ store, port: () => 1, fetchImpl: offline, env: { SLS_ACCOUNTS_URL: SERVICE }, onChange: (x) => changes.push(x), onLoaded: () => told++ });
  assert.equal(s.publicState().loaded, false, 'before the read: "signed out" means "not known yet"');
  await s.load();
  assert.equal(s.signedIn, false);
  assert.equal(told, 1, 'the page still hears that the account is known now (its "signed out" is final)');
  await s.load();
  assert.equal(told, 1, 'once');
  const st = s.publicState();
  assert.equal(st.loaded, true);
  assert.equal(st.signedIn, false);
  assert.equal(st.persistent, true, 'not known to be impossible – the page shows no "no keychain" note');
  assert.equal(st.condition, null);
  assert.equal((await s.request('/v1/me')).status, 401);
  assert.deepEqual(secure.calls, { available: 0, encrypt: 0, decrypt: 0 }, 'isEncryptionAvailable / decrypt never called');
  assert.deepEqual(changes, [], 'nothing to tell the page');
  assert.equal(existsSync(FILE), false, 'and no keychain item is made either');
});

test('a saved sign-in: read once, in the background – never while the session (or the server) is being made', async () => {
  await writeSaved();
  const secure = fakeKeychain();
  secure.gate.hold(); // the keychain prompt is open
  const store = createTokenStore(secure, { file: FILE });
  const changes = [];
  let told = 0;
  const fetchImpl = async () => ({ status: 200, json: async () => ({ id: 'u_kim' }), headers: new Headers() });
  const s = createSession({ store, port: () => 1, fetchImpl, env: { SLS_ACCOUNTS_URL: SERVICE }, onChange: (x) => changes.push(x), onLoaded: () => told++ });
  assert.equal(secure.calls.available + secure.calls.decrypt, 0, 'creating the session reads nothing');
  assert.equal(s.signedIn, false);
  const loading = s.load();
  assert.equal(s.load(), loading, 'one read, however often it is asked for');
  await tick(5);
  assert.equal(s.signedIn, false, '"signed out" while the prompt is open');
  assert.equal(s.publicState().signedIn, false);
  assert.equal(s.publicState().loaded, false, '… but not known yet: the page must not act on it (a souldew+ pack would be wiped)');
  secure.gate.release();
  await loading;
  assert.equal(s.signedIn, true);
  assert.equal(s.publicState().account.handle, 'kimchi');
  assert.equal(changes.at(-1).signedIn, true, 'the page is told (and reloads its account view)');
  assert.equal(changes.at(-1).loaded, true);
  assert.equal(told, 0, 'told once – through onChange');
  // the token stays in memory: requests, the page's state and another load don't go back to the keychain
  for (let i = 0; i < 3; i++) assert.equal((await s.request('/v1/me')).status, 200);
  s.publicState();
  await s.load();
  assert.deepEqual(secure.calls, { available: 1, encrypt: 0, decrypt: 1 }, 'decrypted exactly once');
  rmSync(FILE, { force: true });
});

test('the keychain says no (macOS "Deny"): signed out, a calm note to sign in again – no crash, no prompt at the next start', async () => {
  await writeSaved();
  const secure = fakeKeychain({ deny: true });
  const changes = [];
  const s = createSession({ store: createTokenStore(secure, { file: FILE }), port: () => 1, fetchImpl: offline, env: { SLS_ACCOUNTS_URL: SERVICE }, onChange: (x) => changes.push(x) });
  await s.load();
  assert.equal(s.signedIn, false);
  assert.equal(s.publicState().condition, 'unreadable', 'Settings › Account: "souldew couldn’t read your saved sign-in – sign in again"');
  assert.equal(changes.at(-1).condition, 'unreadable');
  assert.equal(changes.at(-1).loaded, true, 'a real "signed out": known');
  assert.equal(existsSync(FILE), false, 'the unreadable blob goes');
  // the next start: nothing saved – the keychain isn't asked again
  const next = fakeKeychain();
  const s2 = createSession({ store: createTokenStore(next, { file: FILE }), port: () => 1, fetchImpl: offline, env: { SLS_ACCOUNTS_URL: SERVICE } });
  await s2.load();
  assert.equal(s2.publicState().condition, null);
  assert.deepEqual(next.calls, { available: 0, encrypt: 0, decrypt: 0 });
  // a keyring that went away (Linux: only "basic_text" left) reads the same way
  await writeSaved();
  const gone = fakeKeychain({ none: true });
  const s3 = createSession({ store: createTokenStore(gone, { file: FILE }), port: () => 1, fetchImpl: offline, env: { SLS_ACCOUNTS_URL: SERVICE } });
  await s3.load();
  assert.equal(s3.publicState().condition, 'unreadable');
  assert.equal(gone.calls.decrypt, 0, 'no decrypt without a keychain');
  assert.equal(existsSync(FILE), false);
});

test('saving: a sign-in the keychain refuses stays in memory (and the page says so); a sign-out while it is asked writes nothing', async () => {
  rmSync(FILE, { force: true });
  const denied = fakeKeychain({ deny: true });
  const store = createTokenStore(denied, { file: FILE });
  await assert.rejects(store.save(SESSION));
  assert.equal(store.persistent(), false, 'Settings › Account: signed in until the app closes');
  assert.equal(existsSync(FILE), false);
  assert.equal(denied.calls.available, 1);
  assert.equal(await store.save(SESSION), false, 'memory only');
  assert.equal(denied.calls.available, 1, 'later saves (every token refresh) don\'t ask again');
  // a sign-out while the keychain is still being asked: the tokens never reach the disk
  const slow = fakeKeychain();
  slow.gate.hold();
  const s2 = createTokenStore(slow, { file: FILE });
  const writing = s2.save(SESSION);
  await tick(5);
  s2.clear();
  slow.gate.release();
  assert.equal(await writing, false);
  assert.equal(existsSync(FILE), false, 'not brought back');
  assert.equal(await s2.load(), null);
  // writes keep their order: the last one is on disk
  const k = fakeKeychain();
  const s3 = createTokenStore(k, { file: FILE });
  await Promise.all([s3.save({ ...SESSION, refresh: 'x'.repeat(24) }), s3.save({ ...SESSION, refresh: 'y'.repeat(24) })]);
  assert.equal((await createTokenStore(fakeKeychain(), { file: FILE }).load()).refresh, 'y'.repeat(24));
  rmSync(FILE, { force: true });
});

test('a rotated refresh token is in the store before the refresh counts (quitting right after can\'t leave the spent one)', async () => {
  rmSync(FILE, { force: true });
  await writeSaved({ ...SESSION, accessExp: 0 });
  const secure = fakeKeychain();
  const store = createTokenStore(secure, { file: FILE });
  const json = (status, body) => ({ status, json: async () => body, headers: new Headers() });
  const fetchImpl = async (url) => (url.endsWith('/auth/token') ? json(200, { access_token: 'b'.repeat(24), refresh_token: 'n'.repeat(24), expires_in: 900 }) : json(200, {}));
  const s = createSession({ store, port: () => 1, fetchImpl, env: { SLS_ACCOUNTS_URL: SERVICE } });
  await s.load();
  assert.equal(await s.refresh(), 'ok');
  assert.equal(JSON.parse(Buffer.from(readFileSync(FILE).map((x) => x ^ 0x5a)).toString()).refresh, 'n'.repeat(24));
  rmSync(FILE, { force: true });
});

// ---- the local server -------------------------------------------------------------------------------------------------

const H = { 'x-soullink': '1', 'content-type': 'application/json' };
const get = (base, p) => fetch(base + p, { headers: H, signal: AbortSignal.timeout(3000) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test('server start never waits for the keychain: up at once, "signed out" while a prompt is open, signed in once it is answered', async () => {
  await writeSaved();
  const secure = fakeKeychain();
  secure.gate.hold(); // the prompt stays open for as long as the player leaves it
  const t0 = Date.now();
  const started = await startServer({ port: 0, background: false, secureStore: secure, packaged: false, deferAccount: true });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(secure.calls.available + secure.calls.decrypt, 0, 'deferAccount: nothing read before the desktop app says so (its window is open)');
    const st = await get(base, '/api/account');
    assert.equal(st.status, 200);
    assert.equal(st.body.session.signedIn, false);
    assert.equal(st.body.session.loaded, false, 'the page learns it is not known yet');
    assert.equal(secure.calls.available, 0, 'the page\'s status doesn\'t start the read either');
    assert.equal((await get(base, '/api/status')).status, 200, 'the rest of the app answers');
    started.loadAccount();
    await tick(10);
    assert.equal(secure.calls.available, 1);
    assert.equal((await get(base, '/api/account')).body.session.signedIn, false, 'the prompt is still open: signed out, answered at once');
    // a route that acts on the account waits for the saved sign-in instead of answering "signed out" for it
    const waiting = get(base, '/api/account/friends');
    let settled = false;
    waiting.then(() => (settled = true), () => (settled = true));
    await tick(30);
    assert.equal(settled, false);
    secure.gate.release();
    await waiting;
    const after = await get(base, '/api/account');
    assert.equal(after.body.session.signedIn, true);
    assert.equal(after.body.session.loaded, true);
    assert.equal(after.body.brief.handle, 'kimchi');
    assert.equal(secure.calls.decrypt, 1);
  } finally {
    started.server.close();
    rmSync(FILE, { force: true });
  }
});

test('server start without deferAccount (npm start, tests): the saved sign-in is read right after listen, by itself', async () => {
  await writeSaved();
  const secure = fakeKeychain();
  const started = await startServer({ port: 0, background: false, secureStore: secure, packaged: false });
  try {
    let st = null;
    for (let i = 0; i < 100 && !st?.session?.signedIn; i++) {
      await tick(10);
      st = (await get(`http://127.0.0.1:${started.port}`, '/api/account')).body;
    }
    assert.equal(st.session.signedIn, true);
    assert.equal(secure.calls.decrypt, 1);
  } finally {
    started.server.close();
    rmSync(FILE, { force: true });
  }
});

test('the desktop app: the async safeStorage on macOS (keychain off the main thread), the sync one with the basic_text check elsewhere', () => {
  const src = readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const secureStore = MAC'), src.indexOf('/** "Sign in with Discord"'));
  assert.match(block, /isAsyncEncryptionAvailable\(\)/);
  assert.match(block, /decryptStringAsync\(buf\)\)\.result/);
  assert.match(block, /encryptStringAsync\(text\)/);
  assert.match(block, /\['basic_text', 'unknown'\]\.includes\(safeStorage\.getSelectedStorageBackend\(\)\)/, 'Linux without a keyring: memory only, as before');
  assert.ok(!/safeStorage\./.test(src.slice(0, src.indexOf('const secureStore = MAC'))), 'nothing touches safeStorage before');
  assert.match(src, /deferAccount: true/);
  assert.match(src, /createWindow\(\);\n\s+started\.loadAccount\(\);/, 'the saved sign-in only once the window is open');
});
