// A link session that falls out of step puts the run's save back to what it was before the session
// (/api/link/restore) – also after a rejoin, when the save on disk already holds the session's own in-game saves; and
// only into the save the session played. A fake link host (it just reads its commands) stands in for the real one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const DATA = mkdtempSync(join(tmpdir(), 'souldew-linkrestore-'));
const TOOLS = join(DATA, 'bundled');
process.env.SLS_DATA_DIR = DATA;
process.env.SLS_TOOLS_DIR = TOOLS;
process.env.SLS_ACCOUNTS_URL = 'http://127.0.0.1:9';
process.env.SOULDEW_LINK_ICE = 'off';
const { PLATFORM_DIR } = await import('../server/lib/ctr.mjs');
if (process.platform !== 'win32') {
  const dir = join(TOOLS, 'native', PLATFORM_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'linkhost'), '#!/bin/sh\nexec cat >/dev/null\n');
  chmodSync(join(dir, 'linkhost'), 0o755);
}
const { startServer, defaultSavePath } = await import('../server/app.mjs');
const { buildRun, readManifest } = await import('../server/lib/build.mjs');

mkdirSync(join(DATA, 'Library'), { recursive: true });
const ROM = join(DATA, 'Library', 'Fake.gb');
writeFileSync(ROM, Buffer.alloc(0x8000, 7));
let server = null;
after(() => {
  server?.close();
  rmSync(DATA, { recursive: true, force: true });
});

test('desync after a rejoin: the save goes back to the one from before the session, not to one from its middle', { skip: process.platform === 'win32' }, async () => {
  const s = await startServer({ port: 0, background: false });
  server = s.server;
  const base = `http://127.0.0.1:${s.port}`;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const built = await buildRun({ romId: ROM, randomize: false, config: {}, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } } });
  const m = readManifest(built.id);
  const save = defaultSavePath(m, 'p1');
  writeFileSync(save, Buffer.from('before the session'));
  const check = await fetch(`${base}/api/link/check?runId=${m.id}`, { headers: { 'x-soullink': '1' } }).then((r) => r.json());
  const seats = ['p1', 'p2'].map((slot) => ({ slot, sha1: check.slots[slot].sha1, ...(slot === 'p2' ? { save: Buffer.from('partner').toString('base64') } : {}) }));
  const first = await post('/api/link/start', { runId: m.id, local: 'p1', seats, delay: 2 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // a trade: the game saves – the play view writes it into the run
  writeFileSync(save, Buffer.from('after the trade'));
  // the page reloads (the host stops), then rejoins from the state the partner kept
  assert.equal((await post('/api/native/stop', { id: first.body.id })).status, 200);
  const again = await post('/api/link/start', { runId: m.id, local: 'p1', seats, delay: 2, state: deflateRawSync(Buffer.from('session state')).toString('base64') });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  // a restore for another player's save of this run: refused, nothing written
  assert.equal((await post('/api/link/restore', { runId: m.id, id: again.body.id, slot: 'p2' })).status, 400);
  // out of step
  const r = await post('/api/link/restore', { runId: m.id, id: again.body.id, slot: 'p1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, true);
  assert.equal(readFileSync(save, 'utf8'), 'before the session');
  assert.equal(readFileSync(join(save, '..', r.body.backup), 'utf8'), 'after the trade', 'the session\'s save kept as a backup');
});
