// The stream of a player's host (3DS: lib/ctrplayer.mjs, the fast player: lib/nativeplayer.mjs) – pictures, sound and
// memory, ~25 MB a second for a 3DS game. Over a WebSocket (#38): as one endless HTTP response, antivirus with HTTP
// scanning kept the whole body on disk until the game was closed (C:\Windows\Temp filled up). The server side:
// server/lib/wsstream.mjs. If a WebSocket can't be opened, the HTTP stream of 3.0.0 is the fallback.
//
// Read like a fetch body's reader: read() → { value: Uint8Array, done }, cancel(). The page says how much it has handled
// (every ACK_BYTES) – the server holds the host back while the page is more than its window
// behind, as TCP did for the HTTP stream.

/** How often the page tells the server what it has handled (bytes). */
export const ACK_BYTES = 256 * 1024;

/**
 * Open the stream at `path` ('/api/ctr/stream?id=…') → a reader, or throws (no session: 404). `WS` / `fetchFn` /
 * `where`: for tests.
 */
export async function openHostStream(path, { WS = globalThis.WebSocket, fetchFn = globalThis.fetch, where = globalThis.location } = {}) {
  if (WS && where?.host) {
    const ws = await openSocket(WS, `${where.protocol === 'https:' ? 'wss' : 'ws'}://${where.host}${path}`).catch(() => null);
    if (ws) return socketReader(ws);
  }
  const res = await fetchFn(path);
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  const reader = res.body.getReader();
  return { kind: 'http', read: () => reader.read(), cancel: () => reader.cancel().catch(() => {}) };
}

/** A WebSocket once it is open – or a rejection (refused, no session, closed before it opened). */
function openSocket(WS, url) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WS(url);
    } catch (e) {
      reject(e);
      return;
    }
    ws.binaryType = 'arraybuffer';
    const done = (ok) => {
      ws.onopen = ws.onerror = null;
      if (ok) resolve(ws);
      else {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // closing anyway
        }
        reject(new Error('no WebSocket'));
      }
    };
    ws.onopen = () => done(true);
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}

/** The fetch-reader shape over an open WebSocket, with the "handled so far" messages back to the server. */
export function socketReader(ws) {
  const queue = [];
  let waiting = null;
  let closed = false;
  let handed = 0; // bytes handed to the page
  let told = 0; // what the server was told
  const ack = new DataView(new ArrayBuffer(8));
  const tell = () => {
    if (handed === told || closed) return;
    told = handed;
    ack.setFloat64(0, handed, true);
    try {
      ws.send(ack.buffer.slice(0));
    } catch {
      // closing
    }
  };
  ws.onmessage = (e) => {
    const value = new Uint8Array(e.data);
    if (waiting) {
      const w = waiting;
      waiting = null;
      handed += value.length;
      w({ value, done: false });
    } else queue.push(value);
  };
  ws.onclose = ws.onerror = () => {
    closed = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w({ value: undefined, done: true });
    }
  };
  return {
    kind: 'ws',
    // the page asks for the next piece: everything handed before is handled – said once a quarter MB has piled up, and
    // whenever the page has read all there is (then it waits for more: it must never wait on a server that waits for it)
    read() {
      if (handed - told >= ACK_BYTES || !queue.length) tell();
      if (queue.length) {
        const value = queue.shift();
        handed += value.length;
        return Promise.resolve({ value, done: false });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    cancel() {
      closed = true;
      try {
        ws.close();
      } catch {
        // gone
      }
      return Promise.resolve();
    },
  };
}
