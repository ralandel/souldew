// A remote control for ONE player in the real app (dev tool, like scripts/link-drive.mjs for the link host): a souldew
// server with a scratch data folder, a run of one game with a battery save in it, its play view in Electron (muted) –
// and a tiny HTTP API on 127.0.0.1 to press buttons, tap the DS touch screen with a real mouse click, take screenshots
// and read the run's save. For checking by hand what a player does in a game (an in-game save, a menu) in the fast
// player – solo, outside any link. Never commit ROMs, saves or screenshots.
//
//   node scripts/app-drive.mjs --rom <game> --save <battery.sav> --data <scratch dir> [--port 7461] [--ctl 7462]
//        [--engine] [--state <fast player state>] [--show]
//
//   GET /press?keys=a,x&ms=120          hold game buttons (as a controller does) for ms, then let go (&f=8: for 8 of the
//                                       game's frames instead – every wait takes f=, the same whatever speed the game runs)
//   GET /key?code=KeyZ&ms=120           a real key press in the player's window (Settings › Controls: Z = A, A = X …)
//   GET /tap?x=65&y=141&ms=150          a real mouse click on the DS touch screen at (x, y) of the bottom screen (256×192)
//   GET /touch?x=65&y=141&ms=150        the test hook instead (__emu.touch) – what scripts/link-e2e.mjs uses
//   GET /wait?ms=1000 | ?f=60
//   GET /shot?file=x.png                the app window
//   GET /save                           the run's save as the app keeps it: { sha1, size, at }
//   GET /eval?js=…                      in the play view
//   GET /emu?js=…                       with e = the player's __emu
//   GET /quit
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, constants as fsConstants } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
  app.setPath('userData', join(resolve(opt('data')), 'electron'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(main);
}

async function main() {
  const { app, BrowserWindow } = await import('electron');
  const data = resolve(opt('data'));
  const port = Number(opt('port', '7461'));
  const ctl = Number(opt('ctl', String(port + 1)));
  const rom = resolve(opt('rom'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = join(data, 'profile');
  const lib = join(dir, 'roms');
  mkdirSync(lib, { recursive: true });
  copyFileSync(rom, join(lib, basename(rom)), fsConstants.COPYFILE_FICLONE);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'Sam', libraryFolders: [lib], bootAnimation: false, sounds: false, nativeCore: true, nativeEngine: flag('engine') }));
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLS_DATA_DIR: dir, PORT: String(port), NO_OPEN: '1', SLS_E2E: '1', SOULDEW_LINK_ICE: 'off' };
  const server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  const quit = () => {
    server.kill();
    app.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, quit);
  const api = async (path, body, method) => {
    const r = await fetch(base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-soullink': '1', ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : Buffer.from(await r.arrayBuffer());
  };
  for (let i = 0; i < 150; i++) { try { await api('/api/status'); break; } catch { await sleep(200); } }
  const libNow = await api('/api/library');
  const own = libNow.roms.find((r) => basename(r.file || '') === basename(rom)) || libNow.roms[0];
  const built = await api('/api/runs/build', { romId: own.id, randomize: false, mode: 'soullink', players: { p1: { name: 'Sam' }, p2: { name: 'Tim' } }, buildFor: ['p1'], gameId: own.gameId, name: 'Drive', rules: {} });
  const runId = built.manifest.id;
  if (opt('save')) await api(`/api/runs/${runId}/save/p1`, new Uint8Array(readFileSync(resolve(opt('save')))), 'PUT');
  const win = new BrowserWindow({ width: 1100, height: 780, show: flag('show'), webPreferences: { partition: 'app-drive', backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  const logs = [];
  win.webContents.on('console-message', (e) => logs.push(`${e.level}: ${String(e.message).slice(0, 400)}`));
  await win.loadURL(`${base}/#/soullink?run=${runId}`);
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  await ev(`localStorage.setItem(${JSON.stringify(`sl-me-${runId}`)}, ${JSON.stringify(JSON.stringify('p1'))}); true`);
  await win.loadURL(`${base}/#/play?run=${runId}`);
  await ev('location.reload(); true');
  const FRAME = 'document.querySelector(\'iframe[src^="/playernative.html"]\')';
  const emu = (js) => ev(`(() => { const f = ${FRAME}; const e = f?.contentWindow?.__emu; return e ? (${js}) : null; })()`);
  for (let i = 0; i < 300 && !(await emu('e.ready').catch(() => null)); i++) await sleep(400);
  if (opt('state')) await emu(`e.loadState(new Uint8Array(${JSON.stringify([...readFileSync(resolve(opt('state')))])}))`);
  console.log(`app-drive: run ${runId}, the page on ${base}, control on http://127.0.0.1:${ctl}`);

  // a point of the bottom screen (256×192) → the window's coordinates (the iframe's canvas, the screens stacked or side
  // by side as the player lays them out)
  const where = async (x, y) => JSON.parse(await ev(`(() => { const f = ${FRAME}; const fr = f.getBoundingClientRect();
    const c = f.contentDocument.querySelector('canvas'); const r = c.getBoundingClientRect();
    const side = r.width / r.height > 1.5; const fx = side ? 0.5 + ${x} / 512 : ${x} / 256; const fy = side ? ${y} / 192 : (192 + ${y}) / 384;
    return JSON.stringify({ x: Math.round(fr.left + r.left + fx * r.width), y: Math.round(fr.top + r.top + fy * r.height), side }); })()`));
  // (wall-clock waits break when the computer is busy and the game runs slower: f=<frames> waits for the game's frames)
  const frames = async () => Number(await emu('e.frames()')) || 0;
  const hold = async (q) => {
    if (q('f')) {
      const end = (await frames()) + Number(q('f'));
      for (let i = 0; i < 3000 && (await frames()) < end; i++) await sleep(15);
    } else await sleep(Number(q('ms', 120)));
  };
  const keyOf = (code) => (/^Key[A-Z]$/.test(code) ? code[3] : code === 'Enter' ? 'Return' : code.replace(/^Arrow/, ''));

  createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = (k, d) => u.searchParams.get(k) ?? d;
    let out = 'ok';
    try {
      if (u.pathname === '/press') {
        await emu(`e.hold(${JSON.stringify(q('keys', '').split(',').filter(Boolean))})`);
        await hold(q);
        await emu('e.hold([])');
      } else if (u.pathname === '/key') {
        const keyCode = keyOf(q('code'));
        win.webContents.focus();
        await ev(`${FRAME}.contentWindow.focus(); true`);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        await hold(q);
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      } else if (u.pathname === '/tap') {
        const p = await where(Number(q('x')), Number(q('y')));
        win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await hold(q);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        out = JSON.stringify(p);
      } else if (u.pathname === '/touch') {
        const x = Number(q('x')) / 256;
        const y = (192 + Number(q('y'))) / 384;
        await emu(`e.touch(${x}, ${y}, true)`);
        await hold(q);
        await emu(`e.touch(${x}, ${y}, false)`);
      } else if (u.pathname === '/wait') await hold((k, d) => (k === 'ms' ? q('ms', 1000) : q(k, d)));
      else if (u.pathname === '/shot') writeFileSync(resolve(q('file')), (await win.webContents.capturePage()).toPNG());
      else if (u.pathname === '/save') {
        const b = await api(`/api/runs/${runId}/save/p1`);
        const m = await api(`/api/runs/${runId}`);
        out = JSON.stringify({ sha1: createHash('sha1').update(b).digest('hex'), size: b.length, savedAt: m.manifest?.saves?.p1 || m.saves?.p1 || null });
      } else if (u.pathname === '/savefile') writeFileSync(resolve(q('file')), await api(`/api/runs/${runId}/save/p1`));
      else if (u.pathname === '/eval') out = JSON.stringify(await ev(q('js')));
      else if (u.pathname === '/emu') out = JSON.stringify(await emu(q('js')));
      else if (u.pathname === '/logs') out = logs.splice(0).join('\n');
      else if (u.pathname === '/quit') { res.end('bye'); quit(); return; }
      else out = 'unknown';
    } catch (e) {
      out = `error: ${e.message}`;
    }
    res.end(out);
  }).listen(ctl, '127.0.0.1');
}
