// The players' host streams over a WebSocket (#38, server/lib/wsstream.mjs + web/lib/hoststream.mjs). As one endless
// HTTP response, antivirus with HTTP scanning ("web shield") on Windows kept the 3DS player's whole stream in
// C:\Windows\Temp until the game was closed (~25 MB/s). Here: the frames, the page's "handled so far" holding a host
// back the way TCP did, the app server's checks on the upgrade, and the sessions taking the socket like a response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { acceptStream, acceptKey, frameHeader, frameReader, WINDOW } from '../server/lib/wsstream.mjs';
import { socketReader, openHostStream, ACK_BYTES } from '../web/lib/hoststream.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'sls-wsstream-'));
process.env.SLS_DATA_DIR = join(TMP, 'data');
process.env.SLS_TOOLS_DIR = join(TMP, 'tools');
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
};

/** A server whose upgrades become StreamSockets (handed to `onStream`). */
async function wsServer(onStream, opts) {
  const server = createServer((req, res) => res.end('http'));
  server.on('upgrade', (req, socket) => {
    const s = acceptStream(req, socket, opts);
    if (s) onStream(s);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `ws://127.0.0.1:${server.address().port}/s` };
}

test('wsstream: the handshake answer (RFC 6455\'s example) and frame headers of every length class', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.deepEqual([...frameHeader(2, 5)], [0x82, 5]);
  assert.deepEqual([...frameHeader(2, 300)], [0x82, 126, 1, 44]);
  assert.deepEqual([...frameHeader(2, 0x10000)], [0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0]);
  // the page's frames are masked; one in pieces still reads whole
  const got = [];
  const feed = frameReader((op, p) => got.push([op, [...p]]), () => got.push('error'));
  const mask = [1, 2, 3, 4];
  const payload = [10, 20, 30, 40, 50, 60, 70, 80];
  const frame = Buffer.from([0x82, 0x80 | 8, ...mask, ...payload.map((b, i) => b ^ mask[i & 3])]);
  feed(frame.subarray(0, 3));
  feed(frame.subarray(3));
  assert.deepEqual(got, [[2, payload]]);
  feed(Buffer.from([0x82, 4, 1, 2, 3, 4])); // unmasked from a client: refused
  assert.equal(got.at(-1), 'error');
});

test('wsstream: every host message arrives whole and in order; a page that stops reading holds the host back, reading on releases it', async () => {
  let stream = null;
  const { server, url } = await wsServer((s) => { stream = s; }, { window: 64 * 1024 });
  try {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const reader = socketReader(ws);
    assert.ok(await until(() => stream));
    const msg = (n, size) => Buffer.alloc(size, n & 0xff);
    // within the window: write says "go on"
    assert.equal(stream.write(msg(1, 1000)), true);
    // a 3DS picture bigger than the whole window still goes out – then the host waits
    assert.equal(stream.write(msg(2, 200 * 1024)), false);
    let drained = false;
    stream.once('drain', () => { drained = true; });
    const a = await reader.read();
    const b = await reader.read();
    assert.equal(a.value.length, 1000);
    assert.equal(b.value[0], 2);
    assert.equal(b.value.length, 200 * 1024);
    assert.equal(drained, false, 'not before the page has said what it handled');
    // the next read says it (more than ACK_BYTES handed) – the host may write again
    const next = reader.read();
    assert.ok(await until(() => drained), 'drain once the page caught up');
    stream.write(msg(3, 10));
    assert.equal((await next).value[0], 3);
    // the page closes: the server side sees it
    let closed = false;
    stream.on('close', () => { closed = true; });
    await reader.cancel();
    assert.ok(await until(() => closed));
    assert.equal(stream.write(msg(4, 10)), false, 'nothing written after the end');
  } finally {
    server.close();
  }
  assert.ok(WINDOW >= 1024 * 1024 && WINDOW <= 8 * 1024 * 1024, 'about what the TCP buffers held');
  assert.ok(ACK_BYTES < WINDOW / 4, 'what isn\'t said yet never holds the host back');
});

