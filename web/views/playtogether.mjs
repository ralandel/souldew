// "Play together" (shared/playtogether.mjs): the new-run page, the join step and the board of a run in mode
// 'together' – 2..MAX_PLAYERS players in their own normal games, linked for trades, battles, Shared World and raids, without a
// challenge. It lives in the SoulLink section (route `soullink`): `?together` starts one (with `&rom=` a library game),
// a Play together's `?run=` shows TogetherBoard instead of the SoulLink board.
import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp, Led } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { buildLogText } from '../lib/errors.mjs';
import { gameById, gameTitle, hackById } from '../lib/data.mjs';
import { ALL_SLOTS, MAX_PLAYERS, slotsOf, defaultRunName } from '/shared/slots.mjs';
import { numberedName } from '/shared/restart.mjs';
import { togetherDefaults, rulesWithDefaults } from '/shared/rules.mjs';
import { hostSlotOf } from '/shared/hostrules.mjs';
import { gameInfo, linkWith, linkPairs, togetherRomBlock } from '/shared/playtogether.mjs';
import {
  live, players as getPlayers, rules as getRules, togetherGames, canEditRules, allowedRulesPatch, logRulesChange, feedList, feed, feedText, joinNames,
} from '../lib/run.mjs';
import { writeHostRules } from '../lib/hostrules.mjs';
import { PartyGrid, unhatched } from './party.mjs';
import { LinkButtons, LinkGroupButton, HeadToHead, gameLabelOf } from './linkplay.mjs';
import { PartnerTogether } from './together.mjs';
import { RpsStart } from './rps.mjs';
import { RaidStart } from './raid.mjs';
import { TogetherChoices, HostRulesNote } from './nuzrules.mjs';
import { InviteBody, playTimeText } from './board.mjs';

