// "Find a SoulLink partner" (views/findpartner.mjs): the form's prefill. Pure, so test/findpartner.test.mjs checks it.

const LANG_NAMES = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano' };

/** "English, UTC+1" – the app's language and this computer's time zone, as a starting point the player can change. */
export function langAndZone(lang = 'en', offsetMin = new Date().getTimezoneOffset()) {
  const off = -offsetMin;
  const h = Math.trunc(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  const zone = off === 0 ? 'UTC' : `UTC${off > 0 ? '+' : '−'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
  return `${LANG_NAMES[lang] || LANG_NAMES.en}, ${zone}`;
}
