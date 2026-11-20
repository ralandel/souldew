// "What's new in 3.0": five cards – one line and a picture of the app each – shown once after the update from 2.x (the
// server marks such an install, lib/whatsnew.mjs says when they may open) and any time from Help or Settings › General.
// Skippable at every card: Esc, the ×, the backdrop, "Skip" and the last card's button all close them for good.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { Modal } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { WHATS_NEW_CARDS, cardMedia, stepCard } from '../lib/whatsnew.mjs';

/** Each card's title and line (here, so scripts/extract-i18n.mjs finds them). */
function cardText(id) {
  return {
    together: [t('wn.togetherTitle', 'Trade & battle'), t('wn.togetherText', 'Trade and battle with your partners right from where you are in your game – Gen 1 to 5, no restart.')],
    world: [t('wn.worldTitle', 'Shared World'), t('wn.worldText', 'Your partners walk around in your game: wave, send a heart or play rock-paper-scissors.')],
    raid: [t('wn.raidTitle', 'Raids'), t('wn.raidText', 'All of you against one trainer – every hit in anybody’s game comes off one shared health bar.')],
    handheld: [t('wn.handheldTitle', 'Your handheld'), t('wn.handheldText', 'Your games start on your own handheld in 3D, with skins and stickers – with Supporter or souldew+.')],
    friends: [t('wn.friendsTitle', 'Friends'), t('wn.friendsText', 'Sign in with Discord, see who’s playing what, and invite friends straight into your run.')],
  }[id] || ['', ''];
}

/** The cards. `onClose` runs once, however they were closed – they count as seen then. */
export function WhatsNew({ open, onClose }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!open) return;
    setI(0);
    // every picture at once, so paging never waits for one
    for (const c of WHATS_NEW_CARDS) {
      const img = new Image();
      img.src = cardMedia(c.id);
    }
  }, [open]);
  const n = WHATS_NEW_CARDS.length;
  const card = WHATS_NEW_CARDS[i] || WHATS_NEW_CARDS[0];
  const [title, text] = cardText(card.id);
  const last = i === n - 1;
  // ← → (and Home / End) page through while the cards have the focus – the controller's shoulder buttons do it via the
  // dots' tab list (lib/padnav.mjs)
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (!e.target?.closest?.('dialog')?.querySelector('.wn') || e.altKey || e.metaKey || e.ctrlKey) return;
      const next = stepCard(i, e.key, n);
      if (next === i) return;
      e.preventDefault();
      setI(next);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, i, n]);
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('wn.title', 'What’s new in souldew 3.0')}
    footer=${html`<div class="wn-dots" role="tablist" data-pad-tabs aria-label=${t('wn.cards', 'Cards')}>
        ${WHATS_NEW_CARDS.map((c, k) => html`<button type="button" role="tab" key=${c.id} aria-selected=${k === i} class=${k === i ? 'on' : ''}
          aria-label=${t('wn.cardN', 'Card {n} of {count}: {title}', { n: k + 1, count: n, title: cardText(c.id)[0] })} onClick=${() => setI(k)}></button>`)}
      </div>
      ${!last && html`<button class="btn ghost" onClick=${onClose}>${t('wn.skip', 'Skip')}</button>`}
      ${i > 0 && html`<button class="btn" onClick=${() => setI(i - 1)}>${t('wn.back', 'Back')}</button>`}
      <button class="btn primary" data-pad-first onClick=${() => (last ? onClose() : setI(i + 1))}>${last ? t('wn.done', 'Let’s go') : t('wn.next', 'Next')}</button>`}>
    <div class="wn">
      <figure class="wn-media" key=${card.id}>
        <img src=${cardMedia(card.id)} width="1120" height="640" alt=${t('wn.shot', 'souldew: {title}', { title })} draggable="false" />
      </figure>
      <div class="wn-text" aria-live="polite">
        <h3><span class="wn-icon"><${Icon} name=${card.icon} size=${16} /></span>${title}</h3>
        <p class="muted">${text}</p>
      </div>
    </div>
  <//>`;
}
