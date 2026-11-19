import { html, useState, useEffect, useLayoutEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp, openExternal, copy } from '../lib/ui.mjs';
import { LINKS } from '../lib/links.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, LANGS, setLang, currentLang } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { applyTheme } from '../lib/theme.mjs';
import { BUTTONS, PRESETS, bindable, keyLabel, keyFor, resolve as resolveControls, presetMap, activePreset, detectLayout, currentLayout,
  PAD_LABELS, PAD_PRESETS, PAD_HOTKEY_IDS, PAD_HOTKEY_DEFAULTS, padMap, padFamily, padLabel, pickPad, padKey, looksLikePad,
  HOTKEY_IDS, HOTKEY_ROWS, isHotkeyId, resolveHotkeys, refusedHotkeys, hotkeyBindable, sameCombo, plainCombo, combo, reservedCombo, assignKey, clearKey, changedBindings,
  padHotkeys, assignPad, PAD_NONE } from '../lib/controls.mjs';
import { buttonLabel, comboLabel, hotkeyLabel } from './guide.mjs';
import { UpdateSection } from './update.mjs';
import { PLATFORM } from '../lib/platform.mjs';
import { gpuBackends } from '/shared/gpu.mjs';
import { LiveRunsSettings, LIVE_RUNS } from './liveshare.mjs';
import { EDITION } from '/shared/edition.mjs';
import { suspendPadNav } from '../lib/padnav.mjs';

const SYSTEMS = [['gb', 'Game Boy'], ['gbc', 'Game Boy Color'], ['gba', 'Game Boy Advance'], ['nds', 'Nintendo DS'], ['3ds', 'Nintendo 3DS']];
/** Systems the built-in player runs only with an extra part: 3DS needs souldew's 3DS host (status.ctr). */
const externalOnly = (sys, status) => sys === '3ds' && !status?.ctr?.ok;
const SYS_SHORT = { nds: 'DS', gba: 'GBA', gb: 'GB', '3ds': '3DS' };

// "WASD" is printed as the layout prints those keys (ZQSD on AZERTY)
const presetLabel = (id) => (id === 'arrows' ? t('ctl.presetArrows', 'Arrow keys')
  : ['up', 'left', 'down', 'right'].map((b) => keyLabel(presetMap(id)[b])).join(''));

const rowLabel = (r) => (r.id === 'save' ? t('keys.saveSlot', 'Save to slot 1–4') : r.id === 'load' ? t('keys.loadSlot', 'Load slot 1–4') : hotkeyLabel(r.id));
const rowOf = (id) => HOTKEY_ROWS.find((r) => r.ids.includes(id))?.id || id;
const SYS_ALL = ['nds', 'gba', 'gb'];

/** A shortcut's other keys besides the first, for the row ("also Num +") – not the same key with Shift ("+" on US keyboards). */
function alsoKeys(keys) {
  return keys.slice(1).filter((c) => c.keyCode !== keys[0].keyCode).map((c) => comboLabel(c)).filter((l, i, a) => a.indexOf(l) === i);
}

