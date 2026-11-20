// Partner screen over the relay path: still pictures are encrypted, sent on their own non-retained topic,
// only while the partner watches, and decode back to the same bytes on the other side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SyncLink, screenFrame, readScreenFrame } from '../web/lib/sync.mjs';

/** In-memory MQTT broker: every client subscribed to `prefix/#` gets every publish (async, like a socket). */
function fakeMqtt() {
  const clients = new Set();
  const log = [];
  const mod = {
    connect() {
      const c = new EventEmitter();
      c.connected = false;
      c.subs = [];
      c.subscribe = (pattern) => c.subs.push(pattern.replace(/#$/, ''));
      c.publish = (topic, payload, opts = {}) => {
        const buf = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload);
        log.push({ topic, size: buf.length, opts, buf });
        for (const o of clients) if (o.connected && o.subs.some((p) => topic.startsWith(p))) setTimeout(() => o.emit('message', topic, buf), 1);
      };
      c.end = () => {
        c.connected = false;
        clients.delete(c);
      };
      clients.add(c);
      setTimeout(() => {
        c.connected = true;
        c.emit('connect');
      }, 1);
      return c;
    },
  };
  return { importer: async () => mod, log };
}

// Trystero stand-in that never finds a peer (relay-only tests).
const noP2P = async () => ({
  joinRoom: () => ({ makeAction: () => ({ send() {}, onMessage: null }), leave() {}, getPeers: () => ({}) }),
});

/** In-memory Trystero: two rooms see each other, 'ops' messages and addStream() reach the other side. */
function fakeTrystero() {
  const rooms = [];
  const mod = {
    joinRoom() {
      const id = `peer${rooms.length}`;
      const room = { id, actions: {}, streams: [], left: false };
      room.makeAction = (name) => (room.actions[name] = { send(msg) { for (const o of rooms) if (o !== room && !o.left) setTimeout(() => o.actions[name]?.onMessage?.(structuredClone(msg), { peerId: id }), 1); } });
      room.addStream = (stream, { target, metadata }) => {
        room.streams.push(stream);
        for (const o of rooms) if (o.id === target) setTimeout(() => o.onPeerStream?.(stream, id, metadata), 1);
        return [Promise.resolve()];
      };
      room.removeStream = (stream) => { room.streams = room.streams.filter((x) => x !== stream); };
      room.getPeers = () => ({});
      room.leave = () => {
        room.left = true;
        for (const o of rooms) if (o !== room && !o.left) o.onPeerLeave?.(id);
      };
      rooms.push(room);
      if (rooms.length === 2) setTimeout(() => { rooms[0].onPeerJoin?.(rooms[1].id); rooms[1].onPeerJoin?.(rooms[0].id); }, 5);
      return room;
    },
  };
  return async () => mod;
}

function fakeStream() {
  const track = { kind: 'video', readyState: 'live', enabled: true, contentHint: '', stop() { this.readyState = 'ended'; }, getSettings: () => ({ width: 768 }), addEventListener() {} };
  return { id: 's1', track, getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track], removeTrack() {}, addEventListener() {} };
}
const stubDoc = () => ({ onLocalChange: () => () => {}, entries: {}, merge: () => false });
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};
const pair = (broker) => ['p1', 'p2'].map((slot) => new SyncLink({
  room: 'room-x', secret: 'secret-y', slot, name: slot, doc: stubDoc(), importers: { mqtt: broker.importer, trystero: noP2P },
}));
// Fake JPEG with incompressible bytes so the size checks are realistic.
const jpeg = (n) => {
  const u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = (i * 2654435761) >>> 24;
  u8.set([0xff, 0xd8, 0xff]);
  return u8;
};

test('screenFrame / readScreenFrame round trip and validation', async () => {
  const bytes = jpeg(5000);
  const msg = screenFrame('p1', bytes, 'image/jpeg', 'nds', 123);
  assert.equal(msg.kind, 'screen-frame');
  const back = readScreenFrame(JSON.parse(JSON.stringify(msg)));
  assert.deepEqual(back.bytes, bytes);
  assert.equal(back.blob.type, 'image/jpeg');
  assert.equal(back.system, 'nds');
  assert.deepEqual(new Uint8Array(await back.blob.arrayBuffer()), bytes);
  assert.equal(readScreenFrame({ ...msg, mime: 'image/svg+xml' }), null);
  assert.equal(readScreenFrame({ ...msg, data: 'x'.repeat(200000) }), null);
  assert.equal(readScreenFrame({ ...msg, data: 42 }), null);
  assert.equal(readScreenFrame(null), null);
});

