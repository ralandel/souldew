// Settings › Account: the souldew account. Signed out – what it is for and "Sign in with Discord" (nothing else in the
// app needs it). Signed in – who you are (Discord name and picture, handle, friend code), privacy and presence, the
// opt-in for showing your runs, souldew+ and linking a membership, your data (export, delete) and signing out.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { t, ago } from '../../lib/i18n.mjs';
import { Icon } from '../../lib/icons.mjs';
import { Modal, download, openExternal } from '../../lib/ui.mjs';
import { LINKS } from '../../lib/links.mjs';
import {
  useAccount, signIn, cancelSignIn, signOut, updateMe, setHandle, newFriendCode, exportData, deleteAccount, linkEmail, reloadAccount, isPlus,
  unlinkMembership, listSessions, signOutSession,
} from '../../lib/account.mjs';
import { refreshPack, forgetPack } from '../../lib/cosmetics/index.mjs';
import { askToJoinAllowed, setAskToJoin } from '../../lib/friendpresence.mjs';
import { Avatar, Badges, CodeChip } from '../social.mjs';
import { Item, Group, Check } from './parts.mjs';
import { PlusShowcase } from './cosmetics.mjs';

const tierName = (tier) => ({ plus: 'souldew+', patron: t('acct.patronTier', 'souldew+ · Legend'), supporter: t('acct.supporter', 'Supporter') }[tier] || t('acct.tierNone', 'No membership'));
const dateOf = (ms) => (ms ? new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '');

function SignedOut({ acct, toast }) {
  const s = acct.session;
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await signIn();
    } catch (e) {
      toast({ kind: 'death', title: t('acct.signInFailed', 'Signing in didn’t start'), text: e.message });
    }
    setBusy(false);
  };
  return html`
        <div class="acct-intro stack">
          <p>${t('acct.intro', 'An account is optional. Everything in souldew works without one – signing in only adds the social side:')}</p>
          <ul class="acct-gets">
            <li><${Icon} name="user" size=${14} /><span>${t('acct.getProfile', 'A profile with your title, trophies and – if you like – your runs')}</span></li>
            <li><${Icon} name="heart" size=${14} /><span>${t('acct.getFriends', 'Friends: see who is online and what they play')}</span></li>
            <li><${Icon} name="link" size=${14} /><span>${t('acct.getInvites', 'Invite friends into a SoulLink with one click – no code to read out')}</span></li>
            <li><${Icon} name="star" size=${14} /><span>${t('acct.getPlus', 'souldew+ looks for your profile if you support souldew')}</span></li>
          </ul>
          ${s.condition === 'expired' && html`<p class="warning info" role="status">${t('acct.expired', 'You were signed out – the session ended on another device or was signed out everywhere. Sign in again to continue.')}</p>`}
          ${s.condition === 'unreadable' && html`<p class="warning info" role="status">${t('acct.unreadable', 'souldew couldn’t read your saved sign-in – sign in again. Your runs and settings are fine.')}</p>`}
          ${!s.persistent && html`<p class="small muted">${t('acct.noKeychain', 'This computer has no keychain souldew can use, so you would stay signed in only until you close the app – souldew never keeps your sign-in in a plain file.')}</p>`}
          ${s.pending ? html`<div class="row"><span class="small">${t('acct.pending', 'Finish signing in in your browser …')}</span>
              <button class="btn small ghost" onClick=${() => cancelSignIn()}>${t('common.cancel', 'Cancel')}</button>
              <button class="btn small ghost" onClick=${go}>${t('acct.openAgain', 'Open the browser again')}</button></div>`
            : html`<div><button class="btn primary big acct-discord" disabled=${busy} onClick=${go}><${Icon} name="discord" size=${16} />${t('acct.signIn', 'Sign in with Discord')}</button></div>`}
          <p class="small muted">${t('acct.signInNote', 'Opens your browser. souldew only gets your Discord name and picture – no email, no servers, no messages. You never type your Discord password into souldew.')}</p>
        </div>`;
}

