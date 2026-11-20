// Electron main for test/skin-proof.test.mjs: starts the app's own server (scratch data folder, a dev pack, a fake
// accounts service – test/fixtures/fakeaccounts.mjs, never the real one), opens the real app in a hidden window and, on
// every main view, compares classic with every skin from the pack: element boxes, visible text and generated
// (::before / ::after) text must be identical – a skin may change the look only.
//
//   1. signed out: the app's own views
//   2. signed in (the sidebar's account chip on every view): Friends and the profile, with friends, presence, a friend
//      request, stats, a showcase – plus readable text: every text on those pages and in the account chip holds
//      ≥ 4.5:1 (3:1 for large text) against what it is actually drawn on, in classic and every skin
//   3. the profile's banner: nothing but the avatar (and its frame) overlaps it, at 1024 and 1440 px wide
//   4. the live theme PREVIEW pack (what a non-member tries for 15 minutes): every preview skin lays out exactly like
//      classic – and so like the full skin
//   5. light skins: no field, popover, menu, hint, toast or dialog is drawn on a dark ground – on every view above and
//      in the profile editor (a dialog), every light skin (the Settings search was a black pill on Soft Light)
// Writes one JSON result: { ok, views, skins, previewSkins, boxes, contrast, banner, diffs: [...] }.
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

const out = process.argv[process.argv.length - 1];
app.commandLine.appendSwitch('mute-audio');
app.disableHardwareAcceleration();

const VIEWS = ['library', 'soullink', 'nuzlocke', 'link', 'stream', 'trophies', 'settings?s=general', 'settings?s=play', 'settings?s=controls', 'settings?s=about', 'guide', 'plus'];
// signed in: the account's own pages, and the library again (the account chip in the sidebar)
const ACCOUNT_VIEWS = ['friends', 'profile', 'library', 'plus', 'thanks'];
// collected in the page: every element of the shell and the view, its box (to 1/4 px) and its generated text.
// SKIP: subtrees left out of a comparison (the preview bar in Settings is UI that names the skin – not the skin)
const COLLECT = (skip = '') => `(() => {
  const r = (v) => Math.round(v * 4) / 4;
  const els = [...document.querySelectorAll('body *')].filter((e) => !e.closest('canvas, .cos-art-host, script, style${skip ? `, ${skip}` : ''}'));
  const boxes = els.map((e) => { const b = e.getBoundingClientRect(); return [r(b.x), r(b.y), r(b.width), r(b.height)].join(','); });
  // generated TEXT: an ornament with content: '' adds no text, so none / normal / "" are all "no text"
  const gen = (v) => (v === 'none' || v === 'normal' || v === '""' ? '' : v);
  const pseudo = els.map((e) => [gen(getComputedStyle(e, '::before').content), gen(getComputedStyle(e, '::after').content)].join('|'));
  const fonts = els.map((e) => getComputedStyle(e).fontFamily);
  const own = els.map((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim()));
  const tags = els.map((e) => e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
  const text = ${skip ? `(() => { const c = document.body.cloneNode(true); c.querySelectorAll(${JSON.stringify(skip)}).forEach((x) => x.remove()); document.body.appendChild(c); c.style.cssText = 'position:absolute;left:-99999px;top:0'; const t = c.innerText; c.remove(); return t; })()` : 'document.body.innerText'};
  return { boxes, pseudo, tags, fonts, own, text, hidden: els.filter((e) => e.checkVisibility && !e.checkVisibility() && e.innerText?.trim()).length };
})()`;

