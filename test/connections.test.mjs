// Invite files arriving at the import route: anything malformed is a 400 with a translatable code (never a
// 500 or a bare German message), a pack can be imported twice, and the host's own run is not replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-conn-'));
process.env.SLS_DATA_DIR = DATA;
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const pack = (o = {}) => ({
  format: 'soullink-studio/run-pack@1', id: 'a1b2c3d4', name: 'Duo', room: 'room-0123456789', secret: 'SECRET-ROOM-KEY-0f9e8d7c', mode: 'soullink',
  players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, base: { crc: 'E25703ED', name: 'Fake.gb' }, patch: null,
  randomizer: { enabled: false, values: {}, seeds: { p1: '1', p2: '2' } }, outputs: { p1: { sha1: 'x' } }, rules: null, game: null, ...o,
});

test('import route: damaged invites get a 400 with a code the app translates; importing twice is fine', async () => {
  const { server, url } = await startServer({ port: 0, background: false });
  const post = async (body) => {
    const r = await fetch(`${url}/api/runs/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    for (const body of [{ pack: { ...pack(), format: 'other' } }, { pack: 'hello' }, { pack: null }, { pack: [1] }, {}]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'packInvalid');
    }
    for (const id of ['zz', 5, '../../etc', 'A1B2C3D4']) {
      const r = await post({ pack: pack({ id }) });
      assert.equal(r.status, 400, String(id));
      assert.equal(r.body.code, 'packBroken');
      assert.equal(r.body.vars.what, 'id');
    }
    const r = await post({ pack: pack({ secret: 5 }) });
    assert.deepEqual([r.status, r.body.code, r.body.vars.what], [400, 'packBroken', 'secret']);
    const a = await post({ pack: pack() });
    const b = await post({ pack: pack({ name: 'Duo 2' }) });
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(b.body.name, 'Duo 2');
    assert.equal(b.body.imported, true);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a run with a shiny rate travels in the pack format 2.7.4 refuses; this app reads both, and says "update" for a later one', async () => {
  const { runPack } = await import('../server/lib/build.mjs');
  const { PACK_FORMAT, PACK_FORMAT_SHINY, PACK_FORMAT_SHINY_ANY, PACK_FORMATS, SHINY_MIN_VERSION, SHINY_ANY_MIN_VERSION, packFormatState } = await import('../shared/runpack.mjs');
  const { PACK_FORMATS: CODE_FORMATS } = await import('../web/lib/invitecode.mjs');
  const m = { id: 'a1b2c3d4', name: 'Duo', room: 'r', secret: 's', players: {}, outputs: {} };
  // 2.7.4 accepts exactly 'soullink-studio/run-pack@1' (server/app.mjs and web/lib/invitecode.mjs of 2.7.4)
  assert.equal(runPack(m).format, PACK_FORMAT);
  assert.equal(runPack(m).minVersion, undefined, 'a plain run: older players can still join');
  const shiny = runPack({ ...m, shiny: { rate: 512, trainers: false } });
  assert.notEqual(shiny.format, 'soullink-studio/run-pack@1', '2.7.4 refuses it instead of building the normal odds');
  assert.deepEqual([shiny.format, shiny.minVersion], [PACK_FORMAT_SHINY, '2.8.0']);
  assert.equal(SHINY_MIN_VERSION, '2.8.0');
  // a rate 2.8.0 doesn't know (2.8.1: any rate): 2.8.0 reads @2 and would turn it into the normal odds – @3 it refuses
  const custom = runPack({ ...m, shiny: { rate: 100, trainers: false } });
  assert.deepEqual([custom.format, custom.minVersion], [PACK_FORMAT_SHINY_ANY, '2.8.1']);
  assert.equal(SHINY_ANY_MIN_VERSION, '2.8.1');
  assert.ok(!['soullink-studio/run-pack@1', 'soullink-studio/run-pack@2'].includes(custom.format), '2.8.0 reads only @1 and @2');
  assert.equal(runPack({ ...m, shiny: { rate: 8192, trainers: true } }).format, PACK_FORMAT_SHINY, 'trainer shinies alone: 2.8.0 knows them');
  assert.deepEqual(CODE_FORMATS, PACK_FORMATS, 'the code invite reads the same formats as the import route');
  assert.deepEqual(['ok', 'ok', 'ok', 'newer', 'invalid', 'invalid'], [pack(), pack({ format: PACK_FORMAT_SHINY }), pack({ format: PACK_FORMAT_SHINY_ANY }), pack({ format: 'soullink-studio/run-pack@7' }), pack({ format: 'other' }), null].map(packFormatState));

  const { server, url } = await startServer({ port: 0, background: false });
  const post = async (body) => {
    const r = await fetch(`${url}/api/runs/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const ok = await post({ pack: pack({ id: 'b1b2c3d4', format: PACK_FORMAT_SHINY, minVersion: '2.8.0', shiny: { rate: 256, trainers: true } }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.shiny, { rate: 256, trainers: true }, 'the partner\'s game gets the same rate');
    const any = await post({ pack: pack({ id: 'd1b2c3d4', format: PACK_FORMAT_SHINY_ANY, minVersion: '2.8.1', shiny: { rate: 100, trainers: false } }) });
    assert.equal(any.status, 200);
    assert.deepEqual(any.body.shiny, { rate: 100, trainers: false }, 'a custom rate arrives as it is');
    const later = await post({ pack: pack({ id: 'c1b2c3d4', format: 'soullink-studio/run-pack@6', minVersion: '3.1.0' }) });
    assert.deepEqual([later.status, later.body.code, later.body.vars?.version], [400, 'packNewer', '3.1.0']);
    const unnamed = await post({ pack: pack({ id: 'c1b2c3d4', format: 'soullink-studio/run-pack@6', minVersion: '../x' }) });
    assert.deepEqual([unnamed.status, unnamed.body.code], [400, 'packNewerAny']);
  } finally {
    server.close();
  }
  // the host is told where the invite is handed out
  const { readFileSync } = await import('node:fs');
  const board = readFileSync(new URL('../web/views/board.mjs', import.meta.url), 'utf8');
  const link = readFileSync(new URL('../web/views/link.mjs', import.meta.url), 'utf8');
  assert.match(board.slice(board.indexOf('export function InviteBody')), /<\$\{PackVersionNote\} manifest=\$\{manifest\} \/>\n {4}<\$\{HostCode\}/);
  assert.match(link, /<\$\{PackVersionNote\} manifest=\$\{manifest\} \/>/);
});
