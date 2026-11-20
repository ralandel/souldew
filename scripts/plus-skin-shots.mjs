// Electron main for scripts/plus-previews.mjs renderSkinPreviews: the real app (its own server, a throwaway data
// folder, muted, hidden window) in every colour skin – Settings › General at 1440×900 (tabs, fields, switches, the theme
// cards: our own UI only – no game box art, which isn't ours to hand out), saved as
// <dir>/<id>.png at 960×600. The skins' stylesheets come in <dir>/skins.json ([{ id, css }]) and are set exactly the way
// the app sets a skin (a <style> plus html[data-skin]).
//   electron scripts/plus-skin-shots.mjs <dir>
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[process.argv.length - 1];
app.commandLine.appendSwitch('mute-audio');
const scratch = mkdtempSync(join(tmpdir(), 'souldew-skinshots-app-'));
app.setPath('userData', join(scratch, 'electron'));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let code = 0;
  try {
    const skins = JSON.parse(readFileSync(join(dir, 'skins.json'), 'utf8'));
    const data = join(scratch, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'souldew', bootAnimation: false, sounds: false, nagOff: true }));
    process.env.SLS_DATA_DIR = data;
    process.env.SLS_ACCOUNTS_URL = 'http://127.0.0.1:9'; // never the real service: signed out, nothing to reach
    const { startServer } = await import(pathToFileURL(join(ROOT, 'server', 'app.mjs')).href);
    const { url } = await startServer({ port: 0, background: false });
    const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    const js = (c) => win.webContents.executeJavaScript(c, true);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await win.loadURL(url);
    await js("localStorage.setItem('sl-firststeps-hidden', 'true'); true");
    await win.loadURL(`${url.split('#')[0]}#/settings?s=general`);
    for (let i = 0; i < 100 && !(await js("!!document.querySelector('.nav') && !!document.querySelector('.set-search')").catch(() => false)); i++) await sleep(150);
    await sleep(1500);
    await js(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); return true; })()`);
    for (const s of skins) {
      await js(`(() => { document.querySelectorAll('style[data-cos-skin]').forEach((e) => e.remove()); const el = document.createElement('style'); el.dataset.cosSkin = ${JSON.stringify(s.id)};
        el.textContent = ${JSON.stringify(s.css)}; document.head.appendChild(el); document.documentElement.dataset.skin = ${JSON.stringify(s.id)}; return true; })()`);
      await sleep(400);
      win.webContents.invalidate();
      await sleep(200);
      const img = await win.webContents.capturePage();
      writeFileSync(join(dir, `${s.id}.png`), img.resize({ width: 960, height: 600, quality: 'best' }).toPNG());
    }
  } catch (e) {
    console.error(e);
    code = 1;
  }
  rmSync(scratch, { recursive: true, force: true });
  app.exit(code);
});