function DeleteModal({ me, onClose, toast }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = typed.trim().replace(/^@/, '').toLowerCase() === me.handle;
  const go = async () => {
    setBusy(true);
    try {
      await deleteAccount(me.handle);
      toast({ kind: 'ok', title: t('acct.deleted', 'Your souldew account is deleted'), text: t('acct.deletedText', 'Your profile, friends and invites are gone. Your runs on this computer stay.') });
      onClose();
    } catch (e) {
      toast({ kind: 'death', title: t('acct.deleteFailed', 'Couldn’t delete the account'), text: e.message });
    }
    setBusy(false);
  };
  return html`<${Modal} open onClose=${onClose} title=${t('acct.deleteTitle', 'Delete your souldew account?')}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn danger" disabled=${!ok || busy} onClick=${go}>${t('acct.deleteNow', 'Delete account')}</button>`}>
    <div class="stack">
      <p class="muted">${t('acct.deleteText', 'This deletes your profile, friends, friend requests, invites and every session right away. It can’t be undone. Your runs, saves and trophies on this computer are not touched.')}</p>
      <label class="field"><span>${t('acct.deleteType', 'Type your handle {handle} to confirm', { handle: `@${me.handle}` })}</span>
        <input type="text" autocomplete="off" spellcheck="false" value=${typed} onInput=${(e) => setTyped(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && ok && go()} /></label>
    </div>
  <//>`;
}

function HandleField({ me, toast }) {
  const [v, setV] = useState(me.handle);
  useEffect(() => setV(me.handle), [me.handle]);
  const changed = v.trim().replace(/^@/, '').toLowerCase() !== me.handle;
  const save = async () => {
    try {
      await setHandle(v.trim());
      toast({ kind: 'ok', title: t('acct.handleSaved', 'Handle changed'), text: `@${v.trim().replace(/^@/, '').toLowerCase()}` });
    } catch (e) {
      toast({ kind: 'death', title: t('acct.handleFailed', 'Couldn’t change the handle'), text: e.message });
    }
  };
  return html`<label class="field"><span>${t('acct.handle', 'Handle')}</span>
    <div class="row nowrap"><span class="acct-at" aria-hidden="true">@</span><input type="text" class="grow" value=${v} maxLength="20" spellcheck="false" autocomplete="off"
      onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && changed && save()} />
    <button class="btn" disabled=${!changed} onClick=${save}>${t('common.save', 'Save')}</button></div>
    <span class="hint">${t('acct.handleHint', '3–20 letters, digits or _. Friends can find you by it. You can change it 3 times a week.')}</span></label>`;
}

/** "Unlink membership" – asks first: what goes away, that the payment itself isn't cancelled, the 30-day re-link wait. */
function UnlinkModal({ tier, onClose, toast }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await unlinkMembership();
      // the local server wiped the encrypted cache already; the page drops what it had in memory
      await forgetPack().catch(() => {});
      refreshPack().catch(() => {});
      toast({ kind: 'ok', title: t('acct.unlinked', 'Membership unlinked'), text: t('acct.unlinkedText', 'This account no longer has it. You can link the same email again in 30 days.') });
      onClose();
    } catch (e) {
      toast({ kind: 'death', title: t('acct.unlinkFailed', 'Couldn’t unlink the membership'), text: e.vars?.code === 'rate_limited' ? t('acct.unlinkLimit', 'Unlinking works 5 times a day – try again tomorrow.') : e.message });
      setBusy(false);
    }
  };
  return html`<${Modal} open onClose=${onClose} title=${t('acct.unlinkTitle', 'Unlink the membership from this account?')}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn danger" disabled=${busy} onClick=${go}>${t('acct.unlinkNow', 'Unlink membership')}</button>`}>
    <div class="stack">
      <ul class="acct-gets">
        <li><${Icon} name="close" size=${14} /><span>${isPlus(tier) ? t('acct.unlinkPlus', 'souldew+ ends for this account on every device: your profile goes back to the free banners and frames, the souldew+ look on this computer is deleted.')
          : t('acct.unlinkSupporter', 'The Supporter badge goes away from this account on every device.')}</span></li>
        <li><${Icon} name="clock" size=${14} /><span>${t('acct.unlinkCooldown', 'The membership’s email can be linked again – to this or another account – only 30 days after it was linked, and at least 7 days from now.')}</span></li>
        <li><${Icon} name="coffee" size=${14} /><span>${t('acct.unlinkPayment', 'Your membership on Buy Me a Coffee keeps running – cancel it there if you want to stop paying.')}</span></li>
      </ul>
    </div>
  <//>`;
}

