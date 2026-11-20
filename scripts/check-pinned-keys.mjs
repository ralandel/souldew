#!/usr/bin/env node
// Release gate: a packaged build must carry the REAL pinned public keys of souldew+ – the pack signing key
// (web/lib/cosmetics/pack/keys.mjs PRODUCTION_KEYS) and the entitlement key (server/lib/accounts/enttoken.mjs
// PRODUCTION_ENTITLEMENT_KEYS). Placeholders fail closed in the app (nobody gets souldew+), which is safe but means a
// broken release – so `npm run dist*` and `npm run release` stop here until the owner pasted both keys.
//
//   node scripts/check-pinned-keys.mjs            exit 1 while a placeholder is pinned
//   SOULDEW_UNPINNED_TEST_BUILD=1 npm run dist      an internal test build anyway (loud warning; never for release.mjs)
import { PRODUCTION_KEYS } from '../web/lib/cosmetics/pack/keys.mjs';
import { PRODUCTION_ENTITLEMENT_KEYS, publicKey } from '../server/lib/accounts/enttoken.mjs';

/** → the list of problems (empty: both lists hold only real 32-byte Ed25519 keys). */
export function pinnedKeyProblems({ pack = PRODUCTION_KEYS, entitlement = PRODUCTION_ENTITLEMENT_KEYS } = {}) {
  const out = [];
  const check = (name, list) => {
    if (!list.length) out.push(`${name}: no key pinned`);
    for (const k of list) if (!publicKey(k)) out.push(`${name}: "${String(k).slice(0, 48)}" is not a public key (placeholder?)`);
  };
  check('pack key (web/lib/cosmetics/pack/keys.mjs PRODUCTION_KEYS)', pack);
  check('entitlement key (server/lib/accounts/enttoken.mjs PRODUCTION_ENTITLEMENT_KEYS)', entitlement);
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const problems = pinnedKeyProblems();
  const forRelease = process.argv.includes('--release');
  if (problems.length) {
    const allow = !forRelease && process.env.SOULDEW_UNPINNED_TEST_BUILD === '1';
    console.error(`${allow ? 'WARNING' : 'ERROR'}: souldew+ keys are not pinned – this build gives nobody souldew+:\n  ${problems.join('\n  ')}`);
    console.error('Paste the public halves (souldew-accounts: node tools/keygen.mjs pack / entitlement) into those files first.');
    if (!allow) process.exit(1);
  }
}
