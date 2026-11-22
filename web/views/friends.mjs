// Friends (souldew account, look "A – Logbook"): the list grouped Playing now / Online / Offline with friend requests
// on top, a pane with the picked friend (what they play, "Invite to a run", "Ask to join"), the invites that are open
// both ways, adding by handle or friend code, removing, blocking and reporting. Signed out it only points to
// Settings › Account. Every name and status here was written by another player: text only.
import { html, useState, useEffect, useMemo } from '/vendor/htm-preact.mjs';
import { useApp, Modal, Led } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { catalog } from '../lib/data.mjs';
import { settingsLink } from '../lib/settingsindex.mjs';
import { slotsOf, runMode } from '/shared/slots.mjs';
import { parseFriendQuery } from '/shared/social.mjs';
import {
  useAccount, useFriends, useInvites, useCatalog, accentHex, addFriend, answerRequest, cancelRequest, removeFriend, blockUser, report, askToJoin, profileOf,
} from '../lib/account.mjs';
import { inviteFriends, letIn, allowFriend, declineFriend, cancelInvite, useHostedInvites, declineInvite, freeSeats, seatsLeft } from '../lib/friendinvite.mjs';
import { shortTitle } from '../lib/friendpresence.mjs';
import { coverOf } from './library.mjs';
import { takenSlots } from './invitecode.mjs';
import { Avatar, presenceText, canAskToJoin, Badges, CodeChip, TitlePlate, achTitle } from './social.mjs';
import { Banner, Nameplate } from '../lib/cosmetics/components.mjs';
import { FindPartnerLink } from './findpartner.mjs';

/** The cover of a game a friend plays (by its short title – presence carries no ids). */
export function coverForTitle(library, title) {
  if (!title) return null;
  const g = (catalog().games || []).find((x) => !x.variantOf && shortTitle({ gameId: x.id }) === title);
  return g ? coverOf(library, { gameId: g.id }) : null;
}

const groupOf = (f) => (f.presence?.state === 'playing' || f.presence?.state === 'in_run' ? 'playing' : f.presence?.state && f.presence.state !== 'offline' ? 'online' : 'offline');

/** Signed out: what the page is and where to sign in. */
export function SignInFirst({ what }) {
  const { navigate } = useApp();
  return html`<div class="panel empty-state acct-signin-first">
    <${Icon} name="user" size=${48} />
    <h2>${what}</h2>
    <p class="muted">${t('fr.signInText', 'Friends, profiles and invites need a souldew account. Everything else works without one.')}</p>
    <button class="btn primary" onClick=${() => navigate('settings', settingsLink('account'))}>${t('fr.toAccount', 'Sign in under Settings › Account')}</button>
  </div>`;
}

function AddFriendModal({ me, onClose, onDone }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const parsed = parseFriendQuery(q);
  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await addFriend(q.trim());
      setMsg({ ok: true, text: r.status === 'accepted' ? t('fr.addedNow', 'You’re friends now – they had asked you already.') : t('fr.requestSent', 'Request sent. You’ll see them here once they accept.') });
      setQ('');
      onDone?.();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
    setBusy(false);
  };
  return html`<${Modal} open onClose=${onClose} title=${t('fr.addTitle', 'Add a friend')}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.close', 'Close')}</button>
      <button class="btn primary" disabled=${!parsed || busy} onClick=${send}><${Icon} name="plus" size=${14} />${t('fr.sendRequest', 'Send request')}</button>`}>
    <div class="stack">
      <label class="field"><span>${t('fr.addLabel', 'Their handle or friend code')}</span>
        <input type="text" value=${q} placeholder=${t('fr.addPh', '@handle or SD-XXXX-XXXX')} autocomplete="off" spellcheck="false" autoFocus
          onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && parsed && !busy && send()} />
        <span class="hint">${parsed?.friend_code ? t('fr.isCode', 'Friend code {code}', { code: parsed.friend_code }) : parsed?.handle ? t('fr.isHandle', 'Handle @{handle}', { handle: parsed.handle }) : t('fr.addHint', 'Ask your friend – it’s in their Settings › Account.')}</span></label>
      ${msg && html`<p class=${msg.ok ? 'note small' : 'warning error small'} role="status">${msg.text}</p>`}
      ${me && html`<div class="acct-share small"><span class="muted">${t('fr.yours', 'Yours:')}</span> <b>@${me.handle}</b>
        <${CodeChip} code=${me.friendCode} onCopy=${() => toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: me.friendCode })} /></div>`}
    </div>
  <//>`;
}

