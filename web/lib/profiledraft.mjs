// The profile editor's draft (web/views/profileedit.mjs, design 3.0 "B · Parts drawer"): one editing session with one
// Save / Cancel. Every pick tries itself on at once; the bar counts the parts that differ from what is saved, each
// part can go "Back to saved" alone, and Save sends only what changed. A souldew+ item tried on without the membership
// never blocks Save – Save keeps the saved (free) item for that part and saves the rest. Pure, so
// test/profiledraft.test.mjs checks it without a page.
import { SHOWCASE_LAYOUTS, DEFAULT_SHOWCASE_LAYOUT, PROFILE_VISIBILITY, PRESENCE_VISIBILITY } from '/shared/social.mjs';

/** Every editable part: the draft fields it owns, and whether its picker wants a wide drawer. */
export const PARTS = {
  banner: { keys: ['banner'], wide: true },
  frame: { keys: ['frame'], wide: true },
  nameplate: { keys: ['nameplate'], wide: true },
  accent: { keys: ['accent'] },
  name: { keys: ['name', 'status'] },
  title: { keys: ['title'] },
  layout: { keys: ['layout'] },
  trophies: { keys: ['trophies'], wide: true },
  trusted: { keys: ['trusted', 'note', 'legacy'], wide: true },
  fav: { keys: ['fav'] },
  privacy: { keys: ['vis', 'runs', 'presence'] },
};
/** The drawer's groups, in the order of the list (and of the part dots, L / R). */
export const GROUPS = [['look', ['banner', 'frame', 'nameplate', 'accent']], ['about', ['name', 'title']], ['showcase', ['layout', 'trophies', 'trusted', 'fav']], ['privacy', ['privacy']]];
export const ORDER = GROUPS.flatMap(([, ids]) => ids);
/** The parts that can hold a souldew+ item. */
export const LOCKABLE = ['banner', 'frame', 'nameplate'];

const pad3 = (a) => [0, 1, 2].map((i) => (Array.isArray(a) && a[i]) || null);

/** The saved profile (the account's `me`, lib/account.mjs) → the draft's starting point. */
export function draftFrom(me) {
  const sc = me?.showcase || {};
  const p = me?.privacy || {};
  const tr = sc.trusted && typeof sc.trusted === 'object' ? sc.trusted : null;
  return {
    banner: me?.banner || null, frame: me?.frame || null, nameplate: me?.nameplate || null, title: me?.title || null, accent: me?.accent || null,
    name: me?.name || '', status: me?.status || '',
    trophies: pad3(sc.trophies),
    trusted: tr ? { species: tr.species, line: tr.line || tr.species } : null,
    note: tr?.note || '',
    legacy: tr ? null : sc.trustedText || null, // the old free-text "most trusted", kept until a line replaces it
    fav: sc.favoriteGame || '',
    layout: SHOWCASE_LAYOUTS.includes(me?.showcaseLayout) ? me.showcaseLayout : DEFAULT_SHOWCASE_LAYOUT,
    vis: PROFILE_VISIBILITY.includes(p.profile) ? p.profile : 'friends', runs: p.showRuns === true, presence: PRESENCE_VISIBILITY.includes(p.presence) ? p.presence : 'friends',
  };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Has this part changed against the saved draft? */
export const partChanged = (initial, d, id) => PARTS[id].keys.some((k) => !same(initial[k], d[k]));
/** The changed parts, in the drawer's order – the bar says "n changes not saved". */
export const changedParts = (initial, d) => ORDER.filter((id) => partChanged(initial, d, id));
/** "Back to saved" for one part. */
export const revertPart = (initial, d, id) => ({ ...d, ...Object.fromEntries(PARTS[id].keys.map((k) => [k, initial[k]])) });

/**
 * The trophy cabinet: put `id` (a catalog id, or null to take one out) into place `slot` (0–2). A trophy already in
 * another place swaps with what was in `slot`, so one trophy is never shown twice.
 */
export function placeTrophy(trophies, slot, id) {
  const t = pad3(trophies);
  const at = id ? t.indexOf(id) : -1;
  if (at >= 0 && at !== slot) t[at] = t[slot];
  t[slot] = id || null;
  return t;
}
/** After a pick: the next empty place (the cabinet moves on to it), else the same one. */
export function nextSlot(trophies, slot) {
  const t = pad3(trophies);
  const next = [1, 2].map((k) => (slot + k) % 3).find((i) => !t[i]);
  return next ?? slot;
}

/**
 * Save: the PATCH for lib/account.mjs updateMe (the page's camelCase shape) – only what differs from `initial`.
 * `locked`: parts whose tried-on souldew+ item can't be kept; they stay as saved (the free item) and the rest saves.
 * An emptied display name is sent as null (the service falls back to the Discord name). null when nothing changed.
 */
export function savePatch(initial, d, { locked = [] } = {}) {
  const patch = {};
  for (const k of ['banner', 'frame', 'nameplate', 'title', 'accent']) {
    if (locked.includes(k)) continue;
    if ((d[k] || null) !== (initial[k] || null)) patch[k] = d[k] || null;
  }
  if (d.name.trim() !== initial.name.trim()) patch.name = d.name.trim() || null;
  if (d.status.trim() !== initial.status.trim()) patch.status = d.status.trim() || null;
  const sc = (x) => ({
    trophies: x.trophies.filter(Boolean),
    trusted: x.trusted ? { species: x.trusted.species, line: x.trusted.line, note: x.note.trim() || null } : null,
    trustedText: x.trusted ? null : x.legacy || null,
    favoriteGame: x.fav.trim() || null,
  });
  if (!same(sc(d), sc(initial))) patch.showcase = sc(d);
  if (d.layout !== initial.layout) patch.showcaseLayout = d.layout;
  const priv = {};
  if (d.vis !== initial.vis) priv.profile = d.vis;
  if (d.runs !== initial.runs) priv.showRuns = d.runs;
  if (d.presence !== initial.presence) priv.presence = d.presence;
  if (Object.keys(priv).length) patch.privacy = priv;
  return Object.keys(patch).length ? patch : null;
}

/** Is a leave from the editor (to `nextHash`) one that should ask first? Staying in the editor never asks. */
export function leaveAsks(nextHash, changed) {
  if (!changed) return false;
  const [route, query = ''] = String(nextHash || '').replace(/^#\/?/, '').split('?');
  return !(route === 'profile' && new URLSearchParams(query).has('edit'));
}
