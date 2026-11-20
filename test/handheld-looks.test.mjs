// The souldew+ looks of the 3.0 launch animation (Gold, Clear shell, Holo label, the Rare start, holo / glitter finishes)
// are data from the souldew+ pack (handheld/looks.json, web/lib/handheld/looks.mjs) – the public app only draws "Your
// colours" and vinyl. A patched client that flips its membership switch gets no souldew+ look, because the look's data
// isn't in the app. These tests use made-up looks (never the real ones: those live only in the private pack sources).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanLooks, cleanGlsl, effectiveLook, effectiveCart, hasLook, finishIndex, hasRare } from '../web/lib/handheld/looks.mjs';
import { contentFrom } from '../web/lib/cosmetics/pack/client.mjs';
import { opaqueChunk } from '../web/lib/handheld/surface.mjs';
import { productShot } from '../scripts/handheld/preview-shot.mjs';
import { buildAtlas, stickerPicture } from '../web/lib/handheld/atlas.mjs';
import { DESIGNS } from '../scripts/handheld/stickers-app.mjs';
import { launchTier, launchRights, playableLookFor, LAUNCH_DEFAULT } from '../shared/handheld.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const enc = new TextEncoder();

/** made-up looks in the pack's shape */
export const FAKE_LOOKS = () => ({
  v: 1,
  gold: {
    shell: { color: '#c09a30', tone: 0.04, metalness: 1, roughness: 0.3, clearcoat: 0.4 },
    dark: { color: '#302010' }, keys: { color: '#e0c070', metalness: 1 }, word: { color: '#705010' },
    cart: { color: '#d0a040', metalness: 1, roughness: 0.3 }, pulse: '#fff2d0',
  },
  clear: {
    shell: { whiten: 0.2, roughness: 0.05, transmission: 0.9, thickness: 2, ior: 1.5, attenuationDistance: 30, clearcoat: 1 },
    word: { opacity: 0.5, shade: 1 },
    board: {
      scale: 4, bg: '#103020', edge: '#082018', seed: 1,
      traces: { n: 8, spread: 40, y0: 0.2, x: [0.1, 0.8], y: [0.3, 0.6], color: '#a08040', width: 3, maskWidth: 4, pad: '#c09050', padR: 4 },
      chips: [{ x: [0.3, 0], y: [0.5, 0], w: 12, h: 12, label: 'X1' }, { x: [0.6, 2], y: [0.6, 0], w: 8, h: 6 }],
      chip: { pins: '#909090', body: '#101010', top: '#202020', label: '#c0c0c0' },
      coin: { x: 0.7, y: 0.3, r: 8, r2: 6, ring: '#c0c0c0', face: '#808080' },
      connector: { color: '#c0a060', w: 30, h: 3, y: 2 },
      material: { roughness: 0.5, metalness: 0.1, emissive: '#ffe0a0' },
    },
  },
  holo: {
    label: { roughness: 0.25, metalness: 0.1, iridescence: 1, iridescenceIOR: 1.5, iridescenceThicknessRange: [100, 800], clearcoat: 1 },
    foil: { size: 64, base: 0.5, terms: [{ a: 0.3, kx: 0.2, ky: 0.2 }] },
    glsl: '  outgoingLight = mix(outgoingLight, vec3(fu.x, fu.y, 1.0), uFoilA * 0.3 + uFoil * 0.0);\n',
  },
  rare: { screen: ['#000000', '#202020', '#f0e0c0', '#ffe0a0'], pulse: '#ffd080', glow: '#ffe0b0' },
  finishes: {
    holo: { roughness: 0.2, metalness: 0.4, glsl: '      outgoingLight = mix(outgoingLight, vec3(0.2, 0.9, 0.9) * (0.5 + 0.5 * ndv), hh_holo * hh_holoW * hh_scov);\n' },
    glitter: { glsl: '      outgoingLight += vec3(0.6) * hh_glit * hh_scov * hh_hash3(floor(hh_U / 0.2)).x * dot(normal, V);\n' },
  },
});

test('cleanLooks: a whole, valid pack look is kept; the rest of the app sees nothing else', () => {
  const L = cleanLooks(FAKE_LOOKS());
  assert.deepEqual(Object.keys(L).sort(), ['clear', 'finishes', 'gold', 'holo', 'rare']);
  assert.deepEqual(Object.keys(L.finishes).sort(), ['glitter', 'holo']);
  assert.equal(L.gold.shell.color, '#c09a30');
  assert.equal(L.clear.board.chips[1].label, '', 'a chip without a label');
  // unknown material keys are dropped, never passed to three.js
  const raw = FAKE_LOOKS();
  raw.gold.shell.onBeforeCompile = 'evil';
  raw.gold.shell.map = 'x';
  assert.deepEqual(Object.keys(cleanLooks(raw).gold.shell).sort(), ['clearcoat', 'color', 'metalness', 'roughness', 'tone']);
});