function ReportModal({ user, onClose }) {
  const { toast } = useApp();
  const [target, setTarget] = useState('profile');
  const [reason, setReason] = useState('inappropriate');
  const [note, setNote] = useState('');
  const send = async () => {
    try {
      await report({ userId: user.id, target, reason, note });
      toast({ kind: 'ok', title: t('fr.reported', 'Thanks – the report is in'), text: t('fr.reportedText', '{name} won’t know who reported them.', { name: user.name }) });
      onClose();
    } catch (e) {
      toast({ kind: 'death', title: t('fr.reportFailed', 'Couldn’t send the report'), text: e.message });
    }
  };
  return html`<${Modal} open onClose=${onClose} title=${t('fr.reportTitle', 'Report {name}', { name: user.name })}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button><button class="btn primary" onClick=${send}>${t('fr.report', 'Report')}</button>`}>
    <div class="stack">
      <div class="grid-2">
        <label class="field"><span>${t('fr.reportWhat', 'What')}</span><select value=${target} onChange=${(e) => setTarget(e.target.value)}>
          <option value="profile">${t('fr.rProfile', 'Profile')}</option><option value="status">${t('fr.rStatus', 'Status line')}</option>
          <option value="name">${t('fr.rName', 'Name or handle')}</option><option value="other">${t('fr.rOther', 'Something else')}</option></select></label>
        <label class="field"><span>${t('fr.reportWhy', 'Why')}</span><select value=${reason} onChange=${(e) => setReason(e.target.value)}>
          <option value="inappropriate">${t('fr.wInappropriate', 'Inappropriate')}</option><option value="harassment">${t('fr.wHarassment', 'Harassment')}</option>
          <option value="hate">${t('fr.wHate', 'Hate')}</option><option value="spam">${t('fr.wSpam', 'Spam')}</option>
          <option value="impersonation">${t('fr.wImpersonation', 'Pretends to be someone else')}</option><option value="other">${t('fr.wOther', 'Other')}</option></select></label>
      </div>
      <label class="field"><span>${t('fr.reportNote', 'Anything to add (optional)')}</span>
        <textarea rows="3" maxLength="300" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea></label>
    </div>
  <//>`;
}

