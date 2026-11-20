// Raids in the UI (docs/MULTIPLAYER.md › "Raid", web/lib/raid.mjs): the board's way in, the invite, the raid's panel in
// the play view's dock (the shared pool per opponent, the players and their teams, the countdown and the waiting), and
// the result. Outside the play view the invite and the result come as a small card at the bottom of the app – the
// same place as rock-paper-scissors.
import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp, Sprite, HpBar } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { useRaid } from '../lib/raid.mjs';
import { speciesName } from '../lib/data.mjs';
import { players as getPlayers, slotsOf } from '../lib/run.mjs';
import { RAID, FULL, rosterOf, raidResult, durationText } from '/shared/raid.mjs';

const CSS = `
.raid{display:flex;flex-direction:column;gap:8px}
.raid-head{display:flex;align-items:center;gap:8px}
.raid-head .grow{flex:1;min-width:0}
.raid-head svg{color:var(--warn);flex:none}
.raid-say{font-size:12.5px;line-height:1.35;color:var(--ink-2)}
.raid-pools{display:flex;gap:6px;align-items:center}
.raid-pool{flex:1;min-width:0}
.raid-pool.now{flex:3}
.raid-pool .hp{margin-top:0;height:8px}
.raid-pool.down .hp{opacity:.35}
.raid-pool.now .hp{height:10px}
.raid-pct{font-variant-numeric:tabular-nums;font-size:12px;min-width:38px;text-align:right}
.raid-who{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px}
.raid-who span{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.raid-who i{font-style:normal;font-variant-numeric:tabular-nums;color:var(--ink-3)}
.raid-who .out{opacity:.5;text-decoration:line-through}
.raid-btns{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.raid-res{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12.5px}
.raid-res dt{color:var(--ink-3)}
.raid-res dd{margin:0}
.raid-cards{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:78;width:min(360px,calc(100vw - 32px))}
.cards-dock .raid-cards{position:static;transform:none;width:auto}
.raid-card{padding:10px 12px 12px;box-shadow:0 14px 30px #000a;animation:toast-in .22s cubic-bezier(.2,.8,.2,1)}
.raid-stage{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:10;width:min(420px,calc(100% - 24px));box-sizing:border-box;padding:10px 12px;border-left:3px solid var(--warn);box-shadow:0 18px 44px #000c}
.raid-start{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:-2px 0 10px}
@media (prefers-reduced-motion: reduce){.raid-card{animation:none}}
`;
let styled = false;
function useStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.append(el);
}

/** Why a partner can't be invited / a game can't take part – in words. */
export function raidWhyText(code, name = '') {
  return {
    offline: t('raid.whyOffline', '{name} isn’t online', { name }),
    old: t('raid.whyOld', '{name}’s souldew doesn’t know raids yet', { name }),
    game: t('raid.whyGame', '{name}’s game can’t take part in raids', { name }),
    busy: t('raid.whyBusy', '{name} is in another raid', { name }),
    ctr: t('raid.whyCtr', 'Not in the 3DS games: souldew can’t change the opponent’s HP there cleanly.'),
    hack: t('raid.whyHack', 'Not in this ROM hack: its battles aren’t laid out like the original game’s, so souldew doesn’t change the opponent’s HP there.'),
    version: t('raid.whyVersion', 'Not in this version of the game yet – raids are checked game by game, in the English versions first.'),
    unknown: t('raid.whyUnknown', 'Only in games souldew reads live.'),
  }[code] || '';
}

/** The same, in two words next to a name. */
const shortWhy = (code) => ({
  offline: t('raid.shortOffline', 'offline'),
  old: t('raid.shortOld', 'older souldew'),
  game: t('raid.shortGame', 'game can’t take part'),
  busy: t('raid.shortBusy', 'in another raid'),
}[code] || '');

const outText = (why) => ({
  wiped: t('raid.outWiped', 'team down'),
  left: t('raid.outLeft', 'left the battle'),
  desync: t('raid.outDesync', 'out of step'),
  quit: t('raid.outQuit', 'left the raid'),
  late: t('raid.outLate', 'didn’t start a battle'),
  gone: t('raid.outGone', 'connection lost'),
  unsupported: t('raid.outUnsupported', 'game can’t take part'),
}[why] || '');

const pct = (bp) => `${Math.ceil((bp / FULL) * 100)} %`;

