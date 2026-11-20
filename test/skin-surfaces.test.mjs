// Light souldew+ skins (Soft Light, Sunbleached, Glacier, Sakura, Cartridge Grey) must never show a dark field,
// popover, menu, hint, toast or dialog: a skin only sets tokens (--sk-field, --sk-well, --sk-line, --sk-shadow …) and
// rules for the selectors it knows – a surface the app paints with a hard-coded dark colour stays dark in every skin.
// (That is how the Settings search ended up a black pill on Soft Light.) So: every such surface in the app's own
// stylesheets takes its colour from a skin token with classic's colour as the fallback – var(--sk-field, #121116),
// var(--sk-well, …), or a --lt-* token of styles.css (defined only when a light skin is on). Surfaces that are dark by
// design in every skin – the game screen and what sits on it, LCD displays, the trophy case – are listed below.
// test/skin-proof.test.mjs checks the rendered app in every skin on top of this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '..', 'web');
// fields, wells, popovers, menus, hints, tooltips, toasts, dialogs – and the chrome around them
const SURFACE = /(^|[\s,>+~(])(input|select|textarea)\b|search|-pop\b|popover|menu|hint|tooltip|\.tip\b|toast|dialog|modal|\.log\b|details|\.attn\b|\.chip\b|\.seg\b|\.kbd\b|rule-presets|states-panel|coffee-float|\.power|\.warning|\.inbox|run-banner|update-|fs-|\.dock\b|speed-real|gstrip/;
// dark in every skin, by design
const ALWAYS_DARK = /::backdrop|console-screen|\.screen|launch-screen|\.osd|\.boot\b|mini-open|\.ps-|\.pt-|cart-|\.ci-|nag-|\.onboard|onb-|html\[data-theme='contrast'\]/;

const lum = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const hex = (h) => {
  let x = h.slice(1);
  if (x.length <= 4) x = [...x].map((c) => c + c).join('');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1];
};
const colours = (v) => [...v.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => hex(m[0]))
  .concat([...v.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\)/g)].map((m) => [+m[1], +m[2], +m[3], m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) : 1]));
/** flat rules of a stylesheet (nested at-rule blocks are flattened – only selector { declarations } pairs matter) */
const rules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]]);

test('no field, popover, menu, hint, toast or dialog is a hard-coded dark surface (light skins would keep it dark)', () => {
  const found = [];
  let checked = 0;
  for (const f of readdirSync(WEB).filter((x) => x.endsWith('.css'))) {
    for (const [sel, body] of rules(readFileSync(join(WEB, f), 'utf8'))) {
      const parts = sel.split(',').map((s) => s.trim()).filter((s) => SURFACE.test(s) && !ALWAYS_DARK.test(s));
      if (!parts.length) continue;
      for (const m of body.matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g)) {
        checked++;
        // a skin token with classic's colour as its fallback is what we want – the fallback is classic only
        const v = m[1].replace(/var\(--(sk|lt)-[a-z-]+\s*,\s*(?:[^()]|\([^()]*\))*\)/g, 'transparent');
        const dark = colours(v).filter((c) => c[3] >= 0.25 && lum(c) < 0.03);
        if (dark.length) found.push(`${f}: ${parts.join(', ')} { background: ${m[1].trim().slice(0, 80)} }`);
      }
    }
  }
  assert.ok(checked > 40, `${checked} surface backgrounds checked`);
  assert.deepEqual(found, []);
});

test('the light-skin tokens exist only with a light skin (built from --sk-field / --sk-shadow, which only light skins set)', () => {
  const css = readFileSync(join(WEB, 'styles.css'), 'utf8');
  const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  const tokens = [...root.matchAll(/(--lt-[a-z-]+):\s*([^;]+);/g)];
  assert.ok(tokens.length >= 5, 'the --lt-* tokens are declared on :root');
  for (const [, name, value] of tokens) assert.match(value, /var\(--sk-(field|shadow)\)/, `${name} must depend on a light-only skin token (no fallback), or it would change classic`);
  // and every --lt-* use has classic's value as its fallback
  for (const f of readdirSync(WEB).filter((x) => x.endsWith('.css'))) {
    for (const m of readFileSync(join(WEB, f), 'utf8').matchAll(/var\((--lt-[a-z-]+)(\s*,)?/g)) assert.ok(m[2], `${f}: var(${m[1]}) needs classic's value as the fallback`);
  }
});
