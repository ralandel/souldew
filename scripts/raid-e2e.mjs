// End-to-end test of a raid in the real app (docs/MULTIPLAYER.md › "Raid"): two or three souldew servers with scratch
// data folders (players on this computer), one SoulLink run (created on A, joined on the others), every page in
// Electron (hidden, muted) playing its own game in the fast player (the souldew engine). Every game loads the same
// save state from right before a trainer battle (--state). A starts the raid from the board, the others join from the
// raid panel in their play view, the countdown runs, every player walks into the battle, and they take turns hitting
// the trainer's Pokémon: each hit comes off the shared pool and goes into the other games. Checked: the pool every
// page computes, the HP every game holds, the raid won in everybody's game, the result card and the log entry.
// Screenshots, frames and a muted clip per player go to --out.
//
//   node scripts/raid-e2e.mjs --rom <game> --state <pre-battle.state> --walk red|frlg [--players 2|3] --data <dir> --out <dir> [--show]
//
//   --walk red   Red/Blue: the state stands in Oak's lab with the starter – walking down starts the rival's battle
//   --walk frlg  FireRed/LeafGreen: the state stands at the balls in Oak's lab – round the table to the door: the rival
//   --skins <dir> the raid panel in colour themes as well (A's page, while fighting and at the end): the default, the
//                 high-contrast theme and souldew+ skins (<dir>/<id>.css, set the way the app sets one) – light and dark
//
// Never commit ROMs, states or the screenshots.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.setPath('userData', join(resolve(opt('data')), 'electron'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(main);
}

