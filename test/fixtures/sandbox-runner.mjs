// Electron main for test/cosmetics-sandbox.test.mjs: the app's own server with the window secret (like
// electron/main.mjs), the real page in a hidden window, and souldew+ pack code started the way the frames runtime starts
// it (web/lib/cosmetics/sandbox.mjs startWorker). The pack code probes what it can reach; the frames host must still work.
// Writes one JSON result to the path given as the last argument.
import { app, BrowserWindow, session } from 'electron';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const out = process.argv[process.argv.length - 1];
app.commandLine.appendSwitch('mute-audio');
app.disableHardwareAcceleration();

const PROBE = `
const hdr = { 'x-soullink': '1', 'content-type': 'application/json' };
const j = (p, o) => fetch(new URL(p, ${JSON.stringify('__BASE__')}).href, { headers: hdr, credentials: 'include', ...o }).then((r) => 'reached ' + r.status, (e) => 'blocked');
const probe = {
  origin: self.origin,
  exportData: await j('/api/account/export'),
  entitlements: await j('/api/account/entitlements'),
  status: await j('/api/status'),
  configWrite: await j('/api/config', { method: 'POST', body: JSON.stringify({ playerName: 'pwned-by-pack' }) }),
  outside: await fetch('https://example.invalid/x').then(() => 'reached', () => 'blocked'),
  relay: await new Promise((res) => { try { const ws = new WebSocket('wss://relay.damus.io'); ws.onopen = () => res('reached'); ws.onerror = () => res('blocked'); setTimeout(() => res('blocked'), 3000); } catch { res('blocked'); } }),
};
self.postMessage({ op: 'probe', probe });
export const RECIPES = [];
`;

app.whenReady().then(async () => {
  const result = { ok: false };
  try {
    const { startServer } = await import('../../server/app.mjs');
    const secret = randomBytes(32).toString('base64url');
    const { url } = await startServer({ port: 0, background: false, rendererSecret: secret });
    await session.defaultSession.cookies.set({ url, name: 'sls_rt', value: secret, httpOnly: true, sameSite: 'strict', path: '/' });
    const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    result.console = [];
    win.webContents.on('console-message', (...a) => { const e = a[0]; result.console.push(String(e?.message ?? a[2] ?? '').slice(0, 300)); });
    await win.loadURL(url);
    const t0 = Date.now();
    while (!(await js("!!document.querySelector('.nav')").catch(() => false))) {
      if (Date.now() - t0 > 30000) throw new Error('app did not start');
      await new Promise((r) => setTimeout(r, 150));
    }
    // the page itself (the window) may call the account routes – it has the secret
    result.pageAccount = await js(`fetch('/api/account', { headers: { 'x-soullink': '1' } }).then((r) => r.status)`);
    const probeText = PROBE.replace('__BASE__', url);
    result.sandbox = await js(`new Promise((resolve) => {
      import('/lib/cosmetics/sandbox.mjs').then((S) => {
        const got = { messages: [] };
        const w = S.startWorker({ hostModule: 'frames/worker-host.mjs', freeModule: 'content/frames-free.mjs', packText: ${JSON.stringify(probeText)}, packExport: 'RECIPES', name: 'probe' });
        w.onmessage = (e) => {
          got.messages.push(e.data.op);
          if (e.data.op === 'probe') got.probe = e.data.probe;
          if (e.data.op === 'ready') {
            got.readyIds = e.data.ids.length;
            // a real canvas of the page: the worker can't get it – it draws through the stand-in (canvas-proxy.mjs)
            const c = document.createElement('canvas');
            document.body.appendChild(c);
            got.cv = c;
            const off = c.transferControlToOffscreen();
            got.size = () => [off.width, off.height];
            w.postMessage({ op: 'mount', id: 1, recipe: e.data.ids[0], canvas: off, N: 64, O: 8, small: false }, [off]);
            return;
          }
          if (e.data.op === 'meta') {
            w.postMessage({ op: 'draw', id: 1, t: 2, noIntro: true });
            setTimeout(() => {
              const probe = document.createElement('canvas');
              [probe.width, probe.height] = got.size();
              const ctx = probe.getContext('2d');
              ctx.drawImage(got.cv, 0, 0);
              const px = ctx.getImageData(0, 0, probe.width, probe.height).data;
              let n = 0;
              for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
              got.drawn = { w: probe.width, pixels: n };
              got.cv.remove();
              delete got.cv;
              delete got.size;
              done();
            }, 500);
            return;
          }
          done();
        };
        const done = () => {
          if (got.probe && got.readyIds !== undefined && got.drawn) {
            got.iframe = { sandbox: document.querySelector('iframe[sandbox]')?.getAttribute('sandbox') };
            w.terminate();
            got.iframeGone = !document.querySelector('iframe[sandbox]');
            resolve(got);
          }
        };
        const plain = () => { const { cv, size, ...rest } = got; void cv; void size; return rest; };
        w.onerror = (e) => resolve({ error: e.message, ...plain() });
        setTimeout(() => resolve({ timeout: true, ...plain() }), 20000);
      });
    })`);
    const cfg = await fetch(`${url.replace('localhost', '127.0.0.1')}/api/status`, { headers: { 'x-soullink': '1' } }).then((r) => r.json());
    result.playerName = cfg.config?.playerName ?? null;
    const sb = await fetch(`${url}/cosmetics-sandbox.html`);
    result.sandboxCsp = sb.headers.get('content-security-policy');
    result.ok = true;
  } catch (e) {
    result.error = String(e?.stack || e);
  }
  writeFileSync(out, JSON.stringify(result));
  app.exit(0);
});
