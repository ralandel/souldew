// Settings in tabs (views/settings.mjs, views/settings/*.mjs, lib/settingsindex.mjs): every setting of the old single
// page still exists and is rendered in a tab, the search finds settings by English and translated labels and by
// synonyms, the URL picks the tab and deep links land on their setting, and every link into Settings is valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { EDITION } from '../shared/edition.mjs';

const {
  SECTIONS, VISIBLE_SECTIONS, SETTINGS, settingById, searchSettings, settingsRoute, settingsLink, haystack, norm, queryWords, matches,
} = await import('../web/lib/settingsindex.mjs');

const web = (p) => readFileSync(new URL(`../web/${p}`, import.meta.url), 'utf8');
const i18n = (lang) => JSON.parse(web(`i18n/${lang}.json`));
const EN = i18n('en');
const SECTION_FILES = Object.fromEntries(VISIBLE_SECTIONS.map((s) => [s, web(`views/settings/${s}.mjs`)]));
const ALL_SETTINGS_SRC = [web('views/settings.mjs'), web('views/settings/parts.mjs'), ...Object.values(SECTION_FILES)].join('\n');
const itemIds = (src) => [...src.matchAll(/<\$\{Item\} id="([\w-]+)"/g)].map((m) => m[1]);

// Every setting the single Settings page had before the tabs (2.x / early 3.0): its entry, and the code that changes it
// (the config key it saves, or the call / component that does the work). A lost setting fails here.
const OLD_SETTINGS = [
  ['language', 'save({ lang:'], ['name', 'save({ playerName:'], ['animations', 'save({ bootAnimation:'], ['sounds', 'save({ sounds:'],
  ['tour', 'save({ onboarded: false })'], ['theme', 'save({ theme:'],
  ['full-turbo', 'save({ fullTurbo:'], ['speed-guard', 'save({ speedGuard:'], ['turbo-max', 'save({ turboMax:'], ['whole-pixels', 'save({ wholePixels:'],
  ['gb-look', 'save({ gbLook:'], ['ctr-scale', 'save({ ctrScale:'], ['native', 'save({ nativeCore:'], ['engine', 'save({ nativeEngine:'],
  ['keyboard', 'save({ controls: next })'], ['controller', "save({ pads: { preset: id"], ['pad-nav', 'save({ padNav:'],
  ['library', "api.post('/api/library/reveal'"], ['library', 'folders({ remove: f })'], ['library', 'folders({ add: paths[0] })'],
  ['emulator-for', 'save({ emulatorFor:'], ['install', 'install(id)'], ['install', 'mgbaScriptAgain'],
  ['share-screen', 'save({ shareScreen:'], ['discord', '<${LiveRunsSettings} />'], ['coffee-pop', "api.post('/api/stream', { coffee: on })"], ['presence', 'save({ presence:'],
  ['updates', '<${UpdateSection} />'], ['gpu', 'save({ gpuBackend:'], ['ctr-renderer', 'save({ ctrRenderer:'], ['nag', 'save({ nagOff:'],
  ['credits', 'LINKS.github'], ['credits', 'LINKS.issues'], ['credits', 'LINKS.coffee'],
];