/** "Invite {name} to a run": the SoulLinks with a free seat, or a new SoulLink with them. */
export function InviteModal({ friend, onClose }) {
  const { status, library, navigate, toast, me, doc, linkStatus, manifest } = useApp();
  const runs = (status?.runs || []).filter((r) => runMode(r) !== 'nuzlocke' && slotsOf(r).length > 1 && (r.summary?.status?.state || 'active') === 'active');
  const hosted = useHostedInvites();
  // a seat an invite of this app still holds is not free (an open run: whoever this computer knows is in it)
  const withSeats = runs.map((r) => ({ r, free: r.id === manifest?.id ? seatsLeft(manifest, takenSlots(manifest, { me, doc, linkStatus }), hosted)
    : Math.min(freeSeats(r), seatsLeft(r, ['p1'], hosted)) }));
  const [pick, setPick] = useState(withSeats.find((x) => x.free > 0)?.r.id || (withSeats.length ? withSeats[0].r.id : 'new'));
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (pick === 'new') {
      onClose();
      navigate('soullink', { new: '', friend: friend.id });
      return;
    }
    setBusy(true);
    try {
      const m = await api.get(`/api/runs/${pick}`);
      const taken = () => (manifest?.id === m.id ? takenSlots(manifest, { me, doc, linkStatus }) : slotsOf(m).filter((s) => s === 'p1' || m.summary?.live?.[s]));
      await inviteFriends(m, [friend], { gameTitle: shortTitle({ gameId: m.game?.id, hackId: m.game?.hackId, title: m.game?.title }), taken });
      toast({ kind: 'ok', title: t('fr.inviteSent', 'Invite sent to {name}', { name: friend.name }), text: t('fr.inviteSentText', 'Keep souldew open – you allow them in when their app asks.') });
      onClose();
    } catch (e) {
      toast({ kind: 'death', title: t('fr.inviteFailed', 'Couldn’t send the invite'), text: e.message });
    }
    setBusy(false);
  };
  return html`<${Modal} open onClose=${onClose} title=${t('fr.inviteTitle', 'Invite {name} to a run', { name: friend.name })}
    footer=${html`<span class="small muted grow acct-lockline"><${Icon} name="lock" size=${12} />${t('fr.ownCopy', '{name} still needs their own copy of the game.', { name: friend.name })}</span>
      <button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn go" disabled=${busy} onClick=${send}><${Icon} name="link" size=${14} />${pick === 'new' ? t('fr.newRunGo', 'Set up the run') : t('fr.sendInvite', 'Send invite')}</button>`}>
    <div class="stack">
      <p class="muted">${t('fr.inviteText', '{name} gets the invite in souldew right away – no code to read out. It works like “Invite with code”: their app fetches the run once you allow it, never your game files.', { name: friend.name })}</p>
      <div class="inv-runs" role="radiogroup">
        ${withSeats.map(({ r, free }) => html`<button type="button" role="radio" aria-checked=${pick === r.id} class=${`inv-run ${pick === r.id ? 'on' : ''}`} disabled=${free === 0} onClick=${() => setPick(r.id)}>
          <span class="radio"></span>${coverOf(library, { gameId: r.game?.id, hackId: r.game?.hackId }) ? html`<img class="inv-cover pixel" src=${coverOf(library, { gameId: r.game?.id, hackId: r.game?.hackId })} alt="" />` : html`<span class="inv-cover"></span>`}
          <span class="grow stack-s" style="gap:0"><b>${r.name}</b><span class="small muted">${shortTitle({ gameId: r.game?.id, hackId: r.game?.hackId, title: r.game?.title })} · ${t('runs.modeLink', 'SoulLink · {n}', { n: slotsOf(r).length })}</span></span>
          <span class=${`chip ${free ? 'ok' : ''}`}>${free ? t('fr.freeSeats', '1 free seat|{count} free seats', { count: free }) : t('fr.full', 'full')}</span></button>`)}
        <button type="button" role="radio" aria-checked=${pick === 'new'} class=${`inv-run inv-new ${pick === 'new' ? 'on' : ''}`} onClick=${() => setPick('new')}>
          <span class="radio"></span><span class="inv-cover inv-plus"><${Icon} name="plus" size=${16} /></span>
          <span class="grow stack-s" style="gap:0"><b>${t('fr.newWith', 'New SoulLink with {name}', { name: friend.name })}</b><span class="small muted">${t('fr.newWithText', 'Pick game and rules – {name} gets the invite when it’s built.', { name: friend.name })}</span></span></button>
      </div>
    </div>
  <//>`;
}

function FriendRow({ f, on, onPick, onInvite, library }) {
  const p = f.presence;
  const cover = coverForTitle(library, p?.game?.title);
  // the friend's nameplate (souldew+) behind their row, still until hovered – drawn by the cosmetics module
  return html`<${Nameplate} id=${f.user.nameplate || null} class=${`fr-row ${on ? 'on' : ''} ${groupOf(f)}`} data-cos-row="">
    <button type="button" class="fr-pick" onClick=${onPick} aria-pressed=${on}>
      <${Avatar} user=${f.user} size=${38} presence=${p} />
      <span class="grow stack-s fr-text"><b class="ellipsis">${f.user.name}</b><span class="small muted ellipsis">${presenceText(p)}</span></span>
      ${cover && html`<img class="fr-cover pixel" src=${cover} alt="" />`}
    </button>
    ${groupOf(f) !== 'offline' && html`<button type="button" class="btn small go fr-invite" onClick=${onInvite} title=${t('fr.inviteTo', 'Invite to a run')}><${Icon} name="link" size=${14} />${t('fr.invite', 'Invite')}</button>`}
  <//>`;
}

