// Regression tests from the 3.0 release review (one block per fix).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'souldew-review30-'));
// a service address on this computer nobody answers at: nothing leaves the machine
process.env.SLS_ACCOUNTS_URL = 'http://127.0.0.1:9';
const { startServer } = await import('../server/app.mjs');

const servers = [];
after(() => {
  for (const s of servers) s.close();
});

test('a souldew+ preview that can\'t be had is a 404 answer, never an unhandled rejection that leaves the request hanging', async () => {
  const unhandled = [];
  const onRejection = (e) => unhandled.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    const s = await startServer({ port: 0, background: false });
    servers.push(s.server);
    const r = await fetch(`http://127.0.0.1:${s.port}/api/plus/previews/file?path=banners/none.png`, { headers: { 'x-soullink': '1' }, signal: AbortSignal.timeout(20000) });
    assert.equal(r.status, 404);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(unhandled.map((e) => e?.message), []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('signing out while a token refresh is on its way: the late answer doesn\'t sign the player back in', async () => {
  const { createSession } = await import('../server/lib/accounts/session.mjs');
  let stored = { access: 'a'.repeat(20), accessExp: 0, refresh: 'r'.repeat(20), sid: null, service: 'http://127.0.0.1:9', account: { id: 'u_1' } };
  const store = { load: () => stored, save: (v) => (stored = v), clear: () => (stored = null), persistent: () => true };
  let release;
  const gate = new Promise((res) => (release = res));
  const json = (status, body) => ({ status, json: async () => body, headers: new Headers() });
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (url.endsWith('/auth/token') && body.grant_type === 'refresh_token') {
      await gate;
      return json(200, { access_token: 'b'.repeat(20), refresh_token: 's'.repeat(20), expires_in: 900 });
    }
    if (url.endsWith('/auth/logout')) return json(200, {});
    return json(200, {});
  };
  const s = createSession({ store, port: () => 1, fetchImpl, env: { SLS_ACCOUNTS_URL: 'http://127.0.0.1:9' } });
  await s.load();
  assert.equal(s.signedIn, true);
  const pending = s.request('/v1/me'); // the access token ran out: a refresh starts
  await new Promise((res) => setTimeout(res, 10));
  await s.signOut();
  assert.equal(s.signedIn, false);
  release();
  await pending;
  assert.equal(s.signedIn, false, 'still signed out');
  assert.equal(stored, null, 'nothing stored again');
});

test('upgrade backup: a file that vanishes between the plan and the copy is skipped, the rest is still backed up', async () => {
  const { makeBackup, backupPlan } = await import('../server/lib/upgrade.mjs');
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'souldew-review30-backup-'));
  mkdirSync(join(dir, 'runs', 'abcd1234'), { recursive: true });
  writeFileSync(join(dir, 'runs', 'abcd1234', 'p1.sav'), Buffer.alloc(1024, 7));
  writeFileSync(join(dir, 'Cookies-journal'), 'x');
  const plan = backupPlan(dir);
  assert.equal(plan.files.length, 2);
  // the journal is gone by the time the copy reaches it
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'Cookies-journal'));
  const made = makeBackup(dir, { label: '3.0', plan, free: 1e12 });
  assert.equal(made.files, 1);
  assert.equal(made.bytes, 1024);
  assert.deepEqual(readFileSync(join(made.path, 'runs', 'abcd1234', 'p1.sav')), Buffer.alloc(1024, 7));
  assert.equal(existsSync(join(made.path, 'Cookies-journal')), false);
});

test('gifts between 3DS games: a Medicine item goes into the receiver\'s Medicine pocket; an item number no pocket holds is never written', async () => {
  const { addItem, removeItem, bagRoom, itemFitsPocket } = await import('../shared/live/cheats.mjs');
  const base = 0x33000000;
  const mem = new Uint8Array(0xde0 + 64);
  const dv = new DataView(mem.buffer);
  dv.setUint32(0xb48, (17 | (3 << 10)) >>> 0, true); // Sun/Moon: 3 Potions in Medicine
  dv.setUint32(0, (4 | (1 << 10)) >>> 0, true); // a Poké Ball in Items
  const entry = { id: 'sm', gen: 7, partyAddrs: [{ bag: `0x${base.toString(16)}` }] };
  const read = (a, n) => (a >= base && a + n <= base + mem.length ? mem.slice(a - base, a - base + n) : null);
  const write = (a, b) => {
    mem.set(b, a - base);
    return true;
  };
  assert.equal(bagRoom(entry, read, null, 17, 2, { pocket: 'medicine' }), true);
  const added = await addItem(entry, { read, write }, null, 17, 2, { pocket: 'medicine' });
  assert.equal(added.ok, true, 'a Medicine gift is written (it used to be refused – and lost on the way back too)');
  assert.equal((dv.getUint32(0xb48, true) >>> 10) & 0x3ff, 5);
  assert.equal((await removeItem(entry, { read, write }, null, 17, 2, { pocket: 'medicine' })).ok, true);
  // item 1500 would wrap into item 476 in Gen 7's 10 bits
  const before = mem.slice();
  assert.deepEqual(await addItem(entry, { read, write }, null, 1500, 2, { pocket: 'items' }), { error: 'unsupported' });
  assert.deepEqual(mem, before, 'nothing written');
  // the other generations' bounds
  const gb2 = { kind: 'gb' };
  assert.equal(itemFitsPocket(gb2, { gen: 2 }, 0x05, 'balls'), true);
  assert.equal(itemFitsPocket(gb2, { gen: 2 }, 0x12, 'balls'), false, 'a Potion is no ball');
  assert.equal(itemFitsPocket(gb2, { gen: 2 }, 0x05, 'items'), false);
  assert.equal(itemFitsPocket(gb2, { gen: 1 }, 0xff, null), false, 'never the list\'s end mark');
  const gba = { kind: 'gba', maxId: 376 };
  assert.equal(itemFitsPocket(gba, { gen: 3 }, 4, 'balls'), true);
  assert.equal(itemFitsPocket(gba, { gen: 3 }, 13, 'balls'), false);
  assert.equal(itemFitsPocket(gba, { gen: 3 }, 68, null), true, 'Rare Candy into Items');
  assert.equal(itemFitsPocket(gba, { gen: 3 }, 377, 'items'), false);
  assert.equal(itemFitsPocket({ kind: 'ds', maxId: 536 }, { gen: 4 }, 537, 'medicine'), false);
});

test('raids: a hack that keeps its base game\'s id but whose memory moved or is searched for is never written to', async () => {
  const { raidSupport, raidView } = await import('../shared/live/raidhp.mjs');
  assert.equal(raidSupport({ id: 'crystal_us', gen: 2 }).ok, true);
  assert.equal(raidSupport({ id: 'emerald_us', gen: 3 }).ok, true);
  for (const e of [{ id: 'crystal_us', gen: 2, wram: { delta: 0x20 } }, { id: 'emerald_us', gen: 3, scan3: true }, { id: 'firered_us', gen: 3, scanOnly: true }, { id: 'emerald_us~x', gen: 3 }]) {
    assert.deepEqual(raidSupport(e), { ok: false, why: 'hack' }, JSON.stringify(e));
    assert.equal(raidView(e, () => new Uint8Array(64)), null);
  }
});
