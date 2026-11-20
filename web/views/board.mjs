import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp, Sprite, Types, Modal, SpeciesPicker, Led, copy, download } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { speciesName, speciesFormName, gameById, hackById, gameTitle } from '../lib/data.mjs';
import { play } from '../lib/sound.mjs';
import {
  progression, pairState, setEncounter, markDead, revive, markExtraDead, party, live, counts, checks, feedList, feed, feedText, causeText, msg, areaName, joinNames,
  players as getPlayers, rules as getRules, levelCap, dupeOf, resumeRun, slotsOf, encounter, openAreas, runStats, isNuzlocke, logRulesChange,
  stampLivesChange, allowedRulesPatch, hostSlotOf, canEditRules, lives as getLives, livesFor, lastWildAt, genOfRun, shinyNote, beforeBalls,
} from '../lib/run.mjs';
import { writeHostRules } from '../lib/hostrules.mjs';
import { PartyPanel, PartyGrid, TeamColumns, unhatched } from './party.mjs';
import { MonDetail } from './mondetail.mjs';
import { RunFriendInvites } from './friends.mjs';
import { HostCode, PackVersionNote } from './invitecode.mjs';
import { RestartModal } from './restart.mjs';
import { KeepIntroItem } from './introsave.mjs';
import { SaveImportDialog } from './saveimport.mjs';
import { useStreamer } from '../lib/streamer.mjs';
import { NuzlockeRules, Choice, TypeHelpRule, LivesRule, SoulLinkRules, SoulLinkAuto, HostRulesNote, BallsRule, LinkRules, GiftRule, RaidRules } from './nuzrules.mjs';
import { ShareButton, HallOfFame } from './liveshare.mjs';
import { deathEvent } from '../lib/liveshare.mjs';
import { LinkButtons, LinkGroupButton, HeadToHead, linkUnavailable } from './linkplay.mjs';
import { RpsStart } from './rps.mjs';
import { RaidStart } from './raid.mjs';
import { RAID_SYSTEMS } from '/shared/live/raidhp.mjs';
import { PartnerTogether } from './together.mjs';


/** Is `slot` connected right now? Per player once the app tracks it (`onlineSlots`), before that "any partner". */
function slotOnline({ me, onlineSlots, partnerOnline }, slot) {
  if (slot === me) return true;
  return onlineSlots instanceof Set ? onlineSlots.has(slot) : !!partnerOnline;
}

/** Did `slot` ever show up in this run (connected, played or caught something)? */
function playerSeen(app, doc, slot, slots) {
  if (slotOnline(app, slot) || live(doc, slot)) return true;
  if (Object.keys(doc.scan('enc:')).some((k) => k.endsWith(`:${slot}`))) return true;
  // two players: any change made on another computer was the partner's
  return slots.length === 2 && Object.values(doc.entries || {}).some((e) => e?.by && e.by !== doc.by);
}

/** In-game play time { h, m } (or seconds) as "12:05". */
export function playTimeText(pt) {
  if (pt === null || pt === undefined) return '–';
  if (typeof pt === 'number') pt = { h: Math.floor(pt / 3600), m: Math.floor((pt % 3600) / 60) };
  if (typeof pt !== 'object') return String(pt);
  return `${pt.h ?? 0}:${String(pt.m ?? 0).padStart(2, '0')}`;
}

