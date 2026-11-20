// The souldew account in the local server: the page's /api/account/* routes, the sign-in hand-off page
// (/auth/done), the avatar proxy, the presence heartbeat and the opt-in stats upload. The page never talks to the
// accounts service itself and never sees a token; this module checks what the page sends, calls the service through
// the session (./session.mjs) and cleans every answer (./clean.mjs).
//
// Signed out, none of this does anything: no timer runs, no request leaves the computer – the app works exactly as
// it does without an account.
import { createHash, randomBytes } from 'node:crypto';
import { httpError } from '../fsutil.mjs';
import { createTokenStore } from './store.mjs';
import { createSession, errorCode } from './session.mjs';
import { API, accountsBase } from './contract.mjs';
import { authPage, AUTH_PAGE_HEADERS, AUTH_RESULTS } from './authpage.mjs';
import { entitlementKeys, verifyEntitlementToken, serviceClock, isPackagedBuild, SKEW_S } from './enttoken.mjs';
import { currentStats, editorChoices, trustedNumbers } from './stats.mjs';
import {
  cleanMe, cleanProfile, cleanFriend, cleanRequest, cleanPresence, cleanInvite, cleanJoinRequest, cleanCatalog, cleanEntitlements,
  cleanThanks, catalogId, inviteCode, isPlusTier,
} from './clean.mjs';
import {
  cleanText, withoutFileNames, safeAvatarUrl, parseFriendQuery, normalizeHandle, oneOf, presenceSystem, int,
  PROFILE_VISIBILITY, PRESENCE_VISIBILITY, ACCENTS, STATUS_MAX, NAME_MAX, FAVORITE_MAX, RUN_NAME_MAX, SHOWCASE_LAYOUTS,
} from '../../../shared/social.mjs';
import { SPECIES_MAX, TRUSTED_NOTE_MAX } from '../../../shared/trustedlines.mjs';
import { EDITION } from '../../../shared/edition.mjs';

const ID = '[A-Za-z0-9_-]{3,64}';
const BODY_LIMIT = 64 * 1024;
const ME_TTL = 30000;
const CATALOG_TTL = 5 * 60000;
const PAGE_ALIVE = 3 * 60000; // the page reports presence at least this often while it is open
const STATS_EVERY = 10 * 60000;
const AVATAR_MAX = 512 * 1024;
const AVATAR_CACHE = 200;
const ENT_FRESH = 15 * 60000; // the verified entitlement behind the own badges is re-read this often (the token lives 1 hour)
const OFFLINE_DELETE_MS = 1500; // quitting: how long "I'm offline now" may hold the app up
const NO_ENT = Object.freeze({ tier: 'none', badges: [], until: null });
const THANKS_MIN_GAP = 30000; // the service's wall is asked at most this often, however many pages look (it is cached 60 s there)

async function readJson(req) {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > BODY_LIMIT) throw httpError(413, 'Request too large', 'requestTooLarge');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) throw httpError(413, 'Request too large', 'requestTooLarge');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError(400, 'Invalid JSON', 'badJson');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'JSON object expected', 'jsonObject');
  return body;
}

/** A service answer that isn't a success → the error the page gets: { error, code: 'acct', vars: { code, field, retryAfter } }. */
function serviceError(r) {
  if (r.status === 0) return httpError(503, 'The account service can’t be reached', 'acctOffline');
  if (r.status === 401) return httpError(401, 'Signed out', 'acctSignedOut');
  const e = r.body?.error || {};
  const vars = { code: errorCode(r.body) || 'internal' };
  if (typeof e.field === 'string' && /^[a-z_.]{1,40}$/.test(e.field)) vars.field = e.field;
  if (Number.isFinite(e.retry_after)) vars.retryAfter = Math.max(1, Math.ceil(e.retry_after));
  if (typeof e.reason === 'string') vars.reason = cleanText(e.reason, 80);
  return httpError(r.status >= 400 && r.status < 600 ? r.status : 502, `Account service: ${vars.code}`, 'acct', vars);
}

/**
 * A response's body, but never more than `max` bytes: null as soon as it is longer – whether its Content-Length said so
 * or not (a chunked answer is read only that far and then dropped).
 */
export async function readCapped(r, max) {
  const reader = r.body?.getReader?.();
  if (!reader) {
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > max ? null : b;
  }
  const parts = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts, n);
}

/**
 * A build without the souldew account (shared/edition.mjs → accounts: false): the page's status says "signed out, for
 * good" (session.off), every other account route answers 404, nothing reads the keychain and no request leaves the
 * computer.
 */
export function accountsOff() {
  const off = () => {
    throw httpError(404, 'This build has no souldew account', 'acctOff');
  };
  const state = Object.freeze({ signedIn: false, persistent: false, condition: null, pending: false, account: null, loaded: true, off: true });
  const routes = [
    { method: 'GET', pattern: /^\/api\/account$/, handler: () => ({ session: state, me: null, brief: null, pending: null, service: '' }) },
    ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => ({ method, pattern: /^\/api\/account\/(?!diagnostics$).+$/, handler: off })),
  ];
  const notFound = (req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not found');
  };
  return {
    routes, off: true, authDone: notFound, avatar: notFound, close: () => {}, goOffline: async () => false,
    diagnostics: () => ({ signedIn: false, tier: null, off: true }), session: { signedIn: false, publicState: () => state, load: async () => {} },
    setReport: () => {}, loadSession: async () => {}, service: '',
  };
}

/**
 * secure: Electron's safeStorage wrapper (./store.mjs) or null; port(): this server's port; emit(event, data): the
 * page's event stream; openExternal(url): the system browser (desktop app) – without it the page opens the URL;
 * focus(): bring the app window forward. onPackKeyChange(): the souldew+ pack key changed or went away (tier dropped, key
 * rotated, signed out) – the encrypted pack cache must go (server/lib/pluspack.mjs wipe). packaged: an installed build (no
 * dev entitlement key, ./enttoken.mjs). fetchImpl / env / now / stats / entKeys: for tests.
 */
