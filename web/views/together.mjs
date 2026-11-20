// Playing together (docs/MULTIPLAYER.md › 9 "Playing together"): what the app shows of it outside the game picture –
// the cards for a gift and a "come here" (app-wide, like the rock-paper-scissors cards), the gift picker, the watch
// panel and the battle strip, the line on a partner's board card and the "Come to me" button. The hub is
// web/lib/together.mjs; inside a Gen 3 game the Shared World overlay shows the same things in the picture.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp, Modal, Sprite, HpBar } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { speciesName, giftItemName, moveName } from '../lib/data.mjs';
import { players as getPlayers } from '../lib/run.mjs';
import { useTogether, giftsAllowed } from '../lib/together.mjs';
import { togetherArtUrl } from '../lib/togetherart.mjs';
import { Watch, viewInfo, Picture } from './partnerscreen.mjs';
import { linkedText } from './linkplay.mjs';
import { GIFT_MAX } from '/shared/giftitems.mjs';
import { TG } from '/shared/together.mjs';

const nameOf = (doc, manifest, slot) => getPlayers(doc, manifest)[slot]?.name || String(slot || '').toUpperCase();
const color = (slot) => (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(`--${slot}`).trim()) || '#ebe6da';
const art = (name, slot, scale = 2) => html`<img class="tg-art" src=${togetherArtUrl(name, color(slot), scale)} alt="" />`;

/** "Potion", "3 × Potion" in this app's language. */
export function itemText(gen, item, n = 1) {
  const name = giftItemName(item, gen) || `#${item}`;
  return n > 1 ? t('feed.itemCount', '{n} × {item}', { n, item: name }) : name;
}

/** Why a gift can't happen (or didn't), in words – `name`: the partner. */
export function giftWhyText(why, name) {
  return {
    off: t('gift.off', 'Gifts are off in this run’s rules.'),
    old: t('gift.old', '{name}’s souldew can’t take gifts yet – it needs an update.', { name }),
    offline: t('gift.offline', '{name} isn’t online.', { name }),
    nogame: t('gift.nogame', 'Start your game here to give items.'),
    busy: t('gift.busy', 'A gift with {name} is still on its way.', { name }),
    battle: t('gift.battle', 'Not during a battle.'),
    overworld: t('gift.overworld', 'Only while walking around in the game – close menus and texts first.'),
    link: t('gift.link', 'Not during a link.'),
    waiting: t('gift.waiting', 'Available once live tracking has found your team.'),
    unsupported: t('gift.unsupported', 'souldew doesn’t know where this game keeps its bag.'),
    gen: t('gift.gen', '{name} plays a game of another generation – its items are numbered differently.', { name }),
    game: t('gift.game', '{name} plays another version – this item may not exist in their game.', { name }),
    full: t('gift.full', '{name}’s bag has no room for it.', { name }),
    short: t('gift.short', 'That’s no longer in your bag.'),
    declined: t('gift.declined', '{name} doesn’t want it right now.', { name }),
    refused: t('gift.refused', '{name} can’t take it right now.', { name }),
    expired: t('gift.expired', '{name} didn’t answer.', { name }),
    limit: t('gift.limit', 'Not so fast – try again in a few seconds.'),
    late: t('gift.late', 'It took too long, so nothing was given.'),
    unknown: t('gift.unknown', '{name}’s app didn’t get it, so nothing was given.', { name }),
    item: t('gift.item', 'This item can’t be given.'),
    cancel: t('gift.cancelled', 'Called off.'),
  }[why] || t('gift.write', 'The game’s memory couldn’t be changed – nothing was given.');
}

// ---- the cards ---------------------------------------------------------------------------------------------------------

