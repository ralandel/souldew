// Where "Get souldew+" / "Keep … with souldew+" leads. The account client sets the real page (Settings › Account / the
// souldew+ page) with setPlusHandler; until then it opens the Buy Me a Coffee membership page in the system browser,
// where the membership lives.
import { LINKS } from '../links.mjs';

let handler = null;

/** fn({ reason: 'skin' | 'banner' | 'frame' | 'nameplate' | 'launch' | 'handheld', id }) */
export function setPlusHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

export async function openPlus(info = {}) {
  if (handler) return handler(info);
  const { openExternal } = await import('../ui.mjs');
  return openExternal(LINKS.membership); // where souldew+ is joined
}