test('pictures reach the watching partner over the relay, encrypted and not retained', async () => {
  const broker = fakeMqtt();
  const [a, b] = pair(broker);
  try {
    await Promise.all([a.start(), b.start()]);
    await until(() => a.status.relay === 'connected' && b.status.relay === 'connected');
    const bytes = jpeg(9000);
    let shots = 0;
    a.startScreenShare({ system: 'gba', isActive: () => true, getSnapshot: async (o) => (shots++, assert.ok(o.maxW <= 192), new Blob([bytes], { type: 'image/jpeg' })) });
    const views = [];
    const unwatch = b.watchPartnerScreen((v) => views.push(v));
    const got = await until(() => views.find((v) => v.mode === 'image' && v.blob));
    assert.equal(got.active, true);
    assert.equal(got.system, 'gba');
    assert.deepEqual(new Uint8Array(await got.blob.arrayBuffer()), bytes);
    assert.ok(got.url?.startsWith('blob:'));
    const screenPubs = broker.log.filter((m) => m.topic.endsWith('/screen/p1'));
    assert.ok(screenPubs.length >= 2, 'state + frame');
    assert.ok(screenPubs.every((m) => m.opts.retain === false));
    assert.ok(screenPubs.every((m) => m.size < 20 * 1024));
    // the plaintext never travels: the JPEG magic must not appear in what the broker saw
    const raw = Buffer.from(bytes.subarray(100, 160));
    const b64 = Buffer.from(Buffer.from(bytes).toString('base64').slice(200, 260));
    assert.ok(screenPubs.every((m) => !m.buf.includes(raw) && !m.buf.includes(b64)));

    // viewer stops watching → sender stops sending pictures
    unwatch();
    await until(() => a.partnerWants === 0);
    await new Promise((r) => setTimeout(r, 1700));
    const n = shots;
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal(shots, n, 'no more snapshots once nobody watches');
  } finally {
    a.stop();
    b.stop();
  }
});

test('nothing is sent to a partner that never asks (older app version)', async () => {
  const broker = fakeMqtt();
  const [a, b] = pair(broker);
  try {
    await Promise.all([a.start(), b.start()]);
    await until(() => a.status.relay === 'connected');
    let shots = 0;
    a.startScreenShare({ isActive: () => true, getSnapshot: async () => (shots++, new Blob([jpeg(100)], { type: 'image/jpeg' })) });
    await new Promise((r) => setTimeout(r, 3300));
    assert.equal(shots, 0);
    assert.equal(broker.log.filter((m) => m.topic.includes('/screen/')).length, 0);
    // unknown / malformed screen messages from a newer or broken partner are ignored
    assert.doesNotThrow(() => b._receive({ kind: 'screen-future', from: 'p1' }, 'relay'));
    assert.doesNotThrow(() => b._receive({ kind: 'screen-frame', from: 'p1', data: '%%%', mime: 'image/jpeg' }, 'relay'));
  } finally {
    a.stop();
    b.stop();
  }
});

test('no game running → no pictures, partner told it is inactive', async () => {
  const broker = fakeMqtt();
  const [a, b] = pair(broker);
  try {
    await Promise.all([a.start(), b.start()]);
    await until(() => a.status.relay === 'connected' && b.status.relay === 'connected');
    let playing = true;
    a.startScreenShare({ isActive: () => playing, getSnapshot: async () => new Blob([jpeg(800)], { type: 'image/jpeg' }) });
    const views = [];
    b.watchPartnerScreen((v) => views.push(v));
    await until(() => views.some((v) => v.mode === 'image' && v.blob));
    playing = false;
    const last = await until(() => views.at(-1).known && !views.at(-1).active && views.at(-1));
    assert.equal(last.url, null);
    assert.equal(last.paused, false); // the game itself stopped – not just a hidden tab
  } finally {
    a.stop();
    b.stop();
  }
});

// Trailer take "approach": Lena opened Shared World's A menu (it pauses her game) and Tim's tile went black with
// "Lena isn't playing right now" for ~1.6 s, then came back blurry. A paused game keeps its picture – marked held.
test('paused game (A menu, pause button) → the picture stays, marked held, unchanged pictures not resent', async () => {
  const broker = fakeMqtt();
  const [a, b] = pair(broker);
  try {
    await Promise.all([a.start(), b.start()]);
    await until(() => a.status.relay === 'connected' && b.status.relay === 'connected');
    let paused = false;
    let shots = 0;
    const bytes = jpeg(800);
    a.startScreenShare({ isActive: () => true, isPaused: () => paused, getSnapshot: async () => (shots++, new Blob([bytes], { type: 'image/jpeg' })) });
    const views = [];
    b.watchPartnerScreen((v) => views.push(v));
    await until(() => views.some((v) => v.mode === 'image' && v.blob));
    paused = true;
    const held = await until(() => views.at(-1).held && views.at(-1));
    assert.equal(held.active, true);
    assert.equal(held.mode, 'image');
    assert.ok(held.url || held.blob, 'the last picture is still there');
    assert.ok(views.every((v) => !v.known || v.active), 'never told the game stopped');
    const frames = () => broker.log.filter((m) => m.topic.endsWith('/screen/p1') && m.size > 1000).length;
    const before = frames();
    await new Promise((r) => setTimeout(r, 3300)); // two more steps: the same picture isn't sent again (resendSame)
    assert.equal(frames(), before);
    assert.ok(shots > 0);
    paused = false;
    await until(() => views.at(-1).active && !views.at(-1).held);
  } finally {
    a.stop();
    b.stop();
  }
});

