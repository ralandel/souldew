// The souldew account on this computer: "Sign in with Discord" and the session that follows (PLUS_SPEC.md › Auth).
//
// Sign-in is OAuth 2 authorization code + PKCE in the SYSTEM browser – never an embedded web view, never a Discord
// password in the app. startLogin() makes a code_verifier (32 random bytes), its S256 challenge and a random state;
// the browser goes to the accounts service, which sends it on to Discord and, once the player said yes, back to this
// computer's local server: http://127.0.0.1:<port>/auth/done?code=…&state=… (./routes.mjs). finishLogin() takes that
// one-time code only for the pending sign-in it belongs to (state compared in constant time, single use, 10 minutes)
// and trades it together with the verifier for a session. Nothing else ever travels in a URL.
//
// The session: a short-lived access token and an opaque refresh token that the service rotates on every use. Both stay
// in this module – the page never sees either; it talks to the local server, the local server talks to the service.
// A refresh is single-flight (two at once would look like a stolen token to the service's reuse detection and end the
// session), the new pair is stored before it is used. A 401 the refresh can't cure means the session was revoked
// (signed out elsewhere, "sign out everywhere", account deleted): the tokens are dropped and the page says so.
// No answer at all is "offline": the tokens stay, the page shows the last known state. Tokens, codes and the
// verifier are never logged.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { API, accountsBase } from './contract.mjs';

// The service's state lives 10 minutes and its confirmation page ("Sign in to souldew on this computer as …?") another
// 5 after Discord said yes – the loopback keeps waiting for all of it (API.md §1.3a: at least 10 minutes).
const LOGIN_TTL = 15 * 60000;
const REFRESH_EARLY = 60000; // refresh this long before the access token runs out (clock skew, slow networks)
const MAX_BAD_STATES = 20; // /auth/done with a wrong state: counted, never ends the pending sign-in (a web page could)
const CODE = /^[A-Za-z0-9._~-]{16,512}$/;
const TOKEN = /^[\x21-\x7e]{16,4096}$/; // printable, no spaces: whatever the service issues, but nothing that can break a header
// 401 codes that end the session at once (no refresh can cure them)
const ENDED = ['session_revoked', 'refresh_reused'];
const SID = /^ses_[A-Za-z0-9_-]{1,64}$/;

/**
 * The session id the service put into its own access token (the `sid` claim). Read, not verified: the token came
 * straight from the service over its own connection; the id only tells this computer's session apart from the
 * others in the session list and binds the entitlement token to it (./enttoken.mjs).
 */
