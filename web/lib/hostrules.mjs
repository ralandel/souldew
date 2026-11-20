// A SoulLink's rules are the host's (shared/hostrules.mjs): this app takes a `rules` entry from the link only with the
// host's signature for its timestamp, and the host's app writes them signed (the key is on its server – POST
// /api/runs/:id/rules). A solo Nuzlocke has no host key: nothing changes there.
import { api } from './api.mjs';
import { HOST_DOC_KEY, isHostKey, signedFor, rulesPayload, verifyHostRules, unsigned, hostSlotOf, canEditRules } from '/shared/hostrules.mjs';
import { runMode } from '/shared/slots.mjs';

export { canEditRules };

/**
 * The doc guard (RunDoc.guard) of run `runId`. `doc.hostKey` is the host's public key – unknown (a run whose host is
 * still on an older version): everything is taken, as before. Known: a `rules` entry only with a valid signature for its
 * timestamp, and a `host` announcement only with that same key.
 */
export function hostGuard(doc, runId) {
  const checked = new Map(); // payload + signature → 'signed' / true / false
  return (key, e) => {
    if (key === HOST_DOC_KEY) return !doc.hostKey || e.v?.key === doc.hostKey;
    if (key !== 'rules' || !doc.hostKey) return true;
    if (!signedFor(e.v, e.t)) return false;
    const id = `${e.v.sig}\n${rulesPayload(runId, e.v)}`;
    if (checked.has(id)) return checked.get(id);
    return verifyHostRules(runId, doc.hostKey, e.v, e.t).then((ok) => {
      // 'signed': the host's – taken at the exact timestamp it was signed for (RunDoc.merge doesn't clamp it then).
      // A browser without Ed25519 can't check – it takes a signed entry, as it took every entry before (clamped).
      const yes = ok === true ? 'signed' : ok !== false;
      if (checked.size > 200) checked.clear();
      checked.set(id, yes);
      return yes;
    });
  };
}

/**
 * RunDoc.outranks for a SoulLink: once the host's key is known, a `rules` entry signed for its timestamp beats an
 * unsigned one whatever the timestamps – the guard still checks the signature before it is taken. Without it, a
 * partner's unsigned entry with a later timestamp (a clock ahead of the host's, the same millisecond, an entry the
 * host's doc refused and so never moved its clock past) kept the host's signed rules out on that computer.
 */
export function hostOutranks(doc) {
  return (key, a, b) => key === 'rules' && !!doc.hostKey && !!a && !!b && signedFor(a.v, a.t) && !signedFor(b.v, b.t);
}

/**
 * The host writes the rules `next` (the whole set, unsigned): signed by this computer's server for a timestamp newer
 * than anything in the doc, then written at it. Resolves to the stored value; throws when this computer isn't the host's.
 */
export async function writeHostRules(doc, manifest, next, me) {
  // newer than anything in the doc – and than the rules themselves, which may be signed for later than the doc's clock
  const after = Math.max(doc.clock || 0, doc.entries.rules?.t || 0);
  const res = await api.post(`/api/runs/${manifest.id}/rules`, { rules: unsigned(next), after, me });
  if (isHostKey(res.hostKey)) doc.hostKey = res.hostKey;
  doc.setAt('rules', res.rules, res.rules.rev);
  announceHost(doc, res.host, res.hostKey);
  return res.rules;
}

/** The `host` entry everybody learns the key from (runs from before 2.8.2 – a new run's invite has it already). */
function announceHost(doc, slot, key) {
  if (!isHostKey(key)) return;
  const cur = doc.get(HOST_DOC_KEY);
  if (cur?.key !== key || cur?.slot !== slot) doc.set(HOST_DOC_KEY, { slot, key });
}

/**
 * Opening a run (app.mjs, after the doc has loaded) – initRules, then setupHostRules (a SoulLink):
 *  - the rules the run was made with (a new run, a fresh join), while the doc has none: written at the host's
 *    timestamp, so they are the host's signed value on every computer
 *  - the guard
 *  - on the host's computer: rules that aren't signed by its key yet (a run from before 2.8.2, or one a partner changed
 *    then) are signed as they stand – they stay what they are, only now under the host's authority – and the key is
 *    announced in the doc
 *  - elsewhere: a run without the key learns it from the host's announcement once (stored in the manifest).
 * `reload()` re-reads the manifest after it changed. Returns a function that stops listening.
 */
export function initRules(doc, manifest) {
  if (doc.get('rules') || !manifest.rules) return;
  if (signedFor(manifest.rules, manifest.rules.rev)) doc.setAt('rules', manifest.rules, manifest.rules.rev);
  else doc.set('rules', manifest.rules);
}

/** See initRules – after it (and after anything else the app writes into the rules when a run opens). */
export function setupHostRules(doc, manifest, { me, reload = () => {} } = {}) {
  const solo = runMode(manifest) === 'nuzlocke';
  doc.hostKey = !solo && isHostKey(manifest.hostKey) ? manifest.hostKey : null;
  if (solo) return () => {};
  doc.guard = hostGuard(doc, manifest.id);
  doc.outranks = hostOutranks(doc);
  if (canEditRules(manifest)) {
    const entry = doc.entries.rules;
    const own = doc.hostKey && entry && signedFor(entry.v, entry.t)
      ? verifyHostRules(manifest.id, doc.hostKey, entry.v, entry.t) : Promise.resolve(false);
    own.then((ok) => (ok === false ? writeHostRules(doc, manifest, doc.get('rules') || {}, me).then(reload) : announceHost(doc, hostSlotOf(manifest), doc.hostKey)))
      .catch(() => {}); // (server busy: the next time the run opens)
    return () => {};
  }
  // another player's computer: learn the key from the host's announcement (a run from before 2.8.2) – trust on first
  // use, so only an announcement that can be the host's: for the run's host player (`host`, older runs: p1 – the
  // creator), not for this computer's own player, not from this device, and – when the doc knows which device plays the
  // host's player (its live team, `live:<slot>`) – from that device. (Device ids aren't proof: the run from before
  // 2.8.2 has nothing signed to check against. A new run's invite carries the key, nothing is learned then.)
  const hostSlot = hostSlotOf(manifest);
  const adopt = () => {
    const e = doc.entries[HOST_DOC_KEY];
    const v = e?.v;
    if (doc.hostKey || !isHostKey(v?.key) || v.slot !== hostSlot || (me && v.slot === me) || e.by === doc.by) return;
    const plays = doc.entries[`live:${hostSlot}`]?.by;
    if (plays && plays !== e.by) return;
    doc.hostKey = v.key;
    api.post(`/api/runs/${manifest.id}/meta`, { hostKey: v.key, host: v.slot }).then(reload, () => {});
  };
  adopt();
  return doc.subscribe((keys) => (keys.includes(HOST_DOC_KEY) || keys.includes(`live:${hostSlot}`)) && adopt());
}
