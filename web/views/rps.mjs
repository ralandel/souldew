// Rock-paper-scissors outside the game picture (docs/MULTIPLAYER.md › 9): the card for a game the Shared World overlay
// doesn't show (Gen 4 and later, Shared World switched off, a battle or a menu on screen when the challenge came, or no
// game running at all), and the button on the board's log that starts one. The game itself is
// web/lib/worldrps.mjs (commit–reveal, shared/rps.mjs).
import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { t } from '../lib/i18n.mjs';
import { useRps } from '../lib/worldrps.mjs';
import { rpsTexts } from '../lib/sharedworld.mjs';
import { artUrl, HAND_ART } from '../lib/worldart.mjs';
import { rpsLine, RPS } from '/shared/rps.mjs';
import { players as getPlayers, slotsOf } from '../lib/run.mjs';

const CSS = `
.rps-cards{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:79;display:flex;flex-direction:column;gap:8px;width:min(340px,calc(100vw - 32px))}
.rps-card{background:var(--shell-3,#1b1a1f);border:1px solid #0d0c10;border-radius:12px;padding:10px 12px 12px;box-shadow:0 14px 30px #000a;animation:toast-in .22s cubic-bezier(.2,.8,.2,1)}
.rps-card h4{margin:0 0 8px;font-size:13px;display:flex;gap:8px;align-items:center}
.rps-card h4 .grow{flex:1}
.rps-hands{display:flex;gap:6px}
.rps-hands button{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 4px 6px;font-size:12px;border-radius:10px;height:auto}
.rps-hands button.picked{outline:2px solid var(--c,#ebe6da);outline-offset:-2px}
.rps-hands img,.rps-vs img{image-rendering:pixelated;width:30px;height:30px;object-fit:contain}
.rps-vs{display:flex;align-items:center;justify-content:center;gap:14px;padding:4px 0}
.rps-vs .lose{opacity:.45}
.rps-time{height:3px;margin-top:8px;border-radius:2px;background:#2d2c33;overflow:hidden}
.rps-time i{display:block;height:100%;background:var(--c,#ebe6da);transition:width .5s linear}
.rps-say{margin-top:8px;font-size:12px;min-height:16px}
.rps-start{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:-2px 0 10px}
`;
let styled = false;
function useStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.append(el);
}

const handName = (h) => [t('rps.rock', 'Rock'), t('rps.paper', 'Paper'), t('rps.scissors', 'Scissors')][h] || '';
const color = (slot) => (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(`--${slot}`).trim()) || '#ebe6da';

/** The cards of the games of mine the in-game overlay doesn't show (mount once, app-wide). */
export function RpsCards() {
  useStyle();
  const { link, doc, manifest } = useApp();
  const r = useRps(link);
  if (!r || !doc || !manifest) return null;
  const games = r.hub.list().filter((g) => !r.claimed.has(g.id));
  if (!games.length) return null;
  const names = getPlayers(doc, manifest);
  return html`<div class="rps-cards" role="region" aria-label=${t('world.rps', 'Rock-paper-scissors')}>
    ${games.map((g) => html`<${Card} key=${g.id} g=${g} hub=${r.hub} name=${names[g.other]?.name || g.other.toUpperCase()} />`)}
  </div>`;
}

