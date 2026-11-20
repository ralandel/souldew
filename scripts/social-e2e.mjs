// Screens of the souldew account in the real app (Electron, muted): two souldew servers with scratch data folders
// (Robin hosts, Kim joins), both signed in to a fake accounts service (test/fixtures/fakeaccounts.mjs – never the real
// one) that is filled with friends, presence, requests and stats. Walks through Settings › Account (signed out / in),
// the own and a friend's profile, the profile editor, Friends, inviting a friend from the new-run wizard and the
// board, the friend's invite notification, joining and the host's "Allow". Screenshots go to --out.
//
//   node scripts/social-e2e.mjs --out <dir> [--show] [--lang de] [--players 3|4]
//
// --players 3|4: a run with 3 or 4 seats – Lou (and Ida) sign in on servers of their own too. Their apps' Friends page
// and the real presence they report are checked, then Robin invites them from the board's picker (which offers only
// the seats still free), both ask at the same time and Robin allows them together: every friend gets the run and a seat
// of their own. Checks go to <out>/results.json.
//
// The join step uses the app's real invite-code relay (public MQTT brokers), so it needs internet.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);

if (!process.versions.electron) {
  const electron = (await import('electron')).default;
  const p = spawn(electron, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  p.on('exit', (c) => process.exit(c ?? 1));
} else {
  const { app } = await import('electron');
  app.commandLine.appendSwitch('mute-audio');
  const scratch = mkdtempSync(join(tmpdir(), 'souldew-social-e2e-'));
  app.setPath('userData', join(scratch, 'electron'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => main(scratch)).catch((e) => { console.error(e); app.exit(1); });
}

/** A port nobody uses right now (never the installed app's 47390). */
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

/** A header-only Emerald cartridge (recognised by its serial – enough for the wizard; nothing is played). */
function fakeEmerald() {
  const rom = Buffer.alloc(0x10000);
  rom.write('POKEMON EMER', 0xa0, 'ascii');
  rom.write('BPEE', 0xac, 'ascii');
  rom[0xb2] = 0x96;
  return rom;
}

async function main(scratch) {
  const { app, BrowserWindow } = await import('electron');
  const { startFakeAccounts } = await import('../test/fixtures/fakeaccounts.mjs');
  const out = resolve(opt('out', join(scratch, 'shots')));
  mkdirSync(out, { recursive: true });
  const lang = opt('lang', 'en');
  const N = Math.max(2, Math.min(4, Number(opt('players', 2)) || 2));
  const results = [];
  const check = (what, ok, detail = '') => {
    results.push({ what, ok: !!ok, detail: String(detail).slice(0, 300) });
    console.log(ok ? 'PASS' : 'FAIL', what, detail ? String(detail).slice(0, 200) : '');
    return !!ok;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const fake = await startFakeAccounts();
  const H = 3600000;
  const D = 24 * H;

  // ---- the people ----
  const plus = { tier: 'plus', until: new Date(Date.now() + 30 * D).toISOString(), badges: ['plus'] };
  const robin = fake.addUser({ handle: 'robin_dew', display_name: 'Robin', entitlement: plus, title: 'win-nuzlocke', accent: 'amber', status: 'grinding Victory Road', banner: 'night-train', nameplate: 'night-train',
    showcase: { trophies: ['win-nuzlocke', 'win-soul-link', 'badges16'], trusted: 'Breloom line – on 6 teams, fell once (Crystal, to Whitney)', favorite_game: 'Emerald' },
    privacy: { show_runs: true, profile: 'friends' }, createdAt: Date.parse('2025-03-12'),
    stats: { totals: { runs_started: 23, runs_completed: 7, runs_failed: 14, soullink_runs: 13, nuzlocke_runs: 10, badges_earned: 61, pokemon_caught: 412, deaths: 168, playtime_minutes: 12840 },
      recent_runs: [
        { name: 'Robin – Nuzlocke #4', game: 'Emerald', mode: 'nuzlocke', result: 'active', badges: 3, deaths: 2 },
        { name: 'Robin & Kim', game: 'HeartGold', mode: 'soullink', result: 'won', badges: 16, deaths: 14, ended_at: '2026-10-21T20:00:00Z' },
        { name: 'Unova Squad', game: 'Black', mode: 'soullink', result: 'lost', badges: 3, deaths: 22, ended_at: '2026-09-14T20:00:00Z' },
        { name: 'Kanto, no resets', game: 'FireRed', mode: 'nuzlocke', result: 'won', badges: 8, deaths: 9, ended_at: '2026-08-03T20:00:00Z' },
        { name: 'Crystal Hardcore', game: 'Crystal', mode: 'nuzlocke', result: 'lost', badges: 2, deaths: 7, ended_at: '2026-07-11T20:00:00Z' },
      ] } });
  const kim = fake.addUser({ handle: 'kimchi_k', display_name: 'Kim', title: 'win-soul-link', accent: 'dusk', banner: 'dusk-ridge', status: 'Johto again, why not', createdAt: Date.parse('2025-05-02'),
    showcase: { trophies: ['win-soul-link', 'first-catch'], trusted: 'Gyarados – the Magikarp that made it, every time', favorite_game: 'HeartGold' }, privacy: { show_runs: true },
    stats: { totals: { runs_started: 31, runs_completed: 9, runs_failed: 20, soullink_runs: 25, nuzlocke_runs: 6, badges_earned: 88, pokemon_caught: 540, deaths: 251, playtime_minutes: 18120 },
      recent_runs: [
        { name: 'Kim & Lou', game: 'HeartGold', mode: 'soullink', result: 'active', badges: 4, deaths: 3 },
        { name: 'Robin & Kim', game: 'HeartGold', mode: 'soullink', result: 'won', badges: 16, deaths: 14, ended_at: '2026-10-21T20:00:00Z' },
        { name: 'Johto Trio', game: 'SoulSilver', mode: 'soullink', result: 'won', badges: 16, deaths: 18, ended_at: '2026-05-30T20:00:00Z' },
      ] } });
  const others = [['lou_lou', 'Lou', 'moss'], ['ida_plays', 'Ida', 'tide'], ['sam_s', 'Sam', 'ember'], ['mo_mo', 'Mo', 'moss'], ['tim_t', 'Tim', 'dusk'], ['lena_l', 'Lena', 'amber']]
    .map(([handle, name, accent]) => fake.addUser({ handle, display_name: name, accent, avatar: handle !== 'tim_t' }));
  const [lou, ida, sam, mo, tim, lena] = others;
  for (const u of [kim, ...others]) fake.befriend(robin.id, u.id, Date.now() - (60 + others.indexOf(u) * 20) * D);
  fake.befriend(kim.id, lou.id);
  const noor = fake.addUser({ handle: 'noor_exe', display_name: 'Noor', accent: 'tide' });
  const finn = fake.addUser({ handle: 'finn_r', display_name: 'Finn', accent: 'ember' });
  for (const [u, n] of [[noor, 0], [finn, 1]]) fake.requests.set(`fr_seed${n}AAAAAAAAAAAAAAAAA`, { id: `fr_seed${n}AAAAAAAAAAAAAAAAA`, from: u.id, to: robin.id, status: 'pending', created: Date.now() - n * H });
  fake.keepStats.add(robin.id);
  fake.keepStats.add(kim.id);
  let kimPresence = null;
  const real = new Set(); // players whose own app reports their presence (--players 3|4) – the fake leaves them alone
  const keepPresence = () => {
    const now = Date.now();
    if (kimPresence) fake.presence.set(kim.id, { ...kimPresence, at: now });
    if (!real.has(lou.id)) fake.presence.set(lou.id, { state: 'in_run', game: { title: 'HeartGold', system: 'nds' }, run: { name: 'Kim & Lou', mode: 'soullink', free_slot: true, joinable: false }, at: now });
    if (!real.has(ida.id)) fake.presence.set(ida.id, { state: 'playing', game: { title: 'Platinum', system: 'nds' }, at: now });
    fake.presence.set(sam.id, { state: 'library', at: now });
    for (const u of [mo, tim, lena]) fake.presence.delete(u.id);
  };
  keepPresence();
  const presenceTimer = setInterval(keepPresence, 1500);

  // ---- two apps ----
  const servers = [];
  const seats = [['host', 'Robin'], ['guest', 'Kim'], ['p3', 'Lou'], ['p4', 'Ida']].slice(0, N);
  for (const s of seats) s.push(await freePort());
  const profiles = seats.map(([id, name, port]) => {
    const dir = join(scratch, id);
    const lib = join(dir, 'roms');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'Pokemon Emerald.gba'), fakeEmerald());
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang, playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nagOff: true }));
    const p = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1', SLS_ACCOUNTS_URL: fake.base, SLS_ACCOUNTS_DEV_ENT_KEY: fake.ent.publicKey }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => process.stderr.write(`[${id}] ${d}`));
    servers.push(p);
    return { id, name, port, dir, base: `http://127.0.0.1:${port}` };
  });
  const [HOST, GUEST] = profiles;
  const EXTRA = profiles.slice(2).map((pr, k) => ({ ...pr, user: [lou, ida][k], slot: `p${k + 3}` }));
  const RUN = 'e3a1d07b';
  // a room of its own on every run: the public relay would otherwise join two e2e runs at the same time into one room
  mkdirSync(join(HOST.dir, 'runs', RUN), { recursive: true });
  // seats 3 and 4 carry no player's name: the seat a friend gets comes from what is taken, not from a matching name
  const runPlayers = Object.fromEntries(['Robin', 'Kim', 'Player 3', 'Player 4'].slice(0, N).map((name, k) => [`p${k + 1}`, { name }]));
  writeFileSync(join(HOST.dir, 'runs', RUN, 'run.json'), JSON.stringify({
    id: RUN, name: 'Emerald with Kim', mode: 'soullink', room: `room-e3a1d07b-${randomBytes(4).toString('hex')}`, secret: `e2e-${randomBytes(12).toString('hex')}`, createdAt: new Date().toISOString(),
    players: runPlayers, game: { id: 'pokemon-emerald', system: 'gba', code: 'BPEE', title: 'POKEMON EMER' },
    randomizer: { enabled: false, values: {}, seeds: { p1: '1', p2: '2' } }, outputs: {}, rules: {},
  }));
  // never throws and always ends the process: the windows and the servers go first (on Windows a file they still hold
  // makes removing the scratch folder fail with EPERM), the folder is removed with retries, then the app exits
  let finishing = false;
  const finish = async (code) => {
    if (finishing) return;
    finishing = true;
    setTimeout(() => app.exit(code), 30000).unref?.(); // whatever hangs below, the run ends
    const quietly = async (what, fn) => {
      try {
        await fn();
      } catch (e) {
        console.error(`finish: ${what}:`, e?.message || e);
      }
    };
    clearInterval(presenceTimer);
    await quietly('results', () => writeFileSync(join(out, 'results.json'), JSON.stringify({ ok: code === 0 && results.every((r) => r.ok), players: N, results }, null, 2)));
    await quietly('windows', async () => {
      const { BrowserWindow } = await import('electron');
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    });
    await quietly('servers', () => Promise.all(servers.map((p) => new Promise((res) => {
      if (p.exitCode !== null || p.signalCode !== null) return res();
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} res(); }, 5000);
      p.once('exit', () => { clearTimeout(t); res(); });
      p.kill();
    }))));
    await quietly('fake accounts', () => Promise.race([fake.close(), sleep(3000)]));
    if (!args.includes('--keep')) {
      await quietly('scratch folder', async () => {
        for (let i = 0; ; i++) {
          try {
            rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            return;
          } catch (e) {
            if (i >= 10) throw e;
            await sleep(500);
          }
        }
      });
    }
    app.exit(code);
  };
  const api = async (pr, path, body, method) => {
    const r = await fetch(pr.base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw new Error(`${pr.id} ${path}: ${r.status} ${t.slice(0, 300)}`);
    try { return JSON.parse(t); } catch { return t; }
  };
  const signIn = async (pr, user) => {
    const { url } = await api(pr, '/api/account/login', {});
    fake.nextLogin = user.id;
    const b = await fake.browse(url);
    if (b.done !== '/auth/done?r=ok') throw new Error(`${pr.id}: sign-in ${b.done}`);
    pr.okPage = b.doneUrl; // the outcome page shows once, with the loopback's nonce
    return b;
  };
  try {
    for (const pr of profiles) for (let i = 0; i < 100; i++) { try { await api(pr, '/api/status'); break; } catch { await sleep(200); } }
    const show = args.includes('--show');
    const W = 1440;
    const Hh = 900;
    const wins = profiles.map((pr, i) => {
      const w = new BrowserWindow({ width: W, height: Hh, x: 20 + i * 60, y: 20 + i * 40, show, webPreferences: { partition: `social-e2e-${pr.id}`, backgroundThrottling: false } });
      w.webContents.setAudioMuted(true);
      w.loadURL(`${pr.base}/#/library`);
      // the achievement plates ("Press Start" …) are not what this run checks: kept out of the shots and the checks
      w.webContents.on('did-finish-load', () => w.webContents.insertCSS('.trophy-toasts { display: none !important; }').catch(() => {}));
      return w;
    });
    const ev = (i, js) => wins[i].webContents.executeJavaScript(js, true);
    const until = async (what, fn, ms = 30000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
        await sleep(250);
      }
    };
    const go = async (i, hash, ready) => {
      await ev(i, `location.hash = ${JSON.stringify(hash)}; true`);
      if (ready) await until(`${hash} ${ready}`, () => ev(i, `!!document.querySelector(${JSON.stringify(ready)})`));
      await sleep(900);
    };
    const shot = async (i, name, { toasts = false } = {}) => {
      if (!toasts) await ev(i, `document.querySelectorAll('.toast').forEach((t) => t.click()); true`);
      await sleep(400);
      const img = await wins[i].webContents.capturePage();
      writeFileSync(join(out, `${name}.png`), img.toPNG());
      log('shot', name);
    };
    const click = (i, sel, text) => ev(i, `(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : 'els[0]'}; if (!el) return false; el.click(); return true; })()`);
    for (const [i] of profiles.entries()) await until(`page ${i}`, () => ev(i, '!!document.querySelector(".nav")'), 60000);

    // 1 · Settings › Account, signed out
    await go(0, '#/settings?s=account', '.acct-intro');
    await shot(0, '01-account-signed-out');
    // 2 · signed in (the system browser's round trip done by the fake), its loopback page too
    const hand = await signIn(HOST, robin);
    writeFileSync(join(out, '02b-browser-signed-in.html'), hand.page || '');
    await until('signed in', () => ev(0, '!!document.querySelector(".acct-who")'));
    await api(HOST, '/api/account/presence', { state: 'library' }, 'PUT');
    await sleep(1200);
    await shot(0, '02-account-signed-in');
    // the browser tab after signing in (rendered from the loopback page itself)
    const tab = new BrowserWindow({ width: 900, height: 560, show: false, webPreferences: { partition: 'social-e2e-browser' } });
    await tab.loadURL(`${HOST.base}${HOST.okPage}`);
    await sleep(600);
    writeFileSync(join(out, '02c-browser-tab.png'), (await tab.webContents.capturePage()).toPNG());
    tab.destroy();

    // 3 · own profile, 4 · the editor
    await go(0, '#/profile', '.pf-mast');
    await sleep(800);
    await shot(0, '03-profile-own');
    await click(0, '.pf-actions .btn');
    await until('editor', () => ev(0, '!!document.querySelector(".pe-drawer .pe-pcard")'));
    await sleep(800);
    await shot(0, '05-profile-editor');
    await click(0, '.pe-pcard[data-card="trophies"]');
    await sleep(600);
    await shot(0, '05b-profile-editor-showcase');
    await click(0, '.pe-bar .btn.ghost');

    // Kim signs in on the guest app; her presence: in a run with a free seat she opened for "Ask to join"
    await signIn(GUEST, kim);
    // (her app in the background would report "in the library" – the fake keeps her in her run for these shots)
    kimPresence = { state: 'in_run', game: { title: 'HeartGold', system: 'nds' }, run: { name: 'Kim & Lou', mode: 'soullink', free_slot: true, joinable: true }, location: 'Route 34' };
    fake.users.get(kim.id).privacy.show_location = true;
    fake.pinPresence.add(kim.id);
    keepPresence();
    await sleep(800);

    // 4 · a friend's profile
    await go(0, `#/profile?id=${kim.id}`, '.pf-mast');
    await sleep(1200);
    await shot(0, '04-profile-friend');

    // 6 · Friends
    await go(0, '#/friends', '.fr-list');
    await click(0, '.fr-pick', 'Kim');
    await sleep(1500);
    await shot(0, '06-friends');
    // the "Invite Kim to a run" dialog
    await click(0, '.fr-card-body .btn.go');
    await until('invite modal', () => ev(0, '!!document.querySelector(".inv-runs")'));
    await sleep(500);
    await shot(0, '07-friends-invite-dialog');
    await ev(0, `document.querySelector('.modal-x')?.click(); true`);

    // 8 · the new-run wizard with a friend for the second seat
    await go(0, `#/soullink?new=pokemon-emerald&friend=${kim.id}`, '.who-friend');
    await sleep(1500);
    await shot(0, '08-wizard-friend-seat');

    // 9 · the board's invite panel: "Invite friends" → Kim
    kimPresence = null;
    fake.pinPresence.delete(kim.id);
    await go(0, `#/soullink?run=${RUN}`, '.run-steps, .board, main');
    await sleep(1500);
    await until('Invite player', () => click(0, 'button', 'Invite player'));
    await until('invite panel', () => ev(0, '!!document.querySelector(".fr-runinv")'));
    await click(0, '.fr-runinv .btn.go');
    await until('picker', () => ev(0, '!!document.querySelector(".fr-picklist")'));
    await click(0, '.fr-pickrow', 'Kim');
    await sleep(300);
    await shot(0, '09-wizard-invite-pick');
    await click(0, '.modal-foot .btn.go');
    await until('invite out', () => ev(0, '!!document.querySelector(".fr-runinv .fr-inv")'), 30000);
    await sleep(1000);
    await shot(0, '10-wizard-invite-sent');

    // 11 · Kim's app: the toast and the Friends badge
    await go(1, '#/library', '.nav');
    await until('invite toast', () => ev(1, `[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('invites you'))`), 90000);
    await sleep(600);
    await shot(1, '11-invite-notification', { toasts: true });
    // 12 · Join: the existing join page with the invite's code
    await click(1, '.toast .toast-action', 'Join');
    await until('join page', () => ev(1, '!!document.querySelector(".note")'), 30000);
    await sleep(2500);
    await shot(1, '12-invite-join-waiting');
    // 13 · the host: "Kim wants to join" → Allow
    const asked = await until('host asked', () => ev(0, `[...document.querySelectorAll('.toast, .fr-inv.asking')].some((t) => t.textContent.includes('wants to join'))`), 90000).catch(() => false);
    check('Kim: the invite reached her app, Join opened the join page and the host was asked', !!asked);
    if (asked) {
      await sleep(500);
      await shot(0, '13-host-allow', { toasts: true });
      await click(0, '.fr-inv.asking .btn.go') || await click(0, '.toast .toast-action', 'Allow');
      const got = await until('pack on the guest', () => ev(1, `(() => { const n = document.querySelector('.note'); return n && n.textContent.includes('SoulLink with') ? n.textContent : null; })()`), 60000).catch(() => null);
      check(`Kim got the run after "Allow" (${N} seats)`, got && got.includes(`SoulLink with ${N} players`), got);
      const seat = await ev(1, `document.querySelector('.seg [aria-checked="true"]')?.textContent || null`).catch(() => null);
      check('Kim: her own seat is suggested', seat === 'Kim', seat);
      await sleep(1500);
      await shot(1, '14-invite-joined');
    } else log('the relay did not connect (offline?) – no Allow shot');

    // ---- 3 or 4 seats: Lou (and Ida) on apps of their own ----
    if (EXTRA.length) {
      for (const [k, pr] of EXTRA.entries()) {
        const i = k + 2;
        await signIn(pr, pr.user);
        real.add(pr.user.id);
        fake.presence.delete(pr.user.id);
        await until(`${pr.name} signed in`, async () => (await api(pr, '/api/account')).me?.name === pr.name);
        await go(i, '#/friends', '.fr-list');
        await until(`${pr.name}: friends`, () => ev(i, `[...document.querySelectorAll('.fr-pick')].some((b) => b.textContent.includes('Robin'))`));
        await click(i, '.fr-pick', 'Robin');
        await sleep(1200);
        check(`${pr.name}: Friends lists Robin (and her friends only)`, await ev(i, `(() => { const n = [...document.querySelectorAll('.fr-pick b')].map((b) => b.textContent); return n.includes('Robin') && !n.includes('Noor') ? n.join(', ') : false; })()`));
        await shot(i, `2${k}-${pr.id}-friends`);
      }
      // their own apps report their presence (no example pinned): Robin sees it on his Friends page
      for (const pr of EXTRA) {
        const seen = await until(`${pr.name}'s presence`, async () => {
          const f = (await api(HOST, '/api/account/friends')).friends.find((x) => x.user.id === pr.user.id);
          return f && f.presence?.state && f.presence.state !== 'offline' ? f.presence.state : null;
        }, 40000).catch(() => null);
        check(`Robin sees ${pr.name}'s presence reported by her own app`, !!seen, seen);
      }
      await go(0, '#/friends', '.fr-list');
      await sleep(1500);
      await shot(0, '24-host-friends-real-presence');

      // the board: "Invite friends" → the picker offers only the seats still free
      await go(0, `#/soullink?run=${RUN}`, '.run-steps, .board, main');
      await sleep(1200);
      await until('Invite player', () => click(0, 'button', 'Invite player'));
      await until('invite panel (2)', () => ev(0, '!!document.querySelector(".fr-runinv")'));
      await click(0, '.fr-runinv .btn.go');
      await until('picker (2)', () => ev(0, '!!document.querySelector(".fr-picklist")'));
      for (const name of ['Sam', 'Mo', 'Tim', 'Lou', 'Ida']) await click(0, '.fr-pickrow', name);
      await sleep(300);
      const picked = await ev(0, `[...document.querySelectorAll('.fr-pickrow.on b')].map((b) => b.textContent)`);
      check(`picker: at most the ${N - 2} free seat(s) can be picked`, picked.length === N - 2, picked.join(', '));
      await shot(0, '25-picker-free-seats');
      // pick exactly the extra players
      await ev(0, `[...document.querySelectorAll('.fr-pickrow.on input')].forEach((i) => i.click()); true`);
      for (const pr of EXTRA) await click(0, '.fr-pickrow', pr.name);
      await sleep(300);
      await click(0, '.modal-foot .btn.go');
      await until('invites out', () => ev(0, `document.querySelectorAll('.fr-runinv .fr-inv').length >= ${1 + EXTRA.length}`), 30000);
      await sleep(800);
      await shot(0, '26-invites-sent');
      // the run is full now: the panel says so instead of offering more invites
      check('a full run offers no more friend invites', await ev(0, `!!document.querySelector('.fr-runinv .btn.go')?.disabled`));
      for (const [k, pr] of EXTRA.entries()) {
        const i = k + 2;
        await go(i, '#/library', '.nav');
        const toast = await until(`${pr.name}: invite toast`, () => ev(i, `[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('invites you'))`), 90000).catch(() => false);
        check(`${pr.name}: the invite notification`, toast);
        await shot(i, `27-${pr.id}-invite-notification`, { toasts: true });
        await click(i, '.toast .toast-action', 'Join');
        await until(`${pr.name}: join page`, () => ev(i, '!!document.querySelector(".note")'), 30000).catch(() => null);
      }
      // both ask at the same time – Robin allows them together
      const asking = await until('all asking', () => ev(0, `document.querySelectorAll('.fr-runinv .fr-inv.asking').length >= ${EXTRA.length} ? document.querySelectorAll('.fr-runinv .fr-inv.asking').length : 0`), 90000).catch(() => 0);
      check(`the host is asked by all ${EXTRA.length} at once`, asking >= EXTRA.length, asking);
      await shot(0, '28-host-allow-all', { toasts: true });
      await ev(0, `[...document.querySelectorAll('.fr-runinv .fr-inv.asking .btn.go')].forEach((b) => b.click()); true`);
      const seatsGot = [];
      for (const [k, pr] of EXTRA.entries()) {
        const i = k + 2;
        const got = await until(`${pr.name}: run`, () => ev(i, `(() => { const n = document.querySelector('.note'); return n && n.textContent.includes('SoulLink with') ? n.textContent : null; })()`), 60000).catch(() => null);
        check(`${pr.name} got the run (${N} seats)`, got && got.includes(`SoulLink with ${N} players`), got);
        const seat = await ev(i, `document.querySelector('.seg [aria-checked="true"]')?.textContent || null`).catch(() => null);
        seatsGot.push(seat);
        await sleep(800);
        await shot(i, `29-${pr.id}-joined`);
      }
      check('every friend is offered a free seat of their own', seatsGot.every((s) => s && !['Robin', 'Kim'].includes(s)) && new Set(seatsGot).size === seatsGot.length, seatsGot.join(', '));
      await sleep(1500);
      await shot(0, '30-host-everyone-in');
    }
    // 15 · the editor without souldew+: a souldew+ banner can be tried on, quietly marked, not saved
    await go(1, '#/profile', '.pf-mast');
    await click(1, '.pf-actions .btn');
    await until('editor (guest)', () => ev(1, '!!document.querySelector(".pe-drawer .pe-pcard")'));
    await sleep(500);
    await click(1, '.pe-pcard[data-card="banner"]');
    await until('banner picker (guest)', () => ev(1, '!!document.querySelector(".pe-card.locked")'));
    await click(1, '.pe-card.locked');
    await sleep(800);
    await shot(1, '15-profile-editor-locked');
    await click(1, '.pe-bar .btn.ghost');
    log('done →', out);
    await finish(results.every((r) => r.ok) ? 0 : 1);
  } catch (e) {
    console.error(e);
    try {
      for (const [i, w] of BrowserWindow.getAllWindows().entries()) writeFileSync(join(out, `fail-${i}.png`), (await w.webContents.capturePage()).toPNG());
    } catch {}
    check(`run stopped: ${e?.message || e}`, false);
    await finish(1);
  }
}