function ControlsSection({ saved, save }) {
  const [, setLayoutTick] = useState(0);
  const lang = currentLang();
  useEffect(() => { detectLayout(lang).then(() => setLayoutTick((x) => x + 1)); }, [lang]);
  const map = resolveControls(saved);
  const hot = resolveHotkeys(saved); // every shortcut's keys – rows of their own below the game buttons
  const active = activePreset(saved); // null = custom (the game buttons; the shortcuts don't count)
  const [listen, setListen] = useState(null); // button or shortcut waiting for its new key
  const [msg, setMsg] = useState(null); // { at (row), text, swap?, undo? } – the note under that row
  const bound = useRef(0);
  const store = (next) => save({ controls: next });
  const nameOf = (id) => (isHotkeyId(id) ? hotkeyLabel(id) : buttonLabel(id));
  // what happened to the others, in a sentence each: "R was the key for Reset – Reset has no key now."
  const lostText = (lost) => lost.map((l) => (l.left.length
    ? t('ctl.tookOverAlso2', '{key} was also a key for “{action}” – it keeps {keys}.', { key: comboLabel(l.key), action: nameOf(l.id), keys: l.left.map((c) => comboLabel(c)).join(', ') })
    : t('ctl.tookOver2', '{key} was the key for “{action}” – it has no key now.', { key: comboLabel(l.key), action: nameOf(l.id) }))).join(' ');
  // (a layout effect: listening starts with the render that says "Press a key …", not a frame later)
  useLayoutEffect(() => {
    if (!listen) return;
    const onKey = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'AltGraph', 'OS'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { setListen(null); setMsg(null); return; }
      const hk = isHotkeyId(listen);
      const at = rowOf(listen);
      // a shortcut may have modifiers (Shift+Tab, Ctrl+R), a game button is a key of its own; the key's name as the
      // layout prints it without modifiers (Shift+1, not "!"; ⌥R, not "®")
      const name = keyFor(e.code, currentLayout())?.key;
      const k = { keyCode: e.keyCode, key: hk && name ? name : e.key, code: e.code,
        ...(hk ? Object.fromEntries([['shift', e.shiftKey], ['ctrl', e.ctrlKey], ['alt', e.altKey], ['meta', e.metaKey]].filter(([, v]) => v)) : {}) };
      if (hk ? !hotkeyBindable(e.keyCode) : !bindable(e.keyCode)) {
        return setMsg({ at, text: hk ? t('ctl.hotkeyUnbindable', 'This key can’t be used for this shortcut. Press another key.') : t('ctl.unbindable', 'This key can’t be used for the game. Press another key.') });
      }
      const why = reservedCombo(hk ? k : { keyCode: k.keyCode });
      if (why === 'system') return setMsg({ at, text: t('ctl.system', '{key} belongs to the system. Press another key.', { key: comboLabel(k) }) });
      if (why === 'menu') return setMsg({ at, text: t('ctl.menu', '{key} is a shortcut of souldew’s menu. Press another key.', { key: comboLabel(k) }) });
      bound.current = Date.now();
      setListen(null);
      const mine = hk ? hot[listen] : map[listen] ? [map[listen]] : [];
      if (mine.length === 1 && (hk ? sameCombo(mine[0], combo(k)) : mine[0].keyCode === k.keyCode)) return setMsg(null); // the key it has
      const { next, lost, swap } = assignKey(saved, listen, k);
      store(next);
      setMsg(lost.length ? { at, text: lostText(lost), swap, undo: saved } : null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [listen, saved]);
  // the default preset is stored as "nothing saved", so it keeps following the keyboard layout (own shortcuts stay)
  const pick = (id) => {
    setListen(null);
    if (id === active) return;
    const own = Object.fromEntries(HOTKEY_IDS.filter((h) => saved?.[h] != null).map((h) => [h, saved[h]]));
    const next = id === PRESETS[0].id ? (Object.keys(own).length ? own : null) : { ...presetMap(id), ...own };
    store(next);
    // a preset's key that a shortcut had: the shortcut gives way – say so
    const moved = changedBindings(saved, next).filter((c) => isHotkeyId(c.id));
    setMsg(moved.length ? { at: 'preset', text: moved.map((c) => (c.after.length
      ? t('ctl.movedTo', '“{action}” is now on {key}.', { action: nameOf(c.id), key: comboLabel(c.after[0]) })
      : t('ctl.noKeyNow', '“{action}” has no key now.', { action: nameOf(c.id) }))).join(' '), undo: saved } : null);
  };
  const clear = (id) => {
    bound.current = Date.now();
    setListen(null);
    store(clearKey(saved, id));
    setMsg(null);
  };
  const click = (id) => { if (Date.now() - bound.current < 400) return; setMsg(null); setListen(listen === id ? null : id); };
  const blur = (id) => setListen((l) => (l === id ? null : l));
  // the note under a row: while listening "press a key" with "No key" (shortcuts), else what the last change did
  const note = (at) => {
    const listening = listen && rowOf(listen) === at;
    // a key the player set that this computer's menu or system has (a 2.8.1 fast-forward key on F11): said here, with
    // the key it plays on now – until another key is picked, or that one is kept
    const refused = !listening && msg?.at !== at && refusedHotkeys(saved).find((r) => rowOf(r.id) === at);
    if (refused) {
      const now = hot[refused.id];
      const keep = () => {
        const next = { ...saved };
        delete next[refused.id];
        store(Object.keys(next).length ? next : null);
      };
      return html`<tr class="ctl-note"><td colspan="3"><div class="note row" role="status"><span class="grow">${now.length
        ? t('ctl.refusedNow', '{key}, your key for “{action}”, is taken by {owner} – it is on {now} for now. Click it to pick another key.', { key: comboLabel(refused.key), action: nameOf(refused.id), now: comboLabel(now[0]), owner: refused.why === 'menu' ? t('ctl.ownerMenu', 'souldew’s menu') : t('ctl.ownerSystem', 'the system') })
        : t('ctl.refusedNone', '{key}, your key for “{action}”, is taken by {owner} – it has no key for now. Click it to pick another key.', { key: comboLabel(refused.key), action: nameOf(refused.id), owner: refused.why === 'menu' ? t('ctl.ownerMenu', 'souldew’s menu') : t('ctl.ownerSystem', 'the system') })}</span>
        ${now.length > 0 && html`<button class="btn small" onClick=${keep}>${t('ctl.keepKey', 'Keep {key}', { key: comboLabel(now[0]) })}</button>`}
      </div></td></tr>`;
    }
    if (!listening && msg?.at !== at) return null;
    const text = msg?.at === at ? msg.text : t('ctl.pressFor', 'Press the new key for “{action}” – Esc cancels.', { action: nameOf(listen) });
    // (mousedown: the key cap keeps the focus, so it is still listening when the click arrives)
    const keep = (e) => e.preventDefault();
    return html`<tr class="ctl-note"><td colspan="3"><div class="note row" role="status"><span class="grow">${text}</span>
      ${listening && isHotkeyId(listen) && hot[listen].length > 0 && html`<button class="btn small" onMouseDown=${keep} onClick=${() => clear(listen)}>${t('ctl.noKey', 'No key')}</button>`}
      ${!listening && msg.swap && html`<button class="btn small" onClick=${() => { store(msg.swap); setMsg(null); }}>${t('ctl.swap', 'Swap keys')}</button>`}
      ${!listening && msg.undo !== undefined && html`<button class="btn small ghost" onClick=${() => { store(msg.undo); setMsg(null); }}>${t('ctl.undo', 'Undo')}</button>`}
      ${(listening || msg.undo === undefined) && html`<button class="btn small ghost" onMouseDown=${keep} onClick=${() => { setListen(null); setMsg(null); }}>${t('common.cancel', 'Cancel')}</button>`}
    </div></td></tr>`;
  };
  // a key cap; without a key it says "none" (a dash would read as the minus key)
  const cap = (id, label, text, extra = '') => {
    const none = text === '–';
    const shown = none ? t('ctl.none', 'none') : text;
    return html`<button type="button" class=${`kbd ctl-key${extra}${none ? ' ctl-none' : ''}${listen === id ? ' on' : ''}`} aria-label=${`${label}: ${shown}`}
      onClick=${() => click(id)} onBlur=${() => blur(id)}>${listen === id ? t('ctl.press', 'Press a key …') : shown}</button>`;
  };
  const lay = currentLayout();
  return html`<section class="panel stack">
    <h2>${t('set.controls', 'Controls')}</h2>
    <p class="small muted">${t('set.controlsText2', 'Keyboard keys for the built-in emulator and its shortcuts. Click a key, then press the new one – any key can go to any button or shortcut, and shortcuts can also be switched off. Changes apply right away, also to a game that is running.')}</p>
    <div class="row">
      <div class="seg" role="group" aria-label=${t('ctl.presets', 'Key presets')}>
        ${PRESETS.map((p) => html`<button type="button" class=${active === p.id ? 'on' : ''} aria-pressed=${active === p.id} onClick=${() => pick(p.id)}>${presetLabel(p.id)}</button>`)}
        <button type="button" class=${active ? '' : 'on'} aria-pressed=${!active} disabled=${!!active} title=${t('ctl.customHint', 'Your own keys – click a key in the table to change it')}>${t('ctl.custom', 'Custom')}</button>
      </div>
      <span class="small faint">${lay.real ? t('ctl.layoutSystem', 'Key names follow your keyboard layout.')
        : t('ctl.layoutGuess', 'Key names assume a {layout} keyboard (from the app language).', { layout: lay.id.toUpperCase() })}</span>
    </div>
    ${msg?.at === 'preset' && html`<div class="note row" role="status"><span class="grow">${msg.text}</span>
      <button class="btn small ghost" onClick=${() => { store(msg.undo); setMsg(null); }}>${t('ctl.undo', 'Undo')}</button></div>`}
    <table class="data ctl-table"><thead><tr><th>${t('keys.button', 'Console button')}</th><th>${t('keys.key', 'Key')}</th><th>${t('set.system', 'System')}</th></tr></thead><tbody>
      ${BUTTONS.map((b) => html`<tr><td>${buttonLabel(b.id)}</td><td>${cap(b.id, buttonLabel(b.id), keyLabel(map[b.id]))}</td>
        <td class="small faint">${(b.systems || SYS_ALL).map((s) => SYS_SHORT[s]).join(' · ')}</td></tr>${note(b.id)}`)}
      <tr><th colspan="3">${t('guide.shortcuts', 'Shortcuts while playing')}</th></tr>
      ${HOTKEY_ROWS.map((r) => {
        const also = r.ids.length > 1
          ? (r.ids.every((id, i) => hot[id][1]?.keyCode === 97 + i && plainCombo(hot[id][1])) ? ['Num 1–4'] : [])
          : alsoKeys(hot[r.id]);
        return html`<tr><td>${rowLabel(r)}</td><td>${r.ids.length > 1
          ? html`<span class="ctl-slots">${r.ids.map((id) => cap(id, hotkeyLabel(id), comboLabel(hot[id]), ' ctl-slot'))}</span>`
          : cap(r.id, hotkeyLabel(r.id), comboLabel(hot[r.id]))}</td>
          <td class="small faint">${also.length ? t('ctl.alsoKey', 'also {key}', { key: also.join(', ') }) : ''}</td></tr>${note(r.id)}`;
      })}
    </tbody></table>
    <div class="row"><span class="small faint">${t('ctl.sneakHint', 'Circle Pad half tilt (3DS): hold it while walking and the Circle Pad tilts only part of the way – to sneak in Omega Ruby / Alpha Sapphire or walk slowly in other games.')}</span></div>
    <div class="row"><span class="small faint">${t('ctl.touch', 'Touch screen (DS): mouse click.')} ${t('ctl.resetBar', 'Reset, pause and the save states are always in the bar under the game too – also without a key.')}</span></div>
  </section>`;
}

export const GPU_LABELS = () => ({ auto: t('set.gpuAuto', 'Automatic'), d3d11: 'Direct3D 11', vulkan: 'Vulkan', gl: 'OpenGL' });

/**
 * Graphics backend (Windows and Linux, desktop app only – shared/gpu.mjs): Chromium reads it at start, so a change
 * needs a restart. The app tells which backend this session runs with; while that differs from the saved choice,
 * the hint with "Restart now" stays.
 */
function GraphicsSetting({ cfg, save }) {
  const [active, setActive] = useState(null);
  const [safe, setSafe] = useState(false);
  const native = typeof window.sls?.gpuInfo === 'function' && gpuBackends(PLATFORM).length > 1;
  useEffect(() => {
    if (native) {
      window.sls.gpuInfo().then((g) => {
        setActive(g?.backend || 'auto');
        setSafe(!!g?.safe);
      }).catch(() => {});
    }
  }, [native]);
  if (!native) return null;
  const value = cfg.gpuBackend || 'auto';
  const labels = GPU_LABELS();
  return html`<div class="stack">
    ${safe && html`<div class="note row" role="status"><span class="grow">${t('set.gpuSafeNote', 'souldew runs in safe graphics mode (software rendering, slower). If the window stays blank in a normal start, pick another graphics backend here – Vulkan or OpenGL often help – then restart normally.')}</span>
      <button class="btn small" onClick=${() => window.sls.relaunch?.()}>${t('set.gpuSafeRestart', 'Restart normally')}</button></div>`}
    <div class="grid-2"><label class="field"><span>${t('set.gpu', 'Graphics backend')}</span>
      <select value=${value} onChange=${(e) => save({ gpuBackend: e.target.value })}>
        ${gpuBackends(PLATFORM).map((b) => html`<option value=${b}>${labels[b]}</option>`)}</select></label></div>
    <span class="small faint">${t('set.gpuHint', 'If the game stutters or the sound crackles, try Vulkan. Automatic lets the system decide.')}</span>
    ${!safe && active && active !== value && html`<div class="note row" role="status"><span class="grow">${t('set.gpuRestart', 'The new graphics backend is used after a restart of souldew.')}</span>
      <button class="btn small" onClick=${() => window.sls.relaunch?.()}>${t('upd.restart', 'Restart now')}</button></div>`}
  </div>`;
}

/** The 3DS renderer's names (server/lib/ctrrenderer.mjs). */
export const CTR_RENDERER_LABELS = () => ({
  auto: t('set.ctrRendererAuto', 'Automatic'),
  vulkan: 'Vulkan',
  compat: t('set.ctrRendererCompat', 'Vulkan (compatibility)'),
  software: t('set.ctrRendererSoftware', 'Software'),
});

/**
 * How the built-in 3DS player draws. "Automatic" starts with Vulkan and steps down by itself when a graphics driver
 * can't run it (remembered for that card and driver); the others are fixed.
 */
function CtrRendererSetting({ cfg, status, save }) {
  if (!status?.ctr?.ok) return null;
  const value = cfg.ctrRenderer || 'auto';
  const labels = CTR_RENDERER_LABELS();
  const now = status.ctr.renderer;
  return html`<div class="stack-s">
    <div class="grid-2"><label class="field"><span>${t('set.ctrRenderer', '3DS renderer')}</span>
      <select value=${value} onChange=${(e) => save({ ctrRenderer: e.target.value })}>
        ${['auto', 'vulkan', 'compat', 'software'].map((m) => html`<option value=${m}>${labels[m]}</option>`)}</select></label></div>
    <span class="small faint">${t('set.ctrRendererHint', 'How souldew’s built-in 3DS player draws the game. Automatic starts with Vulkan; if the game stops right after starting, it switches to Vulkan (compatibility) and then to Software, and remembers that for this graphics card and driver. Software works on every PC but is much slower. Applies to the next 3DS game you start.')}</span>
    ${value === 'auto' && now && now !== 'vulkan' && html`<span class="small muted" role="status">${t('set.ctrRendererLearned', 'This graphics card currently plays 3DS games with: {mode}', { mode: labels[now] || now })}</span>`}
  </div>`;
}

/**
 * The built-in 3DS player's internal resolution (issue #59): 1× is the 3DS's own, 2× and 3× draw the games sharper and
 * cost the graphics card more. The host takes it at its start – it applies to the next 3DS game.
 */
function CtrScaleSetting({ cfg, status, save }) {
  if (!status?.ctr?.ok) return null;
  const value = [1, 2, 3].includes(cfg.ctrScale) ? cfg.ctrScale : 1;
  const labels = { 1: t('set.ctrScale1', '1× (native)'), 2: '2×', 3: '3×' };
  return html`<div class="stack-s">
    <div class="grid-2"><label class="field"><span>${t('set.ctrScale', '3DS resolution')}</span>
      <select value=${value} onChange=${(e) => save({ ctrScale: Number(e.target.value) })}>
        ${[1, 2, 3].map((n) => html`<option value=${n}>${labels[n]}</option>`)}</select></label></div>
    <span class="small faint">${t('set.ctrScaleHint', 'Draws the 3DS games at two or three times their own resolution – sharper and less pixelated, but more work for the graphics card. Applies to the next 3DS game you start. The Software renderer always plays at 1×, and so does the automatic step down after a crash.')}</span>
  </div>`;
}

/** The notice after souldew put the graphics backend back to "Automatic" itself (shown once, see app.mjs). */
export function gpuFallbackText(notice) {
  const backend = GPU_LABELS()[notice.from] || notice.from;
  return notice.reason === 'gpu-crash'
    ? t('set.gpuFallbackCrash', 'The graphics backend {backend} kept crashing. souldew uses “Automatic” again from the next start – you can change it in Settings.', { backend })
    : t('set.gpuFallbackStart', 'souldew didn’t open with the graphics backend {backend}, so it uses “Automatic” again. You can change it in Settings.', { backend });
}

/** Connected controllers (polled – the Gamepad API has no "button pressed" event). */
export function usePads() {
  const [pads, setPads] = useState([]);
  useEffect(() => {
    let last = '';
    const read = () => {
      const now = [...(navigator.getGamepads?.() || [])].filter((g) => g && g.connected)
        .map((g) => ({ id: g.id, index: g.index, family: padFamily(g.id), standard: g.mapping === 'standard', axes: g.axes.length, buttons: g.buttons.length, pressed: g.buttons.map((b) => b.pressed) }));
      const sig = JSON.stringify(now);
      if (sig !== last) setPads(now); // re-render only when something changed
      last = sig;
    };
    read();
    const id = setInterval(read, 60);
    return () => clearInterval(id);
  }, []);
  return pads;
}

/** Face buttons of a controller we can't name: where they sit. */
export const PAD_POS = () => ({ BUTTON_1: t('pad.posBottom', 'bottom button'), BUTTON_2: t('pad.posRight', 'right button'), BUTTON_3: t('pad.posLeft', 'left button'), BUTTON_4: t('pad.posTop', 'top button') });

export const FAMILY_NAMES = () => ({ playstation: 'PlayStation (DualSense / DualShock)', xbox: 'Xbox', switch: t('pad.switch', 'Nintendo Switch (Pro Controller / Joy-Con)'), generic: t('pad.generic', 'Controller') });

/** A device's name as the browser reports it, without the vendor/product part in brackets. */
export const padName = (id) => String(id || '').replace(/\s*\(.*\)\s*$/, '') || String(id || '');

/**
 * Which connected device plays (lib/controls.mjs pickPad): "Automatic" or one the player picked – remembered as
 * config.pads.device. Shown as soon as there is a choice to make: two devices, one that doesn't look like a controller,
 * or a remembered one.
 */
function PadPicker({ pads, saved, pad, onPick }) {
  const wanted = saved?.device ? padKey(saved.device) : '';
  const missing = wanted && !pads.some((p) => padKey(p.id) === wanted);
  if (pads.length < 2 && !wanted && (!pads.length || looksLikePad(pads[0]))) return null;
  const auto = pickPad(pads);
  // the same model twice has the same id – they are told apart by their slot
  const twice = (p) => pads.filter((q) => q.id === p.id).length > 1;
  const label = (p) => `${padName(p.id)}${twice(p) ? ` (${p.index + 1})` : ''}${looksLikePad(p) ? '' : ` – ${t('pad.notAPad', 'doesn’t look like a controller')}`}`;
  return html`<div class="grid-2"><label class="field"><span>${t('pad.use', 'Controller to use')}</span>
    <select value=${wanted} onChange=${(e) => onPick(e.target.value || null)}>
      <option value="">${auto ? t('pad.auto', 'Automatic – {name}', { name: padName(auto.id) }) : t('pad.autoNone', 'Automatic')}</option>
      ${pads.filter((p, i) => pads.findIndex((q) => q.id === p.id) === i).map((p) => html`<option value=${padKey(p.id)}>${label(p)}</option>`)}
      ${missing && html`<option value=${wanted}>${t('pad.missing', '{name} (not connected)', { name: padName(wanted) })}</option>`}
    </select></label>
    <span class="small faint pad-pick-hint">${pad && wanted && padKey(pad.id) === wanted ? t('pad.remembered', 'souldew remembers this controller and uses it whenever it is connected.')
      : t('pad.autoHint', 'Automatic picks a real controller and skips microphones, headsets and other devices the system lists as controllers.')}</span></div>`;
}

function PadSection({ saved, save, nav, saveNav }) {
  const pads = usePads();
  const pad = pickPad(pads, saved?.device);
  const odd = !pad && pads.length ? pads : null; // only devices that don't look like a controller
  const keep = saved?.device ? { device: saved.device } : {};
  const family = pad?.family || 'generic';
  const map = padMap(saved);
  const hot = padHotkeys(saved); // the shortcuts' buttons – ZR turbo, ZL pause, fast-forward none unless picked here
  const all = { ...map, ...hot };
  const preset = PAD_PRESETS.find((p) => p.id === saved?.preset) || PAD_PRESETS[0];
  const custom = !!saved?.map && (BUTTONS.some((b) => map[b.id] !== preset.map[b.id]) || PAD_HOTKEY_IDS.some((h) => hot[h] !== PAD_HOTKEY_DEFAULTS[h]));
  const [listen, setListen] = useState(null);
  const [msg, setMsg] = useState(null); // { at (row), text, swap?, undo? }
  const before = useRef(null);
  const nameOf = (id) => (isHotkeyId(id) ? hotkeyLabel(id) : buttonLabel(id));
  const show = (label) => padLabel(label, family, PAD_POS());
  // waiting for a button: the first one that goes down (and wasn't down when we started listening) is the new one
  useEffect(() => {
    if (!listen || !pad) return;
    if (!before.current) before.current = pad.pressed;
    const i = pad.pressed.findIndex((p, k) => p && !before.current[k] && k < PAD_LABELS.length);
    if (i < 0) return;
    const label = PAD_LABELS[i];
    before.current = null;
    const id = listen;
    setListen(null);
    if (all[id] === label) return setMsg(null);
    // it takes the button over – whatever had it is left without one (or swaps, if the player wants)
    const { next, lost, swap } = assignPad(saved, id, label);
    save({ pads: { ...next, ...keep } });
    setMsg(lost.length ? { at: id, undo: saved, swap: swap && { ...swap, ...keep },
      text: lost.map((l) => t('ctl.tookOver2', '{key} was the key for “{action}” – it has no key now.', { key: show(label), action: nameOf(l.id) })).join(' ') } : null);
  }, [pad?.pressed?.join(), listen]);
  useEffect(() => {
    if (!listen) return undefined;
    const esc = (e) => e.key === 'Escape' && (setListen(null), (before.current = null));
    addEventListener('keydown', esc);
    // the next button pressed is the new one – it must not also move the focus (lib/padnav.mjs)
    const resume = suspendPadNav();
    return () => {
      removeEventListener('keydown', esc);
      resume();
    };
  }, [listen]);
  const pick = (id) => { setListen(null); setMsg(null); save({ pads: { preset: id, ...keep } }); };
  const choose = (device) => {
    setListen(null);
    setMsg(null);
    save({ pads: { ...(saved?.preset ? { preset: saved.preset } : {}), ...(saved?.map ? { map: saved.map } : {}), ...(device ? { device } : {}) } });
  };
  const off = (id) => {
    setListen(null);
    setMsg(null);
    save({ pads: { preset: preset.id, ...keep, map: { ...Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v || PAD_NONE])), [id]: PAD_NONE } } });
  };
  const note = (id) => {
    const listening = listen === id;
    if (!listening && msg?.at !== id) return null;
    const keepFocus = (e) => e.preventDefault();
    return html`<tr class="ctl-note"><td colspan="2"><div class="note row" role="status"><span class="grow">${listening
      ? t('pad.pressFor', 'Press the new button for “{action}” on the controller – Esc cancels.', { action: nameOf(id) }) : msg.text}</span>
      ${listening && isHotkeyId(id) && all[id] && html`<button class="btn small" onMouseDown=${keepFocus} onClick=${() => off(id)}>${t('ctl.noKey', 'No key')}</button>`}
      ${!listening && msg.swap && html`<button class="btn small" onClick=${() => { save({ pads: msg.swap }); setMsg(null); }}>${t('ctl.swap', 'Swap keys')}</button>`}
      ${!listening && html`<button class="btn small ghost" onClick=${() => { save({ pads: msg.undo }); setMsg(null); }}>${t('ctl.undo', 'Undo')}</button>`}
      ${listening && html`<button class="btn small ghost" onMouseDown=${keepFocus} onClick=${() => { setListen(null); before.current = null; }}>${t('common.cancel', 'Cancel')}</button>`}
    </div></td></tr>`;
  };
  const row = (id) => {
    const lit = pad && all[id] && pad.pressed[PAD_LABELS.indexOf(all[id])];
    return html`<tr class=${lit ? 'pad-lit' : ''}><td>${nameOf(id)}</td><td>
      <button type="button" class=${`kbd ctl-key${all[id] ? '' : ' ctl-none'}${listen === id ? ' on' : ''}`} disabled=${!pad}
        title=${pad ? '' : t('pad.connectFirst', 'Connect a controller first')}
        onClick=${() => { before.current = null; setMsg(null); setListen(listen === id ? null : id); }}>
        ${listen === id ? t('pad.press', 'Press a button …') : all[id] ? show(all[id]) : t('ctl.none', 'none')}</button></td></tr>${note(id)}`;
  };
  const pause = hot.pause ? show(hot.pause) : null;
  return html`<section class="panel stack">
    <h2>${t('pad.title', 'Controller')}</h2>
    <p class="small muted">${t('pad.text', 'PlayStation, Xbox, Switch and other controllers work over USB or Bluetooth. Click a button in the table, then press the new one on the controller. Changes apply right away, also to a game that is running.')}</p>
    <div class=${`pad-status ${pad ? 'on' : ''}`} role="status">
      <span class=${`led green ${pad ? 'on' : ''}`}></span>
      ${pad ? html`<span><b>${FAMILY_NAMES()[family]}</b> <span class="small faint">${padName(pad.id)}</span>${!pad.standard ? html` <span class="chip">${t('pad.nonStandard', 'unusual layout – check the buttons below')}</span>` : ''}</span>`
        : odd ? html`<span class="small">${t('pad.onlyOdd', 'No controller found – {name} doesn’t look like one. Connect your controller and press a button on it, or pick the device below if it is one.', { name: odd.map((p) => padName(p.id)).join(', ') })}</span>`
        : html`<span class="small">${t('pad.none', 'No controller found. Connect one and press any button on it.')}</span>`}
    </div>
    <${PadPicker} pads=${pads} saved=${saved} pad=${pad} onPick=${choose} />
    <label class="check"><input type="checkbox" checked=${nav} onChange=${(e) => saveNav(e.target.checked)} /><span>${t('pad.nav', 'Navigate the app with a controller')}
      <span class="hint">${pause ? t('pad.navHint', 'D-pad or left stick moves between buttons, A presses, B goes back, L and R switch sections or tabs, Start jumps to the sidebar, the right stick scrolls. While a game runs, the controller belongs to the game – pause it ({button} or Home) to use the menus.', { button: pause })
        : t('pad.navHintHome', 'D-pad or left stick moves between buttons, A presses, B goes back, L and R switch sections or tabs, Start jumps to the sidebar, the right stick scrolls. While a game runs, the controller belongs to the game – pause it (Home) to use the menus.')}</span></span></label>
    <div class="row">
      <div class="seg" role="group" aria-label=${t('pad.layouts', 'Button layout')}>
        ${PAD_PRESETS.map((p) => html`<button type="button" class=${!custom && preset.id === p.id ? 'on' : ''} aria-pressed=${!custom && preset.id === p.id} onClick=${() => pick(p.id)}>${p.id === 'nintendo' ? t('pad.nintendo', 'Nintendo layout (A right)') : t('pad.xbox', 'Xbox layout (A bottom)')}</button>`)}
        <button type="button" class=${custom ? 'on' : ''} aria-pressed=${custom} disabled=${!custom}>${t('ctl.custom', 'Custom')}</button>
      </div>
    </div>
    <table class="data"><thead><tr><th>${t('keys.button', 'Console button')}</th><th>${t('pad.button', 'Controller button')}</th></tr></thead><tbody>
      ${BUTTONS.map((b) => row(b.id))}
      <tr><th colspan="2">${t('guide.shortcuts', 'Shortcuts while playing')}</th></tr>
      ${PAD_HOTKEY_IDS.map(row)}
    </tbody></table>
    <ul class="small muted pad-hints">
      <li>${t('pad.stick', 'Left stick: moves like the D-pad.')}</li>
      <li>${t('pad.sneak', 'Circle Pad half tilt (3DS): a stick doesn’t need it – just tilt it a little. With a button for it, the D-pad sneaks too while you hold that button.')}</li>
      <li>${t('pad.home', 'The Home button always pauses – also when no other button does.')}</li>
    </ul>
  </section>`;
}

