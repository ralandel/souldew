// Runs first in every pack worker (sandbox.mjs workerSource). The worker lives in a sandboxed iframe of its own origin,
// in another process than the page – an OffscreenCanvas can't be handed across that line. So the page keeps its canvases
// and sends { __souldewCanvas: id } instead; here that becomes a stand-in with exactly what the hosts use (width,
// height, getContext('2d') → createImageData, putImageData, clearRect), and every picture goes back to the page as
// ImageData, which draws it into the real canvas (sandbox.mjs SandboxedWorker).
const send = (m) => self.postMessage({ op: '__souldew_canvas', ...m });

class ProxyContext {
  constructor(canvas) {
    this.canvas = canvas;
  }
  createImageData(w, h) {
    return new ImageData(Math.max(1, w | 0), Math.max(1, h | 0));
  }
  putImageData(img, x = 0, y = 0) {
    send({ id: this.canvas.id, w: this.canvas.width, h: this.canvas.height, img, x, y });
  }
  clearRect() {
    send({ id: this.canvas.id, w: this.canvas.width, h: this.canvas.height, clear: true });
  }
}

export class ProxyCanvas {
  constructor(id) {
    this.id = id;
    this.width = 300;
    this.height = 150;
    this.ctx = new ProxyContext(this);
  }
  getContext(kind) {
    return kind === '2d' ? this.ctx : null;
  }
}

const canvases = new Map();
const revive = (d) => {
  if (!d || typeof d !== 'object' || !d.canvas || typeof d.canvas.__souldewCanvas !== 'number') return d;
  const id = d.canvas.__souldewCanvas;
  if (!canvases.has(id)) canvases.set(id, new ProxyCanvas(id));
  return { ...d, canvas: canvases.get(id) };
};

// the hosts set self.onmessage – their handler gets the messages with the stand-ins in place of the page's canvases
let handler = null;
Object.defineProperty(self, 'onmessage', {
  configurable: true,
  get: () => handler,
  set: (fn) => {
    handler = typeof fn === 'function' ? fn : null;
  },
});
self.addEventListener('message', (e) => {
  if (handler) handler({ data: revive(e.data) });
});