function FriendPane({ f, onInvite, onRemoved }) {
  const { navigate, toast } = useApp();
  const cat = useCatalog();
  const [menu, setMenu] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [asked, setAsked] = useState(false);
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    profileOf(f.user.id).then(setProfile, () => setProfile(null));
  }, [f.user.id]);
  const u = f.user;
  const p = f.presence;
  const ask = async () => {
    try {
      await askToJoin(u.id);
      setAsked(true);
      toast({ kind: 'ok', title: t('fr.asked', 'Asked {name}', { name: u.name }), text: t('fr.askedText', 'You get an invite as soon as they let you in.') });
    } catch (e) {
      toast({ kind: 'death', title: t('fr.askFailed', 'Couldn’t ask to join'), text: e.message });
    }
  };
  const remove = async () => {
    setMenu(false);
    try {
      await removeFriend(u.id);
      toast({ kind: 'ok', title: t('fr.removed', '{name} is no longer your friend', { name: u.name }) });
      onRemoved();
    } catch (e) {
      toast({ kind: 'death', title: t('fr.removeFailed', 'Couldn’t remove the friend'), text: e.message });
    }
  };
  const block = async () => {
    setMenu(false);
    try {
      await blockUser(u.id);
      toast({ kind: 'ok', title: t('fr.blocked', '{name} is blocked', { name: u.name }), text: t('fr.blockedText', 'You won’t see each other any more, and neither can send requests or invites.') });
      onRemoved();
    } catch (e) {
      toast({ kind: 'death', title: t('fr.blockFailed', 'Couldn’t block'), text: e.message });
    }
  };
  const accent = accentHex(cat, u.accent);
  return html`<div class="stack-l fr-pane" style=${accent ? `--acc:${accent}` : ''}>
    <section class="panel fr-card">
      <div class="fr-card-banner"><${Banner} id=${profile?.banner || null} size="fill" shade /></div>
      <div class="fr-card-body">
        <${Avatar} user=${u} size=${72} presence=${p} />
        <div class="grow stack-s" style="gap:2px">
          <div class="row tight"><b class="fr-card-name">${u.name}</b><${TitlePlate} text=${achTitle(u.title)} /><${Badges} badges=${u.badges} /></div>
          <span class="small muted">@${u.handle}${f.since ? ` · ${t('fr.since', 'friends since {date}', { date: new Date(f.since).toLocaleDateString(document.documentElement.lang || undefined, { month: 'long', year: 'numeric' }) })}` : ''}</span>
        </div>
        <button class="btn ghost" onClick=${() => navigate('profile', { id: u.id })}>${t('fr.profile', 'Profile')}</button>
        <button class="btn go" onClick=${onInvite}><${Icon} name="link" size=${14} />${t('fr.inviteTo', 'Invite to a run')}</button>
        <div class="fr-more">
          <button class="btn icon ghost" aria-haspopup="menu" aria-expanded=${menu} aria-label=${t('fr.more', 'More')} onClick=${() => setMenu(!menu)}>⋯</button>
          ${menu && html`<div class="run-menu" role="menu" onMouseLeave=${() => setMenu(false)}>
            <button role="menuitem" onClick=${remove}><${Icon} name="close" size=${14} />${t('fr.remove', 'Remove friend')}</button>
            <button role="menuitem" onClick=${block}><${Icon} name="lock" size=${14} />${t('fr.block', 'Block')}</button>
            <button role="menuitem" class="danger" onClick=${() => { setMenu(false); setReporting(true); }}><${Icon} name="bell" size=${14} />${t('fr.report', 'Report')}</button>
          </div>`}
        </div>
      </div>
    </section>
    ${p?.state === 'in_run' || p?.state === 'playing' ? html`<section class="lcd-card fr-live">
      <div class="row"><${Led} on /><span class="px lcd-live">${t('fr.live', 'LIVE')}</span><b class="px">${[p.game?.title, p.run?.name].filter(Boolean).join(' · ')}</b>
        <span class="spacer"></span><span class="small">${p.location || ''}</span></div>
      ${p.state === 'in_run' && p.run?.freeSlot && html`<div class="row fr-live-foot"><span class="small grow">${canAskToJoin(p) ? t('fr.freeAsk', 'This run has a free seat – {name} can let you in.', { name: u.name }) : t('fr.freeNoAsk', 'This run has a free seat.')}</span>
        ${canAskToJoin(p) && html`<button class="btn small primary" disabled=${asked} onClick=${ask}>${asked ? t('fr.askedShort', 'Asked') : t('fr.askToJoin', 'Ask to join')}</button>`}</div>`}
    </section>` : html`<p class="small muted">${presenceText(p)}</p>`}
    ${reporting && html`<${ReportModal} user=${u} onClose=${() => setReporting(false)} />`}
  </div>`;
}

