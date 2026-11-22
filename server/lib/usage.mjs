// The anonymous daily usage ping (docs/PRIVACY.md › "Daily usage count"): how many people use souldew, which versions
// and systems, and whether they come back – for the team's stats page – without any id for the install.
//
// Once a day (the first time the app runs that day, then nothing more that day) and only while Settings › Online ›
// "Count me in" is on (config.presence !== false – the same switch as the playing-now heartbeat), the local server
// sends the bot one small JSON:
//   POST <the bot>/usage { day_id, v, os, arch, first_week, active7, active28, new }
//   day_id      16 random bytes, made for this day only, kept in memory only (a retry the same day isn't counted twice)
//   v           the app version · os mac | win | linux · arch x64 | arm64
//   first_week  the ISO week souldew was first used on this computer ("2026-W47")
//   active7     on how many of the last 7 days souldew was used here (today included), 1–7; active28 the same for 28
//   new         true on the day of the first use
// What it needs to know for that stays on this computer, in usage.json next to config.json: the first-use date and the
// dates (no times) souldew was used in the last 28 days. Nothing is recorded while the switch is off. Offline, or when
// the bot can't be reached: nothing happens (the next hour tries again; no queue, no log line).
// Only a packaged app sends (a development or test server never reaches the real bot; SOULDEW_LIVE_URL points a test at
// a mock).
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { liveBases, souldewVersion } from './liveruns.mjs';
import { writeFileAtomic } from './fsutil.mjs';

export const CHECK_MS = 60 * 60_000; // looks once an hour whether today's ping is still due
const FIRST_MS = 45_000; // the first look, a little after start
const TIMEOUT_MS = 8000;
const KEEP_DAYS = 28;
const OSES = { darwin: 'mac', win32: 'win', linux: 'linux' };
const ARCHES = ['x64', 'arm64'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');
/** This computer's calendar date ("2026-11-22"). */
export const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayNumber = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86400000);

/** ISO 8601 week of a calendar date ("2026-W47"). */
export function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${pad(week)}`;
}

function readState(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (!s || typeof s !== 'object' || !DATE.test(s.firstUse || '')) return null;
    return { firstUse: s.firstUse, days: Array.isArray(s.days) ? s.days.filter((x) => DATE.test(x)) : [], sent: DATE.test(s.sent || '') ? s.sent : null, wasNew: s.wasNew === true };
  } catch {
    return null;
  }
}

/**
 * When souldew was first used here, for an install from before this ping existed: the day its config.json was made
 * (when that is a real date before today), else null (= a new install).
 */
export function firstUseOf(configPath, today) {
  try {
    const st = statSync(configPath);
    const born = st.birthtimeMs > 946684800000 ? localDay(new Date(st.birthtimeMs)) : null;
    if (born && born < today) return born;
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    return cfg?.onboarded ? today : null; // an older install whose file date is unknown: counted from today, not as new
  } catch {
    return null;
  }
}

/**
 * The body for today (and the state to keep), or null when nothing is due: the switch is off, today's ping went out,
 * or this computer's system/processor isn't one the bot counts.
 */
export function pingFor(state, { today, version, platform, arch, existing }) {
  const os = OSES[platform];
  if (!os || !ARCHES.includes(arch)) return null;
  const first = state?.firstUse || existing || today;
  const fresh = !state && !existing; // a new install: no record and no older config
  const wasNew = state ? state.wasNew && first === today : fresh;
  const days = [...new Set([...(state?.days || []), today])].filter((d) => dayNumber(today) - dayNumber(d) < KEEP_DAYS && d <= today).sort();
  const next = { firstUse: first <= today ? first : today, days, sent: state?.sent || null, wasNew };
  if (next.sent === today) return { state: next, body: null };
  const within = (n) => days.filter((d) => dayNumber(today) - dayNumber(d) < n).length;
  const body = {
    v: version, os, arch, first_week: isoWeek(next.firstUse),
    active7: Math.max(1, Math.min(7, within(7))), active28: Math.max(1, Math.min(28, within(28))),
    new: wasNew,
  };
  if (body.active28 < body.active7) body.active28 = body.active7;
  return { state: next, body };
}

/** One per local server. `allowed`: a packaged app (or a test pointing SOULDEW_LIVE_URL at a mock). */
export function createUsage({ enabled = () => true, allowed = false, file, configPath, fetchImpl = fetch, env = process.env, version = souldewVersion, now = () => new Date(), platform = process.platform, arch = process.arch, timers = globalThis } = {}) {
  let dayId = null; // { day, id } – memory only
  let timer = null;

  const save = (s) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(s));
    } catch {
      // can't write (read-only, full disk): the ping simply may go again tomorrow with less history
    }
  };

  /** Today's ping, if it's due → { sent, reason }. */
  async function tick() {
    if (!allowed) return { sent: false, reason: 'not-packaged' };
    if (!enabled()) return { sent: false, reason: 'off' };
    const today = localDay(now());
    const prev = readState(file);
    const plan = pingFor(prev, { today, version: version(), platform, arch, existing: prev ? null : firstUseOf(configPath, today) });
    if (!plan) return { sent: false, reason: 'platform' };
    if (!plan.body) {
      if (JSON.stringify(plan.state) !== JSON.stringify(prev)) save(plan.state);
      return { sent: false, reason: 'done' };
    }
    save(plan.state); // today counts as used, whether or not the bot answers
    if (dayId?.day !== today) dayId = { day: today, id: randomBytes(16).toString('base64url') };
    const body = JSON.stringify({ day_id: dayId.id, ...plan.body });
    for (const base of liveBases(env)) {
      try {
        const r = await fetchImpl(`${base}/usage`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'Content-Type': 'application/json' }, body,
        });
        if (r.status >= 500) continue;
        // the bot answered (a 4xx too – the same ping won't do better later): today is done
        save({ ...plan.state, sent: today });
        return { sent: r.ok, reason: r.ok ? 'sent' : `status ${r.status}` };
      } catch {
        // no answer from this address – the next one; offline: silently nothing, the next hour tries again
      }
    }
    return { sent: false, reason: 'offline' };
  }

  return {
    tick,
    start() {
      if (!allowed || timer) return;
      const first = timers.setTimeout(() => { tick().catch(() => {}); }, FIRST_MS);
      first?.unref?.();
      timer = timers.setInterval(() => { tick().catch(() => {}); }, CHECK_MS);
      timer?.unref?.();
    },
    stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
  };
}
