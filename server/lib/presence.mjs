// "Playing now": the anonymous heartbeat behind the souldew Discord's "🎮 Playing now: N" (docs/PRIVACY.md).
//
// Only while a game runs (the page reports it, web/lib/presence.mjs) and only when Settings › General › "Count me in"
// is on (config.presence !== false), the local server sends the bot one small JSON every minute:
//   POST <the bot>/presence  { sid, system, mode, v }   (the bot = LIVE_RUNS_URL, server/lib/liveruns.mjs)
//   sid    a random id made when the game starts – new for every game, never written to disk, tied to nothing
//   system gb | gba | nds | 3ds          mode solo | nuzlocke | soullink          v the app version
// and { sid, stop: true } when the game closes, the setting is switched off or the app quits. No name, no account,
// no game title, no run data, no ROM, no file path. When the bot can't be reached nothing happens (no retries, no
// error, no log line) – the next heartbeat simply tries again.
import { randomBytes } from 'node:crypto';
import { liveBases, souldewVersion } from './liveruns.mjs';

export const SYSTEMS = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', '3ds': '3ds' };
export const MODES = ['solo', 'nuzlocke', 'soullink'];
export const EVERY_MS = 60_000; // what the page uses; the bot may answer a longer `every`
const MIN_GAP_MS = 30_000; // the same heartbeat again sooner (a reload, two pages) is not sent
const QUIET_MS = 3 * 60_000; // no word from the page this long (crashed, closed): the game counts as closed
const TIMEOUT_MS = 8000;

/** The page's report → { system, mode } or null (not a game souldew counts). */
export function presenceOf(body) {
  const system = SYSTEMS[body?.system];
  const mode = MODES.includes(body?.mode) ? body.mode : null;
  return system && mode ? { system, mode } : null;
}

/**
 * One per local server. `enabled()` reads the setting at every call, so switching it off takes effect at once.
 * fetchImpl / env / now / timers are for the tests.
 */
export function createPresence({ enabled = () => true, fetchImpl = fetch, env = process.env, edition, version = souldewVersion, now = Date.now, timers = globalThis } = {}) {
  let sid = null; // the running game's id while the bot knows about it
  let lastKey = '';
  let lastSent = 0;
  let quiet = null;
  let every = EVERY_MS;

  const post = async (body) => {
    for (const base of liveBases(env, edition)) {
      try {
        const r = await fetchImpl(`${base}/presence`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!body.stop && r.ok) {
          const j = await r.json().catch(() => null);
          const e = Number(j?.every);
          if (Number.isFinite(e) && e >= 60 && e <= 900) every = e * 1000;
        }
        return true;
      } catch {
        // no answer from this address – the next one, if there is one; offline: silently nothing
      }
    }
    return false;
  };

  const clearQuiet = () => {
    if (quiet) timers.clearTimeout(quiet);
    quiet = null;
  };

  /** The game closed (or the setting went off, or the app quits): tell the bot once, forget the id. */
  async function stop() {
    clearQuiet();
    const id = sid;
    sid = null;
    lastKey = '';
    lastSent = 0;
    if (!id) return false;
    return post({ sid: id, stop: true });
  }

  /** The page says a game runs ({ system, mode }) – a heartbeat, unless the setting is off or one went out just now. */
  async function beat(report) {
    const p = presenceOf(report);
    if (!p || !enabled()) {
      await stop();
      return { sent: false, every };
    }
    clearQuiet();
    quiet = timers.setTimeout(() => { stop(); }, QUIET_MS);
    quiet.unref?.();
    const key = `${p.system}|${p.mode}`;
    // (the page reports every minute; when the bot asked for a slower beat, the reports in between are not sent)
    const gap = every > EVERY_MS ? every - 5000 : MIN_GAP_MS;
    if (sid && key === lastKey && now() - lastSent < gap) return { sent: false, every };
    if (!sid) sid = randomBytes(16).toString('base64url');
    lastKey = key;
    lastSent = now();
    const sent = await post({ sid, system: p.system, mode: p.mode, v: version() });
    return { sent, every };
  }

  return { beat, stop, get active() { return !!sid; } };
}

/** The local server's instance (server/app.mjs reads the setting from the config; electron/main.mjs stops it on quit). */
let shared = null;
export function presence(opts) {
  if (!shared || opts) shared = createPresence(opts);
  return shared;
}
/** On quit: the stop, but never longer than `ms` (the app must close). */
export async function stopPresence(ms = 1500) {
  if (!shared?.active) return;
  await Promise.race([shared.stop(), new Promise((r) => setTimeout(r, ms).unref?.())]);
}
