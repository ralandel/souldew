// Trades and battles between the players of a run (docs/MULTIPLAYER.md, web/lib/linksession.mjs): the buttons on the
// board's player cards, the invite, the partner's game (pick your copy / build it), and the bar that says what the link
// is doing.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { serverErrorText } from '../lib/errors.mjs';
import { players as getPlayers, rules as getRules, slotsOf, isTogether, togetherGames } from '../lib/run.mjs';
import { inviteBlock } from '/shared/playtogether.mjs';
import { gameById, gameTitle } from '../lib/data.mjs';
import { sameLinkSystem, LINK_SYSTEMS, linkUnavailable } from '/shared/link.mjs';
import { wagerGame, battleFormats, moneyText, MONEY_MAX } from '/shared/linkbattle.mjs';
import { useTogether } from '../lib/together.mjs';
import { wagerRules, agreedWager, sessionsIn, outcomeOf, headToHead, wagerStatus } from '../lib/wager.mjs';
import { currentLang } from '../lib/i18n.mjs';

export { LINK_SYSTEMS, linkUnavailable }; // (the board shows the link buttons for these)


/** Does this run allow link sessions of `kind` ('trade' | 'battle')? The run rule (default: allowed). */
export function linkAllowed(doc, manifest, kind) {
  const r = getRules(doc, manifest) || {};
  if (linkUnavailable(manifest?.game)) return false;
  return kind === 'battle' ? r.linkBattles !== 'off' : r.linkTrades !== 'off';
}

export const reasonText = (code, name) => ({
  declined: t('linkplay.declined', '{name} doesn’t want to right now.', { name }),
  left: t('linkplay.left', 'The link has ended.'),
  closed: t('linkplay.left', 'The link has ended.'),
  linkMissing: t('linkplay.missing', 'This version of souldew can’t link games yet – update it on both computers.'),
  linkSystem: t('linkplay.system', 'Linking isn’t available for this game yet.'),
  linkHack: t('linkplay.hack', 'Trades and battles over the link aren’t available for this ROM hack – it changed its Pokémon and its link too much to be sure they work.'),
  linkOwnMissing: t('linkplay.ownMissing', 'Your own game for this run isn’t built on this computer.'),
  linkRomMissing: t('linkplay.romMissing2', 'A player’s game isn’t on one of the computers – the link needs every player’s game on every computer.'),
  linkSaveDiffers: t('linkplay.saveDiffers', 'A save arrived damaged. Try again.'),
  linkNoDirect: t('linkplay.noConnection', 'There’s no connection to {name} – check the Connection page and try again.', { name }),
  linkDesync: t('linkplay.desync2', 'The games fell out of step, so the link was stopped. To keep it fair, both of you are back at your saves from before the link – the session’s last save is kept as a backup in the run folder.'),
  linkStart: t('linkplay.startFailed', 'The linked games didn’t start.'),
  linkRejoinGone: t('linkplay.rejoinGone', 'Nobody answered – the others have left the link.'),
  linkRejoinBusy: t('linkplay.rejoinBusy', 'The others’ games are in the middle of a wireless exchange right now, so you can’t rejoin – the link has ended.'),
  busy: t('linkplay.busy', '{name} is in another link right now.', { name }),
  linkNoAnswer: t('linkplay.noAnswer', '{name} didn’t answer.', { name }),
  // Play together, each player in a game of their own (shared/playtogether.mjs linkWith)
  linkGen: t('linkplay.gen', 'These games can’t link: only games of the same generation meet in the Cable Club or the Union Room.'),
  linkTradeOnly: t('linkplay.tradeOnly', 'A Game Boy and a Game Boy Color game only trade (Time Capsule) – no battles.'),
}[code] || serverErrorText({ code }) || t('linkplay.left', 'The link has ended.')); // (a server's code: its own text)

/** Where the players meet in their games for this system. */
const meetText = (system) => system === 'nds'
  ? t('linkplay.goUnionRoom', 'Meet in the Pokémon Center: the Union Room counter (DS wireless).')
  : t('linkplay.goUpstairs', 'Meet in the Pokémon Center, upstairs at the counter.');