/** The raid this player sees (an invite, the one they're in, one that just ended) and what to say about it. */
function useCurrent() {
  const { doc, manifest, me } = useApp();
  const hub = useRaid(doc);
  if (!hub || !manifest || !me) return null;
  const cur = hub.current();
  if (!cur) return null;
  const names = getPlayers(doc, manifest);
  const name = (s) => names[s]?.name || s.toUpperCase();
  return { hub, cur, name, me };
}

/** The players of a raid: name, state, team (Pokémon that can still fight). */
function Players({ cur, name, me }) {
  const { raid, seats, st } = cur;
  const list = st.phase === 'invite' ? raid.players : rosterOf(raid, seats);
  return html`<div class="raid-who">${list.map((s) => {
    const p = st.players[s];
    const tm = seats[s]?.tm;
    const state = p === 'invited' ? t('raid.stInvited', 'asked') : p === 'declined' ? t('raid.stDeclined', 'not this time')
      : p === 'out' ? outText(st.outWhy[s]) : p === 'done' ? t('raid.stDone', 'beat it') : p === 'battle' ? (tm ? `${tm[0]}/${tm[1]}` : t('raid.stBattle', 'in battle'))
        : st.phase === 'invite' ? t('raid.stIn', 'in') : t('raid.stReady', 'on the way');
    return html`<span key=${s} class=${p === 'out' || p === 'declined' ? 'out' : ''}><b class=${`who-${s}`}>${s === me ? t('raid.you', 'You') : name(s)}</b><i>${state}</i></span>`;
  })}</div>`;
}

/** The shared pool: one bar per opponent Pokémon, the one being fought big. */
function Pools({ pool, gen = 4, species = null }) {
  if (!pool.size) return null;
  const now = pool.pools.findIndex((p) => p > 0);
  return html`<div class="raid-pools" role="group" aria-label=${t('raid.pool', 'Shared HP')}>
    ${species && html`<${Sprite} id=${species} size=${30} gen=${gen} />`}
    ${pool.pools.map((bp, i) => html`<div key=${i} class=${`raid-pool ${i === now ? 'now' : ''} ${bp === 0 ? 'down' : ''}`}
      title=${t('raid.poolN', 'Pokémon {n}: {pct}', { n: i + 1, pct: pct(bp) })}><${HpBar} hp=${bp} max=${FULL} /></div>`)}
    <span class="raid-pct">${now >= 0 ? pct(pool.pools[now]) : '0 %'}</span>
  </div>`;
}

/** The result of a finished raid. */
function Result({ cur, name, me }) {
  const { doc } = useApp();
  const res = raidResult(cur.raid, cur.seats, cur.st);
  // (the time the log says: the moment the pool emptied – not the last game's final hit)
  const logged = doc?.get?.(`feed:raid-${cur.id}`)?.ms;
  if (Number.isFinite(logged)) res.ms = logged;
  return html`<dl class="raid-res">
    ${res.mvp && html`<dt>${t('raid.mvp', 'Most damage')}</dt><dd><b class=${`who-${res.mvp}`}>${res.mvp === me ? t('raid.you', 'You') : name(res.mvp)}</b> · ${t('raid.mvpShare', '{pct} of it', { pct: `${Math.round((res.dealt[res.mvp] / Math.max(1, Object.values(res.dealt).reduce((a, b) => a + b, 0))) * 100)} %` })}</dd>`}
    <dt>${t('raid.survivors', 'Still standing')}</dt><dd>${res.survivors.length ? res.survivors.map((s) => (s === me ? t('raid.you', 'You') : name(s))).join(', ') : t('raid.nobody', 'nobody')}</dd>
    ${res.ms !== null && html`<dt>${t('raid.time', 'Time')}</dt><dd class="num">${durationText(res.ms)}</dd>`}
  </dl>`;
}

/**
 * The raid as one block: the head line, what's going on, the pool, the players, the buttons. `where`: 'dock' (the play
 * view), 'card' (the app's bottom card), 'stage' (over the game while the dock is folded).
 */
