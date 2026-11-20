// Electron main for test/thanks-render.test.mjs: the real app (its own server, a scratch data folder, muted, hidden
// window) against the fake accounts service (test/fixtures/fakeaccounts.mjs – never the real one), with a Thank you wall
// of Legends, souldew+ members, Supporters and coffees – some opted in, most not. It
//   1. signs in as a new Supporter who never answered → the one-time card must show (and only once): "Yes, show me"
//   2. reads the Thank you page: who is named (only the opted-in), the "and N more", the live state
//   3. a new Legend opts in while the page is open → the next minute's ask shows "New: … joined the Legends"
//   4. the service goes away → the last wall stays, "Offline – as of …"
// With a souldew+ dev pack (SLS_PLUS_DEV_PACK) the page is also shown in two light and two dark skins and at a bigger
// interface size. SHOTS=<folder>: PNG captures go there. Writes one JSON result to the path given last.
import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[process.argv.length - 1];
const SHOTS = process.env.THANKS_SHOTS || '';
app.commandLine.appendSwitch('mute-audio');

const D = 86400000;
const until30 = new Date(Date.now() + 30 * D).toISOString();
const ent = (tier) => ({ tier, until: until30, badges: { supporter: ['supporter'], plus: ['plus'], patron: ['plus', 'patron'] }[tier] });

function seed(fake) {
  const on = { show_on_thanks: true };
  const add = (o) => fake.addUser(o);
  add({ handle: 'lena', display_name: 'Lena', entitlement: ent('patron'), banner: 'lantern-night', frame: 'gilded-filigree', privacy: on, thanksSince: '2026-03' });
  add({ handle: 'marisol', display_name: 'Marisol', entitlement: ent('patron'), banner: 'cloud-sea', frame: 'brass-ring', privacy: on, thanksSince: '2026-06' });
  add({ handle: 'hidden_legend', display_name: 'Quiet Legend', entitlement: ent('patron') });
  add({ handle: 'mo', display_name: 'Mo', entitlement: ent('plus'), banner: 'cherry-orchard', frame: 'sakura-bough', privacy: on, thanksSince: '2026-04' });
  add({ handle: 'jun', display_name: 'Jun', entitlement: ent('plus'), banner: 'first-snow', frame: 'porcelain', privacy: on, thanksSince: '2026-08' });
  add({ handle: 'aria', display_name: 'Aria', entitlement: ent('plus'), privacy: on, thanksSince: '2026-10', avatar: false });
  add({ handle: 'kai', display_name: 'Kai', entitlement: ent('supporter'), frame: 'plain', privacy: on, thanksSince: '2026-02' });
  add({ handle: 'ida', display_name: 'Ida', entitlement: ent('supporter'), privacy: on, thanksSince: '2026-07' });
  add({ handle: 'tomas', display_name: 'Tomás', entitlement: ent('supporter'), privacy: on, thanksSince: '2026-09' });
  add({ handle: 'said_no', display_name: 'Said No', entitlement: ent('supporter'), privacy: { show_on_thanks: false } });
  for (const [h, n] of [['pip', 'Pip'], ['sam', 'Sam'], ['oskar', 'Oskar'], ['wren', 'Wren']]) add({ handle: h, display_name: n, coffee: true, privacy: on });
  fake.thanksAnonymous = { legend: 1, plus: 5, supporter: 17, coffee: 8 };
  // the one signing in: a brand-new Supporter who never answered
  return add({ handle: 'robin_new', display_name: 'Robin', entitlement: ent('supporter'), banner: 'dusk-ridge', frame: 'plain' });
}