// Every label, hint and message of the old page (its t() keys) – still shown somewhere in Settings. (2.8.3's page: the
// shortcuts became rows of their own – the texts about keys taken by a shortcut went with it – and "playing now".)
const OLD_KEYS = `common.cancel common.copied common.copy common.remove common.save ctl.custom ctl.customHint ctl.layoutGuess
ctl.layoutSystem ctl.presetArrows ctl.presets ctl.press ctl.swap ctl.touch ctl.unbindable keys.button keys.key
 lib.reveal nav.settings pad.auto pad.autoHint pad.autoNone pad.button pad.connectFirst pad.generic pad.layouts pad.missing
pad.nav pad.navHint pad.nintendo pad.none pad.nonStandard pad.notAPad pad.onlyOdd pad.posBottom pad.posLeft pad.posRight pad.posTop
pad.press pad.remembered pad.stick pad.switch pad.text pad.title pad.use pad.xbox rail.coffee set.about set.addFolder
set.appearance set.boot set.builtin set.bundled set.coffeePop set.coffeePopHint set.controls set.covers set.ctrRenderer
set.ctrRendererAuto set.ctrRendererCompat set.ctrRendererHint set.ctrRendererLearned set.ctrRendererSoftware set.ctrScale set.ctrScale1
set.ctrScaleHint set.data set.emuCore set.emulators set.emuText set.engine set.engineHint set.fullTurbo set.fullTurboHint set.gbLook
set.gbLookColor set.gbLookHint set.gbLookOriginal set.general set.github set.gpu set.gpuAuto set.gpuFallbackCrash set.gpuFallbackStart
set.gpuHint set.gpuRestart set.gpuSafeNote set.gpuSafeRestart set.install set.installed set.installing set.javaMissing set.language set.legal
set.library set.libraryText set.liveRpc set.liveSave set.liveScript set.mgbaScriptAgain set.nag set.nagHint set.name set.native set.nativeHint
set.nativeShort set.notInstalled set.randomizer set.replayOnboarding set.reportBug set.saveFailed set.shareScreenAll set.shareScreenHint
set.soundsAll set.speedGuard set.speedGuardFull set.speedGuardHint set.system set.theme set.themeText set.turboMax set.turboMaxHint set.useEmu
set.wholePixels set.wholePixelsHint theme.classic theme.classicHint theme.contrast theme.contrastHint theme.deutan theme.deutanHint theme.tritan
theme.tritanHint upd.restart
ctl.alsoKey ctl.hotkeyUnbindable ctl.keepKey ctl.menu ctl.noKey ctl.none ctl.pressFor ctl.refusedNow ctl.resetBar ctl.sneakHint ctl.system
ctl.tookOver2 ctl.undo guide.shortcuts pad.home pad.navHintHome pad.pressFor pad.sneak set.controlsText2 set.presence set.presenceHint set.presenceMore`.split(/\s+/);

test('every setting of the old page still has its entry, is rendered in its tab and still saves the same thing', () => {
  for (const [id, code] of OLD_SETTINGS) {
    const e = settingById(id);
    assert.ok(e, `${id}: entry in lib/settingsindex.mjs`);
    assert.ok(VISIBLE_SECTIONS.includes(e.section), `${id}: its section ${e.section} is a visible tab`);
    const src = SECTION_FILES[e.section];
    assert.ok(itemIds(src).includes(id), `${id}: rendered as <Item id="${id}"> in views/settings/${e.section}.mjs`);
    assert.ok(src.includes(code), `${id}: views/settings/${e.section}.mjs still does ${code}`);
  }
  // …and Turbo audio (until now only in the game's sound menu) is a setting here too, on the same stored value
  assert.match(SECTION_FILES.play, /<\$\{Item\} id="turbo-audio">/);
  assert.match(SECTION_FILES.play, /'sl-turbo-audio'/);
});

test('every label and hint of the old page is still shown in Settings', () => {
  const used = new Set([...ALL_SETTINGS_SRC.matchAll(/\bt\('([\w.-]+)'/g)].map((m) => m[1]));
  const lost = OLD_KEYS.filter((k) => !used.has(k));
  assert.deepEqual(lost, [], `texts no longer in Settings: ${lost.join(', ')}`);
});

test('each entry is rendered exactly once, in the file of its own section – and nothing is rendered without an entry', () => {
  const seen = {};
  for (const [section, src] of Object.entries(SECTION_FILES)) {
    for (const id of itemIds(src)) {
      assert.ok(settingById(id), `<Item id="${id}"> in ${section}.mjs has no entry`);
      assert.equal(settingById(id).section, section, `${id} is rendered in ${section}, its entry says ${settingById(id).section}`);
      seen[id] = (seen[id] || 0) + 1;
    }
  }
  // (a hidden section's file isn't read – souldew Renaissance hides Account: shared/edition.mjs accounts: false)
  for (const e of SETTINGS) if (VISIBLE_SECTIONS.includes(e.section)) assert.equal(seen[e.id], 1, `${e.id} rendered ${seen[e.id] || 0}×`);
  assert.equal(new Set(SETTINGS.map((e) => e.id)).size, SETTINGS.length, 'ids are unique');
  // the view renders a body for every visible section
  const body = web('views/settings.mjs').match(/const BODY = \{([^}]+)\}/)[1];
  for (const s of VISIBLE_SECTIONS) assert.match(body, new RegExp(`\\b${s}:`), `BODY has ${s}`);
});

