// "No partner yet? Find one on the souldew Discord" – a small secondary action where a player is about to start a
// SoulLink without a partner (the new-run wizard's "Who plays", the Friends page with no friends yet). It makes the same
// post as the Discord bot's partner finder in #find-a-partner – game, partners, language and time zone, when you play,
// rules – prefilled, as the player's own Discord account (the accounts service hands it to the bot, API.md §14), then
// opens it on Discord. Signed out it offers the sign-in instead. Nothing is posted without the player pressing "Post".
import { html, useState } from '/vendor/htm-preact.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { Modal, useApp, openExternal } from '../lib/ui.mjs';
import { LINKS } from '../lib/links.mjs';
import { useAccount, findPartner } from '../lib/account.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { langAndZone } from '../lib/lfg.mjs';
import { EDITION } from '/shared/edition.mjs';

/** What went wrong, in words – and, for an open post, its link. */
function problem(e) {
  const code = e?.vars?.code;
  if (code === 'lfg_active') return { text: t('lfg.active', 'You already have an open post on the souldew Discord. Close it there with “Found / close” to make a new one – or wait, posts close by themselves after 7 days.'), url: e.vars.url || null };
  if (code === 'lfg_not_member') return { text: t('lfg.notMember', 'Join the souldew Discord server first – the post goes up there.'), join: true };
  if (code === 'text_rejected') return { text: t('lfg.rejected', 'The post wasn’t sent: {reason}.', { reason: e.vars.reason || t('lfg.rejectedWhy', 'something in it isn’t allowed (links, mentions, certain words)') }) };
  if (code === 'rate_limited') return { text: t('lfg.tooMany', 'That’s enough posts for today – try again tomorrow.') };
  if (code === 'invalid_field') return { text: t('lfg.fill', 'Please fill in the game, your language and when you play.') };
  return { text: t('lfg.failed', 'The souldew Discord can’t be reached right now – try again in a moment.') };
}

/** The form, prefilled. game / partners / rules come from where it was opened. */
export function FindPartnerModal({ game = '', partners = 1, rules = '', onClose }) {
  const { toast } = useApp();
  const [v, setV] = useState(() => ({ game: game.slice(0, 60), partners: Math.min(3, Math.max(1, partners)), lang: langAndZone(currentLang()), schedule: '', rules: rules.slice(0, 300) }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: k === 'partners' ? Number(e.target.value) : e.target.value });
  const ready = v.game.trim().length >= 2 && v.lang.trim().length >= 2 && v.schedule.trim().length >= 2;
  const post = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await findPartner(v);
      toast({ kind: 'ok', title: t('lfg.posted', 'Your post is up on the souldew Discord'), text: t('lfg.postedText', 'Whoever clicks “I’m in” gets a private thread with you.') });
      openExternal(r.url);
      onClose();
    } catch (e) {
      setErr(problem(e));
    }
    setBusy(false);
  };
  return html`<${Modal} open onClose=${onClose} title=${t('lfg.title', 'Find a SoulLink partner')}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn go" disabled=${!ready || busy} onClick=${post}><${Icon} name="external" size=${14} />${t('lfg.post', 'Post on Discord')}</button>`}>
    <div class="stack">
      <p class="small muted">${t('lfg.intro', 'Your post goes up in #find-a-partner on the souldew Discord, under your Discord name. Whoever clicks “I’m in” joins a private thread with you to plan the run.')}</p>
      <div class="grid-2">
        <label class="field"><span>${t('lfg.game', 'Game')}</span><input type="text" value=${v.game} maxLength="60" placeholder=${t('lfg.gamePh', 'e.g. Emerald, Radical Red, Platinum')} onInput=${set('game')} /></label>
        <label class="field"><span>${t('lfg.partners', 'Partners wanted')}</span><select value=${v.partners} onChange=${set('partners')}>
          ${[1, 2, 3].map((n) => html`<option value=${n}>${t('lfg.partnersN', '{count} partner ({players} players)|{count} partners ({players} players)', { count: n, players: n + 1 })}</option>`)}</select></label>
      </div>
      <label class="field"><span>${t('lfg.lang', 'Language and time zone')}</span><input type="text" value=${v.lang} maxLength="60" onInput=${set('lang')} /></label>
      <label class="field"><span>${t('lfg.when', 'When do you play?')}</span><input type="text" value=${v.schedule} maxLength="100" placeholder=${t('lfg.whenPh', 'e.g. Weekday evenings, 2–3 times a week')} onInput=${set('schedule')} /></label>
      <label class="field"><span>${t('lfg.rules', 'Rules (optional)')}</span><textarea rows="3" maxLength="300" value=${v.rules} placeholder=${t('lfg.rulesPh', 'e.g. Set mode, level caps, no items in battle')} onInput=${set('rules')}></textarea>
        <span class="hint">${t('lfg.rulesHint', 'No links or mentions – those are refused.')}</span></label>
      ${err && html`<div class="warning info small stack-s" role="status"><span>${err.text}</span>
        ${err.url && html`<div><button class="btn small" onClick=${() => openExternal(err.url)}><${Icon} name="external" size=${12} />${t('lfg.openPost', 'Open my post')}</button></div>`}
        ${err.join && html`<div><button class="btn small" onClick=${() => openExternal(LINKS.discord)}><${Icon} name="external" size=${12} />${t('lfg.join', 'Join the souldew Discord')}</button></div>`}</div>`}
    </div>
  <//>`;
}

/**
 * The small secondary action: "No partner yet? Find one on the souldew Discord" (signed in) or "… Sign in to find one"
 * (signed out). Props are the form's prefill.
 */
export function FindPartnerLink({ game, partners, rules, class: cls = '' }) {
  const { navigate } = useApp();
  const acct = useAccount();
  const [open, setOpen] = useState(false);
  // souldew Renaissance: the finder posts through the official account service to the official Discord – not without the account
  if (!EDITION.accounts || !acct.loaded) return null;
  const on = !!acct.session?.signedIn;
  return html`<p class=${`small muted lfg-link ${cls}`}>
    <${Icon} name="friends" size=${13} />
    <span>${t('lfg.noPartner', 'No partner yet?')}</span>
    ${on ? html`<a href="#" onClick=${(e) => { e.preventDefault(); setOpen(true); }}>${t('lfg.findOne', 'Find one on the souldew Discord')}</a>`
      : html`<a href="#" onClick=${(e) => { e.preventDefault(); navigate('settings', settingsLink('account')); }}>${t('lfg.signIn', 'Sign in to find one on the souldew Discord')}</a>`}
    ${open && html`<${FindPartnerModal} game=${game} partners=${partners} rules=${rules} onClose=${() => setOpen(false)} />`}
  </p>`;
}
