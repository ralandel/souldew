// End-to-end test of link sessions in the real app: two souldew servers with scratch data folders (two players on this
// computer), one SoulLink run (created on A, joined on B), each player's battery save in it, both pages in Electron
// (muted). A invites B over the run's peer channel, B joins; both servers find every seat's game by SHA-1, the saves
// cross the channel, both play views switch to the link session. The buttons come from a recording of the same trade
// or battle (each host plays its own seat's column – SLS_LINK_TEST_SCRIPT, test-only), so the session's outcome is
// known: both hosts must stay in step (hashes), and the battery saves written back into each player's run must be the
// recording's (--expect). Screenshots of both windows go to --out.
//
//   node scripts/link-e2e.mjs --rom1 <A's game> [--rom2 <B's game>] --save1 <a.sav> --save2 <b.sav> --script <rec>
//        --data <dir> --out <dir> [--kind trade|battle] [--rtc ms] [--expect <dir with seat0.sav, seat1.sav …>]
//        [--players 3|4 --save3 … --save4 … [--rom3 … --rom4 …]]   (a group session: everybody linked at once)
//        [--all-roms]        (every library has every game: the partners' are found there by CRC and SHA-1)
//        [--speed 6] [--shots f1,f2,…] [--other-release]   (B plays another file of the game: each side must find or
//        pick the partner's copy – decision (2), "Pick your copy", by SHA-1)
//        [--rejoin <frame>]  (B's page reloads at that frame and rejoins from A's state)
//        [--desync]          (B's host gets another clock: the games fall out of step – both saves go back; with
//                            --seamless --desync-state <file>: B's host starts A's seat from that state instead – each
//                            game then goes back to where it was before the link)
//        [--seamless [--state1 <a.state> --state2 <b.state> …]]   (docs/MULTIPLAYER.md › "Seamless": every player is
//                            in the middle of their game in the fast player – a state of that moment (the fast player's
//                            format, e.g. linkhost --bench F --export) loaded while paused – and the link starts from the
//                            running games without a restart; --script is then the recording from that moment on. After
//                            the session each game goes on alone from where the session left it: same page, no reboot.
//                            Frame strips of the switch in and out go to --out. --prestep k: the states are k frames
//                            before the recording's start; those k frames run in the fast player, nothing pressed.)
//        [--disconnect <frame>]  (B's peer link goes down there; both players leave – with --seamless each goes on alone
//                            from their own console as it is)
//        [--relay]           (every peer connection relayed through TURN – the bot's /link/ice must answer)
//        [--gb-look original|color] [--gb-look1 …] [--gb-look2 …]  (every / one player's Settings › Game Boy look;
//                            default color, as the recordings were made)
//        [--engine]          (Settings › "souldew engine (beta)": every fast player is the souldew engine – with
//                            --seamless the partners join each player's running game in its own process and leave it
//                            the same way: checks linkedInPlace / aloneInPlace)
//        [--winner p1|p2|p3,p4]   (a battle: the seat(s) the recording's battle is known to end with as the winners –
//                            every computer must have read that result, the same, and logged it; docs/MULTIPLAYER.md
//                            › "Battle results and wagers")
//        [--wager <₽> [--format single|double|multi]]   (A's challenge is for that much money: after the session each
//                            player's game pays / gets it in the overworld – checked in RAM; with --save-after each
//                            player then saves in the game (Gen 3: START, SAVE, YES, YES) and the money is checked in the
//                            run's save file)
//        [--continue]        (with --seamless and no states: every game boots from its save and is pressed through its
//                            title screen – START ×4, A ×4 – before the link starts from the running games)
//        [--reset-after]     (with --wager: after the session every game is switched off and on and Continue'd –
//                            Gen 1 has no way out of the Colosseum, the wager is settled once the player walks again)
//        [--bystander [--save3 …] [--rom3 …] [--state3 …]]   (one more player in the run who isn't in the session:
//                            their page never sees the invite, asking A to trade meanwhile is answered "in another
//                            link", the session goes on; with --seamless their own game keeps running untouched; they
//                            get the trade / battle result in the run's log afterwards)
//        [--together]       (a Play together run instead of a SoulLink – shared/playtogether.mjs: each player's save goes
//                            into their library game, the run reads it from there, and after the session the library
//                            game's own save must hold the session's result: checks runSaveIsLibrarySave,
//                            librarySaveHasSession)
//        [--port-base 7401] (the players' servers listen on it and the next three ports)
//        [--show]
//
// Two computers (one seat here, the other seat on another computer – Mac ↔ Windows, x64 ↔ arm64): each side runs its
// own souldew server and page (muted, hidden) with a scratch data folder; the run travels by the app's invite code
// (6 digits over the public relay), the session over the run's real peer channel (direct, or TURN when that fails);
// each side plays its own seat's column of the SAME recording and prints a RESULT line: the hashes its link host
// computed (count, first, last and a sha256 over all of them – equal on both sides) and the sha256 of its seat's save
// after the session (with --expect: compared with the recording's). The session itself also compares every hash: a
// difference ends it as out of step (checks.noMismatch false on both). Needs internet on both computers.
//
//   host (seat 1):  node scripts/link-e2e.mjs --host --rom <game> [--save <seat0.sav>] [--script <rec>] [--expect <dir>] --data <dir>
//                   → prints INVITE CODE: 123456 (also <data>/out/invite-code.txt) and waits up to 15 minutes
//   other side:     node scripts/link-e2e.mjs --join 123456 --rom <game> [--save <seat1.sav>] [--script <rec>] [--expect <dir>] --data <dir>
//        [--other-rom <the other side's game>]  (a run of two different games: each side needs both files)
//        [--kind trade|battle] [--speed 4] [--frames 7200] (no --script: nothing pressed for that many frames, from
//        the saves) [--relay] (TURN only) [--no-turn] [--port 7421|7422] [--slot p2] [--engine] [--gb-look …] [--show]
//   Results: <data>/out/result.json and screenshots. Both sides must use the same recording, the same ROMs (SHA-1) and
//   the same souldew build (the link host's version is part of the check). docs/MULTIPLAYER.md › "Two computers".
//
// Never commit ROMs, saves or the screenshots.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, statfsSync, constants as fsConstants } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, dirname, basename, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { headerRange, gameOf } from '../shared/linkbattle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);

