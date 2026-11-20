// ICE servers for the run's peer connections (docs/MULTIPLAYER.md › "Transport"): STUN plus short-lived Cloudflare TURN
// credentials from souldew's bot (GET /link/ice at liveruns.mjs' address – the Worker holds the TURN key, the app never does).
// With TURN, players behind strict NATs (mobile hotspots, some ISPs) still get a data channel – relayed. The direct path
// is always tried first; when the bot can't be reached the app keeps its default STUN servers.
import { liveBases } from './liveruns.mjs';

let cache = null; // { at, until, servers }

/** Only well-formed entries: { urls: [stun:/turn:/turns: …], username?, credential? }. */
export function cleanIceServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 8)) {
    const urls = (Array.isArray(s?.urls) ? s.urls : [s?.urls]).filter((u) => typeof u === 'string' && u.length < 200 && /^(stun|turns?):[\w.:?=&\-[\]]+$/i.test(u)).slice(0, 10);
    if (!urls.length) continue;
    const e = { urls };
    if (typeof s.username === 'string' && typeof s.credential === 'string' && s.username.length < 512 && s.credential.length < 512) {
      e.username = s.username;
      e.credential = s.credential;
    } else if (urls.some((u) => /^turns?:/i.test(u))) continue;
    out.push(e);
  }
  return out;
}

/**
 * { iceServers, turn, ttl, relayOnly? } – cached until 80 % of the credentials' lifetime is over (they are valid for `ttl` s). On
 * any trouble: { iceServers: [], turn: false } (the page then keeps Trystero's own STUN servers).
 */
export async function linkIceServers({ fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  if (env.SOULDEW_LINK_ICE === 'off') return { iceServers: [], turn: false, ttl: 0 };
  if (cache && now < cache.until) return cache.value;
  for (const base of liveBases(env)) {
    try {
      const r = await fetchImpl(`${base}/link/ice`, { redirect: 'error', signal: AbortSignal.timeout(6000) });
      if (!r.ok) break; // an answer (rate limit, error): not the other address
      const j = await r.json();
      const iceServers = cleanIceServers(j?.iceServers);
      const turn = !!j?.turn && iceServers.some((s) => s.username);
      const ttl = Number.isFinite(j?.ttl) && j.ttl > 0 ? Math.min(j.ttl, 24 * 3600) : 0;
      // (SOULDEW_LINK_ICE=relay: every peer connection through TURN, never direct – tests of the relayed path only)
      const value = { iceServers, turn, ttl, ...(turn && env.SOULDEW_LINK_ICE === 'relay' ? { relayOnly: true } : {}) };
      cache = { until: now + (turn ? ttl * 800 : 10 * 60_000), value };
      return value;
    } catch {
      // no answer from this address – the next one
    }
  }
  const value = { iceServers: [], turn: false, ttl: 0 };
  cache = { until: now + 2 * 60_000, value };
  return value;
}

/** Tests: forget the cached answer. */
export function resetLinkIce() {
  cache = null;
}
