// A product shot of a souldew+ sticker or wrap for the public preview media (scripts/plus-dev-pack.mjs). The previews
// go to anyone, signed in or not – and a sticker IS its pixel art: a clean integer upscale would be the sticker itself,
// one nearest-neighbour downscale away from a patched client's atlas. So the picture is the real look, shot a little
// turned (a few degrees), at a size that isn't a whole multiple of the art, resampled smoothly, with a soft sheen across
// it like light on a glossy print. It reads as the sticker; it isn't the file.
//
//   productShot({ w, h, rgba }, { angle (degrees), seed (any string), scale = 0.92, opaque = false }) → { w, h, rgba }
//   opaque: a picture without transparency (a wrap's window) – zoomed so the turned picture still fills its frame.

const hash = (s) => {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
};

export function productShot(pic, { angle = -6, seed = '', scale = 0.92, opaque = false } = {}) {
  const { w, h, rgba } = pic;
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  let W, H, k;
  if (opaque) { // keep the frame; zoom until the turned picture covers it
    W = w; H = h;
    k = Math.abs(cos) + Math.abs(sin) * Math.max(w / h, h / w);
  } else { // a sticker: its own size × scale, on a canvas that holds it turned
    k = scale;
    W = Math.ceil((Math.abs(cos) * w + Math.abs(sin) * h) * k) + 4;
    H = Math.ceil((Math.abs(sin) * w + Math.abs(cos) * h) * k) + 4;
  }
  const out = new Uint8ClampedArray(W * H * 4);
  // premultiplied bilinear sampling (no dark fringes at the die-cut edge)
  const px = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    const i = (y * w + x) * 4;
    return c === 3 ? rgba[i + 3] : (rgba[i + c] * rgba[i + 3]) / 255;
  };
  const sheenAt = 0.25 + hash(seed) * 0.5; // where the light crosses (0..1 along the diagonal)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - W / 2) / k, dy = (y + 0.5 - H / 2) / k;
      const sx = cos * dx + sin * dy + w / 2 - 0.5, sy = -sin * dx + cos * dy + h / 2 - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const v = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        v[c] = (px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx) * (1 - fy) + (px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx) * fy;
      }
      const al = v[3];
      const o = (y * W + x) * 4;
      if (al <= 0.5) continue;
      // the sheen: a soft, wide band of light along the diagonal
      const d = (x / W + y / H) / 2 - sheenAt;
      const sheen = 0.16 * Math.exp(-(d * d) / 0.006);
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(Math.min(255, (v[c] * 255) / al) * (1 - sheen) + 255 * sheen);
      out[o + 3] = opaque ? 255 : Math.round(al);
    }
  }
  return { w: W, h: H, rgba: out };
}