function Card({ g, hub, name }) {
  const me = hub.me;
  const line = rpsLine(g, me, rpsTexts(), name, handName);
  const left = Math.max(0, g.until - Date.now());
  const picking = g.phase === 'pick';
  const last = g.phase === 'show' || g.phase === 'end' ? g.last : null;
  return html`<section class="rps-card" style=${`--c:${color(me)}`} aria-live="polite">
    <h4><span class="grow">${t('rps.with', 'Rock-paper-scissors · {name}', { name })}</span>
      ${g.bo === 3 && html`<span class="tiny muted">${t('rps.bestOf3Short', 'best of 3')} ${g.wins.me}–${g.wins.them}</span>`}</h4>
    ${(picking || g.phase === 'wait') && html`<div class="rps-hands" role="group" aria-label=${t('rps.pick', 'Pick your hand')}>
      ${HAND_ART.map((h, k) => html`<button class=${`btn ${g.hand === k ? 'picked' : ''}`} disabled=${!picking} onClick=${() => hub.pick(g.id, k)}>
        <img src=${artUrl(h, color(me), 4)} alt="" />${handName(k)}</button>`)}
    </div>`}
    ${last && html`<div class="rps-vs" aria-hidden="true">
      <img class=${last.winner && last.winner !== me ? 'lose' : ''} src=${artUrl(HAND_ART[last.mine], color(me), 4)} alt="" />
      <span class="tiny muted">${t('common.vs', 'vs')}</span>
      <img class=${last.winner && last.winner === me ? 'lose' : ''} src=${artUrl(HAND_ART[last.theirs], color(g.other), 4)} alt="" />
    </div>`}
    ${picking && html`<div class="rps-time" aria-hidden="true"><i style=${`width:${(left / RPS.pickMs) * 100}%`}></i></div>`}
    <div class="rps-say">${line}</div>
    ${(picking || g.phase === 'wait') && html`<div class="row" style="margin-top:8px;justify-content:flex-end">
      <button class="btn small ghost" onClick=${() => hub.pass(g.id)}>${g.round > 1 || g.phase === 'wait' ? t('rps.giveUp', 'Give up') : t('rps.notNow', 'Not now')}</button></div>`}
  </section>`;
}

/**
 * The board's way in (any game, also without Shared World): "Rock-paper-scissors" → a partner (online ones), best of 1
 * or 3. `online`: the slots connected right now.
 */
export function RpsStart({ online = null }) {
  useStyle();
  const { link, doc, manifest, me } = useApp();
  const r = useRps(link);
  const [open, setOpen] = useState(false);
  const [bo3, setBo3] = useState(false);
  const [why, setWhy] = useState('');
  if (!r || !doc || !manifest) return null;
  const names = getPlayers(doc, manifest);
  const others = slotsOf(manifest).filter((s) => s !== me);
  if (!others.length) return null;
  const go = (slot) => {
    const g = r.hub.challenge(slot, bo3 ? 3 : 1);
    if (g?.error) setWhy(g.error === 'busy' ? t('rps.busyMine', 'You’re already playing {name}.', { name: names[slot]?.name || slot }) : t('rps.limit', 'Not so fast – try again in a few seconds.'));
    else (setWhy(''), setOpen(false));
  };
  if (!open) return html`<button type="button" class="btn ghost" onClick=${() => setOpen(true)} title=${t('rps.startHint', 'Play rock-paper-scissors with a partner – fair: nobody sees the other hand before both picked.')}>
    <img src=${artUrl('scissors', '#ebe6da', 2)} alt="" style="image-rendering:pixelated;width:20px;height:20px" />${t('world.rps', 'Rock-paper-scissors')}</button>`;
  return html`<div class="rps-start" role="group" aria-label=${t('world.rps', 'Rock-paper-scissors')}>
    <span class="small muted">${t('rps.against', 'Play against:')}</span>
    ${others.map((s) => html`<button type="button" class=${`btn small who-${s}`} disabled=${online && !online.has(s)} onClick=${() => go(s)}>${names[s]?.name || s.toUpperCase()}</button>`)}
    <label class="check small"><input type="checkbox" checked=${bo3} onChange=${(e) => setBo3(e.currentTarget.checked)} /><span>${t('rps.bestOf3', 'Best of 3')}</span></label>
    <button type="button" class="btn small ghost" onClick=${() => (setOpen(false), setWhy(''))}>${t('common.cancel', 'Cancel')}</button>
    ${why && html`<span class="small warning">${why}</span>`}
  </div>`;
}