export function Board() {
  const { manifest, doc, docVersion, route, navigate, runData } = useApp();
  const [tab, setTab] = useState(route.params.tab || 'live');
  if (!doc) return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  const c = counts(doc, manifest);
  const warn = checks(doc, manifest, runData);
  const TABS = [
    ['live', t('board.live', 'Live')], ['routes', t('board.routes', 'Routes')], ['graves', t('board.graves', 'Graveyard')],
    ['log', t('board.log', 'Log')], ['stats', t('board.stats', 'Stats')], ['rules', t('board.rules', 'Rules')], ['spoiler', t('board.spoiler', 'Spoiler')],
  ];
  return html`<div data-v=${docVersion}>
    <${BoardHead} counts=${c} />
    <div class="tabbar"><div class="tabs" role="tablist" data-pad-tabs>
      ${TABS.map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}
        ${k === 'live' && warn.length > 0 ? html`<span class="count">${warn.length}</span>` : ''}${k === 'graves' && c.dead > 0 ? html`<span class="count">${c.dead}</span>` : ''}</button>`)}
      </div>
      <div class="row nowrap tabbar-end">
        <button class="btn small ghost" onClick=${() => navigate(isNuzlocke(manifest) ? 'nuzlocke' : 'soullink')}>${t('board.allRuns', 'All runs')}</button>
        <button class="btn small go" onClick=${() => navigate('play', { run: manifest.id })}><${Icon} name="play" size=${14} />${t('nav.play', 'Play')}</button></div>
    </div>
    ${tab === 'live' && html`<${LiveTab} warnings=${warn} />`}
    ${tab === 'routes' && html`<${RoutesTab} />`}
    ${tab === 'graves' && html`<${GravesTab} />`}
    ${tab === 'log' && html`<${LogTab} />`}
    ${tab === 'stats' && html`<${StatsTab} />`}
    ${tab === 'rules' && html`<${RulesTab} />`}
    ${tab === 'spoiler' && html`<${SpoilerTab} />`}
  </div>`;
}

function PlayerTag({ slot, right }) {
  const app = useApp();
  const { doc, manifest, me, linkStatus, session } = app;
  const names = getPlayers(doc, manifest);
  const l = live(doc, slot);
  const playingHere = slot === me && session?.target.runId === manifest.id;
  const fresh = l && Date.now() - (l.at || 0) < 15000;
  const online = slotOnline(app, slot);
  const cap = levelCap(doc, manifest, slot);
  // the lives rule with a pool per player: each player's own count (a shared pool is a stat of the head)
  const lv = getLives(doc, manifest)?.pool === 'player' ? livesFor(doc, manifest, slot) : null;
  return html`<div class=${`player-tag ${slot} ${right ? 'right' : ''}`} style=${`--acc:var(--${slot})`}>
    <${Led} on=${(online && fresh) || playingHere} color="green" blink=${online && !fresh && !playingHere} />
    <div class="stack-s" style="gap:2px;min-width:0">
      <span class="who" title=${names[slot].name}>${names[slot].name}${slot === me && !isNuzlocke(manifest) ? html` <span class="faint tiny">(${t('common.you', 'you')})</span>` : ''}</span>
      <span class="tiny muted">${l
        // each fact stays in one piece when the line wraps in a narrow head card ("cap 17", not "cap ⏎ 17")
        ? [l.source === 'live' ? t('board.liveNow', 'live') : t('board.fromSave', 'from save'), ago(l.at),
          l.badges !== undefined ? t('board.badges', '{n} badge|{n} badges', { n: l.badges, count: l.badges }) : null,
          cap.cap && getRules(doc, manifest).levelCaps ? t('board.cap', 'cap {n}', { n: cap.cap }) : null,
          lv ? html`<span class=${lv.low || lv.out ? 'lives-low' : ''}>${t('board.livesFact', '{n} life left|{n} lives left', { n: lv.left, count: lv.left })}</span>` : null].filter(Boolean)
          .map((x, i) => html`${i ? ' · ' : ''}<span class="fact">${x}</span>`)
        : playingHere ? t('board.playingNoTeam', 'playing – no team yet')
          : slot === me ? t('board.startPlaying', 'Start the game to go live')
            : online ? t('board.partnerOnline', 'online – no team yet') : linkStatus ? t('board.notPlaying', 'not playing yet') : t('rail.offline', 'Not connected')}</span>
      ${slot !== me && html`<${HeadToHead} slot=${slot} />`}
      ${slot !== me ? html`<${LinkButtons} slot=${slot} />` : html`<${LinkGroupButton} />`}
      ${slot !== me && html`<${PartnerTogether} slot=${slot} />`}
    </div>
  </div>`;
}

// ---- run status (shared doc key `run:status` = {state:'failed'|'won'|'ended', at, by, note, reason}) & invite ----
const endLabels = (solo) => ({
  failed: [t('end.failed', 'Failed'), solo ? t('end.failedHintSolo', 'Blacked out, or you give up.') : t('end.failedHint', 'Team wiped, or you give up.')],
  won: solo ? [t('end.wonSolo', 'Run won!'), t('end.wonSoloHint', 'Champion beaten – the Nuzlocke is won.')] : [t('end.won', 'We made it!'), t('end.wonHint', 'Champion beaten – the run is won.')],
});

/**
 * A fresh run's way to the first catch, one step at a time – the current step is lit and has the one action
 * that moves it on. Gone once everybody is in and the first catch is on the board (or the run ended).
 * Solo: no one to wait for, so it is just game → first catch.
 */
function RunSteps({ onInvite }) {
  const app = useApp();
  const { manifest, doc, me, navigate } = app;
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const solo = isNuzlocke(manifest);
  // host and joiners alike wait for every other player (a joiner's board names the host and the other joiners too)
  const waitFor = slots.filter((s) => s !== me);
  const others = joinNames(waitFor.map((s) => names[s]?.name).filter(Boolean));
  const allSeen = waitFor.every((s) => playerSeen(app, doc, s, slots));
  const missingNames = joinNames(waitFor.filter((s) => !playerSeen(app, doc, s, slots)).map((s) => names[s]?.name).filter(Boolean));
  const steps = [
    { id: 'made', done: true, label: t('steps.made', 'Run created') },
    ...(solo || !waitFor.length ? [] : [{ id: 'partner', done: allSeen,
      // done: who is there; still open: whom you still wait for (not everyone, as if they were connected already)
      label: !allSeen ? t('steps.connectWith', 'Connect with {names}', { names: missingNames || others })
        : waitFor.length > 1 ? t('steps.everyone', 'Everyone connected') : t('steps.partner', '{name} connected', { name: others }) }]),
    { id: 'play', done: !!live(doc, me), label: t('steps.play', 'Game started') },
    { id: 'catch', done: Object.keys(doc.scan('enc:')).length > 0, label: t('steps.catch', 'First catch') },
  ];
  const cur = steps.find((x) => !x.done);
  if (!cur || doc.get('run:status')) return null;
  const toPlay = () => navigate('play', { run: manifest.id });
  const next = {
    partner: manifest.imported && playerSeen(app, doc, 'p1', slots)
      ? { text: t('steps.waitOthers', 'Still missing: {names} – they join with their own invite code. Meanwhile you can already play.', { names: missingNames }), btn: t('nav.play', 'Play'), go: toPlay }
      : manifest.imported
      ? { text: t('steps.partnerWaitJoin', '{name} hosts this run – as soon as their app is open, you’re connected. Meanwhile you can already play.', { name: names.p1.name }), btn: t('nav.play', 'Play'), go: toPlay }
      : slots.length > 2
        ? { text: t('steps.playersInvite', 'Create a code for each player and tell it to them – their app joins once you allow it. You can play already, everything is merged later.'), btn: t('board.invitePlayer', 'Invite player'), go: onInvite }
        : { text: t('steps.partnerInvite', 'Create a code and tell it to {name} – their app joins once you allow it. You can play already, everything is merged later.', { name: others }), btn: t('board.invitePlayer', 'Invite player'), go: onInvite },
    play: { text: t('steps.playText', 'Start your game – your team appears here live as soon as you have Pokémon.'), btn: t('nav.play', 'Play'), go: toPlay },
    catch: {
      text: solo ? t('steps.catchTextSolo', 'Catch the first Pokémon of an area – it’s filed by itself. Only the first encounter of each area counts.')
        : slots.length > 2 ? t('steps.catchTextGroup', 'Catch the first Pokémon of an area – it’s filed by itself and the others’ catches there join its group.')
          : t('steps.catchText', 'Catch the first Pokémon of an area – it’s filed by itself and your partner’s catch there becomes its pair.'),
      btn: t('nav.play', 'Play'), go: toPlay,
    },
  }[cur.id];
  return html`<div class=${`run-steps panel n${steps.length}`} role="group" aria-label=${t('steps.title', 'Next step')}>
    <ol>${steps.map((x, i) => html`<li class=${x.done ? 'done' : x === cur ? 'cur' : ''} aria-current=${x === cur ? 'step' : undefined}>
      <span class="rs-dot">${x.done ? html`<${Icon} name="check" size=${10} />` : i + 1}</span><span>${x.label}</span></li>`)}</ol>
    <div class="row"><p class="small grow">${next.text}</p><button class="btn small primary" onClick=${next.go}>${next.btn}</button></div>
  </div>`;
}

/** The solo head's counters: caught / missed / open areas, alive / dead. */
function soloCounts(doc, manifest) {
  const s = runStats(doc, manifest, 'p1');
  return { caught: s.caught, missed: s.missed, open: openAreas(doc, manifest, 'p1').length, alive: s.alive, dead: s.dead };
}

function BoardHead({ counts: c }) {
  const app = useApp();
  const { manifest, doc, me } = app;
  const [modal, setModal] = useState(null);
  const g = gameById(manifest.game?.id);
  const h = manifest.game?.hackId ? hackById(manifest.game.hackId) : null;
  const st = doc.get('run:status', null);
  // "New attempt …" from the run list lands here (?restart=1): this run's live document is open now – the dialog opens for an ended run
  useEffect(() => {
    if (app.route?.params?.restart === undefined) return;
    if (st) setModal('restart');
    // drop the parameter without a history entry (Back must not open the dialog again)
    location.replace(`#/${app.route.route}?run=${encodeURIComponent(manifest.id)}`);
  }, [app.route?.params?.restart, manifest.id, !!st]);
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const solo = isNuzlocke(manifest);
  // HostCode hands out the next free slot by itself – the button stays while anybody is still missing
  const missing = slots.filter((s) => s !== me && !playerSeen(app, doc, s, slots));
  const invite = !solo && !manifest.imported && missing.length > 0;
  const stat = (cls, n, label) => html`<div class=${`stat center ${cls} ${n === 0 ? 'zero' : ''}`}><b>${n}</b><span>${label}</span></div>`;
  const sc = solo ? soloCounts(doc, manifest) : null;
  // the lives rule with one pool (solo, or shared by everyone): how many are left, next to the dead
  const shared = getLives(doc, manifest)?.pools.all;
  const livesStat = shared ? stat(`lives ${shared.low || shared.out ? 'low' : ''}`, shared.left, t('board.livesLeft', 'life left|lives left', { count: shared.left })) : null;
  const stats = solo
    ? html`<div class="stat-strip">
        ${stat('', sc.caught, t('board.caught', 'caught'))}${stat('', sc.missed, t('board.missed', 'missed'))}${stat('open', sc.open, t('board.openAreas', 'open areas'))}
        ${stat('alive', sc.alive, t('board.alive', 'alive'))}${stat('dead', sc.dead, t('board.dead', 'dead'))}${livesStat}</div>`
    : html`<div class="stat-strip" style="justify-content:center">
        ${stat('alive', c.linked, t('board.alive', 'alive'))}${stat('dead', c.dead, t('board.dead', 'dead'))}${stat('', c.waiting, t('board.waiting', 'waiting'))}${livesStat}</div>`;
  return html`<div class="stack" style="margin-bottom:6px">
    <div class="row"><h1 style="margin-right:auto">${manifest.name}</h1>
      <span class="small muted">${solo ? `${t('board.nuzlocke', 'Nuzlocke')} · ` : ''}${h ? h.name : g ? gameTitle(g) : manifest.game?.title || ''}${manifest.randomizer?.enabled ? ` · ${t('board.randomized', 'randomized')}` : ''}${shinyNote(manifest) ? ` · ${shinyNote(manifest)}` : ''}</span>
      ${invite && html`<button class="btn primary small" onClick=${() => setModal('invite')}><${Icon} name="user" size=${14} />${t('board.invitePlayer', 'Invite player')}</button>`}
      <${FilesMenu} />
      ${!st && html`<button class="btn small ghost" onClick=${() => setModal('end')}><${Icon} name="grave" size=${14} />${t('board.endRun', 'End run')}</button>`}</div>
    ${st && html`<div class=${`run-banner ${st.state}`} role="status">
      <${Icon} name=${st.state === 'won' ? 'heart' : st.state === 'failed' ? 'grave' : 'pause'} size=${28} />
      <div class="grow"><b>${{ failed: t('end.bannerFailed', 'This run has failed'), won: t('end.bannerWon', 'You made it – run won!'), ended: t('end.bannerEnded', 'This run has ended') }[st.state] || st.state}</b>
        <div class="small muted">${[endReason(st), names[st.by]?.name, ago(st.at), st.note].filter(Boolean).join(' · ')}</div>
        ${st.state === 'won' && html`<${HallOfFame} status=${st} compact />`}</div>
      ${st.state !== 'won' && html`<button class="btn primary small" onClick=${() => setModal('restart')}
        title=${solo ? t('end.restartHintSolo', 'A new attempt with the same settings and rules – with a new randomizer seed.') : t('end.restartHint', 'A new run with the same settings and a new randomizer seed – the others are invited.')}><${Icon} name="reset" size=${14} />${t('end.restart', 'New attempt …')}</button>`}
      <button class="btn small ghost" onClick=${() => resumeRun(doc, me)} title=${t('over.resumeHint', 'Undo: the run goes on as before, tracking resumes.')}>${t('end.resume', 'Play on after all')}</button>
    </div>`}
    <${RunSteps} onInvite=${() => setModal('invite')} />
    ${modal === 'end' && html`<${EndRunModal} onClose=${() => setModal(null)} />`}
    ${modal === 'restart' && html`<${RestartModal} r=${manifest} rules=${doc.get('rules')} onClose=${() => setModal(null)} />`}
    ${modal === 'invite' && html`<${Modal} open=${true} onClose=${() => setModal(null)}
      title=${missing.length === 1 ? t('board.inviteTitle', 'Invite {name}', { name: names[missing[0]].name }) : t('board.invitePlayers', 'Invite players')}
      footer=${html`<button class="btn ghost" onClick=${() => setModal(null)}>${t('common.close', 'Close')}</button>`}><${InviteBody} manifest=${manifest} heading=${false} /><//>`}
    ${solo
      ? html`<div class="board-head panel solo" style="padding:14px 18px"><${PlayerTag} slot="p1" />${stats}</div>`
      : slots.length === 2
        ? html`<div class="board-head panel" style="padding:14px 18px"><${PlayerTag} slot=${slots[0]} />${stats}<${PlayerTag} slot=${slots[1]} right /></div>`
        : html`<div class=${`board-head panel multi n${slots.length}`} style="padding:14px 18px">
            <div class="bh-players">${slots.map((s) => html`<${PlayerTag} slot=${s} key=${s} />`)}</div>${stats}</div>`}
  </div>`;
}

/** Why the run ended, when the app ended it (blackout / deathless rule). */
function endReason(st) {
  if (!st?.auto) return '';
  return { blackout: t('end.reasonBlackout', 'blackout'), deathless: t('end.reasonDeathless', 'deathless rule'), wipe: t('end.reasonWipe', 'team wiped'), lives: t('end.reasonLives', 'out of lives') }[st.reason] || '';
}

/**
 * Export: my ROM, my save (only once one exists), the invite – plain downloads from the server. Import: a save file from
 * elsewhere into my game (web/views/saveimport.mjs – once the game is built).
 */
function FilesMenu() {
  const { manifest, me } = useApp();
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [hasSave, setHasSave] = useState(false);
  const [intro, setIntro] = useState(null); // can this save become the intro save of the game (KeepIntroItem)
  const base = `/api/runs/${manifest.id}/download`;
  useEffect(() => {
    if (!open) return;
    let off = false;
    fetch(`${base}?what=save&slot=${me}`, { method: 'HEAD' }).then((r) => !off && setHasSave(r.ok)).catch(() => !off && setHasSave(false));
    api.get(`/api/runs/${manifest.id}/intro/${me}`).then((r) => !off && setIntro(r), () => !off && setIntro(null));
    return () => { off = true; };
  }, [open, manifest.id, me]);
  const nothing = !manifest.outputs?.[me] && !hasSave && isNuzlocke(manifest);
  // (closes when the pointer or the keyboard focus leaves it; `onfocusout` in lowercase – Preact only maps the camel-case
  // names the DOM has an on… property for, and focusin / focusout have none)
  return html`<div class="files-menu" onMouseLeave=${() => setOpen(false)} onKeyDown=${(e) => e.key === 'Escape' && setOpen(false)}
    onfocusout=${(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
    <button class="btn small ghost" aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name="save" size=${14} />${t('board.files', 'Files')}</button>
    ${open && html`<div class="run-menu" role="menu">
      ${manifest.outputs?.[me] && html`<a role="menuitem" href=${`${base}?what=rom&slot=${me}`} download>${t('board.fileRom', 'Save my game (ROM)')}</a>`}
      ${hasSave && html`<a role="menuitem" href=${`${base}?what=save&slot=${me}`} download>${t('board.fileSave', 'Save my save file')}</a>`}
      <${KeepIntroItem} manifest=${manifest} me=${me} state=${intro} onDone=${() => setOpen(false)} />
      ${manifest.outputs?.[me] && html`<button role="menuitem" onClick=${() => { setOpen(false); setImporting(true); }}
        title=${t('simp.openHint', 'Replace this game’s save with one from another emulator, a flash cart or an older backup – the current one is backed up first.')}>${t('simp.open', 'Import a save file …')}</button>`}
      ${!isNuzlocke(manifest) && html`<a role="menuitem" href=${`${base}?what=pack`} download>${t('board.filePack', 'Save invite')}</a>`}
      ${nothing && html`<span class="small faint" style="padding:7px 10px;white-space:nowrap">${t('board.filesNone', 'Nothing to save yet.')}</span>`}
    </div>`}
    ${importing && html`<${SaveImportDialog} target=${{ runId: manifest.id, slot: me, system: manifest.game?.system, label: manifest.name }}
      onClose=${() => setImporting(false)} />`}
  </div>`;
}

function EndRunModal({ onClose }) {
  const { doc, me, manifest } = useApp();
  const [state, setState] = useState('failed');
  const [note, setNote] = useState('');
  const solo = isNuzlocke(manifest);
  const L = endLabels(solo);
  const save = () => {
    doc.set('run:status', { state, at: Date.now(), by: me, note: note.trim() || null });
    const m = { failed: msg('end.failedFeed', 'Run failed'), won: solo ? msg('end.wonSolo', 'Run won!') : msg('end.won', 'We made it!') }[state];
    feed(doc, { type: 'run', slot: me, msg: m, note: note.trim() || null, text: `${L[state][0]}${note.trim() ? ` – ${note.trim()}` : ''}` });
    onClose();
  };
  return html`<${Modal} open=${true} onClose=${onClose} title=${t('end.title', 'How did the run end?')}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class=${`btn ${state === 'won' ? 'primary' : 'danger'}`} onClick=${save}>${t('end.confirm', 'End run')}</button>`}>
    <div class="preset-list" role="radiogroup">
      ${Object.entries(L).map(([k, [name, desc]]) => html`<button class=${`preset ${state === k ? 'on' : ''}`} role="radio" aria-checked=${state === k} onClick=${() => setState(k)}>
        <span class="radio"></span><span><b>${name}</b></span><span class="desc">${desc}</span></button>`)}
    </div>
    <label class="field"><span>${t('end.note', 'Note (optional)')}</span><input type="text" maxLength="120" value=${note} onInput=${(e) => setNote(e.target.value)} placeholder=${t('end.notePh', 'e.g. Whitney’s Miltank, again')} /></label>
    <p class="small muted">${solo ? t('end.textSolo', 'Nothing is deleted. Afterwards you can start a new attempt with the same settings – or undo it and play on.')
      : slotsOf(manifest).length > 2 ? t('end.textGroup', 'Everyone sees this right away. Nothing is deleted. Afterwards you can start a new attempt with the same settings – or undo it and play on.')
        : t('end.text', 'Your partner sees this right away. Nothing is deleted. Afterwards you can start a new attempt with the same settings – or undo it and play on.')}</p>
  <//>`;
}

/** Invite: a 6-digit code first (HostCode – it picks the next free player slot), the file / clipboard as the fallback. */
export function InviteBody({ manifest, heading = true, autoFriends = [] }) {
  const { toast } = useApp();
  const json = JSON.stringify(manifest.pack, null, 2);
  const others = slotsOf(manifest).slice(1).map((s) => manifest.players?.[s]?.name).filter(Boolean);
  const many = others.length > 1;
  const partner = joinNames(others) || t('common.partner', 'Partner');
  return html`<div class="stack">
    ${heading && html`<h2>${t('invite.title', 'Now send {name} the invite', { name: partner })}</h2>`}
    <p class="muted">${many
      ? t('invite.codeWhatGroup', 'Easiest: create a code for each player and tell it to them. Their app fetches the settings and the key to your room – no game data – once you allow it.')
      : t('invite.codeWhat', 'Easiest: create a code and tell it to {name}. Their app fetches the settings and the key to your room – no game data – once you allow it.', { name: partner })}</p>
    <${RunFriendInvites} manifest=${manifest} autoFriends=${autoFriends} />
    <${PackVersionNote} manifest=${manifest} />
    <${HostCode} manifest=${manifest} />
    <details class="group"><summary>${t('invite.fileInstead', 'Or use an invite file')}</summary><div class="stack" style="padding:4px 14px 12px">
    <p class="muted">${t('invite.what', 'The invite is one small file (.soullink.json). It holds the settings and the key to your room – no game data.')}</p>
    <ol class="small muted steps">
      <li>${t('invite.s1', 'Save the invite and send it to {name} – e.g. via Discord, WhatsApp or mail. Or copy it and paste it into the chat.', { name: partner })}</li>
      <li>${many ? t('invite.s2Group', 'Each of them opens souldew › SoulLink › “Join with code” and opens the file. Their own copy of the game must be in their library.')
        : t('invite.s2', '{name} opens souldew › SoulLink › “Join with code” and opens the file. Their own copy of the game must be in their library.', { name: partner })}</li>
      <li>${many ? t('invite.s3Group', 'Their apps build the identical game and connect you all automatically.') : t('invite.s3', 'Their app builds the identical game and connects you both automatically.')}</li>
    </ol>
    <div class="row">
      <button class="btn" onClick=${() => download(`soullink-invite-${manifest.id}.soullink.json`, json)}><${Icon} name="save" size=${16} />${t('new.saveInvite', 'Save invite')}</button>
      <button class="btn ghost" onClick=${() => { copy(json); toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: t('new.inviteCopied', 'The invite is on your clipboard.') }); }}>${t('common.copy', 'Copy')}</button>
    </div>
    <p class="small faint">${many ? t('new.inviteSecretGroup', 'The invite contains the key to your room – share it only with your fellow players. It contains no game data.')
      : t('new.inviteSecret', 'The invite contains the key to your room – share it only with the players of this run. It contains no game data.')}</p>
    </div></details>
  </div>`;
}

// One SoulLink pair as two party-menu panels (your mon | partner's mon) joined by a strand. Three or four players:
// the area with its strand on top, everybody's panel below it in the same columns as the head.
function GroupRow({ area, mons, leads, onPick }) {
  const { doc, manifest, runData } = useApp();
  const slots = slotsOf(manifest);
  const st = area ? pairState(doc, area, slots).state : 'empty';
  const dead = st === 'dead';
  const side = (slot) => {
    const mon = mons[slot];
    return html`<${PartyPanel} mon=${mon} gen=${runData.gen} accent=${`var(--${slot})`} lead=${!!mon && leads[slot] === mon} dead=${dead}
      types=${mon && !mon.maxHp ? runData.types(mon.species, slot) : null} placeholder=${t('board.noMon', 'not in the team')} onPick=${onPick ? (m) => onPick(m, slot) : null} />`;
  };
  const label = area ? areaName(doc, manifest, area) : t('board.unlinked', 'unassigned');
  const strand = html`<svg viewBox="0 0 120 26" preserveAspectRatio="none" aria-hidden="true"><path class="strand" vector-effect="non-scaling-stroke" d="M1 13 C 30 2, 50 24, 60 13 S 92 2, 119 13" /></svg>`;
  if (slots.length === 2) {
    return html`<div class=${`pair-row ${dead ? 'dead' : st === 'linked' ? 'alive' : ''}`}>
      ${side(slots[0])}<div class="pair-knot">${strand}<span class="area" title=${label}>${label}</span></div>${side(slots[1])}
    </div>`;
  }
  return html`<div class=${`group-row ${dead ? 'dead' : st === 'linked' ? 'alive' : st}`}>
    <div class="group-knot">${strand}<span class="area" title=${label}>${label}</span>${area && html`<span class="group-st">${stateLabel(st, slots.length)}</span>`}</div>
    <div class=${`group-mons n${slots.length}`}>${slots.map((s) => html`<div class="group-cell" key=${s}>${side(s)}</div>`)}</div>
  </div>`;
}

/** Short state word of an area's group (solo: the encounter's own state). */
function stateLabel(state, n) {
  if (n === 1) return { empty: t('routes.open', 'open'), linked: t('routes.caught', 'caught'), failed: t('routes.failed', 'missed'), dead: t('routes.dead', 'dead') }[state] || '';
  return { empty: t('routes.open', 'open'), waiting: t('routes.waitingShort', 'waiting'), linked: t('routes.linked', 'linked'), failed: t('routes.failed', 'missed'), dead: t('routes.dead', 'dead') }[state] || '';
}

const LIVE_VIEW_KEY = 'sl-board-live-view';

const WARN_ORDER = { error: 0, warn: 1, info: 2 };
const WARN_SHOWN = 4;

/** Rule warnings, worst first. With four players a dozen lines pile up – the first few show, the rest fold away. */
function Warnings({ list }) {
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => (WARN_ORDER[a.level] ?? 1) - (WARN_ORDER[b.level] ?? 1));
  const shown = all || sorted.length <= WARN_SHOWN + 1 ? sorted : sorted.slice(0, WARN_SHOWN);
  const hidden = sorted.length - shown.length;
  return html`<div class="warnings">
    ${shown.map((w) => html`<div class=${`warning ${w.level === 'error' ? 'error' : w.level === 'info' ? 'info' : ''}`}>${w.text}</div>`)}
    ${(hidden > 0 || all) && sorted.length > WARN_SHOWN + 1 && html`<button class="btn small ghost warnings-more" aria-expanded=${all} onClick=${() => setAll(!all)}>
      ${all ? t('board.warnLess', 'Show fewer') : t('board.warnMore', '{n} more notes', { n: hidden })}</button>`}
  </div>`;
}