/** "direct · 42 ms" / "relayed · 80 ms" for the partners of the session. */
function routeText(route) {
  const list = Object.values(route || {}).filter(Boolean);
  if (!list.length) return null;
  const relayed = list.some((r) => r.route === 'relayed');
  const rtt = list.map((r) => r.rtt).filter(Number.isFinite);
  const ms = rtt.length ? ` · ${Math.max(...rtt)} ms` : '';
  return relayed ? t('linkplay.relayed', 'relayed (TURN)') + ms : t('linkplay.direct', 'direct') + ms;
}

/**
 * "In a link with Tim": a partner who is linked with other players of the run right now (what their computer tells the
 * players outside the session, web/lib/linksession.mjs 'linked') – null when they aren't. `names`: { slot: { name } }.
 */
export function linkedText(linkSessions, slot, names) {
  const away = linkSessions?.linkedElsewhere?.(slot);
  if (!away) return null;
  const name = away.seats.filter((s) => s !== slot).map((s) => names?.[s]?.name || s.toUpperCase()).join(', ');
  return away.kind === 'battle' ? t('linkplay.inBattleWith', 'In a link battle with {name}', { name }) : t('linkplay.inLinkWith', 'In a link with {name}', { name });
}

/**
 * Play together: why `me` can't start a `kind` link with `slots` because of the games (shared/playtogether.mjs
 * inviteBlock) – a sentence naming the partner's game – or null (a SoulLink: always null).
 */
export function gamesWhy(doc, manifest, me, slots, kind, names) {
  if (!isTogether(manifest)) return null;
  const games = togetherGames(doc, manifest, me);
  const b = inviteBlock(games, me, slots, kind);
  if (!b) return null;
  const name = names?.[b.slot]?.name || b.slot;
  const game = gameLabelOf(games[b.slot]);
  return {
    gen: t('linkplay.genWith', '{name} plays {game} – a game of another generation can’t link with yours.', { name, game }),
    system: t('linkplay.systemWith', '{name} plays {game} – that can’t link with your game.', { name, game }),
    hack: t('linkplay.hack', 'Trades and battles over the link aren’t available for this ROM hack – it changed its Pokémon and its link too much to be sure they work.'),
    battle: t('linkplay.tradeOnlyWith', '{name} plays {game}: Game Boy and Game Boy Color games only trade (Time Capsule) – no battles.', { name, game }),
  }[b.why] || null;
}

/** A partner's game as words: "Sapphire", "Unbound (FireRed)", or "Gen 3". */
export function gameLabelOf(g) {
  if (!g) return '?';
  const c = g.root ? gameById(g.root) || gameById(g.id) : null;
  const title = c ? gameTitle(c) : null;
  if (g.hack) return title ? `${g.hack} (${title})` : g.hack;
  return title || t('pt.genN', 'Gen {n}', { n: g.gen });
}

