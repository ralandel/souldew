// The play screen's cheats menu (one button in the dock): items into the bag – Rare Candies, Max Repels, Poké Balls,
// healing items – with how many, and money. The cheats themselves and which game gets which: shared/live/cheats.mjs
// (CHEATS, cheatSupported – a cheat that wasn't checked in a game's bag is left out there); which a run allows:
// shared/rules.mjs cheatSet (the host's call in a SoulLink). web/views/play.mjs asks before writing (cheatConfirmText),
// writes and logs.
import { html } from '/vendor/htm-preact.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { itemNameByKey } from '../lib/data.mjs';
import { moneyText } from '/shared/linkbattle.mjs';
import { CHEATS, CHEAT_AMOUNTS, MONEY_STEPS, MONEY_MAX } from '/shared/live/cheats.mjs';

/** A cheat item's name in the app's language (PokeAPI's), its English one where the names aren't loaded. */
export const cheatItemName = (id) => itemNameByKey(CHEATS[id]?.key) || CHEATS[id]?.en || id;

/** "10 × Master Ball", "Master Ball" – an item cheat with its amount, as the log says it. */
export const cheatItemText = (id, n) => (n > 1 ? t('feed.itemCount', '{n} × {item}', { n, item: cheatItemName(id) }) : cheatItemName(id));

const money = (v) => moneyText(v, currentLang());

/** The icon of a cheat's row (souldew's own pixel icons). */
const ICON = { rareCandy: 'candy', maxRepel: 'repel', masterBall: 'ball', ultraBall: 'ball', pokeBall: 'ball', fullRestore: 'heart', revive: 'heart', maxRevive: 'heart' };

/** The question before a cheat is written: { id, amount } – an item and how many, or the money ('max' or ₽). */
export function cheatConfirmText({ id, amount }) {
  if (CHEATS[id]?.money) {
    return amount === 'max'
      ? t('cheat.confirmMoneyMax', 'Set your money to {money}, the most the game holds?', { money: money(MONEY_MAX) })
      : t('cheat.confirmMoney', 'Add {money} to your money?', { money: money(amount) });
  }
  return t('cheat.confirmItem', 'Add {what} to your bag?', { what: cheatItemText(id, amount) });
}

/** What a cheat that worked says: `res` – applyCheat's answer. */
export function cheatDoneText(id, res) {
  return CHEATS[id]?.money
    ? t('cheat.doneMoney', '+{money} – you have {total} now', { money: money(res.added), total: money(res.after) })
    : t('cheat.doneItem', '+{what} in your bag', { what: cheatItemText(id, res.added) });
}

/**
 * Why a cheat didn't work, for the toast: a title, the reason, and a line of details for a report (`res`: applyCheat's
 * answer; `where`: the game and bag layout, the amount).
 */
export function cheatFailText(id, res, { gen = 0, where = '' } = {}) {
  const isMoney = !!CHEATS[id]?.money;
  const title = isMoney ? t('cheat.failedMoney', 'Money not changed') : t('cheat.failedItem', 'No {item} added', { item: cheatItemName(id) });
  const reason = {
    // (a 3DS game: not where souldew knows it, not nearby either – or, without the game's own pocket table, an empty bag
    // that can't be told from other memory yet)
    notFound: isMoney ? t('cheat.moneyNotFound', 'Your money wasn’t found in the game’s memory just now. Try again outside of menus and battles.')
      : gen >= 6 ? (res.why === 'empty' ? t('cheat.notFoundEmpty', 'Your bag looks empty, and souldew can’t tell an empty bag from other memory in this game. Pick up any item in the game, then try again.')
        : t('cheat.notFoundCtr', 'souldew couldn’t find your bag in the game’s memory – not where this game keeps it, and not nearby. “Save diagnostics” in the sound menu records where it looked; please send it along with a report.'))
        : res.why === 'empty' ? t('cheat.notFoundEmptyDs', 'Your bag is still empty, and souldew can’t be sure yet where the game keeps it. Pick up or buy any item first, then try again.')
          : t('cheat.notFound', 'Your bag wasn’t found in the game’s memory just now. Try again outside of menus and battles.'),
    changed: t('cheat.changed', 'The game changed your bag just then – try again.'),
    // (Gen 3: not while a battle, a menu, a text or a screen change holds the player – shared/live/cheats.mjs cheatIdle)
    busy: t('cheat.busy', 'Your game is busy right now – a battle, a menu, a text or a screen change. Try again in a moment, while you stand in the overworld.'),
    full: t('cheat.full', 'The bag pocket is full – make room and try again.'),
    max: isMoney ? t('cheat.moneyFull', 'You already have the most money the game holds ({money}).', { money: money(MONEY_MAX) })
      : t('cheat.maxItem', 'Your bag already holds as many of this item as the game allows ({what}).', { what: cheatItemText(id, res.before) }),
    unsupported: t('cheat.unsupported', 'Not available for this game.'),
  }[res.error] || t('cheat.writeFailed', 'The game’s memory couldn’t be changed.');
  const details = [res.error, res.why, where].filter(Boolean).join(' · ');
  return { title, text: `${reason}\n${t('cheat.details', 'Details: {details}', { details })}` };
}