app.whenReady().then(async () => {
  const result = { ok: false, steps: {}, shots: [], console: [] };
  let fake = null;
  try {
    const { startFakeAccounts } = await import('./fakeaccounts.mjs');
    fake = await startFakeAccounts();
    fake.accessTtl = 6 * 3600;
    const robin = seed(fake);
    process.env.SLS_ACCOUNTS_URL = fake.base; // before the server reads it
    process.env.SLS_ACCOUNTS_DEV_ENT_KEY = fake.ent.publicKey;
    const { startServer } = await import('../../server/app.mjs');
    const { url, server } = await startServer({ port: 0, background: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    win.webContents.on('console-message', (...a) => { const m = String(a[0]?.message ?? a[2] ?? ''); if (/error|warn/i.test(m)) result.console.push(m.slice(0, 300)); });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (code, ms = 20000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await js(code).catch(() => false)) return true; await sleep(150); }
      throw new Error(`timed out: ${code}`);
    };
    const frame = () => js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const C = (expr) => js(`import('/lib/cosmetics/index.mjs').then((m) => ${expr})`);
    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await js('document.fonts.ready');
      await frame();
      await sleep(250);
      const img = await win.webContents.capturePage();
      const file = join(SHOTS, `${name}.png`);
      writeFileSync(file, img.toPNG());
      result.shots.push(file);
    };
    await win.loadURL(url);
    await until("!!document.querySelector('.nav')");
    const pack = !!process.env.SLS_PLUS_DEV_PACK;
    if (pack) await until("import('/lib/cosmetics/index.mjs').then((m) => m.packState().entitled)", 30000).catch(() => {});

    // ---- 1 · sign in as a new Supporter: the card asks once
    const login = await (await fetch(`${base}/api/account/login`, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: '{}' })).json();
    fake.nextLogin = robin.id;
    const hand = await fake.browse(login.url);
    if (hand.done !== '/auth/done?r=ok') throw new Error(`sign-in failed: ${JSON.stringify(hand).slice(0, 300)}`);
    await until("!!document.querySelector('.rail-me')", 30000);
    if (pack) {
      await until("import('/lib/cosmetics/index.mjs').then((m) => !m.packState().loading)").catch(() => {});
      await C('m.setPackAccessProvider(null)');
      await C('m.refreshPack()');
      await until("import('/lib/cosmetics/index.mjs').then((m) => m.packState().entitled)", 30000).catch(() => {});
    }
    await until("!!document.querySelector('dialog[open] .ty-ask')", 15000);
    result.steps.ask = await js(`(() => { const d = document.querySelector('dialog[open]'); return { title: d.querySelector('h2')?.textContent, preview: d.querySelector('.ty-ask-preview')?.innerText, buttons: [...d.querySelectorAll('.ty-ask-answers .btn')].map((b) => b.textContent.trim()) }; })()`);
    await shot('ask-classic');
    await js(`[...document.querySelectorAll('.ty-ask-answers .btn')].find((b) => /Yes/.test(b.textContent)).click(); true`);
    await until("!document.querySelector('dialog[open] .ty-ask')");
    await sleep(400);
    result.steps.answered = robin.privacy.show_on_thanks;
    // never again: another look at the account (as after a restart) doesn't bring it back
    await js("import('/lib/account.mjs').then((m) => m.reloadAccount())");
    await sleep(3500);
    result.steps.askedAgain = await js("!!document.querySelector('dialog[open] .ty-ask')");

    // ---- 2 · the page
    await js("location.hash = '#/thanks'");
    await until("!!document.querySelector('.ty-page .ty-tier')", 20000);
    await sleep(1200);
    const read = () => js(`(() => ({
      names: [...document.querySelectorAll('.ty-person .ty-name')].map((e) => e.textContent),
      tiers: [...document.querySelectorAll('.ty-tier')].map((s) => [s.className.match(/ty-tier-(\\w+)/)[1], s.querySelector('.ty-count')?.textContent, s.querySelector('.ty-more')?.textContent || null]),
      total: document.querySelector('.ty-total b')?.textContent, live: document.querySelector('.ty-live')?.textContent,
      moment: document.querySelector('.ty-moment')?.textContent || null, text: document.querySelector('.ty-page').innerText,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    }))()`);
    result.steps.page = await read();
    await shot('thanks-classic');
    await js("document.querySelector('main.main').scrollTop = 99999; true");
    await shot('thanks-classic-bottom');
    await js("document.querySelector('main.main').scrollTop = 0; true");

    if (pack) {
      const skins = await C("m.listSkins().filter((s) => s.available && s.id !== 'classic').map((s) => ({ id: s.id, group: s.group }))");
      const pick = [...skins.filter((s) => s.group === 'light').slice(0, 2), ...skins.filter((s) => s.group !== 'light').slice(0, 2)];
      result.steps.skins = pick.map((s) => s.id);
      for (const s of pick) {
        await C(`m.applySkin(${JSON.stringify(s.id)})`);
        await sleep(600);
        await shot(`thanks-${s.group === 'light' ? 'light' : 'dark'}-${s.id}`);
      }
      await C('m.applySkin(null)');
      // the interface size (the window's zoom, as Settings › General sets it)
      win.webContents.setZoomFactor(1.25);
      await sleep(600);
      result.steps.zoomOverflow = await js('document.documentElement.scrollWidth > innerWidth + 1');
      await shot('thanks-classic-zoom125');
      win.webContents.setZoomFactor(1);
      await sleep(300);
    }

    // ---- 3 · someone new while the page is open: the next ask (a minute) brings the moment
    fake.addUser({ handle: 'fen', display_name: 'Fen', entitlement: ent('patron'), banner: 'firefly-meadow', frame: 'firefly-ring', privacy: { show_on_thanks: true }, thanksSince: '2026-11' });
    await until("!!document.querySelector('.ty-moment')", 75000);
    await sleep(700);
    result.steps.moment = (await read()).moment;
    result.steps.fresh = await js("[...document.querySelectorAll('.ty-fresh .ty-name')].map((e) => e.textContent)");
    await shot('thanks-moment');

    // ---- 4 · the service goes away: the last wall, "as of"
    fake.thanksDown = true;
    await until("!!document.querySelector('.ty-live-off')", 75000);
    result.steps.offline = await read();
    await shot('thanks-offline');

    result.ok = true;
    win.destroy();
    server.close();
  } catch (e) {
    result.error = String(e?.stack || e);
  }
  try { await fake?.close(); } catch {}
  writeFileSync(out, JSON.stringify(result, null, 1));
  app.exit(0);
});