/** Trade / Battle on a partner's card (the board): only when both can link right now. */
export function LinkButtons({ slot }) {
  const { doc, manifest, me, onlineSlots, linkSessions, linkPlay, linkStatus, toast, link } = useApp();
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const together = useTogether(link);
  if (!linkSessions || slot === me || linkUnavailable(manifest?.game)) return null;
  const online = onlineSlots?.has?.(slot);
  const direct = !!linkStatus?.partners?.[slot]?.p2p;
  const idle = !linkPlay || ['idle', 'ended', 'rejoinable'].includes(linkPlay.phase);
  const names = getPlayers(doc, manifest);
  const name = names[slot]?.name || slot;
  // linked with others right now: said on the card, and the buttons wait until that link ends
  const away = online ? linkedText(linkSessions, slot, names) : null;
  // a partner on 2.x never answers an invite: say why instead of letting it run into "didn't answer"
  const older = online && !!together?.olderApp(slot);
  const start = async (kind) => {
    setBusy(true);
    try {
      await linkSessions.invite(kind, [slot]);
    } catch (e) {
      toast({ kind: 'death', title: t('linkplay.title', 'Link'), text: reasonText(e.code, name) });
    } finally {
      setBusy(false);
    }
  };
  const olderText = t('linkplay.olderApp', '{name} is on an older souldew – trading and battling need souldew 3.0 on both computers', { name });
  const why = !online ? t('linkplay.needOnline', '{name} isn’t online', { name }) : older ? olderText : away || (!direct ? t('linkplay.needConnection', 'No connection to {name} yet', { name }) : null);
  // (Play together: the two games must be able to meet – said on the button, not after the invite)
  const tradeWhy = gamesWhy(doc, manifest, me, [slot], 'trade', names);
  const battleWhy = tradeWhy || gamesWhy(doc, manifest, me, [slot], 'battle', names);
  // a battle may be for money (the run's wager rule): first the challenge – format and wager – then the invite
  const challenge = wagerRules(getRules(doc, manifest)).on && wagerGame(manifest?.game?.id);
  if (setup) {
    return html`<${BattleSetup} names=${[name]} seats=${2} onCancel=${() => setSetup(false)}
      onSend=${async (opts) => { setSetup(false); setBusy(true); try { await linkSessions.invite('battle', [slot], opts); } catch (e) { toast({ kind: 'death', title: t('linkplay.title', 'Link'), text: reasonText(e.code, name) }); } finally { setBusy(false); } }} />`;
  }
  return html`${away && html`<span class="link-away tiny" data-linked=${slot}><${Icon} name="link" size=${12} />${away}</span>`}
    ${older && html`<span class="link-away tiny" data-older=${slot}><${Icon} name="download" size=${12} />${olderText}</span>`}<div class="row link-buttons">
    ${linkAllowed(doc, manifest, 'trade') && html`<button class="btn small" disabled=${busy || !idle || !!why || !!tradeWhy} title=${tradeWhy || why || t('linkplay.tradeHint', 'Both games open in the link – meet in the Pokémon Center upstairs, as with a cable')}
      onClick=${() => start('trade')}><${Icon} name="link" size=${14} />${t('linkplay.trade', 'Trade')}</button>`}
    ${linkAllowed(doc, manifest, 'battle') && html`<button class="btn small" disabled=${busy || !idle || !!why || !!battleWhy} title=${battleWhy || why || (isTogether(manifest) ? t('linkplay.battleHintCasual', 'A link battle – just for fun') : t('linkplay.battleHint2', 'A link battle – by the run’s rules, losing there doesn’t count'))}
      onClick=${() => (challenge ? setSetup(true) : start('battle'))}><${Icon} name="bolt" size=${14} />${t('linkplay.battle', 'Battle')}</button>`}
  </div>`;
}

/**
 * The challenge before a battle invite: the format (where the game lets the players pick one) and an optional wager –
 * in-game money, at most what you have and the run's limit. The partner sees both in the invite.
 */
