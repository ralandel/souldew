// Electron main for scripts/plus-previews.mjs renderLaunchPreviews: the launch looks of "Your handheld" as public
// preview pictures – drawn by the REAL launch scene (web/lib/handheld/scene.mjs through look.mjs poseScene) in the real
// app page (its own server, a throwaway data folder, signed out, muted, hidden window), with the souldew+ looks' data
// (<dir>/looks.json – the design source's LOOKS, checked by looks.mjs cleanLooks) set in memory the way a verified pack
// sets it. A GBA from behind (the cartridge and its label in view), swinging gently: frames for a loop and one still.
//   electron scripts/handheld/launch-shots.mjs <dir>
// writes <dir>/<name>/f000.png … (LOOP_FRAMES, LOOP_W × LOOP_H) and <dir>/<name>.png (STILL_W × STILL_H) for every name
// of LAUNCH_SHOTS, and <dir>/shots.json (the names). Pictures only: no recipe, no material values, no shader code leave
// the page.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** name → the launch look (shared/handheld.mjs LAUNCH_LOOKS) and the Clear shell's colour */
const LAUNCH_SHOTS = [
  ['your-colours', { look: 'theme' }], ['gold', { look: 'gold' }], ['holo', { look: 'theme', cartLook: 'holo' }],
  ...['atomic', 'smoke', 'ice', 'jungle'].map((k) => [`clear-shell-${k}`, { look: 'clear', clear: k }]),
];
const LOOP_FRAMES = 30, LOOP_W = 288, LOOP_H = 180, STILL_W = 640, STILL_H = 400;

if (process.versions.electron) {
  const dir = process.argv[process.argv.length - 1];
  app.commandLine.appendSwitch('mute-audio');
  // the app's throwaway data inside <dir>: the caller removes <dir> once Electron has exited (Chromium still writes to
  // its profile while it shuts down, so a folder removed from here comes back)
  const scratch = join(dir, 'app');
  mkdirSync(scratch, { recursive: true });
  app.setPath('userData', join(scratch, 'electron'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    let code = 0;
    try {
      const looks = JSON.parse(readFileSync(join(dir, 'looks.json'), 'utf8'));
      const data = join(scratch, 'data');
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'souldew', bootAnimation: false, sounds: false, nagOff: true }));
      process.env.SLS_DATA_DIR = data;
      process.env.SLS_ACCOUNTS_URL = 'http://127.0.0.1:9'; // never the real service: signed out, nothing to reach
      const { startServer } = await import(pathToFileURL(join(ROOT, 'server', 'app.mjs')).href);
      const { url } = await startServer({ port: 0, background: false });
      const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { backgroundThrottling: false } });
      win.webContents.setAudioMuted(true);
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await win.loadURL(`${url.split('#')[0]}#/settings?s=general`);
      for (let i = 0; i < 100 && !(await js("!!document.querySelector('.nav')").catch(() => false)); i++) await sleep(150);
      await sleep(800);
      const ok = await js(`(async () => {
        const st = await import('/lib/cosmetics/state.mjs');
        const { cleanLooks } = await import('/lib/handheld/looks.mjs');
        const L = cleanLooks(${JSON.stringify(looks)});
        if (!L) return false;
        st.content.handheld = { ...(st.content.handheld || {}), looks: L };
        Object.defineProperty(window, 'devicePixelRatio', { get: () => 1 }); // the sizes are the pictures' own pixels (the interface size zooms the page)
        return true;
      })()`);
      if (!ok) throw new Error('looks.json does not pass the app\'s check (looks.mjs cleanLooks)');
      for (const [name, o] of LAUNCH_SHOTS) {
        const shots = await js(`(async () => {
          const H = await import('/lib/handheld/look.mjs');
          const shot = async (w, h, yaws) => {
            const cv = document.createElement('canvas');
            const yaw = { v: 0 };
            const { scene } = await H.poseScene(cv, { sys: 'gba', look: ${JSON.stringify(o.look)}, cartLook: ${JSON.stringify(o.cartLook || null)}, clear: ${JSON.stringify(o.clear || null)},
              skin: null, w, h, el: document.body, reduced: true, keep: true, plan: () => H.viewPlan('gba', 'back', { yaw: yaw.v, tilt: 2, zoom: 1.05 }) });
            try {
              return yaws.map((v) => { yaw.v = v; scene.render(0); return cv.toDataURL('image/png'); });
            } finally {
              scene.dispose();
            }
          };
          const n = ${LOOP_FRAMES};
          // a gentle swing, ±22° around the back (3 s at 10 fps), that loops without a seam
          const loop = await shot(${LOOP_W}, ${LOOP_H}, Array.from({ length: n }, (_, i) => -8 + 22 * Math.sin((2 * Math.PI * i) / n)));
          const still = await shot(${STILL_W}, ${STILL_H}, [-14]);
          return { loop, still: still[0] };
        })()`);
        const out = join(dir, name);
        mkdirSync(out, { recursive: true });
        const png = (u) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');
        shots.loop.forEach((u, i) => writeFileSync(join(out, `f${String(i).padStart(3, '0')}.png`), png(u)));
        writeFileSync(join(dir, `${name}.png`), png(shots.still));
      }
      writeFileSync(join(dir, 'shots.json'), JSON.stringify(LAUNCH_SHOTS.map(([name]) => name)));
    } catch (e) {
      console.error(e);
      code = 1;
    }
    app.exit(code);
  });
}