function PlusGroup({ me, toast }) {
  const ent = me.entitlement || { tier: 'none', badges: [] };
  const [unlink, setUnlink] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const link = async () => {
    setBusy(true);
    setResult(null);
    try {
      // the service answers "submitted" whatever the email is; the local server reads the entitlement afterwards
      const r = await linkEmail(email.trim());
      setResult(r.linked ? 'linked' : 'nomatch');
      if (r.linked) {
        setEmail('');
        if (isPlus(r.tier)) refreshPack().catch(() => {});
      }
    } catch (e) {
      if (e.vars?.code === 'locked_out' || e.vars?.code === 'rate_limited') setResult('locked');
      else toast({ kind: 'death', title: t('acct.linkFailed', 'Couldn’t link the membership'), text: e.message });
    }
    setBusy(false);
  };
  const check = async () => {
    const s = await reloadAccount();
    refreshPack().catch(() => {});
    toast({ kind: 'ok', title: t('acct.checked', 'Membership checked'), text: tierName(s.me?.entitlement?.tier || me.entitlement?.tier) });
  };
  return html`
      <div class="stack">
        <div class="row"><span class=${`chip ${isPlus(ent.tier) ? 'ok' : ''}`}>${tierName(ent.tier)}</span>
          ${ent.until && html`<span class="small muted">${t('acct.until', 'until {date}', { date: dateOf(ent.until) })}</span>`}<${Badges} badges=${ent.badges} /></div>
        <p class="small muted">${isPlus(ent.tier) ? t('acct.plusThanks', 'Thank you for supporting souldew! Your souldew+ banners, frames and nameplates are in the profile editor.')
          : t('acct.plusText2', 'souldew stays free. If you support it on Buy Me a Coffee, souldew+ adds banners, frames and nameplates for your profile, the colour themes and everything for your handheld. Supporter gets a badge and the 3D launch with your own handheld.')}</p>
        ${!isPlus(ent.tier) && html`<div class="row"><a class="btn small go" href="#/plus"><${Icon} name="plus" size=${12} />${t('acct.seePlus', 'See souldew+')}</a>
          <button class="btn small ghost" onClick=${() => openExternal(LINKS.coffee)}><${Icon} name="coffee" size=${14} />${t('acct.toCoffee', 'Buy Me a Coffee')}</button></div>`}
        ${!isPlus(ent.tier) && html`<${PlusShowcase} />`}
        ${ent.tier !== 'none' && html`<div class="row"><button class="btn small ghost" onClick=${() => setUnlink(true)}>${t('acct.unlink', 'Unlink membership …')}</button>
          <span class="small muted">${t('acct.unlinkHint', 'Takes it off this account, e.g. to move it to another one. Re-linking the email waits 30 days.')}</span></div>`}
        ${unlink && html`<${UnlinkModal} tier=${ent.tier} toast=${toast} onClose=${() => setUnlink(false)} />`}
        <details class="group"><summary>${t('acct.linkTitle', 'Link a membership you already have')}</summary>
          <div class="stack" style="padding:6px 14px 14px">
            ${busy && html`<p class="small muted" role="status">${t('acct.linkChecking', 'Checking the membership …')}</p>`}
            <label class="field"><span>${t('acct.linkEmail', 'The email you used on Buy Me a Coffee')}</span>
              <div class="row nowrap"><input type="email" class="grow" value=${email} autocomplete="email" spellcheck="false" onInput=${(e) => setEmail(e.target.value)}
                onKeyDown=${(e) => e.key === 'Enter' && email.includes('@') && link()} />
              <button class="btn" disabled=${busy || !email.includes('@')} onClick=${link}>${t('acct.link', 'Link')}</button></div>
              <span class="hint">${t('acct.linkHint', 'souldew sends nothing to this address – the service only compares it with the membership. It isn’t stored.')}</span></label>
            ${result === 'linked' && html`<p class="note small" role="status">${t('acct.linked', 'Linked – thank you!')}</p>`}
            ${result === 'nomatch' && html`<p class="warning info small" role="status">${t('acct.noMatchClaim', 'No membership found for this email. Check the spelling – it’s the address Buy Me a Coffee has – or use /supporter claim in the souldew Discord, or contact support.')}</p>`}
            ${result === 'locked' && html`<p class="warning info small" role="status">${t('acct.linkLocked', 'Too many tries – linking by email is paused for a while. /supporter claim in the souldew Discord works any time.')}</p>`}
            <div class="row"><span class="small muted grow">${t('acct.discordClaim', 'Already claimed with /supporter claim in the souldew Discord? That links it too.')}</span>
              <button class="btn small ghost" onClick=${check}>${t('acct.claimedDiscord', 'I already claimed on Discord')}</button></div>
          </div></details>
      </div>`;
}