test('the texts the search reads exist in English and every app language; the tab names are translated', () => {
  for (const e of SETTINGS) for (const k of e.keys) assert.ok(EN[k], `${e.id}: ${k} in en.json`);
  for (const lang of ['de', 'fr', 'es', 'it']) {
    const tr = i18n(lang);
    for (const k of ['set.general', 'set.tabPlay', 'set.controls', 'set.tabGames', 'set.tabOnline', 'set.tabAccount', 'set.about', 'set.search', 'set.trouble']) assert.ok(tr[k], `${lang}: ${k}`);
    // no menu path in the app still names a section that is gone
    for (const [k, v] of Object.entries(tr)) assert.ok(!/›\s*(Emulatoren|Émulateurs|Emuladores|Emulatori)\b/.test(v) || k.startsWith('faq.'), `${lang}: ${k} still points at the old Emulators section`);
  }
  for (const [k, v] of Object.entries(EN)) assert.ok(!/Settings › (Emulators|General|Discord|Game Boy look)\b/.test(v), `${k} still points at an old section: ${v}`);
});

test('sections: tab order – the Account section (souldew account) sits between Online and About', () => {
  assert.deepEqual(SECTIONS.map((s) => s.id), ['general', 'play', 'controls', 'games', 'online', 'account', 'about']);
  // souldew Renaissance: the tab is there only with the souldew account (shared/edition.mjs accounts)
  assert.deepEqual(VISIBLE_SECTIONS, ['general', 'play', 'controls', 'games', 'online', ...(EDITION.accounts ? ['account'] : []), 'about']);
  assert.deepEqual(SETTINGS.filter((e) => e.section === 'account').map((e) => e.id), ['account', 'account-privacy', 'plus-show', 'plus', 'account-sessions', 'account-data']);
});

test('the URL picks the tab: s=, else the remembered tab, else General – and a deep link opens its setting’s own tab', () => {
  assert.deepEqual(settingsRoute({}), { section: 'general', setting: null });
  assert.deepEqual(settingsRoute({}, 'games'), { section: 'games', setting: null });
  assert.deepEqual(settingsRoute({ s: 'play' }, 'games'), { section: 'play', setting: null });
  assert.deepEqual(settingsRoute({ s: 'nonsense' }, 'nonsense'), { section: 'general', setting: null });
  assert.deepEqual(settingsRoute({ s: 'account' }), { section: EDITION.accounts ? 'account' : 'general', setting: null });
  assert.deepEqual(settingsRoute({ s: 'play', f: 'turbo-audio' }), { section: 'play', setting: 'turbo-audio' });
  assert.deepEqual(settingsRoute({ f: 'discord' }, 'about'), { section: 'online', setting: 'discord' }, 'f alone');
  assert.deepEqual(settingsRoute({ s: 'general', f: 'gpu' }), { section: 'about', setting: 'gpu' }, 'a setting that moved keeps its links');
  assert.deepEqual(settingsRoute({ s: 'play', f: 'nope' }), { section: 'play', setting: null });
  assert.deepEqual(settingsLink('turbo-audio'), { s: 'play', f: 'turbo-audio' });
  assert.deepEqual(settingsLink('controls'), { s: 'controls' });
  assert.deepEqual(settingsLink('nope'), {});
});