/** Colour scheme cards (Settings and the welcome tour); a pick applies at once. */
export function ThemePicker({ value, onPick }) {
  const cur = value || 'classic';
  return html`<div class="theme-picker" role="radiogroup" aria-label=${t('set.theme', 'Colour scheme')}>
    ${THEMES().map(([id, name, hint]) => html`<button type="button" role="radio" aria-checked=${cur === id}
      class=${`theme-card ${cur === id ? 'on' : ''}`} data-theme-preview=${id} onClick=${() => { applyTheme(id); onPick(id); }}>
      <span class="theme-swatches" aria-hidden="true"><i class="sw ok"></i><i class="sw bad"></i><i class="sw warn"></i><i class="sw p1"></i><i class="sw p2"></i><i class="sw p3"></i><i class="sw p4"></i></span>
      <b>${name}</b><span class="hint">${hint}</span></button>`)}
  </div>`;
}

const THEMES = () => [
  ['classic', t('theme.classic', 'Classic'), t('theme.classicHint', 'Dark, the original colours')],
  ['contrast', t('theme.contrast', 'High contrast'), t('theme.contrastHint', 'Black background, brighter text and edges')],
  ['deutan', t('theme.deutan', 'Red-green safe'), t('theme.deutanHint', 'For deuteranopia / protanopia: blue and orange instead of green and red')],
  ['tritan', t('theme.tritan', 'Blue-yellow safe'), t('theme.tritanHint', 'For tritanopia: teal and magenta instead of blue and yellow')],
];