test('cleanLooks: one bad value drops that look whole (never half a look); junk → null', () => {
  for (const [what, spoil] of [
    ['gold colour', (L) => { L.gold.shell.color = 'red'; }],
    ['gold range', (L) => { L.gold.cart.metalness = 7; }],
    ['clear board chip', (L) => { L.clear.board.chips[0].w = 'big'; }],
    ['clear board label', (L) => { L.clear.board.chips[0].label = '<b>'; }],
    ['clear board size', (L) => { L.clear.board.scale = 99; }],
    ['holo foil', (L) => { L.holo.foil.terms = []; }],
    ['holo glsl', (L) => { L.holo.glsl = '#extension GL_EXT_foo : enable\n'; }],
    ['rare palette', (L) => { L.rare.screen = ['#000000']; }],
  ]) {
    const raw = FAKE_LOOKS();
    spoil(raw);
    const L = cleanLooks(raw);
    const key = what.split(' ')[0];
    assert.equal(L[key], undefined, `${what}: the look is gone`);
    for (const other of ['gold', 'clear', 'holo', 'rare'].filter((k) => k !== key)) assert.ok(L[other], `${what}: ${other} stays`);
  }
  assert.equal(cleanLooks(null), null);
  assert.equal(cleanLooks({ ...FAKE_LOOKS(), v: 2 }), null, 'an unknown version');
  assert.equal(cleanLooks({ v: 1 }), null, 'nothing in it');
});

test('cleanGlsl: statements only – no preprocessor, declarations, texture reads, loops or unbalanced braces', () => {
  assert.ok(cleanGlsl('outgoingLight *= 0.9;'));
  for (const bad of ['#define X 1', 'uniform float x;', 'varying vec2 v;', 'vec4 c = texture2D(map, fu);', 'vec4 c = texture(map, fu);',
    'for (int i = 0; i < 9; i++) {}', 'while (true) {}', 'discard;', '}', 'if (x) {', 'gl_FragColor = vec4(1.0);', 'a = "x";', 'x'.repeat(5000)]) {
    assert.equal(cleanGlsl(bad), null, bad.slice(0, 40));
  }
});

test('without the pack\'s data a souldew+ look draws "Your colours", vinyl and no Rare start – whatever a client switches on', () => {
  for (const L of [null, undefined, {}, { finishes: {} }]) {
    assert.equal(effectiveLook('gold', L), 'theme');
    assert.equal(effectiveLook('clear', L), 'theme');
    assert.equal(effectiveCart('gold', L), undefined);
    assert.equal(effectiveCart('holo', L), undefined);
    assert.equal(hasLook('gold', L), false);
    assert.equal(hasLook('clear-shell', L), false);
    assert.equal(hasLook('holo', L), false);
    assert.equal(hasLook('your-colours', L), true, 'the free look always');
    assert.equal(finishIndex('holo', L), 0);
    assert.equal(finishIndex('glitter', L), 0);
    assert.equal(hasRare(L), false);
  }
  const L = cleanLooks(FAKE_LOOKS());
  assert.deepEqual([effectiveLook('gold', L), effectiveLook('clear', L), effectiveCart('holo', L), finishIndex('holo', L), finishIndex('glitter', L), hasRare(L)],
    ['gold', 'clear', 'holo', 1, 2, true]);
  // the shader: without finishes no holo / glitter code at all; with them, the pack's lines in place
  assert.doesNotMatch(opaqueChunk(null), /hh_holo > 0\.001|hh_glit > 0\.001|__FINISHES__/);
  const chunk = opaqueChunk(L.finishes);
  assert.match(chunk, /if \(hh_holo > 0\.001\)/);
  assert.ok(chunk.includes(L.finishes.glitter.glsl));
});

