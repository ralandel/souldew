// A fake souldew accounts service for tests and screenshots: the parts of souldew-accounts docs/API.md the app uses,
// in memory, on a random local port. Strict where the real one is strict (PKCE, redirect_uri, single-use login codes,
// refresh rotation with reuse detection, unknown fields, friends-only invites, visibility), with switches for the
// cases a test needs (who signs in next, a cancelled sign-in, short access tokens). Discord itself is skipped:
// /auth/discord/start sends the browser straight back to the app's loopback.
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes, createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { ACCENTS } from '../../shared/social.mjs';

const rid = (prefix) => `${prefix}_${randomBytes(16).toString('base64url').slice(0, 22)}`;
const tok = () => randomBytes(32).toString('base64url');

/** A throwaway Ed25519 key pair like the service's entitlement key: { publicKey (raw, base64url), kid, sign(payload) }. */
export function entitlementSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  const kid = createHash('sha256').update(Buffer.from(x, 'base64url')).digest('base64url').slice(0, 12);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload, header = {}) => {
    const input = `${b64({ alg: 'EdDSA', typ: 'souldew-ent+jwt', kid, ...header })}.${b64(payload)}`;
    return `${input}.${cryptoSign(null, Buffer.from(input), privateKey).toString('base64url')}`;
  };
  return { publicKey: x, kid, sign };
}
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha = (s) => createHash('sha256').update(s).digest('base64url');