const PLATFORM = { mac: 'Mac', win: 'Windows', linux: 'Linux' };
/** "Signed-in devices" (§1.7): every session of the account, compact – this computer marked, the others signed out one by one. */
function Sessions({ toast }) {
  const [items, setItems] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(null);
  const load = () => listSessions().then((r) => {
    setItems(r.items || []);
    setFailed(false);
  }).catch(() => setFailed(true));
  useEffect(() => {
    load();
  }, []);
  const out = async (x) => {
    setBusy(x.id);
    try {
      await signOutSession(x.id);
      toast({ kind: 'ok', title: t('acct.deviceOut', 'Device signed out'), text: t('acct.deviceOutText', 'It needs to sign in again to use your account.') });
      await load();
    } catch (e) {
      toast({ kind: 'death', title: t('acct.deviceOutFailed', 'Couldn’t sign that device out'), text: e.message });
    }
    setBusy(null);
  };
  const name = (x) => (x.platform ? t('acct.devicePlatform', 'souldew on {platform}', { platform: PLATFORM[x.platform] }) : x.device || 'souldew');
  return html`<div class="stack">
    <p class="small muted">${t('acct.devicesText', 'Everywhere you’re signed in to this account. Sign out a device you don’t use or don’t recognise.')}</p>
    ${failed && html`<p class="warning info small" role="status">${t('acct.devicesFailed', 'The list can’t be loaded right now.')}</p>`}
    ${items && html`<ul class="acct-sessions">${[...items].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0)).map((x) => html`<li key=${x.id}>
      <span class="stack-s grow" style="gap:0"><b>${name(x)}</b>
        <span class="tiny muted">${x.lastUsedAt ? t('acct.deviceUsed', 'Last used {when}', { when: ago(Date.parse(x.lastUsedAt)) }) : ''}${x.createdAt ? ` · ${t('acct.deviceSince', 'signed in {date}', { date: dateOf(x.createdAt) })}` : ''}</span></span>
      ${x.current ? html`<span class="chip ok">${t('acct.thisDevice', 'This computer')}</span>`
        : html`<button class="btn small ghost" disabled=${busy === x.id} onClick=${() => out(x)}>${t('acct.deviceSignOut', 'Sign out')}</button>`}
    </li>`)}</ul>`}
  </div>`;
}

