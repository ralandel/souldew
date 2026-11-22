// The fast player (playernative.html) for the DS, GBA and Game Boy: the game runs in souldew's native host
// (server/lib/native.mjs, native/retro-host – melonDS DS with its JIT, mGBA, SameBoy) and arrives here as a stream of
// pictures, sound, memory and battery saves; input, speed, save states and cheats go back. It offers the Play view the
// same window.__emu as player.html (EmulatorJS) – the live reader, cheats, save states, the battery save, speed,
// screenshots and the partner's mini view work the same way. The game's RAM is mirrored here (what changed, ten times a
// second, between two frames), so the live reader reads it synchronously like the browser emulator's memory.
import * as controls from '/lib/controls.mjs';
import { setLang, guessLang, t } from '/lib/i18n.mjs';
import { serverErrorText } from '/lib/errors.mjs';
import { openHostStream } from '/lib/hoststream.mjs';
import { LINK_CMD, LINK_MSG } from '/shared/link.mjs';
import { b64 } from '/lib/bytes.mjs';
import { installWorld } from '/lib/worldoverlay.mjs';
import { sharpScale, dsTouchAt } from '/lib/pixelscale.mjs';

const q = new URLSearchParams(location.search);
const SYSTEM = q.get('system') || 'nds';
// A link session (trades and battles, docs/MULTIPLAYER.md): this page shows the local seat of the link host. No save
// states, cheats or fast-forward there – every console of the session must stay the same on every player's computer.
// The host's buttons for the partners and its hashes go to the play view (web/lib/linksession.mjs sends them on).
// Seamless (docs/MULTIPLAYER.md › "Seamless"): a running game goes into a link session and back without a restart – its
// state goes in (linkSnapshot), the page switches its stream to the link host (attachLink) and, once the session is over,
// back to the fast player started from this console's state as the link host left it (resumeSolo). The canvas stays.
// The souldew engine (Settings › "souldew engine (beta)": the link host plays the game alone too) does both switches in
// its own process: the session's id stays, the stream goes on, and leaving needs no state to travel (/api/native/unlink).
// ?link=1&session=<id>: a session the play view opened for a game that wasn't running here (it starts from the save).
let LINK_SESSION = q.get('link') === '1' ? q.get('session') : null;
// (retrohost's messages – the link host speaks the same ones plus its own, shared/link.mjs)
const MSG = { VIDEO: 2, AUDIO: 3, STATE: 5, LOG: 6, EVENT: 7, RAM: 8, SRAM: 9, MEM: LINK_MSG.MEM, LINPUT: LINK_MSG.LINPUT, SEATSRAM: LINK_MSG.SEATSRAM, SEATSTATE: LINK_MSG.SEATSTATE, WATCHED: 16, DEPTH: 17 };
const CMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, QUIT: 6, RESET: 7, WRITE: 9, FLUSH: 10, SRAM: 11, RESYNC: 12, STEP: 13, WATCH: 14, DEPTH: 15, SEATSTATE: LINK_CMD.SEATSTATE, READ: LINK_CMD.READ };
const post = (m) => window.parent?.postMessage(m, location.origin);
// ?debug=1 (the ROM matrix): what arrives from the host – events, picture sizes, saves – on the console
const DEBUG = q.get('debug') === '1';
const dbg = (...a) => DEBUG && console.log('[native]', ...a);
if (DEBUG) {
  addEventListener('error', (e) => console.log('[native] error', e.message, e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => console.log('[native] rejection', String(e.reason?.stack || e.reason)));
  addEventListener('beforeunload', () => console.log('[native] beforeunload'));
  addEventListener('pagehide', () => console.log('[native] pagehide'));
}

/** "Linking…" over the last picture (playernative.html #linking) – null hides it. */
let linkingTimer = null;
function linking(text) {
  const el = document.getElementById('linking');
  if (!el) return;
  clearTimeout(linkingTimer);
  if (text) el.querySelector('span').textContent = text;
  el.classList.toggle('on', !!text);
  if (text) linkingTimer = setTimeout(() => el.classList.remove('on'), 60000); // (never stuck over the game)
}

const st = {
  id: null, core: null, ready: false, paused: false, speed: 1, volume: 1, frames: 0, hostFrame: 0, fps: 0, hostSpeed: 0,
  ram: [], ramReady: false, sram: null, bootSave: 'pending', error: null, log: [], ended: false, lr: /left/i.test(q.get('layout') || ''),
  info: null, turboAudio: 'music', switches: [], whole: q.get('px') === 'whole',
  model: q.get('model') || null, // a Game Boy game's console ('dmg' | 'cgb'): its save states only load into that model
  engine: false, // the souldew engine plays (its loaded event says so): link sessions switch in its own process
};
const waiters = { state: [], loaded: [], stepped: [], seatState: [], seatSram: [] };
// a link session's READs (any seat's bytes – the link battle's result, shared/linkbattle.mjs) and FLUSH's every-seat saves
const memWaiters = []; // { seat, addr, res }
const seatSaves = { want: 0, got: null, res: null };

// ---- commands -----------------------------------------------------------------------------------------------------
// One request at a time, and what comes meanwhile goes along with the next one (the server takes several framed
// commands in one body, in order): the host sees input in the order it happened, and a burst of input is a few requests,
// not thousands. (One request per command piled up native memory in the renderer – responses not read, request
// bookkeeping – until Chromium ended the page after ~30 000 of them: a long DS plan in the ROM matrix, and in the end
// a long play session.) Each command's promise resolves false when the server refused it.
const MAX_BATCH = 8 * 1024 * 1024; // (a save state goes alone)
// A big payload (a save state: a DS one is ≈ 20 MB) goes as a Blob – copied once, when the command is made – not
// concatenated into a new array and copied again into the request: "where you left off" loads while the launch
// animation runs, and those copies were 40–55 ms on the main thread, a dropped frame of the device.
const BLOB_AT = 256 * 1024;
const queue = []; // { bytes: Uint8Array | Blob (header + payload), len, done }
let inFlight = false;
const idle = [];
function sendQueued() {
  if (inFlight) return;
  if (!queue.length) return idle.splice(0).forEach((f) => f());
  if (!st.id) {
    queue.splice(0).forEach((c) => c.done(false));
    return idle.splice(0).forEach((f) => f());
  }
  const batch = [];
  let size = 0;
  while (queue.length && (!batch.length || size + queue[0].len <= MAX_BATCH)) {
    const c = queue.shift();
    batch.push(c);
    size += c.len;
  }
  let body;
  if (typeof Blob === 'function' && batch.some((c) => c.bytes instanceof Blob)) body = new Blob(batch.map((c) => c.bytes)); // (no copy: Blobs of Blobs)
  else {
    body = new Uint8Array(size);
    let o = 0;
    for (const c of batch) {
      body.set(c.bytes, o);
      o += c.len;
    }
  }
  inFlight = true;
  fetch(`/api/native/cmd?id=${st.id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body })
    .then(async (r) => {
      await r.arrayBuffer().catch(() => null); // (read it: an unread response holds on to its resources)
      return r.ok;
    })
    .catch(() => true) // (no answer at all: the server is gone – the stream's end answers what waits)
    .then((ok) => {
      inFlight = false;
      for (const c of batch) c.done(ok);
      sendQueued();
    });
}
function cmd(type, payload = new Uint8Array(0)) {
  const big = payload.length >= BLOB_AT && typeof Blob === 'function';
  const b = new Uint8Array(big ? 8 : 8 + payload.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, type, true);
  v.setUint32(4, payload.length, true);
  if (!big) b.set(payload, 8);
  // (either way the bytes are this moment's: the Blob holds its own copy, as the array does)
  const bytes = big ? new Blob([b, payload]) : b;
  return new Promise((done) => {
    queue.push({ bytes, len: 8 + payload.length, done });
    sendQueued();
  });
}
/** Resolves once every command so far reached the server. */
const flushCommands = () => new Promise((res) => {
  idle.push(res);
  sendQueued();
});
function ask(list, type, payload, fallback, map = (x) => x) {
  return new Promise((res) => {
    const w = (x) => res(map(x));
    list.push(w);
    cmd(type, payload).then((ok) => {
      if (ok) return;
      const i = list.indexOf(w);
      if (i >= 0) list.splice(i, 1);
      res(fallback);
    });
  });
}
const f32 = (x) => new Uint8Array(new Float32Array([x]).buffer);
const u32 = (x) => new Uint8Array(new Uint32Array([x]).buffer);

// ---- picture (WebGL) – the DS's two screens on top of each other as the core draws them, or side by side ----------
const canvas = document.getElementById('screen');
const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
let uni = null;
let tex = null;
function initGl() {
  const vs = '#version 300 es\nin vec2 p;out vec2 uv;void main(){uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);gl_Position=vec4(p,0.,1.);}';
  // lr: the left half shows the top screen (the picture's upper half), the right half the bottom screen
  const fs = '#version 300 es\nprecision mediump float;in vec2 uv;uniform sampler2D t;uniform bool bgra;uniform bool lr;out vec4 o;'
    + 'void main(){vec2 c=uv;if(lr){c=uv.x<.5?vec2(uv.x*2.,uv.y*.5):vec2((uv.x-.5)*2.,.5+uv.y*.5);}vec4 x=texture(t,c);o=vec4(bgra?x.bgr:x.rgb,1.);}';
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  uni = { bgra: gl.getUniformLocation(prog, 'bgra'), lr: gl.getUniformLocation(prog, 'lr') };
}
if (gl) initGl();

const sideBySide = () => SYSTEM === 'nds' && st.lr;
let pendingFrame = null;
let lastFrame = null;
let nextWatched = null; // WATCHED: the bytes the host sends right before a picture (Shared World's camera)
let nextDepth = null; // DEPTH: the DS's 3D depth in the rectangles the overlay named, for the same picture
let lastWatched = null; // (the newest of them, drawn or not – Shared World's A press checks what the game shows now)
// the game's picture in game pixels (the DS side by side: both screens next to each other) and the whole factor it is
// drawn at (lib/pixelscale.mjs) – the canvas holds pic × pre
const pic = { w: 0, h: 0, pre: 1 };
function drawFrame() {
  const f = pendingFrame || lastFrame;
  pendingFrame = null;
  if (!f || !gl) return;
  lastFrame = f;
  const lr = sideBySide();
  const cw = lr ? f.w * 2 : f.w;
  const ch = lr ? f.h / 2 : f.h;
  if (pic.w !== cw || pic.h !== ch) {
    pic.w = cw;
    pic.h = ch;
    layout();
  }
  if (canvas.width !== cw * pic.pre || canvas.height !== ch * pic.pre) {
    canvas.width = cw * pic.pre;
    canvas.height = ch * pic.pre;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  if (f.depth) window.__world?.onDepth?.(f.depth); // (the DS's 3D depth for this picture – before its bytes, which draw it)
  if (f.watched) window.__world?.onWatched(f.watched); // (the overlay draws for exactly this picture)
  if (f.fmt === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, f.w, f.h, 0, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, new Uint16Array(f.px.buffer, f.px.byteOffset, f.w * f.h));
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.px);
  gl.uniform1i(uni.bgra, f.fmt === 0 ? 1 : 0);
  gl.uniform1i(uni.lr, lr ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  streamFrame();
}

// The partners' video (captureStream) at the picture's own size, as before the sharp scaling: the bigger drawing buffer
// would only cost upload and encoder time. Drawn only while someone watches.
let streamCanvas = null;
function streamFrame() {
  if (!streamCanvas) return;
  const w = pic.w || canvas.width;
  const h = pic.h || canvas.height;
  if (streamCanvas.width !== w || streamCanvas.height !== h) {
    streamCanvas.width = w;
    streamCanvas.height = h;
  }
  const x = streamCanvas.getContext('2d');
  x.imageSmoothingEnabled = false; // a whole factor down: the game's pixels exactly
  x.drawImage(canvas, 0, 0, w, h);
}
function onVideo(p) {
  const v = new DataView(p.buffer, p.byteOffset, 8);
  const w = v.getUint16(0, true);
  const h = v.getUint16(2, true);
  const fmt = v.getUint32(4, true);
  const bpp = fmt === 0 ? 4 : 2;
  if (!w || !h || p.length < 8 + w * h * bpp) return dbg('bad picture', w, h, fmt, p.length);
  if (DEBUG && (w !== st.dbgW || h !== st.dbgH)) dbg('picture', w, h, fmt), (st.dbgW = w), (st.dbgH = h);
  const px = p.subarray(8, 8 + w * h * bpp);
  if (st.awaitPicture) { // the first picture after a switch into / out of a link session: the game goes on
    // (a console started from a state has drawn nothing yet in its first frame – a black picture there would flash
    // between two real ones: the last picture stays a few frames longer)
    if (st.awaitPicture++ < 8 && px.every((x) => x === 0)) return;
    st.awaitPicture = 0;
    linking(null);
    const ms = st.switchFrom ? Math.round(performance.now() - st.switchFrom) : null;
    st.switches.push({ to: LINK_SESSION ? 'link' : 'solo', ms, at: Date.now() }); // (diagnostics / tests: how long the picture stood)
    if (st.switches.length > 20) st.switches.shift();
  }
  if (!pendingFrame) requestAnimationFrame(drawFrame);
  pendingFrame = { w, h, fmt, px, watched: nextWatched, depth: nextDepth };
  nextWatched = null;
  nextDepth = null;
  st.frames++;
  if (!st.ready) {
    st.ready = true;
    window.__emu.ready = true;
    document.getElementById('wait')?.remove();
    layout();
    post({ type: 'emu-started', core: st.core, system: SYSTEM });
  }
}

// the picture as big as the frame allows, its proportions kept (the page decides the frame's size): game pixels blown
// up by a whole number with hard edges, the rest smoothed – or whole multiples only (Settings) – lib/pixelscale.mjs
function layout() {
  const box = document.body.getBoundingClientRect();
  const src = pic.w ? pic : { w: canvas.width, h: canvas.height };
  const s = sharpScale(src, { w: box.width, h: box.height }, devicePixelRatio || 1, { whole: st.whole });
  canvas.style.width = `${s.w}px`;
  canvas.style.height = `${s.h}px`;
  canvas.style.imageRendering = s.smooth ? 'auto' : 'pixelated';
  if (pic.w && s.pre !== pic.pre) {
    pic.pre = s.pre;
    drawFrame(); // the new buffer size, with the last picture
  }
}
addEventListener('resize', layout);
new ResizeObserver(layout).observe(document.body);
// the window moved to a screen with another pixel density: the whole factor changes, the frame's size doesn't
(function watchDensity() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
    layout();
    watchDensity();
  }, { once: true });
})();
layout();

// ---- sound: the host's samples through souldew's turbo mixer (lib/native-audio-worklet.mjs) ------------------------
// While fast-forwarding the host sends the sound sped up by the real speed, resampled to real time with a steady ratio
// (native/ctr-host/ffsound.h, as the 3DS host since 2.8.2), and says by how much ("ffrate", right before that sound – the
// worklet hands the ratio to the mixer when the sound plays); the mixer keeps the music going at normal speed (Settings › sound while fast-forwarding), for DS games synthesized from the
// ROM's own sound archive (lib/sdat-worker.mjs), as in player.html.
const MAX_SOUND_RATIO = 16; // the host speeds its fast-forward sound up at most this much
const audio = { ctx: null, node: null, gain: null, key: null, events: [], subs: new Set(), probes: [], exact: false };
function tellAudio(m) {
  audio.node?.port.postMessage(m);
}
const audioInit = () => [
  { type: 'mode', mode: st.turboAudio },
  { type: 'paused', paused: st.paused },
  ...(audio.key ? [{ type: 'song', key: audio.key }] : []),
  { type: 'speed', ratio: Math.min(st.speed, MAX_SOUND_RATIO) },
];
async function startAudio(rate) {
  if (audio.ctx || !rate || q.get('audio') === '0') return; // (?audio=0: no sound at all – diagnostics)
  try {
    audio.ctx = new AudioContext({ sampleRate: Math.round(rate), latencyHint: 'interactive' });
    await audio.ctx.audioWorklet.addModule('/lib/native-audio-worklet.mjs');
    audio.node = new AudioWorkletNode(audio.ctx, 'native-audio', { outputChannelCount: [2], processorOptions: { init: audioInit() } });
    audio.node.port.onmessage = (e) => {
      const ev = e.data?.e;
      if (!ev) return;
      if (ev.type === 'error') st.log.push(`turbo audio: ${ev.message}`);
      if (ev.type === 'probe') audio.probes.splice(0).forEach((f) => f(ev));
      if (ev.type === 'state' || ev.type === 'error') {
        audio.events.push({ t: Math.round(performance.now()), ...ev });
        if (audio.events.length > 40) audio.events.shift();
      }
      // every mixer decision (loops found, switches, song keys) to the page's music log for "Save diagnostics" – as player.html;
      // without it a native player's diagnostics showed only the speed steps (a Windows player's Pokémon Y report, 2.7.4)
      if (ev.type !== 'probe') {
        for (const f of audio.subs) {
          try {
            f({ t: Math.round(performance.now()), ...ev });
          } catch {
            // the page's problem
          }
        }
      }
    };
    audio.gain = audio.ctx.createGain();
    audio.gain.gain.value = st.volume;
    audio.node.connect(audio.gain).connect(audio.ctx.destination);
    audio.ctx.resume().catch(() => {});
    for (const m of audioInit()) tellAudio(m); // (the state may have changed while the module loaded)
    startSdat();
  } catch (e) {
    st.log.push(`audio: ${e.message}`);
  }
}
/** The host's sound comes at `rate` (from now on): a context at another rate is replaced by one at this rate. */
function audioRate(rate) {
  if (audio.ctx && rate && Math.round(audio.ctx.sampleRate) !== Math.round(rate)) {
    const old = audio.ctx;
    audio.ctx = audio.node = audio.gain = null;
    old.close().catch(() => {});
  }
  startAudio(rate);
}
// DS games: the ROM's sound archive, read in a worker – the mixer synthesizes the song the game plays
const sdat = { worker: null, ready: false };
const sdatSong = (key) => {
  const id = /^m(\d+)$/.exec(key || '')?.[1];
  if (sdat.ready && id) sdat.worker.postMessage({ type: 'pack', key, id: Number(id) });
};
function startSdat() {
  if (SYSTEM !== 'nds' || sdat.worker || typeof Worker !== 'function' || !q.get('rom')) return;
  try {
    // a blob worker inherits the page's cross-origin isolation (a script of its own would need the headers itself)
    const src = `import ${JSON.stringify(new URL('/lib/sdat-worker.mjs', location.href).href)};`;
    sdat.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  } catch (e) {
    st.log.push(`sdat: ${e.message}`);
    return;
  }
  sdat.worker.onerror = () => st.log.push('sdat: worker failed');
  sdat.worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'ready') {
      sdat.ready = true;
      tellAudio({ type: 'sdat-ready' });
      sdatSong(audio.key);
    } else if (m.type === 'none') st.log.push(`sdat: ${m.why}`);
    else if (m.type === 'pack' && m.pack) tellAudio({ type: 'sdat', key: m.key, pack: m.pack });
  };
  sdat.worker.postMessage({ type: 'rom', url: new URL(q.get('rom'), location.href).href });
}
const wake = () => audio.ctx?.state === 'suspended' && audio.ctx.resume().catch(() => {});
addEventListener('pointerdown', wake);
addEventListener('keydown', wake);
function onAudio(p) {
  st.audioIn = (st.audioIn || 0) + 1; // (diagnostics / tests: the host sends sound – link sessions too)
  if (!audio.node || st.paused) return;
  const s = new Int16Array(p.buffer.slice(p.byteOffset, p.byteOffset + (p.length & ~1)));
  const f = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
  audio.node.port.postMessage(f, [f.buffer]);
}

// ---- memory: a mirror of the game's RAM regions --------------------------------------------------------------------
function onRam(p) {
  const v = new DataView(p.buffer, p.byteOffset, p.length);
  const n = v.getUint32(0, true);
  let o = 4;
  for (let i = 0; i < n && o + 8 <= p.length; i++) {
    const addr = v.getUint32(o, true);
    const len = v.getUint32(o + 4, true);
    o += 8;
    if (o + len > p.length) break;
    const r = st.ram.find((x) => addr >= x.addr && addr + len <= x.addr + x.b.length);
    if (r) r.b.set(p.subarray(o, o + len), addr - r.addr);
    if (r && addr === r.addr && len === r.b.length) whole.add(r);
    o += len;
  }
  if (!st.ramReady && st.ram.length) st.ramReady = true;
  // every region whole (a RESYNC's answer – the host's changes are blocks, never all of it): the mirror is the core's now
  const full = st.ram.length > 0 && st.ram.every((r) => whole.has(r));
  whole.clear();
  if (full) freshWaiters.splice(0).forEach((f) => f(true));
}
const whole = new Set(); // (onRam: the regions a message carried whole)
const freshWaiters = []; // fresh(): who waits for the core's whole RAM
/**
 * The mirror as the core holds it right now: the whole RAM once more (RESYNC), sent by the host after everything asked
 * of it before (a WRITE included) and after the next frame. A write's own copy in the mirror (write) can't tell whether
 * it landed – the host only sends what changed against what it sent last, so a write the game lost (Emerald moving its
 * save blocks) would never come back. Resolves true once it is in, false when it can't come (no game, a link session,
 * no answer).
 */
function fresh() {
  if (!st.ramReady || st.ended || LINK_SESSION || !st.id) return Promise.resolve(false);
  return new Promise((res) => {
    const f = (ok) => {
      clearTimeout(timer);
      res(ok);
    };
    const timer = setTimeout(() => {
      const i = freshWaiters.indexOf(f);
      if (i >= 0) freshWaiters.splice(i, 1);
      res(false);
    }, 4000);
    freshWaiters.push(f);
    cmd(CMD.RESYNC);
  });
}
const region = (addr, len) => st.ram.find((r) => addr >= r.addr && addr + len <= r.addr + r.b.length);
/** `len` bytes at a console bus address (a copy), or null outside the game's RAM. */
function read(addr, len) {
  if (!st.ramReady || !(len > 0)) return null;
  const r = region(addr, len);
  return r ? r.b.slice(addr - r.addr, addr - r.addr + len) : null;
}
/** A cheat: bytes at a bus address – between two frames in the host, and right away in the mirror. */
function write(addr, bytes) {
  if (LINK_SESSION) return false; // (no cheats in a link session: the partners' copies of this console would differ)
  if (!st.ramReady || !ArrayBuffer.isView(bytes) || !bytes.length || bytes.length > 65536) return false;
  const r = region(addr, bytes.length);
  if (!r) return false;
  const b = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  r.b.set(b, addr - r.addr);
  const pl = new Uint8Array(4 + b.length);
  new DataView(pl.buffer).setUint32(0, addr >>> 0, true);
  pl.set(b, 4);
  written.push({ fn: null }); // (the host answers every WRITE with an event, in order – writeChecked waits for its own)
  cmd(CMD.WRITE, pl);
  return true;
}
const written = []; // one entry per WRITE sent, the host's "written" events in the same order: { fn } – who waits for it
/** A write the host confirmed: resolves true once it is in the game's memory, false when the host refused it (or no
 *  answer came – an older host answers too, so a missing answer means the host is gone). */
function writeChecked(addr, bytes) {
  if (!write(addr, bytes)) return Promise.resolve(false);
  const slot = written.at(-1);
  return new Promise((res) => {
    const timer = setTimeout(() => {
      slot.fn = null; // (its answer still comes and is dropped)
      res(false);
    }, 3000);
    slot.fn = (ok) => {
      clearTimeout(timer);
      res(ok);
    };
  });
}

// ---- events -------------------------------------------------------------------------------------------------------
function onEvent(p) {
  let e;
  try {
    e = JSON.parse(new TextDecoder().decode(p));
  } catch {
    return dbg('bad event', p.length);
  }
  if (!['stats', 'stepped', 'written', 'ffrate'].includes(e.event)) dbg('event', JSON.stringify(e).slice(0, 300));
  if (e.event === 'loaded') {
    for (const w of written.splice(0)) w.fn?.(false); // (a new host: the old one's writes get no answer any more)
    st.info = e;
    st.engine = e.engine === true;
    if (Number.isInteger(e.local)) st.localSeat = e.local;
    // a mirror for every region the core has (all of it arrives with the first RAM message) – after a switch into or out
    // of a link session the same regions stay as they are until then (the live reader never sees an empty party)
    const regions = (e.ram || []).filter((r) => r.ok && r.len > 0 && r.len <= 16 * 1024 * 1024);
    const same = regions.length === st.ram.length && regions.every((r, i) => (r.addr >>> 0) === st.ram[i].addr && r.len === st.ram[i].b.length);
    if (!same) {
      st.ram = regions.map((r) => ({ addr: r.addr >>> 0, b: new Uint8Array(r.len) }));
      st.ramReady = false;
    }
    audioRate(e.sampleRate); // (the link host's rate may be another)
  } else if (e.event === 'audioRate') audioRate(e.sampleRate); // (a GBA game switched its sound hardware's rate)
  else if (e.event === 'stats') {
    st.fps = e.fps;
    st.hostSpeed = e.speed;
    // (a host before 2.8.2 doesn't say its ratio: the measured speed then, as before)
    if (!audio.exact && st.speed > 1 && !st.paused && e.speed > 0.5) tellAudio({ type: 'rate', ratio: Math.round(Math.min(e.speed, MAX_SOUND_RATIO) * 100) / 100 });
    if (Number.isFinite(e.frame)) st.hostFrame = e.frame;
  } else if (e.event === 'ffrate') {
    if (!(e.k >= 1)) return;
    audio.exact = true;
    tellAudio({ type: 'rate', ratio: e.k, exact: true, inband: true });
  } else if (e.event === 'stepped') {
    if (Number.isFinite(e.frame)) st.hostFrame = e.frame;
    waiters.stepped.splice(0).forEach((f) => f(e.frame));
  } else if (e.event === 'written') written.shift()?.fn?.(!!e.ok);
  else if (e.event === 'stateLoaded') waiters.loaded.splice(0).forEach((f) => f(!!e.ok));
  else if (e.event === 'seatState' && !e.size) waiters.seatState.splice(0).forEach((f) => f(null));
  else if (LINK_SESSION && (e.event === 'hash' || e.event === 'wait' || e.event === 'stuck')) post({ type: `emu-link-${e.event}`, ...e });
  else if (e.event === 'error') {
    st.error = e.message;
    fail(t('native.failed', 'The game can’t run in the fast player: {why}', { why: e.message }));
  }
}
function onSram(p) {
  dbg('battery save', p.length);
  st.sram = p.slice();
  // as EmulatorJS' saveSaveFiles: the play view takes getSave() to disk now
  post({ type: 'emu-saved' });
}
function showError(text) {
  const w = document.getElementById('wait');
  if (w) w.textContent = text;
  post({ type: 'emu-error', message: text });
}
/** Before the game ever showed a picture the play view switches to the browser emulator; later it's an error. */
function fail(text) {
  if (!st.ready) post({ type: 'emu-native-failed', message: text });
  showError(text);
}

// ---- the stream from the host ------------------------------------------------------------------------------------
let pumpGen = 0;
async function pump() {
  const gen = ++pumpGen;
  // a WebSocket (an endless HTTP response filled antivirus caches on Windows – #38, lib/hoststream.mjs)
  const reader = await openHostStream(`/api/native/stream?id=${st.id}`);
  if (gen !== pumpGen) return reader.cancel(); // (switched meanwhile)
  st.streamKind = reader.kind;
  cmd(CMD.RESYNC); // the whole RAM, whatever was sent before this page listened
  let buf = new Uint8Array(0);
  let parts = [];
  let partsLen = 0;
  let need = 8;
  for (;;) {
    const { value, done } = await reader.read();
    if (done || gen !== pumpGen) break;
    parts.push(value);
    partsLen += value.length;
    if (buf.length + partsLen < need) continue;
    const next = new Uint8Array(buf.length + partsLen);
    next.set(buf);
    let at = buf.length;
    for (const c of parts) {
      next.set(c, at);
      at += c.length;
    }
    buf = next;
    parts = [];
    partsLen = 0;
    let o = 0;
    while (buf.length - o >= 8) {
      const v = new DataView(buf.buffer, buf.byteOffset + o, 8);
      const type = v.getUint32(0, true);
      const len = v.getUint32(4, true);
      if (buf.length - o - 8 < len) break;
      const p = buf.subarray(o + 8, o + 8 + len);
      if (type === MSG.VIDEO) onVideo(p.slice());
      else if (type === MSG.AUDIO) onAudio(p);
      else if (type === MSG.RAM) onRam(p);
      else if (type === MSG.SRAM) onSram(p);
      else if (type === MSG.EVENT) onEvent(p);
      else if (type === MSG.LINPUT && LINK_SESSION) post({ type: 'emu-link-input', bytes: p.slice() });
      else if (type === MSG.WATCHED) nextWatched = lastWatched = p.slice();
      else if (type === MSG.DEPTH) nextDepth = p.slice();
      else if (type === MSG.STATE) waiters.state.shift()?.(p.slice());
      else if (type === MSG.SEATSTATE) waiters.seatState.shift()?.(p.length > 4 ? p.slice(4) : null);
      else if (type === MSG.SEATSRAM && p.length >= 4) onSeatSram(new DataView(p.buffer, p.byteOffset, 4).getUint32(0, true), p.slice(4));
      else if (type === MSG.MEM && p.length >= 8) onMem(p);
      else if (type === MSG.LOG) {
        st.log.push(new TextDecoder().decode(p));
        if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
      }
      o += 8 + len;
    }
    buf = buf.subarray(o);
    need = buf.length >= 8 ? 8 + new DataView(buf.buffer, buf.byteOffset, 8).getUint32(4, true) : 8;
  }
  if (gen !== pumpGen || st.switching) { // (into or out of a link session: another stream follows – or, if the switch fails, a restart)
    if (gen === pumpGen) ended();
    return reader.cancel().catch(() => {});
  }
  dbg('stream ended');
  ended();
  if (!st.error) fail(t('native.stopped', 'The game stopped. Close it and start it again.'));
}
/** Reads the current session's stream (a failure ends the game with an error over the picture). */
function startPump() {
  pump().catch((e) => {
    ended();
    fail(t('native.failed', 'The game can’t run in the fast player: {why}', { why: e.message }));
  });
}
/** A seat's battery save from FLUSH: ours for resumeSolo, every seat's for linkSeatSaves. */
function onSeatSram(seat, bytes) {
  if (seat === st.localSeat) waiters.seatSram.shift()?.(bytes);
  if (seatSaves.got && seat < seatSaves.want) {
    seatSaves.got[seat] = bytes;
    if (Object.keys(seatSaves.got).length === seatSaves.want) seatSaves.res?.(seatSaves.got);
  }
}
function onMem(p) {
  const v = new DataView(p.buffer, p.byteOffset, 8);
  const seat = v.getUint32(0, true);
  const addr = v.getUint32(4, true);
  const i = memWaiters.findIndex((w) => w.seat === seat && w.addr === addr);
  if (i >= 0) memWaiters.splice(i, 1)[0].res(p.slice(8));
}
function ended() {
  st.ended = true;
  freshWaiters.splice(0).forEach((f) => f(false));
  memWaiters.splice(0).forEach((w) => w.res(null));
  seatSaves.res?.(null);
  for (const k of ['state', 'stepped', 'seatState', 'seatSram']) waiters[k].splice(0).forEach((f) => f(null));
  waiters.loaded.splice(0).forEach((f) => f(false));
}

// ---- input ------------------------------------------------------------------------------------------------------------
// libretro joypad bits (the same numbers EmulatorJS uses, lib/controls.mjs BUTTONS.ejs)
const BIT = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };
const inp = { keys: 0, pad: 0, test: 0, px: 0, py: 0, touch: false };
let sentInput = '';
function sendInput() {
  const buttons = inp.keys | inp.pad | inp.test;
  const sig = [buttons, inp.px, inp.py, inp.touch].join();
  if (sig === sentInput) return;
  sentInput = sig;
  window.__world?.input(buttons);
  const b = new Uint8Array(17);
  const v = new DataView(b.buffer);
  v.setUint32(0, buttons >>> 0, true);
  v.setInt16(12, inp.px, true);
  v.setInt16(14, inp.py, true);
  b[16] = inp.touch ? 1 : 0;
  cmd(CMD.INPUT, b);
}

let keyMap = {}; // keyCode → button
let hotkeys = controls.resolveHotkeys(null); // the shortcuts' keys (Settings › Controls) – handled by the play view
function forwardKey(e, down) {
  post({ type: 'emu-key', key: e.key, code: e.code, keyCode: e.keyCode, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, down, repeat: e.repeat, blur: e.blur || undefined });
}
addEventListener('keydown', (e) => {
  forwardKey(e, true);
  // a shortcut's exact key: the play view's, never also the game's (Shift+R as reset while R is B) – and Tab
  // fast-forwards here instead of moving the focus
  if (controls.isHotkeyKey(e, hotkeys)) return e.preventDefault();
  const b = keyMap[e.keyCode];
  if (b === undefined) return;
  e.preventDefault();
  inp.keys |= 1 << BIT[b];
  sendInput();
});
addEventListener('keyup', (e) => {
  forwardKey(e, false);
  const b = keyMap[e.keyCode];
  if (b === undefined) return;
  inp.keys &= ~(1 << BIT[b]);
  sendInput();
});
addEventListener('blur', () => {
  forwardKey({ key: 'Tab', code: 'Tab', blur: true }, false); // ends a held fast-forward
  inp.keys = 0;
  inp.pad = 0;
  inp.touch = false;
  sendInput();
});

// touch (DS): the mouse on the bottom screen – the core takes a pointer over its whole picture (-0x7fff…0x7fff), the
// two screens on top of each other; side by side the click is mapped back onto that picture (lib/pixelscale.mjs)
function pointer(e) {
  const r = canvas.getBoundingClientRect();
  const { x, y } = dsTouchAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, sideBySide());
  inp.px = Math.round(x * 0xfffe - 0x7fff);
  inp.py = Math.round(y * 0xfffe - 0x7fff);
}
if (SYSTEM === 'nds') {
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointer(e);
    inp.touch = true;
    sendInput();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!inp.touch) return;
    pointer(e);
    sendInput();
  });
  const lift = () => {
    if (!inp.touch) return;
    inp.touch = false;
    sendInput();
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
}

// Settings › Controls and › Controller (config.controls, config.pads): read when the page starts, and again whenever
// they change while the game runs (__emu.setControls from the play view) – the game often keeps running in the corner
// while the player re-binds buttons in Settings, and the in-game reset doesn't load the page again (ticket #18).
let padCfg = null; // config.pads
let padButtons = controls.padMap(null); // game button → controller button label
const padRec = controls.padRecorder(); // (diagnostics: __emu.padInfo)
let padActions = controls.padActions(null); // controller hotkeys: standard button index → action
let controlsSig = '';
function applyControls(config) {
  const sig = JSON.stringify([config?.controls || null, config?.pads || null]);
  if (sig === controlsSig) return; // (the play view hands them over once the game runs – mostly what was read at start)
  controlsSig = sig;
  keyMap = controls.keyButtons(config?.controls);
  hotkeys = controls.resolveHotkeys(config?.controls);
  padCfg = config?.pads || null;
  padButtons = controls.padMap(padCfg);
  padActions = controls.padActions(padCfg);
  post({ type: 'emu-pad', action: 'ffHold', down: false }); // (a fast-forward button held under the old buttons)
  // what was held under the old buttons is let go (the next poll presses what is still down)
  inp.keys = 0;
  inp.pad = 0;
  if (st.id) sendInput();
}

// controllers: the chosen device (lib/controls.mjs pickPad) – buttons by Settings › Controller, the left stick moves
// like the D-pad; RT/R2 toggles turbo, LT/L2 and Home pause (as in player.html)
function startPads() {
  const IDX = Object.fromEntries(controls.PAD_LABELS.map((l, i) => [l, i]));
  const held = {};
  setInterval(() => {
    if (!st.ready || document.visibilityState === 'hidden') return;
    const pad = controls.pickPad(navigator.getGamepads?.() || [], padCfg?.device || null);
    padRec.see(pad, padButtons, controls.appHasPad());
    if (!pad) {
      if (inp.pad) {
        inp.pad = 0;
        sendInput();
      }
      return;
    }
    let bits = 0;
    for (const [btn, label] of Object.entries(padButtons)) {
      const i = IDX[label];
      if (i !== undefined && pad.buttons[i]?.pressed && btn in BIT) bits |= 1 << BIT[btn];
    }
    const [lx = 0, ly = 0] = pad.axes;
    if (lx < -0.5) bits |= 1 << BIT.left;
    if (lx > 0.5) bits |= 1 << BIT.right;
    if (ly < -0.5) bits |= 1 << BIT.up;
    if (ly > 0.5) bits |= 1 << BIT.down;
    inp.pad = controls.appHasPad() ? 0 : bits; // the app's menus have the controller (lib/padnav.mjs)
    for (const m of controls.padHotkeyPresses(pad, padActions, held, controls.appHasPad())) post(m);
    sendInput();
  }, 16);
}

// ---- window.__emu: what the Play view uses (see player.html) ----------------------------------------------------------
async function snapshot({ maxW = 192, type = 'image/jpeg', quality = 0.5 } = {}) {
  if (!st.ready) return null;
  drawFrame(); // (the last picture again: the canvas may be cleared after a resize)
  // at the game's own size at most (the canvas holds it blown up by a whole number, lib/pixelscale.mjs)
  const w0 = pic.w || canvas.width;
  const h0 = pic.h || canvas.height;
  const k = Math.min(1, maxW / w0);
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k);
  c.height = Math.round(h0 * k);
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = k < 1;
  x.drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, type, quality));
}
const speedValue = () => (st.speed === Infinity ? 1000 : st.speed);
const blankSave = (b) => !b || !b.length || b.every((x) => x === 0xff) || b.every((x) => x === 0);

window.__emu = {
  ready: false,
  /** Diagnostics: the controller settings this page plays with, the device it picked and the last presses. */
  padInfo: () => padRec.info(padCfg, padButtons),
  native: true,
  system: () => SYSTEM,
  locateRam() {
    return st.ramReady ? { base: 0, size: st.ram.reduce((n, r) => n + r.b.length, 0) } : null;
  },
  ramInfo: () => ({ base: st.ramReady ? 0 : -1, size: st.ram.reduce((n, r) => n + r.b.length, 0), tried: 0, system: SYSTEM }),
  read,
  write,
  writeChecked,
  fresh,
  paused: () => st.paused,
  pause() {
    if (LINK_SESSION) return; // (the partners' games would stand still too – leave the link instead)
    st.paused = true;
    cmd(CMD.SPEED, f32(0));
    tellAudio({ type: 'paused', paused: true });
  },
  resume() {
    st.paused = false;
    cmd(CMD.SPEED, f32(speedValue()));
    tellAudio({ type: 'paused', paused: false });
  },
  togglePause() {
    if (st.paused) this.resume();
    else this.pause();
  },
  restart: () => {
    if (LINK_SESSION) return Promise.resolve(false);
    tellAudio('clear');
    tellAudio({ type: 'cut' });
    return cmd(CMD.RESET);
  },
  /** 1–4, or Infinity: as fast as this computer can. */
  setSpeed(ratio) {
    st.speed = LINK_SESSION ? 1 : ratio === Infinity ? Infinity : Math.max(1, Number(ratio) || 1);
    if (!st.paused) cmd(CMD.SPEED, f32(speedValue()));
    tellAudio({ type: 'speed', ratio: Math.min(st.speed, MAX_SOUND_RATIO) });
  },
  speed: () => st.speed,
  setFullTurbo() {}, // the native host always runs fast-forward at full power – it doesn't hold the page back
  /** Settings › Controls / Controller changed while the game runs: { controls, pads } as in config. */
  setControls(config) {
    applyControls(config);
  },
  /** Emulated frames so far (the host's count, four times a second) – the page measures the real speed with it. */
  frames: () => st.hostFrame,
  fastForward: () => st.speed > 1,
  ffRatio: () => (st.speed > 1 ? st.speed : 3),
  /** A link session's whole state (every console, the frame) for a partner who rejoins; null when not now. */
  linkState() {
    if (st.ended || !LINK_SESSION) return Promise.resolve(null);
    return ask(waiters.state, CMD.SAVE, undefined, null, (b) => (b && b.length ? b.slice() : null));
  },
  /**
   * Seamless link start: the running game stops (a frame boundary – the host takes commands between frames) and its save
   * state comes back – the link session starts from it on every player's computer. "Linking…" shows over the picture.
   * Resolves { state } or null (no game running here, or one in a link session already).
   */
  async linkSnapshot() {
    if (LINK_SESSION || st.ended || !st.ready || !st.id) return null;
    linking(t('native.linking', 'Linking…'));
    st.switchFrom = performance.now();
    st.switching = true;
    st.wasPaused = st.paused;
    cmd(CMD.SPEED, f32(0));
    tellAudio({ type: 'paused', paused: true });
    const state = await ask(waiters.state, CMD.SAVE, undefined, null, (b) => (b && b.length ? b.slice() : null));
    if (!state) this.linkSnapshotCancel();
    return state ? { state, frame: st.hostFrame, model: st.model } : null;
  },
  /** The link didn't start after all: the game goes on (from the snapshot, if its host is gone meanwhile). */
  async linkSnapshotCancel(state = null) {
    if (LINK_SESSION || !st.switching) return false;
    if (st.ended && state) return startSolo({ state, save: st.sram });
    st.switching = false;
    linking(null);
    if (!st.wasPaused) cmd(CMD.SPEED, f32(speedValue()));
    tellAudio({ type: 'paused', paused: !!st.wasPaused });
    return true;
  },
  /** The link session `id` (its host already runs, started from this game's snapshot): this page shows it from now on. */
  attachLink(id) {
    if (!id) return false;
    const inPlace = id === st.id; // (the engine: its game was linked in its own process – the stream goes on)
    LINK_SESSION = id;
    st.id = id;
    st.core = 'link';
    window.__world?.rewatch(); // (the overlay's WATCH waits for the fast player after the session)
    st.ended = false;
    st.paused = false;
    st.speed = 1;
    st.switching = false;
    st.awaitPicture = 1;
    sentInput = ''; // (the held buttons go to the link host too)
    tellAudio('clear');
    tellAudio({ type: 'speed', ratio: 1 });
    tellAudio({ type: 'paused', paused: false });
    if (!inPlace) startPump();
    sendInput();
    return true;
  },
  /**
   * A link session: `len` bytes at bus address `addr` of seat `seat`'s console (READ – it changes nothing), or null. How
   * every peer reads every seat's link battle (shared/linkbattle.mjs).
   */
  linkRead(seat, addr, len) {
    if (!LINK_SESSION || st.ended) return Promise.resolve(null);
    return new Promise((res) => {
      const w = { seat, addr: addr >>> 0, res };
      memWaiters.push(w);
      const b = new Uint8Array(12);
      const v = new DataView(b.buffer);
      v.setUint32(0, seat, true);
      v.setUint32(4, addr >>> 0, true);
      v.setUint32(8, len, true);
      const drop = () => {
        const i = memWaiters.indexOf(w);
        if (i >= 0) memWaiters.splice(i, 1);
        res(null);
      };
      cmd(CMD.READ, b).then((ok) => !ok && drop());
      setTimeout(drop, 4000);
    });
  },
  /** A link session: every seat's battery save as its console holds it now ({ seat: bytes }), or null. */
  linkSeatSaves(n) {
    if (!LINK_SESSION || st.ended || !(n > 0)) return Promise.resolve(null);
    return new Promise((res) => {
      const finish = (x) => {
        if (seatSaves.res !== finish) return;
        seatSaves.got = null;
        seatSaves.res = null;
        res(x);
      };
      seatSaves.res?.(null); // (one at a time)
      Object.assign(seatSaves, { want: n, got: {}, res: finish });
      cmd(CMD.FLUSH);
      setTimeout(() => finish(null), 4000);
    });
  },
  /**
   * The link session is over: this console goes on alone from the state the link host left it in (with the session's
   * last battery save) – or, given `from` ({ state, save }: a session that fell out of step), from the game as it was
   * before the session. Resolves true once the fast player runs it; false when it can't (the play view then closes).
   */
  async resumeSolo(from = null) {
    if (!LINK_SESSION || !q.get('rom')) return false;
    linking(t('native.unlinking', 'Back to your game…'));
    st.switchFrom = performance.now();
    st.switching = true;
    // the engine: the partners leave its process and the game goes on alone where it is (its last battery save comes as
    // SRAM first, the play view stores it as every save) – nothing to fetch and hand back
    if (!from && st.engine && !st.ended && (await unlinkInPlace())) return true;
    let state = from?.state || null;
    let save = from ? from.save || null : null;
    if (!from && !st.ended) {
      // the hosts stand still (the session's end): the session's last battery saves, then this console as it is
      const sram = new Promise((res) => waiters.seatSram.push(res));
      cmd(CMD.FLUSH);
      save = await Promise.race([sram, new Promise((res) => setTimeout(() => res(null), 3000))]);
      state = await Promise.race([ask(waiters.seatState, CMD.SEATSTATE, u32(300), null), new Promise((res) => setTimeout(() => res(null), 8000))]);
    }
    if (!state) {
      st.switching = false;
      linking(null);
      return false;
    }
    // (out of step: exactly the save from before the link – none if there was none; never the session's last one)
    return startSolo({ state, save: from ? save : save?.length ? save : st.sram });
  },
  getState() {
    if (st.ended || LINK_SESSION) return Promise.resolve(null);
    return ask(waiters.state, CMD.SAVE, undefined, null, (b) => (b && b.length ? b : null));
  },
  loadState(u8) {
    if (st.ended || LINK_SESSION) return Promise.resolve(false);
    tellAudio('clear');
    tellAudio({ type: 'cut' });
    // (the play view's bytes come from its own window: not an instanceof here – a view on them, not a copy)
    return ask(waiters.loaded, CMD.LOAD, ArrayBuffer.isView(u8) ? new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength) : new Uint8Array(u8), false);
  },
  async screenshot() {
    const b = await snapshot({ maxW: 4096, type: 'image/png' });
    return b ? new Uint8Array(await b.arrayBuffer()) : null;
  },
  canvas: () => (st.ready ? canvas : null),
  captureStream(fps = 15) {
    try {
      if (!st.ready || !canvas.captureStream) return null;
      streamCanvas ||= document.createElement('canvas');
      streamFrame();
      return streamCanvas.captureStream(fps);
    } catch {
      return null;
    }
  },
  snapshot,
  /** The battery save as the game last wrote it (a copy), or null before it ever saved. */
  getSave: () => (st.sram ? st.sram.slice() : null),
  /** How the app's save reached the core at boot: 'loaded' | 'none' | 'failed' | 'pending'. */
  bootSave: () => st.bootSave,
  /** A battery save given after the start: into the core, then the game starts over with it. */
  loadSave(bytes) {
    if (LINK_SESSION || !ArrayBuffer.isView(bytes) || !bytes.length) return;
    const b = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    st.sram = b;
    st.bootSave = 'loaded';
    tellAudio('clear');
    tellAudio({ type: 'cut' });
    cmd(CMD.SRAM, b);
  },
  setVolume(v) {
    st.volume = v;
    if (audio.gain) audio.gain.gain.value = v;
  },
  muted: () => st.volume === 0,
  /** What plays while fast-forwarding: 'music' | 'mute' | 'original' | 'plain' (as player.html). */
  setTurboAudio(mode) {
    st.turboAudio = mode;
    tellAudio({ type: 'mode', mode });
  },
  /** The music the game plays now (location.mjs musicKey): the turbo mixer follows it. */
  songKey(key) {
    if (!key || key === audio.key) return;
    audio.key = key;
    tellAudio({ type: 'song', key });
    sdatSong(key);
  },
  /** The mixer's last state changes (diagnostics). */
  /** Every mixer event from now on (the page keeps them for "Save diagnostics"); returns the unsubscribe. */
  onAudio(f) {
    audio.subs.add(f);
    return () => audio.subs.delete(f);
  },
  turboAudio: () => ({ mode: st.turboAudio, key: audio.key, sdat: sdat.ready, events: audio.events.slice(-10) }),
  /** Tests: what the mixer plays right now ({ playing, turbo, key, … }), or null without sound. */
  audioProbe() {
    if (!audio.node) return Promise.resolve(null);
    return new Promise((res) => {
      audio.probes.push(res);
      tellAudio({ type: 'probe' });
      setTimeout(() => res(null), 2000);
    });
  },
  /** Switches into and out of link sessions: { to: 'link' | 'solo', ms (the picture stood still), at } – the last 20. */
  switches: () => st.switches.slice(),
  perf: () => ({ fps: st.fps, speed: st.hostSpeed, frames: st.hostFrame, shown: st.frames, audioIn: st.audioIn || 0, audioOn: !!audio.node, core: st.core, info: st.info, error: st.error, log: st.log.slice(-20), pacing: { core: st.core, native: true }, stream: st.streamKind || null }),
  setOption(k, v) {
    if (/screens?_layout$/.test(k)) {
      st.lr = /left/i.test(v);
      drawFrame();
    }
  },
  /** Settings › "Whole pixels only" switched while playing. */
  setWholePixels(on) {
    st.whole = !!on;
    layout();
  },
  fullscreen: () => document.documentElement.requestFullscreen?.(),
  /** Tests / diagnostics: hold buttons by name (["a"], ["up", "b"] …) – what a controller would do. */
  hold(names = []) {
    inp.test = names.reduce((m, n) => (String(n).toLowerCase() in BIT ? m | (1 << BIT[String(n).toLowerCase()]) : m), 0);
    sendInput();
  },
  /** Tests: the stylus at (x, y) over the whole picture (0…1, the two screens on top of each other). */
  touch(x, y, down = true) {
    inp.px = Math.round(x * 0xfffe - 0x7fff);
    inp.py = Math.round(y * 0xfffe - 0x7fff);
    inp.touch = down;
    sendInput();
  },
  /** Tests: run exactly `n` frames, then stay paused – resolves with the frame number once they ran. */
  step(n) {
    if (st.ended) return Promise.resolve(null);
    st.paused = true;
    return ask(waiters.stepped, CMD.STEP, u32(Math.max(1, Math.min(100000, n | 0))), null);
  },
  /** The input as sent last (tests: the next step() runs with it). */
  flush: () => flushCommands(),
};

// Shared World (web/lib/worldoverlay.mjs): the partners over the picture – the play view turns it on for a SoulLink.
// Never in a link session (everyone stands in the Cable Club then, and the session's consoles must stay untouched).
if (!LINK_SESSION) {
  installWorld({
    system: SYSTEM,
    romUrl: q.get('rom'),
    read,
    rect: () => (st.ready ? canvas.getBoundingClientRect() : null),
    /** The DS's 3D depth in a few rectangles of the top screen with every picture: [[x, y, w, h]…] (≤ 8, ≤ 16384
     *  pixels), [] stops it. Only souldew's melonDS DS core has it (native/melonds-ds-patch); others send nothing. */
    depth(rects) {
      const b = new Uint8Array(4 + rects.length * 8);
      const v = new DataView(b.buffer);
      v.setUint32(0, rects.length, true);
      rects.forEach(([x, y, w, h], i) => (v.setInt16(4 + i * 8, x, true), v.setInt16(6 + i * 8, y, true), v.setUint16(8 + i * 8, w, true), v.setUint16(10 + i * 8, h, true)));
      if (!st.id || LINK_SESSION) return false;
      cmd(CMD.DEPTH, b);
      return true;
    },
    /** The DS's top screen (where its 3D field is): the upper half, or the left one side by side. */
    screen() {
      if (!st.ready) return null;
      const r = canvas.getBoundingClientRect();
      return sideBySide() ? { left: r.left, top: r.top, width: r.width / 2, height: r.height } : { left: r.left, top: r.top, width: r.width, height: r.height / 2 };
    },
    // (hidden while a seamless link session runs on this page: the Cable Club is no place for partners walking about)
    ready: () => st.ready && !st.ended && !LINK_SESSION,
    /** A few RAM bytes with every picture (WATCH): ranges [[addr, len]…], [] stops it. Only retrohost knows WATCH –
     *  during a link session the ranges wait (false: asked again) for the fast player that comes after it. */
    watch(ranges) {
      const b = new Uint8Array(4 + ranges.length * 8);
      const v = new DataView(b.buffer);
      v.setUint32(0, ranges.length, true);
      ranges.forEach(([a, l], i) => (v.setUint32(4 + i * 8, a >>> 0, true), v.setUint32(8 + i * 8, l >>> 0, true)));
      if (!st.id || LINK_SESSION) return false;
      cmd(CMD.WATCH, b);
      return true;
    },
    /** The newest WATCHED bytes from the host (the picture they go with may not be drawn yet). */
    watchedNow: () => lastWatched,
    paused: () => st.paused,
    pause: () => window.__emu.pause(),
    resume: () => window.__emu.resume(),
    post,
    keyButton: (e) => keyMap[e.keyCode],
    /** The picture on screen: { w, h, fmt (0: 32-bit BGRX, else RGB565), px } – the Game Boy overlay takes its colours from
     *  it, the DS overlay the field's light (off the player's own sprite). */
    picture: () => lastFrame,
  });
}

// ---- start ----------------------------------------------------------------------------------------------------------
async function bootSaveBytes() {
  const url = q.get('save');
  if (!url) return { state: 'none', bytes: null };
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return { state: 'none', bytes: null };
      if (r.ok) {
        const b = new Uint8Array(await r.arrayBuffer());
        return b.length && !blankSave(b) ? { state: 'loaded', bytes: b } : { state: 'none', bytes: null };
      }
    } catch {
      // try again
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  return { state: 'failed', bytes: null }; // the play view reads it again and hands it over with loadSave()
}

const BOOT_TIMEOUT_MS = Number(q.get('bootTimeout')) || 30000;

/** The engine's link session ends in place: the same process, the same stream; false when the server can't (then the
 *  session's console travels the usual way). */
async function unlinkInPlace() {
  const res = await fetch('/api/native/unlink', { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ id: st.id }) }).catch(() => null);
  const j = res?.ok ? await res.json().catch(() => null) : null;
  if (!j || j.id !== st.id) return false;
  // the engine sent the session's last battery save, then its "loaded" (alone): once that is read here, the save goes
  // to the play view as every save does (it skips saves during a link session – this one is the game's own again)
  for (let i = 0; i < 40 && st.info?.mode !== 'solo'; i++) await new Promise((r) => setTimeout(r, 50));
  LINK_SESSION = null;
  if (st.sram) post({ type: 'emu-saved' });
  st.core = j.core;
  st.model = j.model || st.model;
  window.__world?.rewatch();
  st.paused = false;
  st.speed = 1;
  st.awaitPicture = 1;
  sentInput = '';
  tellAudio('clear');
  tellAudio({ type: 'paused', paused: false });
  st.switching = false;
  sendInput();
  return true;
}

/** The fast player again, from a save state (out of a link session): the same page, canvas and sound – no restart. */
async function startSolo({ state, save }) {
  st.switching = true;
  const res = await fetch('/api/native/start', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' },
    body: JSON.stringify({ rom: q.get('rom'), key: q.get('key'), system: SYSTEM, save: save?.length ? b64(save) : null, saveUrl: q.get('save'), state: b64(state), model: st.model }),
  }).catch(() => null);
  const j = await res?.json().catch(() => ({}));
  if (!res?.ok) {
    st.switching = false;
    linking(null);
    fail(serverErrorText(j || {}, res?.status || 0));
    return false;
  }
  LINK_SESSION = null;
  const inPlace = j.id === st.id; // (the engine went on alone in its own process: the stream goes on)
  st.id = j.id;
  st.core = j.core;
  st.model = j.model || st.model;
  window.__world?.rewatch(); // (a new host – or the engine alone again: the Shared World overlay's WATCH ranges go to it)
  st.ended = false;
  st.paused = false;
  st.speed = 1;
  st.awaitPicture = 1;
  st.sram = save?.length ? save.slice() : null; // (the game's battery save from here on – none if it had none)
  if (st.sram) post({ type: 'emu-saved' }); // (to disk, as the play view does with every save)
  sentInput = '';
  tellAudio('clear');
  tellAudio({ type: 'paused', paused: false });
  st.switching = false;
  if (!inPlace) startPump();
  sendInput();
  return true;
}

async function start() {
  const [status, save] = await Promise.all([fetch('/api/status').then((r) => r.json()).catch(() => null), bootSaveBytes()]);
  await setLang(status?.config?.lang || guessLang()).catch(() => {});
  try {
    await controls.detectLayout(status?.config?.lang);
    applyControls(status?.config);
    startPads();
  } catch (e) {
    st.log.push(`controls: ${e.message}`);
  }
  if (LINK_SESSION) return startLinked(status, save);
  const res = await fetch('/api/native/start', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' },
    // (saveUrl: where the server keeps a last battery save that comes after this page has gone – never when the save on
    // disk couldn't be read: the game started without it, and its save must not replace the real one)
    body: JSON.stringify({ rom: q.get('rom'), key: q.get('key'), system: SYSTEM, save: save.bytes ? b64(save.bytes) : null, saveUrl: save.state === 'failed' ? null : q.get('save') }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return fail(serverErrorText(j, res.status));
  st.id = j.id;
  st.core = j.core;
  st.model = j.model || null;
  st.sram = save.bytes;
  st.bootSave = save.state;
  const stop = () => fetch('/api/native/stop', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ id: st.id }) }).catch(() => {});
  addEventListener('pagehide', stop);
  // A game that never shows a picture (a core stuck while loading it) goes to the browser emulator instead of leaving
  // the player black – the biggest DS games load in a second or two.
  setTimeout(() => {
    if (st.ready || st.error) return;
    fail(t('native.noStart', 'The game didn’t start in the fast player.'));
    stop();
  }, BOOT_TIMEOUT_MS);
  startPump();
}
/** A link session the play view started (web/lib/linksession.mjs): attach to it. The server booted it with the run's save. */
function startLinked(status, save) {
  st.id = LINK_SESSION;
  st.core = 'link';
  st.sram = save.bytes;
  st.bootSave = 'loaded';
  addEventListener('pagehide', () => fetch('/api/native/stop', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ id: st.id }) }).catch(() => {}));
  startPump();
}
start();