test('browser tab in the background → partner told the picture is paused, not that nobody plays', async () => {
  const broker = fakeMqtt();
  const [a, b] = pair(broker);
  const had = 'document' in globalThis;
  const prev = globalThis.document;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  try {
    await Promise.all([a.start(), b.start()]);
    await until(() => a.status.relay === 'connected' && b.status.relay === 'connected');
    a.startScreenShare({ isActive: () => true, getSnapshot: async () => new Blob([jpeg(800)], { type: 'image/jpeg' }) });
    const views = [];
    b.watchPartnerScreen((v) => views.push(v));
    await until(() => views.some((v) => v.mode === 'image' && v.blob));
    globalThis.document.hidden = true;
    const last = await until(() => views.at(-1).known && !views.at(-1).active && views.at(-1));
    assert.equal(last.paused, true);
    globalThis.document.hidden = false;
    await until(() => views.at(-1).active && !views.at(-1).paused);
  } finally {
    a.stop();
    b.stop();
    if (had) globalThis.document = prev;
    else delete globalThis.document;
  }
});

test('stop() during start() and after sharing leaves no timers behind', async () => {
  const broker = fakeMqtt();
  const [a, b] = pair(broker);
  const starting = a.start();
  a.startScreenShare({ getSnapshot: async () => null }); // before the key exists
  const views = [];
  a.watchPartnerScreen((v) => views.push(v));
  a.stop();
  await starting;
  assert.equal(a.share, null);
  assert.equal(a.wantTimer, null);
  assert.equal(a.screenWatchers.size, 0);
  a.startScreenShare({ getSnapshot: async () => null }); // no-op once stopped
  assert.equal(a.share, null);
  assert.equal(views.at(-1).active, false);
  b.stop();
});

test('direct link: the game goes out as a video stream; paused → track kept on (held), no game → track disabled', async () => {
  const broker = fakeMqtt();
  const trystero = fakeTrystero();
  const [a, b] = ['p1', 'p2'].map((slot) => new SyncLink({
    room: 'room-z', secret: 'secret-z', slot, name: slot, doc: stubDoc(), importers: { mqtt: broker.importer, trystero },
  }));
  try {
    await Promise.all([a.start(), b.start()]);
    await until(() => a.status.p2p === 'connected' && b.status.p2p === 'connected');
    const stream = fakeStream();
    let playing = true;
    let paused = false;
    let shots = 0;
    a.startScreenShare({ system: 'nds', isActive: () => playing, isPaused: () => paused, getStream: () => stream, getSnapshot: async () => (shots++, null) });
    const views = [];
    b.watchPartnerScreen((v) => views.push(v));
    const got = await until(() => views.find((v) => v.mode === 'stream' && v.stream));
    assert.equal(got.stream, stream);
    assert.equal(got.system, 'nds');
    assert.equal(stream.track.enabled, true);
    assert.equal(stream.track.contentHint, 'detail', 'pixel art: sharp, frames given up under load rather than resolution');
    assert.equal(shots, 0, 'no stills while the video runs');
    assert.equal(broker.log.filter((m) => m.topic.endsWith('/screen/p1') && m.size > 2000).length, 0);
    // paused: a disabled track would send black frames and restart the encoder blurry when turned on again
    paused = true;
    const held = await until(() => views.at(-1).held && views.at(-1));
    assert.equal(held.active, true);
    assert.equal(held.stream, stream, 'the same stream – nothing renegotiated');
    assert.equal(stream.track.enabled, true);
    assert.equal(stream.track.readyState, 'live');
    assert.equal(shots, 0, 'no switch to stills');
    paused = false;
    await until(() => views.at(-1).active && !views.at(-1).held);
    assert.equal(views.at(-1).stream, stream);
    playing = false;
    await until(() => views.at(-1).known && !views.at(-1).active);
    assert.equal(stream.track.enabled, false);
    a.stopScreenShare();
    assert.equal(stream.track.readyState, 'ended');
  } finally {
    a.stop();
    b.stop();
  }
});


test('a change made right before leaving the run still reaches the partner (and the retained snapshot)', async () => {
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const broker = fakeMqtt();
  const docs = ['p1', 'p2'].map((by) => Object.assign(new RunDoc('room-x'), { by, _persistSoon() {} }));
  const [a, b] = ['p1', 'p2'].map((slot, i) => new SyncLink({
    room: 'room-x', secret: 'secret-y', slot, name: slot, doc: docs[i], importers: { mqtt: broker.importer, trystero: noP2P },
  }));
  try {
    await Promise.all([a.start(), b.start()]);
    await until(() => a.status.relay === 'connected' && b.status.relay === 'connected');
    docs[0].set('run:restart', { id: 'abcd1234' });
    a.stop(); // switching runs immediately – before the 120 ms flush and the 3 s snapshot timer
    await until(() => docs[1].get('run:restart')?.id === 'abcd1234');
    await until(() => broker.log.some((m) => m.topic.endsWith('/state/p1') && m.opts.retain));
  } finally {
    a.stop();
    b.stop();
  }
});