/** The signed-in bodies of the section's settings (hooks inside – called as a hook by AccountSection). */
function useSignedIn(acct, toast) {
  const me = acct.me;
  const brief = acct.brief || acct.session.account || {};
  const s = acct.session;
  const [del, setDel] = useState(false);
  const [askJoin, setAskJoinState] = useState(askToJoinAllowed());
  const patch = async (p) => {
    try {
      await updateMe(p);
    } catch (e) {
      toast({ kind: 'death', title: t('set.saveFailed', 'Couldn’t save the setting'), text: e.message });
      await reloadAccount();
    }
  };
  const out = async (everywhere) => {
    const r = await signOut(everywhere).catch((e) => ({ error: e }));
    if (r?.error) toast({ kind: 'death', title: t('acct.signOutFailed', 'Couldn’t sign out'), text: r.error.message });
    else toast({ kind: 'ok', title: everywhere ? t('acct.signedOutAll', 'Signed out everywhere') : t('acct.signedOut', 'Signed out'),
      text: r.reached ? '' : t('acct.signedOutOffline', 'Signed out here. The account service couldn’t be reached – the session ends there on its own.') });
  };
  const doExport = async () => {
    try {
      download('souldew-account-export.json', JSON.stringify(await exportData(), null, 2));
    } catch (e) {
      toast({ kind: 'death', title: t('acct.exportFailed', 'Couldn’t export your data'), text: e.message });
    }
  };
  const p = me?.privacy;
  const who = html`
        <div class="stack">
          <div class="acct-who">
            <${Avatar} user=${me || brief} size=${56} />
            <div class="stack-s grow" style="gap:2px">
              <b class="acct-name">${me?.name || brief.name || ''}</b>
              <span class="small muted">@${me?.handle || brief.handle || ''}${me?.discord?.username ? html` · ${t('acct.discordAs', 'Discord: {name}', { name: me.discord.username })}` : ''}</span>
            </div>
            <a class="btn small" href="#/profile">${t('acct.openProfile', 'Open profile')}</a>
          </div>
          ${s.condition === 'offline' && html`<p class="warning info small" role="status">${t('acct.offline', 'The account service can’t be reached right now – showing what souldew knew last. Friends and invites come back once you’re online.')}</p>`}
          ${s.condition === 'suspended' && html`<p class="warning small" role="status">${t('acct.suspended', 'This souldew account is suspended. Your runs on this computer work as always.')}</p>`}
          ${!s.persistent && html`<p class="small muted">${t('acct.memoryOnly', 'This computer has no keychain souldew can use: you stay signed in until you close the app, then you sign in again. souldew never keeps your sign-in in a plain file.')}</p>`}
          ${me && html`<div class="grid-2">
            <${HandleField} me=${me} toast=${toast} />
            <div class="field"><span>${t('acct.friendCode', 'Friend code')}</span>
              <div class="row nowrap"><${CodeChip} code=${me.friendCode} onCopy=${() => toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: me.friendCode })} />
                <button class="btn small ghost" onClick=${() => newFriendCode().catch((e) => toast({ kind: 'death', title: t('acct.codeFailed', 'Couldn’t make a new code'), text: e.message }))}>${t('acct.newCode', 'New code')}</button></div>
              <span class="hint">${t('acct.friendCodeHint', 'Give it to a friend so they can add you. A new code makes the old one stop working.')}</span></div>
          </div>`}
        </div>`;
  const privacy = p && html`
        <div class="stack">
          <div class="grid-2">
            <label class="field"><span>${t('acct.profileVis', 'Who can see my profile')}</span>
              <select value=${p.profile} onChange=${(e) => patch({ privacy: { profile: e.target.value } })}>
                <option value="friends">${t('acct.visFriends', 'My friends')}</option>
                <option value="link">${t('acct.visLink', 'Anyone with my handle')}</option>
                <option value="nobody">${t('acct.visNobody', 'Only me')}</option></select></label>
            <label class="field"><span>${t('acct.presenceVis', 'Show friends what I’m doing')}</span>
              <select value=${p.presence} onChange=${(e) => patch({ privacy: { presence: e.target.value } })}>
                <option value="friends">${t('acct.presFriends', 'Yes – online, the game I play')}</option>
                <option value="offline">${t('acct.presOffline', 'Appear offline')}</option>
                <option value="nobody">${t('acct.presNobody', 'Hide me completely')}</option></select>
              <span class="hint">${p.presence === 'friends' ? t('acct.presHint', 'While souldew runs: online, in the library, the game or run you play. Never your saves or where you are in a game unless you allow it below.')
                : t('acct.presOffHint', 'souldew then sends nothing about what you do – you still get friend requests and invites.')}</span></label>
          </div>
          <${Check} checked=${p.showLocation} disabled=${p.presence !== 'friends'} onChange=${(v) => patch({ privacy: { showLocation: v } })}
            label=${t('acct.showLocation', 'Show friends where I am in the game')} hint=${t('acct.showLocationHint', 'The route or town your run is on, next to the game.')} />
          <${Check} checked=${p.showRuns} onChange=${(v) => patch({ privacy: { showRuns: v } })}
            label=${t('acct.showRuns', 'Show my runs on my profile')}
            hint=${t('acct.showRunsHint', 'Uploads summary numbers only – runs, wins, catches, deaths, badges, play time and your last five runs by name and game. Never saves, ROMs or files. Turning it off deletes them from the service.')} />
          <${Check} checked=${p.showOnThanks === true} onChange=${(v) => patch({ privacy: { showOnThanks: v } })}
            label=${t('acct.showOnThanks', 'Show my name on the Thank you page')}
            hint=${t('acct.showOnThanksHint', 'While you support souldew: your name, Discord picture, banner and frame, with your tier. Off unless you switch it on – you’re counted either way.')} />
          <${Check} checked=${askJoin} disabled=${p.presence !== 'friends'} onChange=${(v) => { setAskToJoin(v); setAskJoinState(v); }}
            label=${t('acct.askToJoin', 'Friends may ask to join my SoulLink when a seat is free')}
            hint=${t('acct.askToJoinHint', 'They see “Ask to join” next to your run. You decide every time.')} />
          <label class="field" style="max-width:420px"><span>${t('acct.requestsFrom', 'Friend requests')}</span>
            <select value=${p.friendRequests} onChange=${(e) => patch({ privacy: { friendRequests: e.target.value } })}>
              <option value="everyone">${t('acct.reqEveryone', 'Anyone with my handle or friend code')}</option>
              <option value="nobody">${t('acct.reqNobody', 'Nobody')}</option></select></label>
        </div>`;
  const data = html`
        <div class="stack">
          <p class="small muted">${t('acct.dataText', 'Download everything the souldew account service stores about you as a JSON file, or delete the account.')}</p>
          <div class="row">
            <button class="btn small" disabled=${!me} onClick=${doExport}><${Icon} name="download" size=${14} />${t('acct.export', 'Export my data')}</button>
            <button class="btn small danger" disabled=${!me} onClick=${() => setDel(true)}>${t('acct.delete', 'Delete account …')}</button>
          </div>
          <div class="row acct-out">
            <button class="btn small" onClick=${() => out(false)}>${t('acct.signOut', 'Sign out')}</button>
            <button class="btn small ghost" onClick=${() => out(true)}>${t('acct.signOutAll', 'Sign out everywhere')}</button>
            <span class="small muted">${t('acct.signOutAllHint', 'Everywhere: every device where you’re signed in.')}</span>
          </div>
          ${del && me && html`<${DeleteModal} me=${me} toast=${toast} onClose=${() => setDel(false)} />`}
        </div>`;
  return { who, privacy, data, plus: me && html`<${PlusGroup} me=${me} toast=${toast} />`, sessions: html`<${Sessions} toast=${toast} />` };
}

