// Shared World's controls over the picture (docs/MULTIPLAYER.md › 9), the same for every generation: the partners'
// name tags, the A menu (Trade / Battle / Wave / Rock-paper-scissors / emotes), the rock-paper-scissors picker, a
// controller in both, and the speech bubbles drawn on the overlay's canvas. The overlays (web/lib/worldoverlay.mjs for
// the GBA, web/lib/worldds.mjs for the DS) read their game and place things; this draws and handles the input.
import { artSize, paintArt, artCanvas, INK } from '/lib/worldart.mjs';
import { rpsLine } from '/shared/rps.mjs';

const EMOTE_ROW = ['wave', 'heart', 'excl', 'quest', 'gg']; // (Wave sits with the emotes: the menu stays short)

export const WORLD_CSS = `
.sw-layer{position:fixed;pointer-events:none;overflow:hidden;z-index:5}
.sw-layer canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;transition:opacity .14s linear}
.sw-tag{position:absolute;transform:translate(-50%,-100%);padding:1px 6px 2px;border-radius:7px;font:600 11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--c);background:rgba(14,13,18,.74);border:1px solid color-mix(in srgb,var(--c) 55%,transparent);white-space:nowrap;letter-spacing:.01em;
  pointer-events:auto;cursor:pointer;transition:opacity .14s linear;text-shadow:0 1px 0 #000}
.sw-tag:hover{background:rgba(14,13,18,.92)}
.sw-menu{position:fixed;z-index:6;min-width:132px;padding:6px;border-radius:10px;background:#1b1a1f;border:1px solid #4a4855;box-shadow:0 8px 28px #000a,inset 0 1px 0 #ffffff10;
  font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#ebe6da;animation:sw-in .12s ease-out}
@keyframes sw-in{from{opacity:0;transform:translateY(4px) scale(.97)}to{opacity:1;transform:none}}
.sw-menu .sw-who{padding:4px 8px 6px;font-size:12px;color:var(--c);display:flex;gap:6px;align-items:center}
.sw-menu .sw-who i{width:7px;height:7px;border-radius:50%;background:var(--c);box-shadow:0 0 6px var(--c)}
.sw-menu button{display:flex;width:100%;align-items:center;gap:8px;padding:7px 10px;border:0;border-radius:7px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sw-menu button[aria-selected="true"]{background:color-mix(in srgb,var(--c) 22%,#2a2931);box-shadow:inset 2px 0 0 var(--c)}
.sw-menu button:disabled{opacity:.42;cursor:default}
.sw-menu .sw-why{padding:2px 10px 4px;font:500 11px/1.35 system-ui,sans-serif;color:#a9a5b3;max-width:220px}
.sw-menu .sw-keys{padding:5px 10px 2px;font:500 10px/1 system-ui,sans-serif;color:#77757f}
.sw-menu .sw-row{display:flex;gap:4px;padding:2px 4px}
.sw-menu .sw-row button{width:auto;flex:1;justify-content:center;padding:6px 0}
.sw-menu canvas.px-art{image-rendering:pixelated;display:block}
.sw-rps{min-width:216px}
.sw-rps .sw-hands{display:flex;gap:6px;padding:4px}
.sw-rps .sw-hands button{flex-direction:column;gap:5px;padding:8px 4px 6px;justify-content:center;align-items:center;font-size:11px}
.sw-rps .sw-hands button.picked{background:color-mix(in srgb,var(--c) 30%,#2a2931);opacity:1}
.sw-rps .sw-time{height:3px;margin:4px 8px 2px;border-radius:2px;background:#2d2c33;overflow:hidden}
.sw-rps .sw-time i{display:block;height:100%;background:var(--c);transform-origin:left;transition:transform .25s linear}
.sw-rps .sw-say{padding:6px 8px 2px;font:600 12px/1.35 system-ui,sans-serif;min-height:16px}
`;

/**
 * A white speech bubble with pixel art (web/lib/worldart.mjs) in `color`, its tail at (x, y), bobbing once when it
 * appears. `dim`: drawn faded (the losing hand of a rock-paper-scissors round).
 */