/** Open invites both ways, join requests, and the ones this app hosts (Allow / Decline when a friend's app asks). */
export function InviteInbox({ invites, reload }) {
  const { navigate, toast, manifest, me, doc, linkStatus } = useApp();
  const hosted = useHostedInvites();
  const inc = invites?.incoming?.filter((i) => i.status === 'pending') || [];
  const joinIn = invites?.joinIncoming?.filter((j) => j.status === 'pending') || [];
  const joinOut = invites?.joinOutgoing?.filter((j) => j.status === 'pending') || [];
  const live = hosted.filter((h) => h.state && ['starting', 'waiting', 'request', 'sending'].includes(h.state.phase));
  if (!inc.length && !joinIn.length && !joinOut.length && !live.length) return null;
  const letInNow = async (jr) => {
    if (!manifest) return toast({ kind: 'warn', title: t('fr.noOpenRun', 'Open the run first'), text: t('fr.noOpenRunText', 'Open the SoulLink you want to let {name} into, then try again.', { name: jr.from?.name || '' }) });
    try {
      const m = await api.get(`/api/runs/${manifest.id}`);
      await letIn(jr, m, { gameTitle: shortTitle({ gameId: m.game?.id, hackId: m.game?.hackId, title: m.game?.title }), taken: () => takenSlots(manifest, { me, doc, linkStatus }) });
      reload();
    } catch (e) {
      toast({ kind: 'death', title: t('fr.inviteFailed', 'Couldn’t send the invite'), text: e.message });
    }
  };
  return html`<section class="panel stack fr-inbox">
    <h3 class="fr-head">${t('fr.invites', 'Invites')}</h3>
    ${inc.map((i) => html`<div class="fr-inv row nowrap" key=${i.id}>
      <${Avatar} user=${i.from} size=${30} />
      <span class="grow small">${t('fr.invitesYou', '{name} invites you to {run}', { name: i.from?.name || '', run: [i.run?.name, i.run?.game].filter(Boolean).join(' · ') })}</span>
      <button class="btn small go" onClick=${() => navigate('soullink', { join: '1', invite: i.id })}>${t('fr.join', 'Join')}</button>
      <button class="btn small ghost" onClick=${() => declineInvite(i.id).then(reload).catch((e) => toast({ kind: 'death', title: t('fr.declineFailed', 'Couldn’t decline'), text: e.message }))}>${t('fr.decline', 'Decline')}</button>
    </div>`)}
    ${joinIn.map((j) => html`<div class="fr-inv row nowrap" key=${j.id}>
      <${Avatar} user=${j.from} size=${30} />
      <span class="grow small">${t('fr.asksToJoin', '{name} asks to join your run', { name: j.from?.name || '' })}</span>
      <button class="btn small go" onClick=${() => letInNow(j)}>${t('fr.letIn', 'Let in')}</button>
      <button class="btn small ghost" onClick=${() => api.post(`/api/account/join-requests/${encodeURIComponent(j.id)}/decline`).then(reload).catch(() => {})}>${t('fr.decline', 'Decline')}</button>
    </div>`)}
    ${joinOut.map((j) => html`<div class="fr-inv row nowrap" key=${j.id}>
      <${Avatar} user=${j.to} size=${30} />
      <span class="grow small muted">${t('fr.askedWaiting', 'You asked {name} to join – waiting', { name: j.to?.name || '' })}</span>
      <button class="btn small ghost" onClick=${() => api.del(`/api/account/join-requests/${encodeURIComponent(j.id)}`).then(reload).catch(() => {})}>${t('common.cancel', 'Cancel')}</button>
    </div>`)}
    ${live.map((h) => html`<div class=${`fr-inv row nowrap ${h.state.phase === 'request' ? 'asking' : ''}`} key=${h.id}>
      <${Avatar} user=${h.friend} size=${30} />
      ${h.state.phase === 'request' ? html`<span class="grow small"><b>${t('fr.wantsIn', '{name} wants to join {run}', { name: h.friend.name, run: h.runName })}</b></span>
          <button class="btn small go" onClick=${() => allowFriend(h.id)}><${Icon} name="check" size=${14} />${t('code.allow', 'Allow')}</button>
          <button class="btn small ghost" onClick=${() => declineFriend(h.id)}>${t('code.decline', 'Decline')}</button>`
        : html`<span class="grow small muted"><${Led} on blink />${h.state.phase === 'sending' ? t('fr.sending', 'Sending the run to {name} …', { name: h.friend.name }) : t('fr.waitingFor', 'Invited {name} to {run} – waiting for their app', { name: h.friend.name, run: h.runName })}</span>
          <button class="btn small ghost" onClick=${() => cancelInvite(h.id)}>${t('common.cancel', 'Cancel')}</button>`}
    </div>`)}
  </section>`;
}

