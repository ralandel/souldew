// The free launch animation (2D, as in souldew 2.x): starting or continuing a game, the module slides into the console's
// slot and clicks in – the game boots underneath meanwhile (kept invisible until this is over, play.mjs), so it costs no
// time. Since 3.0 it is what plays without a membership (shared/handheld.mjs launchTier 'free'); Supporter and souldew+
// get your handheld in 3D (views/launchstage.mjs). A click or key skips it; Settings › Play › Launch animation (On /
// Off) and the general "Play animations" turn it off; with reduced motion it doesn't play (the module still clicks when
// the game appears). One length – there is no Quick form of it.
import { html, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Cart } from './library.mjs';
import { insertCover } from './launchstage.mjs';
import { play, preload } from '../lib/sound.mjs';

const LENGTH = 1500; // ms – matches the keyframes in styles.css (.cart-insert)
const HOME_AT = 900; // the module is pushed home at 60 % of ci-drop
const CLICK_LEAD = 68; // the click in cart-insert.wav comes this long after its start

/** sound: the app's sounds setting (the click is an app sound – the game's volume doesn't turn it down) */
export function CartInsert({ target, color, sound = true, onDone }) {
  const { library, manifest } = useApp();
  const done = useRef(onDone);
  done.current = onDone;
  const clicked = useRef(false);
  const skipRef = useRef(null);
  useEffect(() => {
    preload('cartInsert');
    const click = () => {
      if (clicked.current) return;
      clicked.current = true;
      play('cartInsert', sound);
    };
    const timer = setTimeout(click, HOME_AT - CLICK_LEAD);
    const end = setTimeout(() => done.current?.(), LENGTH);
    // skipped: the module is home right now – it still clicks
    const skip = () => {
      click();
      done.current?.();
    };
    skipRef.current = skip;
    addEventListener('keydown', skip, { once: true });
    return () => {
      clearTimeout(timer);
      clearTimeout(end);
      removeEventListener('keydown', skip);
    };
  }, []);
  const kind = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', '3ds': 'nds' }[target.system] || 'gb';
  return html`<div class=${`cart-insert ci-${kind}`} onClick=${() => skipRef.current?.()} aria-hidden="true">
    <div class="ci-stage">
      <div class="ci-cart"><${Cart} big title=${target.label} cover=${insertCover(library, target, manifest)} color=${color} system=${target.system} /></div>
      <div class="ci-console">
        <div class="ci-slot"></div>
        <div class="ci-face"><span class="ci-led"></span><span class="ci-power">POWER</span></div>
      </div>
    </div>
  </div>`;
}
