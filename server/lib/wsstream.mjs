// The players' host streams over a WebSocket (#38). The 3DS player and the fast player sent the host's pictures, sound
// and memory to the page as ONE endless HTTP response (application/octet-stream, ~25 MB/s for a 3DS game). Antivirus
// with HTTP scanning (a "web shield") buffers a response body until it ends to scan it – on Windows in
// C:\Windows\Temp, ~30 GB for an evening of play, freed only when the game closed. A WebSocket's frames are no HTTP
// body: nothing waits for an end.
//
// Only what the players need, no library: the handshake (RFC 6455 §4.2), binary frames from the server, and the
// control frames a browser sends (close, ping). The page's commands go by POST as before; all it sends here is how
// much it has handled (an 8-byte message: the bytes so far, a float64) – web/lib/hoststream.mjs.
// `acceptStream()` hands back an object that writes like the HTTP response did (write → false when the page is behind,
// then 'drain'; end; 'close'; destroyed / writableEnded), so the sessions keep holding a slow page's host back the same
// way (server/lib/ctr.mjs forward / release). A fetch stream did that through TCP: the page read only what it handled.
// A browser reads a WebSocket off the network at once and queues the messages in the page – so the page says what it
// has handled, and no more than WINDOW bytes (plus the message being written) are on their way.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * How far the host may be ahead of the page: about what the TCP buffers of the HTTP stream held (a few 3DS pictures
 * at 1×, one at 3×) – latency stays as it was, and a page that stops reading stops the host.
 */
export const WINDOW = 2 * 1024 * 1024;

/** The Sec-WebSocket-Accept answer to a client's key. */
export const acceptKey = (key) => createHash('sha1').update(`${key}${GUID}`).digest('base64');

/** A frame header for a server → client frame (FIN set, unmasked) carrying `len` bytes of opcode `op`. */
export function frameHeader(op, len) {
  if (len < 126) return Buffer.from([0x80 | op, len]);
  if (len < 0x10000) {
    const h = Buffer.alloc(4);
    h[0] = 0x80 | op;
    h[1] = 126;
    h.writeUInt16BE(len, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = 0x80 | op;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h;
}

/**
 * The client's frames as they come in pieces → calls onFrame(opcode, payload) per whole frame (unmasked). Returns
 * the feeder. A frame without the client's mask, or one bigger than `max`, is a protocol error → onError().
 */
export function frameReader(onFrame, onError, max = 1 << 16) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(max)) return onError();
        len = Number(big);
        at = 10;
      }
      if (!masked || len > max) return onError();
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(at + 4 + len);
      onFrame(op, payload);
    }
  };
}

/** A WebSocket the server only sends on – written like an HTTP response (see the top of the file). */
class StreamSocket extends EventEmitter {
  constructor(socket, { window = WINDOW } = {}) {
    super();
    this.socket = socket;
    this.ended = false;
    this.window = window;
    this.sent = 0; // the binary messages' bytes written
    this.handled = 0; // what the page says it has handled of them
    this.full = false; // the socket's own buffer is full
    this.waiting = false; // a write said "wait": 'drain' is owed
    socket.setNoDelay(true);
    socket.on('drain', () => {
      this.full = false;
      this.maybeDrain();
    });
    socket.on('error', () => {}); // ('close' follows)
    socket.on('close', () => {
      this.ended = true;
      this.emit('close');
    });
    socket.on('data', frameReader((op, payload) => {
      if (op === 0x8) this.end(); // the page closes it
      else if (op === 0x9) this.raw(0xa, payload); // ping → pong
      else if (op === 0x2 && payload.length === 8) {
        const n = payload.readDoubleLE(0);
        if (Number.isFinite(n) && n > this.handled && n <= this.sent) {
          this.handled = n;
          this.maybeDrain();
        }
      }
    }, () => socket.destroy()));
  }

  /** The page is behind by more than the window, or the socket is full. */
  behind() {
    return this.full || this.sent - this.handled > this.window;
  }

  maybeDrain() {
    if (this.waiting && !this.behind()) {
      this.waiting = false;
      this.emit('drain');
    }
  }

  get destroyed() {
    return this.socket.destroyed;
  }

  get writableEnded() {
    return this.ended;
  }

  raw(op, payload) {
    if (this.ended || this.socket.destroyed) return false;
    // (header and payload leave as one write – no copy of a picture that can be 7 MB)
    this.socket.cork();
    this.socket.write(frameHeader(op, payload.length));
    const room = this.socket.write(payload);
    this.socket.uncork();
    return room;
  }

  /** One binary message (one of the host's messages). false: the page is behind – wait for 'drain'. */
  write(data) {
    if (this.ended || this.socket.destroyed) return false;
    if (!this.raw(0x2, data)) this.full = true;
    this.sent += data.length;
    if (!this.behind()) return true;
    this.waiting = true;
    return false;
  }

  /** Close it (a normal close: 1000). */
  end() {
    if (this.ended) return;
    if (!this.socket.destroyed) {
      this.socket.write(frameHeader(0x8, 2));
      this.socket.end(Buffer.from([0x03, 0xe8]));
    }
    this.ended = true;
  }
}

/**
 * Answer a WebSocket upgrade (the 'upgrade' event's req and socket) → the StreamSocket, or null when it isn't a valid
 * WebSocket request (then a 400 went back and the socket is closed). The caller checks who asks (Host, Origin) first.
 * `opts.window`: see WINDOW (tests).
 */
export function acceptStream(req, socket, opts = {}) {
  const key = req.headers['sec-websocket-key'];
  const ok = req.method === 'GET' && String(req.headers.upgrade || '').toLowerCase() === 'websocket' && req.headers['sec-websocket-version'] === '13'
    && typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
  if (!ok) {
    refuse(socket, 400);
    return null;
  }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
  return new StreamSocket(socket, opts);
}

/** An upgrade that isn't accepted: a plain HTTP answer, then the socket goes. */
export function refuse(socket, status = 403) {
  const text = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found' }[status] || 'Error';
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}
