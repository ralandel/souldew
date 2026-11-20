// A partner's picture never goes black while it is merely late (views/partnerscreen.mjs): the last good frame is kept
// on a canvas under the video / still and shows whenever there is nothing newer to show – the video for a new stream
// hasn't drawn its first frame yet, the still for a switch to pictures hasn't loaded, or the partner's picture stopped
// for a moment (an older app turns it off while the game is paused). Pure decisions here, the drawing in the view.

/** Mean luminance (0–255) of RGBA bytes, every `step`-th pixel. */
export function meanLuma(rgba, step = 1) {
  const n = Math.floor(rgba.length / 4);
  if (!n) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    sum += 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
    count++;
  }
  return sum / count;
}

// below this a frame is (nearly) black: a turned-off track, a frame before the first one, a fade – never kept
export const DARK_LUMA = 6;

/** Is this frame worth keeping as "the last good picture"? */
export function keepable(rgba) {
  return meanLuma(rgba) >= DARK_LUMA;
}

/**
 * What a partner's picture shows right now.
 *   live      – the partner sends a picture (viewInfo().live)
 *   stream    – it's a video (else a still, when imageMode)
 *   imageMode – a still picture is there
 *   ready     – the shown element (video / still) has drawn the current picture
 *   hasHold   – a last good frame is kept
 * → { video, img, hold, dim, msg }: video / img mounted, hold canvas visible, dimmed (with the message on top), message
 */
export function pictureLayers({ live, stream, imageMode, ready, hasHold }) {
  const video = !!(live && stream);
  const img = !!(live && !stream && imageMode);
  const showing = (video || img) && ready;
  return {
    video,
    img,
    hold: hasHold && !showing,
    dim: hasHold && !live,
    msg: !live,
  };
}
