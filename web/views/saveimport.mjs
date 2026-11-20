// Importing a save file (a player on Discord: "can I bring my old .sav?"): pick a file, see what it is and whether it
// fits the game, then it replaces the game's save – the old one is backed up first and one Undo is kept
// (server/lib/saveimport.mjs). In a run it is a big change: the dialog says what it means, a SoulLink needs the host's
// rule (web/lib/run.mjs canImportSave), the log gets a line for everyone, and what the save brings along doesn't count
// (run.mjs importBaseline, shared/trophies.mjs). Used from the library's game details and the board's Files menu.
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp, Modal } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { serverErrorText } from '../lib/errors.mjs';
import { diag } from '../lib/diag.mjs';
import { canImportSave, markSaveImport, logSaveImport, runStateId } from '../lib/run.mjs';
import { slotsOf } from '/shared/slots.mjs';

/** The file picker's types per system (a zip with one save in it works everywhere). */
const ACCEPT = {
  gb: '.sav,.srm,.sa1,.bin,.zip', gbc: '.sav,.srm,.sa1,.bin,.zip', gba: '.sav,.srm,.sa1,.fla,.eep,.bin,.zip',
  nds: '.sav,.dsv,.srm,.bin,.zip',
};

/** The query naming the save: a solo game's library id, or a run player's slot. */
export const importQuery = (target) => (target.runId ? `run=${target.runId}&slot=${target.slot}` : `id=${encodeURIComponent(target.id)}`);

/** Where "Save a copy" downloads the save from (the server's plain .sav – what other emulators and flash carts read). */
export const exportUrl = (target) => (target.runId ? `/api/runs/${target.runId}/download?what=save&slot=${target.slot}` : `/api/saves/solo/download?id=${encodeURIComponent(target.id)}`);

/** The family names of shared/savefile.mjs, as the player reads them. */
const familyName = (f) => ({
  gen1: t('simp.f.gen1', 'Red, Blue or Yellow'), gs: t('simp.f.gs', 'Gold or Silver'), crystal: t('simp.f.crystal', 'Crystal'),
  rs: t('simp.f.rs', 'Ruby or Sapphire'), frlg: t('simp.f.frlg', 'FireRed or LeafGreen'), e: t('simp.f.e', 'Emerald'),
  dp: t('simp.f.dp', 'Diamond or Pearl'), pt: t('simp.f.pt', 'Platinum'), hgss: t('simp.f.hgss', 'HeartGold or SoulSilver'),
  bw: t('simp.f.bw', 'Black or White'), b2w2: t('simp.f.b2w2', 'Black 2 or White 2'), gen5: t('simp.f.gen5', 'Black, White, Black 2 or White 2'),
  xy: t('simp.f.xy', 'X or Y'), oras: t('simp.f.oras', 'Omega Ruby or Alpha Sapphire'), sm: t('simp.f.sm', 'Sun or Moon'), usum: t('simp.f.usum', 'Ultra Sun or Ultra Moon'),
}[f] || f);

