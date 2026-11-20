// Asking once (owner, 19.11.26): the first time the app sees a supporter – any paid tier, or a coffee that was claimed –
// who never answered, a warm card asks whether they want their name on the Thank you page, with a preview of how they'd
// appear (their name, picture, banner and frame) and two equal answers. The answer is the account's setting
// (privacy.show_on_thanks, also in Settings › Account › Privacy); closing the card counts as "No thanks" – off stays the
// default – and this computer remembers it was asked even if the answer couldn't be saved. Never during a game, the
// welcome tour, the start-up animation or another dialog (lib/thanks.mjs shouldAskThanks).
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { Modal } from '../lib/ui.mjs';
import { useAccount, updateMe } from '../lib/account.mjs';
import { shouldAskThanks, askedHere, rememberAsked } from '../lib/thanks.mjs';
import { PersonCard, TIER_TEXT } from './thanks.mjs';

/** The card's title for the tier (the Discord roles' marks). */
export function askTitle(tier) {
  if (tier === 'legend') return t('thanks.askLegend', 'Thank you for supporting souldew! 🏆');
  if (tier === 'plus') return t('thanks.askPlus', 'Thank you for supporting souldew! 🔗');
  if (tier === 'coffee') return t('thanks.askCoffee', 'Thank you for the coffee! ☕');
  return t('thanks.askSupporter', 'Thank you for supporting souldew! 💧');
}

/** busy(): a game, the welcome tour, the start-up animation … – then the question waits. */
export function ThanksAsk({ busy = false }) {
  const acct = useAccount();
  const me = acct.me;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const done = useRef(false);
  const ok = shouldAskThanks({ signedIn: !!acct.session?.signedIn, me, askedBefore: askedHere(me?.id), busy });
  useEffect(() => {
    if (!ok || open || done.current) return undefined;
    // a moment after things settle, and not on top of another dialog
    const id = setTimeout(() => { if (!document.querySelector('dialog[open]') && !done.current) setOpen(true); }, 2500);
    return () => clearTimeout(id);
  }, [ok, open]);
  if (!open || !me) return null;

  const answer = async (yes) => {
    if (saving) return;
    done.current = true;
    rememberAsked(me.id); // never again on this computer, whatever happens next
    setSaving(true);
    try {
      await updateMe({ privacy: { showOnThanks: yes } });
      setOpen(false);
    } catch {
      if (yes) {
        setFailed(true); // "Yes" didn't reach the service: say so, the setting is in Settings
        setSaving(false);
        return;
      }
      setOpen(false); // "No" is the default anyway
    }
  };
  const tier = me.thanksTier;
  // what others would see: a look the tier doesn't cover right now (locked) isn't shown
  const shown = (k) => (me.locked?.includes(k) ? null : me[k] || null);
  const preview = { name: me.name, tier, avatar: me.avatar, banner: shown('banner'), frame: shown('frame'), since: null };
  return html`<${Modal} open=${open} onClose=${() => (failed ? setOpen(false) : answer(false))} title=${askTitle(tier)}
    footer=${failed ? html`<button type="button" class="btn" onClick=${() => setOpen(false)}>${t('common.close', 'Close')}</button>`
      : html`<div class="ty-ask-answers">
        <button type="button" class="btn" disabled=${saving} onClick=${() => answer(true)}>${t('thanks.askYes', 'Yes, show me')}</button>
        <button type="button" class="btn" disabled=${saving} onClick=${() => answer(false)}>${t('thanks.askNo', 'No thanks')}</button></div>`}>
    <div class="ty-ask">
      <p>${t('thanks.askQ', 'Want your name on the Thank you page?')}</p>
      <div class=${`ty-ask-preview ty-tier-${tier}`} aria-label=${t('thanks.askPreview', 'How you’d appear')}>
        <span class="plus-kicker">${t('thanks.askPreviewK', 'How you’d appear · {tier}', { tier: TIER_TEXT()[tier]?.name || '' })}</span>
        <ul class=${tier === 'coffee' ? 'ty-tags' : tier === 'supporter' ? 'ty-rows' : 'ty-cards ty-cards-one'} role="list"><${PersonCard} p=${preview} you /></ul>
      </div>
      <p class="small muted">${t('thanks.askHint', 'Your name, Discord picture, banner and frame, with your tier – nothing else. Everyone who supports is counted either way. You can change it any time in Settings › Account.')}</p>
      ${failed && html`<p class="small warning" role="alert">${t('thanks.askFailed', 'That didn’t save – the account service can’t be reached. You can switch it on later in Settings › Account.')}</p>`}
    </div>
  <//>`;
}