export function FriendsView() {
  const { library, toast } = useApp();
  const acct = useAccount();
  const on = !!acct.session?.signedIn;
  const { data, reload, error } = useFriends(on);
  const { data: invites, reload: reloadInvites } = useInvites(on);
  const [pick, setPick] = useState(null);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(null);
  const friends = useMemo(() => (data?.friends || []).filter((f) => !search.trim() || `${f.user.name} ${f.user.handle}`.toLowerCase().includes(search.trim().toLowerCase().replace(/^@/, ''))), [data, search]);
  useEffect(() => {
    if (!pick && data?.friends?.length) setPick((data.friends.find((f) => groupOf(f) === 'playing') || data.friends.find((f) => groupOf(f) === 'online') || data.friends[0]).user.id);
  }, [data]);
  if (!acct.known) return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  if (!on) return html`<div class="stack-l"><div class="topbar"><h1>${t('nav.friends', 'Friends')}</h1></div><${SignInFirst} what=${t('fr.signInTitle', 'Play with friends')} /></div>`;
  const groups = ['playing', 'online', 'offline'].map((g) => ({ g, items: friends.filter((f) => groupOf(f) === g) }));
  const label = { playing: t('fr.gPlaying', 'Playing now'), online: t('fr.gOnline', 'Online'), offline: t('fr.gOffline', 'Offline') };
  const picked = data?.friends?.find((f) => f.user.id === pick) || null;
  const answer = async (r, yes) => {
    try {
      await answerRequest(r.id, yes);
      if (yes) toast({ kind: 'ok', title: t('fr.nowFriends', 'You and {name} are friends now', { name: r.from?.name || '' }) });
      reload();
    } catch (e) {
      toast({ kind: 'death', title: t('fr.answerFailed', 'Couldn’t answer the request'), text: e.message });
    }
  };
  return html`<div class="stack-l friends">
    <div class="topbar"><h1>${t('nav.friends', 'Friends')}</h1>
      <label class="set-search fr-search" role="search"><${Icon} name="search" size=${16} />
        <input type="search" value=${search} placeholder=${t('fr.search', 'Search friends')} aria-label=${t('fr.search', 'Search friends')} onInput=${(e) => setSearch(e.target.value)} /></label>
      <button class="btn" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${14} />${t('fr.add', 'Add friend')}</button></div>
    ${error && html`<p class="warning info small" role="status">${error.message}</p>`}
    <div class="fr-layout">
      <section class="panel fr-list">
        ${data?.incoming?.length > 0 && html`<div class="fr-requests">
          <h3 class="fr-head">${t('fr.requests', 'Requests')} <span class="fr-count">${data.incoming.length}</span></h3>
          ${data.incoming.map((r) => html`<div class="fr-req row nowrap" key=${r.id}>
            <${Avatar} user=${r.from} size=${30} />
            <span class="grow stack-s fr-text"><b class="ellipsis">${r.from?.name}</b><span class="small muted ellipsis">@${r.from?.handle}</span></span>
            <button class="btn small go" onClick=${() => answer(r, true)}>${t('fr.accept', 'Accept')}</button>
            <button class="btn small ghost" onClick=${() => answer(r, false)}>${t('fr.ignore', 'Ignore')}</button>
          </div>`)}
        </div>`}
        ${groups.map(({ g, items }) => items.length > 0 && html`<div class="fr-group">
          <h3 class="fr-head">${label[g]}<span class="spacer"></span><span class="fr-n">${items.length}</span></h3>
          ${items.map((f) => html`<${FriendRow} key=${f.user.id} f=${f} library=${library} on=${pick === f.user.id} onPick=${() => setPick(f.user.id)} onInvite=${() => setInviting(f.user)} />`)}
        </div>`)}
        ${data && !data.friends.length && html`<div class="fr-empty stack-s"><b>${t('fr.none', 'No friends yet')}</b>
          <span class="small muted">${t('fr.noneText', 'Add your SoulLink partners by their handle or friend code – then you see who’s online and invite them with one click.')}</span>
          <div><button class="btn small" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${14} />${t('fr.add', 'Add friend')}</button></div>
          <${FindPartnerLink} /></div>`}
        ${data?.outgoing?.length > 0 && html`<div class="fr-group"><h3 class="fr-head">${t('fr.sent', 'Sent requests')}</h3>
          ${data.outgoing.map((r) => html`<div class="fr-req row nowrap" key=${r.id}><${Avatar} user=${r.to} size=${30} />
            <span class="grow stack-s fr-text"><b class="ellipsis">${r.to?.name}</b><span class="small muted">${t('fr.waitingAccept', 'waiting for them to accept')}</span></span>
            <button class="btn small ghost" onClick=${() => cancelRequest(r.id).then(reload).catch(() => {})}>${t('common.cancel', 'Cancel')}</button></div>`)}</div>`}
      </section>
      <div class="stack-l">
        <${InviteInbox} invites=${invites} reload=${reloadInvites} />
        ${picked ? html`<${FriendPane} key=${picked.user.id} f=${picked} onInvite=${() => setInviting(picked.user)} onRemoved=${() => { setPick(null); reload(); }} />`
          : data?.friends?.length > 0 && html`<p class="muted small">${t('fr.pickOne', 'Pick a friend to see what they’re up to.')}</p>`}
      </div>
    </div>
    ${adding && html`<${AddFriendModal} me=${acct.me} onClose=${() => setAdding(false)} onDone=${reload} />`}
    ${inviting && html`<${InviteModal} friend=${inviting} onClose=${() => { setInviting(null); reloadInvites(); }} />`}
  </div>`;
}