function LiveTab({ warnings }) {
  const { doc, manifest, runData, me } = useApp();
  const [view, setView] = useState(() => { try { return localStorage.getItem(LIVE_VIEW_KEY) || 'pairs'; } catch { return 'pairs'; } });
  const pickView = (v) => { setView(v); try { localStorage.setItem(LIVE_VIEW_KEY, v); } catch { /* per-viewer convenience only */ } };
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const solo = isNuzlocke(manifest);
  // the Pokémon whose details are open (its key: the live data of the next snapshot shows, not the one clicked)
  const [detail, setDetail] = useState(null);
  const pick = (mon, slot) => setDetail({ slot, key: mon.key || null, mon });
  const fromLive = (slot) => {
    const l = live(doc, slot);
    // (an egg stays out until it hatches – then it is a Pokémon of the team like any other)
    if (l?.party?.length) return l.party.filter((m) => !unhatched(m));
    return party(doc, slot).map((area) => {
      const e = doc.get(`enc:${area}:${slot}`);
      return e ? { area, species: e.species, nick: e.nickname, level: e.level, shiny: e.shiny } : null;
    }).filter(Boolean);
  };
  const teams = Object.fromEntries(slots.map((s) => [s, fromLive(s)]));
  const leads = Object.fromEntries(slots.map((s) => [s, teams[s][0]]));
  const areas = [];
  for (const s of slots) for (const m of teams[s]) if (m.area && !areas.includes(m.area)) areas.push(m.area);
  const rows = areas.map((area) => ({ area, mons: Object.fromEntries(slots.map((s) => [s, teams[s].find((m) => m.area === area)])) }));
  const unassigned = slots.flatMap((s) => teams[s].filter((m) => !m.area).map((m) => ({ mons: { [s]: m } })));
  const deadPair = (m) => !!m.area && pairState(doc, m.area, slots).state === 'dead';
  const areaOf = (m) => (m.area ? areaName(doc, manifest, m.area) : t('board.unlinked', 'unassigned'));
  const who = (s) => html`<div class=${`pair-who who-${s}`}><span title=${names[s].name}>${names[s].name}</span><span class="tiny faint">${teams[s].length}/6</span></div>`;
  const pairs = html`<div class="pairboard">
    ${slots.length === 2
      ? html`<div class="pair-row pair-head">${who(slots[0])}<span class="pair-gap"></span>${who(slots[1])}</div>`
      : html`<div class=${`group-mons group-head n${slots.length}`}>${slots.map((s) => who(s))}</div>`}
    ${rows.map((r) => html`<${GroupRow} key=${r.area} ...${r} leads=${leads} onPick=${pick} />`)}
    ${unassigned.map((r, i) => html`<${GroupRow} key=${`u${i}`} ...${r} leads=${leads} onPick=${pick} />`)}
  </div>`;
  const teamsView = html`<${TeamColumns} slots=${slots} teams=${teams} names=${Object.fromEntries(slots.map((s) => [s, names[s].name]))} gen=${runData.gen} me=${me}
    typesOf=${(id, s) => runData.types(id, s)} caption=${areaOf} isDead=${deadPair} onPick=${pick} />`;
  const empty = rows.length + unassigned.length === 0;
  const shown = detail && ((detail.key && teams[detail.slot]?.find((m) => m.key === detail.key)) || (!detail.key && detail.mon));
  return html`<div class="stack-l">
    <${Inbox} />
    <${Warnings} list=${warnings} />
    ${empty
      ? html`<div class="panel empty-state"><${Icon} name="play" size=${56} /><h2>${t('board.emptyTitle', 'No team yet')}</h2>
          <p class="muted prose">${solo ? t('board.emptyTextSolo', 'Start the game – as soon as you have Pokémon, your team appears here live.')
            : slots.length > 2 ? t('board.emptyTextGroup', 'Start the game – as soon as you have Pokémon, every team appears here live, group by group.')
              : t('board.emptyText', 'Start the game – as soon as you have Pokémon, both teams appear here live, pair by pair.')}</p></div>`
      : solo ? html`<${SoloTeam} team=${teams.p1} areaOf=${areaOf} isDead=${deadPair} onPick=${(m) => pick(m, 'p1')} />`
        : html`<section class="stack">
          <div class="row live-view-bar"><span class="small faint">${view === 'teams'
            ? slots.length > 2 ? t('board.viewTeamsHintGroup', 'Every team as in the game menu') : t('board.viewTeamsHint', 'Both teams as in the game menu')
            : slots.length > 2 ? t('board.viewGroupsHint', 'Linked Pokémon, one row per area') : t('board.viewPairsHint', 'Linked Pokémon side by side')}</span><span class="spacer"></span>
            <div class="seg" role="group" aria-label=${t('board.viewLabel', 'Team view')}>
              <button class=${view !== 'teams' ? 'on' : ''} aria-pressed=${view !== 'teams'} onClick=${() => pickView('pairs')}>${slots.length > 2 ? t('board.viewGroups', 'Groups') : t('board.viewPairs', 'Pairs')}</button>
              <button class=${view === 'teams' ? 'on' : ''} aria-pressed=${view === 'teams'} onClick=${() => pickView('teams')}>${t('board.viewTeams', 'Teams')}</button>
            </div></div>
          ${view === 'teams' ? teamsView : pairs}
        </section>`}
    ${shown && html`<${MonDetail} mon=${shown} gen=${runData.gen} slot=${detail.slot} owner=${solo ? '' : names[detail.slot]?.name || ''}
      caption=${areaOf(shown)} onClose=${() => setDetail(null)} />`}
  </div>`;
}

