// The signed souldew+ entitlement (server/lib/accounts/enttoken.mjs, accounts API.md §8.2, SECURITY.md §4): only a token
// signed with a pinned key, for this service, this account and this session, counts – and only its claims decide
// souldew+ in the app. Forged, expired, wrong key / sub / sid / aud / iss, clock skew both ways, the offline grace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entitlementSigner } from './fixtures/fakeaccounts.mjs';
import {
  verifyEntitlementToken, entitlementKeys, publicKey, PRODUCTION_ENTITLEMENT_KEYS, SKEW_S, isPackagedBuild,
} from '../server/lib/accounts/enttoken.mjs';

const ISS = 'https://accounts.souldew.app';
const NOW = 1_790_000_000;
const signer = entitlementSigner();
const other = entitlementSigner();
const keys = [publicKey(signer.publicKey)];
const claims = (o = {}) => ({
  iss: ISS, aud: 'souldew-entitlement', sub: 'u_robin', sid: 'ses_robin', tier: 'plus', badges: ['plus'], until: NOW + 30 * 86400,
  grace_until: NOW + 7 * 86400, pack_key_id: '3', iat: NOW, exp: NOW + 3600, ...o,
});
const check = (token, o = {}) => verifyEntitlementToken(token, { keys, iss: ISS, sub: 'u_robin', sid: 'ses_robin', now: NOW + 10, ...o });

test('a valid token: verified claims, badges from the tier', () => {
  const r = check(signer.sign(claims()));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.claims, { tier: 'plus', badges: ['plus'], until: NOW + 30 * 86400, graceUntil: NOW + 7 * 86400, iat: NOW, exp: NOW + 3600, sub: 'u_robin', sid: 'ses_robin', packKeyId: '3' });
  assert.deepEqual(check(signer.sign(claims({ tier: 'patron', badges: ['plus', 'patron'] }))).claims.badges, ['plus', 'patron']);
  // a badge the tier doesn't give is dropped (a supporter can't claim "patron")
  assert.deepEqual(check(signer.sign(claims({ tier: 'supporter', badges: ['supporter', 'patron', 'plus'] }))).claims.badges, ['supporter']);
  assert.equal(check(signer.sign(claims({ until: null }))).claims.until, null);
});

test('forged: changed claims, another key, a bad signature, alg/typ tricks – refused', () => {
  const t = signer.sign(claims({ tier: 'none', badges: [] }));
  const [h, , s] = t.split('.');
  const forgedBody = Buffer.from(JSON.stringify(claims({ tier: 'patron' }))).toString('base64url');
  assert.equal(check(`${h}.${forgedBody}.${s}`).reason, 'signature', 'claims swapped under a valid signature');
  assert.equal(check(other.sign(claims())).reason, 'key', 'signed with a key the app does not pin');
  assert.equal(check(other.sign(claims(), { kid: signer.kid })).reason, 'signature', 'another key posing with the pinned kid');
  assert.equal(check(`${h}.${forgedBody}.${'A'.repeat(86)}`).reason, 'signature');
  assert.equal(check(signer.sign(claims(), { alg: 'none' })).reason, 'header');
  assert.equal(check(signer.sign(claims(), { typ: 'JWT' })).reason, 'header', 'an access token is not an entitlement');
  for (const bad of ['', 'a.b', 'a.b.c.d', `${h}.${forgedBody}.!!`, 'x'.repeat(5000), null, 42]) assert.equal(check(bad).ok, false, String(bad).slice(0, 20));
});

test('wrong sub, sid, aud, iss or tier – refused', () => {
  assert.equal(check(signer.sign(claims({ sub: 'u_kim' }))).reason, 'sub', 'another account’s token');
  assert.equal(check(signer.sign(claims({ sid: 'ses_other' }))).reason, 'sid', 'another session’s token');
  assert.equal(check(signer.sign(claims({ sid: undefined }))).reason, 'sid', 'a token without a session');
  assert.equal(check(signer.sign(claims()), { sid: null }).reason, 'sid', 'no session here');
  assert.equal(check(signer.sign(claims({ aud: 'souldew-app' }))).reason, 'aud', 'an access token’s audience');
  assert.equal(check(signer.sign(claims({ iss: 'http://127.0.0.1:8788' }))).reason, 'iss', 'from another service');
  assert.equal(check(signer.sign(claims({ tier: 'gold' }))).reason, 'tier');
  assert.equal(check(signer.sign(claims({ exp: 'never' }))).reason, 'claims');
});

test('expired and clock skew: 5 minutes each way, offline the grace counts instead of exp', () => {
  const t = signer.sign(claims());
  assert.equal(check(t, { now: NOW + 3600 + SKEW_S - 1 }).ok, true, 'just past exp, within the skew');
  assert.equal(check(t, { now: NOW + 3600 + SKEW_S + 1 }).reason, 'expired');
  assert.equal(check(t, { now: NOW - SKEW_S + 1 }).ok, true, 'a clock a little behind the service');
  assert.equal(check(t, { now: NOW - SKEW_S - 60 }).reason, 'future', 'issued "in the future": a clock far behind');
  // offline: exp (1 hour) doesn't count, grace_until does
  assert.equal(check(t, { now: NOW + 3 * 86400, offline: true }).ok, true, 'day 3 offline');
  assert.equal(check(t, { now: NOW + 7 * 86400 + SKEW_S + 1, offline: true }).reason, 'grace', 'grace over');
  assert.equal(check(t, { now: NOW + 3 * 86400 }).reason, 'expired', 'online the hour counts');
  // after an unlink the service sets grace_until = now: no offline grace at all
  const unlinked = signer.sign(claims({ tier: 'none', badges: [], grace_until: NOW }));
  assert.equal(check(unlinked, { now: NOW + SKEW_S + 1, offline: true }).reason, 'grace');
});

test('the pinned key: the owner’s production key only; a dev key only unpackaged, with a dev flag and a service on this computer', () => {
  assert.deepEqual(PRODUCTION_ENTITLEMENT_KEYS.map((k) => publicKey(k)?.kid), ['k59fr__FUE5V'], 'the owner’s entitlement key is pinned');
  assert.deepEqual(entitlementKeys({ env: {}, packaged: false }).map((k) => k.kid), ['k59fr__FUE5V'], 'production: only that key');
  assert.equal(verifyEntitlementToken(signer.sign(claims()), { keys: entitlementKeys({ env: {} }), iss: ISS, sub: 'u_robin', sid: 'ses_robin', now: NOW }).reason, 'key', 'a throwaway key is not trusted');
  const dev = { SLS_ACCOUNTS_DEV_ENT_KEY: signer.publicKey, SLS_ACCOUNTS_URL: 'http://127.0.0.1:8788' };
  assert.equal(entitlementKeys({ env: dev, packaged: false }).length, 2);
  assert.equal(entitlementKeys({ env: dev, packaged: true }).length, 1, 'never in a packaged build');
  assert.equal(entitlementKeys({ env: { SLS_ACCOUNTS_DEV_ENT_KEY: signer.publicKey }, packaged: false }).length, 1, 'never with the production service');
  assert.equal(entitlementKeys({ env: { ...dev, SLS_ACCOUNTS_URL: 'https://evil.example' }, packaged: false }).length, 1, 'never with a service elsewhere');
  assert.equal(publicKey('AAAA'), null, 'something that isn’t a key never verifies (fail closed)');
  assert.equal(isPackagedBuild('/Applications/souldew.app/Contents/Resources/app/server/lib/accounts/enttoken.mjs'), false, 'not inside this process’ resources');
});