export function sidOf(access) {
  try {
    const c = JSON.parse(Buffer.from(String(access).split('.')[1] || '', 'base64url').toString('utf8'));
    return SID.test(c?.sid || '') ? c.sid : null;
  } catch {
    return null;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const pkceChallenge = (verifier) => b64url(createHash('sha256').update(verifier).digest());

/** Constant-time comparison of two strings (different lengths: false, without leaking where they differ). */
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * store: ./store.mjs createTokenStore(); port(): the local server's port (the loopback the service redirects to).
 * fetchImpl / env / now: for tests. onChange(publicState) is called whenever signed-in / offline / expired changes.
 * onLoaded() is called once load() is done when onChange wasn't (nothing saved, or a sign-in that finished meanwhile) –
 * either way the page learns that the account is known now (publicState().loaded).
 */
export function createSession({ store, port, fetchImpl = fetch, env = process.env, now = Date.now, onChange = () => {}, onLoaded = () => {}, toAccount = () => null, platform = process.platform } = {}) {
  const base = accountsBase(env);
  // { access, accessExp, refresh, sid, service, account } – read from the store by load(), never at creation: reading
  // it may mean the keychain, and the keychain may mean a password prompt the server must not wait for. Once read it
  // stays here in memory – no request reads the keychain again.
  let saved = null;
  let loading = null;
  // load() is done: until then "signed out" only means "not read yet" – the page must not act on it (a souldew+
  // member's pack would be wiped and downloaded again at every start)
  let loaded = false;
  let pending = null; // { state, verifier, at, bad }
  let refreshing = null;
  // what the page is told besides signed-in or not: 'offline' (no answer), 'expired' (the session ended elsewhere),
  // 'unreadable' (the saved sign-in couldn't be read – load())
  let condition = null;
  let lastTier = null;
  // what the session list of the account shows for this computer: the kind of computer, never its name (a host name
  // is often the owner's own name – "Sam's MacBook")
  const platformName = () => ({ darwin: 'mac', win32: 'win', linux: 'linux' }[platform] || undefined);
  const deviceName = () => ({ darwin: 'souldew on a Mac', win32: 'souldew on Windows', linux: 'souldew on Linux' }[platform] || 'souldew');

  const changed = () => onChange(publicState());
  // the loopback the service sends the browser back to (API.md §1.2: exactly 127.0.0.1, this port, /auth/done)
  const redirectUri = () => `http://127.0.0.1:${port()}/auth/done`;
  const setCondition = (c) => {
    if (c === condition) return;
    condition = c;
    changed();
  };

  /** The page's view of the session: never a token. */
  function publicState() {
    return {
      signedIn: !!saved,
      persistent: store.persistent(),
      condition: saved ? (['offline', 'suspended'].includes(condition) ? condition : null) : ['expired', 'unreadable'].includes(condition) ? condition : null,
      pending: !!pending && now() - pending.at < LOGIN_TTL,
      account: saved?.account || null,
      loaded,
    };
  }

  /**
   * The session changed: in memory at once, to the store behind it (the keychain may take its time – or say no).
   * → a promise that is settled once the store has it (never rejects) – a rotated refresh token is awaited this way
   * before it counts, so quitting right after a refresh can't leave the spent one on disk.
   */
  function keep(next, opts) {
    saved = next;
    const failed = (e) => {
      // the keychain refused / disk full: the session works in memory until the app closes
      console.warn('account: could not store the session –', e?.code || e?.name);
      changed(); // persistent may be false now (Settings › Account says so)
    };
    try {
      return Promise.resolve(store.save(next, opts)).catch(failed);
    } catch (e) {
      failed(e);
      return Promise.resolve();
    }
  }

  function drop(reason) {
    saved = null;
    pending = null;
    try {
      store.clear();
    } catch {
      // nothing to remove
    }
    condition = reason || null;
    changed();
  }

  /**
   * Reads the saved sign-in (once – later calls get the same promise; it never rejects). Until it is done the player
   * counts as signed out. Nothing saved → the keychain isn't asked at all (./store.mjs). A saved sign-in the keychain
   * won't open (denied, gone, another user) → signed out with condition 'unreadable' – the page asks to sign in again.
   */
  function load() {
    loading ||= (async () => {
      let next = null;
      let failed = false;
      try {
        next = await store.load();
      } catch {
        failed = true;
      }
      if (next && !(TOKEN.test(next.refresh || '') && next.account)) next = null;
      // tokens belong to the service that issued them: a session kept for another address (a development service, a
      // changed environment) is dropped, never sent to the address in use now
      if (next && next.service !== base) {
        next = null;
        try {
          store.clear();
        } catch {
          // nothing stored
        }
      }
      loaded = true;
      // a sign-in that finished meanwhile is newer than what was saved
      if (saved) return onLoaded();
      if (next) {
        saved = next;
        condition = null;
        changed();
      } else if (failed) setCondition('unreadable');
      else onLoaded(); // nothing saved: signed out – now for certain
    })();
    return loading;
  }

  /** One request to the service. No answer → { status: 0 }. The body is parsed JSON or {} (never followed redirects). */
  async function raw(path, { method = 'GET', token, json, timeout = 15000 } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetchImpl(`${base}${path}`, { method, headers, redirect: 'error', signal: AbortSignal.timeout(timeout), body: json !== undefined ? JSON.stringify(json) : undefined });
    } catch {
      return { status: 0, body: {}, headers: null };
    }
    let body = {};
    try {
      body = await r.json();
    } catch {
      // empty answer (204) or an error page
    }
    return { status: r.status, body: body && typeof body === 'object' ? body : {}, headers: r.headers };
  }

  /** A token answer of the service → the stored session (null when it isn't one). */
  function sessionFrom(body, account) {
    const access = body?.access_token;
    const refresh = body?.refresh_token;
    const ttl = Number(body?.expires_in);
    if (!TOKEN.test(access || '') || !TOKEN.test(refresh || '') || !Number.isFinite(ttl) || ttl <= 0) return null;
    const sid = SID.test(body?.session_id || '') ? body.session_id : sidOf(access) || saved?.sid || null;
    return { access, refresh, accessExp: now() + Math.min(ttl, 3600) * 1000, sid, service: base, account: account || saved?.account || null, ...(saved?.extra ? { extra: saved.extra } : {}) };
  }

  // ---- sign in -----------------------------------------------------------------------------------------------
  function startLogin() {
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(32));
    pending = { state, verifier, at: now(), bad: 0 };
    changed();
    const q = new URLSearchParams({ code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', state, redirect_uri: redirectUri() });
    return { url: `${base}${API.start}?${q}` };
  }

  function cancelLogin() {
    if (!pending) return;
    pending = null;
    changed();
  }

  /**
   * The browser came back to /auth/done. → { ok: true } or { ok: false, error } with error one of
   * 'none' (no sign-in is waiting), 'expired', 'mismatch' (not our state – kept waiting for the real one),
   * 'denied' (the player said no on Discord), 'bad' (malformed), 'offline', 'failed' (the service refused the code).
   */
  async function finishLogin({ code, state, error }) {
    if (!pending) return { ok: false, error: 'none' };
    if (now() - pending.at > LOGIN_TTL) {
      pending = null;
      changed();
      return { ok: false, error: 'expired' };
    }
    if (!sameSecret(String(state || ''), pending.state)) {
      // any web page can navigate here with a made-up state: that must not cancel the player's sign-in. Past
      // MAX_BAD_STATES the answer stays "mismatch" without comparing (the state is 256 bit – nothing to guess anyway).
      pending.bad = Math.min(MAX_BAD_STATES, pending.bad + 1);
      return { ok: false, error: 'mismatch' };
    }
    const { verifier } = pending;
    pending = null; // single use – whatever happens next, this sign-in is spent
    if (error) {
      changed();
      return { ok: false, error: error === 'access_denied' ? 'denied' : error === 'account_suspended' ? 'suspended' : 'failed' };
    }
    if (!CODE.test(String(code || ''))) {
      changed();
      return { ok: false, error: 'bad' };
    }
    const r = await raw(API.token, { method: 'POST', json: { grant_type: 'login_code', code, code_verifier: verifier, redirect_uri: redirectUri(), device_name: deviceName(), platform: platformName() } });
    if (r.status === 0) {
      changed();
      return { ok: false, error: 'offline' };
    }
    const next = r.status === 200 ? sessionFrom(r.body, toAccount(r.body.account)) : null;
    if (!next) {
      changed();
      return { ok: false, error: errorCode(r.body) === 'account_suspended' ? 'suspended' : 'failed' };
    }
    keep(next, { signIn: true });
    condition = null;
    changed();
    return { ok: true };
  }

  // ---- the session -------------------------------------------------------------------------------------------
  /** A fresh refresh (single-flight). → 'ok' | 'revoked' | 'offline' | 'error'. */
  function refresh() {
    if (refreshing) return refreshing;
    const used = saved?.refresh;
    if (!used) return Promise.resolve('revoked');
    refreshing = (async () => {
      const r = await raw(API.token, { method: 'POST', json: { grant_type: 'refresh_token', refresh_token: used } });
      if (r.status === 0) return 'offline';
      if (r.status === 200) {
        // signed out (or in as someone else) while the refresh was on its way: the answer belongs to a session that
        // is gone – storing it would sign the player back in behind their back
        if (saved?.refresh !== used) return 'error';
        const next = sessionFrom(r.body);
        if (!next) return 'error';
        await keep(next);
        return 'ok';
      }
      // 400/401: the refresh token is spent, revoked or reused – the whole session is gone
      if (r.status === 400 || r.status === 401 || r.status === 403) return 'revoked';
      return 'error';
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /**
   * An authorized request to the service: refreshes ahead of time and once more after a 401, then gives up and ends
   * the session. → { status, body, headers } (status 0 = offline, 401 = signed out now).
   */
  async function request(path, opts = {}) {
    const signedOut = () => ({ status: 401, body: { error: { code: 'signed_out' } } });
    if (!saved) return signedOut();
    if (now() > saved.accessExp - REFRESH_EARLY) {
      const res = await refresh();
      if (!saved) return signedOut(); // signed out while the refresh was on its way (or being stored)
      if (res === 'revoked') {
        drop('expired');
        return { status: 401, body: { error: { code: 'session_revoked' } } };
      }
      if (res === 'offline') {
        setCondition('offline');
        return { status: 0, body: {} };
      }
    }
    let r = await raw(path, { ...opts, token: saved?.access });
    // token_expired (or a plain 401 – a clock that runs fast): one refresh and one more try. session_revoked and
    // refresh_reused end the session right away.
    if (r.status === 401 && saved && !ENDED.includes(errorCode(r.body))) {
      const res = await refresh();
      if (!saved) return signedOut();
      if (res === 'ok') r = await raw(path, { ...opts, token: saved.access });
      else if (res === 'revoked') {
        drop('expired');
        return { status: 401, body: { error: { code: 'session_revoked' } } };
      } else if (res === 'offline') {
        setCondition('offline');
        return { status: 0, body: {} };
      }
    }
    if (r.status === 401) {
      drop('expired');
      return r;
    }
    setCondition(r.status === 0 ? 'offline' : r.status === 403 && errorCode(r.body) === 'account_suspended' ? 'suspended' : null);
    return r;
  }

  /** Sign out here (everywhere: every session of the account). The tokens go either way – also when offline. */
  async function signOut({ everywhere = false } = {}) {
    if (!saved) return { ok: true, reached: true };
    let reached = true;
    // logout takes the refresh token in the body – it works also when the access token ran out (API.md §1.5)
    if (everywhere) reached = (await request(API.logoutAll, { method: 'POST' })).status !== 0;
    else reached = (await raw(API.logout, { method: 'POST', json: { refresh_token: saved.refresh } })).status !== 0;
    drop(null);
    return { ok: true, reached };
  }

  /** The account itself is gone (deleted): forget it here. */
  function forget() {
    drop(null);
  }

  /** Keep the account's public bits (name, avatar …) next to the tokens, for the page while offline. */
  function rememberAccount(account) {
    if (!saved || !account) return;
    const next = { ...saved, account: { ...(saved.account || {}), ...account } };
    if (JSON.stringify(next.account) !== JSON.stringify(saved.account)) keep(next);
    if (account.tier !== lastTier) {
      lastTier = account.tier;
      changed();
    }
  }

  /** Small things kept with the session, encrypted like it (the last entitlement for the offline grace of packs). */
  function setExtra(key, value) {
    if (!saved) return;
    keep({ ...saved, extra: { ...(saved.extra || {}), [key]: value } });
  }
  const extra = (key) => saved?.extra?.[key] ?? null;

  return {
    base, load, publicState, startLogin, setExtra, extra, cancelLogin, finishLogin, request, refresh, signOut, forget, rememberAccount,
    get signedIn() { return !!saved; },
    /** this computer's session id (ses_…) – from the token answer, else the access token's sid claim */
    get sid() { return saved ? saved.sid || sidOf(saved.access) : null; },
  };
}

/** The error code of a service answer ({ error: { code } }, API.md §0.3) or null. */
export function errorCode(body) {
  const c = body?.error?.code;
  return typeof c === 'string' && /^[a-z_]{1,40}$/.test(c) ? c : null;
}