/**
 * The menu's popover. `ids`: the cheats to show, in CHEATS order (this game's, those the run allows); `why`: why none can
 * be used right now (null: they can); `hint`: the line under them; `amount` / onAmount: how many of an item; onPick({ id,
 * amount }): a cheat chosen (the play view asks first); `ruleNote`: some of this game's cheats are off in the run's
 * rules; onRules: open them (a run whose rules allow none).
 */
export function CheatMenu({ ids, why, hint, amount, onAmount, onPick, ruleNote = false, onRules = null }) {
  const items = ids.filter((id) => !CHEATS[id].money);
  const withMoney = ids.includes('money');
  const off = !!why;
  return html`<div class="cheat-pop cheats-menu" role="dialog" aria-label=${t('cheat.title', 'Cheats')}>
    <div class="cheats-head">
      <b class="small">${t('cheat.title', 'Cheats')}</b>
      ${items.length > 0 && html`<div class="seg cheats-amount" role="radiogroup" aria-label=${t('cheat.amount', 'How many')} title=${t('cheat.amount', 'How many')}>
        ${CHEAT_AMOUNTS.map((n) => html`<button type="button" role="radio" aria-checked=${amount === n} class=${amount === n ? 'on' : ''} disabled=${off}
          onClick=${() => onAmount(n)}>×${n}</button>`)}
      </div>`}
    </div>
    ${items.length > 0 && html`<div class="cheats-items">
      ${items.map((id) => html`<button class="btn small" key=${id} disabled=${off} title=${cheatItemText(id, amount)} onClick=${() => onPick({ id, amount })}>
        <${Icon} name=${ICON[id] || 'plus'} size=${14} /><span class="ellipsis">${cheatItemName(id)}</span></button>`)}
    </div>`}
    ${withMoney && html`<div class="cheats-money" role="group" aria-label=${t('cheat.gMoney', 'Money')}>
      <span class="tiny muted cheats-label"><${Icon} name="coin" size=${12} />${t('cheat.gMoney', 'Money')}</span>
      ${MONEY_STEPS.map((v) => html`<button class="btn small" key=${v} disabled=${off} onClick=${() => onPick({ id: 'money', amount: v })}
        title=${v === 'max' ? t('cheat.moneyMaxHint', 'Set to {money}, the most the game holds', { money: money(MONEY_MAX) }) : ''}>${v === 'max' ? t('cheat.moneyMax', 'Max') : `+${money(v)}`}</button>`)}
    </div>`}
    <span class="tiny faint">${why || hint}</span>
    ${ruleNote && !why && html`<span class="tiny faint">${t('cheat.someOff', 'The other cheats are off in this run’s rules.')}</span>`}
    ${onRules && html`<button class="btn small ghost" onClick=${onRules}>${t('cheat.openRules', 'Open the rules')}</button>`}
  </div>`;
}