/** Solo live view: the team as in the game menu, with the level cap, the next boss and the box next to it. */
function SoloTeam({ team, areaOf, isDead, onPick }) {
  const { doc, manifest, runData } = useApp();
  const r = getRules(doc, manifest);
  const { cap, boss } = levelCap(doc, manifest, 'p1');
  const l = live(doc, 'p1');
  const over = cap && r.levelCaps ? team.filter((m) => m.level > cap).length : 0;
  return html`<section class="solo-team">
    <${PartyGrid} party=${team} gen=${runData.gen} accent="var(--p1)" label=${t('play.yourTeam', 'Your team')}
      typesOf=${(id) => runData.types(id, 'p1')} isDead=${isDead} onPick=${onPick}
      caption=${(m) => `${areaOf(m)}${cap && r.levelCaps && m.level > cap ? ` · ${t('solo.overCap', 'over the cap')}` : ''}`} />
    <aside class="solo-side panel">
      ${cap && r.levelCaps ? html`<div class=${`solo-cap ${over ? 'over' : ''}`}><span class="small muted">${t('cap.title', 'Level cap')}</span>
        <b class="num">${cap}</b><span class="small">${boss?.name || ''}</span></div>` : null}
      ${over > 0 && html`<p class="warning error">${t('solo.overCapN', '{n} Pokémon over the cap – box them before the boss.|{n} Pokémon over the cap – box them before the boss.', { n: over, count: over })}</p>`}
      <dl class="solo-facts">
        <dt>${t('solo.box', 'In the box')}</dt><dd class="num">${l?.boxCount ?? '–'}</dd>
        <dt>${t('solo.badges', 'Badges')}</dt><dd class="num">${l?.badges ?? '–'}</dd>
        <dt>${t('solo.playTime', 'Play time')}</dt><dd class="num">${playTimeText(l?.playTime)}</dd>
      </dl>
    </aside>
  </section>`;
}

function Inbox() {
  const { inbox, setInbox, doc, manifest, me, runData } = useApp();
  const [assign, setAssign] = useState({});
  // Drop handled entries right away instead of waiting for the next snapshot.
  const dropItem = (key) => setInbox?.((x) => ({ ...x, inbox: (x.inbox || []).filter((it) => it.mon.key !== key) }));
  const dropAlert = (a) => setInbox?.((x) => ({ ...x, alerts: (x.alerts || []).filter((y) => y !== a && !(y.area === a.area && y.type === a.type)) }));
  const items = inbox.inbox || [];
  const alerts = inbox.alerts || [];
  if (!items.length && !alerts.length) return null;
  const n = slotsOf(manifest).length;
  const r = getRules(doc, manifest);
  const areas = progression(doc, manifest).filter((x) => x.kind === 'area');
  const diesLabel = n === 1 ? t('inbox.monDies', 'It died') : n > 2 ? t('inbox.groupDies', 'Group dies') : t('inbox.pairDies', 'Pair dies');
  return html`<section class="inbox">
    <div class="panel-head" style="margin-bottom:4px"><h3>${t('inbox.title', 'From your game')}</h3><p>${t('inbox.hint', 'Decide what to do with these')}</p></div>
    ${alerts.map((a) => html`<div class="inbox-item">
      <${Sprite} id=${a.mon?.species || a.enc?.species} gen=${runData.gen} />
      <div>${a.type === 'fainted'
        ? html`<b>${t('inbox.fainted', '{name} has 0 HP', { name: a.mon.nickname || speciesName(a.mon.species) })}</b><div class="small muted">${areaName(doc, manifest, a.area)}</div>`
        : html`<b>${t('inbox.missing', '{name} is gone from your game', { name: speciesName(a.enc.species) })}</b><div class="small muted">${t('inbox.missingHint', '{area} – released or traded?', { area: areaName(doc, manifest, a.area) })}</div>`}</div>
      <button class="btn danger small" onClick=${() => { markDead(doc, manifest, a.area, { slot: me, cause: a.type === 'fainted' ? msg('inbox.causeFainted', 'fainted') : msg('inbox.causeReleased', 'released'), level: a.mon?.level ?? null }); dropAlert(a); }}>${diesLabel}</button>
    </div>`)}
    ${items.map((it) => {
      const sel = assign[it.mon.key] ?? (it.guess && !it.occupied && it.reason !== 'dupe' ? it.guess : '');
      const bonusShiny = it.mon.shiny && r.shinyClause;
      // a gift (egg, trade, event) is a free extra when the rules say so – kept like a bonus shiny
      const freeGift = !bonusShiny && ['egg', 'special'].includes(it.reason) && r.gifts === 'free';
      const keep = bonusShiny ? 'shiny' : freeGift ? 'gift' : null;
      return html`<div class="inbox-item">
        <${Sprite} id=${it.mon.species} shiny=${it.mon.shiny} gen=${runData.gen} />
        <div><b>${it.mon.nickname || speciesName(it.mon.species)}</b> <span class="small muted">${t('common.lv', 'Lv')} ${it.mon.level || it.mon.metLevel || '?'}${it.mon.shiny ? ` · ${t('common.shiny', 'shiny')}` : ''}</span>
          <div class="small muted">${it.where ? t('inbox.caughtAt', 'Caught at {where}', { where: it.where }) : t('inbox.noLocation', 'This game doesn’t record where it was caught')}${it.reason === 'occupied' ? ` – ${t('inbox.occupied', 'you already have an encounter there')}` : ''}${it.reason === 'egg' ? ` – ${t('inbox.egg', 'hatched from an egg: pick the area it counts for')}` : ''}${it.reason === 'special' ? ` – ${t('inbox.special', 'a trade or gift, not a route encounter: pick the area it counts for')}` : ''}${it.reason === 'dupe' ? ` – ${it.dupeMissed ? t('inbox.dupeMissed', 'dupes clause: this evolution line already got away once ({area})', { area: areaName(doc, manifest, it.dupeArea) }) : t('inbox.dupe', 'dupes clause: this evolution line is already caught ({area})', { area: areaName(doc, manifest, it.dupeArea) })}` : ''}</div></div>
        <div class="row" style="gap:6px">
          <select value=${sel} onChange=${(e) => setAssign({ ...assign, [it.mon.key]: e.target.value })} aria-label=${t('inbox.chooseArea', 'Choose area')}>
            <option value="">${t('inbox.chooseArea', 'Choose area')} …</option>
            ${areas.map((a) => html`<option value=${a.key} disabled=${!!doc.get(`enc:${a.key}:${me}`)}>${a.name}</option>`)}
          </select>
          <button class="btn small" disabled=${!sel} onClick=${() => { setEncounter(doc, manifest, sel, me, { outcome: 'caught', species: it.mon.species, nickname: it.mon.nickname, level: it.mon.level || it.mon.metLevel, metLevel: it.mon.metLevel ?? null, shiny: it.mon.shiny, key: it.mon.key, ...(it.mon.form ? { form: it.mon.form } : {}) }); dropItem(it.mon.key); }}>${t('inbox.assign', 'Assign')}</button>
          <button class="btn small ghost" onClick=${() => { doc.set(`${keep ? 'extra' : 'ign'}:${me}:${it.mon.key}`, { species: it.mon.species, nickname: it.mon.nickname || null, level: it.mon.level || null, shiny: !!it.mon.shiny, ...(keep ? { reason: keep } : {}), at: Date.now() }); dropItem(it.mon.key); }}>
            ${bonusShiny ? t('inbox.keepShiny', 'Keep as bonus shiny') : freeGift ? t('inbox.keepGift', 'Keep as free gift') : t('inbox.ignore', 'Ignore')}</button>
        </div>
      </div>`;
    })}
  </section>`;
}