test('the tier gate and the data gate together (web/lib/handheld/look.mjs playableLook): a souldew+ look plays only with souldew+, the pack AND its data', () => {
  const L = cleanLooks(FAKE_LOOKS());
  // look.mjs: playableLookFor (the tier, shared/handheld.mjs) – then the look's data from the pack, else "Your colours"
  const play = (id, rights, looks) => { const p = playableLookFor(id, rights); return hasLook(p, looks) ? p : LAUNCH_DEFAULT; };
  const rare = (rights, looks) => rights.rare && hasRare(looks);
  const cases = [
    [{ signedIn: false }, false],
    [{ signedIn: true, tier: 'supporter' }, false],
    [{ signedIn: true, tier: 'plus' }, false], // souldew+ on the account, but no pack on this computer
    [{ signedIn: true, tier: 'patron', entitled: true }, true],
    [{ signedIn: true, tier: 'none', entitled: true }, true], // a verified pack is souldew+
  ];
  for (const [who, full] of cases) {
    const rights = launchRights(launchTier(who), { entitled: !!who.entitled });
    for (const id of ['gold', 'clear-shell', 'holo']) {
      assert.equal(play(id, rights, L), full ? id : LAUNCH_DEFAULT, `${JSON.stringify(who)} ${id} with the data`);
      assert.equal(play(id, rights, null), LAUNCH_DEFAULT, `${JSON.stringify(who)} ${id} without the data`);
    }
    assert.equal(play('your-colours', rights, null), 'your-colours');
    assert.equal(rare(rights, null), false, 'no Rare start without its data, whatever the tier');
  }
  // a patched client that hands itself every right still has no data to draw
  const forged = { tier: 'member', three: true, plus: true, rare: true, surprise: true, designMax: 12, earned: true };
  assert.deepEqual([play('gold', forged, null), rare(forged, null), finishIndex('glitter', null)], [LAUNCH_DEFAULT, false, 0]);
});

test('the pack client reads handheld/looks.json through the same check (and drops a damaged one)', () => {
  const files = (looks) => new Map([
    ['contents.json', enc.encode(JSON.stringify({ handheld: { wraps: 'handheld/wraps.json', looks: 'handheld/looks.json' } }))],
    ['handheld/wraps.json', enc.encode('[]')],
    ['handheld/looks.json', enc.encode(JSON.stringify(looks))],
  ]);
  const ok = contentFrom(files(FAKE_LOOKS()));
  assert.ok(ok.handheld.looks.gold && ok.handheld.looks.finishes.glitter);
  const bad = FAKE_LOOKS();
  bad.v = 9;
  assert.equal(contentFrom(files(bad)).handheld.looks, null);
  const older = new Map([['contents.json', enc.encode(JSON.stringify({ handheld: { wraps: 'handheld/wraps.json' } }))], ['handheld/wraps.json', enc.encode('[]')]]);
  assert.equal(contentFrom(older).handheld.looks, null, 'an older pack has no looks');
});

