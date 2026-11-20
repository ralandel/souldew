// "Share to Discord" (Live runs): the button on big moments, "Post to the Hall of Fame" after a won run and the block
// in Settings › Online › Discord.
// The page never holds the Discord token – it asks the local server (web/lib/liveshare.mjs → /api/liveruns).
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp, openExternal } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { normalizeCode } from '/shared/liveruns.mjs';
import { useLiveRuns, refreshLiveRuns, setLiveRunsState, shareEvent, shareErrorText, endEvent, cardModel } from '../lib/liveshare.mjs';
import { renderCardPng } from '../lib/livecard.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { spriteUrl } from '../lib/data.mjs';
import { EDITION } from '/shared/edition.mjs';

/** This build talks to a Discord bot (shared/edition.mjs) – without one, none of these buttons or settings show. */
export const LIVE_RUNS = !!EDITION.liveRunsUrl;

/** The Discord mark, small (the share buttons). */
const DiscordGlyph = ({ size = 14 }) => html`<svg viewBox="0 0 16 16" width=${size} height=${size} aria-hidden="true" class="px">
  <path fill="currentColor" d="M4 3h2v1h4V3h2v1h1v1h1v3h1v4h-1v1h-2v-1h-1v-1H5v1H4v1H2v-1H1V8h1V5h1V4h1zM5 7v2h2V7zM9 7v2h2V7z" /></svg>`;

/**
 * "Share to Discord" for one event (web/lib/liveshare.mjs deathEvent / endEvent) – only while this app is linked.
 * Once shared – by this player or a partner (the bot answers 409) – it says so and stays off for that event.
 */
export function ShareButton({ event, small = false }) {
  if (!LIVE_RUNS) return null;
  const { doc, manifest, runData, toast, navigate } = useApp();
  const lr = useLiveRuns();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { setErr(null); setDone(null); }, [event?.id]);
  if (!lr.linked && err?.error !== 'token') return null;
  if (!event || !doc || !manifest) return null;
  const shared = done || lr.shared?.[event.id];
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await shareEvent({ doc, manifest, gen: runData?.gen || 4, event, app: lr.app || '' });
      if (r.changed?.length) toast({ kind: 'warn', title: t('live.title', 'Live runs'), text: t('live.changed', 'Links were taken out of a name or text – the server doesn’t allow them.') });
      if (r.ok || r.error === 'duplicate') {
        setDone({ url: r.url || null, duplicate: !r.ok });
        toast({ kind: 'ok', title: t('live.sharedTitle', 'Shared to Discord'), text: !r.ok ? t('live.already', 'Already shared – by you or a partner.')
          : event.kind === 'victory' ? t('hof.sharedText', 'Your team is up in #hall-of-fame.') : t('live.sharedText', 'The card is up in #live-runs.') });
      } else {
        setErr(r);
        toast({ kind: 'warn', title: t('live.title', 'Live runs'), text: shareErrorText(r), ttl: 9000 });
      }
    } catch (e) {
      setErr({ error: 'server' });
      toast({ kind: 'warn', title: t('live.title', 'Live runs'), text: e.message || shareErrorText({ error: 'server' }) });
    }
    setBusy(false);
  };
  const cls = `btn live-share ${small ? 'small ghost' : ''}`;
  if (shared) {
    return html`<span class="live-share-done">
      <button class=${`${cls} done`} disabled title=${shared.duplicate ? t('live.already', 'Already shared – by you or a partner.') : ''}>
        ${shared.duplicate ? t('live.alreadyShort', 'Already shared') : t('live.shared', 'Shared')} ✓</button>
      ${shared.url && !small && html`<button class="btn small ghost" onClick=${() => openExternal(shared.url)}><${Icon} name="external" size=${12} />${t('live.open', 'Open in Discord')}</button>`}
    </span>`;
  }
  if (err?.error === 'token') {
    return html`<button class=${cls} onClick=${() => navigate('settings', settingsLink('discord'))} title=${shareErrorText(err)}><${DiscordGlyph} />${t('live.connectAgain', 'Connect again')}</button>`;
  }
  const blocked = err && ['blocked', 'not-member'].includes(err.error);
  const hint = event.kind === 'victory' ? t('hof.hint', 'Posts your winning team in #hall-of-fame on the souldew Discord.') : t('live.shareHint', 'Posts a card of this moment in #live-runs on the souldew Discord.');
  return html`<button class=${cls} disabled=${busy || blocked} onClick=${go} title=${err ? shareErrorText(err) : hint}>
    <${DiscordGlyph} />${busy ? t('live.sharing', 'Sharing …') : err?.error === 'rate' ? t('live.retryIn', 'Try again in {n} min', { n: Math.max(1, Math.ceil((err.retryAfter || 60) / 60)) }) : t('live.share', 'Share to Discord')}</button>`;
}