/** Gifts on their way and partners' "come here" – app-wide, at the bottom (mount once). */
export function TogetherCards() {
  const { link, doc, manifest, me } = useApp();
  const h = useTogether(link);
  const [, tick] = useState(0);
  const [seen, setSeen] = useState({}); // ping id → when it was first shown here ('x' + id: closed)
  const gifts = h ? h.desk.list() : [];
  const pings = h ? (h.link.others || []).map((s) => h.pingOf(s)).filter(Boolean) : [];
  const pingIds = pings.map((p) => p.id).join();
  useEffect(() => {
    const add = pings.filter((p) => !seen[p.id]);
    if (add.length) setSeen((s) => ({ ...s, ...Object.fromEntries(add.map((p) => [p.id, Date.now()])) }));
  }, [pingIds]);
  // a ping shows as a card for a few seconds (the board keeps saying it until it's cleared); an offer counts down
  const showPing = (p) => !seen[`x${p.id}`] && Date.now() - (seen[p.id] || Date.now()) < 12000;
  const ticking = gifts.some((g) => !g.end && g.phase === 'offered') || pings.some(showPing);
  useEffect(() => {
    if (!ticking) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [ticking]);
  if (!h || !doc || !manifest) return null;
  const shown = pings.filter(showPing);
  if (!gifts.length && !shown.length) return null;
  return html`<div class="tg-cards" role="region" aria-label=${t('tg.cards', 'Playing together')}>
    ${shown.map((p) => html`<${PingCard} key=${p.id} p=${p} name=${nameOf(doc, manifest, p.slot)} onClose=${() => setSeen((s) => ({ ...s, [`x${p.id}`]: 1 }))} />`)}
    ${gifts.map((g) => html`<${GiftCard} key=${g.id} g=${g} h=${h} me=${me} name=${nameOf(doc, manifest, g.from === me ? g.to : g.from)} />`)}
  </div>`;
}

function PingCard({ p, name, onClose }) {
  const place = p.here?.name;
  return html`<section class="tg-card" style=${`--c:${color(p.slot)}`} aria-live="polite">
    <h4><${Icon} name="map" size=${14} /><span class="grow">${place ? t('ping.at', '{name} is at {place} – come here', { name, place }) : t('ping.come', '{name} calls you over', { name })}</span>
      <button class="btn icon ghost small" onClick=${onClose} aria-label=${t('common.close', 'Close')} title=${t('common.close', 'Close')}><${Icon} name="close" size=${12} /></button></h4>
    ${p.map !== undefined && html`<p class="tiny muted">${t('ping.arrowHint', 'In the game an arrow at the edge points the way when you’re on the same map.')}</p>`}
  </section>`;
}

function GiftCard({ g, h, me, name }) {
  const mine = g.from === me;
  const what = itemText(g.gen, g.item, g.n);
  const left = Math.max(0, (g.until || 0) - Date.now());
  let line;
  let tone = '';
  if (mine) {
    line = {
      asked: t('gift.waitingFor', 'Waiting for {name} to accept …', { name }),
      removing: t('gift.giving', 'Giving …'),
      sent: t('gift.sending', 'On its way to {name} …', { name }),
      unconfirmed: t('gift.unconfirmed', 'Waiting for {name}’s game to confirm – it’s out of your bag until it does, never given twice.', { name }),
      returning: t('gift.returning', '{name} couldn’t take it – putting it back into your bag …', { name }),
      done: t('gift.doneGiver', '{name} got it.', { name }),
      returned: t('gift.returned', '{name} couldn’t take it – it’s back in your bag.', { name }),
    }[g.phase] || giftWhyText(g.why || g.phase, name);
    tone = g.phase === 'done' ? 'ok' : g.end && g.phase !== 'done' ? 'bad' : '';
  } else {
    line = {
      offered: t('gift.offer', '{name} wants to give you this.', { name }),
      accepted: t('gift.accepting', 'Getting it …'),
      adding: t('gift.accepting', 'Getting it …'),
      done: t('gift.doneTaker', 'It’s in your bag.'),
      withdrawn: g.why && g.why !== 'cancel' ? t('gift.withdrawnWhy', '{name} couldn’t give it after all.', { name }) : t('gift.withdrawn', '{name} called it off.', { name }),
      declined: t('gift.youDeclined', 'Not this time.'),
    }[g.phase] || giftWhyText(g.why || g.phase, name);
    tone = g.phase === 'done' ? 'ok' : g.end && !['done', 'declined'].includes(g.phase) ? 'bad' : '';
  }
  const title = mine ? t('gift.toTitle', 'Gift for {name}', { name }) : t('gift.fromTitle', 'Gift from {name}', { name });
  return html`<section class=${`tg-card ${tone}`} style=${`--c:${color(mine ? g.to : g.from)}`} aria-live="polite">
    <h4>${art('gift', mine ? g.to : g.from)}<span class="grow">${title}</span><span class="tg-what">${what}</span></h4>
    <div class="tg-say">${line}</div>
    ${!mine && g.phase === 'offered' && html`<div class="tg-time" aria-hidden="true"><i style=${`width:${(left / TG.gift.askMs) * 100}%`}></i></div>
      <div class="row tg-actions"><button class="btn small primary" onClick=${() => h.desk.answer(g.id, true)}>${t('gift.accept', 'Accept')}</button>
        <button class="btn small ghost" onClick=${() => h.desk.answer(g.id, false)}>${t('gift.noThanks', 'No thanks')}</button></div>`}
    ${mine && g.phase === 'asked' && html`<div class="row tg-actions"><button class="btn small ghost" onClick=${() => h.desk.cancel(g.id)}>${t('common.cancel', 'Cancel')}</button></div>`}
  </section>`;
}

// ---- the gift picker ---------------------------------------------------------------------------------------------------

/** "Give {name} an item": what my bag can give, how many, then the partner is asked. */
export function GiftDialog({ slot, onClose }) {
  const { link, doc, manifest } = useApp();
  const h = useTogether(link);
  const [pick, setPick] = useState(null);
  const [n, setN] = useState(1);
  const [err, setErr] = useState('');
  const [list, setList] = useState(() => h?.giftable() || null);
  // the bag changes while you look: read again every second or so
  useEffect(() => {
    const id = setInterval(() => setList(h?.giftable() || null), 1200);
    return () => clearInterval(id);
  }, [h]);
  if (!h || !doc || !manifest) return null;
  const name = nameOf(doc, manifest, slot);
  const why = h.giftWhy(slot);
  const gen = h.desk.bag?.gen || 0;
  const cur = pick && list?.find((x) => x.item === pick.item && x.pocket === pick.pocket);
  const max = Math.min(GIFT_MAX, cur?.count || 1);
  const give = () => {
    if (!cur) return;
    const g = h.offer(slot, { item: cur.item, n: Math.min(n, max), pocket: cur.pocket });
    if (g?.error) setErr(giftWhyText(g.error, name));
    else onClose();
  };
  return html`<${Modal} open=${true} onClose=${onClose} title=${t('gift.title', 'Give {name} an item', { name })}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn primary" disabled=${!cur || !!why} onClick=${give}>${art('gift', slot)}${cur ? t('gift.giveWhat', 'Give {what}', { what: itemText(gen, cur.item, Math.min(n, max)) }) : t('gift.give', 'Give')}</button>`}>
    <div class="stack tg-gift">
      ${why ? html`<p class="small warning">${giftWhyText(why, name)}</p>` : html`<p class="small muted">${t('gift.how', '{name} gets asked first. It leaves your bag only once they said yes, and comes back if their game can’t take it.', { name })}</p>`}
      ${list === null && !why && html`<p class="small muted">${t('gift.noBag', 'Your bag can’t be read right now – walk around in the game for a moment and try again.')}</p>`}
      ${list && !list.length && html`<p class="small muted">${t('gift.empty', 'Nothing in your bag can be given.')}</p>`}
      ${list?.length > 0 && html`<div class="tg-items" role="listbox" aria-label=${t('gift.bag', 'Your bag')}>
        ${list.map((x) => {
          const on = cur && x.item === cur.item && x.pocket === cur.pocket;
          return html`<button type="button" role="option" aria-selected=${!!on} class=${`tg-item ${on ? 'on' : ''}`} onClick=${() => { setPick(x); setN(1); setErr(''); }}>
            <span class="grow ellipsis">${giftItemName(x.item, gen) || `#${x.item}`}</span><span class="mono tiny muted">× ${x.count}</span></button>`;
        })}
      </div>`}
      ${cur && max > 1 && html`<div class="row tg-count"><span class="small">${t('gift.howMany', 'How many?')}</span>
        <button class="btn icon small" disabled=${n <= 1} onClick=${() => setN(Math.max(1, n - 1))} aria-label=${t('gift.fewer', 'Fewer')}>−</button>
        <b class="mono" aria-live="polite">${Math.min(n, max)}</b>
        <button class="btn icon small" disabled=${n >= max} onClick=${() => setN(Math.min(max, n + 1))} aria-label=${t('gift.more', 'More')}>+</button>
        <button class="btn small ghost" onClick=${() => setN(max)}>${t('gift.all', 'All ({n})', { n: max })}</button></div>`}
      <p class="tiny faint">${t('gift.never', 'Key items, TMs/HMs and the Master Ball stay with you.')}</p>
      ${err && html`<p class="small warning" role="alert">${err}</p>`}
    </div>
  <//>`;
}