function RouteThread() {
  return html`<div class="route-thread" aria-hidden="true"><svg viewBox="0 0 70 24"><path class="s l" d="M5 12 C 15 4, 25 20, 35 12" /><path class="s r" d="M35 12 C 45 4, 55 20, 65 12" /></svg></div>`;
}

function MonButton({ enc, slot, right, onClick, label }) {
  const { runData } = useApp();
  const cls = `mon ${right ? 'right' : ''} acc`;
  const style = `--acc:var(--${slot})`;
  const aria = label ? { 'aria-label': label } : {};
  if (!enc) return html`<button class=${cls} style=${style} onClick=${onClick} ...${aria}><span class="faint small">${t('routes.add', '+ add encounter')}</span></button>`;
  if (enc.outcome === 'missed') return html`<button class=${cls} style=${style} onClick=${onClick} ...${aria}><span class="muted small">${t('routes.missed', 'missed')}${enc.species ? ` · ${speciesName(enc.species)}` : ''}</span></button>`;
  return html`<button class=${cls} style=${style} onClick=${onClick} ...${aria}>
    <${Sprite} id=${enc.species} form=${enc.form} shiny=${enc.shiny} size=${40} gen=${runData.gen} />
    <span style="min-width:0"><b style="font-weight:500">${enc.nickname || speciesName(enc.species)}</b>
      <span class="tiny faint" style="display:block">${speciesFormName(enc.species, enc.form, runData.gen)}${enc.level ? ` · ${t('common.lv', 'Lv')}\u00a0${enc.level}` : ''}</span>
      <${Types} types=${runData.types(enc.species, slot, enc.form || 0)} /></span>
  </button>`;
}

/** Solo status chip of an area: open / caught / missed / dead / bonus – always with an icon, never colour alone. */
function StatusChip({ status }) {
  const [icon, label] = {
    open: ['plus', t('routes.open', 'open')], caught: ['check', t('routes.caught', 'caught')], missed: ['close', t('routes.failed', 'missed')],
    dead: ['grave', t('routes.dead', 'dead')], bonus: ['heart', t('routes.bonus', 'bonus')],
  }[status];
  return html`<span class=${`st-chip ${status}`}><${Icon} name=${icon} size=${10} />${label}</span>`;
}