/** The trophy, small (the Hall of Fame button). */
const Trophy = ({ size = 14 }) => html`<${Icon} name="trophy" size=${size} />`;

/** The won run's card as an image URL for the preview (painted like the post; freed again when it goes). */
function useCardPreview(doc, manifest, gen, event, app) {
  const [url, setUrl] = useState(null);
  const key = event?.id || '';
  useEffect(() => {
    if (!event || !doc || !manifest) return undefined;
    let gone = false;
    let made = null;
    (async () => {
      try {
        const { model } = cardModel({ doc, manifest, gen, event, app });
        const png = await renderCardPng(model, (id, fallback) => spriteUrl(id, { gen: fallback ? 9 : gen }));
        if (gone) return;
        made = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
        setUrl(made);
      } catch {
        // no preview – the button still works
      }
    })();
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [key, app]);
  return url;
}

/**
 * After a won run: "Post to the Hall of Fame" – the run's card with the final team as its own post in #hall-of-fame on
 * the souldew Discord. Opt-in only: nothing is posted until the player presses the button, and only when this app is
 * linked (Live runs); otherwise it says how to link it. `compact`: one line for the board's banner (no preview).
 */
export function HallOfFame({ status, compact = false, onLeave }) {
  if (!LIVE_RUNS) return null;
  const { doc, manifest, runData, toast, navigate } = useApp();
  const lr = useLiveRuns();
  const event = status?.state === 'won' && manifest ? endEvent(manifest, status) : null;
  const gen = runData?.gen || 4;
  const preview = useCardPreview(compact ? null : doc, manifest, gen, event, lr.app || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { setErr(null); setDone(null); }, [event?.id]);
  if (!event || !doc || !manifest || !lr.loaded) return null;
  const shared = done || lr.shared?.[event.id];
  const linked = lr.linked && err?.error !== 'token';
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await shareEvent({ doc, manifest, gen, event, app: lr.app || '' });
      if (r.changed?.length) toast({ kind: 'warn', title: t('hof.title', 'Hall of Fame'), text: t('live.changed', 'Links were taken out of a name or text – the server doesn’t allow them.') });
      if (r.ok || r.error === 'duplicate') {
        setDone({ url: r.url || null, duplicate: !r.ok });
        toast({ kind: 'ok', title: t('hof.title', 'Hall of Fame'), text: r.ok ? t('hof.sharedText', 'Your team is up in #hall-of-fame.') : t('hof.already', 'Already in the Hall of Fame – posted by you or a partner.') });
      } else {
        setErr(r);
        toast({ kind: 'warn', title: t('hof.title', 'Hall of Fame'), text: shareErrorText(r), ttl: 9000 });
      }
    } catch (e) {
      setErr({ error: 'server' });
      toast({ kind: 'warn', title: t('hof.title', 'Hall of Fame'), text: e.message || shareErrorText({ error: 'server' }) });
    }
    setBusy(false);
  };
  const blocked = err && ['blocked', 'not-member'].includes(err.error);
  const action = shared
    ? html`<span class="live-share-done">
        <button class="btn hof-btn done ${compact ? 'small' : ''}" disabled>${shared.duplicate ? t('hof.alreadyShort', 'Already in the Hall of Fame') : t('hof.posted', 'In the Hall of Fame')} ✓</button>
        ${shared.url && html`<button class="btn small ghost" onClick=${() => openExternal(shared.url)}><${Icon} name="external" size=${12} />${t('live.open', 'Open in Discord')}</button>`}
      </span>`
    : linked
      ? html`<button class="btn hof-btn ${compact ? 'small' : ''}" disabled=${busy || blocked} onClick=${go} title=${err ? shareErrorText(err) : t('hof.hint', 'Posts your winning team in #hall-of-fame on the souldew Discord.')}>
          <${Trophy} />${busy ? t('live.sharing', 'Sharing …') : err?.error === 'rate' ? t('live.retryIn', 'Try again in {n} min', { n: Math.max(1, Math.ceil((err.retryAfter || 60) / 60)) }) : t('hof.post', 'Post to the Hall of Fame')}</button>`
      : html`<button class="btn ghost small" onClick=${() => {
        onLeave?.();
        navigate('settings', settingsLink('discord'));
      }}>${t('hof.connect', 'Connect Discord …')}</button>`;
  const hintText = t('hof.connectHint', 'To share it, link souldew once: type /live connect in the souldew Discord and enter the code in Settings › Online › Discord.');
  if (compact) {
    return html`<div class="hof-inline">
      ${action}
      ${!linked && !shared && html`<span class="tiny muted">${hintText}</span>`}
    </div>`;
  }
  return html`<div class="hof-offer">
    ${preview ? html`<img class="hof-preview" src=${preview} alt=${t('hof.previewAlt', 'The card that will be posted')} width="1200" height="675" />`
      : html`<div class="hof-preview placeholder" aria-hidden="true"><${Trophy} size=${28} /></div>`}
    <div class="hof-copy">
      <b><${Trophy} /> ${t('hof.title', 'Hall of Fame')}</b>
      <p class="small muted">${linked || shared ? t('hof.text', 'Show off your winning team in #hall-of-fame on the souldew Discord – for everyone to see. Nothing is posted until you press the button.') : hintText}</p>
      <div class="row wrap">${action}</div>
      ${err && !['rate'].includes(err.error) && html`<p class="tiny" style="color:var(--bad-ink)" role="alert">${shareErrorText(err)}</p>`}
    </div>
  </div>`;
}

