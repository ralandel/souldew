// souldew+ skins: html[data-skin="…"] plus that skin's stylesheet from the verified pack, injected as a <style> (the CSP
// allows inline styles; fonts and art the CSS uses become data: URLs, which font-src / img-src allow). A skin changes
// the look only – never a box, never a text (proven by test/skin-proof.test.mjs on the real app views).
//
// Three layers of "which skin": the committed one (what the player chose, owned), a pending wish (chosen, but the pack
// isn't loaded yet – applied the moment it is, if still owned), and a preview (Settings: tried on, never saved,
// reverted by endPreview()). Independent of html[data-theme] (the colour schemes): every skin carries its own rules for
// High contrast, Red-green safe and Blue-yellow safe.
import { CATALOG, content, onChange, owned, has } from './state.mjs';
import { b64encode } from './pack/format.mjs';
import { syncTitleBar } from '../theme.mjs';
import { t } from '../i18n.mjs';
import { hintKey } from './strings.mjs';

const KEY = 'sl-skin';
const MIME = { woff2: 'font/woff2', woff: 'font/woff', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };
const listeners = new Set();
let committed = null; // skin id or null = classic
let pending = null;
let previewing = null; // null = no preview; 'classic' = previewing the plain look
const resolved = new Map();
const injectedGen = { gen: -1 };

const root = () => (typeof document !== 'undefined' ? document.documentElement : null);
/** null = classic. A skin the catalog doesn't have (any more – the 2.x editions were dropped in 3.0) is classic too. */
const norm = (id) => (!id || id === 'classic' || !CATALOG.skins.some((s) => s.id === String(id)) ? null : String(id));

function emit() {
  for (const fn of [...listeners]) {
    try {
      fn(skinState());
    } catch (e) {
      console.error(e);
    }
  }
}

/** the skin's CSS with its pack: assets inlined as data: URLs */
export function skinCss(id) {
  if (resolved.has(id)) return resolved.get(id);
  const css = content.skinCss.get(id);
  if (css == null) return null;
  const out = css.replace(/url\((['"]?)pack:([a-z0-9._/-]+)\1\)/g, (_, q, path) => {
    const bytes = content.files.get(path);
    if (!bytes) return 'none';
    const mime = MIME[path.split('.').pop()] || 'application/octet-stream';
    return `url('data:${mime};base64,${b64encode(bytes)}')`;
  });
  resolved.set(id, out);
  return out;
}

function inject(id) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !id) return true;
  if (doc.querySelector(`style[data-cos-skin="${id}"]`)) return true;
  const css = skinCss(id);
  if (css == null) return false;
  const el = doc.createElement('style');
  el.dataset.cosSkin = id;
  el.textContent = css;
  doc.head.appendChild(el);
  return true;
}

function show(id) {
  const r = root();
  if (!r) return;
  if (id && !inject(id)) id = null;
  if (id) r.dataset.skin = id;
  else delete r.dataset.skin;
  syncTitleBar();
}

const visible = () => (previewing ? norm(previewing) : committed);

/** The player's skin (null / 'classic' = the look souldew ships with). Returns false when it isn't owned (yet). */
export function applySkin(id) {
  const want = norm(id);
  try {
    if (want) localStorage.setItem(KEY, want);
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the config still has it
  }
  if (want && !owned('skins', want)) {
    pending = want; // remembered: applied as soon as the pack is loaded and owns it
    committed = null;
    if (!previewing) show(null);
    emit();
    return false;
  }
  pending = null;
  committed = want;
  if (!previewing) show(committed);
  emit();
  return true;
}

/** Try a skin on the whole app without saving (Settings). False when its stylesheet isn't available. */
export function previewSkin(id) {
  const want = norm(id);
  if (want && !has('skins', want)) return false;
  previewing = want || 'classic';
  show(want);
  emit();
  return true;
}

/** Back to the committed skin (leaving Settings, "Back to souldew"). */
export function endPreview() {
  if (previewing === null) return;
  previewing = null;
  show(committed);
  emit();
}

export function skinState() {
  return { committed: committed || 'classic', pending, previewing: previewing ? norm(previewing) || 'classic' : null, visible: visible() || 'classic' };
}
export function onSkinChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The catalog's skins: { id, name, hint, group: 'dark' | 'light', plus, sw, owned, available } */
export function listSkins() {
  return CATALOG.skins.map((s) => ({ id: s.id, name: s.name, hint: t(hintKey(s.id), s.hint), group: s.group, plus: s.plus, sw: s.sw, owned: owned('skins', s.id), available: has('skins', s.id) }));
}

// the pack changed (loaded, re-verified, wiped): drop what was injected, re-resolve, honour a pending wish
onChange((st) => {
  if (injectedGen.gen === st.generation) return;
  injectedGen.gen = st.generation;
  resolved.clear();
  if (typeof document !== 'undefined') for (const el of document.querySelectorAll('style[data-cos-skin]')) el.remove();
  if (committed && !owned('skins', committed)) {
    pending = committed; // membership gone (or pack not loaded): classic until it is back
    committed = null;
  }
  if (pending && owned('skins', pending)) {
    committed = pending;
    pending = null;
  }
  if (previewing && previewing !== 'classic' && !has('skins', previewing)) previewing = null;
  show(visible());
  emit();
});

/** Before the first render: nothing premium is in memory yet – remember the wish, show classic until the pack is in. */
export function applyStoredSkin() {
  try {
    const id = localStorage.getItem(KEY);
    if (id) applySkin(id);
  } catch {
    // storage blocked
  }
}