export function createAccounts({ secure = null, port, emit = () => {}, openExternal = null, focus = () => {}, lang = () => 'en', onPackKeyChange = () => {}, fetchImpl = fetch, env = process.env, now = Date.now, stats = currentStats, choices = editorChoices, numbers = trustedNumbers, packaged = isPackagedBuild(), entKeys = null, enabled = EDITION.accounts !== false || !!env.SLS_ACCOUNTS_URL } = {}) {
  if (!enabled) return accountsOff();
  const service = accountsBase(env);
  const trusted = entKeys || entitlementKeys({ env, packaged });
  const store = createTokenStore(secure);
  let me = null;
  let meAt = 0;
  let meGen = 0; // bumps on every local write of `me`: a read that started before it must not overwrite it
  let pending = null;
  let catalog = null;
  let catalogAt = 0;
  const session = createSession({
    store, port, fetchImpl, env, now,
    toAccount: (a) => brief(cleanMe(a, service)),
    onChange: (s) => {
      if (!s.signedIn) {
        me = null;
        pending = null;
        own = null;
        stopHeartbeat();
        dropPackKey();
      }
      emit('account', { kind: 'session' });
    },
    // the saved sign-in is read and nothing changed (nobody was signed in): the page still hears it – its "signed out"
    // is certain only from now on (web/lib/account.mjs accountKnown)
    onLoaded: () => emit('account', { kind: 'session' }),
  });

  /** The pack key is gone or changed: the cached envelopes are useless (and must not linger) – wipe them. */
  function dropPackKey() {
    try {
      onPackKeyChange();
    } catch (e) {
      console.warn('souldew+ pack wipe failed –', e.message);
    }
  }

  /** What survives offline next to the tokens: the name and picture for Settings and the sidebar. */
  function brief(m) {
    return m ? { id: m.id, handle: m.handle, name: m.name, avatar: m.avatar, tier: own?.tier || 'none' } : null;
  }

  // ---- souldew+: the VERIFIED entitlement ---------------------------------------------------------------------------
  // Every souldew+ decision (pack key → pack access, the preview offer, the own badges) comes from the entitlement
  // token's verified claims (./enttoken.mjs). The JSON fields next to the token – and the entitlement inside /v1/me –
  // are never trusted for any of it.
  let own = null; // { tier, badges, until, graceUntil, packKeyId, at } – the last verified claims (memory)
  let ownLoading = null;
  const ms = (sec) => (Number.isFinite(sec) ? sec * 1000 : null); // the page's times are numbers (clean.mjs)
  const accountId = () => me?.id || session.publicState().account?.id || null;

  /** The service's GET /v1/entitlements answer → what the page gets, from the verified token only. */
  function verifiedView(body, headers) {
    const ent = cleanEntitlements(body);
    const nowS = serviceClock(headers) ?? Math.floor(now() / 1000);
    const v = verifyEntitlementToken(ent.token, { keys: trusted, iss: service, sub: accountId(), sid: session.sid, now: nowS });
    if (!v.ok) console.warn('souldew+ entitlement token not accepted –', v.reason);
    return viewOf(v.ok ? v.claims : null, ent, v.ok ? null : v.reason);
  }
  /** Verified claims (or null: not verified) + the answer's other fields → the page's entitlement. */
  function viewOf(c, ent, reason = null) {
    const plus = !!c && isPlusTier(c.tier);
    return {
      tier: c ? c.tier : 'none', badges: c ? c.badges : [], until: c ? ms(c.until) : null, graceUntil: c ? ms(c.graceUntil) : null,
      packKeyId: c?.packKeyId || null,
      // the pack key only for a verified souldew+ tier, and only the key the token names
      packKey: plus && ent.packKey && ent.packKeyId === c.packKeyId ? ent.packKey : null,
      sources: c ? ent.sources : [], offlineGraceDays: ent.offlineGraceDays,
      preview: ent.preview, verified: !!c, ...(reason ? { unverified: reason } : {}),
    };
  }
  function setOwn(view) {
    const before = own?.tier;
    own = { tier: view.tier, badges: view.badges, until: view.until, graceUntil: view.graceUntil, packKeyId: view.packKeyId, at: now() };
    if (me) session.rememberAccount(brief(me));
    if (before !== undefined && before !== own.tier) emit('account', { kind: 'session' });
  }
  /** The own account as the page sees it: entitlement and badges are the verified ones. */
  function self(m) {
    if (!m) return m;
    const e = own || NO_ENT;
    return { ...m, entitlement: { tier: e.tier, until: e.until, badges: e.badges }, badges: e.badges };
  }

  /** Reads and verifies the entitlement; wipes the pack cache when the key went away or changed. → the page's view. */
  async function readEntitlement() {
    const r = await session.request(API.entitlements);
    const kept = session.extra('entitlement');
    if (r.status === 200) {
      const view = verifiedView(r.body, r.headers);
      // §8.2: the tier dropped below souldew+ or pack_key_id changed (sign out everywhere, unlink, takeover) – or the
      // token didn't verify → the cached pack can't be used any more: wipe
      if (kept?.packKey && (!view.packKey || kept.packKeyId !== view.packKeyId)) {
        dropPackKey();
        session.setExtra('pack', null);
      }
      // kept for the offline grace: the token itself (re-verified offline), the key it allows and the latest time seen
      // (the service's clock or this computer's, whichever is later) – a clock set back behind it counts as expired
      const seen = Math.max(serviceClock(r.headers) ?? 0, Math.floor(now() / 1000), kept?.seen || 0);
      session.setExtra('entitlement', view.verified ? { token: cleanEntitlements(r.body).token, packKey: view.packKey, packKeyId: view.packKeyId, offlineGraceDays: view.offlineGraceDays, at: now(), seen } : null);
      setOwn(view);
      return view;
    }
    if (r.status === 0 && kept?.token) {
      // offline: the kept token, verified again with this computer's clock – valid until its grace_until (which is
      // never later than the membership's end). A clock behind the latest time already seen was set back: expired.
      const nowS = Math.floor(now() / 1000);
      const rolledBack = Number.isFinite(kept.seen) && nowS < kept.seen - SKEW_S;
      const v = rolledBack ? { ok: false, reason: 'clock' } : verifyEntitlementToken(kept.token, { keys: trusted, iss: service, sub: accountId(), sid: session.sid, now: nowS, offline: true });
      if (v.ok) {
        if (nowS > (kept.seen || 0)) session.setExtra('entitlement', { ...kept, seen: nowS });
        const view = { ...viewOf(v.claims, { packKey: kept.packKey, packKeyId: kept.packKeyId, sources: [], offlineGraceDays: kept.offlineGraceDays, preview: null }), offline: true, preview: null, lastPack: session.extra('pack') };
        setOwn(view);
        return view;
      }
      // the grace is over (or the kept token no longer verifies): no souldew+ offline – the cache goes
      if (kept.packKey) dropPackKey();
      session.setExtra('entitlement', null);
      session.setExtra('pack', null);
      setOwn({ ...NO_ENT, graceUntil: null, packKeyId: null });
    }
    throw serviceError(r);
  }
  /** The verified entitlement when it is older than ENT_FRESH (single flight; failures keep the last one). */
  function freshOwn(force = false) {
    if (!session.signedIn) return Promise.resolve(null);
    if (!force && own && now() - own.at < ENT_FRESH) return Promise.resolve(own);
    ownLoading ||= readEntitlement().catch(() => own).finally(() => { ownLoading = null; });
    return ownLoading;
  }

  /**
   * Me from the service – with the showcase layout kept on this computer when the service doesn't store layouts yet
   * (API.md §2.2 showcase_layout came with migration 0004; a service without it neither sends nor takes the field).
   */
  function meOf(raw) {
    const m = cleanMe(raw, service);
    if (m && raw && typeof raw === 'object' && raw.showcase_layout === undefined) {
      const kept = session.extra('showcaseLayout');
      if (SHOWCASE_LAYOUTS.includes(kept)) m.showcaseLayout = kept;
    }
    return m;
  }

  /** An authorized call; any failure becomes the page's error. */
  async function call(path, opts = {}) {
    const r = await session.request(path, opts);
    if (r.status >= 200 && r.status < 300) return r.body || {};
    throw serviceError(r);
  }

  async function loadMe(force = false) {
    if (!session.signedIn) return null;
    if (!force && me && now() - meAt < ME_TTL) return me;
    const gen = meGen;
    const r = await session.request(API.me);
    if (r.status === 200 && gen !== meGen) return me; // an edit (PATCH, handle) landed meanwhile – it is newer
    if (r.status === 200) {
      me = meOf(r.body);
      meAt = now();
      keepPrivacy(me);
      await freshOwn();
      session.rememberAccount(brief(me));
      startHeartbeat();
    }
    return me;
  }

  // ---- presence heartbeat + pending counters + opt-in stats ---------------------------------------------------------
  let report = null; // what the page says the player does: { state, game, run, location }
  let reportAt = 0;
  let timer = null;
  let timerAt = 0;
  let every = 60;
  let lastBeat = 0;
  let statsHash = null;
  let statsAt = 0;
  let lastSent = null;

  function stopHeartbeat() {
    clearTimeout(timer);
    timer = null;
  }
  function startHeartbeat(delay = 0) {
    if (!session.signedIn) return;
    clearTimeout(timer);
    timerAt = now() + delay;
    timer = setTimeout(beat, delay);
    timer.unref?.();
  }

  /** The presence body for the service, or null when nothing about the player may leave the computer. */
  function presenceBody() {
    // the privacy setting from /v1/me, else the one kept with the session; unknown (the profile couldn't be read and
    // nothing is kept) counts as hidden – "appear offline" must never fail open
    const priv = me?.privacy || session.extra('privacy');
    if (priv?.presence !== 'friends' || !report) return null; // hidden / appear offline: no heartbeat at all, only the counters
    const body = { state: report.state };
    if ((report.state === 'playing' || report.state === 'in_run') && report.game) body.game = report.game;
    if (report.state === 'in_run' && report.run) body.run = report.run;
    if (report.location && priv.showLocation === true) body.location = report.location;
    return body;
  }
  /** Keeps the presence privacy with the session (encrypted), for a start where /v1/me can't be read. */
  function keepPrivacy(m) {
    const p = m?.privacy ? { presence: m.privacy.presence, showLocation: m.privacy.showLocation === true } : null;
    const kept = session.extra('privacy');
    if (p && (kept?.presence !== p.presence || kept?.showLocation !== p.showLocation)) session.setExtra('privacy', p);
  }

  function setPending(p) {
    const next = {
      friendRequests: Math.max(0, Number(p?.friend_requests) || 0), invites: Math.max(0, Number(p?.invites) || 0), joinRequests: Math.max(0, Number(p?.join_requests) || 0),
    };
    if (JSON.stringify(next) === JSON.stringify(pending)) return;
    pending = next;
    emit('account', { kind: 'pending', pending });
  }

  async function beat() {
    timer = null;
    if (!session.signedIn) return;
    const alive = now() - reportAt < PAGE_ALIVE;
    try {
      await loadMe();
      const body = alive ? presenceBody() : null;
      let r;
      if (body) {
        r = await session.request(API.presence, { method: 'PUT', json: body });
        if (r.status === 200) lastSent = JSON.stringify(body);
      } else {
        // appear offline / hidden, or the page is gone: say we're gone once, then only ask for the counters
        if (lastSent) {
          await session.request(API.presence, { method: 'DELETE' });
          lastSent = null;
        }
        r = await session.request(API.pending);
      }
      if (r.status === 200) {
        if (Number.isFinite(r.body?.every)) every = Math.max(30, Math.min(300, r.body.every));
        setPending(r.body?.pending || r.body);
      }
      lastBeat = now();
      await uploadStats();
    } catch (e) {
      console.warn('account heartbeat failed –', e.code || e.name);
    }
    if (session.signedIn && alive) startHeartbeat(every * 1000);
  }

  async function uploadStats(force = false) {
    if (!me?.privacy?.showRuns) return;
    if (!force && now() - statsAt < STATS_EVERY) return;
    let body;
    try {
      body = stats();
    } catch (e) {
      console.warn('account stats –', e.message);
      return;
    }
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    statsAt = now();
    if (hash === statsHash && !force) return;
    const r = await session.request(API.stats, { method: 'PUT', json: body });
    if (r.status === 200) statsHash = hash;
    await refreshTrusted();
  }

  /**
   * "The numbers update themselves": the most trusted line's teams / top level / fallen from this computer's runs,
   * sent again when they changed – only while "Show my runs on my profile" is on (they are run numbers, like stats).
   */
  async function refreshTrusted() {
    const sc = me?.showcase;
    if (!me?.privacy?.showRuns || !sc?.trusted) return;
    let n;
    try {
      n = numbers(sc.trusted.line);
    } catch {
      return;
    }
    if (!n || (n.teams === sc.trusted.teams && n.top_level === sc.trusted.topLevel && n.fell === sc.trusted.fell)) return;
    const r = await session.request(API.me, { method: 'PATCH', json: { showcase: showcaseBody(sc, n) } });
    if (r.status === 200) {
      me = meOf(r.body);
      meAt = now();
      meGen++;
    }
  }

  /** The page's report of what the player does → cleaned; a change goes out soon (the service takes 6 a minute). */
  function setReport(b) {
    const state = oneOf(b.state, ['online', 'library', 'playing', 'in_run'], 'online');
    const g = b.game && typeof b.game === 'object' ? { title: withoutFileNames(b.game.title, 60), system: presenceSystem(b.game.system) } : null;
    const r = b.run && typeof b.run === 'object' ? { name: withoutFileNames(b.run.name, RUN_NAME_MAX), mode: oneOf(b.run.mode, ['soullink', 'nuzlocke', 'together'], 'soullink'), free_slot: b.run.freeSlot === true, joinable: b.run.joinable === true } : null;
    const next = { state, game: g?.title && g.system ? g : null, run: r?.name ? r : null, location: withoutFileNames(b.location, 40) || null };
    if (next.state === 'in_run' && !next.run) next.state = next.game ? 'playing' : 'online';
    if (next.state === 'playing' && !next.game) next.state = 'online';
    const wasAlive = now() - reportAt < PAGE_ALIVE;
    const changed = JSON.stringify(next) !== JSON.stringify(report);
    report = next;
    reportAt = now();
    if (!session.signedIn) return;
    if (!wasAlive || !timer) startHeartbeat(0);
    else if (changed) {
      // a change goes out within 10 s – but never later than a beat that is already due sooner (e.g. "appear offline")
      const delay = Math.max(0, 10000 - (now() - lastBeat));
      if (now() + delay < timerAt) startHeartbeat(delay);
    }
  }

  // ---- the page's routes --------------------------------------------------------------------------------------------
  const routes = [];
  // Every route but the page's status (GET /api/account – "signed out" while the saved sign-in is still being read)
  // waits for the saved sign-in: an answer must never say "signed out" (or start a second sign-in) for a player whose
  // session is only still on its way out of the keychain.
  const route = (method, path, handler) => routes.push({
    method, pattern: new RegExp(`^/api/account${path}$`),
    handler: method === 'GET' && path === '' ? handler : async (...args) => {
      await session.load();
      return handler(...args);
    },
  });
  const signedIn = () => {
    if (!session.signedIn) throw httpError(401, 'Signed out', 'acctSignedOut');
  };

  route('GET', '', async () => {
    let m = null;
    if (session.signedIn) m = (await loadMe().catch(() => null)) || null;
    return { session: session.publicState(), me: self(m), brief: session.publicState().account, pending, service: new URL(service).host };
  });
  route('POST', '/login', () => {
    // signed in: no second sign-in on top (it would replace this session without ending it) – sign out first
    if (session.signedIn) throw httpError(409, 'Already signed in', 'acct', { code: 'signed_in' });
    const { url } = session.startLogin();
    if (openExternal) {
      // the desktop app: the system browser opens it; the sign-in address (its state) is never handed to the caller,
      // so nobody but the browser the player sees can finish this sign-in
      try {
        openExternal(url);
        return { opened: true };
      } catch {
        session.cancelLogin();
        throw httpError(500, 'The browser could not be opened', 'acctBrowser');
      }
    }
    return { url, opened: false }; // the browser build: the page opens the tab itself
  });
  route('POST', '/login/cancel', () => {
    session.cancelLogin();
    return { ok: true };
  });
  route('POST', '/logout', async (req) => {
    const { everywhere } = await readJson(req);
    await goOffline();
    report = null;
    return session.signOut({ everywhere: everywhere === true });
  });

  // own account
  route('PATCH', '/me', async (req) => {
    signedIn();
    const b = await readJson(req);
    // a most trusted line goes with its numbers from this computer's runs – only when the runs are shared
    const share = typeof b.privacy?.showRuns === 'boolean' ? b.privacy.showRuns : !!me?.privacy?.showRuns;
    const patch = mePatch(b, { numbers: share ? (line) => numbers(line) : null });
    let body;
    try {
      body = meOf(await call(API.me, { method: 'PATCH', json: patch }));
    } catch (e) {
      // a service that doesn't store showcase layouts yet refuses the field: the layout stays on this computer (and
      // shows on your own profile), everything else is saved as usual
      if (!('showcase_layout' in patch) || e.status !== 400 || e.vars?.field !== 'showcase_layout' || !['unknown_field', 'invalid_field'].includes(e.vars?.code)) throw e;
      session.setExtra('showcaseLayout', patch.showcase_layout);
      delete patch.showcase_layout;
      body = Object.keys(patch).length ? meOf(await call(API.me, { method: 'PATCH', json: patch })) : me && { ...me, showcaseLayout: session.extra('showcaseLayout') };
      if (!body) body = await loadMe(true);
    }
    me = body;
    meAt = now();
    meGen++;
    keepPrivacy(me);
    session.rememberAccount(brief(me));
    if (patch.privacy?.show_runs === true) uploadStats(true).catch(() => {});
    if (typeof patch.privacy?.show_on_thanks === 'boolean') {
      // the wall is read again on the next look – also when a read is under way right now (it may predate the change)
      thanks.at = 0;
      thanks.gen++;
    }
    if (patch.privacy?.presence) startHeartbeat(0);
    return self(body);
  });
  route('PUT', '/handle', async (req) => {
    signedIn();
    const handle = normalizeHandle((await readJson(req)).handle);
    if (!handle) throw httpError(400, 'Invalid handle', 'acct', { code: 'invalid_field', field: 'handle' });
    me = meOf(await call(API.handle, { method: 'PUT', json: { handle } }));
    meAt = now();
    meGen++;
    session.rememberAccount(brief(me));
    return self(me);
  });
  route('POST', '/friend-code', async () => {
    signedIn();
    await call(API.friendCode, { method: 'POST' });
    return self(await loadMe(true));
  });
  route('GET', '/export', async () => {
    signedIn();
    return call(API.exportData);
  });
  route('DELETE', '', async (req) => {
    signedIn();
    const handle = normalizeHandle((await readJson(req)).confirm);
    if (!handle) throw httpError(400, 'Invalid handle', 'acct', { code: 'invalid_field', field: 'confirm' });
    await call(API.me, { method: 'DELETE', json: { confirm: handle } });
    session.forget();
    return { ok: true };
  });
  route('GET', '/catalog', async () => {
    // signed out nothing leaves the computer – not even this public list: the app's own palette, no premium list
    if (!session.signedIn) return { cosmetics: [], accents: ACCENTS.map((a) => ({ key: a.key, hex: a.hex })), local: true };
    if (catalog && now() - catalogAt < CATALOG_TTL) return catalog;
    const r = await fetchPublic(API.catalog);
    if (r.status !== 200) {
      if (catalog) return catalog;
      throw serviceError(r);
    }
    catalog = cleanCatalog(r.body);
    catalogAt = now();
    return catalog;
  });
  // §13 the Thank you wall – signed in or not: only asked while the Thank you page is open (the page asks this route),
  // with no token and nothing about the player; the service's ETag spares the body when nothing changed. ?have=<version>
  // → { unchanged: true } when the page already shows this version. Offline or failing: the last wall this server got,
  // marked stale (the page keeps its own copy across restarts).
  route('GET', '/thanks', async (req, m, url) => {
    const have = url.searchParams.get('have');
    const out = await readThanks();
    if (!out.data) {
      const e = httpError(out.status === 404 ? 404 : 503, out.status === 404 ? 'No Thank you page on this service yet' : 'The account service can’t be reached', out.status === 404 ? 'thanksMissing' : 'acctOffline');
      throw e;
    }
    const head = { version: out.version, fetchedAt: thanks.okAt, stale: out.stale };
    return have && have === out.version ? { unchanged: true, ...head } : { ...head, thanks: out.data };
  });
  route('GET', '/choices', () => {
    signedIn();
    return choices();
  });

  // §1.7 the account's sessions ("Signed-in devices"): this computer's is marked, the others can be signed out one by one
  route('GET', '/sessions', async () => {
    signedIn();
    const mine = session.sid;
    return { items: list(await call(API.sessions)).map((x) => cleanSession(x, mine)).filter(Boolean).slice(0, 50) };
  });
  route('DELETE', `/sessions/(${ID})`, async (req, m) => {
    signedIn();
    if (m[1] === session.sid) {
      // this computer: an ordinary sign-out (tokens go here as well)
      await goOffline();
      return { ...(await session.signOut()), current: true };
    }
    await call(API.session(m[1]), { method: 'DELETE' });
    return { ok: true };
  });

  // other players
  route('GET', `/users/(${ID})`, async (req, m) => {
    signedIn();
    return cleanProfile(await call(API.user(m[1])), service);
  });

  // friends: one call for the Friends page – friends with their presence, requests both ways
  route('GET', '/friends', async () => {
    signedIn();
    const [f, p, inc, out] = await Promise.all([call(API.friends), call(API.presenceFriends), call(API.requestsBox('incoming')), call(API.requestsBox('outgoing'))]);
    const presence = new Map(list(p).map(cleanPresence).filter(Boolean).map((x) => [x.userId, x]));
    return {
      friends: list(f).map((x) => cleanFriend(x, service)).filter(Boolean).map((x) => ({ ...x, presence: presence.get(x.user.id) || { userId: x.user.id, state: 'offline' } })),
      incoming: list(inc).map((x) => cleanRequest(x, service)).filter(Boolean),
      outgoing: list(out).map((x) => cleanRequest(x, service)).filter(Boolean),
    };
  });
  route('POST', '/friends/requests', async (req) => {
    signedIn();
    const q = parseFriendQuery((await readJson(req)).query);
    if (!q) throw httpError(400, 'Invalid handle or friend code', 'acct', { code: 'invalid_field', field: 'query' });
    const r = await call(API.requests, { method: 'POST', json: q });
    return { status: r.status === 'accepted' ? 'accepted' : 'sent' };
  });
  route('POST', `/friends/requests/(${ID})/(accept|ignore)`, async (req, m) => {
    signedIn();
    await call(API.request(m[1], m[2]), { method: 'POST' });
    return { ok: true };
  });
  route('DELETE', `/friends/requests/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.request(m[1]), { method: 'DELETE' });
    return { ok: true };
  });
  route('DELETE', `/friends/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.friend(m[1]), { method: 'DELETE' });
    return { ok: true };
  });
  route('GET', '/blocks', async () => {
    signedIn();
    return { items: list(await call(API.blocksList)).map((x) => ({ user: cleanFriend(x, service)?.user, since: null })).filter((x) => x.user) };
  });
  route('POST', '/blocks', async (req) => {
    signedIn();
    const userId = idOf((await readJson(req)).userId);
    await call(API.blocks, { method: 'POST', json: { user_id: userId } });
    return { ok: true };
  });
  route('DELETE', `/blocks/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.block(m[1]), { method: 'DELETE' });
    return { ok: true };
  });
  route('POST', '/reports', async (req) => {
    signedIn();
    const b = await readJson(req);
    const body = {
      user_id: idOf(b.userId), target: oneOf(b.target, ['profile', 'status', 'name', 'other'], 'profile'),
      reason: oneOf(b.reason, ['spam', 'harassment', 'hate', 'impersonation', 'inappropriate', 'other'], 'other'),
    };
    const note = typeof b.note === 'string' ? b.note.replace(/\r\n?/g, '\n').split('\n').slice(0, 6).map((l) => cleanText(l, 300)).join('\n').slice(0, 300).trim() : '';
    if (note) body.note = note;
    const r = await call(API.reports, { method: 'POST', json: body });
    return { ok: true, duplicate: r.duplicate === true };
  });

  // presence
  route('PUT', '/presence', async (req) => {
    setReport(await readJson(req));
    return { ok: true, pending };
  });

  // play with friends
  route('GET', '/invites', async () => {
    signedIn();
    const [ii, io, ji, jo] = await Promise.all([call(API.invitesBox('incoming')), call(API.invitesBox('outgoing')), call(API.joinBox('incoming')), call(API.joinBox('outgoing'))]);
    return {
      incoming: list(ii).map((x) => cleanInvite(x, service)).filter(Boolean).map(({ code, ...x }) => x), // never a code in a list for recipients
      outgoing: list(io).map((x) => cleanInvite(x, service)).filter(Boolean),
      joinIncoming: list(ji).map((x) => cleanJoinRequest(x, service)).filter(Boolean),
      joinOutgoing: list(jo).map((x) => cleanJoinRequest(x, service)).filter(Boolean),
    };
  });
  route('POST', '/invites', async (req) => {
    signedIn();
    const b = await readJson(req);
    const to = [...new Set((Array.isArray(b.to) ? b.to : []).map(idOf))];
    if (!to.length || to.length > 8) throw httpError(400, 'Pick 1 to 8 friends', 'acct', { code: 'invalid_field', field: 'to' });
    const code = inviteCode(b.code);
    if (!code) throw httpError(400, 'Invalid invite code', 'acct', { code: 'invalid_field', field: 'invite_code' });
    const r = await call(API.invites, { method: 'POST', json: { to, run: runRef(b.run), invite_code: code, ttl_minutes: Math.max(5, Math.min(1440, Number(b.ttlMinutes) || 15)) } });
    return cleanInvite(r.invite, service);
  });
  route('POST', `/invites/(${ID})/accept`, async (req, m) => {
    signedIn();
    const r = await call(API.invite(m[1], 'accept'), { method: 'POST' });
    return cleanInvite(r.invite, service, r.invite_code);
  });
  route('POST', `/invites/(${ID})/decline`, async (req, m) => {
    signedIn();
    await call(API.invite(m[1], 'decline'), { method: 'POST' });
    return { ok: true };
  });
  route('DELETE', `/invites/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.invite(m[1]), { method: 'DELETE' });
    return { ok: true };
  });
  route('POST', '/join-requests', async (req) => {
    signedIn();
    const r = await call(API.joinRequests, { method: 'POST', json: { to: idOf((await readJson(req)).to) } });
    return cleanJoinRequest(r.join_request, service);
  });
  route('POST', `/join-requests/(${ID})/accept`, async (req, m) => {
    signedIn();
    const b = await readJson(req);
    const code = inviteCode(b.code);
    if (!code) throw httpError(400, 'Invalid invite code', 'acct', { code: 'invalid_field', field: 'invite_code' });
    const r = await call(API.joinRequest(m[1], 'accept'), { method: 'POST', json: { invite_code: code, run: runRef(b.run) } });
    return cleanInvite(r.invite, service);
  });
  route('POST', `/join-requests/(${ID})/decline`, async (req, m) => {
    signedIn();
    await call(API.joinRequest(m[1], 'decline'), { method: 'POST' });
    return { ok: true };
  });
  route('DELETE', `/join-requests/(${ID})`, async (req, m) => {
    signedIn();
    await call(API.joinRequest(m[1]), { method: 'DELETE' });
    return { ok: true };
  });

  // souldew+ – only the verified token counts (readEntitlement above); kept with the session (encrypted) for the
  // offline grace, where the kept token is verified again until its grace_until
  route('GET', '/entitlements', async () => {
    signedIn();
    return readEntitlement();
  });
  // §8.3: the service answers "submitted" whatever the email is (no supporter oracle) – the result is read from the
  // verified entitlement: linked when the tier or its sources changed
  route('POST', '/link-email', async (req) => {
    signedIn();
    const email = String((await readJson(req)).email || '').trim();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Invalid email', 'acct', { code: 'invalid_field', field: 'email' });
    const before = await readEntitlement().catch(() => null);
    const sig = (b) => JSON.stringify([b?.tier, (b?.sources || []).map((x) => [x.kind, x.tier, x.status, x.until])]);
    const r = await call(API.linkEmail, { method: 'POST', json: { email } });
    if (r.submitted !== true) throw httpError(502, 'Unexpected answer', 'acct', { code: 'internal' });
    // the answer never says whether it matched (no supporter oracle): read the entitlement – a few times, the link is
    // written right away but the entitlement read may land on a replica a moment behind
    let after = null;
    for (let i = 0; i < 3; i++) {
      after = await readEntitlement();
      if (!before || sig(before) !== sig(after)) break;
      await new Promise((res) => setTimeout(res, 700));
    }
    await loadMe(true).catch(() => null);
    return { submitted: true, linked: !!before && sig(before) !== sig(after), tier: after.tier, badges: after.badges, until: after.until };
  });
  // §8.5: unlink every membership from this account. The pack key rotates – nothing cached can be read any more, so it
  // goes at once; the payer email stays locked for relinking (30 days from the link, at least 7 days from now)
  route('DELETE', '/link', async () => {
    signedIn();
    await call(API.unlink, { method: 'DELETE' });
    dropPackKey();
    session.setExtra('pack', null);
    session.setExtra('entitlement', null);
    const after = await readEntitlement().catch(() => {
      setOwn({ ...NO_ENT, graceUntil: null, packKeyId: null }); // offline right after: no souldew+ until the service says so
      return null;
    });
    await loadMe(true).catch(() => null);
    return { ok: true, tier: after?.tier || 'none' };
  });
  route('GET', '/packs', async () => {
    signedIn();
    return { items: list(await call(API.packs)).map(cleanPack).filter(Boolean) };
  });
  route('POST', `/packs/(${ID})/download`, async (req, m) => {
    signedIn();
    const d = cleanDownload(await call(API.packDownload(m[1]), { method: 'POST' }), service);
    session.setExtra('pack', { packId: d.packId, version: d.version, signature: d.signature, packKeyId: d.packKeyId });
    return d;
  });

  // §10.4: a 15-minute live theme preview (signed-in users; meant for non-members). Memory only on the page.
  route('POST', `/packs/(${ID})/preview`, async (req, m) => {
    signedIn();
    return cleanPreview(await call(API.packPreview(m[1]), { method: 'POST' }), service);
  });

  // ---- the Thank you wall (§13) -----------------------------------------------------------------------------------------
  // gen: bumps when the wall must be read again (an own opt-in changed); a read that started before keeps its answer for
  // its caller but neither satisfies a newer look nor marks the wall fresh. version: a hash of the wall's CONTENT – not
  // its `updated` time, which the service sets on every rebuild – so "unchanged" means unchanged.
  const thanks = { data: null, etag: null, version: null, at: 0, okAt: null, stale: false, avatars: new Set(), inflight: null, inflightGen: -1, gen: 0 };
  /** The wall: from the service when the last read is THANKS_MIN_GAP old (If-None-Match), else the one in memory. */
  function readThanks() {
    if (thanks.data && now() - thanks.at < THANKS_MIN_GAP) return Promise.resolve({ data: thanks.data, version: thanks.version, stale: thanks.stale });
    if (thanks.inflight && thanks.inflightGen === thanks.gen) return thanks.inflight;
    const gen = thanks.gen;
    const fresh = () => gen === thanks.gen; // no invalidation since this read started
    const read = (async () => {
      let status = 0;
      try {
        const headers = { Accept: 'application/json' };
        if (thanks.etag && thanks.data) headers['If-None-Match'] = thanks.etag;
        const r = await fetchImpl(`${service}${API.thanks}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
        status = r.status;
        if (r.status === 304 && thanks.data) {
          if (fresh()) thanks.at = now();
          thanks.okAt = now();
          thanks.stale = false;
          return { data: thanks.data, version: thanks.version, stale: false };
        }
        if (r.status === 200) {
          const data = cleanThanks(await r.json().catch(() => null), service);
          if (data) {
            const etag = r.headers.get('etag');
            thanks.etag = etag && etag.length <= 100 ? etag : null;
            thanks.data = data;
            thanks.version = thanksVersion(data);
            if (fresh()) thanks.at = now();
            thanks.okAt = now();
            thanks.stale = false;
            // the pictures of this wall may be shown signed out too (the avatar proxy takes only these)
            thanks.avatars = new Set(data.people.map((p) => p.avatar && new URL(p.avatar, 'http://x').searchParams.get('src')).filter(Boolean));
            return { data, version: thanks.version, stale: false };
          }
          status = 502;
        }
      } catch {
        status = 0;
      }
      if (fresh()) thanks.at = now() - THANKS_MIN_GAP + 10000; // failing: try again in 10 s at the earliest
      thanks.stale = true;
      return { data: thanks.data, version: thanks.version, stale: true, status };
    })().finally(() => {
      if (thanks.inflight === read) thanks.inflight = null;
    });
    thanks.inflight = read;
    thanks.inflightGen = gen;
    return read;
  }

  /** A no-auth GET of the service (the catalog). */
  async function fetchPublic(path) {
    try {
      const r = await fetchImpl(`${service}${path}`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      let body = {};
      try {
        body = await r.json();
      } catch {}
      return { status: r.status, body };
    } catch {
      return { status: 0, body: {} };
    }
  }

  // ---- the browser's way back: /auth/done ----------------------------------------------------------------------------
  /**
   * GET /auth/done?code=…&state=… – the service's redirect after Discord said yes. Only a real top-level navigation to
   * exactly http://127.0.0.1:<port> is taken (a page's fetch or <img>, another host name, an Origin header, repeated
   * or extra parameters are turned away); the code is used for the pending sign-in only if the state is ours. The
   * answer is a redirect to /auth/done?r=<outcome>, so the code doesn't stay in the browser's address bar and history.
   */
  async function authDone(req, res, url) {
    await session.load();
    const page = (status, result) => {
      res.writeHead(status, AUTH_PAGE_HEADERS);
      res.end(authPage(result, lang()));
    };
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
      return res.end();
    }
    const h = req.headers;
    const hostOk = String(h.host || '').toLowerCase() === `127.0.0.1:${port()}`;
    const navigation = (h['sec-fetch-mode'] === undefined || h['sec-fetch-mode'] === 'navigate') && (h['sec-fetch-dest'] === undefined || h['sec-fetch-dest'] === 'document');
    if (!hostOk || !navigation || h.origin !== undefined) return page(403, 'failed');
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some((k) => !['code', 'state', 'error', 'r', 'n'].includes(k))) return page(400, 'bad');
    const q = Object.fromEntries(url.searchParams);
    if ('r' in q) {
      // the outcome page only for the redirect this server just made (a one-time nonce): a web page can't show
      // "You're signed in" by linking to /auth/done?r=ok
      const shown = keys.length === 2 && AUTH_RESULTS.includes(q.r) && takeOutcome(q.n) === q.r;
      return shown ? page(q.r === 'ok' ? 200 : 400, q.r) : page(400, 'bad');
    }
    if (!('state' in q)) return page(400, 'bad');
    const out = await session.finishLogin({ code: q.code, state: q.state, error: q.error ? cleanText(q.error, 40) : null });
    const result = out.ok ? 'ok' : out.error;
    if (out.ok) {
      await loadMe(true).catch(() => null);
      emit('account', { kind: 'signed-in' });
      try {
        focus();
      } catch {}
    }
    const shown = AUTH_RESULTS.includes(result) ? result : 'failed';
    res.writeHead(303, { Location: `/auth/done?r=${shown}&n=${putOutcome(shown)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }
  const outcomes = new Map(); // nonce → { result, at } – single use, 5 minutes
  function putOutcome(result) {
    for (const [k, v] of outcomes) if (now() - v.at > 5 * 60000) outcomes.delete(k);
    if (outcomes.size > 50) outcomes.delete(outcomes.keys().next().value);
    const n = randomBytes(18).toString('base64url');
    outcomes.set(n, { result, at: now() });
    return n;
  }
  function takeOutcome(n) {
    const v = typeof n === 'string' && n.length === 24 ? outcomes.get(n) : null;
    if (!v) return null;
    outcomes.delete(n);
    return now() - v.at <= 5 * 60000 ? v.result : null;
  }

  // ---- avatars --------------------------------------------------------------------------------------------------------
  const avatars = new Map(); // source URL → { type, buf }
  /** GET /api/account/avatar?src=<allowed avatar URL>: fetched once, checked to be a picture, kept in memory. */
  async function avatar(req, res, url) {
    await session.load();
    const src = safeAvatarUrl(url.searchParams.get('src'), service);
    const fail = (status) => {
      res.writeHead(status, { 'Cache-Control': 'no-store' });
      res.end();
    };
    if (req.method !== 'GET' || !src || [...url.searchParams.keys()].length !== 1) return fail(400);
    // signed out: only the pictures of the Thank you wall the player is looking at
    if (!session.signedIn && !thanks.avatars.has(src)) return fail(404);
    let hit = avatars.get(src);
    if (!hit) {
      try {
        const r = await fetchImpl(src, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        const len = Number(r.headers.get('content-length'));
        if (!r.ok || (Number.isFinite(len) && len > AVATAR_MAX)) return fail(404);
        // (no length said – a chunked answer: read no further than a picture can be)
        const buf = await readCapped(r, AVATAR_MAX);
        const type = buf && imageType(buf);
        if (!type) return fail(404);
        hit = { type, buf };
        avatars.set(src, hit);
        if (avatars.size > AVATAR_CACHE) avatars.delete(avatars.keys().next().value);
      } catch {
        return fail(404);
      }
    }
    res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.buf.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' });
    return res.end(hit.buf);
  }

  /**
   * "I'm offline now" (API.md §5.2) – the app quits, the player signs out. Without it friends would see the player
   * online for another 180 s. Best effort and bounded: it never holds the caller up longer than `ms` (a refresh of
   * the access token, a slow network …). → true when the service confirmed it.
   */
  async function goOffline(ms = OFFLINE_DELETE_MS) {
    stopHeartbeat();
    if (!session.signedIn || !lastSent) return false;
    lastSent = null;
    let t = null;
    const gone = session.request(API.presence, { method: 'DELETE', timeout: ms }).then((r) => r.status === 200).catch(() => false);
    const late = new Promise((res) => { t = setTimeout(() => res(false), ms + 100); t.unref?.(); });
    try {
      return await Promise.race([gone, late]);
    } finally {
      clearTimeout(t);
    }
  }

  /** The server closes: stop the heartbeat, say offline (not awaited – the desktop app awaits goOffline() before). */
  function close() {
    goOffline().catch(() => {});
  }

  /** For "Save diagnostics": signed in yes / no and the tier – nothing else. */
  const diagnostics = () => ({ signedIn: session.signedIn, tier: session.signedIn ? own?.tier || session.publicState().account?.tier || 'none' : null });

  /** Reads the saved sign-in in the background (the server calls it once it is up – ./session.mjs load). */
  const loadSession = () => session.load();

  return { routes, authDone, avatar, close, goOffline, diagnostics, session, setReport, loadSession, get service() { return service; } };
}

/** The wall's version for the page's ?have=: its content only (who, which tier and look, the counts) – never `updated`. */
export function thanksVersion(data) {
  return createHash('sha256').update(JSON.stringify([data.total, data.counts, data.people])).digest('base64url').slice(0, 16);
}

const list = (body) => (Array.isArray(body?.items) ? body.items : []);

/** One session of the list (§1.7) → { id, device, platform, createdAt, lastUsedAt, current }. */
export function cleanSession(x, mine) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !/^ses_[A-Za-z0-9_-]{1,64}$/.test(x.id)) return null;
  const time = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
  return {
    id: x.id, device: cleanText(x.device_name, 40) || null, platform: oneOf(x.platform, ['mac', 'win', 'linux'], null),
    createdAt: time(x.created_at), lastUsedAt: time(x.last_used_at), current: x.current === true || (!!mine && x.id === mine),
  };
}

function idOf(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(v)) throw httpError(400, 'Invalid id', 'acct', { code: 'invalid_field', field: 'user_id' });
  return v;
}

/** A run as an invite names it (§6.2): name, game, mode, system – nothing that identifies the run itself. */
function runRef(v) {
  const o = v && typeof v === 'object' ? v : {};
  const out = { name: withoutFileNames(o.name, RUN_NAME_MAX) || 'Run', game: withoutFileNames(o.game, 60) || 'Game', mode: oneOf(o.mode, ['soullink', 'nuzlocke', 'together'], 'soullink') };
  const sys = presenceSystem(o.system);
  if (sys) out.system = sys;
  return out;
}

/**
 * A free text the player typed, as the service stores it (API.md §0.6): NFKC, single spaces – and refused here
 * already (with the service's own error) when it holds < or > or no letter or digit at all.
 */
export function userText(v, max, field) {
  const s = cleanText(typeof v === 'string' ? v.normalize('NFKC') : v, max);
  if (!s) return null;
  if (/[<>]/.test(s) || !/[\p{L}\p{N}]/u.test(s)) throw httpError(400, 'Text not allowed', 'acct', { code: 'text_rejected', field });
  return s;
}

/**
 * The showcase as §2.2 takes it (it replaces the whole showcase) from the page's shape: the most trusted line with
 * `numbers` ({ teams, top_level, fell } or null), else the old free text unchanged (the service keeps it only as it
 * was), else nothing.
 */
export function showcaseBody(s, numbers = null) {
  const tr = s.trusted && typeof s.trusted === 'object' ? s.trusted : null;
  const species = int(tr?.species, 1, SPECIES_MAX);
  let trusted = null;
  if (species) {
    trusted = { species, line: int(tr.line, 1, SPECIES_MAX) || species, note: tr.note == null || tr.note === '' ? null : userText(tr.note, TRUSTED_NOTE_MAX, 'showcase.trusted.note') };
    if (numbers) Object.assign(trusted, { teams: numbers.teams, top_level: numbers.top_level, fell: numbers.fell });
  } else if (tr === null && typeof s.trustedText === 'string' && s.trustedText) {
    trusted = s.trustedText; // the old free text, sent back exactly as the service has it
  }
  return {
    trophies: [...new Set((Array.isArray(s.trophies) ? s.trophies : []).map(catalogId).filter(Boolean))].slice(0, 3),
    trusted,
    favorite_game: userText(s.favoriteGame, FAVORITE_MAX, 'showcase.favorite_game'),
  };
}

/**
 * The page's profile edits (camelCase) → the PATCH body of §2.2 – known fields only, each checked. `numbers(line)`:
 * the most trusted line's numbers from this computer's runs, or null when they aren't shared.
 */
export function mePatch(b, { numbers = null } = {}) {
  const out = {};
  if ('name' in b) out.display_name = b.name === null ? null : userText(b.name, NAME_MAX, 'display_name');
  for (const k of ['banner', 'frame', 'nameplate', 'title', 'accent']) if (k in b) out[k] = b[k] === null ? null : catalogId(b[k]);
  if ('accent' in b && !out.accent) delete out.accent; // never null: the palette always has a colour
  if ('status' in b) out.status = userText(b.status, STATUS_MAX, 'status');
  if ('showcase' in b && b.showcase && typeof b.showcase === 'object') {
    const line = int(b.showcase.trusted?.line, 1, SPECIES_MAX) || int(b.showcase.trusted?.species, 1, SPECIES_MAX);
    out.showcase = showcaseBody(b.showcase, line && numbers ? numbers(line) : null);
  }
  if ('showcaseLayout' in b) {
    if (!SHOWCASE_LAYOUTS.includes(b.showcaseLayout)) throw httpError(400, 'Unknown showcase layout', 'acct', { code: 'invalid_field', field: 'showcase_layout' });
    out.showcase_layout = b.showcaseLayout;
  }
  if ('privacy' in b && b.privacy && typeof b.privacy === 'object') {
    const p = b.privacy;
    const priv = {};
    if (PROFILE_VISIBILITY.includes(p.profile)) priv.profile = p.profile;
    if (PRESENCE_VISIBILITY.includes(p.presence)) priv.presence = p.presence;
    if (typeof p.showLocation === 'boolean') priv.show_location = p.showLocation;
    if (typeof p.showRuns === 'boolean') priv.show_runs = p.showRuns;
    if (['everyone', 'nobody'].includes(p.friendRequests)) priv.friend_requests = p.friendRequests;
    if (typeof p.showOnThanks === 'boolean') priv.show_on_thanks = p.showOnThanks;
    if (Object.keys(priv).length) out.privacy = priv;
  }
  if (!Object.keys(out).length) throw httpError(400, 'Nothing to change', 'acct', { code: 'bad_request' });
  return out;
}

/** PNG, WebP, GIF or JPEG by their first bytes – the declared type of the answer doesn't count. */
export function imageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

function cleanPack(p) {
  if (!p || typeof p !== 'object' || !catalogId(p.id)) return null;
  return {
    id: p.id, version: typeof p.version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(p.version) ? p.version : null,
    kind: oneOf(p.kind, ['skins', 'banners', 'frames', 'launch', 'mixed', 'preview'], 'mixed'), title: cleanText(p.title, 60),
    requiredTier: oneOf(p.required_tier, ['free', 'supporter', 'plus'], 'plus'), entitled: p.entitled === true, previewable: p.previewable === true,
  };
}

const b64 = (v, max) => (typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v) ? v : null);

/** A live preview answer (§10.4): like a download, with its own key (for this preview only) and its end. */
function cleanPreview(d, service) {
  const base = cleanDownload(d, service);
  const keyId = typeof d?.key_id === 'string' && /^pv_[A-Za-z0-9_-]{22}$/.test(d.key_id) ? d.key_id : null;
  const key = typeof d?.preview_key === 'string' && d.preview_key.length === 43 && /^[A-Za-z0-9_-]+$/.test(d.preview_key) ? d.preview_key : null;
  const expiresAt = typeof d?.expires_at === 'string' && Number.isFinite(Date.parse(d.expires_at)) ? new Date(d.expires_at).toISOString() : null;
  if (!keyId || !key || !expiresAt || !base.manifest || !base.signature || !base.files.length) throw httpError(502, 'Bad preview answer', 'acct', { code: 'internal' });
  return { ...base, packKeyId: keyId, previewId: keyId, key, expiresAt, offlineGrace: false };
}

/** A pack download answer (§10.2): manifest and signature as base64url, file URLs only on the service itself. */
function cleanDownload(d, service) {
  const origin = new URL(service).origin;
  const files = (Array.isArray(d?.files) ? d.files : []).slice(0, 2000).map((f) => {
    let u = null;
    try {
      u = new URL(f.url);
    } catch {}
    const path = typeof f.path === 'string' && f.path.length <= 200 && /^[A-Za-z0-9_./-]+$/.test(f.path) && !f.path.includes('..') ? f.path : null;
    return u && u.origin === origin && !u.username && path ? { path, url: u.href } : null;
  }).filter(Boolean);
  return {
    packId: catalogId(d?.pack_id), version: typeof d?.version === 'string' ? d.version.slice(0, 32) : null,
    manifest: b64(d?.manifest, 2 * 1024 * 1024), signature: b64(d?.signature, 200), watermarkId: typeof d?.watermark_id === 'string' && /^wm_[A-Za-z0-9_-]{1,40}$/.test(d.watermark_id) ? d.watermark_id : null,
    packKeyId: typeof d?.pack_key_id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(d.pack_key_id) ? d.pack_key_id : null,
    expiresAt: typeof d?.expires_at === 'string' ? Date.parse(d.expires_at) || null : null, files,
  };
}