// Text contrast as drawn: every text's colour (with its alpha and every ancestor's opacity) against the pixels it is
// really drawn on – the page is captured with all text made transparent, and under each text box the darkest and the
// lightest tenth of the pixels both have to hold (a texture's grain is ignored, a gloss or gradient counts where it
// actually lies). WCAG 2.x: 4.5:1, large text (24 px, or 18.66 px bold) 3:1. Scope: CSS selectors; the page is
// scrolled through, so texts below the fold count too.
const TEXTS = (scope) => `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const opacity = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const rows = [];
  let i = 0;
  for (const root of document.querySelectorAll(${JSON.stringify(scope)})) for (const el of [root, ...root.querySelectorAll('*')]) {
    if (el.closest('canvas, .cos-art-host, .pf-banner, .fr-card-banner, .sr-only, [aria-hidden="true"], svg, script, style, option')) continue;
    if (el.closest('[disabled], [aria-disabled="true"]')) continue; // WCAG: inactive controls are exempt
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join('').trim();
    if (!text || !/[\\p{L}\\p{N}]/u.test(text)) continue;
    // the text's own box (the text nodes, not the element's padding)
    const range = document.createRange();
    const boxes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.data.trim()).flatMap((n) => { range.selectNodeContents(n); return [...range.getClientRects()]; });
    const b = boxes.reduce((u, r) => (u ? { left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }), null);
    if (!b || b.right - b.left < 1 || b.bottom - b.top < 1 || (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true }))) continue;
    const op = opacity(el);
    if (op < 0.05) continue; // not shown (a hover-only control)
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const fg = rgba(cs.color);
    if (!el.dataset.proofText) el.dataset.proofText = String(++i);
    rows.push({ key: el.dataset.proofText, text: text.slice(0, 40), tag: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''),
      rect: [b.left, b.top, b.right, b.bottom], fg: [fg[0], fg[1], fg[2], fg[3] * op], need: large ? 3 : 4.5 });
  }
  return { rows, w: innerWidth, h: innerHeight };
})()`;