test('every link into Settings opens a real section and setting', () => {
  const files = [];
  const walk = (dir) => {
    for (const d of readdirSync(new URL(`../web/${dir}`, import.meta.url), { withFileTypes: true })) {
      if (d.isDirectory() && !['vendor', 'i18n', 'assets'].includes(d.name)) walk(`${dir}${d.name}/`);
      else if (d.name.endsWith('.mjs')) files.push(`${dir}${d.name}`);
    }
  };
  walk('');
  let links = 0;
  for (const f of files) {
    const src = web(f);
    for (const m of src.matchAll(/settingsLink\('([\w-]+)'\)/g)) {
      links++;
      // (a hidden section is still a real one: its links only show in a build that has it)
      assert.ok(settingById(m[1]) || SECTIONS.some((s) => s.id === m[1]), `${f}: settingsLink('${m[1]}')`);
    }
    for (const m of src.matchAll(/#\/settings\?([\w=&-]+)/g)) {
      const p = Object.fromEntries(new URLSearchParams(m[1]));
      assert.ok(!p.s || SECTIONS.some((s) => s.id === p.s), `${f}: ${m[0]}`);
      assert.ok(!p.f || settingById(p.f), `${f}: ${m[0]}`);
    }
    // a bare navigate('settings') would open whatever tab was open last, not the place the button talks about
    if (f !== 'app.mjs') assert.ok(!/navigate\('settings'\)/.test(src), `${f}: navigate('settings') without a section`);
  }
  assert.ok(links >= 6, `${links} deep links`);
  // the ones named in the 3.0 brief
  assert.match(web('views/liveshare.mjs'), /settingsLink\('discord'\)/);
  assert.match(web('views/playdock.mjs'), /settingsLink\(place\)/);
  assert.match(web('views/play.mjs'), /settingsLink\('turbo-audio'\)/);
});

// ---- search ---------------------------------------------------------------------------------------------------------

const KEY = { general: 'set.general', play: 'set.tabPlay', controls: 'set.controls', games: 'set.tabGames', online: 'set.tabOnline', about: 'set.about' };
const texts = (lang) => {
  const local = lang === 'en' ? {} : i18n(lang);
  return { english: EN, local, sectionName: (id) => [EN[KEY[id]], local[KEY[id]]] };
};
const find = (q, lang = 'en', opts) => Object.fromEntries(searchSettings(q, texts(lang), opts).map((h) => [h.section, h.ids]));
const ids = (q, lang, opts) => Object.values(find(q, lang, opts)).flat();

test('search: words fold case, accents and punctuation; every word has to match', () => {
  assert.equal(norm('Écran – “Vollbild”!'), 'ecran – vollbild');
  assert.deepEqual(queryWords('  Fast   Forward '), ['fast', 'forward']);
  assert.ok(matches(['pad'], 'gamepad joystick'));
  assert.ok(!matches([], 'anything'));
  assert.ok(!matches(['pad', 'zzz'], 'gamepad'));
  assert.deepEqual(find(''), {});
  assert.deepEqual(find('   '), {});
  assert.deepEqual(find('qwertzuiop'), {});
});

test('search: "turbo" finds the three speed settings and Turbo audio, in tab order', () => {
  const r = find('turbo');
  assert.deepEqual(Object.keys(r)[0], 'play');
  for (const id of ['full-turbo', 'speed-guard', 'turbo-max', 'turbo-audio']) assert.ok(r.play.includes(id), id);
});

test('search: synonyms – fast forward, gamepad, vulkan, obs, nickname, colour-blind', () => {
  assert.ok(ids('fast forward').includes('full-turbo'));
  assert.ok(ids('fast-forward').includes('turbo-max'));
  assert.deepEqual(find('gamepad').controls?.slice(0, 2), ['controller', 'pad-nav']);
  assert.ok(ids('dualsense').includes('controller'));
  assert.deepEqual(find('vulkan').about, ['gpu', 'ctr-renderer']);
  assert.deepEqual(ids('obs'), ['coffee-pop']);
  assert.deepEqual(ids('nickname'), ['name']);
  assert.ok(ids('colorblind').includes('theme'));
  assert.ok(ids('wasd').includes('keyboard'));
  assert.ok(ids('roms').includes('library'));
});

test('search: labels in the current app language and in English both work', () => {
  // German UI: the German label …
  assert.ok(ids('Sprache', 'de').includes('language'));
  assert.ok(ids('Tastatur', 'de').includes('keyboard'));
  assert.ok(ids('Farbschema', 'de').includes('theme'));
  assert.ok(ids('Fehlerbehebung', 'de').includes('diagnostics'), 'section and group names count');
  // … and still the English one
  assert.ok(ids('language', 'de').includes('language'));
  assert.ok(ids('whole pixels', 'de').includes('whole-pixels'));
  // French with and without accents, Spanish, Italian
  assert.ok(ids('manette', 'fr').includes('controller'));
  assert.ok(ids('écran', 'fr').includes('share-screen'));
  assert.ok(ids('ecran', 'fr').includes('share-screen'));
  assert.ok(ids('mando', 'es').includes('controller'));
  assert.ok(ids('idioma', 'es').includes('language'));
  assert.ok(ids('tastiera', 'it').includes('keyboard'));
  // the other languages' everyday words find a setting even in an English UI
  assert.ok(ids('vorspulen').includes('full-turbo'));
  assert.ok(ids('sprache').includes('language'));
});

test('search: only settings that exist on this computer, and the extra text the page shows', () => {
  assert.ok(!ids('vulkan', 'en', { available: (id) => id !== 'gpu' }).includes('gpu'));
  assert.deepEqual(ids('melonds', 'en', { extra: (id) => (id === 'install' ? 'melonDS DS installed' : '') }).includes('install'), true);
  // the search text of an entry: label + hint in both languages, keywords, section name
  const h = haystack(settingById('turbo-audio'), texts('de'));
  assert.ok(h.includes('turbo audio') && h.includes('turbo-ton') && h.includes('spielen'), h.slice(0, 120));
});
