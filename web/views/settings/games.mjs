// Settings › Games: the library folder and the folders it includes, which emulator plays each system, installing one.
import { html } from '/vendor/htm-preact.mjs';
import { copy } from '../../lib/ui.mjs';
import { Icon } from '../../lib/icons.mjs';
import { t } from '../../lib/i18n.mjs';
import { api } from '../../lib/api.mjs';
import { Item, Group } from './parts.mjs';

const SYSTEMS = [['gb', 'Game Boy'], ['gbc', 'Game Boy Color'], ['gba', 'Game Boy Advance'], ['nds', 'Nintendo DS'], ['3ds', 'Nintendo 3DS']];
/** Systems the built-in player runs only with an extra part: 3DS needs souldew's 3DS host (status.ctr). */
const externalOnly = (sys, status) => sys === '3ds' && !status?.ctr?.ok;

export function GamesSection({ cfg, status, save, library, folders, install, busy, toast }) {
  return html`
    <${Group} title=${t('set.library', 'Library')} note=${t('set.libraryText', 'Games you add are copied into the library folder. You can also include folders where your ROMs already are.')}>
      <${Item} id="library"><div class="stack">
        <div class="row"><span class="code grow ellipsis" title=${library?.libraryDir}>${library?.libraryDir}</span>
          ${window.sls && html`<button class="btn small ghost" onClick=${() => api.post('/api/library/reveal', {})}><${Icon} name="folder" size=${14} />${t('lib.reveal', 'Show folder')}</button>`}</div>
        ${(cfg.libraryFolders || []).map((f) => html`<div class="row"><span class="code grow ellipsis" title=${f}>${f}</span>
          <button class="btn small ghost" onClick=${() => folders({ remove: f })}>${t('common.remove', 'Remove')}</button></div>`)}
        ${window.sls && html`<div><button class="btn small" onClick=${async () => {
          const paths = await window.sls.pickFiles({ folder: true, title: t('set.addFolder', 'Include a folder') });
          if (paths?.[0]) await folders({ add: paths[0] });
        }}><${Icon} name="plus" size=${14} />${t('set.addFolder', 'Include a folder')}</button></div>`}
      </div><//>
    <//>
    <${Group} title=${t('set.emulators', 'Emulators')} note=${t('set.emuText', 'The built-in emulator plays every system up to the Nintendo 3DS and has the best live sync. 3DS games can also run in Azahar (for example when a graphics card can’t run the built-in 3DS player). External emulators are optional otherwise.')}>
      <${Item} id="emulator-for">
        <table class="data"><thead><tr><th>${t('set.system', 'System')}</th><th>${t('set.useEmu', 'Play with')}</th></tr></thead><tbody>
          ${SYSTEMS.map(([sys, label]) => html`<tr><td>${label}</td><td>
            <select value=${externalOnly(sys, status) ? Object.keys(status?.emulators || {}).find((id) => status.emulators[id].systems.includes(sys)) : cfg.emulatorFor?.[sys] || 'builtin'}
              disabled=${externalOnly(sys, status)} aria-label=${`${t('set.useEmu', 'Play with')}: ${label}`}
              onChange=${(e) => save({ emulatorFor: { ...(cfg.emulatorFor || {}), [sys]: e.target.value } })}>
              ${!externalOnly(sys, status) && html`<option value="builtin">${t('set.builtin', 'Built-in (live)')}</option>`}
              ${Object.entries(status?.emulators || {}).filter(([, e]) => e.systems.includes(sys)).map(([id, e]) => html`<option value=${id} disabled=${!e.installed && !externalOnly(sys, status)}>${e.name}${e.live === 'script' ? ` (${t('set.liveScript', 'live via script')})` : e.live === 'rpc' ? ` (${t('set.liveRpc', 'live via RPC')})` : ` (${t('set.liveSave', 'syncs on save')})`}${e.installed ? '' : ` – ${t('set.notInstalled', 'not installed')}`}</option>`)}
            </select></td></tr>`)}
        </tbody></table>
      <//>
      <${Item} id="install"><div class="stack">
        ${Object.entries(status?.emulators || {}).map(([id, e]) => html`<div class="check-item">
          <span class=${`led green ${e.installed ? 'on' : ''}`}></span>
          <div><b style="font-weight:500">${e.name}</b> <span class="small muted">${e.systems.map((s) => s.toUpperCase()).join(' · ')}</span>
            <div class=${`tiny faint ${e.installed ? 'sm-secret' : ''}`}>${e.installed ? e.path : t('set.notInstalled', 'not installed')}</div></div>
          ${e.installed ? html`<span class="chip ok">${t('set.installed', 'Installed')}</span>` : html`<button class="btn small" disabled=${!!busy} onClick=${() => install(id)}>${busy === id ? t('set.installing', 'Installing …') : t('set.install', 'Install')}</button>`}
        </div>`)}
        ${status?.emulators?.mgba?.installed && html`<div class="note">${t('set.mgbaScriptAgain', 'For live data with mGBA: Tools › Scripting… › File › Load script… and pick this file (again after every mGBA restart):')} <span class="code">${status.live?.script}</span>
          <button class="btn small ghost" onClick=${() => { copy(status.live?.script || ''); toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: status.live?.script }); }}>${t('common.copy', 'Copy')}</button></div>`}
      </div><//>
    <//>`;
}