function RaidBlock({ c, where, species = null, gen = 4 }) {
  const { hub, cur, name, me } = c;
  const { raid, st } = cur;
  const host = raid.host === me;
  const my = st.players[me];
  const others = raid.players.filter((s) => s !== me);
  let title = t('raid.title', 'Raid');
  let say = '';
  const btns = [];
  const now = Date.now();
  if (st.phase === 'invite') {
    if (host) {
      say = t('raid.waitAnswers', 'Asked {names} – the raid starts once they answered.', { names: others.map(name).join(', ') });
      btns.push(html`<button class="btn small ghost" onClick=${() => hub.cancel(raid.id)}>${t('raid.callOff', 'Call it off')}</button>`);
    } else if (my === 'invited') {
      title = t('raid.invited', '{name} starts a raid', { name: name(raid.host) });
      say = t('raid.inviteText', 'Together against the next trainer you all fight – one shared HP pool, so it’s beaten in everyone’s game at once. {deaths}', {
        deaths: raid.deaths ? t('raid.deathsOn', 'Pokémon that go down in it count.') : t('raid.deathsOff', 'Pokémon that go down in it don’t count.'),
      });
      btns.push(html`<button class="btn small primary" onClick=${() => hub.answer(raid.id, true)}>${t('raid.join', 'Join')}</button>`,
        html`<button class="btn small ghost" onClick=${() => hub.answer(raid.id, false)}>${t('raid.notNow', 'Not now')}</button>`);
    } else say = t('raid.joined', 'You’re in – waiting for the others to answer.');
  } else if (st.phase === 'countdown') {
    say = t('raid.countdown', 'Starts in {s} s – then walk into your next trainer battle.', { s: Math.ceil((st.left || 0) / 1000) });
  } else if (st.phase === 'hunt' || st.phase === 'fight') {
    // the opponent out in this player's game (randomized games: each has their own)
    const boss = species || cur.seats[me]?.bs;
    if (st.phase === 'fight' && boss) title = t('raid.titleBoss', 'Raid · {name}', { name: speciesName(boss) });
    if (my === 'out') say = t('raid.youOut', 'You’re out ({why}) – watch the others finish it.', { why: outText(st.outWhy[me]) });
    else if (my === 'done') say = t('raid.youDone', 'You beat it in your game – the others are still on it.');
    else if (hub.holding()) {
      const waiting = rosterOf(raid, cur.seats).filter((s) => !cur.seats[s]?.b && !cur.seats[s]?.out).map(name);
      say = t('raid.holding', 'Your game waits for {names} to start their battle (at most {s} s).', { names: waiting.join(', '), s: Math.round(RAID.waitMs / 1000) });
    } else if (my === 'ready') say = t('raid.goFight', 'Raid on – walk into your next trainer battle.');
    else if (st.pool.size && st.pool.pools.every((p) => p === 0)) say = t('raid.lastHit', 'The pool is empty – one more hit finishes it in your game.');
    else say = t('raid.fighting', 'Every hit in anybody’s game comes off this pool.');
    if (my !== 'out' && my !== 'done') btns.push(html`<button class="btn small ghost" onClick=${() => hub.leave(raid.id)}>${t('raid.leave', 'Leave the raid')}</button>`);
  } else if (st.phase === 'won') {
    title = t('raid.won', 'Raid won!');
    const p = hub.players.get(raid.id);
    if (p && p.key && !p.ended) say = t('raid.lastHit', 'The pool is empty – one more hit finishes it in your game.');
  } else if (st.phase === 'lost') title = t('raid.lost', 'Raid lost');
  const over = st.phase === 'won' || st.phase === 'lost';
  if (over) btns.push(html`<button class="btn small" onClick=${() => hub.dismiss(raid.id)}>${t('common.close', 'Close')}</button>`);
  void now;
  return html`<section class=${`raid ${where === 'card' ? 'raid-card panel' : where === 'stage' ? 'raid-stage panel' : ''}`} role=${over ? 'status' : 'region'} aria-live="polite" aria-label=${t('raid.title', 'Raid')}>
    <div class="raid-head"><${Icon} name="bolt" size=${16} /><b class="grow">${title}</b></div>
    ${say && html`<div class="raid-say">${say}</div>`}
    ${(st.phase === 'fight' || st.phase === 'lost') && html`<${Pools} pool=${st.pool} species=${species || cur.seats[me]?.bs || Object.values(cur.seats).map((s) => s?.bs).find(Boolean) || null} gen=${gen} />`}
    ${over ? html`<${Result} cur=${cur} name=${name} me=${me} />` : html`<${Players} cur=${cur} name=${name} me=${me} />`}
    ${btns.length > 0 && html`<div class="raid-btns">${btns}</div>`}
  </section>`;
}

