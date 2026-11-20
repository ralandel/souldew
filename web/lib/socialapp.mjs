// The souldew account's part of the app shell (app.mjs): reports what the player does (presence), turns new friend
// requests, invites and join requests into toasts, asks the host about friends who want in, and gives the sidebar
// its Friends entry (online count, things to answer) and the profile chip. Signed out it does nothing at all.
import { useEffect, useRef } from '/vendor/htm-preact.mjs';
import { api } from './api.mjs';
import { t } from './i18n.mjs';
import { useAccount, onPending, onSignedIn, useOnlineFriends, accountState } from './account.mjs';
import { reportFrom } from './friendpresence.mjs';
import { setRequestListener, allowFriend } from './friendinvite.mjs';
import { authTexts } from './authtexts.mjs';
import { takenSlots } from '../views/invitecode.mjs';
import { setPlusHandler, refreshPack, forgetPack } from './cosmetics/index.mjs';

const SEEN_KEY = 'sl-social-seen';
const loadSeen = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
};
const saveSeen = (set) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-300)));
  } catch {
    // private mode: they may show again after a restart
  }
};

export function useSocial({ ready, route, session, manifest, doc, me, linkStatus, toast, navigate }) {
  const acct = useAccount();
  const on = ready && !!acct.session?.signedIn;
  const online = useOnlineFriends(on);

  // souldew+ cosmetics: the pack comes through this account (app.mjs sets the provider at boot – it waits until the
  // account is known); every "Get souldew+" (theme picker, locked items in the profile editor, a friend's souldew+
  // banner) leads to the souldew+ page – signed in or not, never a pop-up
  const wasOn = useRef(false);
  useEffect(() => {
    if (!ready) return;
    setPlusHandler(() => navigate('plus'));
    // nothing before the account is known: "signed out" then only means the saved sign-in is still being read
    if (!acct.known) return;
    if (on) refreshPack().catch(() => {});
    else if (wasOn.current) forgetPack().catch(() => {}); // signed out just now: the membership's pack goes
    wasOn.current = on;
  }, [on, ready, acct.known]);

  // "You're signed in" – wherever the player is when the browser hands the sign-in back
  useEffect(() => onSignedIn(() => toast({ kind: 'ok', title: authTexts().okTitle, text: t('acct.welcome', 'Welcome, {name}.', { name: accountState().me?.name || accountState().brief?.name || '' }) })), []);

  // presence: on every change of what the player does, and once a minute while the app is open
  const ctx = useRef(null);
  ctx.current = { route: route.route, session, manifest, doc, me, taken: manifest ? takenSlots(manifest, { me, doc, linkStatus }) : [] };
  const partners = Object.keys(linkStatus?.partners || {}).join();
  useEffect(() => {
    if (on) reportFrom(ctx.current);
  }, [on, route.route, session?.target?.key, manifest?.id, partners]);
  useEffect(() => {
    if (!on) return undefined;
    const id = setInterval(() => reportFrom(ctx.current), 60000);
    return () => clearInterval(id);
  }, [on]);

  // a friend's app asks to join a run this computer invited them to
  useEffect(() => {
    setRequestListener((entry) => toast({
      kind: 'soul', key: `friend-in-${entry.id}`, ttl: 60000,
      title: t('fr.wantsIn', '{name} wants to join {run}', { name: entry.friend.name, run: entry.runName }),
      text: t('fr.wantsInText', 'Your invite reached them – let them in?'),
      action: { label: t('code.allow', 'Allow'), run: () => allowFriend(entry.id) },
    }));
    return () => setRequestListener(null);
  }, [toast]);

  // new friend requests, invites and join requests → a toast each (once – remembered across restarts)
  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    const seen = loadSeen();
    const check = async () => {
      const [fr, inv] = await Promise.all([api.get('/api/account/friends').catch(() => null), api.get('/api/account/invites').catch(() => null)]);
      if (!alive) return;
      // friend requests: one toast for one, one summary for several (no stack of toasts after a day away)
      const fresh = (fr?.incoming || []).filter((r) => !seen.has(r.id));
      fresh.forEach((r) => seen.add(r.id));
      if (fresh.length === 1) {
        toast({ kind: 'soul', title: t('fr.newRequest', '{name} wants to be friends', { name: fresh[0].from?.name || '' }), text: `@${fresh[0].from?.handle || ''}`,
          action: { label: t('fr.open', 'Open Friends'), run: () => navigate('friends') } });
      } else if (fresh.length > 1) {
        toast({ kind: 'soul', title: t('fr.newRequests', '{count} friend requests', { count: fresh.length }), text: fresh.map((r) => r.from?.name || '').filter(Boolean).slice(0, 3).join(', '),
          action: { label: t('fr.open', 'Open Friends'), run: () => navigate('friends') } });
      }
      for (const i of (inv?.incoming || []).filter((x) => x.status === 'pending')) {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
        toast({ kind: 'soul', ttl: 30000, title: t('fr.invitesYou', '{name} invites you to {run}', { name: i.from?.name || '', run: [i.run?.name, i.run?.game].filter(Boolean).join(' · ') }),
          text: t('fr.inviteToastText', 'Join with one click – you need your own copy of the game.'),
          action: { label: t('fr.join', 'Join'), run: () => navigate('soullink', { join: '1', invite: i.id }) } });
      }
      for (const j of (inv?.joinIncoming || []).filter((x) => x.status === 'pending')) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        toast({ kind: 'soul', ttl: 30000, title: t('fr.asksToJoin', '{name} asks to join your run', { name: j.from?.name || '' }),
          action: { label: t('fr.open', 'Open Friends'), run: () => navigate('friends') } });
      }
      saveSeen(seen);
    };
    check();
    const off = onPending(check);
    return () => {
      alive = false;
      off();
    };
  }, [on]);

  const p = acct.pending || {};
  return { signedIn: on, online, toAnswer: on ? (p.friendRequests || 0) + (p.invites || 0) + (p.joinRequests || 0) : 0, me: acct.me || acct.brief || null };
}
