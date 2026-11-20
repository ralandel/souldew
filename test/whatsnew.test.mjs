// "What's new in 3.0" (web/lib/whatsnew.mjs, web/views/whatsnew.mjs): who gets the cards and when, that closing them
// marks them seen, that Help and Settings open them again, and that their pictures are small, served right and there in
// every language's texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITION } from '../shared/edition.mjs';
import { WHATS_NEW, WHATS_NEW_CARDS, WHATS_NEW_EVENT, cardMedia, whatsNewPending, mayShowWhatsNew, whatsNewSeenPatch, skipUpdatedToast, stepCard } from '../web/lib/whatsnew.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

test('whatsnew: only an onboarded install the server marked gets the cards – a new user gets the welcome tour', () => {
  assert.equal(WHATS_NEW, '3.0');
  assert.equal(whatsNewPending({ onboarded: true, whatsNew: '3.0' }), true);
  // a new install (or one that never finished the welcome tour): the welcome tour, not the cards
  assert.equal(whatsNewPending({ onboarded: false, whatsNew: '3.0' }), false);
  assert.equal(whatsNewPending({ onboarded: false }), false);
  // seen, never marked, another version, junk
  for (const whatsNew of [null, undefined, '', '2.8', '3.1', 3, true]) assert.equal(whatsNewPending({ onboarded: true, whatsNew }), false, String(whatsNew));
  assert.equal(whatsNewPending(null), false);
  assert.equal(whatsNewPending(undefined), false);
});

test('whatsnew: never over the start-up animation, a running game or another dialog – it waits', () => {
  const config = { onboarded: true, whatsNew: '3.0' };
  assert.equal(mayShowWhatsNew({ config }), true);
  assert.equal(mayShowWhatsNew({ config, boot: true }), false);
  assert.equal(mayShowWhatsNew({ config, playing: true }), false);
  assert.equal(mayShowWhatsNew({ config, dialogOpen: true }), false);
  assert.equal(mayShowWhatsNew({ config: { ...config, onboarded: false } }), false, 'the welcome tour first');
  assert.equal(mayShowWhatsNew({ config: { onboarded: true, whatsNew: null } }), false, 'once seen, never again by itself');
  assert.equal(mayShowWhatsNew(), false);
});

test('whatsnew: closing marks the cards seen – the only value the page sends', () => {
  assert.deepEqual(whatsNewSeenPatch(), { whatsNew: null });
});

test('whatsnew: no "Updated" toast on top of the cards, the toast as before otherwise', () => {
  assert.equal(skipUpdatedToast({ onboarded: true, whatsNew: '3.0' }), true);
  assert.equal(skipUpdatedToast({ onboarded: true, whatsNew: null }), false);
  assert.equal(skipUpdatedToast({ onboarded: false, whatsNew: '3.0' }), false);
});

test('whatsnew: arrows and Home / End page through without wrapping around', () => {
  const n = WHATS_NEW_CARDS.length;
  assert.equal(stepCard(0, 'ArrowRight'), 1);
  assert.equal(stepCard(n - 1, 'ArrowRight'), n - 1);
  assert.equal(stepCard(0, 'ArrowLeft'), 0);
  assert.equal(stepCard(3, 'ArrowLeft'), 2);
  assert.equal(stepCard(2, 'Home'), 0);
  assert.equal(stepCard(0, 'End'), n - 1);
  assert.equal(stepCard(2, 'Enter'), 2);
  assert.equal(stepCard(1, 'PageDown'), 2);
});

test('whatsnew: at most five cards – play together, Shared World, raids, the handheld, friends', () => {
  // (souldew Renaissance: no account, no souldew+ – the handheld's and the friends' cards stay out)
  assert.ok(WHATS_NEW_CARDS.length >= 3 && WHATS_NEW_CARDS.length <= 5);
  assert.deepEqual(WHATS_NEW_CARDS.map((c) => c.id), ['together', 'world', 'raid', ...(EDITION.accounts ? ['handheld', 'friends'] : [])]);
});

test('whatsnew: every card has a small WebP picture, served as image/webp from the app\'s own origin', () => {
  for (const { id } of WHATS_NEW_CARDS) {
    const url = cardMedia(id);
    assert.match(url, /^\/assets\/whatsnew\/[a-z]+\.webp$/);
    const file = join(ROOT, 'web', url);
    const head = readFileSync(file).subarray(0, 12);
    assert.equal(head.subarray(0, 4).toString('latin1'), 'RIFF', `${id}: a RIFF file`);
    assert.equal(head.subarray(8, 12).toString('latin1'), 'WEBP', `${id}: a WebP picture`);
    assert.ok(statSync(file).size < 150 * 1024, `${id}: ${statSync(file).size} bytes`);
  }
  assert.match(src('server/app.mjs'), /'\.webp': 'image\/webp'/, 'the server names the type (it sends nosniff)');
  assert.match(src('server/lib/csp.mjs'), /'img-src': \["'self'"/);
});

test('whatsnew: every card\'s title and line in every language', () => {
  const view = src('web/views/whatsnew.mjs');
  const langs = ['en', 'de', 'fr', 'es', 'it'].map((l) => [l, JSON.parse(src(`web/i18n/${l}.json`))]);
  for (const { id } of WHATS_NEW_CARDS) {
    for (const k of [`wn.${id}Title`, `wn.${id}Text`]) {
      assert.ok(view.includes(`t('${k}'`), `${k} in the view`);
      for (const [l, d] of langs) assert.ok(typeof d[k] === 'string' && d[k].length > 0, `${l}: ${k}`);
    }
  }
  // one short line each
  const en = langs[0][1];
  for (const { id } of WHATS_NEW_CARDS) assert.ok(en[`wn.${id}Text`].length <= 120, `${id}: ${en[`wn.${id}Text`].length} characters`);
});

test('whatsnew: the app wires it – shown once after the update, opened again from Help and Settings, no toast on top', () => {
  const app = src('web/app.mjs');
  assert.match(app, /<\$\{WhatsNew\} open=\$\{whatsNew\} onClose=\$\{closeWhatsNew\} \/>/);
  assert.match(app, /mayShowWhatsNew\(\{ config: status\?\.config, boot, playing: !!sessionRef\.current, dialogOpen: /);
  assert.match(app, /api\.post\('\/api\/config', whatsNewSeenPatch\(\)\)/);
  assert.match(app, /addEventListener\(WHATS_NEW_EVENT, open\)/);
  // the joke license window never takes that first start
  assert.match(app, /!whatsNewPending\(status\.config\) && shouldNag/);
  assert.equal(WHATS_NEW_EVENT, 'souldew:whatsnew');
  for (const f of ['web/views/guide.mjs', 'web/views/settings/general.mjs']) assert.match(src(f), /dispatchEvent\(new Event\(WHATS_NEW_EVENT\)\)/, f);
  assert.match(src('web/views/update.mjs'), /skipUpdatedToast\(status\?\.config\)/);
  assert.match(src('web/index.html'), /href="\/whatsnew\.css"/);
});