/** Pick friends (online first) – for "Invite friends" on a run's invite panel. */
function FriendPicker({ onClose, onPick, exclude = [], max = 3 }) {
  const { data } = useFriends(true);
  const [sel, setSel] = useState([]);
  const list = (data?.friends || []).filter((f) => !exclude.includes(f.user.id))
    .sort((a, b) => ['playing', 'online', 'offline'].indexOf(groupOf(a)) - ['playing', 'online', 'offline'].indexOf(groupOf(b)));
  const toggle = (u) => setSel((s) => (s.some((x) => x.id === u.id) ? s.filter((x) => x.id !== u.id) : [...s, u].slice(0, max)));
  return html`<${Modal} open onClose=${onClose} title=${t('fr.pickTitle', 'Invite friends')}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn go" disabled=${!sel.length} onClick=${() => onPick(sel)}><${Icon} name="link" size=${14} />${t('fr.sendInvites', 'Send invite|Send {count} invites', { count: sel.length })}</button>`}>
    <div class="stack">
      ${!data ? html`<p class="muted small">${t('common.loading', 'Loading …')}</p>` : !list.length ? html`<p class="muted small">${t('fr.noneToInvite', 'No friends to invite yet – add them under Friends.')}</p>`
        : html`<div class="fr-picklist">${list.map((f) => html`<label class=${`fr-pickrow ${sel.some((x) => x.id === f.user.id) ? 'on' : ''}`}>
          <input type="checkbox" checked=${sel.some((x) => x.id === f.user.id)} onChange=${() => toggle(f.user)} />
          <${Avatar} user=${f.user} size=${30} presence=${f.presence} />
          <span class="grow stack-s fr-text"><b class="ellipsis">${f.user.name}</b><span class="small muted ellipsis">${presenceText(f.presence)}</span></span></label>`)}</div>`}
      <p class="small muted">${t('fr.pickSeats', '1 seat is free – pick one friend.|{count} seats are free – pick up to {count} friends.', { count: max })} ${t('fr.pickHint', 'Each friend gets their own invite in souldew. They still need their own copy of the game.')}</p>
    </div>
  <//>`;
}