// The values the public app used to hard-code for the souldew+ looks (before they moved into the pack) – as hashes, so
// this test doesn't publish them again. None may come back into the public scene, surface, look or launch code.
const PAID_HASHES = new Set([
  '1838936e', 'ccf7f3e4', '11c1f38e', '96569355', 'ea14d2a6', '73910ce5', '20ecbca4', 'cf64a3d5', '393617ec', 'a3842908', '033dfe93', '4018750e',
  '98ffccd6', 'bd1ebad0', '79b1edb4', '92274679', '8250b34b', 'bc91dff2', '916ecff0', '182c5997', '410414dc', 'be0f3b84', '059ffe03', 'a41ec721',
  'f7784871', 'dc85388b', '0cf1d1f1', 'ddc46b49', '97db1450', '7eee2f7f', '93e22af4', 'ad600616', '5b89f7cb', 'efb843bf', '0a63f111', '09c1b6df',
  '99223cb0', '8e015878',
]);
const h8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
export const paidTokensOf = (src) => [...new Set([...(src.match(/#[0-9a-f]{6}\b/gi) || []).map((c) => c.toLowerCase()), ...src.split('\n').map((l) => l.trim()).filter((l) => l.length > 30)])];

test('no souldew+ look is hard-coded in the public launch scene any more', () => {
  const files = ['web/lib/handheld/scene.mjs', 'web/lib/handheld/surface.mjs', 'web/lib/handheld/look.mjs', 'web/lib/handheld/looks.mjs', 'web/views/launchstage.mjs', 'shared/handheld.mjs'];
  for (const f of files) {
    const hits = paidTokensOf(readFileSync(join(ROOT, f), 'utf8')).filter((t) => PAID_HASHES.has(h8(t)));
    assert.deepEqual(hits, [], `${f} still holds souldew+ look values`);
  }
  // and the private source, where it is next to this checkout, carries every one of them (the list above stays honest)
  const src = join(ROOT, '..', 'design-plus', 'design', 'plus', 'handheld', 'looks.mjs');
  if (existsSync(src)) {
    const have = new Set(paidTokensOf(readFileSync(src, 'utf8')).map(h8));
    for (const x of PAID_HASHES) assert.ok(have.has(x), `hash ${x} is not in the private looks source`);
  }
});

test('preview media of a souldew+ sticker are a product shot, never the pixel art 1:1', () => {
  const atlas = buildAtlas(DESIGNS);
  // a round badge, and round 7's pixel lettering (a wide bar with text, big letters) – text is the easiest to lift
  for (const id of ['moon', 'one-hp', 'gg']) previewIsNoCopy(atlas, id);
  // a wrap's window keeps its frame and stays opaque
  const win = productShot({ w: 40, h: 30, rgba: new Uint8ClampedArray(40 * 30 * 4).fill(200) }, { angle: 4, opaque: true });
  assert.deepEqual([win.w, win.h, win.rgba.every((v, i) => i % 4 !== 3 || v === 255)], [40, 30, true]);
});

function previewIsNoCopy(atlas, id) {
  const pic = stickerPicture(atlas, id, 6);
  const shot = productShot(pic, { angle: -6, seed: id });
  assert.notEqual(shot.w % atlas.rects[id].w, 0, `${id}: not a whole multiple of the art`);
  // downscaled the way a copier would (nearest, back to the art's grid) it is not the sticker's art any more
  const r = atlas.rects[id];
  let same = 0, total = 0;
  const k = shot.w / (r.w + 2);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const i = ((r.y + y) * atlas.w + r.x + x) * 4;
    if (!atlas.rgba[i + 3]) continue;
    const sx = Math.min(shot.w - 1, Math.round((x + 1.5) * k)), sy = Math.min(shot.h - 1, Math.round((y + 1.5) * k));
    const o = (sy * shot.w + sx) * 4;
    total++;
    if (atlas.rgba[i] === shot.rgba[o] && atlas.rgba[i + 1] === shot.rgba[o + 1] && atlas.rgba[i + 2] === shot.rgba[o + 2]) same++;
  }
  assert.ok(same / total < 0.5, `${id}: only ${same} of ${total} art pixels survive a naive copy`);
  // but it still shows the sticker: most of the picture is covered, its edge is soft
  const covered = shot.rgba.filter((v, i) => i % 4 === 3 && v > 200).length;
  assert.ok(covered > shot.w * shot.h * 0.4, `${id}: covered`);
}

const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
test('real Chromium: a souldew+ look without its data is "Your colours" to the pixel; with it, the pack\'s code compiles and draws', { skip: noDisplay ? 'no display' : false, timeout: 150000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'souldew-looks-'));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'Proof', bootAnimation: false, nagOff: true }));
  // the real looks when the private sources are next to this checkout, else the made-up ones
  const src = join(ROOT, '..', 'design-plus', 'design', 'plus', 'handheld', 'looks.mjs');
  const looks = existsSync(src) ? (await import(pathToFileURL(src).href)).LOOKS : FAKE_LOOKS();
  writeFileSync(join(data, 'looks.json'), JSON.stringify(looks));
  const out = join(data, 'result.json');
  const electron = (await import('electron')).default;
  const env = { ...process.env, SLS_DATA_DIR: data, ELECTRON_ENABLE_LOGGING: '' };
  delete env.SLS_ACCOUNTS_URL;
  delete env.SLS_PLUS_DEV_PACK;
  const r = spawnSync(electron, [join(ROOT, 'test', 'fixtures', 'looks-runner.mjs'), join(data, 'looks.json'), out], { env, encoding: 'utf8', timeout: 140000 });
  assert.ok(existsSync(out), `no result (exit ${r.status}): ${String(r.stderr).slice(-1500)}`);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(res.error, undefined, res.error);
  const s = res.shots;
  assert.equal(s.valid, true);
  assert.deepEqual(s.kinds.sort(), ['clear', 'finish:glitter', 'finish:holo', 'finishes', 'gold', 'holo', 'rare']);
  const errors = res.console.filter((m) => /Shader Error|ERROR: \d|THREE\.WebGLProgram|WebGL: INVALID/.test(m));
  assert.deepEqual(errors, [], 'every shader compiles');
  assert.ok(s.theme.length > 1000, 'the scene drew');
  assert.equal(s.goldNoData, s.theme, 'Gold (+ a gold cartridge, a Rare start) without the pack\'s data: exactly "Your colours"');
  assert.equal(s.holoNoData, s.theme, 'the holo label without its data: the plain label');
  assert.notEqual(s.gold, s.theme, 'with the data, Gold is drawn');
  assert.notEqual(s.clearHolo, s.theme, 'with the data, the Clear shell is drawn');
});