const SYSTEM_NAME = { gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance', nds: 'Nintendo DS' };
const newProgressId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const rootOf = (id) => gameById(id)?.variantOf || id || null;

/** A library ROM as a player picks it: its title (the catalog's, a hack's, or the file's) and the game info. */
export function romChoice(r) {
  const g = gameById(r.gameId);
  const hack = r.hackId ? hackById(r.hackId) : null;
  const title = hack ? hack.name : r.customHack || (g ? gameTitle(g) : r.title || r.name);
  const game = { id: rootOf(r.gameId), system: r.system, code: r.code, title: r.title, hackId: r.hackId || null, hackName: !r.hackId && r.customHack ? r.customHack : undefined };
  return { rom: r, title, info: gameInfo(game, g ? gameById(rootOf(r.gameId)) : null), game, block: togetherRomBlock(r) };
}

/** The library ROMs a Play together can be played with (no 3DS – no link there yet), the playable ones first. */
function useTogetherRoms() {
  const { library } = useApp();
  return (library?.roms || []).map(romChoice).sort((a, b) => Number(!!a.block) - Number(!!b.block) || a.title.localeCompare(b.title));
}

/** "Trades · Battles · See each other" for a pair of games, with what's missing said once. */
function PairChips({ c }) {
  const chip = (ok, label) => html`<span class=${`chip ${ok === true ? 'ok' : ok === 'untested' ? 'warn' : 'off'}`}>
    <${Icon} name=${ok === true ? 'check' : ok === 'untested' ? 'help' : 'close'} size=${12} />${label}</span>`;
  // (games that can't link at all: one chip, not three crosses)
  if (c.why) return html`<span class="row tight pt-chips">${chip(false, t('pt.noLink', 'Can’t link'))}</span>`;
  return html`<span class="row tight pt-chips">
    ${chip(c.trade, t('pt.trade', 'Trades'))}${chip(c.battle, t('pt.battle', 'Battles'))}${chip(c.world, t('pt.world', 'See each other'))}</span>`;
}

/** Why two games can't do it all – one short line (or null when they can). */
export function pairNote(c) {
  if (c.why === 'gen') return t('pt.noteGen', 'Different generations don’t meet in the games’ link rooms – you can still chat, raid, give items and play rock-paper-scissors.');
  if (c.why === 'system') return t('pt.noteSystem', 'These two consoles can’t link with each other – you can still chat, raid and play rock-paper-scissors.');
  if (c.why === 'hack') return t('pt.noteHack', 'This ROM hack changed its link too much to be sure it works.');
  if (c.trade === 'untested') return t('pt.noteTimeCapsule', 'Game Boy and Game Boy Color games meet in the Time Capsule (trades only) – souldew hasn’t tried that yet.');
  if (!c.world) return t('pt.noteWorld', 'Seeing each other walk needs two games with the same maps (Ruby and Sapphire, FireRed and LeafGreen, Gold, Silver and Crystal …).');
  return null;
}

// ---- new Play together ---------------------------------------------------------------------------------------------

export function NewTogether({ romPick = null }) {
  const { status, navigate, reloadStatus, setRunId, setMe, toast } = useApp();
  const choices = useTogetherRoms();
  const usable = choices.filter((c) => !c.block);
  const [romId, setRomId] = useState(() => (usable.find((c) => c.rom.id === romPick) || usable[0])?.rom.id || null);
  const pick = usable.find((c) => c.rom.id === romId) || usable[0] || null;
  const [count, setCount] = useState(2);
  const [names, setNames] = useState(() => ({ ...Object.fromEntries(ALL_SLOTS.map((s) => [s, ''])), p1: status?.config?.playerName || '' }));
  const [rules, setRules] = useState(togetherDefaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const slots = ALL_SLOTS.slice(0, count);

  if (result) {
    return html`<div class="stack-l">
      <div class="topbar"><h1>${t('pt.done', 'Ready to play together')}</h1></div>
      <section class="panel stack invite-panel"><${InviteBody} manifest=${result} /></section>
      <div class="row">
        <button class="btn" onClick=${() => navigate('play', { run: result.id })}><${Icon} name="play" size=${16} />${t('new.playNow', 'Start playing')}</button>
        <button class="btn ghost" onClick=${() => navigate('soullink', { run: result.id })}>${t('pt.toBoard', 'Open the board')}</button>
      </div>
    </div>`;
  }
  if (!usable.length) {
    return html`<div class="panel empty-state"><${Icon} name="friends" size=${56} /><h2>${t('pt.noGame', 'Add a game first')}</h2>
      <p class="muted prose">${t('pt.noGameText', 'Play together uses a game of your library – a Game Boy, Game Boy Advance or DS game (3DS games can’t link yet).')}</p>
      <button class="btn primary" onClick=${() => navigate('library')}>${t('nav.library', 'Library')}</button></div>`;
  }
  const build = async () => {
    setBusy(true);
    setError(null);
    setLog([]);
    const players = Object.fromEntries(slots.map((s, i) => [s, { name: names[s].trim() || `P${i + 1}` }]));
    try {
      const res = await api.post('/api/runs/build', {
        progressId: newProgressId(), mode: 'together', romId: pick.rom.id, randomize: false, players, buildFor: ['p1'], host: 'p1',
        gameId: pick.game.id, gameTitle: pick.title, hackId: pick.rom.hackId || null, hackName: pick.game.hackName,
        name: numberedName(defaultRunName(players, 'together'), status?.runs), rules,
      });
      setLog(res.log);
      await reloadStatus();
      setRunId(res.manifest.id);
      setMe('p1', res.manifest.id);
      setResult(await api.get(`/api/runs/${res.manifest.id}`));
      if (names.p1.trim()) api.post('/api/config', { playerName: names.p1.trim() }).catch(() => {});
    } catch (e) {
      setError(e.message);
      toast({ kind: 'death', title: t('pt.title', 'Play together'), text: e.message });
    }
    setBusy(false);
  };
  return html`<div class="stack-l">
    <div class="topbar"><div class="stack-s" style="gap:2px; margin-right:auto"><h1>${t('pt.title', 'Play together')}</h1>
      <span class="small muted">${t('pt.lead', 'Your own game with friends: trade, battle, see each other walk and raid together – no challenge rules.')}</span></div></div>
    ${error && html`<div class="warning error" role="alert">${error}</div>`}
    <section class="panel stack">
      <h2>${t('pt.step1', '1 · Your game')}</h2>
      <label class="field"><span>${t('pt.pickGame', 'Game from your library')}</span>
        <select value=${pick?.rom.id} onChange=${(e) => setRomId(e.target.value)}>
          ${choices.map((c) => html`<option value=${c.rom.id} disabled=${!!c.block}>${c.title} · ${SYSTEM_NAME[c.rom.system] || c.rom.system?.toUpperCase()}${c.block ? ` – ${t('pt.cantLink', 'can’t link')}` : ''}</option>`)}
        </select></label>
      <p class="small muted">${t('pt.saveNote', 'You play your normal game with its own save: what you do together is there when you play it alone from the library, and the other way round.')}</p>
    </section>
    <section class="panel stack">
      <h2>${t('pt.step2', '2 · Who plays')}</h2>
      <div class="seg" role="radiogroup" aria-label=${t('pt.howMany', 'How many play')}>
        ${Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => i + 2).map((n) => html`<button role="radio" aria-checked=${count === n} class=${count === n ? 'on' : ''} onClick=${() => setCount(n)}>${t('pt.nPlayers', '{n} players', { n })}</button>`)}</div>
      <div class="grid-2">${slots.map((s, i) => html`<label class="field" key=${s}><span>${i === 0 ? t('new.you', 'You') : t('new.playerN', 'Player {n}', { n: i + 1 })}</span>
        <input type="text" maxLength="40" value=${names[s]} placeholder=${i === 0 ? t('new.yourName', 'Your name') : t('pt.friendName', 'Their name (they can change it)')}
          onInput=${(e) => setNames({ ...names, [s]: e.target.value })} /></label>`)}</div>
      <p class="small muted">${t('pt.othersGames', 'Each of them plays a game of their own – the same as yours or another one. Who can trade, battle or see whom shows on the board.')}</p>
    </section>
    <section class="panel stack">
      <h2>${t('pt.step3', '3 · What you can do together')}</h2>
      <${TogetherChoices} value=${rulesWithDefaults(rules, 'together')} onChange=${(patch) => setRules({ ...rules, ...patch })} />
      <p class="tiny faint">${t('pt.noRules', 'No encounter rules, no deaths, no level caps – nothing in your game counts against you. You can change these choices on the board later.')}</p>
    </section>
    <div><button class="btn primary big" disabled=${busy || !pick} onClick=${build}><${Icon} name="friends" size=${16} />${busy ? t('new.building', 'Building …') : t('pt.create', 'Create & invite')}</button></div>
    ${log.length > 0 && html`<div class="log">${log.map(buildLogText).join('\n')}</div>`}
  </div>`;
}

// ---- joining ---------------------------------------------------------------------------------------------------------

/**
 * Step 2 of joining a Play together (views/soullink.mjs JoinRun): pick your own game – any linkable one –, see what it
 * can do with the host's, pick your seat, join. `onJoined()` after the build.
 */
export function TogetherJoinStep({ pack, slots, mine, setSlot, taken = [], myName = '', onJoined }) {
  const { navigate } = useApp();
  const choices = useTogetherRoms();
  const usable = choices.filter((c) => !c.block);
  const hostGame = pack.game ? gameInfo(pack.game, gameById(pack.game.id)) : null;
  // the host's game first when it's in the library, else the first playable
  const [romId, setRomId] = useState(() => (usable.find((c) => c.info.root && c.info.root === hostGame?.root) || usable[0])?.rom.id || null);
  const pick = usable.find((c) => c.rom.id === romId) || null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [log, setLog] = useState([]);
  const host = pack.players?.[hostSlotOf(pack)]?.name || hostSlotOf(pack).toUpperCase();
  const c = pick && hostGame ? linkWith(pick.info, hostGame) : null;
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const players = myName.trim() && pack.players?.[mine] ? { ...pack.players, [mine]: { ...pack.players[mine], name: myName.trim() } } : pack.players;
      const res = await api.post('/api/runs/build', {
        progressId: newProgressId(), runId: pack.id, mode: 'together', romId: pick.rom.id, randomize: false, players, buildFor: [mine], name: pack.name,
        rules: pack.rules, gameId: pick.game.id, gameTitle: pick.title, hackId: pick.rom.hackId || null, hackName: pick.game.hackName,
      });
      setLog(res.log);
      await onJoined?.(mine);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  return html`<section class="panel stack">
    <h2>${t('join.step2', '2 · Your game')}</h2>
    ${error && html`<div class="warning error" role="alert">${error}</div>`}
    ${usable.length ? html`<label class="field"><span>${t('pt.pickGame', 'Game from your library')}</span>
        <select value=${pick?.rom.id} onChange=${(e) => setRomId(e.target.value)}>
          ${choices.map((x) => html`<option value=${x.rom.id} disabled=${!!x.block}>${x.title} · ${SYSTEM_NAME[x.rom.system] || x.rom.system?.toUpperCase()}${x.block ? ` – ${t('pt.cantLink', 'can’t link')}` : ''}</option>`)}
        </select></label>
      ${c && html`<div class="stack-s"><span class="small">${t('pt.withHost', 'With {name}’s {game}:', { name: host, game: gameLabelOf(hostGame) })}</span>
        <${PairChips} c=${c} />${pairNote(c) && html`<span class="tiny muted">${pairNote(c)}</span>`}</div>`}
      <p class="small muted">${t('pt.saveNote', 'You play your normal game with its own save: what you do together is there when you play it alone from the library, and the other way round.')}</p>`
      : html`<p class="warning">${t('pt.noGameText', 'Play together uses a game of your library – a Game Boy, Game Boy Advance or DS game (3DS games can’t link yet).')}</p>
        <div><button class="btn" onClick=${() => navigate('library')}>${t('nav.library', 'Library')}</button></div>`}
    ${slots.length > 1 && html`<div class="row small"><span class="muted">${t('join.iAm', 'I am')}</span>
      <div class="seg" role="radiogroup">${slots.map((s) => html`<button role="radio" aria-checked=${mine === s} class=${mine === s ? 'on' : ''} onClick=${() => setSlot(s)}
        title=${taken.includes(s) ? t('join.takenTitle', 'Already in the run') : ''} style=${taken.includes(s) && mine !== s ? 'opacity:.55' : ''}>${pack.players?.[s]?.name || s.toUpperCase()}</button>`)}</div></div>`}
    <div><button class="btn primary big" disabled=${busy || !pick} onClick=${join}>${busy ? t('new.building', 'Building …') : t('pt.join', 'Join with this game')}</button></div>
    ${log.length > 0 && html`<div class="log">${log.map(buildLogText).join('\n')}</div>`}
  </section>`;
}

// ---- the board -------------------------------------------------------------------------------------------------------

/** Has `slot` ever shown up in the run (online now, a live team, or their game announced)? */
const seen = (app, doc, slot) => slot === app.me || app.onlineSlots?.has?.(slot) || !!live(doc, slot) || !!doc.get(`game:${slot}`, null);

export function TogetherBoard() {
  const app = useApp();
  const { manifest, doc, docVersion, navigate, route } = app;
  const [tab, setTab] = useState(route.params.tab === 'log' || route.params.tab === 'rules' ? route.params.tab : 'players');
  if (!doc) return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  const slots = slotsOf(manifest);
  const missing = slots.filter((s) => !seen(app, doc, s));
  const TABS = [['players', t('pt.players', 'Players')], ['log', t('board.log', 'Log')], ['rules', t('pt.choices', 'Choices')]];
  return html`<div class="stack-l together-board" data-v=${docVersion}>
    <div class="topbar"><div class="stack-s" style="gap:2px; margin-right:auto"><h1>${manifest.name}</h1>
      <span class="small muted"><${Icon} name="friends" size=${14} /> ${t('pt.modeN', 'Play together · {n} players', { n: slots.length })}</span></div></div>
    ${missing.length > 0 && html`<details class="group panel pt-invite" open=${missing.length === slots.length - 1}>
      <summary>${t('pt.inviteMissing', 'Invite {names}', { names: joinNames(missing.map((s) => getPlayers(doc, manifest)[s]?.name || s.toUpperCase())) })}</summary>
      <div style="padding:4px 14px 12px"><${InviteBody} manifest=${manifest} heading=${false} /></div></details>`}
    <div class="tabbar"><div class="tabs" role="tablist" data-pad-tabs>
      ${TABS.map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
      <div class="row nowrap tabbar-end">
        <button class="btn small ghost" onClick=${() => navigate('soullink')}>${t('board.allRuns', 'All runs')}</button>
        <button class="btn small go" onClick=${() => navigate('play', { run: manifest.id })}><${Icon} name="play" size=${14} />${t('nav.play', 'Play')}</button></div>
    </div>
    ${tab === 'players' && html`<${PlayersTab} />`}
    ${tab === 'log' && html`<${TogetherLog} />`}
    ${tab === 'rules' && html`<${ChoicesTab} />`}
  </div>`;
}

function PlayersTab() {
  const { doc, manifest, me } = useApp();
  const slots = slotsOf(manifest);
  const games = togetherGames(doc, manifest, me);
  const names = getPlayers(doc, manifest);
  const pairs = linkPairs(games, slots).filter((p) => games[p.a] && games[p.b]);
  return html`<div class="stack-l">
    <div class=${`pt-players n${slots.length}`}>${slots.map((s) => html`<${PlayerCard} key=${s} slot=${s} game=${games[s]} />`)}</div>
    ${pairs.length > 0 && html`<section class="panel stack-s pt-pairs">
      <h3>${t('pt.whoLinks', 'Who can play with whom')}</h3>
      <ul class="pt-pair-list">${pairs.map((p) => {
        const note = pairNote(p);
        return html`<li key=${`${p.a}${p.b}`}><span class="pt-pair-who"><b class=${`who-${p.a}`}>${names[p.a]?.name}</b> ↔ <b class=${`who-${p.b}`}>${names[p.b]?.name}</b></span>
          <${PairChips} c=${p} />${note && html`<span class="tiny muted pt-pair-note">${note}</span>`}</li>`;
      })}</ul>
      <p class="tiny faint">${t('pt.romsNote', 'For a trade or battle each of you needs the other’s game in the library too – souldew never sends games, only the buttons.')}</p>
    </section>`}
  </div>`;
}

function PlayerCard({ slot, game }) {
  const app = useApp();
  const { doc, manifest, me, session, onlineSlots } = app;
  const names = getPlayers(doc, manifest);
  const l = live(doc, slot);
  const where = doc.get(`where:${slot}`, null);
  const playingHere = slot === me && session?.target.runId === manifest.id;
  const online = slot === me || !!onlineSlots?.has?.(slot);
  const fresh = l && Date.now() - (l.at || 0) < 15000;
  const team = (l?.party || []).filter((m) => !unhatched(m));
  const facts = l ? [game && html`<span class="fact">${gameLabelOf(game)}</span>`,
    html`<span class="fact">${t('board.badges', '{n} badge|{n} badges', { n: l.badges || 0, count: l.badges || 0 })}</span>`,
    l.playTime ? html`<span class="fact">${playTimeText(l.playTime)}</span>` : null,
    where?.name ? html`<span class="fact">${where.name}</span>` : null,
    html`<span class="fact faint">${ago(l.at)}</span>`].filter(Boolean)
    : [game && html`<span class="fact">${gameLabelOf(game)}</span>`,
      html`<span class="fact">${playingHere ? t('board.playingNoTeam', 'playing – no team yet') : slot === me ? t('board.startPlaying', 'Start the game to go live') : online ? t('board.partnerOnline', 'online – no team yet') : t('board.notPlaying', 'not playing yet')}</span>`].filter(Boolean);
  return html`<section class=${`panel stack-s pt-player player-tag ${slot}`} style=${`--acc:var(--${slot})`}>
    <div class="row nowrap"><${Led} on=${(online && fresh) || playingHere} color="green" blink=${online && !fresh && !playingHere && slot !== me} />
      <b class="who grow ellipsis" title=${names[slot]?.name}>${names[slot]?.name}${slot === me ? html` <span class="faint tiny">(${t('common.you', 'you')})</span>` : ''}</b>
      ${game && html`<span class="chip tiny">${SYSTEM_NAME[game.system] || game.system}</span>`}</div>
    <span class="tiny muted pt-facts">${facts.map((x, i) => html`${i ? ' · ' : ''}${x}`)}</span>
    ${team.length > 0 && html`<${PartyGrid} party=${team} gen=${game?.gen || 3} compact accent=${`var(--${slot})`} label=${names[slot]?.name || ''} emptySlots=${false} />`}
    ${slot !== me && html`<${HeadToHead} slot=${slot} />`}
    ${slot !== me ? html`<${LinkButtons} slot=${slot} />` : html`<${LinkGroupButton} />`}
    ${slot !== me && html`<${PartnerTogether} slot=${slot} />`}
  </section>`;
}

function TogetherLog() {
  const { doc, manifest, me, link, onlineSlots } = useApp();
  const [text, setText] = useState('');
  const names = getPlayers(doc, manifest);
  const items = feedList(doc, 120);
  return html`<section class="panel">
    <form class="row" style="margin-bottom:10px" onSubmit=${(e) => { e.preventDefault(); if (text.trim()) { feed(doc, { type: 'chat', slot: me, text: text.trim() }); setText(''); } }}>
      <input type="text" class="grow" placeholder=${t('log.placeholder', 'Message to the log …')} value=${text} onInput=${(e) => setText(e.target.value)} />
      <button class="btn">${t('log.send', 'Send')}</button>
      <button type="button" class="btn ghost" disabled=${!link} onClick=${() => link?.sendMessage({ type: 'ping', text: t('log.pingText', 'Hey, take a look!') })}>${t('log.ping', 'Ping')}</button>
      ${link && html`<${RpsStart} online=${onlineSlots} />`}
      <${RaidStart} online=${onlineSlots} />
    </form>
    <div class="feed" style="max-height:none">
      ${items.length === 0 && html`<p class="small faint">${t('pt.logEmpty', 'Trades, battles, raids, gifts, badges and your messages show up here.')}</p>`}
      ${items.map((f) => html`<div class=${`feed-item ${f.type}`}><span class="k"></span>
        <span>${f.slot && html`<span class=${`who-${f.slot}`}>${names[f.slot]?.name}</span> `}${feedText(doc, manifest, f)}</span><time>${ago(f.at)}</time></div>`)}
    </div>
  </section>`;
}

export function ChoicesTab() {
  const { doc, manifest, toast, me } = useApp();
  const r = getRules(doc, manifest);
  const mine = canEditRules(manifest);
  const hostName = getPlayers(doc, manifest)[hostSlotOf(manifest)]?.name;
  const set = async (asked) => {
    const patch = allowedRulesPatch(asked, manifest);
    if (!patch) return;
    const next = { ...(doc.get('rules') || {}), ...patch };
    delete next.discordWebhook;
    try {
      await writeHostRules(doc, manifest, next, me);
    } catch (e) {
      toast({ kind: 'death', title: t('rules.notSaved', 'Rules not changed'), text: e.code === 'notHost' ? t('rules.notHostHere', 'Only the computer that created this run can change its rules.') : e.message });
      return;
    }
    logRulesChange(doc, manifest, me, r, getRules(doc, manifest));
  };
  return html`<div class="stack-l">
    <${HostRulesNote} host=${hostName} mine=${mine} players=${slotsOf(manifest).length} />
    <section class="panel stack">
      <h2>${t('pt.choicesTitle', 'What you can do together')}</h2>
      <${TogetherChoices} value=${r} onChange=${set} disabled=${!mine} hostName=${hostName} />
    </section>
    <section class="panel stack-s">
      <h3>${t('pt.offTitle', 'Never in Play together')}</h3>
      <p class="small muted">${t('pt.offText', 'No encounter rules, no deaths, no level caps, no lives and no run that can fail – everyone just plays their own game. Trophies are for challenge runs, so Play together doesn’t earn any.')}</p>
    </section>
  </div>`;
}

/** The SoulLink section's shelf of Play together runs and its way in (views/soullink.mjs RunsHome). */
export function TogetherIntro({ onStart, onJoin }) {
  return html`<section class="panel entry together-entry">
    <div class="row nowrap"><${Icon} name="friends" size=${28} /><h2>${t('pt.title', 'Play together')}</h2></div>
    <p class="muted">${t('pt.introText', 'No challenge – just your own games with friends: trade and battle in the games’ link rooms, see each other walk around, raid trainers together and swap items.')}</p>
    <div class="row"><button class="btn primary" onClick=${onStart}><${Icon} name="friends" size=${16} />${t('pt.start', 'Play together')}</button>
      <button class="btn" onClick=${onJoin}><${Icon} name="load" size=${16} />${t('runs.joinCode', 'Join with code')}</button></div>
  </section>`;
}