function RoutesTab() {
  const { doc, manifest, me } = useApp();
  const [editing, setEditing] = useState(null);
  const [dying, setDying] = useState(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const solo = isNuzlocke(manifest);
  const n = slots.length;
  const prog = progression(doc, manifest);
  const cap = levelCap(doc, manifest, me);
  const bosses = doc.scan('boss:');
  const ql = q.toLowerCase();
  const head = solo
    ? html`<span>${t('routes.area', 'Area')}</span><span>${t('routes.pokemon', 'Pokémon')}</span><span>${t('routes.status', 'Status')}</span><span></span>`
    : n === 2
      ? html`<span>${t('routes.area', 'Area')}</span><span class="who-p1">${names.p1.name}</span><span></span><span class="who-p2" style="text-align:right">${names.p2.name}</span><span></span>`
      : html`<span>${t('routes.area', 'Area')}</span>${slots.map((s) => html`<span class=${`who-${s}`}>${names[s].name}</span>`)}<span></span>`;
  const extras = solo ? Object.entries(doc.scan('extra:p1:')).filter(([, x]) => x?.species) : [];
  return html`<div class="stack">
    <div class="row">
      <label class="check"><input type="checkbox" checked=${onlyOpen} onChange=${(e) => setOnlyOpen(e.target.checked)} /><span>${solo ? t('routes.onlyOpenAreas', 'Only open areas') : t('routes.onlyOpen', 'Only open routes')}</span></label>
      <input type="search" placeholder=${t('routes.search', 'Search route or Pokémon')} aria-label=${t('routes.search', 'Search route or Pokémon')} value=${q} onInput=${(e) => setQ(e.target.value)} />
      <span class="spacer"></span>
      <button class="btn small" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${14} />${t('routes.addArea', 'Add area')}</button>
    </div>
    <div class=${`routes-wrap ${solo ? 'solo' : `n${n}`}`}>
    <div class="route route-head" aria-hidden="true">${head}</div>
    <div class="routes">
      ${prog.map((item) => {
        if (item.kind === 'boss') {
          if (onlyOpen || q) return null;
          const beaten = !!bosses[item.key];
          return html`<div class=${`boss ${beaten ? 'beaten' : ''} ${cap.boss?.key === item.key ? 'next' : ''}`}>
            <strong>${item.name}</strong><span>${t('routes.cap', 'Level cap {n}', { n: item.cap })}</span><span class="spacer"></span>
            <button class="btn small ghost" onClick=${() => { doc.set(`boss:${item.key}`, beaten ? null : { at: Date.now(), by: me }); if (!beaten) feed(doc, { type: 'boss', slot: me, msg: msg('feed.boss', '{boss} defeated!', { boss: { area: item.key } }), text: t('feed.boss', '{boss} defeated!', { boss: item.name }) }); }}>
              ${beaten ? t('routes.beaten', 'defeated') : t('routes.markBeaten', 'mark as defeated')}</button>
          </div>`;
        }
        const st = pairState(doc, item.key, slots);
        const encs = slots.map((s) => st.encs[s]);
        if (onlyOpen && !['empty', 'waiting'].includes(st.state)) return null;
        if (q && !item.name.toLowerCase().includes(ql) && !encs.some((e) => speciesName(e?.species).toLowerCase().includes(ql))) return null;
        const settled = st.state === 'dead' && (!st.pair?.diedAt || Date.now() - st.pair.diedAt > 4000);
        // who it fell to beats the generic "X fainted" when the battle was seen
        const why = st.state === 'dead' ? (st.pair?.killer?.species ? t('routes.killedBy', 'fell to {foe}', { foe: killerText(st.pair.killer) }) : causeText(doc, manifest, st.pair?.cause)) : '';
        const cause = why ? ` · ${why}` : '';
        const waitingFor = slots.filter((s) => !st.encs[s]).map((s) => names[s].name);
        const stateText = {
          empty: t('routes.open', 'open'),
          waiting: n > 2 ? t('routes.waitingFor', 'waiting for {names}', { names: joinNames(waitingFor) }) : t('routes.waiting', 'waiting for partner'),
          linked: t('routes.linked', 'linked'), failed: t('routes.failed', 'missed'), dead: t('routes.dead', 'dead'),
        }[st.state];
        const actions = html`<div class="row route-act" style="justify-content:flex-end">
          ${st.state === 'dead'
            ? html`<button class="btn small ghost" onClick=${() => revive(doc, item.key, manifest)}>${t('routes.undo', 'undo')}</button>`
            : encs.some((e) => e?.outcome === 'caught') && html`<button class="btn small ghost" onClick=${() => setDying(item.key)}>${t('routes.died', 'died')}</button>`}
        </div>`;
        const edit = (s) => () => setEditing({ area: item.key, slot: s });
        if (solo) {
          const e = st.encs.p1;
          const status = st.state === 'dead' ? 'dead' : !e ? 'open' : e.outcome === 'missed' ? 'missed' : 'caught';
          return html`<div class=${`route solo ${st.state} ${settled ? 'settled' : ''}`} key=${item.key}>
            <div class="area-name"><strong>${item.name}</strong>${cause && html`<span>${cause.slice(3)}</span>`}</div>
            <${MonButton} enc=${e} slot="p1" onClick=${edit('p1')} />
            <${StatusChip} status=${status} />
            ${actions}
          </div>`;
        }
        return html`<div class=${`route ${n > 2 ? 'grp' : ''} ${st.state} ${settled ? 'settled' : ''}`} key=${item.key}>
          <div class="area-name"><strong>${item.name}</strong><span>${stateText}${cause}</span></div>
          ${n === 2
            ? html`<${MonButton} enc=${st.encs.p1} slot="p1" onClick=${edit('p1')} /><${RouteThread} /><${MonButton} enc=${st.encs.p2} slot="p2" right onClick=${edit('p2')} />`
            : slots.map((s) => html`<${MonButton} key=${s} enc=${st.encs[s]} slot=${s} onClick=${edit(s)} label=${`${names[s].name}: ${st.encs[s]?.outcome === 'missed' ? t('routes.missed', 'missed') : st.encs[s]?.species ? speciesName(st.encs[s].species) : t('routes.add', '+ add encounter')}`} />`)}
          ${actions}
        </div>`;
      })}
      ${extras.length > 0 && !onlyOpen && html`<div class="boss bonus-head"><strong>${t('routes.bonusTitle', 'Bonus Pokémon')}</strong><span>${t('routes.bonusHint', 'Shinies and free gifts – they don’t use up an area')}</span></div>`}
      ${!onlyOpen && extras.filter(([, x]) => !q || speciesName(x.species).toLowerCase().includes(ql)).map(([key, x]) => html`<div class=${`route solo ${x.dead ? 'dead settled' : 'linked'}`} key=${`x-${key}`}>
        <div class="area-name"><strong>${{ shiny: t('routes.bonusShiny', 'Shiny'), gift: t('routes.bonusGift', 'Gift'), static: t('routes.bonusStatic', 'Static encounter') }[x.reason] || t('routes.bonus', 'bonus')}</strong></div>
        <${MonButton} enc=${{ outcome: 'caught', ...x }} slot="p1" onClick=${() => {}} />
        <${StatusChip} status=${x.dead ? 'dead' : 'bonus'} />
        <div class="row route-act" style="justify-content:flex-end"><button class="btn small ghost" onClick=${() => markExtraDead(doc, manifest, 'p1', key, !x.dead)}>
          ${x.dead ? t('routes.undo', 'undo') : t('routes.died', 'died')}</button></div>
      </div>`)}
    </div>
    </div>
    ${editing && html`<${EncounterModal} ...${editing} onClose=${() => setEditing(null)} />`}
    ${dying && html`<${DeathModal} area=${dying} onClose=${() => setDying(null)} />`}
    ${adding && html`<${AddArea} onClose=${() => setAdding(false)} />`}
  </div>`;
}

function EncounterModal({ area, slot, onClose }) {
  const { doc, manifest, me, runData } = useApp();
  const existing = doc.get(`enc:${area}:${slot}`, null);
  const [outcome, setOutcome] = useState(existing?.outcome || 'caught');
  const [species, setSpecies] = useState(existing?.species || null);
  const [nickname, setNickname] = useState(existing?.nickname || '');
  const [level, setLevel] = useState(existing?.level || '');
  const [shiny, setShiny] = useState(!!existing?.shiny);
  const names = getPlayers(doc, manifest);
  const solo = isNuzlocke(manifest);
  const r = getRules(doc, manifest);
  // "Missed": the wild Pokémon this player last fought here, as the battle reader saw it – filled in, never required
  const seen = existing ? null : lastWildAt(doc, manifest, genOfRun(manifest, runData), area, slot);
  const pick = (o) => {
    setOutcome(o);
    if (o === 'missed' && !species && seen) setSpecies(seen.species);
  };
  const dupe = species ? dupeOf(doc, manifest, runData, species, slot, area) : null;
  const save = () => {
    setEncounter(doc, manifest, area, slot, { outcome, species, nickname: outcome === 'caught' ? nickname.trim() : '', level: outcome === 'caught' ? Number(level) || null : null, shiny: outcome === 'caught' && shiny, key: (outcome === 'caught' && existing?.key) || null }, { by: me });
    onClose();
  };
  const dupeText = dupe && (dupe.missed
    ? solo ? t('enc.dupeMissedSolo', 'Dupes clause: this one already got away from you ({area}) – keep looking.', { area: areaName(doc, manifest, dupe.area) })
      : t('enc.dupeMissed', 'Dupes clause: this evolution line already got away from {name} ({area}).', { name: names[dupe.slot].name, area: areaName(doc, manifest, dupe.area) })
    : solo ? t('enc.dupeSolo', 'Dupes clause: you already caught this one ({area}) – keep looking.', { area: areaName(doc, manifest, dupe.area) })
      : t('enc.dupe', 'Dupes clause: {name} already owns this evolution line ({area}).', { name: names[dupe.slot].name, area: areaName(doc, manifest, dupe.area) }));
  const shown = species && html`<div class="row"><${Sprite} id=${species} shiny=${outcome === 'caught' && shiny} size=${64} gen=${runData.gen} /><div><h3>${speciesName(species)}</h3><${Types} types=${runData.types(species, slot)} />
    ${outcome === 'missed' && seen && species === seen.species && html`<p class="tiny faint">${t('enc.missedSeen', 'From the last battle here – souldew saw it live.')}</p>`}</div></div>`;
  return html`<${Modal} open=${true} onClose=${onClose} title=${solo ? areaName(doc, manifest, area) : `${areaName(doc, manifest, area)} · ${names[slot].name}`}
    footer=${html`${existing && html`<button class="btn danger" onClick=${() => { setEncounter(doc, manifest, area, slot, null, { by: me }); onClose(); }}>${t('common.delete', 'Delete')}</button>`}<span class="spacer"></span>
      <button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn primary" disabled=${outcome === 'caught' && !species} onClick=${save}>${t('common.save', 'Save')}</button>`}>
    ${slot !== me && html`<p class="warning info">${slotsOf(manifest).length > 2
      ? t('enc.otherHint', 'This is {name}’s slot – usually their game fills it in automatically.', { name: names[slot].name })
      : t('enc.partnerHint', 'This is your partner’s slot – usually their game fills it in automatically.')}</p>`}
    <div class="seg">
      <button class=${outcome === 'caught' ? 'on' : ''} aria-pressed=${outcome === 'caught'} onClick=${() => pick('caught')}>${t('enc.caught', 'Caught')}</button>
      <button class=${outcome === 'missed' ? 'on' : ''} aria-pressed=${outcome === 'missed'} onClick=${() => pick('missed')}>${t('enc.missed', 'Missed (fled / fainted)')}</button>
    </div>
    ${outcome === 'missed' && html`<div class="stack">
      <p class="small muted">${r.missedDupes && r.dupes !== 'off'
        ? t('enc.missedWhichDupes', 'Which Pokémon got away? Optional – with it, its evolution line counts as a dupe.')
        : t('enc.missedWhich', 'Which Pokémon got away? Optional.')}</p>
      <${SpeciesPicker} value=${species} onChange=${setSpecies} clearable maxId=${runData.maxSpecies()} extra=${runData.ownSpecies()} typesOf=${(id) => runData.types(id, slot)} />
      ${shown}
      ${dupeText && html`<div class="warning">${dupeText}</div>`}
    </div>`}
    ${outcome === 'caught' && html`<div class="stack">
      <${SpeciesPicker} value=${species} onChange=${setSpecies} autoFocus=${!existing} maxId=${runData.maxSpecies()} extra=${runData.ownSpecies()} typesOf=${(id) => runData.types(id, slot)} />
      ${shown}
      ${dupeText && html`<div class="warning">${dupeText}</div>`}
      <div class="grid-3">
        <label class="field"><span>${t('enc.nickname', 'Nickname')}</span><input type="text" maxLength="12" value=${nickname} onInput=${(e) => setNickname(e.target.value)} /></label>
        <label class="field"><span>${t('enc.level', 'Level')}</span><input type="number" min="1" max="100" value=${level} onInput=${(e) => setLevel(e.target.value)} /></label>
        <label class="check" style="align-self:end"><input type="checkbox" checked=${shiny} onChange=${(e) => setShiny(e.target.checked)} /><span>${t('common.shiny', 'shiny')}</span></label>
      </div>
    </div>`}
  <//>`;
}

function DeathModal({ area, onClose }) {
  const { doc, manifest, me, runData, status } = useApp();
  const [cause, setCause] = useState('');
  const slots = slotsOf(manifest);
  const st = pairState(doc, area, slots);
  const n = slots.length;
  const mons = slots.map((s) => st.encs[s]).filter((e) => e?.outcome === 'caught' && e.species);
  const an = areaName(doc, manifest, area);
  // lives per player: the life comes off the player whose Pokémon fell – ask whose it was (it may not be yours).
  // Only caught Pokémon can fall: a missed encounter keeps its species for the log, but it was never in a team.
  // One holder: that's who fell (shared/lives.mjs deathsIn decides a death without `by` the same way).
  const holders = slots.filter((s) => st.encs[s]?.outcome === 'caught' && st.encs[s].species);
  const askWho = getLives(doc, manifest)?.pool === 'player' && holders.length > 1;
  const [fell, setFell] = useState(holders.includes(me) ? me : holders[0] || me);
  const by = askWho ? fell : holders.length === 1 ? holders[0] : me;
  const names = getPlayers(doc, manifest);
  return html`<${Modal} open=${true} onClose=${onClose}
    title=${n === 1 ? t('death.titleSolo', '{area}: the Pokémon dies', { area: an }) : n > 2 ? t('death.titleGroup', '{area}: the group dies', { area: an }) : t('death.title', '{area}: the pair dies', { area: an })}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn danger" onClick=${() => { markDead(doc, manifest, area, { slot: by, cause: cause.trim(), level: st.encs[by]?.level ?? null }); play('death', status?.config?.sounds !== false); onClose(); }}>
        ${n === 1 ? t('death.confirmSolo', 'Send it to the graveyard') : n > 2 ? t('death.confirmGroup', 'Send all of them to the graveyard') : t('death.confirm', 'Send both to the graveyard')}</button>`}>
    <div class="row" style="justify-content:center;gap:28px">${mons.map((e) => html`<div class="stack-s center"><${Sprite} id=${e.species} size=${72} gen=${runData.gen} /><span class="small">${e.nickname || speciesName(e.species)}</span></div>`)}</div>
    <p class="muted">${n === 1 ? t('death.textSolo', 'This Pokémon is dead from now on – it may not be used again.')
      : n > 2 ? t('death.textGroup', 'Every Pokémon of this group is dead from now on. The others are notified right away.')
        : t('death.text', 'Both Pokémon of this pair are dead from now on. Your partner is notified right away.')}</p>
    ${askWho && html`<div class="stack-s"><b class="small">${t('death.whoFell', 'Whose Pokémon fell?')}</b>
      <${Choice} label=${t('death.whoFell', 'Whose Pokémon fell?')} value=${fell} onChange=${setFell} options=${holders.map((s) => [s, names[s].name])} />
      <span class="tiny faint">${t('death.whoFellHint', 'It costs that player a life – the others’ Pokémon only go with it.')}</span></div>`}
    <label class="field"><span>${t('death.cause', 'What happened? (optional)')}</span><input type="text" value=${cause} onInput=${(e) => setCause(e.target.value)} placeholder=${t('death.causePh', 'e.g. critical hit from Whitney’s Miltank')} /></label>
  <//>`;
}

function AddArea({ onClose }) {
  const { doc, manifest } = useApp();
  const [name, setName] = useState('');
  const [after, setAfter] = useState('');
  const areas = progression(doc, manifest).filter((x) => x.kind === 'area');
  return html`<${Modal} open=${true} onClose=${onClose} title=${t('routes.addArea', 'Add area')}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn primary" disabled=${!name.trim()} onClick=${() => { doc.set(`area:custom-${Date.now().toString(36)}`, { name: name.trim(), after: after || null, order: Date.now() }); onClose(); }}>${t('common.add', 'Add')}</button>`}>
    <p class="small muted">${t('routes.addAreaHint', 'For gifts, cave sections or house rules.')}</p>
    <label class="field"><span>${t('routes.areaName', 'Name')}</span><input type="text" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
    <label class="field"><span>${t('routes.after', 'Insert after')}</span><select value=${after} onChange=${(e) => setAfter(e.target.value)}>
      <option value="">${t('routes.atEnd', 'At the end')}</option>${areas.map((a) => html`<option value=${a.key}>${a.name}</option>`)}</select></label>
  <//>`;
}

/** The opponent a Pokémon fell to: "Miltank Lv 19 (trainer)". */
function killerText(k) {
  if (!k?.species) return '';
  const kind = k.kind === 'trainer' ? t('graves.trainer', 'trainer') : k.kind === 'wild' ? t('graves.wild', 'wild') : '';
  return `${speciesName(k.species)}${k.level ? ` ${t('common.lv', 'Lv')}\u00a0${k.level}` : ''}${kind ? ` (${kind})` : ''}`; // (no break inside "Lv 19")
}