export function SettingsView() {
  const { status, reloadStatus, toast, library, reloadLibrary } = useApp();
  const cfg = status?.config || {};
  const [name, setName] = useState(cfg.playerName || '');
  const [busy, setBusy] = useState(null);
  const nameChanged = name.trim() !== (cfg.playerName || '');
  const save = async (patch) => {
    try {
      await api.post('/api/config', patch);
    } catch (e) {
      toast({ kind: 'death', title: t('set.saveFailed', 'Couldn’t save the setting'), text: e.message });
    }
    await reloadStatus(); // also puts a failed change back on screen
  };
  const folders = async (body) => {
    try {
      await api.post('/api/library/folders', body);
    } catch (e) {
      toast({ kind: 'death', title: t('set.library', 'Library'), text: e.message });
    }
    await reloadStatus();
    await reloadLibrary();
  };
  const install = async (id) => {
    setBusy(id);
    try {
      await api.post(`/api/emulators/${id}/install`);
      await reloadStatus();
      toast({ kind: 'ok', title: status.emulators[id].name, text: t('set.installed', 'Installed') });
    } catch (e) {
      toast({ kind: 'death', title: status.emulators[id].name, text: e.message });
    }
    setBusy(null);
  };
  return html`<div class="stack-l">
    <div class="topbar"><h1>${t('nav.settings', 'Settings')}</h1></div>

    <section class="panel stack">
      <h2>${t('set.general', 'General')}</h2>
      <div class="grid-2">
        <label class="field"><span>${t('set.language', 'Language')}</span>
          <select value=${currentLang()} onChange=${async (e) => { await setLang(e.target.value); await save({ lang: e.target.value }); }}>
            ${LANGS.map((l) => html`<option value=${l.id}>${l.native}</option>`)}</select></label>
        <label class="field"><span>${t('set.name', 'Your name')}</span>
          <div class="row nowrap"><input type="text" class="grow" value=${name} maxLength="20" onInput=${(e) => setName(e.target.value)}
            onKeyDown=${(e) => e.key === 'Enter' && nameChanged && save({ playerName: name.trim() })} />
          <button class="btn" disabled=${!nameChanged} onClick=${() => save({ playerName: name.trim() })}>${t('common.save', 'Save')}</button></div></label>
      </div>
      <label class="check"><input type="checkbox" checked=${cfg.bootAnimation !== false} onChange=${(e) => save({ bootAnimation: e.target.checked })} /><span>${t('set.boot', 'Play animations (start-up, inserting the cartridge)')}</span></label>
      <label class="check"><input type="checkbox" checked=${cfg.fullTurbo !== false} onChange=${(e) => save({ fullTurbo: e.target.checked })} /><span>${t('set.fullTurbo', 'Full-power turbo: no brake while fast-forwarding')}
        <span class="hint">${t('set.fullTurboHint', 'The game may use almost all of the computer’s time while fast-forwarding, and DS games skip drawing frames nobody sees. Never steps down. If the app reacts sluggishly while fast-forwarding, turn it off. Normal speed stays the same.')}</span></span></label>
      <label class="check"><input type="checkbox" disabled=${cfg.fullTurbo !== false} checked=${cfg.speedGuard === true && cfg.fullTurbo === false} onChange=${(e) => save({ speedGuard: e.target.checked })} /><span>${t('set.speedGuard', 'Step down when the computer can’t keep up')}
        <span class="hint">${cfg.fullTurbo !== false ? t('set.speedGuardFull', 'Not with full-power turbo.') : t('set.speedGuardHint', 'Off: the speed you pick stays as it is, the bar shows when a scene runs slower. On: a level that isn’t reached for a few seconds drops to the highest one that holds.')}</span></span></label>
      <label class="check"><input type="checkbox" checked=${cfg.turboMax === true} onChange=${(e) => save({ turboMax: e.target.checked })} /><span>${t('set.turboMax', 'Turbo step “Max”: as fast as this computer can')}
        <span class="hint">${t('set.turboMaxHint', 'After 4× comes “Max” – no speed limit at all. How fast it gets depends on the game and the computer.')}</span></span></label>
      <label class="check"><input type="checkbox" checked=${cfg.sounds !== false} onChange=${(e) => save({ sounds: e.target.checked })} /><span>${t('set.soundsAll', 'Sounds on this computer (start-up chime, catches, deaths, badges, pings)')}</span></label>
      <label class="check"><input type="checkbox" checked=${cfg.shareScreen !== false} onChange=${(e) => save({ shareScreen: e.target.checked })} /><span>${t('set.shareScreenAll', 'Share my screen with the other players')}
        <span class="hint">${t('set.shareScreenHint', 'While you play, the others see your game small in a corner. It is only sent while someone is watching.')}</span></span></label>
      ${EDITION.presence && html`<label class="check"><input type="checkbox" checked=${cfg.presence !== false} onChange=${(e) => save({ presence: e.target.checked })} /><span>${t('set.presence', 'Count me in “playing now” (anonymous)')}
        <span class="hint">${t('set.presenceHint', 'Only while a game runs: system, solo/Nuzlocke/SoulLink and app version with a random id, for the player count on the souldew Discord – no name, no game, no IP stored.')}
          ${' '}<a href=${LINKS.privacy} onClick=${(e) => { e.preventDefault(); e.stopPropagation(); openExternal(currentLang() === 'de' ? LINKS.privacy : LINKS.privacyDocs); }}>${t('set.presenceMore', 'What exactly is sent')}</a></span></span></label>`}
      <${GraphicsSetting} cfg=${cfg} save=${save} />
      <div><button class="btn ghost small" onClick=${() => save({ onboarded: false })}>${t('set.replayOnboarding', 'Show the welcome tour again')}</button></div>
    </section>

    <section class="panel stack">
      <h2>${t('set.appearance', 'Appearance')}</h2>
      <p class="small muted">${t('set.themeText', 'Colour scheme of the whole app. The colour-blind schemes replace the green/red signals (alive, dead, warnings) with colours that stay apart with that colour vision.')}</p>
      <${ThemePicker} value=${cfg.theme} onPick=${(id) => save({ theme: id })} />
    </section>

    <${ControlsSection} saved=${cfg.controls || null} save=${(p) => save(p).catch((e) => toast({ kind: 'death', title: t('set.controls', 'Controls'), text: e.message }))} />
    <${PadSection} saved=${cfg.pads || null} save=${(p) => save(p).catch((e) => toast({ kind: 'death', title: t('pad.title', 'Controller'), text: e.message }))}
      nav=${cfg.padNav !== false} saveNav=${(on) => save({ padNav: on })} />

    <section class="panel stack">
      <h2>${t('set.emulators', 'Emulators')}</h2>
      <p class="small muted">${t('set.emuText', 'The built-in emulator plays every system up to the Nintendo 3DS and has the best live sync. 3DS games can also run in Azahar (for example when a graphics card can’t run the built-in 3DS player). External emulators are optional otherwise.')}</p>
      ${status?.native?.ok && html`<label class="check"><input type="checkbox" checked=${cfg.nativeCore !== false} onChange=${(e) => save({ nativeCore: e.target.checked })} /><span>${t('set.native', 'Fast player for DS, GBA and Game Boy')}
        <span class="hint">${t('set.nativeHint', 'Runs the game with the real emulators (melonDS, mGBA, Gambatte) directly on your computer: full speed even on weaker PCs, and fast-forward that really reaches 4× and more. Live sync, cheats, save states and the in-game save work as before. Save states from the other player can’t be loaded here (and the other way round). Off: the browser emulator as before. Applies to the next game you start.')}</span></span></label>`}
      <${CtrRendererSetting} cfg=${cfg} status=${status} save=${save} />
      <${CtrScaleSetting} cfg=${cfg} status=${status} save=${save} />
      <table class="data"><thead><tr><th>${t('set.system', 'System')}</th><th>${t('set.useEmu', 'Play with')}</th></tr></thead><tbody>
        ${SYSTEMS.map(([sys, label]) => html`<tr><td>${label}</td><td>
          <select value=${externalOnly(sys, status) ? Object.keys(status?.emulators || {}).find((id) => status.emulators[id].systems.includes(sys)) : cfg.emulatorFor?.[sys] || 'builtin'}
            disabled=${externalOnly(sys, status)} onChange=${(e) => save({ emulatorFor: { ...(cfg.emulatorFor || {}), [sys]: e.target.value } })}>
            ${!externalOnly(sys, status) && html`<option value="builtin">${t('set.builtin', 'Built-in (live)')}</option>`}
            ${Object.entries(status?.emulators || {}).filter(([, e]) => e.systems.includes(sys)).map(([id, e]) => html`<option value=${id} disabled=${!e.installed && !externalOnly(sys, status)}>${e.name}${e.live === 'script' ? ` (${t('set.liveScript', 'live via script')})` : e.live === 'rpc' ? ` (${t('set.liveRpc', 'live via RPC')})` : ` (${t('set.liveSave', 'syncs on save')})`}${e.installed ? '' : ` – ${t('set.notInstalled', 'not installed')}`}</option>`)}
          </select></td></tr>`)}
      </tbody></table>
      ${Object.entries(status?.emulators || {}).map(([id, e]) => html`<div class="check-item">
        <span class=${`led green ${e.installed ? 'on' : ''}`}></span>
        <div><b style="font-weight:500">${e.name}</b> <span class="small muted">${e.systems.map((s) => s.toUpperCase()).join(' · ')}</span>
          <div class=${`tiny faint ${e.installed ? 'sm-secret' : ''}`}>${e.installed ? e.path : t('set.notInstalled', 'not installed')}</div></div>
        ${e.installed ? html`<span class="chip ok">${t('set.installed', 'Installed')}</span>` : html`<button class="btn small" disabled=${!!busy} onClick=${() => install(id)}>${busy === id ? t('set.installing', 'Installing …') : t('set.install', 'Install')}</button>`}
      </div>`)}
      ${status?.emulators?.mgba?.installed && html`<div class="note">${t('set.mgbaScriptAgain', 'For live data with mGBA: Tools › Scripting… › File › Load script… and pick this file (again after every mGBA restart):')} <span class="code">${status.live?.script}</span>
        <button class="btn small ghost" onClick=${() => { copy(status.live?.script || ''); toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: status.live?.script }); }}>${t('common.copy', 'Copy')}</button></div>`}
    </section>

    <section class="panel stack">
      <h2>${t('set.library', 'Library')}</h2>
      <p class="small muted">${t('set.libraryText', 'Games you add are copied into the library folder. You can also include folders where your ROMs already are.')}</p>
      <div class="row"><span class="code grow ellipsis" title=${library?.libraryDir}>${library?.libraryDir}</span>
        ${window.sls && html`<button class="btn small ghost" onClick=${() => api.post('/api/library/reveal', {})}><${Icon} name="folder" size=${14} />${t('lib.reveal', 'Show folder')}</button>`}</div>
      ${(cfg.libraryFolders || []).map((f) => html`<div class="row"><span class="code grow ellipsis" title=${f}>${f}</span>
        <button class="btn small ghost" onClick=${() => folders({ remove: f })}>${t('common.remove', 'Remove')}</button></div>`)}
      ${window.sls && html`<div><button class="btn small" onClick=${async () => {
        const paths = await window.sls.pickFiles({ folder: true, title: t('set.addFolder', 'Include a folder') });
        if (paths?.[0]) await folders({ add: paths[0] });
      }}><${Icon} name="plus" size=${14} />${t('set.addFolder', 'Include a folder')}</button></div>`}
    </section>

    ${LIVE_RUNS && html`<section class="panel stack" id="set-discord">
      <h2>Discord</h2>
      <${LiveRunsSettings} />
    </section>`}

    <section class="panel stack">
      <h2>${t('set.about', 'About')}</h2>
      <${UpdateSection} />
      <dl class="facts small">
        <dt>${t('set.randomizer', 'Randomizer')}</dt><dd>Universal Pokémon Randomizer ZX ${status?.upr?.version} · Java ${status?.java?.version || t('set.javaMissing', 'not found')}${status?.java?.bundled ? ` (${t('set.bundled', 'bundled')})` : ''}</dd>
        <dt>${t('set.data', 'Pokémon data')}</dt><dd>PokeAPI · ${t('set.covers', 'covers')}: libretro-thumbnails</dd>
        <dt>${t('set.emuCore', 'Built-in emulator')}</dt><dd>EmulatorJS (melonDS, DeSmuME, mGBA, Gambatte) · ${t('set.nativeShort', 'Fast player')}: melonDS DS, mGBA, Gambatte (libretro) · 3DS: Azahar (libretro)</dd>
      </dl>
      <div class="row">
        <button class="btn small" onClick=${() => openExternal(LINKS.github)}><${Icon} name="external" size=${14} />${t('set.github', 'souldew on GitHub')}</button>
        <button class="btn small" onClick=${() => openExternal(LINKS.issues)}><${Icon} name="external" size=${14} />${t('set.reportBug', 'Report a bug')}</button>
        <button class="btn small" onClick=${() => openExternal(LINKS.coffee)}><${Icon} name="coffee" size=${14} />${t('rail.coffee', 'Buy me a coffee')}</button>
      </div>
      <label class="check small"><input type="checkbox" checked=${cfg.nagOff !== true} onChange=${(e) => save({ nagOff: !e.target.checked })} /><span>${t('set.nag', 'Show the joke license window now and then')}
        <span class="hint">${t('set.nagHint', 'A parody of old shareware nag screens. souldew stays free either way.')}</span></span></label>
      <label class="check small"><input type="checkbox" checked=${cfg.stream?.coffee !== false} onChange=${async (e) => { const on = e.target.checked; try { await api.post('/api/stream', { coffee: on }); reloadStatus?.(); } catch { toast({ kind: 'warn', title: t('set.saveFailed', 'Couldn’t save the setting') }); } }} /><span>${t('set.coffeePop', 'Coffee hint on legendary encounters in stream overlays')}
        <span class="hint">${t('set.coffeePopHint', 'Now and then a cheeky toast about the legendary pops up in your Alerts overlay, with the coffee link.')}</span></span></label>
      <p class="tiny faint">${t('set.legal', 'Pokémon and all related names are trademarks of Nintendo, Game Freak and The Pokémon Company. souldew is a fan project and does not include or download games.')}</p>
    </section>
  </div>`;
}