// ---- the battle strip and the watch panel ------------------------------------------------------------------------------

/** A partner's battle from live tracking: their Pokémon and HP, the opponent and its HP (and their moves). */
export function BattleStrip({ slot, variant = 'panel' }) {
  const { link, doc, manifest, runData } = useApp();
  const h = useTogether(link);
  const b = h?.battleOf(slot);
  if (!b || !doc || !manifest) return null;
  const gen = runData?.gen || 4;
  const foe = b.enemy;
  const mon = b.mon;
  const kind = b.kind === 'trainer' ? t('tg.trainer', 'Trainer battle') : t('tg.wild', 'Wild battle');
  // (the battle's own HP where the reader has it, else the team's – the live team follows the battle too)
  const hp = b.active?.maxHp > 0 && b.active.hp !== null ? { hp: b.active.hp, max: b.active.maxHp } : mon ? { hp: mon.hp, max: mon.maxHp } : null;
  if (variant !== 'panel') {
    return html`<div class="tg-strip" title=${kind}>${art('battle', slot, 1)}
      <span class="ellipsis">${mon ? `${mon.nick || speciesName(mon.species)} ` : ''}<span class="muted">${t('common.vs', 'vs')}</span> ${speciesName(foe.species)}${foe.level ? ` · ${t('common.lv', 'Lv')} ${foe.level}` : ''}</span>
      ${foe.maxHp > 0 && foe.hp !== null && html`<span class="tg-hp"><${HpBar} hp=${foe.hp} max=${foe.maxHp} /></span>`}</div>`;
  }
  const moves = (mon?.moves || []).filter(Boolean).slice(0, 4);
  return html`<div class="tg-battle" aria-label=${kind}>
    <div class="tg-side">
      ${mon && html`<${Sprite} id=${mon.species} shiny=${mon.shiny} gen=${gen} size=${56} form=${mon.form || 0} />`}
      <div class="stack-s grow"><b class="small">${mon ? mon.nick || speciesName(mon.species) : nameOf(doc, manifest, slot)}${mon?.level ? html` <span class="tiny muted">${t('common.lv', 'Lv')} ${mon.level}</span>` : ''}</b>
        ${hp?.max > 0 && hp.hp !== null && html`<${HpBar} hp=${hp.hp} max=${hp.max} /><span class="tiny mono muted">${hp.hp}/${hp.max}</span>`}
        ${moves.length > 0 && html`<span class="tiny muted ellipsis">${moves.map((m) => moveName(m) || `#${m}`).join(' · ')}</span>`}</div>
    </div>
    <span class="tg-vs">${art('battle', slot, 2)}<span class="tiny muted">${kind}</span></span>
    <div class="tg-side">
      <${Sprite} id=${foe.species} shiny=${foe.shiny} gen=${gen} size=${56} form=${foe.form || 0} />
      <div class="stack-s grow"><b class="small">${speciesName(foe.species)}${foe.level ? html` <span class="tiny muted">${t('common.lv', 'Lv')} ${foe.level}</span>` : ''}</b>
        ${foe.maxHp > 0 && foe.hp !== null ? html`<${HpBar} hp=${foe.hp} max=${foe.maxHp} /><span class="tiny mono muted">${foe.hp}/${foe.maxHp}</span>`
          : html`<span class="tiny faint">${t('tg.noHp', 'HP shows once {name} updates souldew', { name: nameOf(doc, manifest, slot) })}</span>`}</div>
    </div>
  </div>`;
}

