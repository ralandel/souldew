// Pieces every account screen uses (Settings › Account, the profile, the friends list): the avatar box with its frame
// and presence dot, what a friend is doing in words, the supporter badges. Everything another player wrote is
// rendered as text (Preact escapes it) – never as HTML.
import { html } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { Icon } from '../lib/icons.mjs';
import { Frame } from '../lib/cosmetics/components.mjs';
import { fromCatalogId } from '../lib/achievementids.mjs';
import { achText } from '../lib/trophytexts.mjs';

/** A title / showcase trophy (catalog id) → the achievement's name in the UI language, or '' for an unknown one. */
export function achTitle(catalogId) {
  const a = catalogId ? fromCatalogId(catalogId) : null;
  return a ? achText(a).name : '';
}

/**
 * The avatar box (.av, the frame engine's anchor): the picture (only ever from the local server's avatar proxy) or a
 * pixel placeholder in the accent colour, the frame, and the presence dot on top.
 */
export function Avatar({ user, size = 38, presence = null, accent = null }) {
  const state = presence?.state;
  const dot = state ? (state === 'offline' ? 'off' : state === 'in_run' || state === 'playing' ? 'play' : 'on') : null;
  const src = user?.avatar && user.avatar.startsWith('/api/account/avatar?') ? user.avatar : null;
  // the frame module draws round this box (its canvas goes right after the <img>, the dot paints above it)
  return html`<span class="av-wrap" style=${accent ? `--acc:${accent}` : ''}><${Frame} id=${size >= 20 ? user?.frame || null : null} size=${size} class=${`av av-${size}`}>
    ${src ? html`<img src=${src} alt="" width=${size} height=${size} loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
      : html`<span class="av-blank" aria-hidden="true"><${Icon} name="user" size=${Math.round(size * 0.55)} /></span>`}
    ${dot && html`<span class=${`av-dot ${dot}`} aria-hidden="true"></span>`}
  <//></span>`;
}

/** What a friend is doing, in one short line. */
export function presenceText(p) {
  if (!p || p.state === 'offline') return t('fr.offline', 'Offline');
  if (p.state === 'library') return t('fr.inLibrary', 'Online · in the library');
  if (p.state === 'playing') return p.game?.title ? t('fr.playing', 'Playing {game}', { game: p.game.title }) : t('fr.online', 'Online');
  if (p.state === 'in_run') {
    const mode = p.run?.mode === 'nuzlocke' ? t('runs.modeSolo', 'Solo Nuzlocke') : p.run?.mode === 'together' ? t('pt.start', 'Play together') : t('nav.soullink', 'SoulLink');
    return [p.game?.title, p.run?.name ? `${mode} · ${p.run.name}` : mode, p.location].filter(Boolean).join(' · ');
  }
  return t('fr.online', 'Online');
}

/** A free seat a friend opened for "Ask to join". */
export const canAskToJoin = (p) => p?.state === 'in_run' && p.run?.freeSlot && p.run?.joinable;

/** Supporter / souldew+ / Legend badges (API.md §8.0) – small, quiet. souldew+ and Legend show together. */
export function Badges({ badges = [] }) {
  if (!badges.length) return null;
  const plus = badges.includes('plus');
  return html`<span class="acct-badges">
    ${plus && html`<span class="acct-badge plus" title=${t('acct.plusBadge', 'souldew+ member')}><${Icon} name="star" size=${11} />souldew+</span>`}
    ${badges.includes('patron') && html`<span class="acct-badge patron" title=${t('acct.patronBadge', 'souldew Legend')}><${Icon} name="heart" size=${11} />${t('acct.patron', 'Legend')}</span>`}
    ${!plus && badges.includes('supporter') && html`<span class="acct-badge" title=${t('acct.supporterBadge', 'Supports souldew')}><${Icon} name="heart" size=${11} />${t('acct.supporter', 'Supporter')}</span>`}
  </span>`;
}

/** A title (an earned trophy's name) as the small plate next to the name. */
export function TitlePlate({ text }) {
  if (!text) return null;
  return html`<span class="acct-title"><${Icon} name="star" size=${11} />${text}</span>`;
}

/** "SD-7K2Q-M9XD" in a copyable chip. */
export function CodeChip({ code, onCopy }) {
  if (!code) return null;
  return html`<button type="button" class="acct-code mono" title=${t('common.copy', 'Copy')} onClick=${() => { navigator.clipboard?.writeText(code); onCopy?.(); }}>${code}</button>`;
}
