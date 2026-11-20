// No German for players who chose another language: the server, the desktop shell and shared code write their
// messages in English and send a code the page translates (web/lib/errors.mjs), the shell reads the page's
// dictionaries (electron/texts.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serverErrorText, buildLogText, SERVER_CODES } from '../web/lib/errors.mjs';
import { appLang, textsFor } from '../electron/texts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (name === 'data') continue; // game data tables (names per language)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(mjs|cjs)$/.test(name)) out.push(rel);
  }
  return out;
}
const FILES = ['server', 'electron', 'shared'].flatMap(sources);
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// ---- German in what players see ------------------------------------------------------------------

// Calls whose text reaches a player: API errors, errors that become one, build log lines, dialogs, SSE payloads.
const USER_FACING = /\b(?:httpError|logLine|saveError|onLog|showErrorBox|showMessageBox|showOpenDialog)\(|new Error\(|\{ error: |\berror: [`'"]|\b(?:title|message|detail|label|name): [`'"]/;
// Umlauts or words that only German has (the code itself is English – an identifier never matches).
const GERMAN = /[äöüÄÖÜß]|\b(?:nicht|keine?n?|bitte|fehlt|fehlen|ungültige?r?s?|fehlgeschlagen|wurde|konnte|Spieler|Spielstand|Datei|Fehler|gefunden|erwartet|Prüfsumme|beschädigt|entpackt|Speicherplatz|Ordner|Einstellungen|läuft|zu groß)\b/i;

/** The lines of `src` that send a player a German text (comments left out; a call's next line counts too). */
export function germanLines(src) {
  const lines = src.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
    const code = line.replace(/\s\/\/\s.*$/, '');
    if (!USER_FACING.test(code)) return;
    const next = /[(,]\s*$/.test(code) ? (lines[i + 1] || '').replace(/\s\/\/\s.*$/, '') : '';
    if (GERMAN.test(code) || GERMAN.test(next)) hits.push(`${i + 1}: ${line.trim().slice(0, 160)}`);
  });
  return hits;
}

test('the leak detector finds German messages and leaves English ones and comments alone', () => {
  assert.equal(germanLines("throw httpError(404, 'Run nicht gefunden', 'runNotFound');").length, 1);
  assert.equal(germanLines("onLog(`Randomisiere ROM für ${name} …`);").length, 1);
  assert.equal(germanLines("throw new Error('Keine freien Box-Plätze mehr.');").length, 1);
  assert.equal(germanLines("return send(res, 400, { error: 'Datei nicht vorhanden' });").length, 1);
  assert.equal(germanLines("dialog.showErrorBox(\n  'souldew konnte nicht starten', String(e));").length, 1);
  assert.equal(germanLines("throw httpError(404, 'Run not found', 'runNotFound');").length, 0);
  assert.equal(germanLines("// the old text was 'Run nicht gefunden'\nconst x = 1;").length, 0);
  assert.equal(germanLines("const kein = 1; // a German-looking name in a comment: nicht").length, 0);
});

test('server, desktop shell and shared code send players no German messages', () => {
  const leaks = [];
  for (const f of FILES) for (const hit of germanLines(read(f))) leaks.push(`${f}:${hit}`);
  assert.deepEqual(leaks, [], `German texts players can see – write them in English and send a code (web/lib/errors.mjs):\n${leaks.join('\n')}`);
});

// ---- codes the page translates ---------------------------------------------------------------------

/** Every literal error code the server and shared code send (httpError, `code:` in an answer, saveError). */
function sentCodes() {
  const codes = new Map();
  const add = (code, where) => codes.has(code) || codes.set(code, where);
  for (const f of FILES) {
    read(f).split('\n').forEach((line, i) => {
      const where = `${f}:${i + 1}`;
      for (const m of line.matchAll(/\b(?:httpError\(\d+, .*?|saveError\()'([A-Za-z]+)'(?=[,)])/g)) add(m[1], where);
      // (`code: 'x'`, or a choice `code: a ? 'x' : 'y'`)
      if (/send\(res|status: /.test(line)) for (const m of line.matchAll(/\bcode: [^,}]+/g)) for (const c of m[0].matchAll(/(?:\?|:) '([A-Za-z]+)'/g)) add(c[1], where);
    });
  }
  return codes;
}

test('every httpError in the server names a code', () => {
  const missing = [];
  for (const f of FILES.filter((x) => x.startsWith('server/'))) {
    read(f).split('\n').forEach((line, i) => {
      if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
      for (const m of line.matchAll(/httpError\(\d+, /g)) {
        const rest = line.slice(m.index);
        // the message, then a literal code or one handed on (e.code)
        if (!/^httpError\(\d+, (?:'[^']*'|`(?:[^`]|`[^`]*`)*`|[\w.]+), (?:'[A-Za-z]+'|[\w.]+\.code\b)/.test(rest)) missing.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(missing, [], 'an error without a code shows the server’s own text to every player');
});

test('every error code the server and shared code send has a text in all languages', () => {
  const codes = sentCodes();
  assert.ok(codes.size > 90, `found only ${codes.size} codes – did the pattern break?`);
  for (const code of ['randoFailed', 'noRun', 'teamEmpty', 'badRequest', 'javaMissing']) assert.ok(codes.has(code), `pattern misses ${code}`);
  const untranslated = [...codes].filter(([code]) => !SERVER_CODES.errors.includes(code)).map(([code, where]) => `${code} (${where})`);
  assert.deepEqual(untranslated, [], 'add these codes to TEXTS in web/lib/errors.mjs');
  for (const [code] of codes) assert.notEqual(serverErrorText({ code, error: '__fallback__' }), '__fallback__', code);
});

test('every build log line has a code with a text in the page', () => {
  const codes = new Map();
  for (const f of FILES) {
    read(f).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\blogLine\('([A-Za-z]+)'/g)) codes.set(m[1], `${f}:${i + 1}`);
      if (/\bonLog\(\s*[`'"]/.test(line)) codes.set('(plain string)', `${f}:${i + 1}`);
    });
  }
  assert.ok(codes.size >= 10, `found only ${codes.size} log lines – did the pattern break?`);
  const untranslated = [...codes].filter(([code]) => !SERVER_CODES.log.includes(code)).map(([code, where]) => `${code} (${where})`);
  assert.deepEqual(untranslated, [], 'build log lines go through logLine with a code in LOG_TEXTS (web/lib/errors.mjs)');
  assert.equal(buildLogText({ code: 'randomize', text: 'Randomizing …', vars: { name: 'Ash', seed: '42' } }), 'Randomizing the ROM for Ash (seed 42) …');
  assert.equal(buildLogText({ code: 'somethingNew', text: 'An English line' }), 'An English line');
  assert.equal(buildLogText('an older server’s line'), 'an older server’s line');
});

test('every code in the page’s tables has a translation in every language', () => {
  const src = read('web/lib/errors.mjs');
  // (the link session's codes share their texts with the play view's link bar: linkplay.*; the souldew account's have
  // their own, acctErr.* – `acct` itself is the account service's code, worded by accountError(); archiveUnsupported
  // shares the library's lib.skipArchive)
  const keys = [...src.matchAll(/\bt\('((?:err|buildLog|linkplay|acctErr)\.[A-Za-z0-9]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= SERVER_CODES.errors.length + SERVER_CODES.log.length - 2, 'every table entry is a t() call');
  for (const lang of ['de', 'fr', 'es', 'it']) {
    const dict = JSON.parse(read(`web/i18n/${lang}.json`));
    const missing = keys.filter((k) => typeof dict[k] !== 'string' || !dict[k]);
    assert.deepEqual(missing, [], `${lang}.json lacks these texts`);
  }
});

// ---- the desktop shell ------------------------------------------------------------------------------

test('desktop shell: the app language and its texts come from the page’s dictionaries, English as the fallback', () => {
  assert.equal(appLang('fr', 'de-DE'), 'fr');
  assert.equal(appLang(null, 'de-DE'), 'de');
  assert.equal(appLang(undefined, 'pt-BR'), 'en');
  assert.equal(appLang('xx', ''), 'en');
  const de = textsFor('de', join(ROOT, 'web', 'i18n'));
  assert.notEqual(de('menu.settings', 'Settings …'), 'Settings …');
  assert.equal(de('no.such.key', 'Fallback'), 'Fallback');
  const dir = mkdtempSync(join(tmpdir(), 'souldew-texts-'));
  try {
    writeFileSync(join(dir, 'it.json'), '{ broken');
    assert.equal(textsFor('it', dir)('menu.settings', 'Settings …'), 'Settings …');
    assert.equal(textsFor('en', dir)('menu.settings', 'Settings …'), 'Settings …');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