/** Watch: the partner's picture, live (the partner screens' stream), with the battle strip under it. */
export function WatchModal({ slot, onClose }) {
  const { link, doc, manifest } = useApp();
  const h = useTogether(link);
  const [view, setView] = useState(null);
  const [ar, setAr] = useState(null);
  if (!doc || !manifest) return null;
  const name = nameOf(doc, manifest, slot);
  const system = manifest.game?.system;
  const info = viewInfo(view, system, ar, Date.now());
  const fighting = !!h?.battleOf(slot);
  return html`<${Modal} open=${true} onClose=${onClose} wide title=${fighting ? t('watch.titleBattle', '{name} – in a battle', { name }) : t('watch.title', '{name}’s game', { name })}>
    <${Watch} link=${link} slot=${slot} onView=${(s, v) => setView(v)} />
    <div class="stack tg-watch">
      <div class="tg-screen" style=${`--ar:${info.ar}`}><${Picture} info=${info} name=${name} onMeasure=${(r) => setAr(r)} /></div>
      ${fighting ? html`<${BattleStrip} slot=${slot} />` : html`<p class="small muted">${t('watch.notFighting', '{name} isn’t in a battle right now.', { name })}</p>`}
    </div>
  <//>`;
}

// ---- the board card and the play view ----------------------------------------------------------------------------------