async function main() {
  const { app, BrowserWindow } = await import('electron');
  const data = resolve(opt('data'));
  const out = resolve(opt('out'));
  mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
  const n = Math.max(2, Math.min(3, Number(opt('players', 2))));
  const SLOTS = ['p1', 'p2', 'p3'].slice(0, n);
  const walkKind = opt('walk', 'red');
  const stateB64 = readFileSync(resolve(opt('state'))).toString('base64');

  const servers = [];
  const profiles = [['A', 'Sam', 7431], ['B', 'Tim', 7432], ['C', 'Kim', 7433]].slice(0, n).map(([id, name, port]) => {
    const dir = join(data, id);
    const lib = join(dir, 'roms');
    mkdirSync(lib, { recursive: true });
    copyFileSync(opt('rom'), join(lib, basename(opt('rom'))));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: opt('lang', 'en'), playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: true, nativeEngine: true, launchAnimation: 'off' }));
    const p = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => process.stderr.write(`[${id}] ${d}`));
    servers.push(p);
    return { id, name, port, base: `http://127.0.0.1:${port}` };
  });
  const finish = (code) => {
    for (const p of servers) p.kill();
    app.exit(code);
  };
  const api = async (pr, path, body, method) => {
    const r = await fetch(pr.base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw new Error(`${pr.id} ${path}: ${r.status} ${t.slice(0, 300)}`);
    try { return JSON.parse(t); } catch { return t; }
  };
  const wins = [];
  try {
    for (const pr of profiles) for (let i = 0; i < 100; i++) { try { await api(pr, '/api/status'); break; } catch { await sleep(200); } }
    const [A] = profiles;
    const libA = await api(A, '/api/library');
    const rom = libA.roms[0];
    const players = Object.fromEntries(SLOTS.map((s, i) => [s, { name: profiles[i].name }]));
    const built = await api(A, '/api/runs/build', { romId: rom.id, randomize: false, mode: 'soullink', players, buildFor: SLOTS, gameId: rom.gameId, name: 'Raid test', rules: {} });
    const runId = built.manifest.id;
    const run = await api(A, `/api/runs/${runId}`);
    const pack = run.manifest?.pack || run.pack;
    for (const [i, pr] of profiles.entries()) {
      if (!i) continue;
      const lib = await api(pr, '/api/library');
      const imported = await api(pr, '/api/runs/import', { pack });
      await api(pr, '/api/runs/build', { runId: imported.id, romId: lib.roms[0].id, randomize: false, values: {}, seeds: {}, players: pack.players, buildFor: [SLOTS[i], ...SLOTS.filter((s) => s !== SLOTS[i])], name: pack.name, mode: 'soullink', expectedOutputs: pack.outputs, gameId: lib.roms[0].gameId });
      await api(pr, `/api/runs/${runId}/me`, { slot: SLOTS[i] }).catch(() => null);
    }
    log('run', runId, 'on', n, 'computers');

    const show = args.includes('--show');
    for (const [i, pr] of profiles.entries()) {
      const w = new BrowserWindow({ width: 1280, height: 820, x: 20 + i * 430, y: 20 + i * 30, show, webPreferences: { partition: `raid-e2e-${pr.id}`, backgroundThrottling: false } });
      w.webContents.setAudioMuted(true);
      w.loadURL(`${pr.base}/#/soullink?run=${runId}`);
      wins.push(w);
    }
    const ev = (i, js) => wins[i].webContents.executeJavaScript(js, true);
    const until = async (what, fn, ms = 120000) => {
      const t = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t > ms) throw new Error(`timeout: ${what}`);
        await sleep(300);
      }
    };
    for (const [i] of profiles.entries()) {
      await until(`page ${i} loaded`, () => ev(i, `!!document.body && (localStorage.getItem('sl-e2e') === 'true' || (localStorage.setItem('sl-e2e', 'true'), location.reload(), false))`), 60000);
      await until(`page ${i}`, () => ev(i, '!!window.__slLink?.sync && !!window.__slRaid'), 120000);
    }
    const slotOf = (i) => ev(i, 'window.__slLink.sync.slot');
    for (const [i] of profiles.entries()) {
      if ((await slotOf(i)) === SLOTS[i]) continue;
      await ev(i, `localStorage.setItem('sl-me-${runId}', ${JSON.stringify(JSON.stringify(SLOTS[i]))}); location.reload(); true`).catch(() => null);
      await sleep(1500);
      await until(`page ${i} as ${SLOTS[i]}`, async () => (await ev(i, 'window.__slLink?.sync?.slot')) === SLOTS[i], 120000);
    }
    await until('direct links', async () => {
      for (const [i] of profiles.entries()) for (const s of SLOTS) if (s !== SLOTS[i] && !(await ev(i, `window.__slLink.sync.linkDirect(${JSON.stringify(s)})`))) return false;
      return true;
    }, 240000);
    log('direct links between all pages');

    // ---- every game: from the state right before the battle ----
    for (const [i] of profiles.entries()) await ev(i, `location.hash = '#/play?run=${runId}'`);
    const emu = (i, js) => ev(i, `(() => { const f = document.querySelector('.console-screen iframe'); const e = f?.contentWindow?.__emu; return e ? (${js}) : null; })()`);
    await until('pictures', async () => {
      for (const [i] of profiles.entries()) {
        await ev(i, `(() => { const f = document.querySelector('.console-screen iframe'); f?.contentWindow?.document.getElementById('tap')?.click(); return true; })()`).catch(() => null);
        if (!(await emu(i, 'e.ready'))) return false;
      }
      return true;
    }, 120000);
    await sleep(2500);
    for (const [i] of profiles.entries()) {
      const ok = await emu(i, `e.loadState(Uint8Array.from(atob(${JSON.stringify(stateB64)}), (c) => c.charCodeAt(0)))`);
      log(`page ${i}: state loaded`, ok);
    }
    await sleep(1500);
    const hold = (i, keys, ms) => emu(i, `e.hold(${JSON.stringify(keys)})`).then(() => sleep(ms)).then(() => emu(i, 'e.hold([])'));
    const press = async (i, key, after = 300) => { await hold(i, [key], 110); await sleep(after); };
    const rd = (i, addr, len) => emu(i, `Array.from(e.read(${addr}, ${len}) || [])`);
    const gameRect = async (i) => JSON.parse(await ev(i, `(() => { const f = document.querySelector('.console-screen iframe'); const c = (f.contentWindow.document.getElementById('screen') || f.contentWindow.__emu.canvas()).getBoundingClientRect(); const fr = f.getBoundingClientRect(); return JSON.stringify({ x: Math.round(fr.left + c.left), y: Math.round(fr.top + c.top), width: Math.round(c.width), height: Math.round(c.height) }); })()`));
    const shot = async (name, i, crop = false) => {
      const img = await wins[i].webContents.capturePage(crop ? await gameRect(i) : undefined);
      writeFileSync(join(out, `${name}-${profiles[i].id}.png`), img.toPNG());
    };
    const all = (name, crop = false) => Promise.all(profiles.map((_, i) => shot(name, i, crop)));
    // the raid panel in other colours (--skins): the default, a theme, souldew+ skins light and dark
    const SKINS = opt('skins') ? [['classic'], ['contrast', 'theme'], ...['fieldbook', 'sakura', 'cartridge-grey', 'paper-lantern', 'midnight-ink'].map((id) => [id, 'skin', readFileSync(join(resolve(opt('skins')), `${id}.css`), 'utf8')])] : [];
    const skinShots = async (i, name) => {
      for (const [id, kind, css] of SKINS) {
        await ev(i, `(() => { const r = document.documentElement; let st = document.getElementById('e2e-skin'); if (!st) { st = document.createElement('style'); st.id = 'e2e-skin'; document.head.append(st); }
          st.textContent = ${JSON.stringify(css || '')}; delete r.dataset.skin; delete r.dataset.theme; ${kind === 'skin' ? `r.dataset.skin = ${JSON.stringify(id)};` : kind === 'theme' ? `r.dataset.theme = ${JSON.stringify(id)};` : ''} return true; })()`);
        await sleep(400);
        const rect = JSON.parse(await ev(i, `(() => { const e = document.querySelector('.raid'); if (!e) return 'null'; const b = e.closest('.dock-sec') || e; const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.max(0, Math.round(r.left - 8)), y: Math.max(0, Math.round(r.top - 8)), width: Math.round(r.width + 16), height: Math.round(r.height + 16) }); })()`));
        if (rect) writeFileSync(join(out, `30-skin-${name}-${id}.png`), (await wins[i].webContents.capturePage(rect)).toPNG());
      }
      await ev(i, `(() => { const r = document.documentElement; document.getElementById('e2e-skin')?.remove(); delete r.dataset.skin; delete r.dataset.theme; return true; })()`);
    };
    const raid = (i, js) => ev(i, `(() => { const h = window.__slRaid; const cur = h?.current(); return JSON.stringify(${js}); })()`).then((s) => JSON.parse(s || 'null'));
    // the clip: every game's picture four times a second while the raid runs
    let recording = true;
    let frame = 0;
    const clipDirs = profiles.map((pr) => join(out, `clip-${pr.id}`));
    clipDirs.forEach((d) => mkdirSync(d, { recursive: true }));
    const rec = (async () => {
      while (recording) {
        await Promise.all(profiles.map(async (_, i) => {
          try {
            const img = await wins[i].webContents.capturePage();
            writeFileSync(join(clipDirs[i], `${String(frame).padStart(5, '0')}.png`), img.resize({ width: 960 }).toPNG());
          } catch { /* a page reloading */ }
        }));
        frame++;
        await sleep(250);
      }
    })();

    // ---- A starts the raid from the board; the others join in their play view ----
    await ev(0, `location.hash = '#/soullink?run=${runId}'`);
    await sleep(2500);
    const clickText = (i, sel, text) => ev(i, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (b) b.click(); return !!b; })()`);
    await until('the board\'s log', () => clickText(0, 'button, [role=tab], a', 'Log'), 30000);
    await sleep(600);
    await until('the board\'s Raid button', () => clickText(0, 'button', 'Raid'), 30000);
    await sleep(600);
    await shot('01-board-start', 0);
    await until('Start the raid', () => clickText(0, 'button', 'Start the raid'), 10000);
    log('A asked', JSON.stringify(await raid(0, 'cur && { id: cur.id, players: cur.raid.players, phase: cur.st.phase }')));
    await sleep(1500);
    for (let i = 1; i < n; i++) {
      await until(`page ${i} sees the invite`, async () => (await raid(i, 'cur && cur.st.players[h.me]')) === 'invited', 20000);
      await shot('02-invite', i);
      await until(`page ${i} joins`, () => clickText(i, '.raid button', 'Join'), 10000);
      log(`page ${i} joined`);
    }
    await ev(0, `location.hash = '#/play?run=${runId}'`);
    await until('countdown', async () => (await raid(0, 'cur && cur.st.phase')) === 'countdown', 30000);
    await sleep(800);
    await all('03-countdown');
    log('countdown');

    // ---- everybody walks into the battle ----
    const posFR = async (i) => {
      const p = await rd(i, 0x03005008, 4);
      const a = (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0;
      const b = await rd(i, a, 6);
      return { x: (b[0] | (b[1] << 8)) << 16 >> 16, y: (b[2] | (b[3] << 8)) << 16 >> 16 };
    };
    const goFR = async (i, tx, ty, order) => {
      for (let k = 0; k < 30; k++) {
        const p = await posFR(i);
        if (p.x === tx && p.y === ty) return;
        const xFirst = order === 'xy';
        if ((xFirst && p.x !== tx) || (!xFirst && p.y === ty)) await hold(i, [p.x < tx ? 'right' : 'left'], 240);
        else await hold(i, [p.y < ty ? 'down' : 'up'], 240);
        await sleep(120);
      }
    };
    const inBattle = (i) => raid(i, 'h.lastView ? { q: h.lastView.quiet, foes: h.lastView.foes.map((f) => f.hp) } : null');
    await until('the countdown ends', async () => (await raid(0, 'cur && cur.st.phase')) !== 'countdown', 20000);
    await Promise.all(profiles.map(async (_, i) => {
      if (walkKind === 'frlg') {
        await goFR(i, 10, 6, 'yx');
        await goFR(i, 7, 10, 'xy');
      }
      await until(`page ${i} in the battle`, async () => {
        if (await inBattle(i)) return true;
        if (walkKind === 'red') await hold(i, ['down'], 200);
        await press(i, 'b', 200);
        return false;
      }, 90000);
    }));
    log('everybody in the battle', JSON.stringify(await Promise.all(profiles.map((_, i) => inBattle(i)))));
    await all('04-battle');

    // ---- turns: the player whose turn it is hits once at their menu, then the next; texts go on with B ----
    const status = (i) => raid(i, `cur && { phase: cur.st.phase, pools: cur.st.pool.pools, players: cur.st.players, mine: h.lastView && h.lastView.foes.map((f) => f.hp), quiet: h.lastView?.quiet, held: h.holding() }`);
    let who = 0;
    let shots = 0;
    const turnsLog = [];
    for (let turn = 0; turn < 40; turn++) {
      const sts = await Promise.all(profiles.map((_, i) => status(i)));
      turnsLog.push(sts);
      log('turn', turn, sts.map((s, i) => `${profiles[i].id}:${s?.phase} pool ${s?.pools?.join('/')} game ${s?.mine?.join('/')} ${s?.players?.[SLOTS[i]]}`).join(' | '));
      if (sts.every((s) => !s || s.phase === 'won' || s.phase === 'lost') && sts.every((s, i) => ['done', 'out'].includes(s?.players?.[SLOTS[i]]))) break;
      // the next player still in their battle
      for (let k = 0; k < n && ['done', 'out'].includes(sts[who]?.players?.[SLOTS[who]]); k++) who = (who + 1) % n;
      const i = who;
      const ready = await until(`page ${i} at its menu`, async () => {
        const s = await status(i);
        if (s?.quiet) return true;
        if (['done', 'out'].includes(s?.players?.[SLOTS[i]])) return 'skip';
        await press(i, 'b', 250);
        return false;
      }, 60000).catch(() => 'skip');
      if (ready === 'skip') { who = (who + 1) % n; continue; }
      await sleep(900);
      if (shots < 6) await all(`10-turn${String(turn).padStart(2, '0')}`, true), shots++;
      if (turn === 2 && SKINS.length) await skinShots(0, 'fight');
      await press(i, 'a', 700);
      await press(i, 'a', 400);
      // the move runs; everybody else's texts go on
      for (let k = 0; k < 24; k++) {
        await sleep(450);
        for (let j = 0; j < n; j++) if (j !== i && !(await status(j))?.quiet) await press(j, 'b', 50);
        if (k > 6 && (await status(i))?.quiet) break;
        if (k % 3 === 2) await press(i, 'b', 50);
      }
      who = (who + 1) % n;
    }
    await sleep(2000);
    await all('20-end');
    // the result card and the log entry on every page
    const results = await Promise.all(profiles.map((_, i) => raid(i, `cur && { phase: cur.st.phase, result: cur.st.phase === 'won' || cur.st.phase === 'lost' }`)));
    const feeds = await Promise.all(profiles.map((_, i) => ev(i, `JSON.stringify(Object.entries(window.__slLink.sync.doc.scan('feed:')).filter(([k]) => k.startsWith('raid-')).map(([, v]) => ({ won: v.won, mvp: v.mvp, players: v.players, survivors: v.survivors, ms: v.ms, text: v.text })))`)));
    log('results', JSON.stringify(results));
    log('log entries', feeds.join(' '));
    await all('21-result');
    if (SKINS.length) await skinShots(0, 'result');
    recording = false;
    await rec;
    // the clips (muted: the pictures only)
    for (const [i, d] of clipDirs.entries()) {
      if (!readdirSync(d).length) continue;
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '4', '-i', join(d, '%05d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(out, `raid-${profiles[i].id}.mp4`)]);
      log('clip', profiles[i].id, r.status === 0 ? 'ok' : String(r.stderr));
    }
    writeFileSync(join(out, 'result.json'), JSON.stringify({ runId, players: n, results, feeds: feeds.map((f) => JSON.parse(f)), turns: turnsLog }, null, 1));
    const ok = results.every((r) => r?.phase === 'won') && feeds.every((f) => JSON.parse(f).length === 1);
    log(ok ? 'RAID WON in every game' : 'NOT OK');
    finish(ok ? 0 : 1);
  } catch (e) {
    console.error(e);
    try {
      for (const [i, w] of wins.entries()) writeFileSync(join(out, `fail-${i}.png`), (await w.webContents.capturePage()).toPNG());
    } catch { /* no windows */ }
    finish(1);
  }
}
