// Where code from a souldew+ pack runs: a module worker inside a SANDBOXED iframe (sandbox="allow-scripts", no
// allow-same-origin) – never the page itself and never the Node / main process. The iframe (/cosmetics-sandbox.html,
// served with its own CSP: connect-src 'none', no images, no styles) has an opaque origin: whatever runs there is
// cross-origin to the app, so it can't call the local API (the server refuses Origin: null and the app window's
// HttpOnly, SameSite=Strict secret is never sent from there), can't read the page, its storage or the account, and has
// no network at all. The worker's imports are the app's PUBLIC engine modules (served with CORS for exactly this); the
// pack's module text (already decrypted, its signature and hash verified by pack/format.mjs) becomes the worker's
// source with its '@cosmetics/…' specifiers pointed at those modules.
//
// The page talks to the worker through a MessageChannel the iframe relays (sandbox-frame.js). Canvases stay in the page:
// the worker draws into stand-ins (canvas-proxy.mjs) and sends the pictures back as ImageData – that's all it can do.

const SPEC = "'@cosmetics/";

/** absolute same-origin URL of a module in web/lib/cosmetics */
export const engineUrl = (path) => new URL(`/lib/cosmetics/${path}`, location.origin).href;

/**
 * hostModule: the public host ('frames/worker-host.mjs'); freeModule: a public content module (default export, an array)
 * or null; packText + packExport: the verified pack module and the array it exports (RECIPES / ANIMS) or null.
 */
export function workerSource({ hostModule, freeModule = null, packText = null, packExport = null }) {
  const lines = [];
  // first: the canvas stand-ins (canvas-proxy.mjs) – imports run in order, before the host takes its messages
  lines.push(`import '${engineUrl('canvas-proxy.mjs')}';`);
  if (packText) lines.push(packText.replaceAll(SPEC, `'${engineUrl('')}`));
  lines.push(`import { host as __souldewHost } from '${engineUrl(hostModule)}';`);
  if (freeModule) lines.push(`import __souldewFree from '${engineUrl(freeModule)}';`);
  lines.push(`__souldewHost([...${freeModule ? '__souldewFree' : '[]'}, ...${packText && packExport ? packExport : '[]'}]);`);
  return lines.join('\n');
}

export const SANDBOX_PAGE = '/cosmetics-sandbox.html';

/**
 * A worker for pack code, Worker-shaped for the runtimes (postMessage with transfers, onmessage / onerror,
 * addEventListener, terminate): the source runs in a module worker the sandboxed iframe starts. Messages sent before
 * the iframe is up are queued.
 */
class SandboxedWorker {
  constructor(source, name) {
    this.onmessage = null;
    this.onerror = null;
    this.listeners = { message: new Set(), error: new Set() };
    this.queue = [];
    this.canvasSeq = 0;
    this.ready = false;
    this.dead = false;
    const ch = new MessageChannel();
    this.port = ch.port1;
    this.canvases = new Map(); // id → { c, ctx } – the page's canvases the worker draws into (canvas-proxy.mjs)
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.op === '__souldew_canvas') this.paint(d);
      else if (d && d.op === '__souldew_error') this.emit('error', { message: String(d.message || 'worker error') });
      else this.emit('message', { data: d });
    };
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.title = 'souldew+';
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
    this.onReady = (e) => {
      if (e.source !== frame.contentWindow || e.data?.op !== 'souldew-sandbox-ready' || this.ready || this.dead) return;
      removeEventListener('message', this.onReady);
      // the iframe's origin is opaque ('null'), so '*' is the only target – the message goes to this iframe's window only
      frame.contentWindow.postMessage({ op: 'souldew-sandbox', source, name }, '*', [ch.port2]);
      this.ready = true;
      for (const [m, t] of this.queue.splice(0)) this.port.postMessage(m, t);
    };
    addEventListener('message', this.onReady);
    frame.src = SANDBOX_PAGE;
    (document.body || document.documentElement).appendChild(frame);
    this.frame = frame;
  }

  emit(type, ev) {
    const fn = type === 'message' ? this.onmessage : this.onerror;
    try {
      fn?.(ev);
      for (const l of this.listeners[type]) l(ev);
    } catch (e) {
      console.error('souldew sandbox listener failed', e);
    }
  }

  /** A picture from the worker → the page's canvas (only canvases the page handed over; sizes clamped). */
  paint(d) {
    const it = this.canvases.get(d.id);
    if (!it) return;
    const w = Math.max(1, Math.min(4096, d.w | 0));
    const h = Math.max(1, Math.min(4096, d.h | 0));
    if (it.c.width !== w) it.c.width = w;
    if (it.c.height !== h) it.c.height = h;
    if (d.clear) it.ctx.clearRect(0, 0, w, h);
    else if (d.img instanceof ImageData) it.ctx.putImageData(d.img, d.x | 0, d.y | 0);
  }

  postMessage(m, transfer = []) {
    if (this.dead) return;
    // a canvas never crosses into the sandbox (another process): the page keeps it and draws what the worker sends
    if (m && typeof OffscreenCanvas !== 'undefined' && m.canvas instanceof OffscreenCanvas) {
      const id = ++this.canvasSeq;
      this.canvases.set(id, { c: m.canvas, ctx: m.canvas.getContext('2d') });
      transfer = transfer.filter((t) => t !== m.canvas);
      m = { ...m, canvas: { __souldewCanvas: id } };
    }
    if (this.ready) this.port.postMessage(m, transfer);
    else this.queue.push([m, transfer]);
  }

  addEventListener(type, fn) {
    this.listeners[type]?.add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type]?.delete(fn);
  }

  terminate() {
    if (this.dead) return;
    this.dead = true;
    removeEventListener('message', this.onReady);
    this.queue.length = 0;
    this.canvases.clear();
    try {
      this.port.postMessage({ op: '__souldew_terminate' });
    } catch {
      // closed already
    }
    this.port.close();
    this.frame.remove(); // removing the iframe ends its worker as well
  }
}

let factory = (source, name) => new SandboxedWorker(source, name);
/** Tests without a browser replace how the worker is made (the default is always the sandboxed iframe). */
export function setWorkerFactory(fn) {
  factory = typeof fn === 'function' ? fn : (source, name) => new SandboxedWorker(source, name);
}

export function startWorker(opts) {
  return factory(workerSource(opts), opts.name || 'souldew-cosmetics');
}