export function BattleSetup({ names, seats, onSend, onCancel }) {
  const { doc, manifest, wagerRef } = useApp();
  const system = manifest?.game?.system;
  const formats = battleFormats(system, seats);
  const [format, setFormat] = useState(formats[0] || null);
  const [on, setOn] = useState(false);
  const [amount, setAmount] = useState(1000);
  const [money, setMoney] = useState(undefined); // undefined: still reading, null: the game isn't running here
  const { cap } = wagerRules(getRules(doc, manifest));
  useEffect(() => {
    let alive = true;
    Promise.resolve(wagerRef?.current?.money?.()).catch(() => null).then((m) => alive && setMoney(Number.isFinite(m) ? m : null));
    return () => { alive = false; };
  }, []);
  const lang = currentLang();
  const max = Math.min(MONEY_MAX, cap || MONEY_MAX, Number.isFinite(money) ? money : MONEY_MAX);
  const value = Math.max(0, Math.min(max, Math.floor(Number(amount) || 0)));
  const fmtName = { single: t('linkplay.fmtSingle', 'Single battle'), double: t('linkplay.fmtDouble', 'Double battle'), multi: t('linkplay.fmtMulti', 'Multi battle (2 vs 2)') };
  const who = names.join(', ');
  return html`<div class="battle-setup stack-s" role="group" aria-label=${t('linkplay.challengeTitle', 'Challenge {name}', { name: who })}>
    <b class="small">${t('linkplay.challengeTitle', 'Challenge {name}', { name: who })}</b>
    ${formats.length > 1 ? html`<div class="seg small" role="group" aria-label=${t('linkplay.format', 'Format')}>${formats.map((f) => html`<button type="button" class=${format === f ? 'on' : ''} aria-pressed=${format === f} onClick=${() => setFormat(f)}>${fmtName[f]}</button>`)}</div>`
      : formats.length === 1 ? html`<span class="tiny muted">${fmtName[formats[0]]}</span>` : ''}
    <label class="check small"><input type="checkbox" checked=${on} onChange=${(e) => setOn(e.target.checked)} /><span>${t('linkplay.wagerOn', 'Battle for money')}
      <span class="hint">${t('linkplay.wagerHint', 'In-game money (₽): the loser’s game pays the winner’s, right after the battle.')}</span></span></label>
    ${on && html`<div class="row wager-row">
      <span class="wager-input"><span aria-hidden="true">₽</span><input type="number" class="input small" min="1" max=${max} step="100" value=${amount} aria-label=${t('linkplay.wagerAmount', 'Wager')}
        onInput=${(e) => setAmount(e.target.value)} /></span>
      ${[500, 1000, 5000].filter((v) => v <= max).map((v) => html`<button type="button" class="btn small ghost" onClick=${() => setAmount(v)}>${moneyText(v, lang)}</button>`)}
    </div>
    <span class="tiny muted">${[money === undefined ? null : money === null ? t('linkplay.wagerNoGame', 'Start your game here to see your money – nobody can put in more than their game holds.') : t('linkplay.wagerHave', 'You have {amount}.', { amount: moneyText(money, lang) }),
      cap ? t('linkplay.wagerCap', 'This run’s limit: {amount}.', { amount: moneyText(cap, lang) }) : null].filter(Boolean).join(' ')}</span>`}
    <div class="row" style="gap:6px">
      <button class="btn small primary" disabled=${on && !value} onClick=${() => onSend({ format, wager: on ? value : 0 })}><${Icon} name="bolt" size=${14} />${on && value ? t('linkplay.challengeFor', 'Challenge for {amount}', { amount: moneyText(value, lang) }) : t('linkplay.challenge', 'Challenge')}</button>
      <button class="btn small ghost" onClick=${onCancel}>${t('common.cancel', 'Cancel')}</button>
    </div>
  </div>`;
}

/** "Sam 3 : 1 Tim" – the link battles of this run between you and `slot` (only once there are any). */
export function HeadToHead({ slot }) {
  const { doc, manifest, me } = useApp();
  if (!doc || !manifest || !slot || slot === me) return null;
  const r = headToHead(doc, me, slot);
  if (!r.a && !r.b && !r.draws) return null;
  const names = getPlayers(doc, manifest);
  const text = t('linkplay.h2h', '{me} {a} : {b} {name}', { me: names[me]?.name || me, a: r.a, b: r.b, name: names[slot]?.name || slot });
  return html`<span class="h2h tiny" title=${t('linkplay.h2hHint', 'Link battles in this run')}><${Icon} name="bolt" size=${12} />${text}${r.draws ? html`<span class="muted"> · ${t('linkplay.h2hDraws', '{n} draw|{n} draws', { n: r.draws, count: r.draws })}</span>` : ''}</span>`;
}

/**
 * With three or four players: one invite for everybody online (Gen 3 multi battles need four linked games, the DS
 * Union Room takes all of them).
 */