// Light skins: every field / popover / menu / hint / toast / dialog on screen and the ground it is drawn on (its own
// background or the first ancestor's that is opaque; a gradient counts with its colours). Dark-by-design places (the
// game screen, LCDs, banners and art) are left out.
const SURFACES = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ground = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const grad = [...cs.backgroundImage.matchAll(/(rgba?|color)\\([^()]*\\)/g)].map((m) => rgba(m[0])).filter((c) => c[3] > 0.5);
      if (grad.length) return { at: n, g: grad };
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0.5) return { at: n, g: [c] };
    }
    return { at: null, g: [[255, 255, 255, 1]] };
  };
  const SEL = 'input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea, .set-search, .seg, .chip, .kbd, dialog.modal, .toast, details.group, .log, .rule-presets, [role=menu], [role=tooltip], [class*="-pop"], .rail-hint, .attn, .fs-pill, .update-card, .power, .inbox, .warning, .rail-me';
  const out = { checked: 0, dark: [] };
  for (const el of document.querySelectorAll(SEL)) {
    if (el.closest('.screen, .console-screen, .launch-screen, canvas, .cos-art-host, .pf-banner, .fr-card-banner, .onboard, .session')) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 4 || b.height < 4 || (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true }))) continue;
    out.checked++;
    const { at, g } = ground(el);
    if (at && at.matches('.rail')) continue; // drawn straight on the skin's own side rail (Glacier and Sakura keep it dark on purpose)
    const L = Math.max(...g.map(lum));
    if (L < 0.06) out.dark.push(el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + ' on rgb(' + g[0].slice(0, 3).join(',') + ')');
  }
  return out;
})()`;

/** Two COLLECT reads show the same page: every element, box, generated text, font and the visible text. */
const sameRead = (a, b) => a.text === b.text && a.hidden === b.hidden && a.boxes.join(';') === b.boxes.join(';')
  && a.pseudo.join(';') === b.pseudo.join(';') && a.fonts.join(';') === b.fonts.join(';');

/** A skin's read against classic's: { diffs: [{ what, a, b }], glyphRuns: [tag] }. */
function compareReads(base, got) {
  const diffs = [];
  const glyphRuns = [];
  const diff = (what, a, b) => diffs.push({ what, a: String(a).slice(0, 200), b: String(b).slice(0, 200) });
  if (got.boxes.length !== base.boxes.length) diff('element count', base.boxes.length, got.boxes.length);
  else {
    for (let i = 0; i < base.boxes.length; i++) {
      if (base.boxes[i] === got.boxes[i]) continue;
      // a glyph run (themes README › proof): a text element set in the skin's display face may be NARROWER, at the
      // same place and height – it moves nothing else (every other box is compared as usual)
      const [ax, ay, aw, ah] = base.boxes[i].split(',').map(Number);
      const [bx, by, bw, bh] = got.boxes[i].split(',').map(Number);
      if (got.own[i] && got.fonts[i] !== base.fonts[i] && ax === bx && ay === by && ah === bh && bw <= aw) {
        glyphRuns.push(base.tags[i]);
        continue;
      }
      diff(`box ${base.tags[i]}`, base.boxes[i], got.boxes[i]);
      if (diffs.length > 60) break;
    }
    for (let i = 0; i < base.pseudo.length; i++) if (base.pseudo[i] !== got.pseudo[i]) diff(`generated text ${base.tags[i]}`, base.pseudo[i], got.pseudo[i]);
  }
  if (got.text !== base.text) diff('text', base.text.length, got.text.length);
  if (got.hidden !== base.hidden) diff('hidden text', base.hidden, got.hidden);
  return { diffs, glyphRuns };
}

const lumOf = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratioOf = (a, b) => { const x = lumOf(a); const y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/** Rows of TEXTS against a capture (NativeImage) of the page with its text hidden. */
function measure(rows, img, view) {
  const { width, height } = img.getSize();
  const k = width / view.w;
  const bmp = img.toBitmap(); // BGRA
  const out = [];
  for (const r of rows) {
    const [l, t, rr, bb] = r.rect;
    if (t < 0 || bb > view.h || l < 0 || rr > view.w) continue; // outside this screenful – measured in another one
    const x0 = Math.max(0, Math.floor(l * k)); const x1 = Math.min(width, Math.ceil(rr * k));
    const y0 = Math.max(0, Math.floor(t * k)); const y1 = Math.min(height, Math.ceil(bb * k));
    const px = [];
    const step = Math.max(1, Math.floor(((x1 - x0) * (y1 - y0)) / 4000));
    for (let n = 0, y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) {
      if (n % step) continue;
      const o = (y * width + x) * 4;
      px.push([bmp[o + 2], bmp[o + 1], bmp[o]]);
    }
    if (!px.length) continue;
    px.sort((a, b) => lumOf(a) - lumOf(b));
    const grounds = [px[Math.floor(px.length * 0.1)], px[Math.floor(px.length * 0.9)]];
    let worst = Infinity; let pair = null;
    for (const g of grounds) {
      const a = r.fg[3];
      const fg = [0, 1, 2].map((i) => r.fg[i] * a + g[i] * (1 - a));
      const q = ratioOf(fg, g);
      if (q < worst) { worst = q; pair = [fg, g]; }
    }
    out.push({ key: r.key, text: r.text, tag: r.tag, need: r.need, ratio: Math.round(worst * 100) / 100,
      fg: pair[0].map(Math.round).join(','), bg: pair[1].join(',') });
  }
  return out;
}

// the profile banner: nothing but the avatar box (with its frame) may overlap it – only the avatar overhangs; and the
// columns under it don't run into each other
const BANNER = `(() => {
  const mast = document.querySelector('.profile > .pf-mast');
  const banner = mast?.querySelector('.pf-banner');
  if (!banner) return { error: 'no banner' };
  const B = banner.getBoundingClientRect();
  const hits = [];
  for (const el of mast.querySelectorAll('*')) {
    if (banner.contains(el) || el.closest('.av-wrap') || el.querySelector('.av-wrap')) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    const ix = Math.min(b.right, B.right) - Math.max(b.left, B.left);
    const iy = Math.min(b.bottom, B.bottom) - Math.max(b.top, B.top);
    if (ix > 0.5 && iy > 0.5) hits.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' ' + (el.textContent || '').trim().slice(0, 30));
  }
  const av = mast.querySelector('.av-wrap')?.getBoundingClientRect();
  // and below it: the main column's content stays in its column (the run table never runs under the side column)
  const main = document.querySelector('.pf-main');
  const side = document.querySelector('.pf-side')?.getBoundingClientRect();
  const wide = main ? [...main.querySelectorAll('*')].some((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > main.getBoundingClientRect().right + 0.5; }) : false;
  const under = main && side ? (() => { const m = main.getBoundingClientRect(); return Math.min(m.right, side.right) - Math.max(m.left, side.left) > 0.5 && Math.min(m.bottom, side.bottom) - Math.max(m.top, side.top) > 0.5; })() : false;
  if (wide) hits.push('the main column overflows');
  if (under) hits.push('the main and side columns overlap');
  return { hits, width: innerWidth, avatarOverhang: av ? Math.round(B.bottom - av.top) : null };
})()`;

/** A friend list, presence, a request and stats for the signed-in pages (the same people as scripts/social-e2e.mjs). */
function seed(fake) {
  const D = 86400000;
  const proof = fake.addUser({ handle: 'proof_dew', display_name: 'Proof', title: 'win-nuzlocke', accent: 'amber', status: 'grinding Victory Road', banner: 'lcd-grid', frame: 'plain',
    showcase: { trophies: ['win-nuzlocke', 'win-soul-link'], trusted: 'Breloom line – on 6 teams, fell once (Crystal, to Whitney)', favorite_game: 'Emerald' },
    privacy: { show_runs: true, profile: 'friends', show_on_thanks: true }, createdAt: Date.parse('2025-03-12'), // on the Thank you wall (and never asked)
    // a Supporter: the sidebar's souldew+ entry says "thank you" – its contrast is checked in every skin too
    entitlement: { tier: 'supporter', until: new Date(Date.now() + 30 * D).toISOString(), badges: ['supporter'] },
    stats: { totals: { runs_started: 23, runs_completed: 7, runs_failed: 14, soullink_runs: 13, nuzlocke_runs: 10, badges_earned: 61, pokemon_caught: 412, deaths: 168, playtime_minutes: 12840 },
      recent_runs: [
        { name: 'Proof – Nuzlocke #4', game: 'Emerald', mode: 'nuzlocke', result: 'active', badges: 3, deaths: 2 },
        { name: 'Proof & Kim', game: 'HeartGold', mode: 'soullink', result: 'won', badges: 16, deaths: 14, ended_at: '2026-10-21T20:00:00Z' },
        { name: 'Unova Squad', game: 'Black', mode: 'soullink', result: 'lost', badges: 3, deaths: 22, ended_at: '2026-09-14T20:00:00Z' },
      ] } });
  const kim = fake.addUser({ handle: 'kimchi_k', display_name: 'Kim', title: 'win-soul-link', accent: 'dusk', banner: 'plain-dusk', status: 'Johto again, why not', createdAt: Date.parse('2025-05-02') });
  const lou = fake.addUser({ handle: 'lou_lou', display_name: 'Lou', accent: 'moss' });
  const ida = fake.addUser({ handle: 'ida_plays', display_name: 'Ida', accent: 'tide' });
  const tim = fake.addUser({ handle: 'tim_t', display_name: 'Tim', accent: 'ember', avatar: false });
  for (const [i, u] of [kim, lou, ida, tim].entries()) fake.befriend(proof.id, u.id, Date.parse('2026-01-01') + i * 9 * D);
  const noor = fake.addUser({ handle: 'noor_exe', display_name: 'Noor', accent: 'tide' });
  fake.requests.set('fr_seedAAAAAAAAAAAAAAAAAAA', { id: 'fr_seedAAAAAAAAAAAAAAAAAAA', from: noor.id, to: proof.id, status: 'pending', created: Date.parse('2026-11-01T10:00:00Z') });
  fake.keepStats.add(proof.id);
  fake.pinPresence.add(proof.id);
  fake.accessTtl = 6 * 3600;
  const keep = () => {
    const at = Date.now();
    fake.presence.set(kim.id, { state: 'in_run', game: { title: 'HeartGold', system: 'nds' }, run: { name: 'Kim & Lou', mode: 'soullink', free_slot: true, joinable: true }, at });
    fake.presence.set(lou.id, { state: 'playing', game: { title: 'Platinum', system: 'nds' }, at });
    fake.presence.set(ida.id, { state: 'library', at });
  };
  keep();
  return { proof, kim, timer: setInterval(keep, 2000) };
}

app.whenReady().then(async () => {
  const result = { ok: false, views: 0, skins: 0, previewSkins: 0, boxes: 0, glyphRuns: [], diffs: [], contrast: { checked: 0, min: {}, fails: [] }, banner: [], surfaces: { checked: 0, lightSkins: 0, dark: [] } };
  let fake = null;
  let seeded = null;
  try {
    const { startFakeAccounts } = await import('./fakeaccounts.mjs');
    fake = await startFakeAccounts();
    seeded = seed(fake);
    process.env.SLS_ACCOUNTS_URL = fake.base; // before the server reads it: never the real service
    const { startServer } = await import('../../server/app.mjs');
    const { url, server } = await startServer({ port: 0, background: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadURL(url);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (code, ms = 20000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await js(code).catch(() => false)) return true; await sleep(150); }
      throw new Error(`timed out: ${code}`);
    };
    const C = (expr) => js(`import('/lib/cosmetics/index.mjs').then((m) => ${expr})`);
    const frame = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";
    const stillFrames = () => js(`(() => { if (document.querySelector('style[data-proof]')) return; const s = document.createElement('style'); s.dataset.proof = '1'; s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`);
    const dismissToasts = () => js(`document.querySelectorAll('.toast, .trophy-toast').forEach((t) => t.click()); true`);
    await until("!!document.querySelector('.nav')");
    await until("import('/lib/cosmetics/index.mjs').then((m) => m.packState().entitled)");
    // still frames only: no animation or transition may land between two captures
    await stillFrames();
    // The coffee button's Pokémon moments (views/coffee.mjs: every 3–8 minutes, ~3 s of pixel art over the sidebar's
    // souldew+ link – 48 to 178 elements) would land in a capture at random – whenever a run took longer than 3 minutes
    // they showed up as "element count" differences on whichever view was being proved. A click on the button stops
    // them for the session (the app's own rule: the button did its job); it opens the souldew+ page, which is fine here.
    await until("!!document.querySelector('.rail-plus')");
    await js("document.querySelector('.rail-plus').click(); true");
    await until("!document.querySelector('.cfx')");
    const skins = await C("m.listSkins().filter((s) => s.id !== 'classic' && s.available).map((s) => s.id)");
    result.skins = skins.length;
    const lightSkins = new Set(await C("m.listSkins().filter((s) => s.group === 'light').map((s) => s.id)"));
    result.surfaces.lightSkins = lightSkins.size;
    const checkSurfaces = async (id, where) => {
      if (!lightSkins.has(id)) return;
      const r = await js(SURFACES);
      result.surfaces.checked += r.checked;
      for (const d of r.dark) result.surfaces.dark.push(`${id} · ${where} · ${d}`);
    };

    let mark = 0;
    /** One view: classic, then every skin (applied – or previewed), compared box by box; contrast where asked. */
    async function proveView(view, { list = skins, mode = 'apply', contrast = null, skip = '', ready = null } = {}) {
      await js(`location.hash = '#/${view}'`);
      if (ready) await until(`!!document.querySelector(${JSON.stringify(ready)})`, 30000);
      await sleep(900);
      await dismissToasts();
      await sleep(300);
      const set = (id) => (mode === 'preview' ? C(`m.previewSkin(${JSON.stringify(id || 'classic')})`) : C(`m.applySkin(${JSON.stringify(id)})`));
      /** id = a skin, or null for classic – applied (or previewed), its fonts in, a frame drawn */
      const show = async (id) => {
        await set(id);
        await js('document.fonts.ready');
        await js(frame);
      };
      await C('m.applySkin(null)');
      if (mode === 'preview') await set(null);
      await js('document.fonts.ready');
      await js(frame);
      const collect = COLLECT(skip);
      // a SETTLED read: the same elements, boxes and text on two reads a frame apart (a list that is still coming in
      // – the pack, a friend's profile, a poll – is read once it is in, never half way)
      const read = async () => {
        let prev = await js(collect);
        for (let i = 0; i < 20; i++) {
          await js(frame);
          const cur = await js(collect);
          if (sameRead(prev, cur)) return cur;
          prev = cur;
        }
        return prev;
      };
      let baseline = await read();
      result.views++;
      const checkContrast = async (id) => {
        if (!contrast) return;
        // every screenful of the scrolling main area: the texts in it, then a capture with all text hidden
        const seen = new Map();
        const max = await js("(() => { const m = document.querySelector('main.main'); return m ? m.scrollHeight - m.clientHeight : 0; })()");
        for (let top = 0; ; top += 600) {
          mark = (mark + 1) % 2; // the marker's colour alternates, so an older capture with a marker can't pass
          const [mr, mg, mb] = mark ? [255, 0, 255] : [0, 255, 255];
          await js(`(() => { const m = document.querySelector('main.main'); if (m) m.scrollTop = ${Math.min(top, max)}; return true; })()`);
          await js(frame);
          const shot = await js(TEXTS(contrast));
          // all text transparent, plus a magenta marker in the corner: a capture that shows the marker is one taken
          // after the text was hidden (a hidden window paints lazily – try again until it does)
          await js(`(() => { const s = document.createElement('style'); s.dataset.proofHide = '1'; s.textContent = '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; caret-color: transparent !important; }'; document.head.appendChild(s);
            const m = document.createElement('div'); m.dataset.proofHide = '1'; m.style.cssText = 'position:fixed;left:0;top:0;width:6px;height:6px;background:rgb(${mr},${mg},${mb});z-index:2147483647;pointer-events:none'; document.body.appendChild(m); return true; })()`);
          let img = null;
          for (let attempt = 0; attempt < 8; attempt++) {
            win.webContents.invalidate();
            await sleep(120 + attempt * 150);
            await js(frame);
            const cap = await win.webContents.capturePage();
            const px = cap.toBitmap();
            const k = cap.getSize().width / shot.w;
            const o = (Math.floor(2 * k) * cap.getSize().width + Math.floor(2 * k)) * 4;
            if (Math.abs(px[o + 2] - mr) < 12 && Math.abs(px[o + 1] - mg) < 12 && Math.abs(px[o] - mb) < 12) { img = cap; break; }
          }
          await js("document.querySelectorAll('[data-proof-hide]').forEach((e) => e.remove()); true");
          win.webContents.invalidate();
          if (!img) throw new Error(`no capture with the text hidden (${id} · ${view})`);
          for (const row of measure(shot.rows, img, shot)) if (!seen.has(row.key)) seen.set(row.key, row);
          if (top >= max) break;
        }
        await js(`(() => { const m = document.querySelector('main.main'); if (m) m.scrollTop = 0; document.querySelectorAll('[data-proof-text]').forEach((e) => delete e.dataset.proofText); return true; })()`);
        await js(frame);
        const rows = [...seen.values()];
        result.contrast.checked += rows.length;
        const key = `${id} · ${view}`;
        if (rows.length) result.contrast.min[key] = Math.min(result.contrast.min[key] ?? Infinity, ...rows.map((r) => r.ratio));
        for (const r of rows) if (r.ratio < r.need) result.contrast.fails.push({ skin: id, view, text: r.text, tag: r.tag, ratio: r.ratio, need: r.need, fg: r.fg, bg: r.bg });
      };
      await checkContrast('classic');
      for (const id of list) {
        await show(id);
        let got = await read();
        let cmp = compareReads(baseline, got);
        // A difference: the skin's – or did the page change under the proof (a late load, a poll, a toast)? Then classic
        // reads differently now too. Classic and the skin are read again (up to 3 times) and compared with each other;
        // a difference the skin really makes comes back every time, one the page made goes away.
        for (let again = 0; cmp.diffs.length && again < 3; again++) {
          await show(null);
          baseline = await read();
          await show(id);
          got = await read();
          cmp = compareReads(baseline, got);
        }
        result.boxes += got.boxes.length;
        if (await js('document.documentElement.dataset.skin') !== id) result.diffs.push({ view, skin: id, mode, what: 'not applied', a: id, b: '' });
        for (const d of cmp.diffs) result.diffs.push({ view, skin: id, mode, ...d });
        for (const tag of cmp.glyphRuns) result.glyphRuns.push(`${id} · ${view} · ${tag}`);
        await checkSurfaces(id, view);
        await checkContrast(id);
      }
      if (mode === 'preview') await C('m.endPreview()');
      await C('m.applySkin(null)');
    }

    // ---- 1 · signed out
    for (const view of VIEWS) await proveView(view);

    // ---- 2 · signed in: the account chip, Friends, the profile
    const login = await (await fetch(`${base}/api/account/login`, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: '{}' })).json();
    fake.nextLogin = seeded.proof.id;
    const hand = await fake.browse(login.url);
    if (hand.done !== '/auth/done?r=ok') throw new Error(`sign-in failed: ${JSON.stringify(hand).slice(0, 300)}`);
    await until("!!document.querySelector('.rail-me')", 30000);
    // the account client takes over the pack access when signed in (a fake member without a pack here): the test pack
    // comes back through the dev provider, as before
    await until("import('/lib/cosmetics/index.mjs').then((m) => !m.packState().loading)");
    await C('m.setPackAccessProvider(null)');
    await C('m.refreshPack()');
    await until("import('/lib/cosmetics/index.mjs').then((m) => m.packState().entitled)");
    await sleep(1500);
    await dismissToasts();
    const READY = { friends: '.fr-list .fr-row', profile: '.profile .pf-stats', library: '.rail-me', plus: '.plus-page .plus-tiers', thanks: '.ty-page .ty-tier' };
    for (const view of ACCOUNT_VIEWS) {
      await proveView(view, { ready: READY[view], contrast: view === 'library' ? '.rail-me, .nav' : '.rail-me, .nav, main.main' });
    }
    // the friend's card in the Friends pane (a banner, an LCD "Now" card)
    await js(`location.hash = '#/friends'`);
    await until("!!document.querySelector('.fr-pick')", 30000);
    await js(`[...document.querySelectorAll('.fr-pick')].find((b) => b.textContent.includes('Kim'))?.click(); true`);
    await until("!!document.querySelector('.fr-card')", 20000);
    await proveView('friends', { ready: '.fr-card', contrast: 'main.main' });

    // ---- 5 · light skins: the profile editor (the parts drawer, its pickers with fields and chips) on a light ground
    for (const id of lightSkins) {
      await C(`m.applySkin(${JSON.stringify(id)})`);
      await js(`location.hash = '#/profile'`);
      await until("!!document.querySelector('.pf-actions .btn')", 20000);
      await js(`[...document.querySelectorAll('.pf-actions .btn')].find((b) => b.textContent.includes('Edit profile'))?.click(); true`);
      await until("!!document.querySelector('.pe-drawer .pe-pcard')", 20000);
      await sleep(400);
      await checkSurfaces(id, 'profile editor');
      for (const part of ['banner', 'name', 'trophies', 'privacy']) {
        await js(`document.querySelector('.pe-pcard[data-card="${part}"]')?.click(); true`);
        await until(`!!document.querySelector('.pe-body.p-${part}')`, 20000);
        await sleep(300);
        await checkSurfaces(id, `profile editor · ${part}`);
        await js(`document.querySelector('.pe-back')?.click(); true`);
        await sleep(200);
      }
      await js(`document.querySelector('.pe-bar .btn.ghost')?.click(); true`);
      await sleep(300);
    }
    await C('m.applySkin(null)');

    // ---- 3 · the profile banner: overlapped by nothing but the avatar, at 1024 and 1440 wide
    for (const width of [1024, 1280, 1440]) {
      win.setContentSize(width, 820);
      await sleep(400);
      await js(`location.hash = '#/library'`);
      await sleep(300);
      await js(`location.hash = '#/profile'`);
      await until("!!document.querySelector('.profile .pf-banner')", 20000);
      await sleep(800);
      for (const id of [null, ...skins]) {
        await C(`m.applySkin(${JSON.stringify(id)})`);
        await js(frame);
        const b = await js(BANNER);
        result.banner.push({ width, skin: id || 'classic', ...b });
      }
      await C('m.applySkin(null)');
    }
    win.setContentSize(1440, 900);
    await sleep(500);

    // ---- 4 · the live theme preview pack: a non-member's 15 minutes, laid out exactly like the full skins
    await js("localStorage.setItem('sl-plus-dev-preview', '1'); true"); // the dev provider: no members' pack, the preview only
    await C('m.refreshPack()');
    await until("import('/lib/cosmetics/index.mjs').then((m) => !m.packState().entitled && !m.packState().loading)");
    await C('m.startPackPreview()');
    await until("import('/lib/cosmetics/index.mjs').then((m) => m.packState().preview)", 60000);
    const previewSkins = await C("m.listSkins().filter((s) => s.id !== 'classic' && s.available).map((s) => s.id)");
    result.previewSkins = previewSkins.length;
    result.previewFonts = await js("import('/lib/cosmetics/state.mjs').then((s) => [...s.content.files.keys()].filter((p) => p.startsWith('fonts/')))");
    for (const view of [...VIEWS, 'friends', 'profile']) {
      await proveView(view, { list: previewSkins, mode: 'preview', skip: '.skin-preview-bar', ready: READY[view] });
    }
    result.ok = result.diffs.length === 0 && result.contrast.fails.length === 0 && result.surfaces.dark.length === 0 && result.banner.every((b) => !b.error && !b.hits.length) && result.skins > 0 && result.previewSkins > 0;
  } catch (e) {
    result.error = String(e?.stack || e);
  }
  clearInterval(seeded?.timer);
  await fake?.close().catch(() => {});
  writeFileSync(out, JSON.stringify(result));
  app.exit(0);
});