/** On a partner's board card: in a battle (Watch), their "come here", Give item. */
export function PartnerTogether({ slot, onWatch = null }) {
  const { link, doc, manifest, me, onlineSlots, linkSessions } = useApp();
  const h = useTogether(link);
  const [gift, setGift] = useState(false);
  const [watch, setWatch] = useState(false);
  if (!h || !doc || !manifest || slot === me) return null;
  const name = nameOf(doc, manifest, slot);
  const b = h.battleOf(slot);
  const p = h.pingOf(slot);
  // (linked with other players right now: the board's own words for it – their game can't take a gift there)
  const away = linkedText(linkSessions, slot, getPlayers(doc, manifest));
  const giftWhy = away ? 'link' : h.giftWhy(slot);
  // the button only where a gift can happen at all: the rule on, my game running here, their app knows gifts
  const giftable = giftsAllowed(doc, manifest) && !!h.desk.bag && h.can(slot, 'gift') && onlineSlots?.has?.(slot) !== false;
  if (!b && !p && !giftable) return null;
  return html`<div class="tg-line">
    ${b && html`<span class="tg-chip">${art('battle', slot, 1)}<span class="ellipsis">${b.kind === 'trainer' ? t('tg.inTrainer', 'In a battle with a trainer – {mon}', { mon: speciesName(b.enemy.species) })
      : t('tg.inWild', 'In a battle – wild {mon}', { mon: speciesName(b.enemy.species) })}</span></span>
      <button class="btn small" onClick=${() => (onWatch ? onWatch(slot) : setWatch(true))}><${Icon} name="eye" size=${14} />${t('world.watch', 'Watch')}</button>`}
    ${p && html`<span class="tg-chip ping"><${Icon} name="map" size=${12} /><span class="ellipsis">${p.here?.name ? t('ping.at', '{name} is at {place} – come here', { name, place: p.here.name }) : t('ping.come', '{name} calls you over', { name })}</span>
      <button class="btn icon ghost small" onClick=${() => h.dismissPing(slot)} aria-label=${t('common.close', 'Close')} title=${t('common.close', 'Close')}><${Icon} name="close" size=${10} /></button></span>`}
    ${giftable && html`<button class="btn small" disabled=${!!giftWhy} title=${away || (giftWhy ? giftWhyText(giftWhy, name) : null) || t('gift.hint', 'Give {name} an item from your bag', { name })} onClick=${() => setGift(true)}>
      ${art('gift', slot, 1)}${t('world.gift', 'Give item')}</button>`}
    ${gift && html`<${GiftDialog} slot=${slot} onClose=${() => setGift(false)} />`}
    ${watch && html`<${WatchModal} slot=${slot} onClose=${() => setWatch(false)} />`}
  </div>`;
}

/** "Come to me" (the play view, next to the Shared World switches): marks where you are for every partner. */
export function PingButton() {
  const { link, doc, manifest } = useApp();
  const h = useTogether(link);
  const [msg, setMsg] = useState('');
  if (!h || !doc || !manifest || !(h.link.others || []).length) return null;
  const on = !!h.myPing;
  const click = () => {
    if (on) return h.unping();
    const r = h.ping();
    setMsg(r?.error === 'limit' ? t('ping.limit', 'Not so fast – try again in a few seconds.') : '');
  };
  return html`<button type="button" class=${`btn small ghost tg-ping ${on ? 'on' : ''}`} aria-pressed=${on} onClick=${click}
    title=${on ? t('ping.cancelHint', 'Take it back') : t('ping.hint', 'Your partners see where you are: an arrow in their game on the same map, else the board says where.')}>
    <${Icon} name="map" size=${12} />${on ? t('ping.calling', 'Calling them over · take back') : t('ping.button', 'Come to me')}</button>
    ${msg && html`<span class="tiny warning">${msg}</span>`}`;
}
