// "Find a SoulLink partner": the form's prefill of language and time zone (web/lib/lfg.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { langAndZone } from '../web/lib/lfg.mjs';

test('language and time zone: the app language and this computer’s offset, as plain text', () => {
  assert.equal(langAndZone('en', -60), 'English, UTC+1');
  assert.equal(langAndZone('de', -120), 'Deutsch, UTC+2');
  assert.equal(langAndZone('fr', 0), 'Français, UTC');
  assert.equal(langAndZone('es', 300), 'Español, UTC−5');
  assert.equal(langAndZone('it', -330), 'Italiano, UTC+5:30');
  assert.equal(langAndZone('xx', -60), 'English, UTC+1');
});