export function LinkGroupButton() {
  const { doc, manifest, me, onlineSlots, linkSessions, linkPlay, linkStatus, toast, link } = useApp();
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const together = useTogether(link);
  const slots = manifest ? slotsOf(manifest) : [];
  if (!linkSessions || slots.length < 3 || linkUnavailable(manifest?.game) || !linkAllowed(doc, manifest, 'battle')) return null;
  // (a player linked with others right now waits for the next one; one on an older souldew can't take part)
  const ready = slots.filter((s) => s !== me && onlineSlots?.has?.(s) && linkStatus?.partners?.[s]?.p2p && !linkSessions.linkedElsewhere?.(s) && !together?.olderApp(s));
  // (Play together: everybody's game must meet everybody else's – four Gen 3 games, four Gen 4 …)
  const groupWhy = ready.length >= 2 ? gamesWhy(doc, manifest, me, ready, 'battle', getPlayers(doc, manifest)) : null;
  const idle = !linkPlay || ['idle', 'ended', 'rejoinable'].includes(linkPlay.phase);
  const go = async (opts = {}) => {
    setBusy(true);
    setSetup(false);
    try {
      await linkSessions.invite('battle', ready, opts);
    } catch (e) {
      toast({ kind: 'death', title: t('linkplay.title', 'Link'), text: reasonText(e.code, '') });
    } finally {
      setBusy(false);
    }
  };
  // four Game Boy Advances: a multi battle (2 vs 2) – it may be for money too
  const multi = ready.length === 3 && battleFormats(manifest?.game?.system, 4).length && wagerRules(getRules(doc, manifest)).on && wagerGame(manifest?.game?.id);
  if (setup) {
    const names = getPlayers(doc, manifest);
    return html`<${BattleSetup} names=${ready.map((s) => names[s]?.name || s)} seats=${4} onCancel=${() => setSetup(false)} onSend=${(opts) => go(opts)} />`;
  }
  return html`<button class="btn small" disabled=${busy || !idle || ready.length < 2 || !!groupWhy}
    title=${groupWhy || t('linkplay.groupHint', 'All of you in one link: multi battles (Gen 3: four players) and the Union Room')}
    onClick=${() => (multi ? setSetup(true) : go())}><${Icon} name="link" size=${14} />${t('linkplay.group', 'Link all of us ({n})', { n: ready.length + 1 })}</button>`;
}

/**
 * What "Pick your copy" / "Build Tim's game" says when a step fails: the server's code in the player's language, else
 * the error's own text (already translated by linksession's _api – or a network error) – never an empty alert.
 */
export function needRomsError(e, names = {}) {
  if (e?.code === 'linkPickDiffers') return t('linkplay.pickDiffers', 'That file isn’t the same game as {name}’s (its SHA-1 differs) – it must be exactly the same release.', { name: names[e.slot]?.name || '' });
  return serverErrorText(e || {}) || e?.message || t('linkplay.stepFailed', 'That didn’t work – try again.');
}

