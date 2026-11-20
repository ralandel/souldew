// Building blocks every Settings section uses: one setting (the unit the search finds and a deep link points at),
// a group panel, a checkbox with its hint, and a pointer to a setting that lives where it is used.
import { html } from '/vendor/htm-preact.mjs';
import { Icon } from '../../lib/icons.mjs';

/**
 * One setting – id is its entry in lib/settingsindex.mjs (#/settings?f=<id> opens it). `when={false}`: not on this
 * computer (a Windows-only setting on a Mac, the 3DS player when it isn't installed …), so not rendered at all.
 */
export function Item({ id, when = true, children }) {
  if (!when) return null;
  return html`<div class="set-item" id=${`set-${id}`} data-set=${id}>${children}</div>`;
}

/** A panel of related settings. */
export function Group({ title, note, children, id }) {
  return html`<section class="panel stack set-group" id=${id}>
    ${title && html`<h2>${title}</h2>`}
    ${note && html`<p class="small muted set-note">${note}</p>`}
    ${children}
  </section>`;
}

export function Check({ checked, disabled, onChange, label, hint, small }) {
  return html`<label class=${`check${small ? ' small' : ''}`}><input type="checkbox" checked=${checked} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />
    <span>${label}${hint && html`<span class="hint">${hint}</span>`}</span></label>`;
}

/** Points at a setting that stays where it is used (the game's sound menu, the Connection or Stream page). */
export function Elsewhere({ icon, children }) {
  return html`<div class="set-elsewhere small"><${Icon} name=${icon} size=${14} /><span>${children}</span></div>`;
}