function GravesTab() {
  const { doc, manifest, runData, toast, me } = useApp();
  const slots = slotsOf(manifest);
  const solo = isNuzlocke(manifest);
  const dead = progression(doc, manifest).filter((a) => a.kind === 'area' && pairState(doc, a.key, slots).state === 'dead');
  const [busy, setBusy] = useState(false);
  const l = live(doc, me);
  const deadInTeam = (l?.party || []).filter((m) => m.area && pairState(doc, m.area, slots).state === 'dead');
  return html`<div class="stack-l">
    ${deadInTeam.length > 0 && manifest.watch?.watching && manifest.watch.graveyard !== false && html`<section class="panel stack">
      <h3>${t('graves.cleanTitle', 'Dead Pokémon are still in your team')}</h3>
      <p class="small muted">${t('graves.cleanText', 'Close the game first (save in-game). Then the app moves them into PC box 18 in your save file – with a backup.')}</p>
      <div><button class="btn danger" disabled=${busy} onClick=${async () => {
        setBusy(true);
        try {
          const r = await api.post(`/api/runs/${manifest.id}/graveyard`, { keys: deadInTeam.map((m) => m.key) });
          toast({ kind: 'ok', title: t('graves.moved', 'Moved to the graveyard box'), text: t('graves.movedText', '{n} Pokémon is now in box {box}.|{n} Pokémon are now in box {box}.', { n: r.moved.length, box: r.box, count: r.moved.length }) });
        } catch (e) {
          toast({ kind: 'death', title: t('graves.failed', 'Not possible right now'), text: e.message });
        }
        setBusy(false);
      }}>${t('graves.move', 'Move them to box 18')}</button></div>
    </section>`}
    ${dead.length === 0
      ? html`<div class="panel empty-state"><${Icon} name="grave" size=${56} /><h2>${t('graves.empty', 'Nobody here yet')}</h2><p class="muted">${t('graves.emptyText', 'May it stay that way.')}</p></div>`
      : html`<div class=${`graves ${slots.length > 2 ? 'wide' : ''}`}>${dead.map((a) => {
        const st = pairState(doc, a.key, slots);
        const mons = slots.map((s) => [s, st.encs[s]]).filter(([, e]) => e?.outcome === 'caught' && e.species);
        const p = st.pair || {};
        const cause = causeText(doc, manifest, p.cause);
        const lv = p.level ?? (solo ? mons[0]?.[1]?.level : null);
        return html`<div class="grave">
          <div class="row" style="gap:2px;justify-content:center">${mons.map(([s, e]) => html`<span class="grave-mon" style=${`--acc:var(--${s})`} title=${speciesName(e.species)}><${Sprite} id=${e.species} size=${48} gen=${runData.gen} /></span>`)}</div>
          <b class="small">${joinNames(mons.map(([, e]) => e.nickname || speciesName(e.species)))}</b>
          <span class="rip">${a.name}</span>
          ${solo && lv && html`<span class="tiny muted">${t('graves.levelAtDeath', 'died at Lv {lv}', { lv })}</span>`}
          ${p.killer?.species && html`<span class="grave-killer tiny"><${Sprite} id=${p.killer.species} size=${24} gen=${runData.gen} />${killerText(p.killer)}</span>`}
          ${cause && !p.killer?.species && html`<span class="tiny faint">${cause}</span>`}
          ${p.diedAt && html`<time class="tiny faint">${ago(p.diedAt)}</time>`}
          <${ShareButton} event=${deathEvent(doc, manifest, a.key)} small />
        </div>`;
      })}</div>`}
  </div>`;
}

function LogTab() {
  const { doc, manifest, me, link, onlineSlots } = useApp();
  const [text, setText] = useState('');
  const names = getPlayers(doc, manifest);
  const solo = isNuzlocke(manifest);
  const items = feedList(doc, 120);
  return html`<section class="panel">
    <form class="row" style="margin-bottom:10px" onSubmit=${(e) => { e.preventDefault(); if (text.trim()) { feed(doc, { type: 'chat', slot: me, text: text.trim() }); setText(''); } }}>
      <input type="text" class="grow" placeholder=${solo ? t('log.placeholderSolo', 'Note for the log …') : t('log.placeholder', 'Message to the log …')} value=${text} onInput=${(e) => setText(e.target.value)} />
      <button class="btn">${solo ? t('log.add', 'Add') : t('log.send', 'Send')}</button>
      ${!solo && html`<button type="button" class="btn ghost" disabled=${!link} onClick=${() => link?.sendMessage({ type: 'ping', text: t('log.pingText', 'Hey, take a look!') })}>${t('log.ping', 'Ping')}</button>`}
      ${!solo && link && html`<${RpsStart} online=${onlineSlots} />`}
      ${!solo && html`<${RaidStart} online=${onlineSlots} />`}
    </form>
    <div class="feed" style="max-height:none">
      ${items.length === 0 && html`<p class="small faint">${solo ? t('log.emptySolo', 'Catches, deaths, badges and your notes show up here.')
        : slotsOf(manifest).length > 2 ? t('log.emptyGroup', 'Catches, deaths, badges and messages from all of you show up here.')
          : t('log.empty', 'Catches, deaths, badges and messages from both of you show up here.')}</p>`}
      ${items.map((f) => html`<div class=${`feed-item ${f.type}`}><span class="k"></span>
        <span>${f.slot && !solo && html`<span class=${`who-${f.slot}`}>${names[f.slot]?.name}</span> `}${feedText(doc, manifest, f)}</span><time>${ago(f.at)}</time></div>`)}
    </div>
  </section>`;
}