const sizeText = (n) => (n >= 1048576 ? `${n / 1048576} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** What was done to the file on the way in (shared/savefile.mjs normalizeSave notes). */
const noteText = (n) => ({
  dsv: t('simp.n.dsv', 'A DeSmuME save (.dsv): its footer is taken off – the save itself stays as it is.'),
  padded: t('simp.n.padded', 'The file stops before the end of the cartridge’s memory – the rest is filled in as empty, like on the cartridge.'),
  clockWidened: t('simp.n.clockWidened', 'Its clock is in the older VBA-M layout – brought into the current one.'),
  clockKept: t('simp.n.clockKept', 'The cartridge clock in it comes along.'),
  clockDropped: t('simp.n.clockDropped', 'The clock data at its end is left out – this game has no clock.'),
  gbaClockDropped: t('simp.n.gbaClockDropped', 'The clock data mGBA adds is left out – the game takes the time from your computer.'),
  padTrimmed: t('simp.n.padTrimmed', 'The empty padding a flash cart adds is left out.'),
}[n] || null);

/** The answer of /check for the dialog: the verdict as a line, its tone. */
function verdictLine(check, system) {
  const v = check?.verdict;
  if (v === 'match') return { tone: 'ok', text: t('simp.match', 'A save of {game} – it fits this game.', { game: familyName(check.found) }) };
  if (v === 'mismatch') return { tone: 'warn', text: t('simp.mismatch', 'This looks like a save of {found}, not of {want}. The game may not load it – or start a new game over it.', { found: familyName(check.found), want: familyName(check.want) }) };
  if (v === 'size') return { tone: 'warn', text: t('simp.sizeOff', 'A save of {game}, but not the size the game writes. It may not load.', { game: familyName(check.found) }) };
  return { tone: 'muted', text: system === '3ds' ? t('simp.unknown3ds', 'souldew can’t tell which game this backup is from – it goes in as it is.')
    : t('simp.unknown', 'souldew can’t tell which game this save is from (a ROM hack, another language or another game) – it goes in as it is.') };
}

/** A folder the player picked (Checkpoint / JKSM backup): its files as the server takes them. */
async function folderPayload(fileList) {
  const files = [];
  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    files.push({ path: rel, data: btoa(bin) });
  }
  return new TextEncoder().encode(JSON.stringify({ files }));
}

/** POST raw bytes, the answer as api.mjs gives it (an Error with the server's code and words). */
async function postRaw(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/octet-stream' }, body });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    const e = new Error(serverErrorText(data || {}, res.status));
    e.code = data?.code;
    e.vars = data?.vars;
    e.status = res.status;
    throw e;
  }
  return data;
}

/** The diagnostics line under an error: what failed and how – the same goes into "Save diagnostics". */
const diagLine = (e) => [e?.code || (e?.status ? `HTTP ${e.status}` : 'error'), e?.vars?.detail, e?.vars?.size].filter(Boolean).join(' · ');

/**
 * "Load a save file …": `target` = { id (library id) | runId + slot, system, label }. Opens the dialog; onDone(result)
 * after an import or its undo.
 */
/**
 * Does the play view's game (`playing`: the session's target) run the save an import is for (`target`: { runId, slot }
 * or { id })? The browser player too – the server can't see that one. Play together: a run slot plays the library
 * game's own save, so the run's player and the library's free play are the same save (one stateId).
 */
export function playsThisSave(playing, target, runManifest = null) {
  if (!playing || !target) return false;
  const inRun = !!target.runId;
  const saveUrl = inRun ? `/api/runs/${target.runId}/save/${target.slot}` : `/api/saves/solo?id=${encodeURIComponent(target.id)}`;
  if (playing.saveUrl === saveUrl || (inRun && playing.runId === target.runId) || (!inRun && playing.key === target.id)) return true;
  const stateId = inRun ? (runManifest ? runStateId(runManifest, target.slot) : null) : target.id;
  return !!stateId && playing.stateId === stateId;
}

export function SaveImportDialog({ target, onClose, onDone }) {
  const { session, closeSession, toast, doc, manifest } = useApp();
  const inRun = !!target.runId;
  const runManifest = inRun && manifest?.id === target.runId ? manifest : null;
  const solo = runManifest ? slotsOf(runManifest).length === 1 : true;
  const allowed = inRun ? canImportSave(doc, runManifest) : { ok: true };
  const [file, setFile] = useState(null); // { name, body, kind }
  const [check, setCheck] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false); // a run: "I understand"; a mismatch: "import anyway"
  const [anyway, setAnyway] = useState(false);
  const [last, setLast] = useState(null); // { undo, running }
  const fileRef = useRef(null);
  const dirRef = useRef(null);
  const q = importQuery(target);
  // the play view runs this very save (the browser player too – the server can't see that one)
  const playingThis = playsThisSave(session?.target, target, runManifest);

  useEffect(() => {
    let off = false;
    api.get(`/api/saves/import/last?${q}`).then((r) => !off && setLast(r), () => !off && setLast(null));
    return () => { off = true; };
  }, [q]);

  const pick = async (list, kind) => {
    const f = list?.[0];
    if (!f) return;
    setErr(null);
    setCheck(null);
    setSure(false);
    setAnyway(false);
    setBusy(true);
    try {
      const body = kind === 'files' ? await folderPayload(list) : new Uint8Array(await f.arrayBuffer());
      const k = kind || (target.system === '3ds' ? (/\.zip$/i.test(f.name) ? 'zip' : 'main') : null);
      const name = kind === 'files' ? (f.webkitRelativePath || f.name).split('/')[0] : f.name;
      setFile({ name, body, kind: k });
      const r = await postRaw(`/api/saves/import/check?${q}${k ? `&kind=${k}` : ''}`, body);
      setCheck(r);
      diag('saveImport', { phase: 'check', system: target.system, size: r.size ?? null, from: r.from ?? null, verdict: r.check?.verdict ?? null, found: r.check?.found ?? null, notes: r.notes || [] });
    } catch (e) {
      setErr(e);
      diag('saveImport', { phase: 'check', system: target.system, code: e.code ?? null, status: e.status ?? null, detail: e.vars?.detail ?? null });
    }
    setBusy(false);
  };

  const run = async () => {
    if (!file || !check) return;
    setBusy(true);
    setErr(null);
    // (a run: the marker first – the first look at the game afterwards must already know – run.mjs importBaseline)
    if (inRun && doc) markSaveImport(doc, target.slot);
    try {
      const r = await postRaw(`/api/saves/import?${q}&confirm=1${file.kind ? `&kind=${file.kind}` : ''}&name=${encodeURIComponent(file.name || '')}`, file.body);
      if (inRun && doc && runManifest) logSaveImport(doc, runManifest, target.slot);
      diag('saveImport', { phase: 'import', system: target.system, verdict: r.check?.verdict ?? null, replaced: !!(r.replaced || r.backup) });
      toast({ kind: 'ok', title: t('simp.done', 'Save imported'), ttl: 12000,
        text: r.replaced || r.backup ? t('simp.doneBackup', 'Your old save is backed up. Start the game to go on from the imported one.') : t('simp.doneNew', 'Start the game to go on from it.'),
        action: { label: t('simp.undo', 'Undo'), run: () => undo() } });
      onDone?.(r);
      onClose();
    } catch (e) {
      if (inRun && doc) markSaveImport(doc, target.slot, { clear: true });
      setErr(e);
      diag('saveImport', { phase: 'import', system: target.system, code: e.code ?? null, status: e.status ?? null, detail: e.vars?.detail ?? null, what: e.vars?.what ?? null });
    }
    setBusy(false);
  };

  const undo = async () => {
    try {
      const r = await api.post(`/api/saves/import/undo?${q}`);
      if (inRun && doc && runManifest) logSaveImport(doc, runManifest, target.slot, { undo: true });
      diag('saveImport', { phase: 'undo', system: target.system, restored: r.restored, playedSince: r.playedSince });
      toast({ kind: 'ok', title: t('simp.undone', 'Import undone'),
        text: r.playedSince ? t('simp.undonePlayed', 'Your save from before is back. What you played since is kept in the save backups.')
          : r.removed ? t('simp.undoneNone', 'The game has no save again, as before.') : t('simp.undoneText', 'Your save from before is back.') });
      onDone?.(r);
      setLast((l) => (l ? { ...l, undo: null } : l));
    } catch (e) {
      toast({ kind: 'warn', title: t('simp.undoFailed', 'Couldn’t undo the import'), text: `${e.message} (${diagLine(e)})` });
    }
  };

  const running = playingThis || check?.running || last?.running;
  const v = check ? verdictLine(check.check, target.system) : null;
  const needSure = inRun;
  const needAnyway = check?.check?.verdict === 'mismatch';
  const canGo = !!check && !busy && !running && allowed.ok && (!needSure || sure) && (!needAnyway || anyway);
  const isCtr = target.system === '3ds';

  const footer = html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
    <button class=${`btn ${inRun ? 'danger' : 'primary'}`} disabled=${!canGo} onClick=${run}><${Icon} name="load" size=${16} />${t('simp.go', 'Import save')}</button>`;

  return html`<${Modal} open=${true} onClose=${onClose} title=${t('simp.title', 'Import a save file')} footer=${footer}>
    <div class="stack save-import">
      <p class="muted">${isCtr
        ? t('simp.intro3ds', 'A backup from Checkpoint or JKSM – the folder, or a zip of it – goes into this game’s save in souldew’s own 3DS player.')
        : inRun ? t('simp.introRun', 'A save from another emulator, a flash cart or a cartridge dump (.sav, .srm, .dsv …) replaces your save in the run “{run}”.', { run: target.label || '' })
          : t('simp.intro', 'A save from another emulator, a flash cart or a cartridge dump (.sav, .srm, .dsv …) replaces the save of {game}.', { game: target.label || '' })}</p>
      ${!allowed.ok && html`<div class="warning" role="alert">${t('simp.hostOnly', 'The host hasn’t allowed importing saves in this run. They can switch it on in the run’s rules.')}</div>`}
      ${allowed.ok && running && html`<div class="warning row nowrap" role="alert"><span class="grow">${check?.running === 'emulator' || (!playingThis && last?.running === 'emulator')
        ? t('simp.emuOpen', 'An emulator is still open. Save in the game, close the emulator, then come back.')
        : t('simp.running', 'This game is running. Close it first – the save is never replaced under a running game.')}</span>
        ${playingThis && html`<button class="btn small" onClick=${() => closeSession(() => setLast((l) => (l ? { ...l, running: false } : l)))}>${t('play.close', 'Close game')}</button>`}</div>`}
      ${allowed.ok && html`<div class="row">
        <label class="btn"><${Icon} name="folder" size=${16} />${isCtr ? t('simp.pickZip', 'Choose a zip or main file …') : t('simp.pick', 'Choose a save file …')}
          <input ref=${fileRef} type="file" class="sr-only" accept=${isCtr ? undefined : ACCEPT[target.system] || '.sav'} onChange=${(e) => { pick(e.target.files); e.target.value = ''; }} /></label>
        ${isCtr && html`<label class="btn ghost"><${Icon} name="folder" size=${16} />${t('simp.pickFolder', 'Choose a backup folder …')}
          <input ref=${dirRef} type="file" class="sr-only" webkitdirectory="" onChange=${(e) => { pick([...e.target.files], 'files'); e.target.value = ''; }} /></label>`}
        ${!isCtr && last?.hasSave && html`<a class="btn ghost" href=${exportUrl(target)} download="" title=${t('simp.copyHint', 'Your current save as a plain .sav – other emulators and flash carts read it.')}>
          <${Icon} name="download" size=${16} />${t('simp.copy', 'Save a copy first')}</a>`}
      </div>`}
      ${busy && !check && html`<p class="small muted">${t('simp.reading', 'Reading the file …')}</p>`}
      ${check && html`<div class="stack-s">
        <div class="small"><b>${file?.name}</b> · ${isCtr ? t('simp.files', '{n} files', { n: check.files }) : sizeText(check.size)}</div>
        <div class=${v.tone === 'warn' ? 'warning' : `small ${v.tone === 'ok' ? '' : 'muted'}`}>${v.tone === 'ok' && html`<span class="chip ok">${t('simp.fits', 'fits')}</span> `}${v.text}</div>
        ${(check.notes || []).map(noteText).filter(Boolean).map((n) => html`<div class="small muted">${n}</div>`)}
        ${check.check?.party > 0 && html`<div class="small muted">${t('simp.party', 'Its team: {n} Pokémon.', { n: check.check.party })}</div>`}
        ${isCtr && check.missing?.length > 0 && html`<div class="small muted">${t('simp.missing3ds', 'Files the game has now that the backup doesn’t: {list} – they are removed.', { list: check.missing.slice(0, 4).join(', ') })}</div>`}
        ${isCtr && !check.current?.exists && html`<div class="warning">${t('simp.ctrStart', 'Start this game in souldew once and save in it first – then its save can be replaced.')}</div>`}
        <div class="small muted">${check.current?.exists
          ? t('simp.backup', 'Your current save{when} is backed up first – Undo brings it back.', { when: check.current.at ? ` (${t('simp.savedAgo', 'saved {ago}', { ago: ago(check.current.at) })})` : '' })
          : isCtr ? '' : t('simp.noSave', 'The game has no save yet.')}</div>
        ${needAnyway && html`<label class="check"><input type="checkbox" checked=${anyway} onChange=${(e) => setAnyway(e.target.checked)} />
          <span>${t('simp.anyway', 'Import it anyway')}</span></label>`}
        ${needSure && html`<div class="note stack-s">
          <b>${t('simp.runTitle', 'This changes your game in the run')}</b>
          <span class="small">${solo
            ? t('simp.runTextSolo', 'The run goes on from the imported save. It goes into the run’s log. Its Pokémon and badges don’t count – no catches, badges or level records from it – and this run can’t earn the trophies for winning any more, even after an Undo.')
            : t('simp.runText', 'Your game goes on from the imported save. Everyone in the run sees it in the log. Its Pokémon and badges don’t count – no catches, badges or level records from it – and this run can’t earn you the trophies for winning any more, even after an Undo.')}</span>
          <label class="check"><input type="checkbox" checked=${sure} onChange=${(e) => setSure(e.target.checked)} /><span>${t('simp.sure', 'I understand – replace my save')}</span></label>
        </div>`}
      </div>`}
      ${err && html`<div class="warning" role="alert">${err.message}<div class="tiny faint mono">${t('simp.diag', 'Details: {line}', { line: diagLine(err) })}</div></div>`}
      ${last?.undo && html`<div class="row nowrap small muted"><span class="grow">${t('simp.lastImport', 'Last import: {when}{name}.', { when: ago(last.undo.at), name: last.undo.name ? ` – ${last.undo.name}` : '' })}</span>
        <button class="btn small ghost" disabled=${running} onClick=${undo}><${Icon} name="reset" size=${14} />${t('simp.undoLast', 'Undo it')}</button></div>`}
    </div>
  <//>`;
}

/** The button / menu item that opens the dialog (`as`: 'button' | 'menuitem'). */
export function ImportSaveButton({ target, as = 'button', onOpen, onDone }) {
  const [open, setOpen] = useState(false);
  if (!target || !['gb', 'gbc', 'gba', 'nds', '3ds'].includes(target.system)) return null;
  const label = t('simp.open', 'Import a save file …');
  const hint = t('simp.openHint', 'Replace this game’s save with one from another emulator, a flash cart or an older backup – the current one is backed up first.');
  const opener = as === 'menuitem'
    ? html`<button role="menuitem" title=${hint} onClick=${() => { onOpen?.(); setOpen(true); }}>${label}</button>`
    : html`<button type="button" class="btn small" title=${hint} onClick=${() => setOpen(true)}><${Icon} name="load" size=${16} />${label}</button>`;
  return html`${opener}${open && html`<${SaveImportDialog} target=${target} onClose=${() => setOpen(false)} onDone=${onDone} />`}`;
}
