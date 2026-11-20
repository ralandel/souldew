// "Playing together" in the Shared World overlay (docs/MULTIPLAYER.md › 9): a partner in a battle stays where the
// battle began with a ⚔ bubble, a catch pops up over the catcher's head (the party icon from this computer's ROM),
// tombstones stand where a partner's Pokémon died, and an arrow at the edge of the picture points to a partner who
// called "come here". web/lib/worldoverlay.mjs calls these at a few points of its picture; the play view feeds the
// data (web/lib/sharedworld.mjs → window.__world.together()). Nothing here reads the game: positions come from the
// partners' states the overlay already has, and from the run (web/lib/together.mjs).
import { edgeArrow } from '/shared/together.mjs';
import { inLocalFrame } from '/shared/world.mjs';
import { TOMB_SIZE, tombPixels, arrowFor, paintRows } from './togetherart.mjs';
import { INK } from './worldart.mjs';

export const POP_MS = 2600;

/** What the play view hands the overlay: { battles: { slot: true }, pops: [{ slot, species, shiny, form, at }], tombs, ping }. */
export const emptyTogether = () => ({ battles: {}, pops: [], tombs: [], ping: null });

/**
 * A partner in a battle sends "hidden" (they left the overworld) – drawn on at the last place they stood, still,
 * facing the way they faced. `s`: the sampled state; `tr`: their Track; `conv`: into the local frame. → the state
 * to draw (marked `battling`) or `s` as it was.
 */
export function standIn(s, tr, conv, battling) {
  if (!battling || !s?.hidden || !tr?.buf?.length) return s;
  let last = null;
  for (let i = tr.buf.length - 1; i >= 0; i--) if (!tr.buf[i].hidden) { last = tr.buf[i]; break; }
  if (!last) return s;
  if (!conv) return { ...last, moving: false, battling: true };
  const p = conv(last);
  return p ? { ...last, x: p.x, y: p.y, local: true, moving: false, battling: true } : s;
}

/** The overlay's half: one per player page. `t`: the world table (screen, anchor, fam). */
export function togetherLayer(t) {
  let tombImg = null;
  let tombRgba = null;
  const tomb = () => {
    if (!tombImg) {
      const [w, h] = TOMB_SIZE;
      tombRgba = tombPixels();
      tombImg = document.createElement('canvas');
      tombImg.width = w;
      tombImg.height = h;
      tombImg.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tombRgba), w, h), 0, 0);
    }
    return { img: tombImg, rgba: tombRgba };
  };
  /** A spot ({ fam, map, x, y, size? }) on this picture: its tile's top-left, or null (another map, off the picture). */
  const spot = (cam, conns, s, margin = 48) => {
    if (!cam || !s || s.fam !== t.fam) return null;
    let x = s.x;
    let y = s.y;
    if (s.map !== cam.map) {
      const p = conns ? inLocalFrame(conns, { ...s, hidden: false }, s.size || null) : null;
      if (!p) return null;
      ({ x, y } = p);
    }
    const sx = t.anchor.x + (x - cam.cx);
    const sy = t.anchor.y + (y - cam.cy);
    if (margin !== Infinity && (sx < -margin || sy < -margin || sx > t.screen.w + margin || sy > t.screen.h + margin)) return null;
    return { x: sx, y: sy };
  };
  return {
    /** The tombstones on this picture, as sprites for the overlay's depth sort. */
    tombSprites(cam, conns, tombs) {
      const out = [];
      for (const tb of tombs || []) {
        const pos = spot(cam, conns, tb);
        if (pos) out.push({ kind: 'tomb', slot: tb.slot, id: tb.id, pos });
      }
      return out;
    },
    /** One tombstone on its tile (its base on the tile's bottom row), cut by the map's top layer like the partners. */
    drawTomb(p, drawSprite) {
      const { img, rgba } = tomb();
      const [w, h] = TOMB_SIZE;
      const x = Math.round(p.pos.x + 8 - w / 2);
      const y = Math.round(p.pos.y + 16 - h - 1);
      drawSprite(img, rgba, w, h, x, y, false, 0);
      p.box = { x, y, w, h };
    },
    /**
     * A catch over a head: the party icon in a speech bubble like the emotes' (it stands out against a follower or the
     * map behind), rising a little and fading. `ic`: the icon (two frames), `head`: where the bubble's tail points.
     */
    drawPop(ctx, ic, cx, head, age) {
      if (!ic || age < 0 || age > POP_MS) return;
      const k = age / POP_MS;
      const rise = Math.round(Math.min(1, age / 300) * 4);
      const iw = ic.right - ic.left + 1;
      const ih = ic.bottom - ic.top + 1;
      const w = iw + 6;
      const h = ih + 6;
      const bx = Math.round(cx) - (w >> 1);
      const by = Math.round(head) - h - 3 - rise;
      ctx.save();
      ctx.globalAlpha = k > 0.8 ? Math.max(0, (1 - k) / 0.2) : 1;
      ctx.fillStyle = INK;
      ctx.fillRect(bx + 1, by, w - 2, h);
      ctx.fillRect(bx, by + 1, w, h - 2);
      ctx.fillRect(bx + (w >> 1) - 1, by + h, 3, 2);
      ctx.fillStyle = '#fbf8f1';
      ctx.fillRect(bx + 1, by + 1, w - 2, h - 2);
      ctx.fillRect(bx + (w >> 1), by + h - 1, 1, 2);
      const fr = Math.floor(age / 260) & 1;
      ctx.drawImage(ic.frames[fr], ic.left, ic.top, iw, ih, bx + 3, by + 3, iw, ih);
      ctx.restore();
    },
    /**
     * The "come here" arrow: at the picture's edge toward the ping's spot – or, when the spot is on the picture, bobbing
     * just above it. → { x, y, dir: 'edge' | 'over' } or null (another map).
     */
    drawPing(ctx, cam, conns, ping, color, now) {
      if (!ping || ping.map === undefined) return null;
      const pos = spot(cam, conns, ping, Infinity);
      if (!pos) return null;
      const a = edgeArrow(pos, t.screen, 12);
      const pulse = Math.floor(now / 380) & 1;
      const pal = { '#': color, o: INK };
      if (a.onScreen) {
        const rows = arrowFor(Math.PI / 2);
        const bob = Math.round(Math.sin(now / 220) * 2);
        paintRows(ctx, rows, Math.round(pos.x + 8 - rows[0].length), Math.round(pos.y - 30 + bob), pal, 2);
        return { x: Math.round(pos.x), y: Math.round(pos.y), dir: 'over' };
      }
      const rows = arrowFor(a.angle);
      // (two picture pixels per art pixel: it has to be seen at a glance; it nudges toward the spot to say "this way")
      const w = rows[0].length * 2;
      const h = rows.length * 2;
      const nudge = pulse ? 2 : 0;
      paintRows(ctx, rows, Math.round(a.x - w / 2 + Math.cos(a.angle) * nudge), Math.round(a.y - h / 2 + Math.sin(a.angle) * nudge), pal, 2);
      return { x: Math.round(a.x), y: Math.round(a.y), dir: 'edge', angle: Math.round((a.angle * 180) / Math.PI) };
    },
  };
}
