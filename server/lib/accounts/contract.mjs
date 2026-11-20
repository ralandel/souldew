// The accounts service's HTTP contract as the app uses it (souldew-accounts docs/API.md, v1 of 2026-11-17) – every
// path the app calls, in one place. The service's address is its public hostname; SLS_ACCOUNTS_URL replaces it for
// development and tests (https, or http on this computer only – a test can never reach the real service by accident,
// and a typo can't send tokens elsewhere).

export const ACCOUNTS_URL = 'https://accounts.souldew.app';

/** The address in use: SLS_ACCOUNTS_URL when it is https (or http on loopback), else the service's. */
export function accountsBase(env = process.env) {
  const v = env.SLS_ACCOUNTS_URL;
  if (v) {
    try {
      const u = new URL(v);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (!u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && local))) return u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      // not a URL – the default
    }
  }
  return ACCOUNTS_URL;
}

const seg = (v) => encodeURIComponent(v);

export const API = {
  // §1 sign-in
  start: '/auth/discord/start',
  token: '/auth/token',
  logout: '/auth/logout',
  logoutAll: '/auth/logout-all',
  // §2 own account
  me: '/v1/me',
  handle: '/v1/me/handle',
  friendCode: '/v1/me/friend-code',
  stats: '/v1/me/stats',
  exportData: '/v1/me/export',
  sessions: '/v1/me/sessions?limit=50',
  session: (id) => `/v1/me/sessions/${seg(id)}`,
  catalog: '/v1/catalog',
  // §13 the public Thank you wall (no auth, ETag)
  thanks: '/v1/thanks',
  // §3 other users
  user: (id) => `/v1/users/${seg(id)}`,
  // §4 friends
  friends: '/v1/friends',
  friend: (id) => `/v1/friends/${seg(id)}`,
  requests: '/v1/friends/requests',
  requestsBox: (box) => `/v1/friends/requests?box=${box}&limit=100`,
  request: (id, action) => `/v1/friends/requests/${seg(id)}${action ? `/${action}` : ''}`,
  blocks: '/v1/blocks',
  blocksList: '/v1/blocks?limit=100',
  block: (id) => `/v1/blocks/${seg(id)}`,
  // §5 presence
  presence: '/v1/presence',
  presenceFriends: '/v1/presence/friends',
  pending: '/v1/pending',
  // §6 play with friends
  invites: '/v1/invites',
  invitesBox: (box) => `/v1/invites?box=${box}&limit=100`,
  invite: (id, action) => `/v1/invites/${seg(id)}${action ? `/${action}` : ''}`,
  joinRequests: '/v1/join-requests',
  joinBox: (box) => `/v1/join-requests?box=${box}&limit=100`,
  joinRequest: (id, action) => `/v1/join-requests/${seg(id)}${action ? `/${action}` : ''}`,
  // §7 reports
  reports: '/v1/reports',
  // §8 souldew+
  entitlements: '/v1/entitlements',
  linkEmail: '/v1/entitlements/link-email',
  unlink: '/v1/entitlements/link',
  // §10 packs
  packs: '/v1/packs',
  packDownload: (id) => `/v1/packs/${seg(id)}/download`,
  packPreview: (id) => `/v1/packs/${seg(id)}/preview`,
};
