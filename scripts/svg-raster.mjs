// SVG → PNG of at most <max> px per side, drawn by Electron's Chromium (offscreen, muted, no network). Used by
// scripts/plus-dev-pack.mjs for the live theme preview pack, whose images must be small PNGs.
//
//   electron scripts/svg-raster.mjs <in.svg> <out.png> <max>
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';

const [svgFile, outFile, maxArg] = process.argv.slice(-3);
const max = Math.max(16, Math.min(4096, Number(maxArg) || 512));
const svg = readFileSync(svgFile, 'utf8');
const dim = (name) => Number((new RegExp(`<svg[^>]*\\s${name}="([0-9.]+)"`).exec(svg) || [])[1]) || 0;
const w0 = dim('width') || max;
const h0 = dim('height') || max;
const scale = Math.min(1, max / Math.max(w0, h0));
const w = Math.max(1, Math.floor(w0 * scale));
const h = Math.max(1, Math.floor(h0 * scale));

app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.dock?.hide?.();
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true, webPreferences: { offscreen: true, javascript: false } });
    const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}img{display:block;width:${w}px;height:${h}px}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
    await win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
    await new Promise((r) => setTimeout(r, 300));
    let img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
    const s = img.getSize();
    if (s.width > max || s.height > max) img = img.resize({ width: w, height: h, quality: 'best' });
    writeFileSync(outFile, img.toPNG());
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