if (!process.versions.electron) {
  const electron = (await import('electron')).default;
  const p = spawn(electron, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  p.on('exit', (c) => process.exit(c ?? 1));
} else {
  const { app } = await import('electron');
  app.commandLine.appendSwitch('mute-audio');
  // (two computers' halves may run on one computer for a check: each its own Electron profile in its data folder)
  if (flag('host') || opt('join')) app.setPath('userData', join(resolve(opt('data')), 'electron'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => (flag('host') || opt('join') ? crossMain() : main()));
}

/**
 * One seat of a link session on THIS computer, the other seat on another computer (--host / --join, see the header):
 * the run travels by the app's invite code (6 digits over the public relay, docs: web/lib/invitecode.mjs), the session
 * over the run's real peer channel (direct, or TURN), each side plays its own seat's column of the same recording, and
 * each side prints what both must agree on: the hashes it computed and the sha256 of its seat's save after the session.
 */
async function crossMain() {
  const { app, BrowserWindow } = await import('electron');
  const host = flag('host');
  const role = host ? 'host' : 'join';
  const data = resolve(opt('data'));
  const out = resolve(opt('out', join(data, 'out')));
  mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s [${role}]`, ...a);
  const sha = (b, alg = 'sha1') => createHash(alg).update(b).digest('hex');
  const seats = Number(opt('players', '2'));
  const slot = host ? 'p1' : opt('slot', 'p2');
  const seat = Number(slot.slice(1)) - 1;
  const kind = opt('kind', 'trade');
  const port = Number(opt('port', host ? '7421' : '7422'));
  const rom = resolve(opt('rom'));
  const here = `${process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux'} ${process.arch}`;
  const name = opt('name', here);
  // the recording (or, without one, nothing pressed for --frames frames: still every console's state, compared)
  let script = opt('script') ? resolve(opt('script')) : null;
  if (!script) {
    const n = Number(opt('frames', '7200'));
    const rec = Buffer.alloc(n * (4 + 4 * seats));
    for (let f = 0; f < n; f++) rec.writeUInt32LE(f, f * (4 + 4 * seats));
    script = join(out, 'nothing-pressed.rec');
    writeFileSync(script, rec);
  }
  const frames = Math.floor(readFileSync(script).length / (4 + 4 * seats));
  const result = { role, slot, platform: process.platform, arch: process.arch, kind, frames, rom: basename(rom), romSha1: sha(readFileSync(rom)), checks: {} };
  const exe = join(root, 'tools', 'native', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'linkhost.exe' : 'linkhost');
  try { result.linkhostSha256 = sha(readFileSync(exe), 'sha256'); } catch { result.linkhostSha256 = null; }

  const dir = join(data, 'profile');
  const lib = join(dir, 'roms');
  mkdirSync(lib, { recursive: true });
  for (const r of [rom, ...(opt('other-rom') ? [resolve(opt('other-rom'))] : [])]) copyFileSync(r, join(lib, basename(r)), fsConstants.COPYFILE_FICLONE);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: true,
    nativeEngine: flag('engine'), gbLook: opt('gb-look', 'color') }));
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1', SLS_E2E: '1', SLS_LINK_TEST_SCRIPT: script,
    SLS_LINK_TEST_RTC: opt('rtc', '1763200000000') };
  // (TURN as the app has it: direct first, relayed when that fails; --relay: relayed only; --no-turn: never relayed)
  if (flag('relay')) env.SOULDEW_LINK_ICE = 'relay';
  else if (flag('no-turn')) env.SOULDEW_LINK_ICE = 'off';
  else delete env.SOULDEW_LINK_ICE;
  const server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  const APP = { headers: { 'x-soullink': '1' } };
  const finish = (code) => {
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(`RESULT ${JSON.stringify({ ok: code === 0, ...result, console: undefined })}`);
    server.kill();
    app.exit(code);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => finish(130));
  const api = async (path, body, method) => {
    const r = await fetch(base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status} ${t.slice(0, 300)}`), { status: r.status });
    try { return JSON.parse(t); } catch { return t; }
  };
  const until = async (what, fn, ms) => {
    const t = Date.now();
    for (let k = 0; ; k++) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() - t > ms) throw new Error(`timeout: ${what}`);
      if (k && k % 75 === 0) log(`still waiting: ${what}`);
      await sleep(400);
    }
  };
  try {
    const up = await Promise.race([new Promise((r) => server.once('exit', r)), sleep(2500).then(() => null)]);
    if (up !== null) throw new Error(`the server stopped (port ${port} taken? --port <n>)`);
    await until('the server', () => api('/api/status'), 30000);
    const libNow = await api('/api/library');
    const own = libNow.roms.find((r) => basename(r.file || '') === basename(rom)) || libNow.roms[0];
    if (!own) throw new Error('the game isn\'t in the library (is --rom a game souldew knows?)');
    log('game', own.name, own.gameId, own.system, 'sha1', result.romSha1);
    const win = new BrowserWindow({ width: 1100, height: 780, show: flag('show'), webPreferences: { partition: `link-x-${role}`, backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') (result.console ||= []).push(`${e.level}: ${String(e.message).slice(0, 300)}`);
    });
    const ev = (js) => win.webContents.executeJavaScript(js, true);
    const load = async (hash) => {
      await win.loadURL(`${base}/${hash}`);
    };
    const shot = async (n) => writeFileSync(join(out, `${n}-${role}.png`), (await win.webContents.capturePage()).toPNG());
    let runId;
    let pack;
    if (host) { // the run: built here, our save in it; then the invite code
      const players = Object.fromEntries(['p1', 'p2', 'p3', 'p4'].slice(0, seats).map((s, i) => [s, { name: i === seat ? name : `Partner ${i + 1}` }]));
      const built = await api('/api/runs/build', { romId: own.id, randomize: false, mode: 'soullink', players, buildFor: [slot], gameId: own.gameId, name: 'Link test (two computers)', rules: {} });
      runId = built.manifest.id;
      const run = await api(`/api/runs/${runId}`);
      pack = run.manifest?.pack || run.pack;
      await load('#/');
      const codeNow = await ev(`(async () => { const m = await import('/lib/invitecode.mjs'); const h = new m.CodeHost({ pack: ${JSON.stringify(pack)},
        onState: (s) => { window.__xstate = s; } }); window.__xhost = h; await h.start(); return h.state.phase === 'waiting' ? h.code : 'failed:' + h.state.phase + ' ' + (h.state.error || ''); })()`);
      if (!/^\d{6}$/.test(codeNow)) throw new Error(`no invite code: ${codeNow}`);
      result.code = codeNow;
      writeFileSync(join(out, 'invite-code.txt'), `${codeNow}\n`);
      console.log(`\n================  INVITE CODE: ${codeNow}  ================\nOn the other computer (within 15 minutes):\n  node scripts/link-e2e.mjs --join ${codeNow} --rom <its game> [--save <its seat's save>] [--script <the same recording>] --data <its scratch folder>\n`);
      const req = await until('the other computer to use the code', async () => ((await ev('window.__xstate?.phase')) === 'request' ? JSON.parse(await ev('JSON.stringify(window.__xstate.request)')) : null), 15 * 60000);
      log('joined by', req.name);
      // (test-only: the host's own digits – the app makes the host type the ones the other screen shows)
      if (!(await ev(`window.__xhost.allow({ confirm: window.__xstate.request.confirm })`))) throw new Error('allow refused');
      await until('the run pack to arrive there', async () => ['done', 'sending'].includes(await ev('window.__xstate?.phase')), 120000);
      result.partner = req.name;
    } else { // the run by the code, our own game built, our save in it
      await load('#/');
      await ev(`(() => { window.__xj = { p: 'starting' }; import('/lib/invitecode.mjs').then((m) => { const j = m.joinWithCode(${JSON.stringify(String(opt('join')))}, { name: ${JSON.stringify(name)},
        onState: (p, info) => { window.__xj = { p, info }; } }); j.promise.then((pk) => { window.__xpack = JSON.stringify(pk); }, (e) => { window.__xj = { p: 'error', info: e.code || String(e) }; }); }); return true; })()`);
      let said = '';
      const packText = await until('the host to allow', async () => {
        const st = JSON.parse(await ev('JSON.stringify(window.__xj)') || '{}');
        if (st.p !== said) log('code:', (said = st.p), st.info ? JSON.stringify(st.info) : '');
        if (st.p === 'error') throw new Error(`invite code: ${st.info}`);
        return ev('window.__xpack');
      }, 16 * 60000);
      pack = JSON.parse(packText);
      const imported = await api('/api/runs/import', { pack });
      runId = imported.id;
      await api('/api/runs/build', { runId, romId: own.id, randomize: false, values: {}, seeds: {}, players: pack.players, buildFor: [slot], name: pack.name, mode: 'soullink', expectedOutputs: pack.outputs, gameId: own.gameId });
    }
    result.runId = runId;
    if (opt('save')) {
      const bytes = readFileSync(resolve(opt('save')));
      await api(`/api/runs/${runId}/save/${slot}`, new Uint8Array(bytes), 'PUT');
      result.saveBeforeSha256 = sha(bytes, 'sha256');
    }
    // (how long this computer's server takes to scan the run's game – web/lib/data.mjs romFetch; the page asks for the
    // same scan and no longer waits for it: logged, so a slow computer shows up in the result)
    const scanAt = Date.now();
    api(`/api/runs/${runId}`).then((m) => {
      const file = m.outputs?.[slot]?.rom;
      return file && api(`/api/rom/locations?src=${encodeURIComponent(`/api/runs/${runId}/file?inline=1&name=${encodeURIComponent(file)}`)}`);
    }).then((r) => {
      result.romScanMs = Date.now() - scanAt;
      log(`the game's ROM data: ${(result.romScanMs / 1000).toFixed(1)} s${r?.data ? '' : ' (none found)'}`);
    }, (e) => log('the game\'s ROM data:', String(e)));
    await ev(`localStorage.setItem(${JSON.stringify(`sl-me-${runId}`)}, ${JSON.stringify(JSON.stringify(slot))}); localStorage.setItem('sl-e2e', 'true'); true`);
    await load(`#/soullink?run=${runId}`);
    await ev('location.reload(); true');
    await sleep(1500);
    await until('the page', () => ev('!!window.__slLink?.sessions'), 60000);
    // (every hash this computer's link host computes, in order: the other computer prints its own – they must be equal)
    await ev(`(() => { const L = window.__slLink.sessions; L.__xh = []; const h = L._hash.bind(L); L._hash = (s, f, x) => { if (s === L.me) L.__xh.push([f, x]); return h(s, f, x); }; return true; })()`);
    const partners = ['p1', 'p2', 'p3', 'p4'].slice(0, seats).filter((s) => s !== slot);
    await until('a peer connection to the other computer', async () => {
      for (const s of partners) if (!(await ev(`window.__slLink.sync.linkDirect(${JSON.stringify(s)})`))) return false;
      return true;
    }, 10 * 60000);
    log('peer connection up');
    await shot('01-board');
    const phase = () => ev('window.__slLink.sessions.state.phase');
    if (host) await ev(`window.__slLink.sessions.invite(${JSON.stringify(kind)}, ${JSON.stringify(partners)}, ${JSON.stringify(opt('wager') ? { wager: Number(opt('wager')) } : {})})`);
    else {
      await until('the host\'s invite', async () => (await phase()) === 'invited', 10 * 60000);
      await ev('window.__slLink.sessions.accept()');
    }
    await until('the link session running', async () => {
      const p = await phase();
      if (p === 'need') throw new Error('a seat\'s game is missing here – give the other computer\'s game with --other-rom');
      if (p === 'ended') throw new Error(`the session ended before it ran: ${await ev('JSON.stringify(window.__slLink.sessions.state.ended)')}`);
      return p === 'running';
    }, 5 * 60000);
    const st0 = JSON.parse(await ev('JSON.stringify(window.__slLink.sessions.state)'));
    result.delay = st0.delay;
    result.rtt = st0.rtt;
    result.route = st0.route;
    log('running: delay', st0.delay, 'rtt', st0.rtt, 'route', JSON.stringify(st0.route));
    const emu = (js) => ev(`(() => { const f = document.querySelector('iframe[src^="/playernative.html"]'); const e = f?.contentWindow?.__emu; return e ? (${js}) : null; })()`);
    await until('the picture', () => emu('e.ready'), 120000);
    // faster than real time where both computers can, and every host stops at the recording's last frame (UNTIL)
    const id = st0.id;
    const b = Buffer.alloc(24);
    b.writeUInt32LE(2, 0), b.writeUInt32LE(4, 4), b.writeFloatLE(Number(opt('speed', '4')), 8);
    b.writeUInt32LE(24, 12), b.writeUInt32LE(4, 16), b.writeUInt32LE(frames, 20);
    await fetch(`${base}/api/native/cmd?id=${id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: b });
    await shot('02-linked');
    let last = 0;
    await until(`frame ${frames}`, async () => {
      if ((await phase()) === 'ended') return true;
      const f = Number(await emu('e.frames()')) || 0;
      if (f - last >= 3000) log('frame', (last = f), JSON.stringify(JSON.parse(await ev('JSON.stringify(window.__slLink.sessions.stats)'))));
      return f >= frames;
    }, Math.max(10 * 60000, (frames / 60) * 4000));
    await shot('03-end');
    if ((await phase()) !== 'ended') {
      await sleep(2500);
      if (host) await ev('window.__slLink.sessions.leave("left")');
      await until('the session to end', async () => (await phase()) === 'ended', 120000);
    }
    const ended = JSON.parse(await ev('JSON.stringify(window.__slLink.sessions.state.ended)'));
    const stats = JSON.parse(await ev('JSON.stringify(window.__slLink.sessions.stats)'));
    const hl = JSON.parse(await ev('JSON.stringify(window.__slLink.sessions.__xh)')) || [];
    result.ended = ended;
    result.stats = stats;
    result.hashes = { count: hl.length, first: hl[0] || null, last: hl.at(-1) || null, sha256: sha(hl.map(([f, h]) => `${f}:${h}`).join(','), 'sha256') };
    await sleep(6000); // (the last battery save reaches the run)
    const save = Buffer.from(await fetch(`${base}/api/runs/${runId}/save/${slot}`, APP).then((r) => r.arrayBuffer()));
    writeFileSync(join(out, `after-${slot}.sav`), save);
    result.saveAfterSha256 = sha(save, 'sha256');
    result.checks.noMismatch = !stats.mismatch && ended?.reason !== 'linkDesync';
    result.checks.hashesCompared = (stats.hashes || 0) > 10;
    result.checks.reachedTheEnd = hl.length > 0 && hl.at(-1)[0] >= Math.floor((frames - 1) / 120) * 120 - 240;
    if (opt('expect')) {
      const e = readFileSync(join(resolve(opt('expect')), `seat${seat}.sav`));
      result.checks.saveAsRecorded = save.subarray(0, e.length).equals(e);
    }
    await shot('04-left');
    log('hashes', JSON.stringify(result.hashes), 'save sha256', result.saveAfterSha256);
    log('checks', JSON.stringify(result.checks));
    finish(Object.values(result.checks).every(Boolean) ? 0 : 1);
  } catch (e) {
    console.error(e);
    result.error = String(e?.stack || e);
    finish(1);
  }
}

async function main() {
  const { app, BrowserWindow } = await import('electron');
  const data = resolve(opt('data'));
  const out = resolve(opt('out'));
  mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`, ...a);
  const sha = (b) => createHash('sha1').update(b).digest('hex');
  const kind = opt('kind', 'trade');
  const script = resolve(opt('script'));
  const seats = Number(opt('players', '2'));
  // (--bystander: one more player in the run who isn't in the session – their computer, page and game must stay out of it)
  const bystander = flag('bystander');
  const together = flag('together');
  const libIds = []; // (--together: each player's library game id – its save is the run's)
  const people = seats + (bystander ? 1 : 0);
  const frames = Math.floor(readFileSync(script).length / (4 + 4 * seats));
  const rtc = opt('rtc', '1763200000000');
  const rom1 = resolve(opt('rom1'));
  const rom2 = resolve(opt('rom2') || rom1);
  const romOf = (i) => (i === 0 ? rom1 : i === 1 ? rom2 : resolve(opt(`rom${i + 1}`) || rom1));
  // (a full disk would hurt more than this test: stop early)
  const free = (() => { try { const f = statfsSync(resolve(opt('data'), '..')); return f.bavail * f.bsize; } catch { return Infinity; } })();
  if (free < 1.2e9) { console.error(`only ${(free / 1e9).toFixed(1)} GB free – not starting`); app.exit(2); return; }
  const result = { kind, frames, players: seats, rom1: basename(rom1), rom2: basename(rom2), checks: {} };
  const SLOTS = ['p1', 'p2', 'p3', 'p4'].slice(0, people); // (the run's players)
  const SESSION = SLOTS.slice(0, seats); // (the session's seats: the first `seats` players)
  // (the bystander's view of the players in `slots`: what its link session knows, the card's tag and link buttons)
  const bystanderCards = (slots) => `JSON.stringify(Object.fromEntries(${JSON.stringify(slots)}.map((s) => {
    const tag = document.querySelector(\`.link-away[data-linked="\${s}"]\`);
    const card = [...document.querySelectorAll('.player-tag')].find((x) => x.classList.contains(s));
    return [s, { known: window.__slLink?.sessions?.linkedElsewhere?.(s) || null, tag: tag?.textContent?.trim() || null,
      buttons: card ? [...card.querySelectorAll('.link-buttons button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, title: b.title })) : [] }];
  })))`;
  const APP = { headers: { 'x-soullink': '1' } }; // (2.7.1: the server answers save reads only to the app – server/lib/guard.mjs)

  // ---- one server and scratch data folder per player ----------------------------------------------------------------
  const servers = [];
  const portBase = Number(opt('port-base', '7401')); // (another --port-base: two runs side by side)
  const profiles = [['A', 'Sam', portBase], ['B', 'Tim', portBase + 1], ['C', 'Robin', portBase + 2], ['D', 'Kim', portBase + 3]].slice(0, people).map(([id, name, port], i) => [id, name, port, romOf(i)]).map(([id, name, port, rom]) => {
    const dir = join(data, id);
    const lib = join(dir, 'roms');
    mkdirSync(lib, { recursive: true });
    // (--all-roms: every player's library has every game of the session – the partners' are then found by CRC + SHA-1)
    // (a clone where the disk can – APFS: no extra space – else a copy: a DS game is 128–512 MB per player)
    for (const r of flag('all-roms') ? [...new Set([rom, ...[0, 1, 2, 3].slice(0, seats).map(romOf)])] : [rom]) copyFileSync(r, join(lib, basename(r)), fsConstants.COPYFILE_FICLONE);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: name, libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: true, nativeEngine: flag('engine'),
      gbLook: opt(`gb-look${'ABCD'.indexOf(id) + 1}`) || opt('gb-look', 'color') })); // (the recordings were made on Game Boy Colors)
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1', SLS_E2E: '1', SLS_LINK_TEST_SCRIPT: script,
      // (--seamless --desync: the states differ instead – a game in the middle of a trade may never read its clock)
      SLS_LINK_TEST_RTC: id === 'B' && flag('desync') ? String(Number(rtc) + 86400000 * 3) : rtc,
      // --relay: every peer connection through Cloudflare TURN (credentials from souldew's bot), never direct; else no
      // TURN at all (both players are on this computer – the bot isn't asked)
      SOULDEW_LINK_ICE: flag('relay') ? 'relay' : 'off' };
    const p = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => process.stderr.write(`[${id}] ${d}`));
    servers.push(p);
    return { id, name, port, lib, dir, base: `http://127.0.0.1:${port}` };
  });
  const finish = (code) => {
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    for (const p of servers) p.kill();
    app.exit(code);
  };
  // (stopped from outside: no server may outlive the test – the next run would talk to it on the same port)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => finish(130));
  const api = async (pr, path, body, method) => {
    const r = await fetch(pr.base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${pr.id} ${path}: ${r.status} ${t.slice(0, 300)}`), { status: r.status, body: t });
    try { return JSON.parse(t); } catch { return t; }
  };
  try {
    for (const [i, p] of servers.entries()) {
      const code = await Promise.race([new Promise((r) => p.once('exit', r)), sleep(2500).then(() => null)]);
      if (code !== null) throw new Error(`server ${profiles[i].id} stopped (port ${profiles[i].port} taken by an older run?)`);
    }
    for (const pr of profiles) for (let i = 0; i < 100; i++) { try { await api(pr, '/api/status'); break; } catch { await sleep(200); } }
    const [A, B] = profiles;
    const N = profiles.length;
    const every = profiles.map((_, i) => i); // (every computer of the run)
    const all = every.slice(0, seats); // (the session's computers)
    const by = bystander ? seats : -1; // (the bystander's computer)
    // ---- the run: built on A, joined on B ------------------------------------------------------------------------------
    const libA = await api(A, '/api/library');
    const own = (lib, i) => lib.roms.find((r) => basename(r.file || '') === basename(romOf(i))) || lib.roms[0];
    const rom = own(libA, 0);
    log('library', rom.name, rom.gameId, rom.system);
    // (every player builds only their own game, as a DS run does when it's joined: the others' are found by SHA-1)
    const players = Object.fromEntries(profiles.map((pr, i) => [SLOTS[i], { name: pr.name }]));
    // --together: a Play together run (shared/playtogether.mjs) – every player's save is their library game's own
    const mode = together ? 'together' : 'soullink';
    const built = await api(A, '/api/runs/build', { romId: rom.id, randomize: false, mode, players, buildFor: ['p1'], gameId: rom.gameId, name: 'Link test', rules: {}, ...(together ? { host: 'p1' } : {}) });
    libIds[0] = rom.id;
    const runId = built.manifest.id;
    const run = await api(A, `/api/runs/${runId}`);
    const pack = run.manifest?.pack || run.pack;
    for (const [i, pr] of profiles.entries()) {
      if (!i) continue;
      const imported = await api(pr, '/api/runs/import', { pack });
      const lib = await api(pr, '/api/library');
      await api(pr, '/api/runs/build', { runId: imported.id, romId: own(lib, i).id, randomize: false, values: {}, seeds: {}, players: pack.players, buildFor: [SLOTS[i]], name: pack.name, mode, expectedOutputs: pack.outputs, gameId: own(lib, i).gameId });
      libIds[i] = own(lib, i).id;
    }
    if (together) result.pack = { format: pack.format, minVersion: pack.minVersion, mode: pack.mode };
    const pre = {};
    for (const [i, pr] of profiles.entries()) {
      const bytes = readFileSync(opt(`save${i + 1}`) || opt('save1')); // (the bystander may play a copy of A's save)
      // (Play together: the game's progress is in the library – the player's normal save, played alone so far)
      await api(pr, together ? `/api/saves/solo?id=${encodeURIComponent(libIds[i])}` : `/api/runs/${runId}/save/${SLOTS[i]}`, new Uint8Array(bytes), 'PUT');
      pre[pr.id] = sha(bytes);
    }
    if (together) { // the run reads the library save: the same bytes both ways
      result.checks.runSaveIsLibrarySave = true;
      for (const [i, pr] of profiles.entries()) {
        const viaRun = Buffer.from(await fetch(`${pr.base}/api/runs/${runId}/save/${SLOTS[i]}`, APP).then((r) => r.arrayBuffer()));
        if (sha(viaRun) !== pre[pr.id]) result.checks.runSaveIsLibrarySave = false;
      }
    }
    log('run', runId, 'built on', N, 'computers');

    // ---- the pages ---------------------------------------------------------------------------------------------------
    const show = flag('show');
    const wins = profiles.map((pr, i) => {
      const w = new BrowserWindow({ width: 1100, height: 780, x: 40 + (i % 2) * 560, y: 40 + Math.floor(i / 2) * 400, show, webPreferences: { partition: `link-e2e-${pr.id}`, backgroundThrottling: false } });
      w.webContents.setAudioMuted(true);
      // (the pages' warnings and errors go into result.json – what a failed run needs first)
      w.webContents.on('console-message', (e) => {
        if (e.level === 'warning' || e.level === 'error') (result.console ||= []).push(`${pr.id} ${e.level}: ${String(e.message).slice(0, 300)}`);
      });
      w.loadURL(`${pr.base}/#/soullink?run=${runId}`);
      return w;
    });
    const ev = (i, js) => wins[i].webContents.executeJavaScript(js, true);
    // which player each computer is (an imported run otherwise guesses "p2" – fine for two players, not for four)
    for (const i of every) {
      await new Promise((r) => (wins[i].webContents.isLoading() ? wins[i].webContents.once('did-finish-load', r) : r()));
      // (sl-e2e: the page hands its link session to this script as window.__slLink)
      await ev(i, `localStorage.setItem(${JSON.stringify(`sl-me-${runId}`)}, ${JSON.stringify(JSON.stringify(SLOTS[i]))}); localStorage.setItem('sl-e2e', 'true'); location.reload(); true`);
    }
    await sleep(1500);
    const shot = async (name) => {
      for (let i = 0; i < N; i++) writeFileSync(join(out, `${name}-${profiles[i].id}.png`), (await wins[i].webContents.capturePage()).toPNG());
    };
    const until = async (what, fn, ms = 120000) => {
      const t = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t > ms) throw new Error(`timeout: ${what}`);
        await sleep(400);
      }
    };
    const phase = (i) => ev(i, 'window.__slLink?.sessions?.state?.phase');
    const emu = (i, js) => ev(i, `(() => { const f = document.querySelector('iframe[src^="/playernative.html"]'); const e = f?.contentWindow?.__emu; return e ? (${js}) : null; })()`);
    const seamless = flag('seamless');
    // frame strips: the window, as fast as it can be captured, while the game switches into / out of the link session
    const strip = (i, name, ms) => (async () => {
      const t = Date.now();
      for (let k = 0; Date.now() - t < ms; k++) {
        const img = await wins[i].webContents.capturePage();
        writeFileSync(join(out, `strip-${name}-${profiles[i].id}-${String(k).padStart(3, '0')}-${Date.now() - t}ms.png`), img.toPNG());
      }
    })();
    const linked = () => until('every page and the peer links', async () => {
      for (const i of every) for (const s of SLOTS) if (s !== SLOTS[i] && !(await ev(i, `window.__slLink?.sync?.linkDirect(${JSON.stringify(s)})`))) return false;
      return true;
    }, 300000);
    const everyone = async (fn) => { for (const i of all) if (!(await fn(i))) return false; return true; };
    /** A page's run document (the doc the page holds – what it synced from the others too). */
    const docOf = async (i) => JSON.parse(await ev(i, `(() => { const L = window.__slLink?.sync?.doc; if (!L) return null; return JSON.stringify(L.scan(''), (k, v) => v); })()`) || 'null');
    /** The wager game key of a ROM file (shared/linkbattle.mjs › GAMES), from its header – null for one without wagers. */
    const gameOfRom = (file) => {
      const b = readFileSync(file);
      const system = /\.nds$/i.test(file) ? 'nds' : /\.gba$/i.test(file) ? 'gba' : 'gb';
      const { addr, len } = headerRange(system);
      const at = system === 'gba' ? addr - 0x08000000 : system === 'nds' ? 0 : addr;
      return gameOf(system, b.subarray(at, at + len));
    };
    /** Gen 3 money in a battery save: SaveBlock1 (sections 1–4) +0x490 – Emerald XORs it with SaveBlock2's key (+0xAC). */
    const saveMoney3 = (b) => {
      const slot = (o) => ({ o, idx: b.readUInt32LE(o + 0xffc) });
      const newest = [slot(0), slot(0xe000)].sort((x, y) => y.idx - x.idx)[0].o;
      const sec = {};
      for (let k = 0; k < 14; k++) sec[b.readUInt16LE(newest + k * 0x1000 + 0xff4)] = newest + k * 0x1000;
      const sb1 = Buffer.concat([1, 2, 3, 4].map((id) => b.subarray(sec[id], sec[id] + 0xf80)));
      return { money: sb1.readUInt32LE(0x490), key: b.readUInt32LE(sec[0] + 0xac) };
    };
    /**
     * DS money in a battery save: Gen 4 – the newer of the two general blocks (0 / 0x40000, by the footer's save
     * counter; PKHeX SAV4BlockDetection), the trainer block +0x14; Gen 5 – the misc block's first word (BW 0x21200, B2W2
     * 0x21100; PKHeX Misc5). Both games of a pair write the same layout.
     */
    const saveMoneyDS = (b, game) => {
      const g4 = { platinum: [0xcf2c, 0x14, 0x68], dp: [0xc100, 0x14, 0x64], hgss: [0xf628, 0x10, 0x64] }[game];
      if (g4) {
        const [size, foot, trainer] = g4;
        const count = (o) => b.readUInt32LE(o + size - foot);
        const c0 = count(0), c1 = count(0x40000);
        const o = c0 === 0xffffffff ? 0x40000 : c1 === 0xffffffff || c0 >= c1 ? 0 : 0x40000;
        return b.readUInt32LE(o + trainer + 0x14);
      }
      if (game === 'bw') return b.readUInt32LE(0x21200);
      if (game === 'b2w2') return b.readUInt32LE(0x21100);
      return null;
    };
    async function battleChecks() {
      const want = String(opt('winner')).split(',').sort();
      const docs = [];
      await until('every computer has every result', async () => {
        docs.length = 0;
        for (const i of all) docs.push(await docOf(i));
        return docs.every((d) => SESSION.every((s) => Object.keys(d || {}).some((k) => k.startsWith('lb:') && k.endsWith(`:${s}`))));
      }, 60000).catch(() => null);
      const outcomes = docs.map((d) => {
        const lb = Object.entries(d || {}).filter(([k]) => k.startsWith('lb:')).map(([k, v]) => [k, v?.v ?? v]);
        return { entries: lb, feed: Object.entries(d || {}).filter(([k]) => k.startsWith('feed:lb-')).map(([, v]) => v?.v ?? v) };
      });
      result.battle = outcomes.map((o) => ({ entries: o.entries.map(([k, v]) => ({ k, per: v.per, h: v.h, wager: v.wager, void: v.void || null })), log: o.feed.map((f) => f.text) }));
      const hashes = new Set(outcomes.flatMap((o) => o.entries.map(([, v]) => v.h)));
      result.checks.battleReadOnEveryComputer = outcomes.every((o) => o.entries.length === seats && o.entries.every(([, v]) => v.per && !v.void));
      result.checks.battleSameResult = hashes.size === 1 && !hashes.has(undefined);
      const per = outcomes[0].entries[0]?.[1]?.per || {};
      const winners = SESSION.filter((s) => per[s]?.w > per[s]?.l).sort();
      result.winners = winners;
      result.checks.knownWinner = JSON.stringify(winners) === JSON.stringify(want);
      result.checks.battleLogged = outcomes.every((o) => o.feed.length === 1);
      if (bystander) { // (the bystander's computer gets the result through the run's document, like every log entry)
        const d = await docOf(by);
        result.checks.bystanderSawResult = Object.keys(d || {}).filter((k) => k.startsWith('feed:lb-')).length === 1;
      }
      if (!opt('wager')) return;
      // the wager: each player's own game pays or gets it once it stands in the overworld (RAM), then saves it
      const stake = outcomes[0].entries[0]?.[1]?.wager || 0;
      result.stake = stake;
      // (each seat's game from its cartridge header, as the app tells them apart – shared/linkbattle.mjs gameOf; the money
      // read the way the play view reads it for the wager, every generation)
      const moneyNow = (i) => emu(i, `import('/shared/linkbattle.mjs').then((m) => m.readMoney(${JSON.stringify(gameOfRom(romOf(i)))}, (a, n) => e.read(a, n)))`);
      const before = result.moneyBefore = [];
      for (const i of all) before.push(Number(await moneyNow(i)));
      if (flag('reset-after')) { // (Gen 1: the Colosseum has no way out – as on the console, switch off and Continue)
        for (const i of all) await emu(i, 'e.restart()');
        await sleep(4000);
        for (const [keys, ms] of [...Array(4).fill([['start'], 1600]), ...Array(4).fill([['a'], 1600])]) {
          for (const i of all) await emu(i, `e.hold(${JSON.stringify(keys)})`);
          await sleep(150);
          for (const i of all) await emu(i, 'e.hold([])');
          await sleep(ms);
        }
        await shot(`${String(n++).padStart(2, '0')}-after-reset`);
      }
      await until('every wager paid', async () => {
        const d = await docOf(0);
        return SESSION.every((s) => !!(d?.[`lbpay:${Object.keys(d).find((k) => k.startsWith('lb:'))?.split(':')[1]}:${s}`]));
      }, 120000).catch(() => null);
      await sleep(2500);
      const after = result.moneyAfter = [];
      for (const i of all) after.push(Number(await moneyNow(i)));
      const exp = all.map((i) => (want.includes(SLOTS[i]) ? stake : -stake));
      const docEnd = await docOf(0);
      result.payments = Object.entries(docEnd || {}).filter(([k]) => k.startsWith('lbpay:') || k.startsWith('feed:lbp-')).map(([k, v]) => [k, v?.v ?? v]);
      // (the money may already be in when this looks first: each game's own record of before → after, and the RAM now)
      const paid = (s) => result.payments.find(([k]) => k.startsWith('lbpay:') && k.endsWith(`:${s}`))?.[1];
      result.checks.wagerPaidInGame = stake > 0 && all.every((i) => paid(SLOTS[i])?.after - paid(SLOTS[i])?.before === exp[i] && after[i] === paid(SLOTS[i])?.after);
      result.checks.paymentLogged = result.payments.some(([k]) => k.startsWith('feed:lbp-'));
      await shot(`${String(n++).padStart(2, '0')}-paid`);
      for (const i of all) await ev(i, `location.hash = ${JSON.stringify(`#/soullink?run=${runId}`)}; true`);
      await sleep(2500);
      await shot(`${String(n++).padStart(2, '0')}-board-record`);
      // (the head-to-head as the session left it: one battle 1 : 0, several "2 : 0" …)
      const score = per[want[0]] ? `${Math.max(per[want[0]].w, per[want[0]].l)} : ${Math.min(per[want[0]].w, per[want[0]].l)}` : '1 : 0';
      const [hi, lo] = score.split(' : ');
      result.checks.recordOnBoard = await everyone(async (i) => new RegExp(`${hi} : ${lo}|${lo} : ${hi}`).test(String(await ev(i, `document.querySelector('.h2h')?.textContent || ''`))));
      for (const i of all) await ev(i, `location.hash = ${JSON.stringify(`#/play?run=${runId}`)}; true`);
      await sleep(3000);
      if (!flag('save-after')) return;
      // an in-game save – Gen 3: START, (the menu remembers SAVE), A, YES, YES; HG/SS and Gen 5: SAVE and YES on the
      // touch screen (after a tap the game's first A only brings the cursor back). Every wait counts the game's own
      // frames: with the computer busy the games run slower than real time, and a press timed by the clock lands while
      // the question is still being written out – then nothing is saved and the run never gets the money
      const waitFrames = async (i, n) => {
        const end = (Number(await emu(i, 'e.frames()')) || 0) + n;
        for (let k = 0; k < 6000 && (Number(await emu(i, 'e.frames()')) || 0) < end; k++) await sleep(20);
      };
      const savedBefore = [];
      for (const i of all) savedBefore.push(sha(Buffer.from(await fetch(`${profiles[i].base}/api/runs/${runId}/save/${SLOTS[i]}`, APP).then((r) => r.arrayBuffer()))));
      for (const i of all) {
        const g = gameOfRom(romOf(i));
        const gen5 = ['black', 'white', 'black2', 'white2'].includes(g);
        // (HeartGold/SoulSilver: the menu stays on the touch screen – SAVE where the recordings' saves have it, with
        // Pokémon, Bag and Pokégear and no Pokédex yet; then YES and YES to overwrite)
        const steps = g === 'hgss'
          ? [['touch', 124, 76], [[], 240], ['touch', 232, 98], [[], 240], ['touch', 232, 98], [[], 1500]]
          : gen5
          ? [[['x'], 8], [[], 90], ['touch', 65, 141], [[], 240], ['touch', 225, 60], [[], 900], [['b'], 8], [[], 60]]
          : [[['start'], 8], [[], 54], [['a'], 8], [[], 90], [['a'], 8], [[], 90], [['a'], 8], [[], 360], [['a'], 8], [[], 72], [['b'], 8], [[], 36]];
        for (const [keys, a, b] of steps) {
          if (keys === 'touch') { // (the stylus on the bottom screen at (a, b): down for a few frames, then up)
            const x = a / 256;
            const y = (192 + b) / 384;
            await emu(i, `e.touch(${x}, ${y}, true)`);
            await waitFrames(i, 8);
            await emu(i, `e.touch(${x}, ${y}, false)`);
            continue;
          }
          await emu(i, `e.hold(${JSON.stringify(keys)})`);
          await waitFrames(i, a);
        }
      }
      // (the battery save settles, then the play view writes it into the run)
      await until('every save in the run', () => everyone(async (i) => sha(Buffer.from(await fetch(`${profiles[i].base}/api/runs/${runId}/save/${SLOTS[i]}`, APP).then((r) => r.arrayBuffer()))) !== savedBefore[i]), 120000).catch(() => null);
      await sleep(3000);
      const savedMoney = [];
      for (const i of all) {
        const pr = profiles[i];
        const b = Buffer.from(await fetch(`${pr.base}/api/runs/${runId}/save/${SLOTS[i]}`, APP).then((r) => r.arrayBuffer()));
        const g = gameOfRom(romOf(i));
        if (/\.nds$/i.test(romOf(i))) {
          savedMoney.push(saveMoneyDS(b, ['black', 'white'].includes(g) ? 'bw' : ['black2', 'white2'].includes(g) ? 'b2w2' : g));
          continue;
        }
        const m = saveMoney3(b);
        savedMoney.push(g === 'emerald' ? (m.money ^ m.key) >>> 0 : m.money); // (Emerald XORs it; R/S don't)
      }
      result.moneyInSaves = savedMoney;
      result.checks.wagerInSaves = all.every((i) => savedMoney[i] === after[i]);
      const docSaved = await docOf(0);
      result.checks.paymentMarkedSaved = SESSION.every((s) => Object.entries(docSaved || {}).some(([k, v]) => k.startsWith('lbpay:') && k.endsWith(`:${s}`) && (v?.v ?? v)?.status === 'saved'));
      await shot(`${String(n++).padStart(2, '0')}-saved`);
    }
    await linked();
    log('peer link up');
    await shot('01-board');

    if (seamless) { // every player is playing: their own game in the fast player, at the recorded moment, paused there
      for (const i of all) await ev(i, `location.hash = ${JSON.stringify(`#/play?run=${runId}`)}; true`);
      await until('every fast player shows a picture', () => everyone((i) => emu(i, 'e.ready')), 120000);
      for (const i of all) {
        const file = opt(`state${i + 1}`);
        if (!file) continue;
        const z = deflateRawSync(readFileSync(file)).toString('base64');
        const ok = await emu(i, `(async () => { e.pause(); const b = Uint8Array.from(atob(${JSON.stringify(z)}), (c) => c.charCodeAt(0));
          const s = new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))); return e.loadState(new Uint8Array(await s.arrayBuffer())); })()`);
        if (!ok) throw new Error(`${profiles[i].id}: the mid-game state didn't load`);
        // (--prestep k: the state is k frames before the recording's start, k frames with nothing pressed run here – the
        // picture is then the game's, not the one from before the state was loaded)
        if (Number(opt('prestep', '0')) > 0) await emu(i, `e.step(${Number(opt('prestep'))})`);
      }
      if (flag('continue')) { // (no state: every game boots from its save – through the title screen into the game first)
        await sleep(4000);
        for (const [keys, ms] of [...Array(4).fill([['start'], 1600]), ...Array(4).fill([['a'], 1600])]) {
          for (const i of all) await emu(i, `e.hold(${JSON.stringify(keys)})`);
          await sleep(150);
          for (const i of all) await emu(i, 'e.hold([])');
          await sleep(ms);
        }
        await sleep(2000);
      }
      if (bystander) { // the bystander plays their own game meanwhile (from its state, if given – else it boots from the save)
        await ev(by, `location.hash = ${JSON.stringify(`#/play?run=${runId}`)}; true`);
        await until('the bystander\'s fast player shows a picture', () => emu(by, 'e.ready'), 120000);
        if (opt(`state${by + 1}`)) {
          const z = deflateRawSync(readFileSync(opt(`state${by + 1}`))).toString('base64');
          await emu(by, `(async () => { const b = Uint8Array.from(atob(${JSON.stringify(z)}), (c) => c.charCodeAt(0));
            const s = new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))); return e.loadState(new Uint8Array(await s.arrayBuffer())); })()`);
        }
      }
      // (a mark in each player page: still there after the session = the page and its canvas never reloaded)
      for (const i of all) await ev(i, `document.querySelector('iframe[src^="/playernative.html"]').contentWindow.__e2eMark = 'm${i}'; true`);
      await sleep(1500);
      await shot('01b-playing');
      // where the game's picture is in each window (for cropping the frame strips)
      result.frameRect = [];
      for (const i of all) result.frameRect.push(JSON.parse(await ev(i, `JSON.stringify((() => { const r = document.querySelector('iframe[src^="/playernative.html"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio }; })())`)));
      result.checks.ownGamesRunning = await everyone((i) => ev(i, 'window.__slLink.sessions.ownGame()'));
      if (flag('engine')) { // (every game in the souldew engine, alone: the process the link will join)
        result.engineIds = [];
        for (const i of all) result.engineIds.push((await api(profiles[i], '/api/native/status')).session?.id || null);
        result.checks.engineAlone = await everyone(async (i) => (await emu(i, 'e.perf().info?.engine === true && e.perf().info?.mode === "solo"')) === true);
      }
    }

    // ---- invite, join (and the partner's game, when it's another file) -------------------------------------------------
    const stripIn = seamless ? strip(0, 'in', 6000) : null;
    const wagerOpts = opt('wager') ? { wager: Number(opt('wager')), format: opt('format', null) } : {};
    if (opt('wager') && !seamless) { // the challenge on the board: format and wager (a picture of it – the invite is sent below)
      await ev(0, `(() => { const b = [...document.querySelectorAll('.link-buttons button')].find((x) => /Battle/.test(x.textContent)); b?.click(); return !!b; })()`);
      await sleep(700);
      await ev(0, `(() => { const c = document.querySelector('.battle-setup input[type=checkbox]'); c?.click(); return !!c; })()`);
      await sleep(500);
      await shot('01c-challenge');
      await ev(0, `(() => { const b = [...document.querySelectorAll('.battle-setup button')].find((x) => /Cancel/.test(x.textContent)); b?.click(); return !!b; })()`);
    }
    await ev(0, `window.__slLink.sessions.invite(${JSON.stringify(kind)}, ${JSON.stringify(SESSION.slice(1))}, ${JSON.stringify(wagerOpts)})`);
    await until('invite arrives', () => everyone(async (i) => !i || (await phase(i)) === 'invited'));
    if (bystander) { // (the invite names its seats: the bystander's page shows nothing)
      await sleep(1500);
      result.bystanderPhases = [await phase(by)];
      result.checks.bystanderNotInvited = !['invited', 'preparing', 'running'].includes(result.bystanderPhases[0]);
    }
    await shot('02-invited');
    if (seamless && flag('desync') && opt('desync-state')) {
      // (out of step on purpose: B's host gets another state for A's seat than A's host has – the hashes differ from
      // frame 120 on. Test-only, in B's page: the snap it received for p1 is swapped for that file before its host starts)
      const other = readFileSync(opt('desync-state'));
      const z = deflateRawSync(other).toString('base64');
      await ev(1, `(() => { const L = window.__slLink.sessions; const start = L._start.bind(L); L._start = (...a) => {
        const st = L.state; st.snaps.p1 = { sha1: ${JSON.stringify(sha(other))}, z: ${JSON.stringify(z)} }; st.saves.p1.state = ${JSON.stringify(sha(other))}; return start(...a); }; return true; })()`);
    }
    for (const i of all.slice(1)) await ev(i, 'window.__slLink.sessions.accept()');
    if (flag('other-release')) {
      // each side lacks the other's file: the bar asks to pick it; a wrong file is refused by SHA-1, the right one taken
      await until('A asks for B\'s game', async () => (await phase(0)) === 'need', 60000);
      await until('B asks for A\'s game', async () => (await phase(1)) === 'need', 60000);
      await sleep(800);
      await shot('03-pick-your-copy');
      const wrong = await api(A, '/api/link/pick', { runId, slot: 'p2', sha1: '0'.repeat(40), romId: (await api(A, '/api/library')).roms[0].id }).then(() => 'taken', (e) => e.status);
      result.checks.wrongFileRefused = wrong === 409;
      for (const [pr, file, i] of [[A, rom2, 0], [B, rom1, 1]]) {
        const bytes = readFileSync(file);
        const name = `${basename(file, extname(file))} (copy)${extname(file)}`;
        await fetch(`${pr.base}/api/library/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: bytes });
        const lib = await api(pr, '/api/library');
        const it = lib.roms.find((r) => r.name?.includes('(copy)') || r.file?.includes('(copy)'));
        await ev(i, `window.__slLink.sessions.pickRom("${i ? 'p1' : 'p2'}", ${JSON.stringify(it.id)})`);
      }
      result.checks.pickedBySha1 = true;
    }
    await until('everybody running', () => everyone(async (i) => (await phase(i)) === 'running'), 120000);
    if (seamless && flag('engine')) { // the partners joined each game in its own process: the same session, now linked
      const ids = [];
      for (const i of all) ids.push((await api(profiles[i], '/api/native/status')).session?.id || null);
      result.checks.linkedInPlace = ids.every((x, i) => x && x === result.engineIds[i])
        && (await everyone(async (i) => (await emu(i, 'e.perf().info?.mode')) === 'link'));
    }
    const st0 = JSON.parse(await ev(0, 'JSON.stringify(window.__slLink.sessions.state)'));
    log('running: delay', st0.delay, 'rtt', st0.rtt);
    result.delay = st0.delay;
    await until('pictures', () => everyone((i) => emu(i, 'e.ready')), 90000);
    if (seamless) {
      await until('every picture switched to the link session', () => everyone(async (i) => (await emu(i, 'e.switches().length')) >= 1), 60000);
      result.seamlessStart = [];
      for (const i of all) result.seamlessStart.push({ player: profiles[i].id, seamless: await ev(i, 'window.__slLink.sessions.state.seamless'), switch: await emu(i, 'e.switches()[0]'), snap: await ev(i, 'window.__slLink.sessions.stats.snap') });
      log('seamless start', JSON.stringify(result.seamlessStart));
      result.checks.startedFromRunningGames = result.seamlessStart.every((x) => x.seamless && x.switch?.to === 'link');
      result.checks.samePlayerPage = await everyone(async (i) => (await ev(i, `document.querySelector('iframe[src^="/playernative.html"]')?.contentWindow?.__e2eMark`)) === `m${i}`);
      await stripIn;
    }
    await sleep(2500); // (sound only comes at normal speed)
    result.checks.sound = await everyone(async (i) => Number(await emu(i, 'e.perf().audioIn')) > 0);
    const speed = Number(opt('speed', '6'));
    // faster than real time, and every host stops exactly where the recording ends (UNTIL: the same frame everywhere)
    const setSpeed = async (i) => {
      const id = await ev(i, 'window.__slLink.sessions.state.id');
      const b = Buffer.alloc(24);
      b.writeUInt32LE(2, 0), b.writeUInt32LE(4, 4), b.writeFloatLE(speed, 8);
      b.writeUInt32LE(24, 12), b.writeUInt32LE(4, 16), b.writeUInt32LE(frames, 20);
      await fetch(`${profiles[i].base}/api/native/cmd?id=${id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: b });
    };
    for (const i of all) await setSpeed(i);
    await sleep(1500);
    await shot('04-linked');
    const route = await ev(0, 'JSON.stringify(window.__slLink.sessions.state.route)');
    result.route = JSON.parse(route || '{}');
    if (bystander) { // the bystander, while the others are linked: still outside; asking A to trade gets "in another link"
      result.bystanderPhases.push(await phase(by));
      const f0 = seamless ? Number(await emu(by, 'e.frames()')) || 0 : 0;
      // what the bystander's page knows: the linked players' own announcement – on the board, right on their cards
      // ("In a link with …"), with Trade / Battle greyed out and that as their hint (the play view: the Shared World menu)
      const cards = await until('the bystander sees who is linked', async () => {
        const c = JSON.parse(await ev(by, bystanderCards(SESSION)));
        return SESSION.every((s) => c[s].known) ? c : null;
      }, 15000).catch(async () => JSON.parse(await ev(by, bystanderCards(SESSION))));
      result.bystanderCards = cards;
      const nameOf = (s) => profiles[SLOTS.indexOf(s)].name;
      result.checks.bystanderKnowsLinked = SESSION.every((s) => JSON.stringify(cards[s].known?.seats) === JSON.stringify(SESSION));
      if (!seamless) {
        result.checks.bystanderCardSaysLinked = SESSION.every((s) => SESSION.filter((x) => x !== s).every((x) => cards[s].tag?.includes(nameOf(x)))
          && cards[s].buttons.length > 0 && cards[s].buttons.every((b) => b.disabled && b.title === cards[s].tag));
      }
      await shot('04b-bystander-during');
      await ev(by, `window.__slLink.sessions.invite('trade', ['p1']).then(() => true, (e) => String(e?.message || e))`);
      const refused = await until('the bystander hears "busy"', async () => ((await phase(by)) === 'ended' ? JSON.parse(await ev(by, 'JSON.stringify(window.__slLink.sessions.state.ended)')) : null), 30000).catch(() => null);
      result.bystanderInvite = refused;
      result.checks.bystanderToldBusy = refused?.reason === 'busy';
      result.checks.sessionUnaffected = await everyone(async (i) => (await phase(i)) === 'running');
      await sleep(1200);
      await shot('04c-bystander-busy');
      if (seamless) { // their own game went on the whole time: frames advanced, never switched to a link session
        await sleep(1500);
        result.checks.bystanderGameRunsOn = (Number(await emu(by, 'e.frames()')) || 0) - f0 > 60 && Number(await emu(by, 'e.switches().length')) === 0;
      }
    }

    // ---- run the recording to its end ----------------------------------------------------------------------------------
    const shots = String(opt('shots', '')).split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
    const rejoinAt = Number(opt('rejoin', '0'));
    const dropAt = Number(opt('disconnect', '0')); // (B's peer link goes down at that frame: both leave, each goes on alone)
    const frameOf = async (i) => Number(await emu(i, 'e.frames()')) || 0;
    let n = 5;
    for (const target of [...new Set([...shots, rejoinAt, dropAt, frames].filter((x) => x > 0))].sort((a, b) => a - b)) {
      await until(`frame ${target}`, async () => {
        if (flag('desync') && (await phase(0)) === 'ended') return true;
        return everyone(async (i) => (await frameOf(i)) >= target);
      }, Math.max(300000, ((target - (await frameOf(0))) / 60 / Math.max(1, speed)) * 4000 + 120000));
      if (flag('desync') && (await phase(0)) === 'ended') break;
      if (target === dropAt) {
        log('disconnect: B\'s peer link goes down at frame', await frameOf(1));
        await ev(1, 'window.__slLink.sync.stop(); true');
        await sleep(3000);
        result.checks.bothStalled = (await frameOf(0)) - dropAt < 600 && (await frameOf(1)) - dropAt < 600; // (each host waits for the other's buttons)
        await shot(`${String(n++).padStart(2, '0')}-disconnected`);
        break;
      }
      if (target === rejoinAt) {
        log('rejoin test: B\'s page reloads at frame', await frameOf(1));
        await shot(`${String(n++).padStart(2, '0')}-before-drop`);
        wins[1].webContents.reload();
        await sleep(4000);
        await linked();
        await until('B offers to rejoin', async () => (await phase(1)) === 'rejoinable', 60000);
        await shot(`${String(n++).padStart(2, '0')}-rejoin-offer`);
        const waitA = await ev(0, 'JSON.stringify(window.__slLink.sessions.state.waiting)');
        result.checks.aWaitedForB = !!JSON.parse(waitA || 'null');
        await ev(1, 'window.__slLink.sessions.rejoin()');
        await until('B running again', async () => (await phase(1)) === 'running', 120000);
        await until('B\'s picture', async () => emu(1, 'e.ready'), 60000);
        await setSpeed(1);
        result.checks.rejoined = true;
        log('rejoined at frame', await frameOf(1));
        await sleep(1500);
        await shot(`${String(n++).padStart(2, '0')}-rejoined`);
        continue;
      }
      log('frame', target, 'stats A', await ev(0, 'JSON.stringify(window.__slLink.sessions.stats)'));
      await shot(`${String(n++).padStart(2, '0')}-frame-${target}`);
    }
    const stats = [];
    for (const i of all) stats.push(JSON.parse(await ev(i, 'JSON.stringify(window.__slLink.sessions.stats)')));
    result.stats = stats;
    log('stats', JSON.stringify(stats));

    if (flag('desync')) {
      await until('the desync ends the session on both', async () => (await phase(0)) === 'ended' && (await phase(1)) === 'ended', 120000);
      const ended = [JSON.parse(await ev(0, 'JSON.stringify(window.__slLink.sessions.state.ended)')), JSON.parse(await ev(1, 'JSON.stringify(window.__slLink.sessions.state.ended)'))];
      result.ended = ended;
      await sleep(3000);
      await shot(`${String(n++).padStart(2, '0')}-desync`);
      const saves = [Buffer.from(await fetch(`${A.base}/api/runs/${runId}/save/p1`, APP).then((r) => r.arrayBuffer())), Buffer.from(await fetch(`${B.base}/api/runs/${runId}/save/p2`, APP).then((r) => r.arrayBuffer()))];
      result.checks.desyncDetected = ended.every((e) => e?.reason === 'linkDesync');
      result.checks.savesBackToBefore = sha(saves[0]) === pre.A && sha(saves[1]) === pre.B;
      result.checks.backupsKept = ended.every((e) => !!e?.restored?.backup);
      if (seamless) { // out of step: each game goes back to where it was before the link – and goes on from there, alone
        result.checks.backToBeforeTheLink = ended.every((e) => e?.resumed === true);
        result.checks.wentOnAlone = await everyone(async (i) => (await emu(i, 'e.perf().core')) !== 'link' && (await emu(i, 'e.switches().at(-1)?.to')) === 'solo');
        result.checks.samePlayerPageAfter = await everyone(async (i) => (await ev(i, `document.querySelector('iframe[src^="/playernative.html"]')?.contentWindow?.__e2eMark`)) === `m${i}`);
      if (flag('engine')) { // each game alone again in the same process (no new player was started)
        const ids = [];
        for (const i of all) ids.push((await api(profiles[i], '/api/native/status')).session?.id || null);
        result.checks.aloneInPlace = ids.every((x, i) => x && x === result.engineIds[i])
          && (await everyone(async (i) => (await emu(i, 'e.perf().info?.mode')) === 'solo'));
      }
      }
      log('desync', JSON.stringify(result.checks));
      return finish(Object.values(result.checks).every(Boolean) ? 0 : 1);
    }

    // ---- leave: both hosts stop, the last battery saves are in the run ---------------------------------------------------
    await sleep(2500);
    const stripOut = seamless ? strip(0, 'out', 6000) : null;
    await ev(0, 'window.__slLink.sessions.leave("left")');
    if (dropAt) await ev(1, 'window.__slLink.sessions.leave("left")'); // (A's bye can't reach B any more: B leaves too)
    await until('everybody ended', () => everyone(async (i) => (await phase(i)) === 'ended'), 60000);
    if (seamless) { // each game goes on alone from where the session left it – the same page, no reboot
      await until('every game going on alone', () => everyone(async (i) => (await emu(i, 'e.switches().length')) >= 2), 60000);
      result.seamlessEnd = [];
      await sleep(800); // (the fast player's first frame count comes four times a second – the link host's last one before)
      for (const i of all) {
        const f1 = Number(await emu(i, 'e.frames()')) || 0;
        await sleep(1500);
        const f2 = Number(await emu(i, 'e.frames()')) || 0;
        result.seamlessEnd.push({ player: profiles[i].id, resumed: await ev(i, 'window.__slLink.sessions.state.ended?.resumed'), switch: await emu(i, 'e.switches().at(-1)'),
          core: await emu(i, 'e.perf().core'), framesAdvance: f2 - f1, sessionOpen: await ev(i, 'location.hash') });
      }
      log('seamless end', JSON.stringify(result.seamlessEnd));
      result.checks.wentOnAlone = result.seamlessEnd.every((x) => x.resumed && x.switch?.to === 'solo' && x.core !== 'link' && x.framesAdvance > 30);
      result.checks.samePlayerPageAfter = await everyone(async (i) => (await ev(i, `document.querySelector('iframe[src^="/playernative.html"]')?.contentWindow?.__e2eMark`)) === `m${i}`);
      if (flag('engine')) { // each game alone again in the same process (no new player was started)
        const ids = [];
        for (const i of all) ids.push((await api(profiles[i], '/api/native/status')).session?.id || null);
        result.checks.aloneInPlace = ids.every((x, i) => x && x === result.engineIds[i])
          && (await everyone(async (i) => (await emu(i, 'e.perf().info?.mode')) === 'solo'));
      }
      await stripOut;
    }
    await sleep(4000);
    await shot(`${String(n++).padStart(2, '0')}-left`);
    const saves = [];
    for (const i of all) saves.push(Buffer.from(await fetch(`${profiles[i].base}/api/runs/${runId}/save/${SLOTS[i]}`, APP).then((r) => r.arrayBuffer())));
    saves.forEach((b, i) => writeFileSync(join(out, `after-${profiles[i].id}.sav`), b));
    if (together) { // the session's save is the library game's: what the player finds when they play it alone later
      const libSaves = [];
      for (const i of all) libSaves.push(Buffer.from(await fetch(`${profiles[i].base}/api/saves/solo?id=${encodeURIComponent(libIds[i])}`, APP).then((r) => r.arrayBuffer())));
      result.checks.librarySaveHasSession = all.every((i) => libSaves[i].equals(saves[i]) && sha(libSaves[i]) !== pre[profiles[i].id]);
      // the board's view of the pair (views/playtogether.mjs): who can trade, battle, see whom
      result.boardPairs = await ev(0, `[...document.querySelectorAll('.pt-pair-list li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`).catch(() => null);
    }
    if (seamless) { // and A plays on (after the saves were taken): a few buttons – close a text box, walk – alone now
      const stripPlay = strip(0, 'play', 4000);
      for (const [keys, ms] of [[['a'], 150], [[], 700], [['a'], 150], [[], 700], [['b'], 150], [[], 400], [['down'], 1200], [[], 300]]) {
        await emu(0, `e.hold(${JSON.stringify(keys)})`);
        await sleep(ms);
      }
      await stripPlay;
      await shot(`${String(n++).padStart(2, '0')}-playing-on`);
    }
    result.checks.noMismatch = stats.every((s) => !s.mismatch);
    result.checks.hashesCompared = stats.every((s) => (s.hashes || 0) > 10);
    if (opt('expect')) {
      const exp = all.map((i) => readFileSync(join(opt('expect'), `seat${i}.sav`)));
      // (a Game Boy clock cartridge's save carries its clock footer: the battery RAM must match, the clock is real time)
      const cut = (b, e) => b.subarray(0, e.length);
      result.checks.savesAsRecorded = all.every((i) => cut(saves[i], exp[i]).equals(exp[i]));
      result.savesChanged = all.map((i) => sha(saves[i]) !== pre[profiles[i].id]);
    }
    // the run's log on both computers: the trade entry (web/lib/run.mjs logLinkTrade)
    await sleep(3000);
    if (opt('winner')) await battleChecks();
    if (kind === 'trade' && !dropAt) { // (a session cut off before the trade has none to log)
      const trades = [];
      for (const pr of profiles) { // (the bystander's computer too: the log is the run's)
        const doc = await api(pr, `/api/runs/${runId}/doc`).catch(() => null);
        for (const [k, v] of Object.entries(doc?.entries || doc || {})) if (k.startsWith('feed:') && JSON.stringify(v).includes('"trade"')) trades.push({ on: pr.id, entry: v.v ?? v });
      }
      result.trades = trades;
      // (what the trade's log entry is made of: the first and the last team each page saw during the session)
      result.tradeTeams = [];
      for (const i of all) result.tradeTeams.push(JSON.parse(await ev(i, `JSON.stringify(['partyFirst', 'partyLast'].map((k) => (window.__slLink.sessions[k] || []).map((m) => \`\${m.key}:\${m.species}\`)))`)));
      result.checks.tradeLogged = trades.length > 0;
      if (bystander) result.checks.bystanderSawTrade = trades.some((x) => x.on === profiles[by].id);
    }
    if (bystander) { // after the session: the bystander's page is still fine, and was never part of it
      result.bystanderPhases.push(await phase(by));
      // …and the linked players' cards are back to normal: no "In a link with …", Trade / Battle open again
      const after = await until('the bystander sees the link ended', async () => {
        const c = JSON.parse(await ev(by, bystanderCards(SESSION)));
        return SESSION.every((s) => !c[s].known && !c[s].tag) ? c : null;
      }, 20000).catch(async () => JSON.parse(await ev(by, bystanderCards(SESSION))));
      result.bystanderCardsAfter = after;
      result.checks.bystanderLinkedCleared = SESSION.every((s) => !after[s].known && !after[s].tag && (seamless || after[s].buttons.some((b) => !b.disabled)));
      if (!seamless) await shot(`${String(n++).padStart(2, '0')}-bystander-after`);
      result.checks.bystanderNeverLinked = !(await ev(by, 'window.__slLink.sessions.state.seamless')) && (!seamless || Number(await emu(by, 'e.switches().length')) === 0);
      result.bystanderErrors = (result.console || []).filter((x) => x.startsWith(`${profiles[by].id} error:`));
    }
    log('checks', JSON.stringify(result.checks));
    finish(Object.values(result.checks).every(Boolean) ? 0 : 1);
  } catch (e) {
    console.error(e);
    result.error = String(e?.stack || e);
    try { // where every page's session stood
      result.pages = [];
      for (const w of BrowserWindow.getAllWindows()) {
        result.pages.push(await w.webContents.executeJavaScript(`(() => { const L = window.__slLink?.sessions; if (!L) return null; const st = L.state;
          return { phase: st.phase, ended: st.ended, saves: Object.fromEntries(Object.entries(st.saves || {}).map(([k, v]) => [k, { b64: typeof v.b64, state: v.state }])),
            snaps: Object.fromEntries(Object.entries(st.snaps || {}).map(([k, v]) => [k, { sha1: v.sha1, z: typeof v.z, got: v.got }])), ready: st.ready, got: st.got, stats: L.stats }; })()`, true));
      }
    } catch { /* the windows are gone */ }
    try {
      for (const [i, w] of BrowserWindow.getAllWindows().entries()) writeFileSync(join(out, `fail-${i}.png`), (await w.webContents.capturePage()).toPNG());
    } catch { /* no windows */ }
    finish(1);
  }
}