export function drawBubble(ctx, x, y, color, age, art = 'wave', dim = false) {
  const [aw, ah] = artSize(art);
  const w = aw + 6;
  const h = ah + 5;
  const bob = age < 160 ? Math.round(-2 * Math.sin((age / 160) * Math.PI)) : 0;
  const bx = Math.round(x) - (w >> 1);
  const by = Math.round(y) - h - 2 + bob;
  ctx.save();
  if (dim) ctx.globalAlpha = 0.5;
  ctx.fillStyle = INK;
  ctx.fillRect(bx + 1, by, w - 2, h);
  ctx.fillRect(bx, by + 1, w, h - 2);
  ctx.fillRect(bx + (w >> 1) - 1, by + h, 3, 2);
  ctx.fillStyle = '#fbf8f1';
  ctx.fillRect(bx + 1, by + 1, w - 2, h - 2);
  ctx.fillRect(bx + (w >> 1), by + h - 1, 1, 2);
  paintArt(ctx, art, bx + 3, by + 3 - (ah > 8 ? 1 : 0), color);
  ctx.restore();
}

/**
 * The controls for one overlay. `host`: the player page's host (rect, pause, resume, paused, post, keyButton); `layer`:
 * the element over the picture (the name tags go in it); `screen`: { w, h } – the picture in game pixels; `getCfg()`:
 * the play view's config (me, players, actions, labels); `anchor(slot)`: { x, top, bottom } of a partner in picture
 * pixels (the menu goes above `top`, or below `bottom` where there's no room), or null; `canModal()`: may the
 * rock-paper-scissors picker take the keys and pause the game now (the overworld is on screen); `onClosed()`: a menu or
 * picker gave the keys back (the A that chose must not open the menu again).
 */
