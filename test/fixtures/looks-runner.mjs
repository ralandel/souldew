// Electron main for test/handheld-looks.test.mjs: the app's own server and page in a hidden window (muted, software GL),
// then the launch scene (web/lib/handheld/scene.mjs) posed still in a few looks – with and without the souldew+ looks'
// data – to show that (1) without the pack's data a souldew+ look draws exactly "Your colours", (2) with it the scene
// draws something else, and (3) the pack's fragment code compiles in the real shader (the GPU's WebGL 2, like the app). Writes one JSON result to the
// path given as the last argument; the looks to use come as JSON in the path before it.
import { app, BrowserWindow, session } from 'electron';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const out = process.argv[process.argv.length - 1];
const looks = JSON.parse(readFileSync(process.argv[process.argv.length - 2], 'utf8'));
app.commandLine.appendSwitch('mute-audio');

app.whenReady().then(async () => {
  const result = { ok: false };
  try {
    const { startServer } = await import('../../server/app.mjs');
    const secret = randomBytes(32).toString('base64url');
    const { url } = await startServer({ port: 0, background: false, rendererSecret: secret });
    await session.defaultSession.cookies.set({ url, name: 'sls_rt', value: secret, httpOnly: true, sameSite: 'strict', path: '/' });
    const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    result.console = [];
    win.webContents.on('console-message', (...a) => { const e = a[0]; const m = String(e?.message ?? a[2] ?? '').slice(0, 400); result.console.push(m); if (process.env.LOOKS_DEBUG) appendFileSync(process.env.LOOKS_DEBUG, `${m}\n`); });
    await win.loadURL(url);
    const t0 = Date.now();
    while (!(await js("!!document.querySelector('.nav')").catch(() => false))) {
      if (Date.now() - t0 > 30000) throw new Error('app did not start');
      await new Promise((r) => setTimeout(r, 150));
    }
    result.shots = await js(`(async () => {
      const { loadScene, viewPlan } = await import('/lib/handheld/look.mjs');
      const { cleanLooks } = await import('/lib/handheld/looks.mjs');
      const { layoutKey } = await import('/lib/handheld/layouts.mjs');
      const { S, atlas } = await loadScene();
      const LK = cleanLooks(${JSON.stringify(looks)});
      const shot = async (o) => {
        const cv = document.createElement('canvas');
        const w = 240, h = 180;
        const scene = await S.createScene(cv, {
          sys: o.sys, lk: layoutKey(o.sys, 'tb', 'tb'), w, h, final: { x: 70, y: 40, w: 100, h: 100 }, dark: true,
          look: o.look, looks: o.looks, shell: '#6fb39b', clearTint: '#7a55d6', cartLook: o.cart, cartColor: '#4a4954', title: 'T',
          pulse: '#fff4e0', glow: '#dfe8ff', warm: !!o.warm, picture: 'placeholder', keep: true, atlas,
          plan: () => ({ ...viewPlan(o.sys, o.sys === 'nds' ? 'lid' : 'back', { yaw: 4, tilt: 4, zoom: 1.6 }), cart: 0, power: [-2000, -2000], led: 1, shadow: 1, clean: 0, canvasO: 1, glassOff: 0.35 }),
          hh: { skin: null, recipe: null, reduced: true },
        });
        try {
          scene.setStickers([{ id: 'heart', finish: 'holo', region: o.sys === 'nds' ? 'lid:top' : 'body:bottom', U: [0, 0], rot: 0, scale: 1 },
            { id: 'moon', finish: 'glitter', region: o.sys === 'nds' ? 'lid:top' : 'body:bottom', U: [12, 6], rot: 0, scale: 1 }]);
          scene.render(0);
          return cv.toDataURL();
        } finally {
          scene.dispose();
        }
      };
      return {
        valid: !!LK, kinds: LK ? Object.keys(LK).concat(Object.keys(LK.finishes).map((k) => 'finish:' + k)) : [],
        theme: await shot({ sys: 'gba', look: 'theme', looks: null }),
        goldNoData: await shot({ sys: 'gba', look: 'gold', cart: 'gold', looks: null, warm: true }),
        holoNoData: await shot({ sys: 'gba', look: 'theme', cart: 'holo', looks: null }),
        gold: await shot({ sys: 'gba', look: 'gold', cart: 'gold', looks: LK }),
        clearHolo: await shot({ sys: 'gba', look: 'clear', cart: 'holo', looks: LK, warm: true }),
      };
    })()`);
    result.ok = true;
  } catch (e) {
    result.error = String(e?.stack || e);
  }
  writeFileSync(out, JSON.stringify(result));
  app.exit(0);
});