/**
 * On a run's invite panel (the wizard's last step, the board): "Invite friends" and how those invites are doing –
 * waiting, "Kim wants to join" with Allow, sent. Signed out it isn't there at all. autoFriends: friends picked in the
 * wizard – invited once, as soon as the run is built.
 */
export function RunFriendInvites({ manifest, autoFriends = [] }) {
  const { toast, me, doc, linkStatus } = useApp();
  const acct = useAccount();
  const hosted = useHostedInvites().filter((h) => h.runId === manifest.id);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const on = !!acct.session?.signedIn;
  // the open run: whoever this computer knows is in it; a run just built: only its host
  const taken = () => (doc?.runId === manifest.id ? takenSlots(manifest, { me, doc, linkStatus }) : ['p1']);
  const left = seatsLeft(manifest, taken(), hosted);
  const send = async (friends) => {
    setPicking(false);
    setBusy(true);
    try {
      await inviteFriends(manifest, friends, {
        gameTitle: shortTitle({ gameId: manifest.game?.id, hackId: manifest.game?.hackId, title: manifest.game?.title }),
        taken,
      });
      toast({ kind: 'ok', title: t('fr.invitesSent', 'Invite sent|{count} invites sent', { count: friends.length }), text: t('fr.inviteSentText', 'Keep souldew open – you allow them in when their app asks.') });
    } catch (e) {
      toast({ kind: 'death', title: t('fr.inviteFailed', 'Couldn’t send the invite'), text: e.message });
    }
    setBusy(false);
  };
  const auto = autoFriends.map((f) => f.id).join();
  useEffect(() => {
    if (on && autoFriends.length && !hosted.length) send(autoFriends);
  }, [on, auto, manifest.id]);
  if (!on) return null;
  return html`<div class="fr-runinv stack-s">
    <div class="row"><${Icon} name="heart" size=${14} /><span class="small grow">${t('fr.runInvite', 'Your souldew friends get the invite in the app – no code to read out.')}</span>
      <button class="btn small go" disabled=${busy || left < 1} title=${left < 1 ? t('fr.noSeatLeft', 'Every seat of this run is taken or has an invite out.') : ''} onClick=${() => setPicking(true)}><${Icon} name="plus" size=${14} />${t('fr.inviteFriends', 'Invite friends')}</button></div>
    ${hosted.map((h) => html`<div class=${`fr-inv row nowrap ${h.state?.phase === 'request' ? 'asking' : ''}`} key=${h.id}>
      <${Avatar} user=${h.friend} size=${30} />
      ${h.state?.phase === 'request' ? html`<span class="grow small"><b>${t('fr.wantsInShort', '{name} wants to join', { name: h.friend.name })}</b></span>
          <button class="btn small go" onClick=${() => allowFriend(h.id)}><${Icon} name="check" size=${14} />${t('code.allow', 'Allow')}</button>
          <button class="btn small ghost" onClick=${() => declineFriend(h.id)}>${t('code.decline', 'Decline')}</button>`
        : h.state?.phase === 'done' || h.state?.phase === 'sending' ? html`<span class="grow small"><span class="chip ok">${t('fr.inRun', 'in')}</span> ${h.state.phase === 'done' ? t('fr.gotRun', '{name} has the run – their app builds the game now.', { name: h.friend.name }) : t('fr.sending', 'Sending the run to {name} …', { name: h.friend.name })}</span>`
        : ['expired', 'cancelled', 'locked', 'conflict', 'error'].includes(h.state?.phase) ? html`<span class="grow small muted">${t('fr.inviteOver', 'The invite for {name} ended.', { name: h.friend.name })}</span>`
        : html`<span class="grow small muted"><${Led} on blink />${t('fr.waitingFriend', 'Waiting for {name} …', { name: h.friend.name })}</span>
          <button class="btn small ghost" onClick=${() => cancelInvite(h.id)}>${t('common.cancel', 'Cancel')}</button>`}
    </div>`)}
    ${picking && left > 0 && html`<${FriendPicker} max=${left} onClose=${() => setPicking(false)} onPick=${send} exclude=${hosted.filter((h) => !['expired', 'cancelled'].includes(h.state?.phase)).map((h) => h.friend.id)} />`}
  </div>`;
}