export function createWorldUi({ host, layer, screen, getCfg, anchor, canModal, onClosed = () => {} }) {
  let menu = null;
  let rpsUi = null;
  const tags = new Map(); // slot → name tag element

  function tagFor(slot) {
    const pl = getCfg().players[slot];
    if (!pl) return null;
    let el = tags.get(slot);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'sw-tag';
      el.style.opacity = '0';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenu(slot);
      });
      layer.append(el);
      tags.set(slot, el);
    }
    if (el.textContent !== pl.name) el.textContent = pl.name;
    el.style.setProperty('--c', pl.color || '#ebe6da');
    el.title = getCfg().labels.tagHint || '';
    return el;
  }

  // ---- the menu (the partners stay drawn behind it; the game is paused while it is open) ----------------------------
  // Items: Trade, Battle, Give item (or Watch while they battle), Rock-paper-scissors, a row of emotes (wave, heart, !,
  // ?, GG), Cancel. Up/down between the items, left/right along the emote row.
  function openMenu(slot) {
    if (menu || rpsUi?.modal || !getCfg().players[slot]) return;
    const pl = getCfg().players[slot];
    const L = getCfg().labels;
    const ac = getCfg().actions[slot] || {};
    // (a partner in a battle: Watch instead of Trade / Battle / Give item, which can't be done with them now)
    const items = [
      ...(ac.watch ? [{ act: 'watch', label: L.watch || 'Watch', on: true }] : [
        { act: 'trade', label: L.trade || 'Trade', on: !!ac.trade },
        { act: 'battle', label: L.battle || 'Battle', on: !!ac.battle },
        ...(ac.gift !== undefined ? [{ act: 'gift', label: L.gift || 'Give item', on: !!ac.gift, title: ac.giftWhy || '' }] : []),
      ]),
      { act: 'rps', label: L.rps || 'Rock-paper-scissors', on: ac.rps !== false },
      { act: 'emote', row: EMOTE_ROW, on: true },
      { act: 'close', label: L.cancel || 'Cancel', on: true },
    ];
    const el = document.createElement('div');
    el.className = 'sw-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', pl.name);
    el.style.setProperty('--c', pl.color || '#ebe6da');
    const who = document.createElement('div');
    who.className = 'sw-who';
    who.append(document.createElement('i'), document.createTextNode(pl.name));
    el.append(who);
    const buttons = [];
    items.forEach((it, i) => {
      const pick = (sub) => (e) => {
        e.stopPropagation();
        choose(i, sub);
      };
      if (it.row) {
        const row = document.createElement('div');
        row.className = 'sw-row';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', L.emotes || 'Emotes');
        it.buttons = it.row.map((name, k) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('role', 'menuitem');
          b.title = L[`emote_${name}`] || name;
          b.setAttribute('aria-label', b.title);
          b.append(artCanvas(name, '#ebe6da', 2));
          b.addEventListener('click', pick(k));
          b.addEventListener('pointerenter', () => select(i, k));
          row.append(b);
          return b;
        });
        el.append(row);
        buttons.push(row);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
      b.disabled = !it.on;
      if (it.title) b.title = it.title;
      b.addEventListener('click', pick(0));
      b.addEventListener('pointerenter', () => it.on && select(i));
      el.append(b);
      buttons.push(b);
    });
    const why = !ac.watch && !ac.trade && !ac.battle ? ac.why || '' : '';
    if (why) {
      const w = document.createElement('div');
      w.className = 'sw-why';
      w.textContent = why;
      el.append(w);
    }
    if (L.keys) {
      const k = document.createElement('div');
      k.className = 'sw-keys';
      k.textContent = L.keys;
      el.append(k);
    }
    document.body.append(el);
    const wasPaused = host.paused();
    if (!wasPaused) host.pause();
    menu = { el, slot, items, buttons, sel: -1, sub: 0, wasPaused, pad: {} };
    select(items.findIndex((x) => x.on));
    positionMenu();
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', swallow, true);
    addEventListener('pointerdown', outside, true);
  }
  /**
   * Over the partner (`slot`), or (null) at the bottom of the picture – the players stand in its middle and their
   * bubbles show above them; kept inside the picture.
   */
  function placeBox(el, slot) {
    const r = host.screen?.() || host.rect(); // (the DS: its top screen)
    if (!r) return;
    const a = slot ? anchor(slot) : null;
    const k = r.width / screen.w;
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    let x = a ? r.left + a.x * k - mw / 2 : r.left + r.width / 2 - mw / 2;
    let y = a ? r.top + a.top * k - mh : r.top + r.height - mh - 8;
    if (y < r.top + 6) y = a ? r.top + a.bottom * k : r.top + 6;
    x = Math.max(r.left + 6, Math.min(x, r.left + r.width - mw - 6));
    y = Math.max(r.top + 6, Math.min(y, r.top + r.height - mh - 6));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }
  const positionMenu = () => menu && placeBox(menu.el, menu.slot);
  function select(i, sub = null) {
    if (!menu || i < 0) return;
    menu.sel = i;
    if (sub !== null) menu.sub = sub;
    menu.items.forEach((it, j) => {
      if (it.buttons) it.buttons.forEach((b, k) => b.setAttribute('aria-selected', String(j === i && k === menu.sub)));
      else menu.buttons[j].setAttribute('aria-selected', String(j === i));
    });
  }
  function move(d) {
    if (!menu) return;
    const n = menu.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (menu.sel + d * k + n * 4) % n;
      if (menu.items[i].on) return select(i);
    }
  }
  function side(d) {
    const it = menu?.items[menu.sel];
    if (it?.row) select(menu.sel, (menu.sub + d + it.row.length) % it.row.length);
  }
  function choose(i, sub = menu?.sub || 0) {
    if (!menu) return;
    const it = menu.items[i];
    if (!it?.on) return;
    const slot = menu.slot;
    closeMenu();
    if (it.act === 'close') return;
    // (the play view decides – a wave or an emote within the limits shows over you through emote(), a game opens
    // the picker through rps())
    if (it.act === 'emote') host.post({ type: 'emu-world-act', act: 'emote', emote: it.row[sub] || it.row[0], slot });
    else host.post({ type: 'emu-world-act', act: it.act, slot });
  }
  function closeMenu() {
    if (!menu) return;
    const m = menu;
    menu = null;
    m.el.remove();
    removeEventListener('keydown', onKey, true);
    removeEventListener('keyup', swallow, true);
    removeEventListener('pointerdown', outside, true);
    onClosed(); // (the A that chose doesn't open it again)
    if (!m.wasPaused) host.resume();
  }
  function swallow(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  function onKey(e) {
    if (!menu) return;
    swallow(e);
    const b = host.keyButton?.(e);
    const k = e.key;
    if (k === 'ArrowDown' || b === 'down') move(1);
    else if (k === 'ArrowUp' || b === 'up') move(-1);
    else if (k === 'ArrowLeft' || b === 'left') side(-1);
    else if (k === 'ArrowRight' || b === 'right') side(1);
    else if (k === 'Enter' || k === ' ' || b === 'a') choose(menu.sel);
    else if (k === 'Escape' || k === 'Backspace' || b === 'b') closeMenu();
  }
  function outside(e) {
    if (menu && !menu.el.contains(e.target)) closeMenu();
  }

  // ---- rock-paper-scissors: the picker (shared/rps.mjs through the play view) ----------------------------------------
  // While you pick, the game waits (at most the 10 s of the round) and the keys are the picker's: left/right, A, B
  // to pass. Once you picked the game runs on; the result shows as the hands over both heads, and here in words.
  const HANDS_KEYS = ['rock', 'paper', 'scissors'];
  function rpsView(v) {
    if (!v) return closeRps();
    const L = getCfg().labels;
    const pl = getCfg().players[v.other] || { name: v.other, color: '#ebe6da' };
    if (!rpsUi || rpsUi.id !== v.id) {
      closeRps();
      closeMenu();
      const el = document.createElement('div');
      el.className = 'sw-menu sw-rps';
      el.setAttribute('role', 'dialog');
      el.style.setProperty('--c', pl.color || '#ebe6da');
      const who = document.createElement('div');
      who.className = 'sw-who';
      const name = document.createElement('span');
      who.append(document.createElement('i'), name);
      const hands = document.createElement('div');
      hands.className = 'sw-hands';
      const buttons = HANDS_KEYS.map((h, k) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.append(artCanvas(h, getCfg().players[getCfg().me]?.color || '#ebe6da', 3), document.createTextNode(L[`hand_${h}`] || h));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          rpsPick(k);
        });
        b.addEventListener('pointerenter', () => rpsSel(k));
        hands.append(b);
        return b;
      });
      const time = document.createElement('div');
      time.className = 'sw-time';
      const bar = document.createElement('i');
      time.append(bar);
      const say = document.createElement('div');
      say.className = 'sw-say';
      say.setAttribute('aria-live', 'polite');
      const keys = document.createElement('div');
      keys.className = 'sw-keys';
      el.append(who, hands, time, say, keys);
      document.body.append(el);
      rpsUi = { id: v.id, el, name, buttons, bar, say, keys, sel: 1, modal: false, wasPaused: false, pad: {}, closeAt: 0 };
      rpsSel(1);
    }
    const u = rpsUi;
    u.v = v;
    u.name.textContent = `${L.rpsWith ? L.rpsWith.replace('{name}', pl.name) : `Rock-paper-scissors · ${pl.name}`}${v.bo === 3 ? ` · ${L.bestOf3 || 'best of 3'} ${v.wins.me}–${v.wins.them}` : ''}`;
    const picking = v.phase === 'pick';
    u.buttons.forEach((b, k) => {
      b.disabled = !picking;
      b.classList.toggle('picked', v.hand === k && !picking);
    });
    u.keys.textContent = picking ? L.rpsKeys || '◀ ▶ choose · A pick · B pass' : '';
    u.bar.parentNode.style.visibility = picking ? '' : 'hidden';
    u.say.textContent = rpsSay(v, pl.name);
    // the modal part: the keys and the paused game, only while picking on the overworld
    const want = picking && canModal();
    if (want && !u.modal) rpsModal(true);
    else if (!want && u.modal) rpsModal(false);
    if (v.phase === 'end') u.closeAt = u.closeAt || performance.now() + 2600;
    placeBox(u.el, null);
  }
  function rpsSay(v, name) {
    return rpsLine(v, getCfg().me, getCfg().labels, name, (h) => getCfg().labels[`hand_${HANDS_KEYS[h]}`] || HANDS_KEYS[h]);
  }
  function rpsModal(on) {
    const u = rpsUi;
    if (!u || u.modal === on) return;
    u.modal = on;
    if (on) {
      u.wasPaused = host.paused();
      if (!u.wasPaused) host.pause();
      addEventListener('keydown', rpsKey, true);
      addEventListener('keyup', swallow, true);
    } else {
      removeEventListener('keydown', rpsKey, true);
      removeEventListener('keyup', swallow, true);
      onClosed();
      if (!u.wasPaused) host.resume();
    }
  }
  function rpsSel(k) {
    if (!rpsUi) return;
    rpsUi.sel = (k + 3) % 3;
    rpsUi.buttons.forEach((b, j) => b.setAttribute('aria-selected', String(j === rpsUi.sel)));
  }
  function rpsPick(k) {
    const u = rpsUi;
    if (!u || u.v?.phase !== 'pick') return;
    rpsSel(k);
    host.post({ type: 'emu-world-rps', id: u.id, hand: k });
    rpsModal(false);
  }
  function rpsPass() {
    const u = rpsUi;
    if (!u) return;
    host.post({ type: 'emu-world-rps', id: u.id, pass: true });
    rpsModal(false);
  }
  function rpsKey(e) {
    if (!rpsUi?.modal) return;
    swallow(e);
    const b = host.keyButton?.(e);
    const k = e.key;
    if (k === 'ArrowLeft' || b === 'left') rpsSel(rpsUi.sel - 1);
    else if (k === 'ArrowRight' || b === 'right') rpsSel(rpsUi.sel + 1);
    else if (k === '1' || k === '2' || k === '3') rpsPick(Number(k) - 1);
    else if (k === 'Enter' || k === ' ' || b === 'a') rpsPick(rpsUi.sel);
    else if (k === 'Escape' || k === 'Backspace' || b === 'b') rpsPass();
  }
  function closeRps() {
    if (!rpsUi) return;
    rpsModal(false);
    rpsUi.el.remove();
    rpsUi = null;
  }

  // a controller in the menu and the picker: D-pad, A, B (standard mapping)
  function pollPad() {
    const box = menu || (rpsUi?.modal ? rpsUi : null);
    if (rpsUi?.closeAt && performance.now() > rpsUi.closeAt) closeRps();
    if (rpsUi && !menu) placeBox(rpsUi.el, null);
    if (rpsUi?.v?.phase === 'pick') rpsUi.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, (rpsUi.v.untilPage - performance.now()) / 10000))})`;
    if (!box) return;
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (!pad) return;
    const was = box.pad;
    const now = {
      a: pad.buttons[0]?.pressed, b: pad.buttons[1]?.pressed, up: pad.buttons[12]?.pressed || pad.axes[1] < -0.5, down: pad.buttons[13]?.pressed || pad.axes[1] > 0.5,
      left: pad.buttons[14]?.pressed || pad.axes[0] < -0.5, right: pad.buttons[15]?.pressed || pad.axes[0] > 0.5,
    };
    box.pad = now;
    const edge = (k) => now[k] && !was[k] && was[k] !== undefined;
    if (box === menu) {
      if (edge('down')) move(1);
      if (edge('up')) move(-1);
      if (edge('left')) side(-1);
      if (edge('right')) side(1);
      if (edge('a')) choose(menu.sel);
      else if (edge('b')) closeMenu();
    } else {
      if (edge('left')) rpsSel(rpsUi.sel - 1);
      if (edge('right')) rpsSel(rpsUi.sel + 1);
      if (edge('a')) rpsPick(rpsUi.sel);
      else if (edge('b')) rpsPass();
    }
  }
  const padTimer = setInterval(pollPad, 50);

  return {
    openMenu,
    closeMenu,
    rpsView,
    tagFor,
    tags,
    positionMenu,
    get menu() {
      return menu;
    },
    get rpsUi() {
      return rpsUi;
    },
    /** Is a menu open, or the picker holding the keys? */
    modal: () => !!menu || !!rpsUi?.modal,
    /** A partner left: their tag goes, and the menu about them closes. */
    gone(slot) {
      tags.get(slot)?.remove();
      tags.delete(slot);
      if (menu?.slot === slot) closeMenu();
    },
    /** Tags of players who left the run (or are this computer's) go. */
    prune() {
      const c = getCfg();
      for (const [slot, el] of tags) if (!c.players[slot] || slot === c.me) (el.remove(), tags.delete(slot));
    },
    debug() {
      const it = menu?.items[menu.sel];
      return {
        menu: menu ? { slot: menu.slot, sel: it?.row ? `emote:${it.row[menu.sub]}` : it?.act } : null,
        rps: rpsUi ? { id: rpsUi.id, phase: rpsUi.v?.phase, modal: rpsUi.modal, sel: rpsUi.sel, say: rpsUi.say.textContent } : null,
      };
    },
    stop() {
      clearInterval(padTimer);
      closeMenu();
      closeRps();
      for (const el of tags.values()) el.remove();
      tags.clear();
    },
  };
}
