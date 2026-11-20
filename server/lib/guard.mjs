// Request gate for the local API. The server only listens on 127.0.0.1, but every website the user opens can
// still send requests to it (fetch no-cors, <img>, <form>). These checks make sure only the app's own pages
// – the main window, the EmulatorJS iframe and the OBS overlay, all served from this origin – reach the API.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The app's own origins for a given port: http://localhost:<port>, http://127.0.0.1:<port>, http://[::1]:<port>. */
export const appOrigins = (port) => LOCAL_HOSTS.map((h) => `http://${h}:${port}`);

/** Host header must name this computer (blocks DNS rebinding). */
export function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d*$/, '');
  return LOCAL_HOSTS.includes(host);
}

/**
 * Returns null when the request may reach the API, otherwise a short reason (→ 403).
 * - An `Origin` header, when present, must be one of the app's own origins ("null" is rejected too).
 * - `Sec-Fetch-Site` (sent by every current browser and Electron) must be same-origin or none (typed URL /
 *   bookmark / OBS). cross-site and same-site (another port on localhost) are rejected for every API request,
 *   which also covers GET routes with side effects (patching, downloads) that an <img> could trigger.
 * - State-changing methods additionally need the `x-soullink: 1` header (a custom header forces a CORS
 *   preflight, which this server never answers).
 */
export function apiRequestError(req, port) {
  const h = req.headers || {};
  const origin = h.origin;
  if (origin !== undefined && !appOrigins(port).includes(String(origin).toLowerCase())) return 'Cross-origin request';
  const site = h['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'Cross-site request';
  const safe = req.method === 'GET' || req.method === 'HEAD';
  if (!safe && h['x-soullink'] !== '1') return 'Missing app header';
  return null;
}

/**
 * GETs that hand out secrets or private paths: a run with its invite pack (room key and secret), a run's files (ROM,
 * save, spoiler log, the pack itself), library ROM / patch downloads, solo and state saves, the app event stream
 * (paths and live hints), the mGBA live-bridge Lua (embeds the bridge token), the randomizer data and spoiler log,
 * the run doc (device ids), the Discord webhook, the stream API token and the status (library and emulator folders).
 * The OBS overlays never ask for these.
 */
export const PRIVATE_GETS = [
  /^\/api\/runs\/[a-f0-9]{8}$/,
  /^\/api\/runs\/[a-f0-9]{8}\/(download|file|doc|discord|log\/p[1-8]|data\/p[1-8]|save\/p[1-8])$/,
  /^\/api\/library\/(rom|patched|download)$/,
  /^\/api\/saves\/(solo|solo\/download|states|state|state\/thumb)$/,
  /^\/api\/(stream|status|events)$/,
  /^\/live\/soullink\.lua$/,
  // the souldew account: profile, friends, invites, entitlements (and the avatars, which an <img> loads same-origin)
  /^\/api\/account(\/.*)?$/,
  // souldew+: the account's encrypted pack and the dev pack's key
  /^\/api\/plus\/(pack\/meta|pack\/file|dev\/access|dev\/key)$/,
];

/**
 * The stricter half of the gate for PRIVATE_GETS (after apiRequestError): the request must come from one of the app's
 * own pages – a fetch with the `x-soullink: 1` header (web/lib/api.mjs sends it on every call) or a same-origin request
 * (the app's download links, the emulator page loading the run's ROM). A typed URL or bookmark (Sec-Fetch-Site: none)
 * and a client that sends neither header (another program, an old browser) get nothing. Returns null or a reason.
 */
export function privateRequestError(req, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null; // other methods already need the app header
  if (!PRIVATE_GETS.some((r) => r.test(path))) return null;
  const h = req.headers || {};
  if (h['x-soullink'] === '1' || h['sec-fetch-site'] === 'same-origin') return null;
  return 'App request required';
}

/** The renderer secret's cookie (set by electron/main.mjs into the app window's own cookie jar – never served by HTTP). */
export const RENDERER_COOKIE = 'sls_rt';
/** Routes that act as the signed-in souldew account or touch its souldew+ pack: only the app window may call them. */
const RENDERER_ONLY = /^\/api\/(account|plus)(\/|$)/;

/**
 * The desktop app's third gate: the static `x-soullink` header keeps websites out, but any other program on this
 * computer (another user's on a shared machine) can send it too. The account and souldew+ routes therefore also need a
 * per-launch random secret that only the app window has: electron/main.mjs makes it, sets it as an HttpOnly,
 * SameSite=Strict cookie in the window's session and hands it to the server – nothing ever serves it, so a program that
 * only talks HTTP to 127.0.0.1 can't learn it. Without a secret (the browser build `npm start`, tests) this gate is off.
 * Returns null or a reason (→ 403).
 */
export function rendererSecretError(req, path, secret) {
  if (!secret || !RENDERER_ONLY.test(path)) return null;
  const got = cookieValue(req.headers?.cookie, RENDERER_COOKIE);
  if (!got || got.length !== secret.length) return 'App window required';
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0 ? null : 'App window required';
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
