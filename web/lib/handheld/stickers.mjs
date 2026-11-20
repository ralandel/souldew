// The sticker atlas on the page: the app's own (free + earned, pre-built in web/assets/handheld/) stacked with the
// souldew+ pack's (handheld/stickers.*, when it is loaded) into one texture – decoded once per pack generation, never
// built here. Plus the sheet's pictures: a souldew+ sticker without the pack shows its public preview picture.
import { decodeLayout, stackAtlases, stickerPicture } from './atlas.mjs';
import { content, state } from '../cosmetics/state.mjs';
import { previewSrc } from '../cosmetics/previews.mjs';

let APP = null; // Promise of the app's atlas part
let cache = { gen: -1, atlas: null, promise: null };

async function decodePng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  return g.getImageData(0, 0, c.width, c.height).data;
}
const red = (rgba) => {
  const out = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
  return out;
};

async function part(layoutJson, artBlob, cutBlob) {
  const L = decodeLayout(layoutJson);
  const [rgba, cut] = await Promise.all([decodePng(artBlob), decodePng(cutBlob)]);
  return { ...L, rgba: new Uint8ClampedArray(rgba), sw: L.w * L.sdfS, sh: L.h * L.sdfS, sdf: red(cut) };
}

function appPart() {
  APP ??= (async () => {
    const get = (f) => fetch(`/assets/handheld/${f}`).then((r) => {
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return f.endsWith('.json') ? r.json() : r.blob();
    });
    const [layout, art, cut] = await Promise.all([get('stickers.json'), get('stickers.png'), get('stickers-cut.png')]);
    return part(layout, art, cut);
  })().catch((e) => {
    APP = null;
    throw e;
  });
  return APP;
}

/** The atlas with every sticker whose art is here (web/lib/handheld/atlas.mjs shape) – cached per pack generation. */
export function loadAtlas() {
  if (cache.gen === state.generation && cache.promise) return cache.promise;
  const gen = state.generation;
  const hh = content.handheld?.stickers;
  const promise = (async () => {
    const own = await appPart();
    let plus = null;
    if (hh) {
      try {
        plus = await part(hh.layout, new Blob([hh.art], { type: 'image/png' }), new Blob([hh.cut], { type: 'image/png' }));
      } catch (e) {
        console.warn('souldew+ stickers', e);
      }
    }
    const atlas = stackAtlases([own, plus]);
    if (cache.gen === gen) cache.atlas = atlas;
    return atlas;
  })();
  cache = { gen, atlas: null, promise };
  return promise;
}

/** the atlas if it is decoded already (sync), else null */
export const atlasNow = () => (cache.gen === state.generation ? cache.atlas : null);

const thumbs = new Map();
/**
 * A sticker's picture for the sheet (data: URL), k css px per art px: from the atlas when its art is here, else the
 * public preview picture of a souldew+ one (or null – the card shows its name only).
 */
export function stickerThumb(id, k = 6) {
  const A = atlasNow();
  if (A?.rects[id]) {
    const key = `${state.generation}:${id}@${k}`;
    if (!thumbs.has(key)) {
      const p = stickerPicture(A, id, k);
      const c = document.createElement('canvas');
      c.width = p.w;
      c.height = p.h;
      c.getContext('2d').putImageData(new ImageData(p.rgba, p.w, p.h), 0, 0);
      thumbs.set(key, c.toDataURL());
    }
    return thumbs.get(key);
  }
  return previewSrc('stickers', id) || null;
}
