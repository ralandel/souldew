// souldew+ preview media in the page: the real look of every premium banner, nameplate, avatar frame
// and colour skin for someone who doesn't own it – signed in or not. The local server fetches them from the accounts
// service and hands out only pictures whose signed manifest (pinned pack key) and SHA-256 checked out
// (server/lib/pluspreviews.mjs); here they are plain <img>s: a still, and the short loop while the card is hovered or
// focused – never with reduced motion.
//
//   previewSrc(kind, id, { loop })   the picture's URL, or null when there is none (yet)
//   <PreviewPicture kind id loop />  that picture (nothing when there is none)
//   usePreviews()                    re-renders once the list is in
import { html, useEffect, useState } from '/vendor/htm-preact.mjs';
import { prefersReduced } from './motion.mjs';

let list = null; // { version, files: { path: true } } | { none: true }
let loading = null;
const listeners = new Set();

/** Asks the local server once (again after `force`) which previews there are. */
export function loadPreviews(force = false) {
  if (loading && !force) return loading;
  loading = fetch('/api/plus/previews', { headers: { 'x-soullink': '1' } })
    .then((r) => (r.ok ? r.json() : { none: true }))
    .catch(() => ({ none: true }))
    .then((v) => {
      list = v && typeof v === 'object' ? v : { none: true };
      for (const fn of [...listeners]) fn(list);
      return list;
    });
  return loading;
}

// stickers / wraps: "Your handheld"'s souldew+ stickers and skins – a still each (scripts/plus-dev-pack.mjs handheldPreviews);
// launch: the 3D launch looks – a still and a loop each, the Clear shell once per colour (scripts/handheld/launch-shots.mjs)
const KINDS = { banners: 'banners', nameplates: 'nameplates', frames: 'frames', skins: 'skins', stickers: 'stickers', wraps: 'wraps', launch: 'launch' };
const STILL_ONLY = new Set(['skins', 'stickers', 'wraps']);

/** kind: banners | nameplates | frames | skins | stickers | wraps | launch. loop: the animated WebP (skins, stickers and wraps have a still only). */
export function previewSrc(kind, id, { loop = false } = {}) {
  if (!list?.files || !KINDS[kind] || typeof id !== 'string') return null;
  const path = `${KINDS[kind]}/${id}.${kind === 'skins' || (loop && !STILL_ONLY.has(kind)) ? 'webp' : 'png'}`;
  if (!list.files[path]) return loop ? previewSrc(kind, id) : null;
  return `/api/plus/previews/file?path=${encodeURIComponent(path)}&v=${encodeURIComponent(list.version || '')}`;
}

/** The previews list (loads it on first use) – re-renders when it arrives. */
export function usePreviews() {
  const [v, setV] = useState(list);
  useEffect(() => {
    listeners.add(setV);
    loadPreviews();
    return () => listeners.delete(setV);
  }, []);
  return v;
}

/** The preview picture of an item; `loop` (hover / focus) shows the animated one unless reduced motion is on. */
export function PreviewPicture({ kind, id, loop = false, class: cls = '', alt = '' }) {
  usePreviews();
  const src = previewSrc(kind, id, { loop: loop && !prefersReduced() });
  if (!src) return null;
  return html`<img class=${`cos-preview cos-preview--${kind}${cls ? ` ${cls}` : ''}`} src=${src} alt=${alt} loading="lazy" decoding="async" draggable="false" />`;
}
