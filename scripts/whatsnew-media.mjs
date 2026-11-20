// The pictures of the "What's new in 3.0" cards (web/views/whatsnew.mjs → web/assets/whatsnew/<card>.webp): crops of
// real screenshots of the app, laid out on a plain backdrop. The screenshots come from the end-to-end scripts' --out
// folders (link-e2e, world-e2e, raid-e2e, social-e2e, the souldew+ handheld editor); copy them into one folder under
// the names below. Only souldew's own interface may be cropped – never the game's picture, box art or a sprite read
// from a ROM: those aren't ours to hand out (each crop below is a panel of souldew's UI, its rounded corners cut so
// nothing behind it shows).
//
//   node scripts/whatsnew-media.mjs <screenshots folder> [--out web/assets/whatsnew] [--png]   (needs cwebp, --png keeps the PNGs)
//
// Electron from node_modules renders the layouts offscreen; nothing is sent anywhere. Never commit the screenshots.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);

const W = 1120;
const H = 640;
// Per card: its accent and the crops – src (file in the folder), r: [x, y, w, h] in the screenshot's pixels, at: [x, y]
// on the 1120×640 picture, s: scale, rad: the panel's corner radius (screenshot pixels), z: stacking order.
const CARDS = {
  together: { accent: '#d77fc6', crops: [
    { src: 'raid-board-A.png', r: [1990, 380, 503, 190], at: [56, 64], s: 0.92, rad: 24 },
    { src: 'link-linked-A.png', r: [1568, 113, 600, 242], at: [520, 92], s: 0.9, rad: 24, z: 2 },
    { src: 'link-result-A.png', r: [1180, 113, 986, 291], at: [96, 340], s: 0.88, rad: 24, z: 3 },
  ] },
  world: { accent: '#6fb39b', crops: [
    { src: 'raid-invite-B.png', r: [1932, 948, 593, 222], at: [44, 196], s: 0.98, rad: 24 },
    { src: 'world-menu-A.png', r: [850, 752, 328, 468], at: [672, 50], s: 1.15, rad: 20, z: 2 },
  ] },
  raid: { accent: '#e7c24f', crops: [
    { src: 'raid-board-A.png', r: [554, 983, 1308, 112], at: [50, 60], s: 0.78, rad: 12 },
    { src: 'raid-invite-B.png', r: [1929, 114, 598, 294], at: [40, 230], s: 0.86, rad: 24, z: 2 },
    { src: 'raid-battle-A.png', r: [1929, 114, 598, 302], at: [572, 230], s: 0.86, rad: 24, z: 3 },
  ] },
  handheld: { accent: '#9a8ee6', crops: [
    { src: 'plus-handheld.png', r: [671, 525, 1029, 682], at: [-10, 120], s: 0.6, rad: 0, soft: true },
    { src: 'plus-handheld.png', r: [2012, 156, 833, 313], at: [588, 90], s: 0.63, rad: 24, z: 2 },
    { src: 'plus-handheld.png', r: [2012, 564, 833, 246], at: [588, 312], s: 0.63, rad: 24, z: 2 },
  ] },
  friends: { accent: '#6fb39b', crops: [
    { src: 'social-friends.png', r: [543, 259, 738, 322], at: [56, 72], s: 0.74, rad: 28 },
    { src: 'social-friends.png', r: [1358, 402, 1448, 201], at: [300, 296], s: 0.55, rad: 28, z: 2 },
    { src: 'social-friends.png', r: [1358, 650, 1448, 218], at: [300, 432], s: 0.55, rad: 28, z: 3 },
  ] },
};

function page(card, dir) {
  const c = CARDS[card];
  const crops = c.crops.map((k) => {
    const [x, y, w, h] = k.r;
    const url = pathToFileURL(join(dir, k.src)).href;
    // the panel at its place: the screenshot moved and scaled so only the crop shows, corners cut to the panel's
    return `<div class="crop ${k.soft ? 'soft' : ''}" style="left:${k.at[0]}px;top:${k.at[1]}px;width:${w * k.s}px;height:${h * k.s}px;z-index:${k.z || 1};
      border-radius:${(k.rad || 0) * k.s}px"><img src="${url}" style="left:${-x * k.s}px;top:${-y * k.s}px;transform:scale(${k.s})"></div>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#17161b}
    .bg{position:absolute;inset:0;background:
      radial-gradient(620px 420px at 78% 18%, ${c.accent}26, transparent 70%),
      radial-gradient(520px 380px at 12% 92%, ${c.accent}14, transparent 70%),
      linear-gradient(160deg,#1f1e24,#141318)}
    .bg::after{content:'';position:absolute;inset:0;background-image:radial-gradient(#ffffff0d 1px, transparent 1.2px);background-size:22px 22px}
    .crop{position:absolute;overflow:hidden;box-shadow:0 22px 48px -18px #000000e6, 0 0 0 1px #ffffff0f}
    .crop img{position:absolute;display:block;max-width:none;transform-origin:0 0}
    .crop.soft{box-shadow:none;-webkit-mask-image:radial-gradient(farthest-side,#000 62%,transparent 98%)}
  </style><div class="bg"></div>${crops}`;
}

if (!process.versions.electron) {
  const dir = resolve(args.find((a, i) => !a.startsWith('--') && !['--out'].includes(args[i - 1])) || '');
  if (!dir || !existsSync(dir)) {
    console.error('usage: node scripts/whatsnew-media.mjs <screenshots folder> [--out dir] [--png]');
    process.exit(2);
  }
  const electron = (await import('electron')).default;
  const p = spawn(electron, [fileURLToPath(import.meta.url), dir, ...args.filter((a) => a !== dir)], { stdio: 'inherit' });
  p.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, BrowserWindow } = await import('electron');
  const dir = resolve(args[0]);
  const out = resolve(opt('out', join(root, 'web', 'assets', 'whatsnew')));
  mkdirSync(out, { recursive: true });
  app.commandLine.appendSwitch('mute-audio');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.setPath('userData', join(tmpdir(), 'souldew-whatsnew-media'));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true, webSecurity: false } });
    for (const card of Object.keys(CARDS)) {
      const html = join(tmpdir(), `souldew-whatsnew-${card}.html`);
      writeFileSync(html, page(card, dir));
      await win.loadFile(html);
      await win.webContents.executeJavaScript('Promise.all([...document.images].map((i) => i.decode().catch(() => {})))');
      await new Promise((r) => setTimeout(r, 300));
      const png = join(out, `${card}.png`);
      writeFileSync(png, (await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H })).toPNG());
      const webp = join(out, `${card}.webp`);
      const r = spawnSync('cwebp', ['-quiet', '-q', '80', '-m', '6', '-sharp_yuv', png, '-o', webp]);
      if (r.status !== 0) console.error(`cwebp failed for ${card}: ${r.stderr}`);
      else console.log(`${card}.webp ${Math.round(statSync(webp).size / 1024)} KB`);
      if (!args.includes('--png')) unlinkSync(png);
    }
    app.quit();
  });
}
