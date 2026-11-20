// Shared World in the browser player (player.html, EmulatorJS): the same overlay as the fast player's
// (web/lib/worldoverlay.mjs). The memory is read straight from the emulator, every animation frame – no per-picture
// bytes needed. The picture sits letterboxed in EmulatorJS' canvas: the overlay covers exactly the GBA's 3:2 part.
import { installWorld } from '/lib/worldoverlay.mjs';

const q = new URLSearchParams(location.search);
const emu = () => window.__emu;

if (q.get('system') === 'gba') {
  installWorld({
    system: 'gba',
    romUrl: q.get('rom'),
    read: (addr, len) => emu()?.read(addr, len) || null,
    ready: () => !!emu()?.ready,
    rect() {
      const c = emu()?.ready ? emu().canvas() : null;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      let { left, top, width, height } = r;
      if (width / height > 1.5 * 1.01) {
        const w = height * 1.5;
        left += (width - w) / 2;
        width = w;
      } else if (width / height < 1.5 / 1.01) {
        const h = width / 1.5;
        top += (height - h) / 2;
        height = h;
      }
      return { left, top, width, height };
    },
    paused: () => !!emu()?.paused(),
    pause: () => emu()?.pause(),
    resume: () => emu()?.resume(),
    post: (m) => window.parent?.postMessage(m, location.origin),
  });
}