/** "Pick your copy of FireRed" / "Build Tim's game": what's missing before the link can start. */
function NeedRoms({ st, names }) {
  const { linkSessions, manifest } = useApp();
  const [lib, setLib] = useState(null);
  const [pick, setPick] = useState({});
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const loadLib = () => api.get('/api/library').then((l) => setLib((l.roms || []).filter((r) => sameLinkSystem(r.system, manifest?.game?.system))));
  useEffect(() => {
    loadLib().catch(() => setLib([]));
  }, []);
  // a file that isn't in the library yet: into the library (as the Library page adds one), then found by its checksum
  const addFile = async (file) => {
    const res = await fetch(`/api/library/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: file });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(serverErrorText(body, res.status)), { code: body?.code, vars: body?.vars });
    }
    loadLib().catch(() => {});
    await linkSessions.recheck();
    // (still missing: the added file isn't that game – name the first seat still missing)
    if (linkSessions.state.phase === 'need') throw Object.assign(new Error('differs'), { code: 'linkPickDiffers', slot: linkSessions.state.missing?.[0]?.slot });
  };
  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(needRomsError(e, names));
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="stack small">
    ${(st.missing || []).map((m) => {
      const name = names[m.slot]?.name || m.slot;
      if (m.canBuild) {
        return html`<div class="row" key=${m.slot}><span class="grow">${t('linkplay.needBuild', '{name}’s game isn’t built on this computer yet (your run was joined before linking existed).', { name })}</span>
          <button class="btn small primary" disabled=${busy || st.building} onClick=${() => run(() => linkSessions.buildPartner(m.slot))}>
            ${st.building === m.slot ? t('linkplay.building', 'Building …') : t('linkplay.build', 'Build {name}’s game', { name })}</button></div>`;
      }
      return html`<div class="stack-s" key=${m.slot}>
        <span>${t('linkplay.needPick', '{name} plays another file of this game. Pick your copy of it – souldew checks it’s exactly the same (SHA-1).', { name })}</span>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
          <select class="input small" style="flex:1 1 240px;min-width:0" aria-label=${t('linkplay.pickLabel', 'Your copy of {name}’s game', { name })} value=${pick[m.slot] || ''}
            onChange=${(e) => setPick({ ...pick, [m.slot]: e.target.value })}>
            <option value="">${lib ? t('linkplay.pickOne', 'Choose a game from your library …') : t('common.loading', 'Loading …')}</option>
            ${(lib || []).map((r) => html`<option value=${r.id}>${r.title || r.name}</option>`)}
          </select>
          <button class="btn small primary" disabled=${busy || !pick[m.slot]} onClick=${() => run(() => linkSessions.pickRom(m.slot, pick[m.slot]).catch((e) => { e.slot = m.slot; throw e; }))}>${t('linkplay.pickUse', 'Use this file')}</button>
          <label class="btn small ghost">${t('linkplay.pickAdd', 'Add a file …')}<input type="file" hidden accept=".gb,.gbc,.gba,.nds,.zip"
            onChange=${(e) => { const f = e.target.files?.[0]; if (f) run(() => addFile(f)); e.target.value = ''; }} /></label>
        </div>
      </div>`;
    })}
    ${err && html`<span class="error small" role="alert">${err}</span>`}
  </div>`;
}

/** While the link gets ready: what the battle is for – or why it is for nothing (a partner's older souldew). */
function wagerNote(st, names) {
  const w = st.wager;
  if (!w?.offer) return null;
  const lang = currentLang();
  const old = (st.seats || []).filter((s) => w.caps?.[s] === false || (st.accepted?.[s] && s !== st.host && !w.caps?.[s]));
  if (old.length) return t('linkplay.wagerOld', 'no wager – {name}’s souldew doesn’t know wagers yet', { name: old.map((s) => names[s]?.name || s).join(', ') });
  const agreed = agreedWager({ offer: w.offer, seats: (st.seats || []).filter((s) => s === st.host || st.accepted?.[s]), host: st.host, accepts: w.accepts, caps: w.caps });
  return t('linkplay.forAmount', 'for {amount}', { amount: moneyText(agreed || w.offer, lang) });
}

/** "Sam challenges you: single battle for ₽2,000" – Join (with less, when you have less) or Not now. */
function BattleInvite({ st, host }) {
  const { linkSessions, wagerRef } = useApp();
  const [money, setMoney] = useState(undefined);
  useEffect(() => {
    let alive = true;
    Promise.resolve(wagerRef?.current?.money?.()).catch(() => null).then((m) => alive && setMoney(Number.isFinite(m) ? m : null));
    return () => { alive = false; };
  }, [st.sid]);
  const lang = currentLang();
  const offer = st.wager?.offer || 0;
  const stake = Number.isFinite(money) ? Math.min(offer, money) : offer;
  const fmt = { single: t('linkplay.fmtSingle', 'Single battle'), double: t('linkplay.fmtDouble', 'Double battle'), multi: t('linkplay.fmtMulti', 'Multi battle (2 vs 2)') }[st.format] || null;
  return html`<div class="grow stack-s battle-invite">
      <span><b>${t('linkplay.challenged', '{name} challenges you!', { name: host })}</b>
        ${fmt && html`<span class="chip small">${fmt}</span>`}
        ${offer ? html`<span class="chip small wager">${t('linkplay.forAmount', 'for {amount}', { amount: moneyText(offer, lang) })}</span>` : ''}</span>
      ${offer ? html`<span class="small muted">${t('linkplay.wagerExplain', 'The loser’s game pays the winner’s, as soon as both are back in their own game.')}
        ${Number.isFinite(money) && money < offer ? html` <b>${t('linkplay.wagerLess', 'You have {have} – you’d play for {amount}.', { have: moneyText(money, lang), amount: moneyText(stake, lang) })}</b>` : ''}</span>` : ''}
      <span class="small muted">${t('linkplay.saveFirst', 'Save in your game first – the link starts from your last in-game save.')}</span>
    </div>
    <button class="btn small primary" disabled=${offer > 0 && stake <= 0} onClick=${() => linkSessions.accept({ wager: stake })}>${offer ? t('linkplay.joinFor', 'Join for {amount}', { amount: moneyText(stake, lang) }) : t('linkplay.join', 'Join')}</button>
    <button class="btn small ghost" onClick=${() => linkSessions.decline()}>${t('linkplay.notNow', 'Not now')}</button>`;
}

/**
 * After a battle session: who won, what the wager moved, the record between you – once every player's computer read the
 * same result (web/lib/wager.mjs); until then "comparing", and why nothing counts when they don't agree.
 */
function BattleResult({ st, names }) {
  const { doc, me } = useApp();
  if (!doc || !st.sid || !st.ended || st.ended.reason === 'declined') return null;
  const entries = sessionsIn(doc)[st.sid];
  if (!entries) return null;
  const o = outcomeOf(entries);
  const lang = currentLang();
  const name = (s) => names[s]?.name || s;
  if (o.state === 'pending') return html`<span class="small muted">${t('linkplay.resultPending', 'Comparing the battle’s result with the others …')}</span>`;
  if (o.state === 'void') {
    if (st.kind !== 'battle') return null;
    const why = { desync: t('linkplay.voidDesync', 'the games fell out of step'), rejoin: t('linkplay.voidRejoin', 'a game dropped out of the link'),
      unread: t('linkplay.voidUnread', 'souldew can’t read the result in this game'), differs: t('linkplay.voidDiffers', 'your computers read different results') }[o.why] || t('linkplay.voidOther', 'the result isn’t clear');
    return html`<div class="link-result void"><b>${t('linkplay.noResult', 'No result')}</b><span class="small muted">${st.stake ? t('linkplay.voidWager', '{why} – the wager is off, nobody pays.', { why }) : why}</span></div>`;
  }
  const s = o.summary;
  if (!s.battles) return null;
  const { delta, settled } = wagerStatus(doc, st.sid, me, o.pays);
  const other = o.seats.find((x) => x !== me);
  const rec = other && o.seats.length === 2 ? headToHead(doc, me, other) : null;
  const head = s.draw ? t('linkplay.resultDraw', 'A draw')
    : s.winners.includes(me) ? (s.multi ? t('linkplay.resultWonTeam', 'You and {name} won!', { name: name(s.winners.find((x) => x !== me)) }) : t('linkplay.resultWon', 'You won!'))
      : s.losers.includes(me) ? t('linkplay.resultLost', '{name} won', { name: s.winners.map(name).join(' & ') })
        : t('linkplay.resultOthers', '{name} won', { name: s.winners.map(name).join(' & ') });
  return html`<div class=${`link-result ${s.draw ? 'draw' : s.winners.includes(me) ? 'won' : 'lost'}`} data-result=${s.draw ? 'draw' : s.winners.includes(me) ? 'won' : 'lost'}>
    <${Icon} name="bolt" size=${18} />
    <div class="stack-s" style="gap:2px">
      <b>${head}${s.battles > 1 ? html` <span class="num">${s.score[0]} : ${s.score[1]}</span>` : ''}</b>
      <span class="small">${[delta > 0 ? t('linkplay.resultGot', '+{amount} for you', { amount: moneyText(delta, lang) }) : delta < 0 ? (settled ? t('linkplay.resultPaid', '{amount} paid', { amount: moneyText(-delta, lang) })
          : t('linkplay.resultToPay', '{amount} to pay once you walk around in your game again', { amount: moneyText(-delta, lang) })) : null,
        rec ? t('linkplay.h2h', '{me} {a} : {b} {name}', { me: name(me), a: rec.a, b: rec.b, name: name(other) }) : null].filter(Boolean).join(' · ')}</span>
    </div>
  </div>`;
}

/** The phases in which the bar asks the player something (or tells how the link ended): shown even with the dock folded. */
export const LINK_ASKS = ['invited', 'need', 'rejoinable', 'ended'];

/**
 * What the link is doing: an invite to answer, the preparation, the running link (with Leave), how it ended.
 * Over the page at the top – or, while the game is big (views/play.mjs), `inline` in its dock, or `stage`: over the top
 * of the game when the dock is folded and the bar asks something.
 */
export function LinkBar({ inline = false, stage = false } = {}) {
  const { doc, manifest, linkPlay: st, linkSessions } = useApp();
  if (!st || !linkSessions || st.phase === 'idle') return null;
  const names = getPlayers(doc, manifest);
  const others = (st.seats || []).filter((s) => s !== linkSessions.me).map((s) => names[s]?.name || s).join(', ');
  const host = names[st.host]?.name || st.host;
  const kind = st.kind === 'battle' ? t('linkplay.kindBattle', 'battle') : t('linkplay.kindTrade', 'trade');
  const route = routeText(st.route);
  let body;
  if (st.phase === 'invited' && st.kind === 'battle' && (st.wager?.offer || st.format)) {
    body = html`<${BattleInvite} st=${st} host=${host} />`;
  } else if (st.phase === 'invited') {
    body = html`<span class="grow">${st.kind === 'battle' ? t('linkplay.invitedBattle', '{name} wants to battle you!', { name: host }) : t('linkplay.invitedTrade', '{name} wants to trade Pokémon with you!', { name: host })}
        <span class="small muted"> ${t('linkplay.saveFirst', 'Save in your game first – the link starts from your last in-game save.')}</span></span>
      <button class="btn small primary" onClick=${() => linkSessions.accept()}>${t('linkplay.join', 'Join')}</button>
      <button class="btn small ghost" onClick=${() => linkSessions.decline()}>${t('linkplay.notNow', 'Not now')}</button>`;
  } else if (st.phase === 'inviting' || st.phase === 'preparing') {
    const bet = st.kind === 'battle' ? wagerNote(st, names) : null;
    body = html`<span class="grow">${st.phase === 'inviting' ? t('linkplay.waitingFor', 'Waiting for {name} to join the {kind} …', { name: others, kind }) : t('linkplay.preparing', 'Getting the link ready: checking the games, swapping saves …')}
        ${bet && html`<span class="small muted"> · ${bet}</span>`}${route && html`<span class="small muted"> · ${route}</span>`}</span>
      <button class="btn small ghost" onClick=${() => linkSessions.leave('left')}>${t('common.cancel', 'Cancel')}</button>`;
  } else if (st.phase === 'need') {
    body = html`<div class="grow stack small"><b>${t('linkplay.needTitle', 'One more thing before the link starts')}</b><${NeedRoms} st=${st} names=${names} /></div>
      <button class="btn small ghost" onClick=${() => linkSessions.leave('left')}>${t('common.cancel', 'Cancel')}</button>`;
  } else if (st.phase === 'running') {
    const waiting = st.waiting && Date.now() - st.waiting.at < 1500;
    body = html`<span class="grow"><b>${t('linkplay.linked', 'Linked with {name}', { name: others })}</b>
        <span class="small muted"> · ${waiting ? t('linkplay.waitingPartner2', 'waiting for {name} … (if their game dropped out, they can rejoin)', { name: others }) : t('linkplay.delay', 'delay {n} frames', { n: st.delay })}
        ${route && html` · <span class="link-route" data-route=${Object.values(st.route || {}).some((r) => r?.route === 'relayed') ? 'relayed' : 'direct'}>${route}</span>`}
        · ${meetText(st.system || manifest?.game?.system)}${st.stake ? html` · <span class="link-stake">${t('linkplay.forAmount', 'for {amount}', { amount: moneyText(st.stake, currentLang()) })}</span>` : ''}</span></span>
      <button class="btn small" onClick=${() => linkSessions.leave('left')}>${t('linkplay.leave', 'Leave link')}</button>`;
  } else if (st.phase === 'rejoinable' || st.phase === 'rejoining') {
    body = html`<span class="grow">${st.phase === 'rejoining' ? t('linkplay.rejoining', 'Rejoining the link – getting the games from the others …') : t('linkplay.rejoinOffer', 'Your link with {name} was cut off. The others are waiting – rejoin?', { name: others })}</span>
      ${st.phase === 'rejoinable' && html`<button class="btn small primary" onClick=${() => linkSessions.rejoin()}>${t('linkplay.rejoin', 'Rejoin')}</button>`}
      <button class="btn small ghost" onClick=${() => linkSessions.leave('left')}>${t('linkplay.dropIt', 'Leave it')}</button>`;
  } else if (st.phase === 'ended') {
    const r = st.ended?.restored;
    body = html`<div class="grow stack-s"><${BattleResult} st=${st} names=${names} />
        <span>${reasonText(st.ended?.reason || st.error, others || host)}${r?.backup ? html` <span class="small muted">(${r.backup})</span>` : ''}</span></div>
      <button class="btn small ghost" onClick=${() => linkSessions.dismiss()}>${t('common.close', 'Close')}</button>`;
  }
  return html`<div class=${`link-bar panel row ${inline ? 'inline' : stage ? 'stage' : ''}`} data-phase=${st.phase} role="status" aria-live="polite"><${Icon} name="link" size=${16} />${body}</div>`;
}