/** The play view's dock section (and over the game while the dock is folded): null when there is no raid to show. */
export function raidSection({ species = null, gen = 4, folded = false } = {}) {
  return { id: 'raid', label: t('raid.title', 'Raid'), icon: 'bolt', node: html`<${RaidDock} species=${species} gen=${gen} />`, folded };
}
export function RaidDock({ species, gen, stage = false }) {
  useStyle();
  const c = useCurrent();
  if (!c) return null;
  c.hub.shownInPlay = Date.now();
  return html`<${RaidBlock} c=${c} where=${stage ? 'stage' : 'dock'} species=${species} gen=${gen} />`;
}
/** Is there a raid to show in the play view right now (its dock section is added then)? */
export function useRaidShown() {
  const c = useCurrent();
  return c ? { phase: c.cur.st.phase, asks: c.cur.st.phase === 'invite' && c.cur.st.players[c.me] === 'invited', over: c.cur.st.phase === 'won' || c.cur.st.phase === 'lost' } : null;
}

/** The app-wide card: an invite or a result while the play view doesn't show it (mount once). */
export function RaidCards() {
  useStyle();
  const c = useCurrent();
  const { session, route } = useApp();
  if (!c) return null;
  const st = c.cur.st;
  // the play view shows the raid itself while it's open in full
  if (session && route?.route === 'play') return null;
  const asks = st.phase === 'invite' && st.players[c.me] === 'invited';
  const over = st.phase === 'won' || st.phase === 'lost';
  if (!asks && !over && st.phase !== 'countdown') return null;
  return html`<div class="raid-cards"><${RaidBlock} c=${c} where="card" /></div>`;
}

/**
 * The board's way in: "Raid" → the partners to ask (online ones whose souldew and game can take part), then start.
 * `online`: the slots connected right now.
 */
export function RaidStart({ online = null }) {
  useStyle();
  const { doc, manifest, me } = useApp();
  const hub = useRaid(doc);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(null);
  const [why, setWhy] = useState('');
  if (!hub || !manifest || !hub.available()) return null;
  if (online) hub.online = online;
  const names = getPlayers(doc, manifest);
  const name = (s) => names[s]?.name || s.toUpperCase();
  const others = slotsOf(manifest).filter((s) => s !== me);
  if (!others.length) return null;
  const busy = hub.activeFor();
  const mine = hub.capOf(me)?.game;
  const myWhy = mine && !mine.ok ? raidWhyText(mine.why) : '';
  const can = Object.fromEntries(others.map((s) => [s, hub.canInvite(s)]));
  const chosen = pick || others.filter((s) => can[s].ok);
  const start = () => {
    const r = hub.start(chosen.filter((s) => can[s].ok));
    if (r?.error) setWhy(r.error === 'busy' ? t('raid.busyMine', 'You’re in a raid already.') : t('raid.nobodyCan', 'Nobody can join right now.'));
    else (setOpen(false), setWhy(''), setPick(null));
  };
  if (!open) {
    return html`<button type="button" class="btn ghost" disabled=${!!busy} onClick=${() => setOpen(true)}
      title=${busy ? t('raid.busyMine', 'You’re in a raid already.') : t('raid.startHint', 'Fight the next trainer together: one shared HP pool for all of you.')}>
      <${Icon} name="bolt" size=${16} />${t('raid.title', 'Raid')}</button>`;
  }
  return html`<div class="raid-start" role="group" aria-label=${t('raid.title', 'Raid')}>
    <span class="small muted">${t('raid.with', 'Raid with:')}</span>
    ${others.map((s) => html`<label class="check small" key=${s} title=${can[s].ok ? '' : raidWhyText(can[s].why, name(s))}>
      <input type="checkbox" disabled=${!can[s].ok} checked=${can[s].ok && chosen.includes(s)} onChange=${(e) => setPick(e.currentTarget.checked ? [...new Set([...chosen, s])] : chosen.filter((x) => x !== s))} />
      <span class=${`who-${s}`}>${name(s)}</span>${!can[s].ok && html`<span class="tiny muted"> · ${shortWhy(can[s].why)}</span>`}</label>`)}
    <button type="button" class="btn small primary" disabled=${!chosen.some((s) => can[s].ok) || !!myWhy} onClick=${start}>${t('raid.start', 'Start the raid')}</button>
    <button type="button" class="btn small ghost" onClick=${() => (setOpen(false), setWhy(''), setPick(null))}>${t('common.cancel', 'Cancel')}</button>
    <span class="small muted" style="flex-basis:100%">${myWhy || t('raid.startText', 'The next trainer battle each of you starts is the raid: every hit in anybody’s game comes off one shared HP pool.')}</span>
    ${why && html`<span class="small warning">${why}</span>`}
  </div>`;
}