/** A tiny real PNG (one colour) – what an avatar proxy answers. */
export function tinyPng(r = 120, g = 160, b = 220, size = 8) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** A 64×64 PNG of a mirrored 8×8 pixel pattern in two colours from the hash – a stand-in for a Discord avatar. */
export function identicon(hash) {
  const h = createHash('sha256').update(String(hash)).digest();
  const fg = [90 + (h[0] % 150), 90 + (h[1] % 150), 90 + (h[2] % 150)];
  const bg = [24 + (h[3] % 30), 22 + (h[4] % 30), 30 + (h[5] % 30)];
  const N = 8;
  const S = 8;
  const on = (x, y) => (h[6 + y] >> Math.min(x, N - 1 - x)) & 1;
  const rows = [];
  for (let y = 0; y < N * S; y++) {
    const row = [0];
    for (let x = 0; x < N * S; x++) row.push(...(on(Math.floor(x / S), Math.floor(y / S)) ? fg : bg));
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N * S, 0);
  ihdr.writeUInt32BE(N * S, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

export const CATALOG = {
  cosmetics: [
    { kind: 'banner', id: 'night-train', tier: 'plus' }, { kind: 'banner', id: 'dusk-ridge', tier: 'free' }, { kind: 'banner', id: 'tall-grass', tier: 'plus' },
    { kind: 'frame', id: 'brass-ring', tier: 'plus' }, { kind: 'frame', id: 'plain-ring', tier: 'free' },
    { kind: 'nameplate', id: 'night-train', tier: 'plus' }, { kind: 'nameplate', id: 'chalk', tier: 'free' },
    { kind: 'title', id: 'win-nuzlocke', tier: 'free' }, { kind: 'title', id: 'win-soul-link', tier: 'free' }, { kind: 'title', id: 'first-catch', tier: 'free' },
    { kind: 'trophy', id: 'win-nuzlocke', tier: 'free' }, { kind: 'trophy', id: 'win-soul-link', tier: 'free' }, { kind: 'trophy', id: 'badges16', tier: 'free' }, { kind: 'trophy', id: 'first-catch', tier: 'free' },
  ],
  accents: ACCENTS, // the same palette as the service (shared/social.mjs)
};

const ME_FIELDS = ['display_name', 'banner', 'frame', 'nameplate', 'title', 'accent', 'status', 'showcase', 'showcase_layout', 'privacy'];
const LAYOUTS = ['case', 'lcd', 'shelf'];
const TRUSTED_KEYS = ['species', 'line', 'note', 'teams', 'top_level', 'fell'];

/** A GET with exactly these headers (fetch would set its own Sec-Fetch-* – a browser navigation sends navigate/document). */
export function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function startFakeAccounts({ port = 0 } = {}) {
  const f = {
    users: new Map(), loginCodes: new Map(), states: new Map(), sessions: new Map(), access: new Map(), refresh: new Map(),
    friends: new Map(), requests: new Map(), blocks: new Set(), presence: new Map(), invites: new Map(), joins: new Map(), reports: [],
    log: [], previewCount: new Map(), nextLogin: null, denyNext: false, accessTtl: 900, offlinePaths: new Set(), memberships: new Map(), keepStats: new Set(), pinPresence: new Set(),
    // the entitlement key (GET /v1/entitlements signs its token with it); tests trust its public half via SLS_ACCOUNTS_DEV_ENT_KEY
    ent: entitlementSigner(),
    // test hooks: claims to change in the next token(s), a clock for the token (seconds)
    entClaims: null, entNow: null,
    // §14 "Find a SoulLink partner": the posts the bot was handed, and the bot's next answer ({ status, body }) or null
    lfgPosts: [], lfgAnswer: null,
  };
  let base = '';

  // ---- data helpers ----
  f.addUser = (o = {}) => {
    const id = o.id || rid('u');
    const handle = o.handle || `user${f.users.size + 1}`;
    const u = {
      id, handle, display_name: o.display_name || handle, display_name_is_custom: false, discord: { id: String(80351110224678912n + BigInt(f.users.size)), username: handle, global_name: o.display_name || handle },
      friend_code: o.friend_code || `SD-${randomBytes(3).toString('hex').toUpperCase().slice(0, 4).replace(/[ILOU]/g, '7')}-${randomBytes(3).toString('hex').toUpperCase().slice(0, 4).replace(/[ILOU]/g, '9')}`,
      banner: o.banner ?? null, frame: o.frame ?? null, nameplate: o.nameplate ?? null, title: o.title ?? null, accent: o.accent || 'moss', status: o.status ?? null,
      showcase: o.showcase || { trophies: [], trusted: null, favorite_game: null }, showcase_layout: o.showcase_layout || 'case',
      privacy: { profile: 'friends', presence: 'friends', show_location: false, show_runs: false, friend_requests: 'everyone', show_on_thanks: null, ...(o.privacy || {}) },
      thanksSince: o.thanksSince || '2026-11', coffee: o.coffee === true, // the Thank you wall (§13): a one-time supporter, when the support started
      stats: o.stats || null, entitlement: o.entitlement || { tier: 'none', until: null, badges: [] }, created_at: iso(o.createdAt || Date.parse('2026-03-02T10:00:00Z')),
      avatar_hash: o.avatar === false ? null : randomBytes(8).toString('hex'),
    };
    f.users.set(id, u);
    return u;
  };
  const pairKey = (a, b) => [a, b].sort().join('|');
  f.befriend = (a, b, since = Date.now() - 86400000 * 60) => f.friends.set(pairKey(a, b), iso(since));
  const areFriends = (a, b) => f.friends.has(pairKey(a, b));
  const blocked = (a, b) => f.blocks.has(`${a}>${b}`) || f.blocks.has(`${b}>${a}`);
  const avatarUrl = (u) => (u.avatar_hash ? `${base}/v1/avatars/${u.id}/${u.avatar_hash}.png?size=128` : null);
  const packKey = (u) => createHash('sha256').update(`pack|${u.id}|${u.keyEpoch || 1}`).digest('base64url');
  /** §13: a user's place on the wall – their tier (patron → legend), or coffee for a one-time supporter. */
  const thanksTier = (u) => ({ patron: 'legend', plus: 'plus', supporter: 'supporter' })[u.entitlement.tier] || (u.coffee ? 'coffee' : null);
  const plusOk = (u) => u.entitlement.tier === 'plus' || u.entitlement.tier === 'patron'; // §8.0: patron = souldew+
  const premium = (kind, id) => CATALOG.cosmetics.find((c) => c.kind === kind && c.id === id)?.tier === 'plus';
  const shown = (u, k) => (u[k] && premium(k, u[k]) && !plusOk(u) ? null : u[k]);
  const card = (u) => ({ id: u.id, handle: u.handle, display_name: u.display_name, avatar_url: avatarUrl(u), frame: shown(u, 'frame'), nameplate: shown(u, 'nameplate'), accent: u.accent, title: u.title, badges: u.entitlement.badges });
  // §2.1/§3.1: the most trusted line, or the old free text as trusted_text; others see the numbers only with show_runs
  const showcaseView = (u, own) => {
    const sc = u.showcase || {};
    const tr = sc.trusted && typeof sc.trusted === 'object' ? sc.trusted : null;
    const numbers = tr && (own || u.privacy.show_runs);
    return { trophies: sc.trophies || [], favorite_game: sc.favorite_game ?? null, trusted_text: typeof sc.trusted === 'string' ? sc.trusted : null,
      trusted: tr ? { species: tr.species, line: tr.line, note: tr.note ?? null, teams: numbers ? tr.teams ?? null : null, top_level: numbers ? tr.top_level ?? null : null, fell: numbers ? tr.fell ?? null : null } : null };
  };
  const me = (u) => {
    const locked = ['banner', 'frame', 'nameplate'].filter((k) => u[k] && premium(k, u[k]) && !plusOk(u));
    return { id: u.id, handle: u.handle, display_name: u.display_name, display_name_is_custom: u.display_name_is_custom, avatar_url: avatarUrl(u), discord: u.discord, friend_code: u.friend_code,
      banner: u.banner, frame: u.frame, nameplate: u.nameplate, title: u.title, accent: u.accent, status: u.status, showcase: showcaseView(u, true), ...(f.noLayouts ? {} : { showcase_layout: u.showcase_layout }), privacy: u.privacy,
      stats: u.privacy.show_runs ? u.stats : null, entitlement: u.entitlement, ...(f.noThanks ? {} : { thanks_tier: thanksTier(u) }), created_at: u.created_at, ...(locked.length ? { locked } : {}) };
  };
  const relationship = (viewer, u) => (viewer === u.id ? 'self' : areFriends(viewer, u.id) ? 'friend'
    : [...f.requests.values()].some((r) => r.status === 'pending' && r.from === viewer && r.to === u.id) ? 'request_sent'
      : [...f.requests.values()].some((r) => r.status === 'pending' && r.from === u.id && r.to === viewer) ? 'request_received' : 'none');
  const profile = (viewer, u) => ({ id: u.id, handle: u.handle, display_name: u.display_name, avatar_url: avatarUrl(u), banner: shown(u, 'banner'), frame: shown(u, 'frame'), nameplate: shown(u, 'nameplate'),
    title: u.title, accent: u.accent, badges: u.entitlement.badges, status: u.status, showcase: showcaseView(u, false), showcase_layout: u.showcase_layout, stats: u.privacy.show_runs ? u.stats : null,
    relationship: relationship(viewer, u), member_since: u.created_at.slice(0, 10) });
  const pendingOf = (uid) => ({
    friend_requests: [...f.requests.values()].filter((r) => r.to === uid && r.status === 'pending').length,
    invites: [...f.invites.values()].filter((i) => i.status === 'active' && i.recipients.some((r) => r.user === uid && r.status === 'pending') && i.expires > Date.now()).length,
    join_requests: [...f.joins.values()].filter((j) => j.to === uid && j.status === 'pending').length,
  });
  const inviteView = (inv, viewer, withCode = false) => {
    const sender = viewer === inv.from;
    const mine = inv.recipients.find((r) => r.user === viewer);
    const status = inv.status === 'cancelled' ? 'cancelled' : inv.expires < Date.now() ? 'expired' : sender ? 'pending' : mine?.status || 'pending';
    return { id: inv.id, from: card(f.users.get(inv.from)), run: inv.run, status, created_at: iso(inv.created), expires_at: iso(inv.expires),
      ...(sender ? { recipients: inv.recipients.map((r) => ({ user: card(f.users.get(r.user)), status: r.status })), invite_code: inv.code, ...(inv.pack_ref ? { pack_ref: inv.pack_ref } : {}) } : {}),
      ...(withCode ? { invite_code: inv.code } : {}) };
  };

  // ---- HTTP ----
  const err = (res, status, code, extra = {}) => json(res, status, { error: { code, message: code, ...extra } });
  function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': rid('rq'), ...headers });
    res.end(JSON.stringify(body));
  }
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    return JSON.parse(text);
  }
  const unknown = (body, allowed) => Object.keys(body).find((k) => !allowed.includes(k));
  function authUser(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return { error: 'unauthorized' };
    const a = f.access.get(m[1]);
    if (!a) return { error: 'unauthorized' };
    const s = f.sessions.get(a.sid);
    if (!s || s.revoked || !f.users.has(s.user)) return { error: 'session_revoked' };
    if (a.exp < Date.now()) return { error: 'token_expired' };
    return { user: f.users.get(s.user), sid: a.sid };
  }
  function issue(sid) {
    const access = `${tok()}.${tok()}.${tok()}`;
    const refresh = tok();
    f.access.set(access, { sid, exp: Date.now() + f.accessTtl * 1000 });
    f.refresh.set(sha(refresh), { sid, used: false });
    const s = f.sessions.get(sid);
    return { token_type: 'Bearer', access_token: access, expires_in: f.accessTtl, refresh_token: refresh, refresh_expires_in: 2592000, session_id: sid, account: me(f.users.get(s.user)) };
  }
  const revokeSession = (sid) => {
    const s = f.sessions.get(sid);
    if (s) s.revoked = true;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const path = url.pathname;
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['content-length'] && Number(req.headers['content-length']) > 0 && !/^application\/json/.test(req.headers['content-type'] || '')) return err(res, 415, 'unsupported_media_type');
      try {
        body = await readBody(req);
      } catch {
        return err(res, 400, 'invalid_json');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return err(res, 400, 'invalid_json');
    }
    f.log.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization || null, headers: req.headers });
    if (f.offlinePaths.has(path)) return req.socket.destroy();
    try {
      return await route(req, res, url, path, body);
    } catch (e) {
      return err(res, 500, 'internal', { message: e.message });
    }
  });

  async function route(req, res, url, path, body) {
    const q = Object.fromEntries(url.searchParams);
    // ---- §1 sign-in ----
    if (path === '/auth/discord/start' && req.method === 'GET') {
      const okRedirect = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{4,5})\/auth\/done$/.exec(q.redirect_uri || '');
      if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge || '') || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{16,128}$/.test(q.state || '') || !okRedirect || Number(okRedirect[2]) < 1024) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        return res.end('<p>This sign-in link is not valid.</p>');
      }
      if (f.denyNext) {
        f.denyNext = false;
        res.writeHead(302, { Location: `${q.redirect_uri}?error=access_denied&state=${encodeURIComponent(q.state)}` });
        return res.end();
      }
      const uid = f.nextLogin || [...f.users.keys()][0];
      const code = tok();
      f.loginCodes.set(code, { uid, challenge: q.code_challenge, redirect: q.redirect_uri, exp: Date.now() + 120000, used: false });
      res.writeHead(302, { Location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (path === '/auth/token' && req.method === 'POST') {
      if (body.grant_type === 'login_code') {
        if (unknown(body, ['grant_type', 'code', 'code_verifier', 'redirect_uri', 'device_name', 'platform'])) return err(res, 400, 'unknown_field', { field: unknown(body, ['grant_type', 'code', 'code_verifier', 'redirect_uri', 'device_name', 'platform']) });
        const c = f.loginCodes.get(body.code);
        if (!c || c.used || c.exp < Date.now() || sha(String(body.code_verifier || '')) !== c.challenge || body.redirect_uri !== c.redirect) {
          if (c) c.used = true;
          return err(res, 400, 'invalid_grant');
        }
        c.used = true;
        const sid = rid('ses');
        f.sessions.set(sid, { user: c.uid, revoked: false, device: body.device_name, platform: body.platform, created: Date.now() });
        return json(res, 200, issue(sid));
      }
      if (body.grant_type === 'refresh_token') {
        const r = f.refresh.get(sha(String(body.refresh_token || '')));
        if (!r) return err(res, 400, 'invalid_grant');
        const s = f.sessions.get(r.sid);
        if (r.used) {
          revokeSession(r.sid);
          return err(res, 401, 'refresh_reused');
        }
        if (!s || s.revoked) return err(res, 401, 'session_revoked');
        r.used = true;
        return json(res, 200, issue(r.sid));
      }
      return err(res, 400, 'bad_request');
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      const r = body.refresh_token ? f.refresh.get(sha(body.refresh_token)) : null;
      if (r) revokeSession(r.sid);
      const a = authUser(req);
      if (a.sid) revokeSession(a.sid);
      return json(res, 200, { ok: true });
    }
    if (path === '/auth/logout-all' && req.method === 'POST') {
      const a = authUser(req);
      if (a.error) return err(res, 401, a.error);
      let n = 0;
      for (const s of f.sessions.values()) if (s.user === a.user.id && !s.revoked) { s.revoked = true; n++; }
      return json(res, 200, { ok: true, revoked: n });
    }
    if (path === '/v1/catalog' && req.method === 'GET') return json(res, 200, CATALOG);
    if (path === '/v1/thanks' && req.method === 'GET') {
      // §13: every user with a tier or a coffee counts (plus f.thanksAnonymous: supports nobody linked); only opted-in
      // ones are named. f.noThanks: a service before §13 (404); f.thanksDown: unreachable-ish (503).
      if (f.noThanks) return err(res, 404, 'not_found');
      if (f.thanksDown) return err(res, 503, 'not_configured');
      f.thanksHits = (f.thanksHits || 0) + 1;
      const order = ['legend', 'plus', 'supporter', 'coffee'];
      const counts = { legend: 0, plus: 0, supporter: 0, coffee: 0, ...(f.thanksAnonymous || {}) };
      const people = [];
      for (const x of f.users.values()) {
        const tier = thanksTier(x);
        if (!tier) continue;
        counts[tier]++;
        if (x.privacy.show_on_thanks !== true) continue;
        const p = { name: x.display_name, tier, since: x.thanksSince };
        const av = avatarUrl(x);
        if (av) p.avatar = av;
        if (x.banner && (!premium('banner', x.banner) || plusOk(x))) p.banner = x.banner;
        if (x.frame && (!premium('frame', x.frame) || plusOk(x))) p.frame = x.frame;
        people.push(p);
      }
      people.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || a.since.localeCompare(b.since) || a.name.localeCompare(b.name));
      const total = Object.values(counts).reduce((n, v) => n + v, 0);
      const bodyText = JSON.stringify({ updated: iso(f.thanksUpdated || Date.now()), total, counts, people });
      // like the service: a weak ETag of the content – `updated` (the build time) changes on every build, the ETag doesn't
      const etag = `W/"${sha(JSON.stringify({ total, counts, people })).slice(0, 20)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
      return res.end(bodyText);
    }
    const av = /^\/v1\/avatars\/(u_[A-Za-z0-9_-]+)\/([a-f0-9]+)\.png$/.exec(path);
    if (av && req.method === 'GET') {
      const u = f.users.get(av[1]);
      if (!u || u.avatar_hash !== av[2]) return err(res, 404, 'not_found');
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(identicon(u.avatar_hash));
    }
    if (path === '/health') return json(res, 200, { ok: true });

    // ---- everything below needs a session ----
    const a = authUser(req);
    if (a.error) return err(res, 401, a.error);
    const u = a.user;
    let m;

    if (path === '/v1/me' && req.method === 'GET') return json(res, 200, me(u));
    if (path === '/v1/me' && req.method === 'PATCH') {
      const bad = unknown(body, f.noLayouts ? ME_FIELDS.filter((k) => k !== 'showcase_layout') : ME_FIELDS); // noLayouts: a service before migration 0004
      if (bad) return err(res, 400, 'unknown_field', { field: bad });
      for (const k of ['banner', 'frame', 'nameplate', 'title']) {
        if (!(k in body)) continue;
        if (body[k] !== null && !CATALOG.cosmetics.some((c) => c.kind === k && c.id === body[k])) return err(res, 400, 'invalid_field', { field: k });
        if (body[k] && premium(k, body[k]) && !plusOk(u)) return err(res, 403, 'not_entitled');
      }
      if ('accent' in body && !CATALOG.accents.some((x) => x.key === body.accent)) return err(res, 400, 'invalid_field', { field: 'accent' });
      if ('status' in body && body.status !== null && (typeof body.status !== 'string' || body.status.length > 60 || /https?:|discord\.gg|badword|[<>]/i.test(body.status))) return err(res, 400, 'text_rejected', { field: 'status', reason: 'filtered' });
      if ('showcase' in body) {
        const s = body.showcase;
        if (unknown(s, ['trophies', 'trusted', 'favorite_game']) || !Array.isArray(s.trophies) || s.trophies.length > 3) return err(res, 400, 'invalid_field', { field: 'showcase' });
        const tr = s.trusted;
        if (typeof tr === 'string' && tr !== u.showcase?.trusted) return err(res, 400, 'invalid_field', { field: 'showcase.trusted' }); // free text: only the old value, unchanged
        if (tr && typeof tr === 'object') {
          const bad3 = unknown(tr, TRUSTED_KEYS);
          if (bad3) return err(res, 400, 'unknown_field', { field: `showcase.trusted.${bad3}` });
          const intIn = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
          if (!intIn(tr.species, 1, 1025) || !intIn(tr.line, 1, 1025)) return err(res, 400, 'invalid_field', { field: 'showcase.trusted.species' });
          const nums = ['teams', 'top_level', 'fell'].filter((k) => tr[k] != null).length;
          if (nums !== 0 && nums !== 3) return err(res, 400, 'invalid_field', { field: 'showcase.trusted' });
          if (nums && (!intIn(tr.teams, 0, 10000) || !intIn(tr.top_level, 1, 100) || !intIn(tr.fell, 0, 10000))) return err(res, 400, 'invalid_field', { field: 'showcase.trusted' });
          if (tr.note != null && (typeof tr.note !== 'string' || !tr.note || tr.note.length > 60 || /https?:|badword|[<>]/i.test(tr.note))) return err(res, 400, 'text_rejected', { field: 'showcase.trusted.note' });
        }
      }
      if ('showcase_layout' in body) {
        if (!LAYOUTS.includes(body.showcase_layout)) return err(res, 400, 'invalid_field', { field: 'showcase_layout' });
        u.showcase_layout = body.showcase_layout;
      }
      if ('privacy' in body) {
        const bad2 = unknown(body.privacy, f.noThanks ? ['profile', 'presence', 'show_location', 'show_runs', 'friend_requests'] : ['profile', 'presence', 'show_location', 'show_runs', 'friend_requests', 'show_on_thanks']);
        if (bad2) return err(res, 400, 'unknown_field', { field: `privacy.${bad2}` });
        if ('show_on_thanks' in body.privacy && typeof body.privacy.show_on_thanks !== 'boolean') return err(res, 400, 'invalid_field', { field: 'privacy.show_on_thanks' });
        if (body.privacy.show_runs === false) {
          u.stats = null;
          const tr = (body.showcase || u.showcase)?.trusted; // §2.2: turning it off deletes the line's numbers too
          if (tr && typeof tr === 'object') for (const k of ['teams', 'top_level', 'fell']) delete tr[k];
        }
        u.privacy = { ...u.privacy, ...body.privacy };
      }
      for (const k of ['banner', 'frame', 'nameplate', 'title', 'accent', 'status', 'showcase']) if (k in body) u[k] = body[k];
      if ('display_name' in body) {
        u.display_name = body.display_name ?? u.discord.global_name;
        u.display_name_is_custom = body.display_name !== null;
      }
      return json(res, 200, me(u));
    }
    if (path === '/v1/me/handle' && req.method === 'PUT') {
      if (!/^[a-z0-9_]{3,20}$/.test(body.handle || '')) return err(res, 400, 'invalid_field', { field: 'handle' });
      if ([...f.users.values()].some((x) => x.handle === body.handle && x.id !== u.id) || body.handle === 'admin') return err(res, 409, 'handle_taken');
      u.handle = body.handle;
      return json(res, 200, me(u));
    }
    if (path === '/v1/me/friend-code' && req.method === 'POST') {
      u.friend_code = `SD-${randomBytes(2).toString('hex').toUpperCase().replace(/[ILOU]/g, '7')}-${randomBytes(2).toString('hex').toUpperCase().replace(/[ILOU]/g, '8')}`;
      return json(res, 200, { friend_code: u.friend_code });
    }
    if (path === '/v1/me/stats' && req.method === 'PUT') {
      if (!u.privacy.show_runs) return err(res, 403, 'opt_in_required');
      if (unknown(body, ['totals', 'recent_runs'])) return err(res, 400, 'unknown_field');
      const keys = ['runs_started', 'runs_completed', 'runs_failed', 'soullink_runs', 'nuzlocke_runs', 'badges_earned', 'pokemon_caught', 'deaths', 'playtime_minutes'];
      if (unknown(body.totals || {}, keys) || (body.recent_runs || []).length > 5) return err(res, 400, 'invalid_field', { field: 'totals' });
      for (const r of body.recent_runs || []) if (unknown(r, ['name', 'game', 'mode', 'result', 'badges', 'deaths', 'ended_at']) || !['soullink', 'nuzlocke', 'solo'].includes(r.mode) || !['active', 'won', 'lost', 'abandoned'].includes(r.result)) return err(res, 400, 'invalid_field', { field: 'recent_runs' });
      if (!f.keepStats.has(u.id)) u.stats = body; // (screenshots keep their example numbers)
      return json(res, 200, { stats: u.stats });
    }
    if (path === '/v1/me/stats' && req.method === 'DELETE') {
      u.stats = null;
      return json(res, 200, { ok: true });
    }
    // §1.7 sessions
    if (path === '/v1/me/sessions' && req.method === 'GET') {
      const items = [...f.sessions.entries()].filter(([, s]) => s.user === u.id && !s.revoked)
        .map(([id, s]) => ({ id, device_name: s.device || null, platform: s.platform || null, created_at: iso(s.created || Date.now()), last_used_at: iso(s.created || Date.now()), current: id === a.sid }));
      return json(res, 200, { items, next_cursor: null });
    }
    if ((m = /^\/v1\/me\/sessions\/([A-Za-z0-9_-]+)$/.exec(path)) && req.method === 'DELETE') {
      const s = f.sessions.get(m[1]);
      if (!s || s.user !== u.id || s.revoked) return err(res, 404, 'not_found');
      s.revoked = true;
      return json(res, 200, { ok: true });
    }
    if (path === '/v1/me/export' && req.method === 'GET') return json(res, 200, { account: me(u), friends: [...f.friends.keys()].filter((k) => k.includes(u.id)) }, { 'Content-Disposition': 'attachment; filename="souldew-account-export.json"' });
    if (path === '/v1/me' && req.method === 'DELETE') {
      if (body.confirm !== u.handle) return err(res, 400, 'invalid_field', { field: 'confirm' });
      f.users.delete(u.id);
      for (const s of f.sessions.values()) if (s.user === u.id) s.revoked = true;
      for (const k of [...f.friends.keys()]) if (k.includes(u.id)) f.friends.delete(k);
      return json(res, 200, { ok: true });
    }

    // ---- §3 users ----
    if ((m = /^\/v1\/users\/(u_[A-Za-z0-9_-]+)$/.exec(path)) && req.method === 'GET') {
      const o = f.users.get(m[1]);
      if (!o || blocked(u.id, o.id)) return err(res, 404, 'not_found');
      const vis = o.privacy.profile;
      if (o.id !== u.id && (vis === 'nobody' || (vis === 'friends' && !areFriends(u.id, o.id)))) return err(res, 404, 'not_found');
      return json(res, 200, profile(u.id, o));
    }

    // ---- §4 friends ----
    if (path === '/v1/friends' && req.method === 'GET') {
      const items = [...f.friends.entries()].filter(([k]) => k.split('|').includes(u.id)).map(([k, since]) => ({ user: card(f.users.get(k.split('|').find((x) => x !== u.id))), since })).filter((x) => x.user);
      return json(res, 200, { items, next_cursor: null });
    }
    if ((m = /^\/v1\/friends\/(u_[A-Za-z0-9_-]+)$/.exec(path)) && req.method === 'DELETE') {
      if (!areFriends(u.id, m[1])) return err(res, 404, 'not_found');
      f.friends.delete(pairKey(u.id, m[1]));
      return json(res, 200, { ok: true });
    }
    if (path === '/v1/friends/requests' && req.method === 'POST') {
      if (unknown(body, ['handle', 'friend_code']) || ('handle' in body) === ('friend_code' in body)) return err(res, 400, 'bad_request');
      const norm = (c) => String(c).toUpperCase().replace(/-/g, '');
      const o = body.handle ? [...f.users.values()].find((x) => x.handle === body.handle) : [...f.users.values()].find((x) => norm(x.friend_code) === norm(body.friend_code));
      if (!o) return err(res, 404, 'not_found');
      if (o.id === u.id) return err(res, 400, 'invalid_field', { field: 'handle' });
      if (areFriends(u.id, o.id)) return err(res, 409, 'already_friends');
      if (f.blocks.has(`${u.id}>${o.id}`)) return err(res, 403, 'forbidden');
      const back = [...f.requests.values()].find((r) => r.status === 'pending' && r.from === o.id && r.to === u.id);
      if (back) {
        back.status = 'accepted';
        f.befriend(u.id, o.id, Date.now());
        return json(res, 200, { status: 'accepted', friend: card(o) });
      }
      const r = { id: rid('fr'), from: u.id, to: o.id, status: 'pending', created: Date.now(), silent: blocked(u.id, o.id) || o.privacy.friend_requests === 'nobody' };
      f.requests.set(r.id, r);
      return json(res, 201, { status: 'sent', request: { id: r.id, from: card(u), to: card(o), created_at: iso(r.created), expires_at: iso(r.created + 30 * 86400000) } });
    }
    if (path === '/v1/friends/requests' && req.method === 'GET') {
      const box = q.box === 'outgoing' ? 'outgoing' : 'incoming';
      const items = [...f.requests.values()].filter((r) => r.status === 'pending' && (box === 'incoming' ? r.to === u.id && !r.silent && !r.ignored : r.from === u.id))
        .map((r) => ({ id: r.id, from: card(f.users.get(r.from)), to: card(f.users.get(r.to)), created_at: iso(r.created), expires_at: iso(r.created + 30 * 86400000) }));
      return json(res, 200, { items, next_cursor: null });
    }
    if ((m = /^\/v1\/friends\/requests\/(fr_[A-Za-z0-9_-]+)\/(accept|ignore)$/.exec(path)) && req.method === 'POST') {
      const r = f.requests.get(m[1]);
      if (!r || r.to !== u.id || r.status !== 'pending' || r.silent) return err(res, 404, 'not_found');
      if (m[2] === 'accept') {
        r.status = 'accepted';
        f.befriend(r.from, r.to, Date.now());
        return json(res, 200, { friend: card(f.users.get(r.from)) });
      }
      r.ignored = true;
      return json(res, 200, { ok: true });
    }
    if ((m = /^\/v1\/friends\/requests\/(fr_[A-Za-z0-9_-]+)$/.exec(path)) && req.method === 'DELETE') {
      const r = f.requests.get(m[1]);
      if (!r || r.from !== u.id) return err(res, 404, 'not_found');
      r.status = 'cancelled';
      return json(res, 200, { ok: true });
    }
    if (path === '/v1/blocks' && req.method === 'GET') return json(res, 200, { items: [...f.blocks].filter((b) => b.startsWith(`${u.id}>`)).map((b) => ({ user: card(f.users.get(b.split('>')[1])), created_at: iso(Date.now()) })), next_cursor: null });
    if (path === '/v1/blocks' && req.method === 'POST') {
      if (unknown(body, ['user_id']) || !f.users.has(body.user_id)) return err(res, 404, 'not_found');
      f.blocks.add(`${u.id}>${body.user_id}`);
      f.friends.delete(pairKey(u.id, body.user_id));
      return json(res, 200, { ok: true });
    }
    if ((m = /^\/v1\/blocks\/(u_[A-Za-z0-9_-]+)$/.exec(path)) && req.method === 'DELETE') {
      f.blocks.delete(`${u.id}>${m[1]}`);
      return json(res, 200, { ok: true });
    }

    // ---- §5 presence ----
    if (path === '/v1/presence' && req.method === 'PUT') {
      const bad = unknown(body, ['state', 'game', 'run', 'location']);
      if (bad) return err(res, 400, 'unknown_field', { field: bad });
      if (!['online', 'library', 'playing', 'in_run'].includes(body.state)) return err(res, 400, 'invalid_field', { field: 'state' });
      if (body.run && unknown(body.run, ['name', 'mode', 'free_slot', 'joinable'])) return err(res, 400, 'unknown_field', { field: 'run' });
      const p = { ...body, at: Date.now() };
      if (!u.privacy.show_location) delete p.location;
      if (!f.pinPresence.has(u.id)) f.presence.set(u.id, p); // (screenshots pin an example presence)
      return json(res, 200, { ok: true, every: 60, pending: pendingOf(u.id) });
    }
    if (path === '/v1/presence' && req.method === 'DELETE') {
      f.presence.delete(u.id);
      return json(res, 200, { ok: true });
    }
    if (path === '/v1/presence/friends' && req.method === 'GET') {
      const items = [];
      for (const [k] of f.friends) {
        if (!k.split('|').includes(u.id)) continue;
        const oid = k.split('|').find((x) => x !== u.id);
        const o = f.users.get(oid);
        if (!o || o.privacy.presence === 'nobody') continue;
        const p = f.presence.get(oid);
        if (!p || o.privacy.presence === 'offline' || Date.now() - p.at > 180000) items.push({ user_id: oid, state: 'offline' });
        else items.push({ user_id: oid, state: p.state, ...(p.game ? { game: p.game } : {}), ...(p.run ? { run: p.run } : {}), ...(p.location ? { location: p.location } : {}), updated_at: iso(p.at) });
      }
      return json(res, 200, { items });
    }
    if (path === '/v1/pending' && req.method === 'GET') return json(res, 200, { pending: pendingOf(u.id) });

    // ---- §6 play with friends ----
    if (path === '/v1/invites' && req.method === 'POST') {
      const bad = unknown(body, ['to', 'run', 'invite_code', 'pack_ref', 'ttl_minutes']);
      if (bad) return err(res, 400, 'unknown_field', { field: bad });
      if (!Array.isArray(body.to) || !body.to.length || body.to.length > 8) return err(res, 400, 'invalid_field', { field: 'to' });
      const notFriend = body.to.find((x) => !areFriends(u.id, x) || blocked(u.id, x));
      if (notFriend) return err(res, 403, 'not_friends', { field: notFriend });
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(body.invite_code || '')) return err(res, 400, 'invalid_field', { field: 'invite_code' });
      if (unknown(body.run || {}, ['name', 'game', 'mode', 'system'])) return err(res, 400, 'unknown_field', { field: 'run' });
      const inv = { id: rid('inv'), from: u.id, run: body.run, code: body.invite_code, pack_ref: body.pack_ref || null, status: 'active', created: Date.now(),
        expires: Date.now() + (body.ttl_minutes || 60) * 60000, recipients: body.to.map((x) => ({ user: x, status: 'pending' })) };
      f.invites.set(inv.id, inv);
      return json(res, 201, { invite: inviteView(inv, u.id) });
    }
    if (path === '/v1/invites' && req.method === 'GET') {
      const out = q.box === 'outgoing';
      const items = [...f.invites.values()].filter((i) => i.status === 'active' && i.expires > Date.now() && (out ? i.from === u.id : i.recipients.some((r) => r.user === u.id && r.status !== 'declined')))
        .map((i) => inviteView(i, u.id));
      return json(res, 200, { items, next_cursor: null });
    }
    if ((m = /^\/v1\/invites\/(inv_[A-Za-z0-9_-]+)\/(accept|decline)$/.exec(path)) && req.method === 'POST') {
      const i = f.invites.get(m[1]);
      const r = i?.recipients.find((x) => x.user === u.id);
      if (!i || i.status === 'cancelled' || !r) return err(res, 404, 'not_found');
      if (i.expires < Date.now()) return err(res, 409, 'conflict', { message: 'expired' });
      r.status = m[2] === 'accept' ? 'accepted' : 'declined';
      return m[2] === 'accept' ? json(res, 200, { invite: inviteView(i, u.id), invite_code: i.code, ...(i.pack_ref ? { pack_ref: i.pack_ref } : {}) }) : json(res, 200, { ok: true });
    }
    if ((m = /^\/v1\/invites\/(inv_[A-Za-z0-9_-]+)$/.exec(path)) && req.method === 'DELETE') {
      const i = f.invites.get(m[1]);
      if (!i || i.from !== u.id || i.status === 'cancelled') return err(res, 404, 'not_found');
      i.status = 'cancelled';
      return json(res, 200, { ok: true });
    }
    if (path === '/v1/join-requests' && req.method === 'POST') {
      if (unknown(body, ['to'])) return err(res, 400, 'unknown_field');
      const p = f.presence.get(body.to);
      if (!areFriends(u.id, body.to) || p?.state !== 'in_run' || !p.run?.free_slot || !p.run?.joinable) return err(res, 409, 'conflict');
      const j = { id: rid('jr'), from: u.id, to: body.to, status: 'pending', invite: null, created: Date.now() };
      f.joins.set(j.id, j);
      return json(res, 201, { join_request: joinView(j) });
    }
    if (path === '/v1/join-requests' && req.method === 'GET') {
      const out = q.box === 'outgoing';
      return json(res, 200, { items: [...f.joins.values()].filter((j) => (out ? j.from === u.id : j.to === u.id) && j.status === 'pending').map(joinView), next_cursor: null });
    }
    if ((m = /^\/v1\/join-requests\/(jr_[A-Za-z0-9_-]+)\/(accept|decline)$/.exec(path)) && req.method === 'POST') {
      const j = f.joins.get(m[1]);
      if (!j || j.to !== u.id || j.status !== 'pending') return err(res, 404, 'not_found');
      if (m[2] === 'decline') {
        j.status = 'declined';
        return json(res, 200, { ok: true });
      }
      if (unknown(body, ['invite_code', 'pack_ref', 'run'])) return err(res, 400, 'unknown_field');
      const inv = { id: rid('inv'), from: u.id, run: body.run, code: body.invite_code, pack_ref: null, status: 'active', created: Date.now(), expires: Date.now() + 3600000, recipients: [{ user: j.from, status: 'pending' }] };
      f.invites.set(inv.id, inv);
      j.status = 'accepted';
      j.invite = inv.id;
      return json(res, 200, { invite: inviteView(inv, u.id) });
    }
    if ((m = /^\/v1\/join-requests\/(jr_[A-Za-z0-9_-]+)$/.exec(path)) && req.method === 'DELETE') {
      const j = f.joins.get(m[1]);
      if (!j || j.from !== u.id) return err(res, 404, 'not_found');
      j.status = 'cancelled';
      return json(res, 200, { ok: true });
    }

    // ---- §7 reports ----
    if (path === '/v1/reports' && req.method === 'POST') {
      if (unknown(body, ['user_id', 'target', 'reason', 'note'])) return err(res, 400, 'unknown_field');
      if (body.user_id === u.id) return err(res, 400, 'invalid_field', { field: 'user_id' });
      if (!f.users.has(body.user_id)) return err(res, 404, 'not_found');
      f.reports.push({ ...body, by: u.id });
      return json(res, 201, { ok: true, id: rid('rep') });
    }

    // ---- §8 souldew+ ----
    if (path === '/v1/entitlements' && req.method === 'GET') {
      const e = u.entitlement;
      const now = f.entNow ?? Math.floor(Date.now() / 1000);
      const until = e.until ? Math.floor(Date.parse(e.until) / 1000) : null;
      const token = f.ent.sign({
        iss: base, aud: 'souldew-entitlement', sub: u.id, sid: a.sid, tier: e.tier, badges: e.badges, until,
        grace_until: e.tier === 'none' ? now : Math.min(until ?? Number.MAX_SAFE_INTEGER, now + 7 * 86400), pack_key_id: String(u.keyEpoch || 1), iat: now, exp: now + 3600,
        ...(f.entClaims || {}),
      });
      // §8.6 the trial: u.trialUntil (ms) once started; u.trialOffer: 'available' (default) | 'unavailable:<reason>'
      const trialRunning = u.trialUntil && u.trialUntil > Date.now();
      const trial = u.trialUntil ? { state: trialRunning ? 'running' : 'used', days: 7, until: iso(u.trialUntil) }
        : (u.trialOffer || 'available').startsWith('unavailable') ? { state: 'unavailable', days: 7, until: null, reason: u.trialOffer.split(':')[1] } : { state: 'available', days: 7, until: null };
      const sources = [...(e.tier === 'none' || e.fromTrial ? [] : [{ kind: 'bmc', tier: e.tier, status: 'active', until: e.until }]),
        ...(trialRunning ? [{ kind: 'trial', tier: 'plus', until: iso(u.trialUntil) }] : [])];
      return json(res, 200, { tier: e.tier, until: e.until, badges: e.badges, sources, token, trial,
        pack_key: plusOk(u) ? packKey(u) : null, pack_key_id: String(u.keyEpoch || 1), offline_grace_days: 7,
        preview: u.preview && u.preview.expires > Date.now() ? { id: u.preview.id, pack_id: 'skins-preview', expires_at: iso(u.preview.expires) } : null });
    }
    if (path === '/v1/entitlements/link-email' && req.method === 'POST') {
      const tier = f.memberships.get(String(body.email || '').toLowerCase());
      if (tier) u.entitlement = { tier, until: iso(Date.now() + 30 * 86400000), badges: { plus: ['plus'], patron: ['plus', 'patron'] }[tier] || ['supporter'] };
      return json(res, 200, { submitted: true }); // the same answer either way (no supporter oracle)
    }
    if (path === '/v1/entitlements/trial' && req.method === 'POST') {
      if (u.trialUntil) return err(res, 409, 'trial_used', { until: iso(u.trialUntil) });
      if ((u.trialOffer || '').startsWith('unavailable')) return err(res, 403, 'trial_unavailable', { reason: u.trialOffer.split(':')[1] });
      u.trialUntil = Date.now() + 7 * 86400000;
      if (u.entitlement.tier === 'none' || u.entitlement.tier === 'supporter') u.entitlement = { tier: 'plus', until: iso(u.trialUntil), badges: ['plus'], fromTrial: true };
      return json(res, 201, { trial: { state: 'running', days: 7, until: iso(u.trialUntil) }, tier: 'plus', until: iso(u.trialUntil) });
    }
    // ---- §14 "Find a SoulLink partner" ----
    if (path === '/v1/lfg' && req.method === 'POST') {
      if (unknown(body, ['game', 'partners', 'rules', 'lang', 'schedule'])) return err(res, 400, 'unknown_field');
      f.lfgPosts.push({ by: u.id, ...body });
      const a = f.lfgAnswer;
      if (a) return a.status >= 400 ? err(res, a.status, a.code, a.extra || {}) : json(res, a.status, a.body);
      return json(res, 201, { url: 'https://discord.com/channels/1570873327566852146/1570873327566852150/1573924615737049202' });
    }
    if (path === '/v1/entitlements/link' && req.method === 'DELETE') {
      u.entitlement = { tier: 'none', until: null, badges: [] };
      u.keyEpoch = (u.keyEpoch || 1) + 1; // §8.5: unlinking rotates the pack key
      return json(res, 200, { ok: true });
    }
    if (path === '/v1/packs' && req.method === 'GET') {
      return json(res, 200, { items: [{ id: 'skins-autumn', version: '1.0.0', kind: 'skins', title: 'Autumn skins', required_tier: 'plus', entitled: plusOk(u), previewable: false },
        { id: 'skins-preview', version: '1.0.0', kind: 'preview', title: 'Skin preview', required_tier: 'plus', entitled: plusOk(u), previewable: true }] });
    }
    // §10.4 live preview (shape only – the files behind the URLs are not served by this fake)
    if (path === '/v1/packs/skins-preview/preview' && req.method === 'POST') {
      f.previewCount.set(u.id, (f.previewCount.get(u.id) || 0) + 1);
      if (f.previewCount.get(u.id) > 10) return err(res, 429, 'rate_limited', { retry_after: 3600 });
      const id = `pv_${randomBytes(16).toString('base64url').slice(0, 22)}`;
      u.preview = { id, expires: Date.now() + 15 * 60000 };
      const q = (p) => `${base}/v1/packs/skins-preview/1.0.0/file?path=${encodeURIComponent(p)}&u=${u.id}&k=${id}&exp=1&sig=x`;
      return json(res, 201, { preview_id: id, pack_id: 'skins-preview', version: '1.0.0', manifest: Buffer.from('{}').toString('base64url'), signature: randomBytes(64).toString('base64url'),
        watermark_id: 'wm_fake', key_id: id, preview_key: randomBytes(32).toString('base64url'), expires_at: iso(u.preview.expires), offline_grace: false,
        files: [{ path: 'skins/ember.css', url: q('skins/ember.css') }, { path: 'https://evil.example/x', url: 'https://evil.example/x' }] });
    }
    return err(res, 404, 'not_found');
  }
  function joinView(j) {
    return { id: j.id, from: card(f.users.get(j.from)), to: card(f.users.get(j.to)), status: j.status, invite_id: j.invite, created_at: iso(j.created), expires_at: iso(j.created + 900000) };
  }

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  f.base = base;
  f.server = server;
  f.close = () => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });
  /** The sign-in "browser": follow the start URL to the app's loopback, as a real browser navigation would. */
  f.browse = async (startUrl, { headers = {} } = {}) => {
    const r1 = await fetch(startUrl, { redirect: 'manual' });
    const loc = r1.headers.get('location');
    if (!loc) return { status: r1.status };
    const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site', ...headers };
    const r2 = await rawGet(loc, nav);
    const done = r2.headers.location;
    const r3 = done ? await rawGet(new URL(done, loc).href, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' }) : null;
    // done: the outcome without the loopback's one-time nonce (/auth/done?r=ok); doneUrl: the full address
    return { loopback: loc, status: r2.status, done: done?.replace(/&n=[A-Za-z0-9_-]+$/, ''), doneUrl: done, page: r3?.body ?? null, pageStatus: r3?.status, headers: r3?.headers };
  };
  return f;
}