test('wsstream: the server ends the stream (the game stopped) – the page reads to the end', async () => {
  let stream = null;
  const { server, url } = await wsServer((s) => { stream = s; });
  try {
    const reader = await openHostStream('/s', { where: { host: new URL(url).host, protocol: 'http:' } });
    assert.equal(reader.kind, 'ws');
    assert.ok(await until(() => stream));
    stream.write(Buffer.from([7, 7, 7]));
    stream.end();
    assert.deepEqual([...(await reader.read()).value], [7, 7, 7]);
    assert.equal((await reader.read()).done, true);
  } finally {
    server.close();
  }
});

test('hoststream: no WebSocket (refused, or none in this browser) – the HTTP stream as in 3.0.0', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
  const fetchFn = async (path) => ({ ok: path === '/api/ctr/stream?id=x', status: 200, body });
  const plain = await openHostStream('/api/ctr/stream?id=x', { WS: null, fetchFn, where: { host: 'localhost:1', protocol: 'http:' } });
  assert.equal(plain.kind, 'http');
  assert.deepEqual([...(await plain.read()).value], [1, 2]);
  // a server that refuses the upgrade (a plain HTTP server: 'upgrade' unanswered → the socket just closes)
  const server = createServer((req, res) => res.end());
  server.on('upgrade', (req, socket) => socket.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const body2 = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([3])); c.close(); } });
    const r = await openHostStream('/x', { fetchFn: async () => ({ ok: true, status: 200, body: body2 }), where: { host: `127.0.0.1:${server.address().port}`, protocol: 'http:' } });
    assert.equal(r.kind, 'http');
    // no session: the HTTP answer's error, as before
    await assert.rejects(openHostStream('/x', { WS: null, fetchFn: async () => ({ ok: false, status: 404 }), where: {} }), /stream 404/);
  } finally {
    server.close();
  }
});

test('app server: the stream upgrade only for the app\'s own pages and a running session; the players use it', async () => {
  const { startServer } = await import('../server/app.mjs');
  const { server } = await startServer({ port: 0, background: false });
  const port = server.address().port;
  const open = (path, headers) => new Promise((resolve) => {
    // a raw upgrade request: the status line says what the server answered
    import('node:net').then(({ connect }) => {
      const s = connect(port, '127.0.0.1', () => {
        s.write([`GET ${path} HTTP/1.1`, `Host: localhost:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...headers, '', ''].join('\r\n'));
      });
      let got = '';
      s.on('data', (d) => { got += d; if (got.includes('\r\n')) { s.destroy(); resolve(got.split('\r\n')[0]); } });
      s.on('error', () => resolve('error'));
      s.on('close', () => resolve(got.split('\r\n')[0] || 'closed'));
    });
  });
  try {
    const mine = `Origin: http://localhost:${port}`;
    assert.match(await open('/api/ctr/stream?id=nope', []), / 403 /, 'no Origin: not a page of the app');
    assert.match(await open('/api/ctr/stream?id=nope', ['Origin: https://evil.example']), / 403 /, 'another website');
    assert.match(await open('/api/native/stream?id=nope', [mine, 'Sec-Fetch-Site: cross-site']), / 403 /);
    assert.match(await open('/api/ctr/stream?id=nope', [mine]), / 404 /, 'no such game running');
    assert.match(await open('/api/native/stream?id=nope', [mine]), / 404 /);
    assert.match(await open('/api/runs', [mine]), / 404 /, 'nothing else upgrades');
  } finally {
    server.close();
  }
  // both players read their host through it
  for (const f of ['ctrplayer', 'nativeplayer']) {
    const src = readFileSync(new URL(`../web/lib/${f}.mjs`, import.meta.url), 'utf8');
    assert.match(src, /const reader = await openHostStream\(`\/api\/(ctr|native)\/stream\?id=\$\{st\.id\}`\);/, f);
    assert.doesNotMatch(src, /fetch\(`\/api\/(ctr|native)\/stream/, `${f}: no endless HTTP response any more`);
  }
  const ctr = readFileSync(new URL('../server/lib/ctr.mjs', import.meta.url), 'utf8');
  assert.match(ctr, /attachStream\(id, res\) \{\s*const s = this\.get\(id\);/);
});