/**
 * Each setting of this tab is one <Item> (Settings' search finds it, a deep link scrolls to it). Signed out only the
 * first one is there; the others appear once signed in.
 */
export function AccountSection({ toast }) {
  const acct = useAccount();
  const on = acct.loaded && acct.session.signedIn;
  const parts = useSignedIn(acct, toast);
  return html`
    <${Group} title=${t('acct.title', 'souldew account')}>
      <${Item} id="account">${!acct.loaded ? html`<p class="muted small">${t('common.loading', 'Loading …')}</p>` : on ? parts.who : html`<${SignedOut} acct=${acct} toast=${toast} />`}<//>
    <//>
    ${on && parts.privacy && html`<${Group} title=${t('acct.privacy', 'Privacy')}><${Item} id="account-privacy">${parts.privacy}<//><//>`}
    ${on && parts.plus && html`<${Group} title="souldew+"><${Item} id="plus">${parts.plus}<//><//>`}
    ${acct.loaded && !on && html`<${Group} title="souldew+"><${Item} id="plus-show"><div class="stack">
      <p class="small muted">${t('acct.plusText2', 'souldew stays free. If you support it on Buy Me a Coffee, souldew+ adds banners, frames and nameplates for your profile, the colour themes and everything for your handheld. Supporter gets a badge and the 3D launch with your own handheld.')}</p>
      <${PlusShowcase} /></div><//><//>`}
    ${on && html`<${Group} title=${t('acct.devices', 'Signed-in devices')}><${Item} id="account-sessions">${parts.sessions}<//><//>`}
    ${on && html`<${Group} title=${t('acct.dataTitle', 'Your data')}><${Item} id="account-data">${parts.data}<//><//>`}`;
}
