import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp, saveDiagnostics, openExternal } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { LINKS } from '../lib/links.mjs';
import { EDITION } from '/shared/edition.mjs';
import { resolve as resolveControls, resolveHotkeys, keyLabel, HOTKEY_ROWS } from '../lib/controls.mjs';
import { shortcut, IS_MAC } from '../lib/platform.mjs';
import { ShowFirstStepsButton } from './firststeps.mjs';
import { WHATS_NEW_EVENT } from '../lib/whatsnew.mjs';
import { uiScaleKeys } from '../lib/uiscale.mjs';

/**
 * A key binding for display, with its modifiers: "Tab", "⇧ Tab" / "⌘+" on a Mac, "Shift+Tab" / "Ctrl+R" elsewhere – "–"
 * for none. A list of keys (a shortcut's) shows its first.
 */
export function comboLabel(b, key = null) {
  if (Array.isArray(b)) b = b[0];
  if (!b) return '–';
  const mods = [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', b.meta && (IS_MAC ? 'Cmd' : 'Meta')].filter(Boolean);
  const k = key ?? keyLabel(b);
  // (the key's own name may hold a "+": Num +)
  return mods.length ? shortcut([...mods, 'K'].join('+'), { space: true }).replace(/K$/, k) : k;
}

/** " (P)" after a button's name in the play bar – nothing when the shortcut has no key. */
export const hotkeyHint = (keys) => (keys?.length ? ` (${comboLabel(keys[0])})` : '');

/** The shortcuts' names (lib/controls.mjs HOTKEYS) – Settings › Controls and › Controller, Help. */
export function hotkeyLabel(id) {
  const n = /^(save|load)(\d)$/.exec(id);
  if (n) return n[1] === 'save' ? t('keys.saveSlotN', 'Save to slot {n}', { n: n[2] }) : t('keys.loadSlotN', 'Load slot {n}', { n: n[2] });
  return {
    ffHold: t('ctl.ffHold', 'Fast-forward (hold)'),
    ffToggle: t('ctl.ffToggle', 'Fast-forward on / off'),
    turbo: t('keys.turboToggle', 'Toggle turbo (2× → 3× → 4×)'),
    faster: t('play.faster', 'Faster'),
    slower: t('play.slower', 'Slower'),
    pause: t('keys.pause', 'Pause / resume'),
    reset: t('keys.reset', 'Reset the game (asks first)'),
    quicksave: t('keys.quicksaveSel', 'Quick save state (selected slot)'),
    quickload: t('keys.quickloadSel', 'Quick load state (selected slot)'),
    screenshot: t('keys.screenshot', 'Screenshot'),
    mute: t('keys.mute', 'Sound on/off'),
    louder: t('play.louder', 'Louder'),
    quieter: t('play.quieter', 'Quieter'),
    fullscreen: t('keys.fullscreen', 'Fullscreen game'),
  }[id] || id;
}

/**
 * The four slot keys of "save" or "load" for display: "⇧ 1–4" / "1–4" while they are the digits 1 to 4 (with the same
 * modifiers), else each one ("1 2 J 4", "–" for none).
 */
export function slotKeys(prefix, hot) {
  const first = [1, 2, 3, 4].map((n) => hot?.[`${prefix}${n}`]?.[0] || null);
  const row = first.every((c, i) => c && c.keyCode === 49 + i && ['shift', 'ctrl', 'alt', 'meta'].every((m) => !!c[m] === !!first[0][m]));
  return row ? comboLabel(first[0], '1–4') : first.map((c) => comboLabel(c)).join(' ');
}

/** The shortcuts while playing for Help, with the keys in use: [[keys, what it does], …]. controls: config.controls. */
export const SHORTCUTS = (controls = null) => {
  const hot = resolveHotkeys(controls);
  return [
    // (the rows of Settings › Controls)
    ...HOTKEY_ROWS.map((r) => (r.id === 'save' ? [slotKeys('save', hot), t('keys.saveSlot', 'Save to slot 1–4')]
      : r.id === 'load' ? [slotKeys('load', hot), t('keys.loadSlot', 'Load slot 1–4')] : [comboLabel(hot[r.id]), hotkeyLabel(r.id)])),
    // the play view's dock (web/views/play.mjs) – a fixed key, not one of Settings › Controls' shortcuts
    [shortcut('Mod+I', { space: true }), t('keys.dock', 'Fold / unfold the game panel next to the game')],
    // menu accelerators (electron/main.mjs) – only exist in the desktop app; ⌘ on a Mac, Ctrl on Windows
    ...(window.sls?.native ? [
      [shortcut('Mod+1–5', { space: true }), t('keys.sectionsNavStream', 'Library · SoulLink · Nuzlocke · Connection · Stream')],
      [shortcut('Mod+O', { space: true }), t('keys.add', 'Add games')],
      [shortcut('Mod+B', { space: true }), t('keys.sidebarPlay', 'Show / hide the sidebar (while playing it slides in over the game)')],
      // the interface size (lib/uiscale.mjs) – while a game fills the window, a shortcut above on the same key goes first
      [Object.values(uiScaleKeys({ space: true })).join('  '), t('keys.uiScale', 'Interface bigger · smaller · 100 % (while a game fills the window, its own shortcuts on these keys go first)')],
    ] : []),
  ];
};

export const buttonLabel = (id) => ({
  up: t('ctl.up', 'D-Pad up'), down: t('ctl.down', 'D-Pad down'), left: t('ctl.left', 'D-Pad left'), right: t('ctl.right', 'D-Pad right'),
  sneak: t('ctl.sneak', 'Circle Pad: half tilt (sneak)'),
}[id] || ({ start: 'Start', select: 'Select' }[id] || id.toUpperCase()));

/** Current game-button keys (Settings › Controls, defaults otherwise). */
export function ControlsTable() {
  const { status } = useApp();
  const m = resolveControls(status?.config?.controls);
  const k = (id) => keyLabel(m[id]);
  return html`<table class="data"><thead><tr><th>${t('keys.button', 'Console button')}</th><th>${t('keys.key', 'Key')}</th></tr></thead><tbody>
    ${[['D-Pad', ['up', 'down', 'left', 'right'].map(k).join(' ')], ['A', k('a')], ['B', k('b')], ['X (DS)', k('x')], ['Y (DS)', k('y')], ['L / R', `${k('l')} / ${k('r')}`],
      ['Start', k('start')], ['Select', k('select')], [t('keys.sneak', 'Circle Pad half tilt – hold to sneak (3DS)'), k('sneak')],
      [t('keys.touch', 'Touch screen (DS)'), t('keys.mouse', 'Mouse')]]
      .map(([a, b]) => html`<tr><td>${a}</td><td><span class="kbd">${b}</span></td></tr>`)}
  </tbody></table>`;
}

/** group: a run of 3–4 players – "the others' computers" instead of the partner's. */
export function ConnectionFlow({ group = false } = {}) {
  return html`<div class="flow" aria-label=${t('conn.flowAria', 'How the connection works')}>
    <div class="box"><b>${t('conn.yourComputer', 'Your computer')}</b><span>${t('conn.local', 'souldew, local')}</span></div>
    <span class="arrow" aria-hidden="true">⇄</span>
    <div class="box"><b>${t('conn.relays', 'Public relays')}</b><span>${t('conn.relaysSub', 'only see encrypted data')}</span></div>
    <span class="arrow" aria-hidden="true">⇄</span>
    <div class="box"><b>${group ? t('conn.friendGroup', 'The others’ computers') : t('conn.friend', 'Your partner’s computer')}</b><span>${t('conn.local', 'souldew, local')}</span></div>
  </div>`;
}

export function ConnectionText({ group = false } = {}) {
  return html`<div class="prose small muted">
    <p>${group ? t('conn.p1Group', 'The app runs locally on every computer, but it may use the internet. That is how your apps find each other – no server of your own, no account, no router settings:')
      : t('conn.p1', 'The app runs locally on both computers, but it may use the internet. That is how your two apps find each other – no server of your own, no account, no router settings:')}</p>
    <p><b>${t('conn.direct', 'Direct:')}</b> ${group ? t('conn.p2Group', 'All apps announce themselves with your room code on public Nostr relays. The relays only introduce you – after that your apps talk directly (WebRTC, like a video call).')
      : t('conn.p2', 'Both apps announce themselves with your room code on public Nostr relays. The relays only introduce you – after that your apps talk directly (WebRTC, like a video call).')}</p>
    <p><b>${t('conn.relay', 'Relay:')}</b> ${t('conn.p3', 'If a router blocks direct connections, data goes through a public MQTT server instead. It also keeps your latest state, so the others catch up even if you are not online at the same time.')}</p>
    <p>${t('conn.p4', 'Everything is encrypted with the key from your invite. Only tracker data travels – never ROMs or save files.')}</p>
  </div>`;
}

export function GuideView() {
  const { route, status } = useApp();
  const [tab, setTab] = useState(route.params.tab || 'start');
  return html`<div class="stack-l">
    <div class="topbar"><h1>${t('guide.title', 'Help')}</h1>
      <div class="row tight"><a class="btn small ghost" href="#/thanks"><${Icon} name="heart" size=${14} />${t('thanks.open', 'Thank you')}</a>
      <button class="btn small ghost" onClick=${() => dispatchEvent(new Event(WHATS_NEW_EVENT))}><${Icon} name="star" size=${14} />${t('wn.open', 'What’s new in 3.0')}</button></div></div>
    <div class="tabs" role="tablist" data-pad-tabs>
      ${[['start', t('guide.start', 'Getting started')], ['keys', t('guide.keys', 'Controls & shortcuts')], ['faq', t('guide.faq', 'Questions')]]
        .map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}
    </div>
    ${tab === 'start' && html`<section class="panel steps-list">
      ${[
        [t('guide.s1t', 'Add your games'), t('guide.s1', 'Library › Add files. ROMs (.gb, .gbc, .gba, .nds, .zip) and ROM-hack patches are copied into your library.')],
        [t('guide.s2t', 'Create a SoulLink'), t('guide.s2Nav', 'SoulLink › Host new SoulLink: pick a game (and optionally a hack), the number of players, a randomizer preset and the names. The app builds the games in seconds.')],
        [t('guide.s3t', 'Invite the others'), t('guide.s3Nav', 'Create a code for each player (or send the invite file). Everyone adds their own copy of the game and gets an identical game – no ROM ever has to be shared. Playing alone? Use Nuzlocke › New Nuzlocke instead and skip this step.')],
        [t('guide.s4t', 'Play'), t('guide.s4Nav', 'Press “Play” on the board or “Continue” in the overview. Your team, levels and HP are read live and appear on everyone’s board within a second. The game keeps running in the corner while you look elsewhere – the green light in the sidebar shows where it belongs.')],
        [t('guide.s5t', 'Live together'), t('guide.s5', 'If a linked Pokémon faints, the pair dies for both of you automatically. The board, the graveyard and the log keep the score.')],
      ].map(([title, text], i) => html`<div class="step"><span class="n">${i + 1}</span><div><h3>${title}</h3><p>${text}</p></div><span></span></div>`)}
      <div class="row guide-fs"><span class="small muted grow">${t('fs.guideHint', 'The checklist in the library walks you through these steps.')}</span><${ShowFirstStepsButton} className="btn small" /></div>
    </section>`}
    ${tab === 'keys' && html`<div class="grid-2">
      <section class="panel stack"><h2>${t('guide.shortcuts', 'Shortcuts while playing')}</h2>
        <div class="keys">${SHORTCUTS(status?.config?.controls).map(([k, l]) => html`<span class="kbd">${k}</span><span>${l}</span>`)}</div></section>
      <section class="panel stack"><h2>${t('guide.controls', 'Game controls')}</h2><${ControlsTable} />
        <p class="small faint">${t('guide.gamepad', 'Game controllers work too – just plug them in.')} ${t('guide.changeKeys', 'You can change the keys in Settings › Controls.')}</p></section>
    </div>`}
    ${tab === 'faq' && html`<section class="panel faq">
      <details open><summary>${t('faq.q1', 'How do we connect if the app runs locally?')}</summary><div class="stack" style="margin-top:10px"><${ConnectionFlow} /><${ConnectionText} /></div></details>
      <details><summary>${t('faq.q2', 'Can the app change my running game?')}</summary><div class="prose small muted" style="margin-top:8px">
        <p>${t('faq.a2a', 'It reads your game live – team, HP, levels, catches – but it never writes into the running game. That keeps your save safe.')}</p>
        <p>${t('faq.a2b', 'Between sessions it can edit your save file: dead Pokémon can be moved into PC box 18 (graveyard). This only works while the game is closed, and a backup is made first.')}</p></div></details>
      <details><summary>${t('faq.q3', 'Do we have to share ROM files?')}</summary><div class="prose small muted" style="margin-top:8px"><p>${t('faq.a3', 'No. Everyone uses their own copy. The invite only contains settings, seeds and the room key; the randomizer rebuilds the identical game from your own ROM, and the app checks the checksum.')}</p></div></details>
      <details><summary>${t('faq.q4', 'Which games are supported?')}</summary><div class="prose small muted" style="margin-top:8px"><p>${t('faq.a4', 'All main Pokémon games on Game Boy, Game Boy Color, Game Boy Advance and Nintendo DS (Gen 1–5) and their ROM hacks, plus X/Y to Ultra Sun/Ultra Moon on Nintendo 3DS (Gen 6–7). Live tracking works for the English and German releases; ROM hacks work when they keep the original memory layout.')}</p></div></details>
      <details><summary>${t('faq.q5', 'Can I use melonDS or mGBA instead?')}</summary><div class="prose small muted" style="margin-top:8px"><p>${t('faq.a5', 'Yes – choose them in the settings. mGBA streams live data through a small script you load once (Tools › Scripting). melonDS has no scripting, so it syncs after every in-game save.')}</p></div></details>
      <details><summary>${t('faq.q6', 'What if one of us is offline?')}</summary><div class="prose small muted" style="margin-top:8px"><p>${t('faq.a6', 'Nothing gets lost. Each app keeps its own copy and both merge automatically when you’re connected again.')}</p></div></details>
      <details><summary>${t('faq.q9', 'Can I bring an old save file, or take mine elsewhere?')}</summary><div class="prose small muted" style="margin-top:8px">
        <p>${t('faq.a9a', 'Yes. In the library, open the game › “Import a save file …” (in a run: the board’s Files menu). It takes .sav, .srm and DeSmuME’s .dsv from other emulators, flash carts and cartridge dumps, checks the size and – for the Pokémon games – whether it is a save of that game, and backs up the save it replaces first, with Undo.')}</p>
        <p>${t('faq.a9b', '“Save game file” gives you a plain .sav that other emulators and flash carts read. In a run, an imported save is logged for everyone, a SoulLink needs the host to allow it, and what it brings along doesn’t count for the run or your trophies. 3DS: a Checkpoint or JKSM backup goes into souldew’s own 3DS player once the game has saved there.')}</p></div></details>
      <details><summary>${t('faq.q7', 'Something doesn’t work right (music, live tracking)?')}</summary><div class="stack" style="margin-top:8px">
        <p class="prose small muted">${t('faq.a7', 'Right after it happens, save the diagnostics and send the file along with what you did. It holds what souldew read from the game and decided this session (song numbers, levels, what the turbo sound played) – no ROM, save file or invite.')}</p>
        <div class="row"><button class="btn small" onClick=${() => saveDiagnostics()}><${Icon} name="save" size=${14} />${t('play.diag', 'Save diagnostics')}</button></div></div></details>
      ${EDITION.presence && html`<details><summary>${t('faq.q8', 'Does souldew send anything about me?')}</summary><div class="stack" style="margin-top:8px">
        <div class="prose small muted"><p>${t('faq.a8a', 'No analytics, and an account only if you want one. By itself souldew sends an anonymous “playing now” heartbeat for the player count on the souldew Discord: while a game runs, once a minute, the system (GB, GBA, DS, 3DS), the mode (solo, Nuzlocke, SoulLink or Play together), the app version and a random id that is new for every game. No name, no game title, no run, no ROM – and the IP address isn’t stored. Besides that it only checks for updates. Signed in with a souldew account, your friends see that you’re online and what you play – Settings › Account › Privacy decides how much, and “Appear offline” shares none of it.')}</p>
          <p>${t('faq.a8b', 'Don’t want to be counted? Switch off “Count me in ‘playing now’” in Settings › Online – it stops right away.')}</p></div>
        <div class="row"><button class="btn small" onClick=${() => openExternal(currentLang() === 'de' ? LINKS.privacy : LINKS.privacyDocs)}><${Icon} name="external" size=${14} />${t('set.presenceMore', 'What exactly is sent')}</button></div></div></details>`}
    </section>`}
  </div>`;
}
