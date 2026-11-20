// The host's key of a SoulLink (shared/hostrules.mjs): an Ed25519 key pair per run, made on the computer that created
// the run. The private key stays in the run folder (host-key.pem – never in the manifest, the run pack or the doc); the
// public key is the manifest's `hostKey`, which the run pack hands to the other players.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { runDir } from './build.mjs';
import { httpError } from './fsutil.mjs';
import { ALL_SLOTS, slotsOf, runMode } from '../../shared/slots.mjs';
import { rulesPayload, unsigned, hostSlotOf } from '../../shared/hostrules.mjs';

const keyFile = (id) => join(runDir(id), 'host-key.pem');

const publicOf = (priv) => createPublicKey(priv).export({ format: 'jwk' }).x;

/** Can this computer change the rules of run `m`? Only a SoulLink's creator (a solo run has no host key). */
export const isHostComputer = (m) => !!m && !m.imported && runMode(m) !== 'nuzlocke'; // (a SoulLink or a Play together)

/**
 * The run's private host key – made now when the creator's computer has none yet (a run from before 2.8.2): then the
 * manifest gets `hostKey` and `host` (the slot that plays on this computer, `mySlot`; else the one it names, or p1).
 * Changes `m` in place (the caller writes it). Throws for a run that this computer didn't create.
 */
export function hostKeyFor(m, mySlot = null) {
  if (!isHostComputer(m)) throw httpError(403, 'Only the host can change the rules of this run', 'notHost');
  const file = keyFile(m.id);
  let priv = null;
  if (existsSync(file)) {
    try {
      priv = createPrivateKey(readFileSync(file, 'utf8'));
    } catch {
      priv = null; // a damaged file: a new key (the others take a changed key only from a new invite)
    }
  }
  if (!priv) {
    priv = generateKeyPairSync('ed25519').privateKey;
    writeFileSync(file, priv.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    try {
      chmodSync(file, 0o600); // only this user (no effect on Windows)
    } catch { /* fine */ }
  }
  m.hostKey = publicOf(priv);
  if (!ALL_SLOTS.includes(m.host)) m.host = slotsOf(m).includes(mySlot) ? mySlot : hostSlotOf(m);
  return priv;
}

/**
 * The rules `rules` signed by the host of run `m` for doc timestamp `rev` (now, but later than `after` – the newest
 * timestamp the doc has seen, so the write wins). Sets `m.rules` too.
 */
export function signRules(m, rules, { after = 0, mySlot = null, now = Date.now() } = {}) {
  const priv = hostKeyFor(m, mySlot);
  const rev = Math.max(now, Number.isFinite(after) ? Math.floor(after) + 1 : 0);
  const value = { ...(unsigned(rules) || {}), rev };
  value.sig = sign(null, Buffer.from(rulesPayload(m.id, value)), priv).toString('base64url');
  m.rules = value;
  return value;
}
