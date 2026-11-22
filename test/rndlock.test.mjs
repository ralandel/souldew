// #43: Blaze Black 2 Redux + randomizer went black in the intro. Found with the fast player and the BB2R 1.4.1 patch,
// several seeds: the Classic preset's "National Pokédex from the start" tweak is an IPS of Black 2's retail intro script
// (script 854) – written over the hack's own intro script, the game stalls black before the name entry. Classic
// without it reached the player's room; "Every Pokémon can learn every HM" alone was not it (it is in Classic, and
// Classic without the tweak worked). The starters are written into the same script at fixed offsets – in the hack
// those hold other script bytes. The bridge now checks the places it writes at fixed offsets (SoulLinkBridge.java
// SafeGen5RomHandler.probe) and the new-run assistant greys out what the game can't have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lockedOptions, valuesForGame, PRESETS, buildValues, withDefaults } from '../shared/randomizer-options.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('rndlock: what the bridge says the game can\'t have is locked, with why', () => {
  assert.deepEqual([...lockedOptions(null)], []);
  assert.deepEqual([...lockedOptions({ startersSupported: true, tutorsSupported: true, shopsSupported: true })], []);
  assert.deepEqual([...lockedOptions({ startersSupported: false, tutorsSupported: false, shopsSupported: false })],
    [['startersMod', 'starters'], ['moveTutorMovesMod', 'tutors'], ['shopItemsMod', 'shops']]);
});

test('rndlock: Classic for Blaze Black 2 Redux – starters stay, the National Dex tweak goes, the rest as chosen', () => {
  // what the bridge answered for BB2R 1.4.1 (tools/upr-bridge, run on the patched ROM)
  const info = { startersSupported: false, tutorsSupported: true, shopsSupported: true, miscTweaks: ['UPDATE_TYPE_EFFECTIVENESS', 'FORCE_CHALLENGE_MODE', 'BAN_LUCKY_EGG', 'NO_FREE_LUCKY_EGG', 'BAN_BIG_MANIAC_ITEMS', 'RUN_WITHOUT_RUNNING_SHOES', 'DISABLE_LOW_HP_MUSIC'] };
  const classic = withDefaults(PRESETS[0].values);
  const v = valuesForGame(classic, info);
  assert.equal(v.startersMod, 'UNCHANGED');
  assert.deepEqual(v['@miscTweaks'], [], 'FASTEST_TEXT and NATIONAL_DEX_AT_START aren\'t offered for it');
  assert.equal(v.wildPokemonMod, classic.wildPokemonMod, 'the rest stays');
  assert.equal(v.fullHMCompat, true, 'HM compatibility stays – it was not the cause');
  assert.equal(classic.startersMod, 'RANDOM_WITH_TWO_EVOLUTIONS', 'the preset itself is unchanged');
  // a retail game: nothing changes (the same values object)
  assert.equal(valuesForGame(classic, { startersSupported: true }), classic);
  // what is stored in the run (so a partner's older app builds the same)
  assert.equal(buildValues(v, 5).startersMod, 'UNCHANGED');
  // tutors and shops locked → their default; the options under them go with them
  const all = valuesForGame({ ...classic, moveTutorMovesMod: 'RANDOM', shopItemsMod: 'RANDOM', banBadRandomShopItems: true }, { tutorsSupported: false, shopsSupported: false });
  assert.equal(all.moveTutorMovesMod, 'UNCHANGED');
  assert.equal(all.shopItemsMod, 'UNCHANGED');
});

test('rndlock: the bridge checks what it writes at fixed offsets in a Gen 5 game, and says so', () => {
  const java = read('tools/upr-bridge/SoulLinkBridge.java');
  // the starters: every offset of a starter must hold the same Pokémon (1…649) – else they stay, with a warning
  assert.match(java, /startersBroken = true;/);
  assert.match(java, /if \(v < 1 \|\| v > Gen5Constants\.pokemonCount \|\| \(species >= 0 && v != species\)\) throw/);
  assert.match(java, /public boolean setStarters\(List<Pokemon> starters\) \{\s*if \(startersBroken\) return true;/);
  assert.match(java, /Starters cannot be randomized in this ROM hack/);
  // the National Dex tweak's script, "Fastest text"'s main program: only where they are retail (checkable)
  assert.match(java, /natDexScriptUnknown = !isRomValid\(\) && \(startersBroken \|\| starterFile == null \|\| !starterFile\.equals\(natDex\)\);/);
  assert.match(java, /if \(natDexScriptUnknown\) v &= ~MiscTweak\.NATIONAL_DEX_AT_START\.getValue\(\);/);
  assert.match(java, /if \(arm9Changed\) v &= ~MiscTweak\.FASTEST_TEXT\.getValue\(\);/);
  // move tutors (an overlay at a fixed offset) and Black/White shops (an overlay at fixed offsets)
  assert.match(java, /tutorsBroken = !overlayRetail\(entry, ovl\) && !tutorTable\(readOverlay\(ovl\), \(Integer\) nums\.get\("MoveTutorDataOffset"\)\);/);
  assert.match(java, /shopsBroken = !overlayRetail\(entry, \(Integer\) nums\.get\("ShopItemOvlNumber"\)\);/);
  assert.match(java, /"\\"startersSupported\\":"/);
  assert.match(java, /"\\"tutorsSupported\\":"/);
  assert.match(java, /"\\"shopsSupported\\":"/);
  // the compiled bridge is the one in the repository (javac --release 8, docs/DEVELOPMENT.md)
  const cls = readFileSync(new URL('../tools/upr-bridge/SoulLinkBridge$SafeGen5RomHandler.class', import.meta.url));
  assert.ok(cls.includes(Buffer.from('startersBroken')) && cls.includes(Buffer.from('natDexScriptUnknown')) && cls.includes(Buffer.from('tutorsBroken')));
});

test('rndlock: the new-run assistant greys them out with why, and builds the game without them', () => {
  const view = read('web/views/soullink.mjs');
  assert.match(view, /const locked = lockedOptions\(inspect\?\.info\);\s*const shown = valuesForGame\(values, inspect\?\.info\);/);
  assert.match(view, /values: buildValues\(valuesForGame\(values, inspect\?\.info\), gen\)/);
  assert.match(view, /locked=\$\{locked\.get\(f\.key\) \|\| null\}/);
  assert.match(view, /t\('new\.lockStarters', 'Not in this ROM hack: it has its own intro, so its starters stay as they are\.'\)/);
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const L = JSON.parse(read(`web/i18n/${lang}.json`));
    for (const k of ['new.lockStarters', 'new.lockTutors', 'new.lockShops', 'new.noStarters', 'err.patchNoFit']) assert.ok(L[k], `${lang}: ${k}`);
  }
});
