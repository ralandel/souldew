// SignPath's privacy condition: the Windows installer shows what souldew sends by itself (build/installer.nsh), with
// a checkbox for each automatic connection, and the app applies what was ticked once (electron/installerchoices.mjs).
// Here: the choices go into config.json once and only when the page was shown (not on a silent update), only what the
// player changed counts, the update check and the "playing now" count obey their settings, and the installer script
// stays buildable (every text in every installer language – makensis runs with -WX) and in step with the app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installerPatch, applyInstallerChoices, INSTALLER_CHOICES_FILE, INSTALLER_KEYS } from '../electron/installerchoices.mjs';
import { scheduleUpdateChecks, autoCheckOn, installerArgs } from '../electron/update-core.mjs';
import { LINKS } from '../shared/links.mjs';
import { EDITION } from '../shared/edition.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = mkdtempSync(join(tmpdir(), 'souldew-installer-'));
process.env.SLS_DATA_DIR = DATA; // before anything of the server is imported (server/lib/paths.mjs) – hence the dynamic imports
const quiet = { warn() {} };

/** A data folder with a config.json (written the way the app writes it) and the main process' read / patch. */
function profile(config = null) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-choices-'));
  const file = join(dir, 'config.json');
  if (config) writeFileSync(file, JSON.stringify(config, null, 2));
  const readConfig = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const patchConfig = (patch) => writeFileSync(file, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  const choices = (o) => writeFileSync(join(dir, INSTALLER_CHOICES_FILE), JSON.stringify({ v: 1, ...o }));
  const apply = (extra = {}) => applyInstallerChoices({ dir, readConfig, patchConfig, log: quiet, ...extra });
  return { dir, readConfig, patchConfig, choices, apply, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- what the installer's answer means ------------------------------------------------------------------------------
test('installerPatch: only the boxes the player changed on the page', () => {
  assert.deepEqual(INSTALLER_KEYS, ['presence', 'updateCheck']);
  // fresh install, both left ticked: nothing to change (both are on by default)
  assert.equal(installerPatch({ v: 1, presence: true, presenceShown: true, updateCheck: true, updateCheckShown: true }), null);
  assert.deepEqual(installerPatch({ v: 1, presence: false, presenceShown: true, updateCheck: true, updateCheckShown: true }), { presence: false });
  assert.deepEqual(installerPatch({ v: 1, presence: false, presenceShown: true, updateCheck: false, updateCheckShown: true }), { presence: false, updateCheck: false });
  // a reinstall: the page showed the count off (as the app had it) and the player ticked it again
  assert.deepEqual(installerPatch({ v: 1, presence: true, presenceShown: false, updateCheck: false, updateCheckShown: false }), { presence: true });
  // without …Shown the default (on) counts as shown
  assert.deepEqual(installerPatch({ v: 1, updateCheck: false }), { updateCheck: false });
  assert.equal(installerPatch({ v: 1, presence: true }), null);
});

test('installerPatch: anything else is ignored', () => {
  for (const raw of [null, undefined, 'x', 3, [], {}, { v: 2, presence: false }, { presence: false },
    { v: 1, presence: 'false', updateCheck: 0 }, { v: 1, presence: null }, { v: 1, theme: 'contrast', presenceShown: false }]) {
    assert.equal(installerPatch(raw), null, JSON.stringify(raw));
  }
  // only the two known keys, never another setting
  assert.deepEqual(installerPatch({ v: 1, presence: false, lang: 'de', onboarded: true }), { presence: false });
});

// ---- applied once, at the start ----------------------------------------------------------------------------------
test('applied once: into config.json, the file removed, the next start changes nothing', () => {
  const p = profile({ lang: 'de', onboarded: true, theme: 'contrast' });
  p.choices({ presence: false, presenceShown: true, updateCheck: false, updateCheckShown: true });
  assert.deepEqual(p.apply(), { presence: false, updateCheck: false });
  const c = p.readConfig();
  assert.equal(c.presence, false);
  assert.equal(c.updateCheck, false);
  assert.equal(c.lang, 'de', 'the rest of the config stays');
  assert.equal(c.theme, 'contrast');
  assert.ok(Number.isFinite(c.installerChoices), 'the file’s time is remembered');
  assert.equal(existsSync(join(p.dir, INSTALLER_CHOICES_FILE)), false, 'the file is gone');

  // the player switches the count on in the app; the next start doesn't undo it
  p.patchConfig({ presence: true });
  assert.equal(p.apply(), null);
  assert.equal(p.readConfig().presence, true);
  p.done();
});

test('a silent update (/S --updated) leaves no file – the settings changed in the app stay as they are', () => {
  // the in-app updater starts the installer silently: the page never shows, nothing is written
  assert.deepEqual(installerArgs({ relaunch: true }).slice(0, 2), ['/S', '--updated']);
  const p = profile({ presence: false, updateCheck: false, onboarded: true });
  const before = readFileSync(join(p.dir, 'config.json'), 'utf8');
  assert.equal(p.apply(), null);
  assert.equal(readFileSync(join(p.dir, 'config.json'), 'utf8'), before, 'config.json untouched');
  p.done();
});

test('a reinstall where nobody touched the boxes changes nothing', () => {
  // the page read config.json (count off, updates on) and showed exactly that; "Install" without a change
  const p = profile({ presence: false, onboarded: true });
  p.choices({ presence: false, presenceShown: false, updateCheck: true, updateCheckShown: true });
  assert.equal(p.apply(), null);
  const c = p.readConfig();
  assert.equal(c.presence, false);
  assert.equal('updateCheck' in c, false, 'no key written that was not changed');
  assert.equal(existsSync(join(p.dir, INSTALLER_CHOICES_FILE)), false);
  p.done();
});

test('a fresh install: config.json is created with the choice; a file that can’t be removed is still applied only once', () => {
  const p = profile(null);
  p.choices({ presence: false, presenceShown: true, updateCheck: true, updateCheckShown: true });
  const stuck = { readFileSync, statSync, rmSync: () => { throw new Error('EBUSY'); } };
  assert.deepEqual(p.apply({ fs: stuck }), { presence: false });
  assert.equal(p.readConfig().presence, false);
  // the player switches it on; the same (still present) file must not switch it off again
  p.patchConfig({ presence: true });
  assert.equal(p.apply({ fs: stuck }), null);
  assert.equal(p.readConfig().presence, true);
  // a newer installer run (a new file) counts again
  const f = join(p.dir, INSTALLER_CHOICES_FILE);
  const later = new Date(Date.now() + 60000);
  utimesSync(f, later, later);
  assert.deepEqual(p.apply(), { presence: false });
  assert.equal(existsSync(f), false);
  p.done();
});

test('a broken file is removed and ignored; a UTF-8 BOM is fine', () => {
  const p = profile({ onboarded: true });
  writeFileSync(join(p.dir, INSTALLER_CHOICES_FILE), '{"v":1,"presence":fal');
  assert.equal(p.apply(), null);
  assert.equal(existsSync(join(p.dir, INSTALLER_CHOICES_FILE)), false);
  assert.equal(p.readConfig().presence, undefined);
  const f = join(p.dir, INSTALLER_CHOICES_FILE);
  writeFileSync(f, '\uFEFF{"v":1,"updateCheck":false,"updateCheckShown":true}');
  const later = new Date(Date.now() + 60000); // (another installer run – a later file)
  utimesSync(f, later, later);
  assert.deepEqual(p.apply(), { updateCheck: false });
  p.done();
});

test('the start never fails over it: an unwritable config only logs', () => {
  const p = profile({ onboarded: true });
  p.choices({ presence: false, presenceShown: true });
  const warned = [];
  const r = applyInstallerChoices({ dir: p.dir, readConfig: p.readConfig, patchConfig: () => { throw new Error('EACCES'); }, log: { warn: (...a) => warned.push(a.join(' ')) } });
  assert.equal(r, null);
  assert.ok(warned.some((w) => /EACCES/.test(w)));
  p.done();
});

// ---- the update check obeys its setting --------------------------------------------------------------------------
function fakeTimers() {
  const jobs = [];
  return {
    setTimeout: (fn, ms) => { jobs.push({ fn, ms, every: false, live: true }); return jobs.length; },
    setInterval: (fn, ms) => { jobs.push({ fn, ms, every: true, live: true }); return jobs.length; },
    clearTimeout: (i) => { if (jobs[i - 1]) jobs[i - 1].live = false; },
    clearInterval: (i) => { if (jobs[i - 1]) jobs[i - 1].live = false; },
    /** the first check, then `n` intervals */
    run(n = 0) {
      for (const j of jobs) if (j.live && !j.every) { j.live = false; j.fn(); }
      for (let k = 0; k < n; k++) for (const j of jobs) if (j.live && j.every) j.fn();
    },
  };
}

test('update check: automatic checks only while the setting is on – read before every one', () => {
  assert.equal(autoCheckOn({}), true, 'on by default');
  assert.equal(autoCheckOn(null), true);
  assert.equal(autoCheckOn({ updateCheck: true }), true);
  assert.equal(autoCheckOn({ updateCheck: false }), false);

  let config = { updateCheck: false };
  let checks = 0;
  const timers = fakeTimers();
  const stop = scheduleUpdateChecks({ check: () => checks++, enabled: () => autoCheckOn(config), first: 20000, every: 4 * 3600e3, timers });
  timers.run(3);
  assert.equal(checks, 0, 'switched off: no request at the start, none every 4 hours');
  config = { updateCheck: true };
  timers.run(2);
  assert.equal(checks, 2, 'switched on again: the next interval checks, no restart needed');
  config = {};
  timers.run(1);
  assert.equal(checks, 3);
  stop();
  timers.run(5);
  assert.equal(checks, 3, 'stopped');
});

test('update check: on from the start (the default), and an unreadable setting means no request', () => {
  let checks = 0;
  const timers = fakeTimers();
  scheduleUpdateChecks({ check: () => checks++, enabled: () => autoCheckOn({}), first: 1, every: 10, timers });
  timers.run(2);
  assert.equal(checks, 3, 'at the start and every interval');
  let n = 0;
  const t2 = fakeTimers();
  scheduleUpdateChecks({ check: () => n++, enabled: () => { throw new Error('unreadable'); }, first: 1, every: 10, timers: t2 });
  t2.run(2);
  assert.equal(n, 0);
});

test('update check: the desktop app wires the setting into the updater; the manual check is not gated', () => {
  const main = readFileSync(join(root, 'electron', 'main.mjs'), 'utf8');
  assert.match(main, /setupUpdater\(\{[^}]*autoCheck: \(\) => autoCheckOn\(readConfig\(\)\)/);
  // the choices are applied before the updater and the server start
  assert.ok(main.indexOf('applyInstallerChoices({') < main.indexOf('setupUpdater({'), 'applied first');
  const updater = readFileSync(join(root, 'electron', 'updater.mjs'), 'utf8');
  assert.match(updater, /scheduleUpdateChecks\(\{ check: \(\) => check\(\), enabled: autoCheck/);
  assert.doesNotMatch(updater, /setInterval\(\(\) => check\(\)/, 'no ungated timer left');
  assert.match(updater, /handle\('update-check', \(\) => check\(\{ manual: true \}\)\)/, '"Check for updates" always asks');
});

// ---- "playing now" obeys its setting -----------------------------------------------------------------------------
test('"playing now": switched off on the installer page, nothing is sent; switched on in the app, it is', async () => {
  const p = profile({ onboarded: true });
  p.choices({ presence: false, presenceShown: true, updateCheck: true, updateCheckShown: true });
  p.apply();
  const { createPresence } = await import('../server/lib/presence.mjs');
  const sent = [];
  const fetchImpl = async (url, o) => { sent.push({ url, body: JSON.parse(o.body) }); return { ok: true, json: async () => ({}) }; };
  // server/app.mjs: presence({ enabled: () => loadConfig().presence !== false })
  const counter = createPresence({ enabled: () => p.readConfig().presence !== false, fetchImpl, env: { SOULDEW_LIVE_URL: 'http://127.0.0.1:9' }, timers: { setTimeout: () => ({}), clearTimeout() {} } });
  assert.equal((await counter.beat({ system: 'gba', mode: 'soullink' })).sent, false);
  assert.equal(sent.length, 0, 'not a single request');
  p.patchConfig({ presence: true });
  assert.equal((await counter.beat({ system: 'gba', mode: 'soullink' })).sent, true);
  assert.equal(sent.length, 1);
  p.done();
});

// ---- the setting through the local server ------------------------------------------------------------------------
let app;
let starting;
before(() => (starting = (async () => {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'config.json'), JSON.stringify({ onboarded: true }));
  const { startServer } = await import('../server/app.mjs');
  app = await startServer({ port: 0, background: false });
})()));
after(async () => {
  await starting?.catch(() => {});
  app?.server?.closeAllConnections?.();
  app?.server?.close();
  rmSync(DATA, { recursive: true, force: true });
});
const call = async (method, path, body) => {
  const r = await fetch(`${app.url}${path}`, { method, headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('server: "Check for updates automatically" is on by default, saved as a boolean, read by the updater from config.json', async () => {
  await starting;
  assert.equal((await call('GET', '/api/status')).body.config.updateCheck, true);
  assert.equal((await call('POST', '/api/config', { updateCheck: false })).status, 200);
  assert.equal((await call('GET', '/api/status')).body.config.updateCheck, false);
  const onDisk = JSON.parse(readFileSync(join(DATA, 'config.json'), 'utf8'));
  assert.equal(onDisk.updateCheck, false);
  assert.equal(autoCheckOn(onDisk), false, 'the updater reads the same key');
  await call('POST', '/api/config', { updateCheck: 'yes' });
  assert.equal(JSON.parse(readFileSync(join(DATA, 'config.json'), 'utf8')).updateCheck, true, 'anything but false is on');
  // the page can't write the installer's marker
  await call('POST', '/api/config', { installerChoices: 1 });
  assert.equal('installerChoices' in JSON.parse(readFileSync(join(DATA, 'config.json'), 'utf8')), false);
});

// ---- the installer script ----------------------------------------------------------------------------------------
const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('installer: the one-click NSIS installer includes the page, and nothing else takes its slot', () => {
  const n = pkg.build.nsis;
  assert.equal(n.include, 'build/installer.nsh');
  assert.equal(n.oneClick, true);
  assert.equal(n.perMachine, false, 'per user: $APPDATA is the player’s own');
  assert.equal(n.license, undefined, 'a license page would be a second licensePage macro');
  assert.equal(n.deleteAppDataOnUninstall, false, 'the data only goes after the question');
  assert.match(nsh, /!macro licensePage[\s\S]*Page custom sdPrivacyCreate sdPrivacyLeave[\s\S]*!macroend/);
  assert.match(nsh, /\$\{If\} \$\{isUpdated\}\s+Abort/, 'skipped for --updated');
  assert.match(nsh, /!undef MUI_PAGE_CUSTOMFUNCTION_PRE/, 'skipPageIfUpdated’s PRE never reaches the install page');
  // written only when the page was left with "Install" (never on /S, where pages don't run)
  assert.match(nsh, /!macro sdWriteChoices\s+\$\{If\} \$sdPrivacyShown == "1"/);
  assert.match(nsh, /!macro customInstall[\s\S]*!insertmacro sdWriteChoices[\s\S]*!macroend/);
  assert.ok(nsh.includes(`!define SD_POLICY_URL "${LINKS.privacyPolicy}"`), 'the same policy as the app links to');
  // souldew Renaissance: its own policy and its own data folder – never the official app's %APPDATA%\SoulLink Studio
  assert.equal(LINKS.privacyPolicy, EDITION.links.privacyPolicy);
  assert.ok(nsh.includes(`!define SD_DATA_DIR "$APPDATA\\${EDITION.dataFolder}"`), 'the app’s data folder (electron/main.mjs, shared/edition.mjs)');
  assert.ok(!/SD_DATA_DIR "[^"]*SoulLink Studio"/.test(nsh), 'never the official app’s data folder');
  assert.ok(nsh.includes(`\\${INSTALLER_CHOICES_FILE}"`));
});

test('installer: what it writes is what the app reads', () => {
  const m = nsh.match(/FileWrite \$0 '(\{[^']+\})'/);
  assert.ok(m, 'the FileWrite line');
  const fill = (v) => m[1].replace(/\$sd(\w+)/g, (_, k) => v[k]);
  const raw = JSON.parse(fill({ Presence: 'false', PresenceShown: 'true', UpdateCheck: 'true', UpdateCheckShown: 'true' }));
  assert.deepEqual(installerPatch(raw), { presence: false });
  assert.deepEqual(installerPatch(JSON.parse(fill({ Presence: 'true', PresenceShown: 'false', UpdateCheck: 'false', UpdateCheckShown: 'true' }))), { presence: true, updateCheck: false });
  for (const k of INSTALLER_KEYS) assert.ok(m[1].includes(`"${k}":`) && m[1].includes(`"${k}Shown":`), k);
});

test('installer: the page’s ticks follow config.json – its lines as the app writes them', () => {
  // the page looks for a top-level `  "presence": false` / `  "updateCheck": false` line (two spaces, as JSON.stringify(c, null, 2))
  const written = JSON.stringify({ lang: 'de', handheld: { presence: false }, presence: false, updateCheck: false }, null, 2).split('\n');
  for (const [key, len] of [['presence', 19], ['updateCheck', 22]]) {
    const probe = nsh.match(new RegExp(`StrCpy \\$2 \\$1 ${len}\\s+\\$\\{If\\} \\$2 == '([^']+)'`));
    assert.ok(probe, key);
    assert.equal(probe[1], `  "${key}": false`);
    assert.equal(probe[1].length, len);
    assert.equal(written.filter((l) => l.slice(0, len) === probe[1]).length, 1, `${key}: the top-level line only`);
  }
});

test('installer: every text in every language electron-builder bundles (makensis -WX), EN DE FR ES IT translated', () => {
  const langs = createRequire(import.meta.url)('app-builder-lib/out/util/langs.js');
  const macro = nsh.match(/!macro SD_STR NAME EN DE FR ES IT([\s\S]*?)!macroend/)[1];
  const ids = [...macro.matchAll(/LangString \$\{NAME\} (\d+) "\$\{(\w+)\}"/g)].map((x) => [Number(x[1]), x[2]]);
  const byId = new Map(ids);
  assert.equal(byId.size, ids.length, 'no language twice');
  for (const l of langs.bundledLanguages) assert.ok(byId.has(langs.lcid[l]), `${l} (${langs.lcid[l]})`);
  assert.equal(byId.size, langs.bundledLanguages.length);
  for (const [l, arg] of [['en_US', 'EN'], ['de_DE', 'DE'], ['fr_FR', 'FR'], ['es_ES', 'ES'], ['it_IT', 'IT']]) assert.equal(byId.get(langs.lcid[l]), arg, l);

  // each text: five non-empty translations, no stray `$` (NSIS would read a variable) and no plain double quote
  const uses = [...nsh.matchAll(/!insertmacro SD_STR (\w+)((?:[\s\\]+"[^"]*")+)/g)];
  const names = uses.map((u) => u[1]);
  for (const name of ['sdPrivTitle', 'sdPrivSub', 'sdPrivIntro', 'sdPol1', 'sdPol2', 'sdPol3', 'sdPol4', 'sdPol5', ...(EDITION.presence ? ['sdChkPresence'] : []), 'sdChkUpdates', 'sdPolicyLink', 'sdUnDeleteData']) {
    assert.ok(names.includes(name), name);
  }
  for (const [, name, args] of uses) {
    const texts = [...args.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    assert.equal(texts.length, 5, name);
    assert.equal(new Set(texts.slice(1)).size >= (name === 'sdPrivTitle' ? 3 : 4), true, `${name}: translated`);
    for (const t of texts) {
      assert.ok(t.trim().length > 0, name);
      assert.doesNotMatch(t.replace(/\$\\r\$\\n/g, ''), /\$/, `${name}: no stray $`);
    }
    // the four other languages are not just English
    assert.notEqual(texts[1], texts[0], `${name}: German`);
    assert.ok(nsh.includes(`$(${name})`), `${name} is used`);
  }
  // the policy mentions both switches and where to find them later
  const en = (name) => uses.find((u) => u[1] === name)[2].match(/"([^"]*)"/)[1];
  // (souldew Renaissance: no "playing now" count – the first part names its own server instead, the update check its repo)
  if (EDITION.presence) assert.match(en('sdPol1'), /api\.souldew\.app/);
  else assert.match(en('sdPol1'), /souldew\.pkmnrenaissance\.com[\s\S]*No “playing now” count/);
  assert.ok(!/souldew\.app|souldewapp/.test(nsh.replace(/^;.*$/gm, '')), 'no official souldew address outside the comments');
  assert.match(en('sdPol2'), /GitHub \(github\.com\/ralandel\/souldew\)/);
  assert.match(en('sdPol5'), /Start menu[\s\S]*desktop shortcut[\s\S]*Apps[\s\S]*No file types/);
});

test('installer: uninstalling by hand asks about the data – never on an update, "No" by default', () => {
  assert.match(nsh, /!macro customUnInit[\s\S]*\$\{GetOptions\} \$R0 "\/S" \$R1[\s\S]*\$\{AndIfNot\} \$\{isUpdated\}[\s\S]*MB_DEFBUTTON2[\s\S]*\/SD IDNO[\s\S]*!macroend/);
  assert.match(nsh, /!macro customUnInstall[\s\S]*\$\{If\} \$sdDeleteData == "1"[\s\S]*RMDir \/r "\$\{SD_DATA_DIR\}"[\s\S]*!macroend/);
  // the safe-graphics shortcut still goes with the app
  assert.match(nsh, /!macro customUnInstall[\s\S]*Delete "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\} \(safe graphics\)\.lnk"/);
});