/** A player's run in numbers (runStats): catch rate, deaths per boss segment, deadliest opponents, longest survivor. */
function StatsTab() {
  const { doc, manifest, me, runData } = useApp();
  const slots = slotsOf(manifest);
  const [slot, setSlot] = useState(slots.includes(me) ? me : slots[0]);
  const names = getPlayers(doc, manifest);
  const s = runStats(doc, manifest, slot);
  const rate = s.catchRate === null ? null : Math.round(s.catchRate * 100);
  const maxDeaths = Math.max(1, ...s.deathsBySegment.map((x) => x.deaths));
  const maxKills = Math.max(1, ...s.deadliest.map((x) => x.kills));
  const surv = s.longestSurvivor;
  const survEnc = surv && encounter(doc, surv.area, slot);
  const tile = (cls, value, label, sub) => html`<div class=${`kpi ${cls}`}><span class="kpi-k">${label}</span><b class="num">${value ?? '–'}</b>${sub && html`<span class="kpi-sub">${sub}</span>`}</div>`;
  return html`<div class="stack-l stats-tab">
    ${slots.length > 1 && html`<div class="seg" role="group" aria-label=${t('stats.player', 'Player')}>${slots.map((x) => html`<button class=${slot === x ? 'on' : ''} aria-pressed=${slot === x} onClick=${() => setSlot(x)}>${names[x].name}</button>`)}</div>`}
    <div class="kpis">
      <div class="kpi rate"><span class="kpi-k">${t('stats.catchRate', 'Catch rate')}</span><b class="num">${rate === null ? '–' : `${rate}%`}</b>
        <span class="meter" aria-hidden="true"><i style=${`width:${rate ?? 0}%`}></i></span>
        <span class="kpi-sub">${t('stats.caughtMissed', '{caught} caught · {missed} missed', { caught: s.caught, missed: s.missed })}</span></div>
      ${tile('alive', s.alive, t('stats.alive', 'Alive'))}
      ${tile('dead', s.dead, t('stats.dead', 'Dead'))}
      ${tile('', s.open, t('stats.open', 'Open areas'))}
      ${tile('', s.bossesBeaten, t('stats.bosses', 'Bosses beaten'))}
      ${tile('', s.attempt ? `#${s.attempt}` : null, t('stats.attempt', 'Attempt'))}
      ${tile('', s.playTime ? playTimeText(s.playTime) : null, t('stats.playTime', 'Play time'))}
    </div>
    <div class="grid-2 stats-panels">
      <section class="panel stack-s">
        <h3>${t('stats.segments', 'Deaths per boss segment')}</h3>
        <p class="tiny faint">${t('stats.segmentsHint', 'Counted on the way to each boss – where the run hurts most.')}</p>
        ${s.deathsBySegment.length === 0
          ? html`<p class="small muted">${t('stats.noDeaths', 'No deaths yet.')}</p>`
          : html`<ul class="bars" role="list">${s.deathsBySegment.map((x) => html`<li>
              <span class="bar-k" title=${x.name || ''}>${x.boss === null ? t('stats.segUnknown', 'unknown') : t('stats.segBefore', 'before {boss}', { boss: x.name || x.boss })}</span>
              <span class="bar" aria-hidden="true"><i style=${`width:${(x.deaths / maxDeaths) * 100}%`}></i></span><b class="num">${x.deaths}</b></li>`)}</ul>`}
      </section>
      <section class="panel stack-s">
        <h3>${t('stats.deadliest', 'Deadliest opponents')}</h3>
        ${s.deadliest.length === 0
          ? html`<p class="small muted">${t('stats.noKillers', 'Nobody has a kill yet.')}</p>`
          : html`<ul class="bars killers" role="list">${s.deadliest.slice(0, 6).map((x) => html`<li>
              <span class="bar-k"><${Sprite} id=${x.species} size=${28} gen=${runData.gen} />${speciesName(x.species)}</span>
              <span class="bar" aria-hidden="true"><i style=${`width:${(x.kills / maxKills) * 100}%`}></i></span>
              <b class="num" title=${t('stats.kills', '{n} kill|{n} kills', { n: x.kills, count: x.kills })}>${x.kills}</b></li>`)}</ul>`}
      </section>
      <section class="panel stack-s">
        <h3>${t('stats.survivor', 'Longest survivor')}</h3>
        ${surv
          ? html`<div class="row survivor"><${Sprite} id=${surv.species} shiny=${survEnc?.shiny} size=${64} gen=${runData.gen} />
              <div class="stack-s" style="gap:2px"><b>${survEnc?.nickname || speciesName(surv.species)}</b>
                <span class="small muted">${areaName(doc, manifest, surv.area)}</span>
                <span class="small">${t('stats.levelsGained', '+{n} level since the catch|+{n} levels since the catch', { n: surv.levels, count: surv.levels })}</span></div></div>`
          : html`<p class="small muted">${t('stats.noSurvivor', 'Shows up once a catch has gained levels.')}</p>`}
      </section>
    </div>
  </div>`;
}

export function RulesTab() {
  const { doc, manifest, toast, me } = useApp();
  const r = getRules(doc, manifest);
  const n = slotsOf(manifest).length;
  const solo = isNuzlocke(manifest);
  // a SoulLink's rules are the host's (shared/hostrules.mjs): set on the computer that created the run, read-only elsewhere
  const mine = canEditRules(manifest);
  const locked = !mine;
  const hostName = getPlayers(doc, manifest)[hostSlotOf(manifest)]?.name;
  // The webhook is a secret of this computer: kept in the local config, never in the shared rules.
  const [hook, setHook] = useState('');
  useEffect(() => {
    let live = true;
    api.get(`/api/runs/${manifest.id}/discord`).then((d) => live && setHook(d?.webhook || '')).catch(() => {});
    return () => {
      live = false;
    };
  }, [manifest.id]);
  const saveHook = async () => {
    try {
      await api.put(`/api/runs/${manifest.id}/discord`, { webhook: hook.trim() });
      toast({ kind: 'ok', title: t('common.saved', 'Saved'), text: t('rules.discordSaved', 'Discord webhook saved.') });
    } catch (e) {
      toast({ kind: 'death', title: 'Discord', text: e.message });
    }
  };
  // Only what was set is stored – the mode's defaults (rules(doc, manifest)) fill in the rest. Every change goes to the
  // log for everyone (cheats, lives, … – lib/run.mjs logRulesChange).
  const set = async (asked) => {
    const patch = allowedRulesPatch(asked, manifest); // the host's call (null on another player's computer)
    if (!patch) return;
    const next = stampLivesChange(doc, doc.get('rules'), { ...(doc.get('rules') || {}), ...patch });
    delete next.discordWebhook;
    if (next.preset === null) delete next.preset;
    if (solo) {
      doc.set('rules', next);
      api.post(`/api/runs/${manifest.id}/meta`, { rules: next }).catch(() => {});
    } else {
      // signed by this computer's server, then written – every other app takes it only with that signature
      try {
        await writeHostRules(doc, manifest, next, me);
      } catch (e) {
        toast({ kind: 'death', title: t('rules.notSaved', 'Rules not changed'), text: e.code === 'notHost' ? t('rules.notHostHere', 'Only the computer that created this run can change its rules.') : e.message });
        return;
      }
    }
    logRulesChange(doc, manifest, me, r, getRules(doc, manifest));
  };
  const blackoutText = { party: t('rules.b4Solo', 'If your whole team faints (blackout), the run is over.'), box: t('rules.b4SoloBox', 'The run is over once no living Pokémon is left – in the team or in the box.'), off: t('rules.b4SoloOff', 'A blackout doesn’t end the run – you decide when it’s over.') }[r.blackout];
  return html`<div class="stack-l">
    ${!solo && html`<${HostRulesNote} host=${hostName} mine=${mine} players=${n} />`}
    <section class="panel stack">
      <h2>${t('rules.basics', 'The basics')}</h2>
      <ul class="small muted">${solo
        ? html`<li>${t('rules.b1Solo', 'Only the first Pokémon you meet in each area may be caught. If it flees or faints, the area is used up.')}</li>
          <li>${t('rules.b2Solo', 'A Pokémon that faints is dead – it goes to the graveyard and is never used again.')}</li>
          <li>${blackoutText}</li>`
        : n > 2
          ? html`<li>${t('rules.b1Group', 'Only the first Pokémon you meet in each area counts. All players’ catches on an area are linked into a group.')}</li>
            <li>${t('rules.b2Group', 'If one Pokémon faints, every Pokémon linked to it dies too – the whole group goes to the graveyard.')}</li>
            <li>${t('rules.b3Group', 'A group is always in the team together or in the box together.')}</li>
            <li>${t('rules.b4Group', 'If one of you blacks out, the run is over for everyone.')}</li>`
          : html`<li>${t('rules.b1', 'Only the first Pokémon you meet in each area counts. Both catches of an area form a pair.')}</li>
            <li>${t('rules.b2', 'If one Pokémon faints, its partner dies too – both go to the graveyard.')}</li>
            <li>${t('rules.b3', 'A pair is always in the team together or in the box together.')}</li>
            <li>${t('rules.b4', 'If one of you blacks out, the run is over for both.')}</li>`}
      </ul>
    </section>
    ${solo
      ? html`<${NuzlockeRules} value=${r} onChange=${set} />`
      : html`<section class="panel stack">
      <h2>${t('rules.options', 'Options')}</h2>
      <${SoulLinkRules} value=${r} onChange=${set} players=${n} disabled=${locked} />
      ${!linkUnavailable(manifest.game) && html`<${LinkRules} value=${r} onChange=${set} disabled=${locked} />`}
      ${RAID_SYSTEMS.includes(manifest.game?.system) && html`<${RaidRules} value=${r} onChange=${set} disabled=${locked} />`}
      <${GiftRule} value=${r} onChange=${set} disabled=${locked} />
    </section>`}
    <section class="panel stack">
      <h2>${t('rules.ballsTitle', 'When the rules start')}</h2>
      <${BallsRule} value=${r.startAtBalls} players=${n} onChange=${(v) => set({ startAtBalls: v })} disabled=${locked} />
      ${r.startAtBalls && html`<${BallsStatus} />`}
    </section>
    <section class="panel stack">
      <h2>${t('lives.title', 'Lives')}</h2>
      <${LivesRule} value=${r.lives} pool=${r.livesPool} players=${n} onChange=${set} left=${getLives(doc, manifest)} ended=${!!doc.get('run:status')} disabled=${locked}
        names=${Object.fromEntries(Object.entries(getPlayers(doc, manifest)).map(([s, p]) => [s, p.name]))} />
    </section>
    <section class="panel stack">
      <h2>${t('rules.battleHelp', 'Battle help')}</h2>
      <${TypeHelpRule} value=${r.typeHelp} solo=${solo} locked=${locked} hostName=${hostName} note=${false} onChange=${(v) => set({ typeHelp: v })} />
    </section>
    <section class="panel stack">
      <h2>${t('rules.auto', 'Automatic')}</h2>
      <${SoulLinkAuto} value=${r} onChange=${set} players=${n} solo=${solo} disabled=${locked} />
      <div class="stack-s"><h3>Discord</h3><p class="small muted">${t('rules.discordHint', 'Optional: post catches and deaths to your Discord channel (Channel › Integrations › Webhook).')}</p>
        <div class="row"><input type="url" class="grow sm-secret" value=${hook} placeholder="https://discord.com/api/webhooks/…" onInput=${(e) => setHook(e.target.value)} />
          <button class="btn" onClick=${saveHook}>${t('common.save', 'Save')}</button></div>
        <p class="tiny faint">${solo ? t('rules.discordLocalSolo', 'Stays on this computer.') : n > 2 ? t('rules.discordLocalGroup', 'Stays on this computer – the others can add their own.') : t('rules.discordLocal', 'Stays on this computer – your partner can add their own.')}</p></div>
    </section>
  </div>`;
}

/** Whose rules have started ("nothing counts before your first Poké Balls"): each player by their own bag. */
function BallsStatus() {
  const { doc, manifest, me } = useApp();
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const line = (s) => {
    const waiting = beforeBalls(doc, manifest, s);
    const name = names[s]?.name || s.toUpperCase();
    if (slots.length === 1) return waiting ? t('rules.ballsWaitingSolo', 'Waiting for your first Poké Balls – nothing counts yet.') : t('rules.ballsStartedSolo', 'Your rules have started.');
    return waiting
      ? s === me ? t('rules.ballsWaitingMine', 'You: waiting for your first Poké Balls – your own Pokémon don’t die yet.') : t('rules.ballsWaitingOther', '{name}: waiting for the first Poké Balls.', { name })
      : s === me ? t('rules.ballsStartedMine', 'You: your rules have started.') : t('rules.ballsStartedOther', '{name}: rules have started.', { name });
  };
  return html`<ul class="small muted">${slots.map((s) => html`<li key=${s}>${line(s)}</li>`)}</ul>`;
}

function SpoilerTab() {
  const { manifest, runData, me, doc } = useApp();
  const [shown, setShown] = useState(false);
  const [slot, setSlot] = useState(me);
  const [q, setQ] = useState('');
  const streamer = useStreamer();
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  if (!manifest.randomizer?.enabled) return html`<div class="panel empty-state"><p class="muted">${t('spoiler.none', 'This run is not randomized.')}</p></div>`;
  // on stream the spoilers stay shut, even when they were open before
  if (streamer) return html`<div class="panel empty-state"><${Icon} name="lock" size=${56} /><h2>${t('spoiler.streamer', 'Hidden in streamer mode')}</h2>
    <p class="muted prose">${t('spoiler.streamerText', 'Your viewers would see what the randomizer rolled. Switch streamer mode off on the Stream page to look.')}</p></div>`;
  if (!shown) return html`<div class="panel empty-state"><${Icon} name="help" size=${56} /><h2>${t('spoiler.title', 'What the randomizer rolled')}</h2>
    <p class="muted prose">${t('spoiler.text', 'Wild Pokémon per route and the starters. Once you look, you no longer play blind.')}</p>
    <button class="btn danger" onClick=${() => setShown(true)}>${t('spoiler.show', 'Show spoilers')}</button></div>`;
  // (the randomizer numbers alternate forms its own way: runData.uprMon)
  const up = (id) => runData.uprMon(id, slot);
  const tables = runData.encounterTables(slot).filter((tb) => !q || tb.area.toLowerCase().includes(q.toLowerCase()) || tb.sets.some((s) => s.slots.some(([id]) => up(id).name.toLowerCase().includes(q.toLowerCase()))));
  return html`<div class="stack">
    <div class="row">${slots.length > 1 && html`<div class="seg">${slots.map((s) => html`<button class=${slot === s ? 'on' : ''} aria-pressed=${slot === s} onClick=${() => setSlot(s)}>${names[s].name}</button>`)}</div>`}
      <span class="spacer"></span><input type="search" value=${q} placeholder=${t('routes.search', 'Search route or Pokémon')} aria-label=${t('routes.search', 'Search route or Pokémon')} onInput=${(e) => setQ(e.target.value)} /></div>
    ${!runData.romData[slot] && html`<p class="warning info">${slots.length > 2 && slot !== me
      ? t('spoiler.otherDeviceName', 'This game was built on {name}’s computer – no spoiler data here.', { name: names[slot]?.name || '' })
      : t('spoiler.otherDevice', 'This game was built on the other computer – no spoiler data here.')}</p>`}
    ${runData.romData[slot] && html`<section class="panel"><div class="panel-head"><h3>${t('spoiler.starters', 'Starters')}</h3></div>
      <div class="row">${runData.starters(slot).map(up).map((m) => html`<div class="row" style="gap:6px"><${Sprite} id=${m.species} form=${m.form} size=${56} gen=${runData.gen} /><div><b>${m.name}</b><br /><${Types} types=${runData.types(m.species, slot, m.form)} /></div></div>`)}</div></section>`}
    <section class="panel"><table class="data"><tbody>
      ${tables.map((tb) => html`<tr><td class="spoiler-area"><b>${tb.area}</b></td><td>${tb.sets.map((s) => {
        const uniq = [...new Map(s.slots.map((x) => [x[0], x])).values()];
        return html`<div class="row spoiler-set"><span class="faint small spoiler-method">${s.method || '–'}</span>
          ${uniq.map(([id]) => up(id)).map((m) => html`<span class="row" style="gap:2px"><${Sprite} id=${m.species} form=${m.form} size=${30} gen=${runData.gen} /><span class="small">${m.name}</span></span>`)}</div>`;
      })}</td></tr>`)}
    </tbody></table></section>
  </div>`;
}