/** Settings › Online › Discord (live runs): link with the code from /live connect, see the account and today's posts, unlink. */
export function LiveRunsSettings() {
  if (!LIVE_RUNS) return null;
  const { toast } = useApp();
  const lr = useLiveRuns();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { refreshLiveRuns(true); }, []);
  const valid = normalizeCode(code);
  const connect = async () => {
    if (!valid) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/api/liveruns/link', { code: valid });
      if (r.ok) {
        setCode('');
        setLiveRunsState({ ...r, expired: false });
        await refreshLiveRuns(true);
        toast({ kind: 'ok', title: t('live.title', 'Live runs'), text: t('live.connected', 'Connected as {name}.', { name: r.user?.name || '' }) });
      } else {
        setErr(r.error === 'code' ? t('live.eCode', 'This code is unknown, expired or already used – get a new one with /live connect.')
          : r.error === 'rate' ? t('live.eLinkRate', 'Too many tries – wait {n} min.', { n: Math.max(1, Math.ceil((r.retryAfter || 60) / 60)) })
            : shareErrorText(r));
      }
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      const r = await api.del('/api/liveruns/link');
      setLiveRunsState({ ...r, limits: null, expired: false });
      if (!r.reached) toast({ kind: 'warn', title: t('live.title', 'Live runs'), text: t('live.unlinkOffline', 'Disconnected here. The bot couldn’t be reached, so it still counts this computer as linked until it drops the oldest link.') });
    } catch (e) {
      toast({ kind: 'death', title: t('live.title', 'Live runs'), text: e.message });
    }
    setBusy(false);
  };
  const l = lr.limits;
  return html`<div class="stack-s live-runs">
    <h3>${t('live.title', 'Live runs')}</h3>
    <p class="small muted">${t('live.explain2', 'Share big moments – a death, a wipe – as a card with your teams in #live-runs on the souldew Discord, and a won run with your final team in #hall-of-fame. Nothing is posted unless you press the button.')}</p>
    ${lr.linked ? html`<div class="row wrap live-linked">
        <span class="chip ok"><${Icon} name="check" size=${12} />${t('live.connectedAs', 'Connected as')} <b class="sm-secret">${lr.user?.name || '?'}</b></span>
        ${l?.left != null && html`<span class="small muted">${t('live.left', '{left} of {perDay} posts left today', { left: l.left, perDay: l.perDay })}${l.nextInSec > 0 ? ` · ${t('live.next', 'next one in {n} min', { n: Math.ceil(l.nextInSec / 60) })}` : ''}</span>`}
        ${lr.offline && html`<span class="small faint">${t('live.botOffline', 'The bot can’t be reached right now.')}</span>`}
        <span class="spacer grow"></span>
        <button class="btn small ghost" disabled=${busy} onClick=${disconnect}>${t('live.disconnect', 'Disconnect')}</button>
      </div>`
    : html`<div class="stack-s">
        ${lr.expired && html`<div class="warning" role="alert">${t('live.expired', 'The link to Discord has ended (disconnected in Discord, or linked on too many devices). Connect again with a new code.')}</div>`}
        <ol class="small muted live-steps">
          <li>${t('live.step1', 'In the souldew Discord, type /live connect (or press “Connect souldew” in #live-runs).')}</li>
          <li>${t('live.step2', 'The bot shows you a code like K7Q-4M2 – only you can see it. Enter it here within 10 minutes.')}</li>
        </ol>
        <div class="row nowrap">
          <input type="text" class="sm-secret live-code" value=${code} maxLength="9" placeholder="K7Q-4M2" autocomplete="off" spellcheck="false"
            aria-label=${t('live.codeLabel', 'Code from /live connect')} onInput=${(e) => { setCode(e.target.value); setErr(''); }}
            onKeyDown=${(e) => e.key === 'Enter' && connect()} />
          <button class="btn primary" disabled=${busy || !valid} onClick=${connect}>${busy ? t('live.connecting', 'Connecting …') : t('live.connect', 'Connect')}</button>
        </div>
        ${err && html`<div class="small" style="color:var(--bad-ink)" role="alert">${err}</div>`}
      </div>`}
    <p class="tiny faint">${t('live.privacy', 'Only this computer keeps the link (not your runs, invites or diagnostics). Streamer mode covers your Discord name and the code.')}</p>
  </div>`;
}
