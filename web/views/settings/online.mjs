// Settings › Online: sharing your screen with the other players, Discord live runs and the anonymous "playing now"
// count, the stream overlays' coffee hint.
import { html } from '/vendor/htm-preact.mjs';
import { t, currentLang } from '../../lib/i18n.mjs';
import { api } from '../../lib/api.mjs';
import { openExternal } from '../../lib/ui.mjs';
import { LINKS } from '../../lib/links.mjs';
import { LiveRunsSettings, LIVE_RUNS } from '../liveshare.mjs';
import { Item, Group, Check, Elsewhere } from './parts.mjs';
import { EDITION } from '/shared/edition.mjs';

export function OnlineSection({ cfg, save, toast, reloadStatus }) {
  const coffee = async (on) => {
    try {
      await api.post('/api/stream', { coffee: on });
      reloadStatus?.();
    } catch {
      toast({ kind: 'warn', title: t('set.saveFailed', 'Couldn’t save the setting') });
    }
  };
  return html`
    <${Group} title=${t('set.withPlayers', 'With the other players')}>
      <${Item} id="share-screen"><${Check} checked=${cfg.shareScreen !== false} onChange=${(v) => save({ shareScreen: v })}
        label=${t('set.shareScreenAll', 'Share my screen with the other players')}
        hint=${t('set.shareScreenHint', 'While you play, the others see your game small in a corner. It is only sent while someone is watching.')} /><//>
      <${Elsewhere} icon="signal">${t('set.connElsewhere', 'Invite codes, relays and who is online:')} <a href="#/link">${t('nav.link', 'Connection')}</a><//>
    <//>
    ${(LIVE_RUNS || EDITION.presence) && html`<${Group} title="Discord">${LIVE_RUNS && html`<${Item} id="discord"><${LiveRunsSettings} /><//>`}
      ${EDITION.presence && html`<${Item} id="presence"><label class="check"><input type="checkbox" checked=${cfg.presence !== false} onChange=${(e) => save({ presence: e.target.checked })} /><span>${t('set.presence', 'Count me in “playing now” (anonymous)')}
        <span class="hint">${t('set.presenceHint2', 'Only while a game runs: system, mode (solo, Nuzlocke, SoulLink or Play together) and app version with a random id, for the player count on the souldew Discord. And once a day an anonymous “souldew was used today” for the team’s statistics (version, system, week of first use, how many recent days) – no name, no game, no IP stored, no id that stays.')}
          ${' '}<a href=${LINKS.privacy} onClick=${(e) => { e.preventDefault(); e.stopPropagation(); openExternal(currentLang() === 'de' ? LINKS.privacy : LINKS.privacyDocs); }}>${t('set.presenceMore', 'What exactly is sent')}</a></span></span></label><//>`}
    <//>`}
    <${Group} title=${t('nav.stream', 'Stream')}>
      <${Item} id="coffee-pop"><${Check} checked=${cfg.stream?.coffee !== false} onChange=${coffee}
        label=${t('set.coffeePop', 'Coffee hint on legendary encounters in stream overlays')}
        hint=${t('set.coffeePopHint', 'Now and then a cheeky toast about the legendary pops up in your Alerts overlay, with the coffee link.')} /><//>
      <${Elsewhere} icon="stream">${t('set.streamElsewhere', 'Streamer mode, OBS overlays and their links:')} <a href="#/stream">${t('nav.stream', 'Stream')}</a><//>
    <//>`;
}
