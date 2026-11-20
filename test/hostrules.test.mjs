// A SoulLink's rules are the host's (2.8.2, shared/hostrules.mjs): the wizard sets every rule, a new attempt keeps
// them, the invite carries them (an older app still joins), the join page shows them, only the host's computer can
// change them – signed, so every other app drops a change that isn't the host's (also a forged one) – and every
// change goes to the log. Runs from before: the creator becomes the host, the rules stay as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { randomBytes } from 'node:crypto';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});

const DATA = mkdtempSync(join(tmpdir(), 'sls-hostrules-'));
process.env.SLS_DATA_DIR = DATA;
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const H = await import('../shared/hostrules.mjs');
const { DEFAULT_RULES, NEW_RUN_RULES, rulesWithDefaults } = await import('../shared/rules.mjs');
const { PACK_FORMAT, packFormatState } = await import('../shared/runpack.mjs');
const { restartRequest } = await import('../shared/restart.mjs');
const { buildRun, runPack, checkPack, readManifest, writeManifest, runDir } = await import('../server/lib/build.mjs');
const { signRules } = await import('../server/lib/hostkey.mjs');
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const WH = await import('../web/lib/hostrules.mjs');
const UI = await import('../web/views/nuzrules.mjs');
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

mkdirSync(join(DATA, 'Library'), { recursive: true });
const ROM = join(DATA, 'Library', 'Fake.gb');
writeFileSync(ROM, Buffer.alloc(0x8000, 7));
const PLAYERS = { p1: { name: 'Lou' }, p2: { name: 'Robin' } };
const build = (o = {}) => buildRun({ romId: ROM, randomize: false, config: {}, players: PLAYERS, ...o });

/** The host's own rules – every rule off its default. */
const MINE = {
  typeClause: 'party', dupes: 'both', missedDupes: true, failKillsPair: false, shinyClause: false, gifts: 'free', levelCaps: false,
  cheats: true, cheatSet: 'balls,money', lives: 3, livesPool: 'player', typeHelp: false, autoAssign: false, autoDeath: false, startAtBalls: false,
  linkTrades: 'off', linkBattles: 'on', linkBattleDeaths: true, linkWagers: 'off', linkWagerCap: 5000, itemGifts: 'off', raids: 'off', raidDeaths: false,
  saveImports: true,
};

function mkDoc(by, runId = 't') {
  const d = new RunDoc(runId);
  d.by = by;
  d._persistSoon = () => {};
  return d;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

// ---- every rule, in the wizard and on the board ------------------------------------------------------------------

/** A component tree with its function components called (none of these use hooks) → the elements, flat. */
function elements(v) {
  if (v == null || typeof v === 'boolean') return [];
  if (Array.isArray(v)) return v.flatMap(elements);
  if (typeof v !== 'object') return [];
  if (typeof v.type === 'function') return elements(v.type(v.props));
  return [v, ...elements(v.props?.children)];
}
const text = (v) => (v == null || typeof v === 'boolean' ? '' : Array.isArray(v) ? v.map(text).join('') : typeof v !== 'object' ? String(v)
  : typeof v.type === 'function' ? text(v.type(v.props)) : text(v.props?.children));
/** Works every control of a rendered rule editor once → the keys of the patches it sent. */
function patchKeys(render) {
  const keys = new Set();
  const onChange = (patch) => Object.keys(patch).forEach((k) => keys.add(k));
  for (const el of elements(render(onChange))) {
    if (el.props?.onClick && el.type === 'button') el.props.onClick();
    if (el.props?.onChange && el.type === 'input') el.props.onChange({ target: { checked: !el.props.checked, value: '5' } });
  }
  return keys;
}
const slEditors = (value, n, disabled) => (onChange) => [
  UI.SoulLinkRules({ value, onChange, players: n, variant: 'wizard', disabled }),
  UI.SoulLinkRules({ value, onChange, players: n, disabled }),
  UI.TypeHelpRule({ value: value.typeHelp, onChange: (v) => onChange({ typeHelp: v }), locked: disabled }),
  UI.LivesRule({ value: value.lives, pool: value.livesPool, players: n, onChange, variant: 'wizard', disabled }),
  UI.SoulLinkAuto({ value, onChange, players: n, disabled }),
  UI.LinkRules({ value, onChange, disabled }), // (3.0: trades and battles between the players – the games that link)
  UI.RaidRules({ value, onChange, disabled }), // (3.0: raids – one shared HP pool against a trainer)
  UI.GiftRule({ value, onChange, disabled }), // (3.0: gifts between the players – every game)
  UI.BallsRule({ value: value.startAtBalls, onChange: (v) => onChange({ startAtBalls: v }), players: n, disabled }),
];

test('every SoulLink rule: the list is the defaults’ (no rule missed), the wizard and the board edit each of them', () => {
  // every rule of the defaults – `sounds` is no rule any more (the app’s setting), `giftsCount` the old name of `gifts`
  assert.deepEqual([...H.SOULLINK_RULE_KEYS].sort(), Object.keys(DEFAULT_RULES).filter((k) => !['sounds', 'giftsCount'].includes(k)).sort());
  assert.ok(!/rules\.sounds|\.sounds\b/.test(src('web/lib/run.mjs')), 'nothing reads rules.sounds');
  // the wizard starts from today's defaults – all of them, a new run's where they differ (older runs keep the defaults)
  assert.deepEqual(H.soulLinkDefaults(), Object.fromEntries(H.SOULLINK_RULE_KEYS.map((k) => [k, k in NEW_RUN_RULES ? NEW_RUN_RULES[k] : DEFAULT_RULES[k]])));
  assert.equal(H.soulLinkDefaults().startAtBalls, true, 'a new SoulLink: nothing counts before the first Poké Balls');
  assert.equal(DEFAULT_RULES.startAtBalls, false, 'a run from before keeps counting from the start');
  assert.deepEqual(Object.keys(H.soulLinkRulesFrom(null)), H.SOULLINK_RULE_KEYS);
  for (const n of [2, 3, 4]) {
    const keys = patchKeys(slEditors({ ...H.soulLinkDefaults(), lives: 3, cheats: true }, n, false));
    assert.deepEqual([...keys].sort(), [...H.SOULLINK_RULE_KEYS].sort(), `${n} players: a control for every rule`);
    // read-only (a player who isn't the host): nothing is sent, every control is disabled
    assert.equal(patchKeys(slEditors({ ...H.soulLinkDefaults(), lives: 3, cheats: true }, n, true)).size, 0);
    const controls = elements(slEditors({ ...H.soulLinkDefaults(), lives: 3, cheats: true }, n, true)(() => {})).filter((el) => ['button', 'input'].includes(el.type));
    assert.ok(controls.length > 15 && controls.every((el) => el.props.disabled), 'every control is disabled');
  }
});

test('the wizard sends every rule the host set (2 and 4 players) – and no longer says they are set on the board', () => {
  const wizard = src('web/views/soullink.mjs');
  assert.match(wizard, /const \[slRules, setSlRules\] = useState\(\(\) => soulLinkRulesFrom\(from && runMode\(from\) === 'soullink' \? from\.rules : null\)\);/);
  assert.match(wizard, /rules: solo \? \{ \.\.\.nzRules, \.\.\.lives, typeHelp, startAtBalls \} : slRules,/);
  for (const part of ['<${SoulLinkRules} variant="wizard" value=${slRules} onChange=${patchSl} players=${count} />',
    '<${TypeHelpRule} value=${slRules.typeHelp} onChange=${(v) => patchSl({ typeHelp: v })} />',
    '<${LivesRule} variant="wizard" value=${slRules.lives} pool=${slRules.livesPool} players=${count} onChange=${patchSl} />',
    '<${SoulLinkAuto} value=${slRules} onChange=${patchSl} players=${count} />',
    '<${BallsRule} value=${slRules.startAtBalls} players=${count} onChange=${(v) => patchSl({ startAtBalls: v })} />']) assert.ok(wizard.includes(part), part);
  assert.ok(!/set together on the board|rulesHintLink|rulesHintGroup/.test(wizard), 'the old hint is gone');
  // what the wizard collects from its controls is what it sends: start from the defaults, change everything
  let sent = H.soulLinkRulesFrom(null);
  const apply = (patch) => (sent = { ...sent, ...patch });
  for (const el of elements(slEditors(sent, 4, false)(apply))) if (el.type === 'button' && el.props.role === 'radio' && !el.props['aria-checked']) el.props.onClick();
  assert.deepEqual(Object.keys(sent).sort(), [...H.SOULLINK_RULE_KEYS].sort());
});

test('a new attempt keeps the old run’s rules – signed anew by whoever starts it, with the new run’s own key', async () => {
  const first = await build({ rules: MINE });
  // (the wizard's "new attempt": the old run's rules, signature dropped)
  assert.deepEqual(H.soulLinkRulesFrom(first.rules), MINE);
  // the one-click new attempt: the old run's doc rules, its host is whoever starts it (here P2)
  const library = { roms: [{ id: ROM, crc: first.base.crc }], patches: [] };
  const body = restartRequest(first, { library, runs: [], rules: first.rules, mySlot: 'p2' });
  assert.equal(body.host, 'p2');
  assert.equal(restartRequest({ ...first, mode: 'nuzlocke', players: { p1: PLAYERS.p1 } }, { library, runs: [] }).host, undefined, 'a solo run has no host');
  const next = await buildRun({ ...body, config: {} });
  assert.equal(next.host, 'p2');
  assert.ok(H.isHostKey(next.hostKey) && next.hostKey !== first.hostKey, 'a key of its own');
  assert.deepEqual(H.unsigned(next.rules), MINE, 'the same rules');
  assert.equal(await H.verifyHostRules(next.id, next.hostKey, next.rules, next.rules.rev), true);
  assert.equal(await H.verifyHostRules(next.id, first.hostKey, next.rules, next.rules.rev), false, 'not with the old run’s key');
});

// ---- the invite --------------------------------------------------------------------------------------------------

test('the invite carries the rules, the host and its key – in the format 2.8.1 reads; the private key stays home', async () => {
  const m = await build({ rules: MINE });
  assert.equal(m.host, 'p1');
  assert.ok(H.isHostKey(m.hostKey));
  const keyFile = join(runDir(m.id), 'host-key.pem');
  assert.ok(existsSync(keyFile));
  if (process.platform !== 'win32') assert.equal(statSync(keyFile).mode & 0o077, 0, 'only this user reads it');
  const pack = runPack(m);
  // no new pack format: a 2.8.1 app (which reads @1–@3, ignores `host`/`hostKey` and the signature's two fields in
  // the rules) still joins – checked by hand against the 2.8.1 server: it imports this pack and reads every rule
  assert.equal(pack.format, PACK_FORMAT);
  assert.equal(packFormatState(pack), 'ok');
  assert.equal(pack.minVersion, undefined);
  assert.deepEqual(rulesWithDefaults(pack.rules, 'soullink'), rulesWithDefaults(MINE, 'soullink'), 'the rules read as they were set (no rev/sig among them)');
  assert.ok(!JSON.stringify(pack).includes('PRIVATE') && !JSON.stringify(m).includes('PRIVATE'), 'no private key in the pack or the manifest');
  assert.equal(await H.verifyHostRules(m.id, pack.hostKey, pack.rules, pack.rules.rev), true);
  // the joining side keeps who the host is and their key
  const checked = checkPack(pack);
  assert.equal(checked.hostKey, m.hostKey);
  assert.equal(checked.host, 'p1');
  // an invite of a 2.8.1 host: no key – the rules work as before
  const { host, hostKey, ...old } = pack; // eslint-disable-line no-unused-vars
  assert.equal(checkPack(old).hostKey, undefined);
  assert.equal(checkPack({ ...pack, hostKey: 'nope' }).hostKey, undefined, 'a broken key is no key');
  assert.equal(checkPack({ ...pack, host: 'p4' }).host, 'p1', 'a host the run doesn’t have');
  // a solo Nuzlocke: no host key, nothing signed (unchanged)
  const solo = await build({ mode: 'nuzlocke', players: { p1: PLAYERS.p1 }, rules: { dupes: 'off' } });
  assert.equal(solo.hostKey, undefined);
  assert.deepEqual(solo.rules, { dupes: 'off' });
  assert.equal(runPack(solo).hostKey, undefined);
});

test('the join page shows the run’s rules before joining', () => {
  const join = src('web/views/soullink.mjs');
  const at = join.indexOf('function JoinRun()');
  assert.ok(join.slice(at).includes("<${RulesSummary} rules=${rulesWithDefaults(pack.rules, 'soullink')} players=${slots.length} />"));
  const shown = text(UI.RulesSummary({ rules: rulesWithDefaults(MINE, 'soullink'), players: 2 }));
  for (const s of ['Type rule', 'Per player', 'Dupes clause', 'For both · fled ones count too', 'Missed encounter costs the pair', 'Shiny clause',
    'Gifts & eggs', 'Free extra', 'Level caps', 'Cheats', 'Poké Balls and Ultra Balls, Money', 'Lives', '3 per player', 'Type matchup help']) assert.ok(shown.includes(s), s);
  // every cheat: "Allowed"; a run from before 3.0: its two
  assert.ok(text(UI.RulesSummary({ rules: rulesWithDefaults({ ...MINE, cheatSet: 'all' }, 'soullink'), players: 2 })).includes('Allowed'));
  assert.ok(text(UI.RulesSummary({ rules: rulesWithDefaults({ ...MINE, cheatSet: undefined }, 'soullink'), players: 2 })).includes('Rare Candies, Max Repels'));
  const plain = text(UI.RulesSummary({ rules: rulesWithDefaults({}, 'soullink'), players: 4 }));
  for (const s of ['Across all teams', 'Missed encounter costs the group', 'Count as the area']) assert.ok(plain.includes(s), s);
});

// ---- only the host's changes count ---------------------------------------------------------------------------------

test('a change that isn’t the host’s is dropped by every app – a partner’s, a 2.8.1 app’s and forged ones', async () => {
  const m = await build({ rules: MINE });
  const host = mkDoc('hostdev', m.id);
  const partner = mkDoc('partnerdev', m.id);
  for (const d of [host, partner]) {
    WH.initRules(d, m);
    d.hostKey = m.hostKey;
    d.guard = WH.hostGuard(d, m.id);
  }
  assert.equal(host.entries.rules.t, m.rules.rev, 'written at the host’s timestamp');
  assert.deepEqual(R.rules(partner, m), rulesWithDefaults(MINE, 'soullink'));
  // only the creator's computer may change them at all (the board is read-only elsewhere)
  assert.deepEqual(R.allowedRulesPatch({ dupes: 'off' }, m), { dupes: 'off' });
  assert.equal(R.allowedRulesPatch({ dupes: 'off' }, { ...m, imported: true }), null);

  // the host changes them: signed for a newer timestamp, every partner takes it
  const signed = signRules(structuredClone(m), { ...MINE, dupes: 'off' }, { after: host.clock });
  host.setAt('rules', signed, signed.rev);
  partner.merge(host.entries);
  await settle();
  assert.equal(R.rules(partner, m).dupes, 'off');

  const dropped = async (entry) => {
    const before = JSON.stringify(host.entries.rules);
    host.merge({ rules: entry });
    await settle();
    assert.equal(JSON.stringify(host.entries.rules), before);
  };
  const t = host.clock + 1000;
  // a partner (or a 2.8.1 app, which writes the rules like before) changes them: no signature
  await dropped({ v: { ...MINE, dupes: 'player' }, t, by: 'partnerdev' });
  // forged: the host's device id, a made-up signature
  await dropped({ v: { ...MINE, rev: t, sig: randomBytes(64).toString('base64url') }, t, by: 'hostdev' });
  // the host's signed value with one rule changed
  await dropped({ v: { ...signed, cheats: false }, t: signed.rev + 1, by: 'hostdev' });
  await dropped({ v: { ...signed, cheats: false, rev: signed.rev + 5 }, t: signed.rev + 5, by: 'hostdev' });
  // an older signed value replayed under a newer timestamp (back to the rules before the change)
  await dropped({ v: m.rules, t, by: 'hostdev' });
  await dropped({ v: { ...m.rules, rev: t }, t, by: 'hostdev' });
  // the signature of another run, or of another key
  const other = await build({ rules: { ...MINE, dupes: 'player' } });
  await dropped({ v: other.rules, t: other.rules.rev + 0, by: 'hostdev' });
  const stranger = signRules({ ...structuredClone(m), hostKey: undefined, host: undefined, id: other.id }, { ...MINE, dupes: 'player' }, { after: t });
  await dropped({ v: stranger, t: stranger.rev, by: 'hostdev' });
  // deleting them
  await dropped({ v: null, t, by: 'partnerdev' });
  assert.equal(R.rules(host, m).dupes, 'off');
  // another key announced for the run: dropped; the host's own: taken
  host.merge({ [H.HOST_DOC_KEY]: { v: { slot: 'p2', key: other.hostKey }, t, by: 'partnerdev' } });
  assert.equal(host.get(H.HOST_DOC_KEY), undefined);
  host.merge({ [H.HOST_DOC_KEY]: { v: { slot: 'p1', key: m.hostKey }, t, by: 'hostdev' } });
  assert.equal(host.get(H.HOST_DOC_KEY).key, m.hostKey);
  // the other keys of the doc sync as before
  host.merge({ 'enc:r29:p2': { v: { outcome: 'caught', species: 1 }, t, by: 'partnerdev' } });
  assert.equal(host.get('enc:r29:p2').species, 1);
});

test('clocks a day or more apart: the host’s changes still reach everyone, and a partner’s far-future clock can’t make them lose', async () => {
  const DAY = 86400000;
  const m = await build({ rules: MINE });
  const docs = (n) => Array.from({ length: n }, (_, i) => {
    const d = mkDoc(['hostdev', 'partnerdev', 'thirddev'][i], m.id);
    WH.initRules(d, m);
    d.hostKey = m.hostKey;
    d.guard = WH.hostGuard(d, m.id);
    return d;
  });
  // a third player's clock runs two days ahead: their ordinary entries pull the host's doc clock a day ahead …
  const [host, partner] = docs(2);
  host.merge({ 'hp:p3': { v: 1, t: Date.now() + 2 * DAY, by: 'thirddev' } });
  assert.ok(host.clock > Date.now() + DAY - 60000, 'the doc clock follows (clamped to a day)');
  // … the host's next change is signed for that clock – the partner, whose clock is right, still takes it
  const s1 = signRules(structuredClone(m), { ...MINE, dupes: 'off' }, { after: host.clock });
  assert.ok(s1.rev > Date.now() + DAY - 60000);
  host.setAt('rules', s1, s1.rev);
  partner.merge(host.entries);
  await settle();
  assert.equal(R.rules(partner, m).dupes, 'off');
  assert.equal(partner.entries.rules.t, s1.rev, 'kept at the signed timestamp');
  assert.ok(partner.clock <= Date.now() + DAY, 'the partner’s own clock is not dragged past a day');

  // the host's clock runs two days ahead
  const [host2, partner2] = docs(2);
  const s2 = signRules(structuredClone(m), { ...MINE, cheats: false }, { after: host2.clock, now: Date.now() + 2 * DAY });
  host2.setAt('rules', s2, s2.rev);
  partner2.merge(host2.entries);
  await settle();
  assert.equal(R.rules(partner2, m).cheats, false);
  // the host's clock is put right: its next change is still newer than the one signed two days ahead
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => {
    const { rules, after } = JSON.parse(o.body);
    const v = signRules(structuredClone(m), rules, { after });
    return Promise.resolve(new Response(JSON.stringify({ rules: v, host: 'p1', hostKey: m.hostKey }), { headers: { 'content-type': 'application/json' } }));
  };
  try {
    await WH.writeHostRules(host2, m, { ...MINE, cheats: false, dupes: 'player' }, 'p1');
  } finally {
    globalThis.fetch = realFetch;
  }
  partner2.merge(host2.entries);
  await settle();
  assert.equal(R.rules(partner2, m).dupes, 'player');

  // a far-future entry that isn't the host's: dropped, and the host's clock stays where it was
  const before = host.clock;
  const t = Date.now() + 30 * DAY;
  host.merge({ rules: { v: { ...MINE, dupes: 'player' }, t, by: 'thirddev' } });
  host.merge({ rules: { v: { ...MINE, rev: t, sig: randomBytes(64).toString('base64url') }, t, by: 'hostdev' } });
  await settle();
  assert.equal(host.clock, before);
  assert.equal(R.rules(host, m).dupes, 'off');
  const s3 = signRules(structuredClone(m), { ...MINE, dupes: 'both' }, { after: host.clock });
  host.setAt('rules', s3, s3.rev);
  partner.merge(host.entries);
  await settle();
  assert.equal(R.rules(partner, m).dupes, 'both', 'the host’s next change still wins');

  // stored and loaded again (the server’s copy, the browser’s copy): the signed timestamp stays as it is
  const { mergeDocEntries } = await import('../server/lib/build.mjs');
  const far = { rules: { v: s2, t: s2.rev, by: 'hostdev' }, x: { v: 1, t: Date.now() + 5 * DAY, by: 'thirddev' } };
  const stored = mergeDocEntries({}, far);
  assert.equal(stored.rules.t, s2.rev);
  assert.ok(stored.x.t <= Date.now() + DAY, 'other entries are still clamped');
  const reloaded = mkDoc('partnerdev', m.id);
  reloaded.merge(stored, null, { own: true });
  assert.equal(reloaded.entries.rules.t, s2.rev);
  // (from the link, without the guard having checked it, a far-future timestamp is clamped as before)
  const unguarded = mkDoc('partnerdev', m.id);
  unguarded.merge(far);
  assert.ok(unguarded.entries.rules.t <= Date.now() + DAY);
});

test('a signed host entry beats any unsigned rules entry, whatever the timestamps (the same millisecond, a clock ahead)', async () => {
  const m = await build({ rules: MINE });
  const signed = signRules(structuredClone(m), { ...MINE, dupes: 'player' }, { after: m.rules.rev });
  for (const ahead of [0, 1, 60000]) {
    // the partner's computer holds an unsigned entry (its own edit, or one from before it knew the key) for the very
    // millisecond the host signs for – or later – and from a device id that wins the tie
    const partner = mkDoc('zzzz-partner', m.id);
    partner.merge({ rules: { v: { ...MINE, dupes: 'both' }, t: signed.rev + ahead, by: 'zzzz-partner' } }, null, { own: true });
    partner.hostKey = m.hostKey;
    partner.guard = WH.hostGuard(partner, m.id);
    partner.outranks = WH.hostOutranks(partner);
    partner.merge({ rules: { v: signed, t: signed.rev, by: 'aaaa-host' } });
    await settle();
    assert.equal(R.rules(partner, m).dupes, 'player', `the host's signed rules (unsigned entry ${ahead} ms ahead)`);
    assert.ok(H.signedFor(partner.entries.rules.v, partner.entries.rules.t));
    // and an unsigned entry can't push them out again – not from the link, not written on this computer
    partner.merge({ rules: { v: { ...MINE, dupes: 'both' }, t: signed.rev + 120000, by: 'zzzz-partner' } });
    partner.set('rules', { ...MINE, dupes: 'both' });
    await settle();
    assert.equal(R.rules(partner, m).dupes, 'player');
  }
  // a forged signature still doesn't get in that way
  const partner = mkDoc('zzzz-partner', m.id);
  partner.merge({ rules: { v: { ...MINE, dupes: 'both' }, t: signed.rev, by: 'zzzz-partner' } }, null, { own: true });
  partner.hostKey = m.hostKey;
  partner.guard = WH.hostGuard(partner, m.id);
  partner.outranks = WH.hostOutranks(partner);
  partner.merge({ rules: { v: { ...signed, sig: randomBytes(64).toString('base64url') }, t: signed.rev, by: 'aaaa-host' } });
  await settle();
  assert.equal(R.rules(partner, m).dupes, 'both');
  // without the host's key (a solo run, a run whose host is still on 2.8.1): the newest entry, as before
  const solo = mkDoc('zzzz-partner', m.id);
  solo.outranks = WH.hostOutranks(solo);
  solo.merge({ rules: { v: { ...MINE, dupes: 'both' }, t: signed.rev + 5, by: 'zzzz-partner' } });
  solo.merge({ rules: { v: signed, t: signed.rev, by: 'aaaa-host' } });
  assert.equal(solo.get('rules').dupes, 'both');
});

test('the server signs only on the host’s computer; a joined run learns a key once, never another', async () => {
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  const call = (method, path, body) => fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const m = await build({ rules: MINE });
    const res = await call('POST', `/api/runs/${m.id}/rules`, { rules: { ...MINE, dupes: 'off', rev: 1, sig: 'x', discordWebhook: 'https://discord.com/api/webhooks/1/a' }, after: 5e12 });
    assert.equal(res.status, 200);
    assert.equal(res.body.rules.rev, 5e12 + 1, 'newer than anything in the doc');
    assert.equal(res.body.rules.dupes, 'off');
    assert.equal('discordWebhook' in res.body.rules, false);
    assert.equal(await H.verifyHostRules(m.id, m.hostKey, res.body.rules, res.body.rules.rev), true);
    assert.deepEqual(readManifest(m.id).rules, res.body.rules, 'the manifest keeps the signed rules');
    // the board's old way (POST …/meta with rules) doesn't overwrite the host's signed rules
    await call('POST', `/api/runs/${m.id}/meta`, { rules: { dupes: 'player' } });
    assert.equal(readManifest(m.id).rules.dupes, 'off');

    // a joined run (imported): no signing at all
    const joined = { ...structuredClone(m), id: 'feed0001', imported: true, hostKey: undefined, host: undefined };
    writeManifest(joined);
    const refused = await call('POST', '/api/runs/feed0001/rules', { rules: MINE });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'notHost');
    // its host's key, announced in the doc (a run from before 2.8.2): taken once …
    await call('POST', '/api/runs/feed0001/meta', { hostKey: m.hostKey, host: 'p2' });
    assert.equal(readManifest('feed0001').hostKey, m.hostKey);
    assert.equal(readManifest('feed0001').host, 'p2');
    // … never replaced
    const other = await build();
    await call('POST', '/api/runs/feed0001/meta', { hostKey: other.hostKey, host: 'p1' });
    assert.equal(readManifest('feed0001').hostKey, m.hostKey);
    // the host's own run never takes a key from outside
    await call('POST', `/api/runs/${m.id}/meta`, { hostKey: other.hostKey });
    assert.equal(readManifest(m.id).hostKey, m.hostKey);
  } finally {
    server.close();
  }
});

test('a run from before 2.8.2: the partner learns the host key only from an announcement that can be the host’s', async () => {
  const realFetch = globalThis.fetch;
  const metaCalls = [];
  globalThis.fetch = (u, o) => {
    metaCalls.push([u, JSON.parse(o.body)]);
    return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
  };
  try {
    const built = await build();
    const legacy = { ...structuredClone(built), imported: true, rules: { lives: 0 } };
    delete legacy.hostKey;
    delete legacy.host;
    const key = built.hostKey;
    const other = (await build()).hostKey;
    const t = Date.now();
    const setup = () => {
      const d = mkDoc('me-dev', legacy.id);
      WH.setupHostRules(d, legacy, { me: 'p2' });
      return d;
    };
    // another player announcing themselves as the host (their own slot), or for this computer's player: ignored
    let d = setup();
    d.merge({ [H.HOST_DOC_KEY]: { v: { slot: 'p2', key: other }, t, by: 'partner-dev' } });
    assert.equal(d.hostKey, null, 'not the run’s host player (p1, the creator)');
    // from this very device (a copy of an old doc): ignored
    d = setup();
    d.merge({ [H.HOST_DOC_KEY]: { v: { slot: 'p1', key: other }, t, by: 'me-dev' } });
    assert.equal(d.hostKey, null);
    // a device that isn't the one playing the host's player: ignored – the one that is: taken
    d = setup();
    d.merge({ 'live:p1': { v: { party: [] }, t, by: 'host-dev' } });
    d.merge({ [H.HOST_DOC_KEY]: { v: { slot: 'p1', key: other }, t, by: 'p3-dev' } });
    assert.equal(d.hostKey, null, 'p1 is played on another device');
    d.merge({ [H.HOST_DOC_KEY]: { v: { slot: 'p1', key }, t: t + 1, by: 'host-dev' } });
    assert.equal(d.hostKey, key);
    // learned once: never another
    d.merge({ [H.HOST_DOC_KEY]: { v: { slot: 'p1', key: other }, t: t + 2, by: 'host-dev' } });
    assert.equal(d.hostKey, key);
    assert.deepEqual(metaCalls.map(([, b]) => b), [{ hostKey: key, host: 'p1' }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- the log -------------------------------------------------------------------------------------------------------

test('every change of the host goes to the log, in clear words', () => {
  const PAIR = { id: 'x', game: { code: 'IPKE', system: 'nds' }, players: PLAYERS };
  const d = mkDoc('a');
  const before = rulesWithDefaults({}, 'soullink');
  R.logRulesChange(d, PAIR, 'p1', before, rulesWithDefaults(MINE, 'soullink'));
  assert.deepEqual(R.feedList(d).map((f) => `${f.type} ${f.slot} ${f.text}`).sort(), [
    'cheat p1 allowed cheats for this run',
    'cheat p1 set the cheats allowed for this run: Poké Balls and Ultra Balls, Money',
    'rule p1 set the lives to 3 per player',
    'rule p1 set “Dupes clause” to For both for everyone',
    'rule p1 set “Gifts & eggs” to Free extra for everyone',
    'rule p1 set “Type rule” to Per player for everyone',
    'rule p1 turned off “A linked Pokémon that faints (live) kills the pair automatically” for everyone',
    'rule p1 turned off “A missed encounter costs the whole pair” for everyone',
    'rule p1 turned off “Check level caps” for everyone',
    'rule p1 turned off “Enter new catches automatically” for everyone',
    'rule p1 turned off “Gifts between us” for everyone',
    'rule p1 turned off “Shiny clause: shinies may always be caught and stay unlinked” for everyone',
    'rule p1 turned off “Trades between us (link)” for everyone',
    'rule p1 turned on “Allow importing a save file” for everyone',
    'rule p1 turned on “Fled or knocked-out encounters count as dupes” for everyone',
    'rule p1 turned on “Losing a link battle counts as deaths” for everyone',
    'rule p1 turned the type matchup help off for everyone',
  ].sort());
  // no change, no line; a group of 4 has its own words
  const quiet = mkDoc('a');
  R.logRulesChange(quiet, PAIR, 'p1', before, { ...before });
  assert.equal(R.feedList(quiet).length, 0);
  const group = mkDoc('a');
  R.logRulesChange(group, { ...PAIR, players: { ...PLAYERS, p3: { name: 'Kim' }, p4: { name: 'Alex' } } }, 'p1', before, { ...before, typeClause: 'party', failKillsPair: false });
  assert.deepEqual(R.feedList(group).map((f) => f.text).sort(), ['set “Type rule” to Per player for everyone', 'turned off “A missed encounter costs the whole group” for everyone']);
  // the board logs through it, after the host's signed write
  const board = src('web/views/board.mjs');
  assert.match(board, /await writeHostRules\(doc, manifest, next, me\);/);
  assert.match(board, /logRulesChange\(doc, manifest, me, r, getRules\(doc, manifest\)\);/);
  // a solo run logs as before – cheats, type matchup help, lives only
  const solo = mkDoc('a');
  const SOLO = { ...PAIR, mode: 'nuzlocke', players: { p1: PLAYERS.p1 } };
  R.logRulesChange(solo, SOLO, 'p1', rulesWithDefaults({}, 'nuzlocke'), { ...rulesWithDefaults({}, 'nuzlocke'), dupes: 'off', cheats: true });
  assert.deepEqual(R.feedList(solo).map((f) => f.text), ['Cheats allowed for this run']);
});

test('the board: the host changes the rules, everyone else sees them read-only with the host’s name', () => {
  const board = src('web/views/board.mjs');
  assert.match(board, /const mine = canEditRules\(manifest\);/);
  assert.match(board, /<\$\{HostRulesNote\} host=\$\{hostName\} mine=\$\{mine\} players=\$\{n\} \/>/);
  for (const part of ['<${SoulLinkRules} value=${r} onChange=${set} players=${n} disabled=${locked} />', 'disabled=${locked}\n',
    '<${SoulLinkAuto} value=${r} onChange=${set} players=${n} solo=${solo} disabled=${locked} />']) assert.ok(board.includes(part), part);
  // the play view's rules drawer is the same tab (a Play together's: its choices – views/playtogether.mjs)
  assert.match(src('web/views/play.mjs'), /RulesTab=\$\{isRun && isTogether\(manifest\) \? ChoicesTab : RulesTab\}/);
  assert.match(text(UI.HostRulesNote({ host: 'Lou', mine: false })), /Set by the host · Lou created this run and sets the rules for everyone – only Lou can change them/);
  assert.match(text(UI.HostRulesNote({ host: 'Lou', mine: true })), /You’re the host/);
});

// ---- runs from before 2.8.2 -----------------------------------------------------------------------------------------

test('a run from before 2.8.2: its creator becomes the host, the rules stay as they are – from then on only theirs count', async () => {
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  const realFetch = globalThis.fetch;
  const metaCalls = [];
  let partnerSide = false;
  // web/lib/api.mjs asks the local server: the host's computer this test server, the partner's a stand-in
  globalThis.fetch = (u, o) => {
    if (!partnerSide) return realFetch(`${url}${u}`, o);
    metaCalls.push([u, JSON.parse(o.body)]);
    return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
  };
  try {
    // made by 2.8.1: no key, no host; the rules a partner changed back then (an unsigned doc entry)
    const built = await build();
    const legacy = { ...structuredClone(built), rules: { typeHelp: false, lives: 0, livesPool: 'shared' } };
    delete legacy.hostKey;
    delete legacy.host;
    rmSync(join(runDir(built.id), 'host-key.pem'));
    writeManifest(legacy);
    const docRules = { typeHelp: false, lives: 0, livesPool: 'shared', dupes: 'off', typeClause: 'party' };
    const host = mkDoc('hostdev', built.id);
    host.merge({ rules: { v: docRules, t: 1000, by: 'partnerdev' }, 'enc:r29:p1': { v: { outcome: 'caught' }, t: 900, by: 'hostdev' } });
    const partner = mkDoc('partnerdev', built.id);
    partner.merge(host.entries);

    WH.initRules(host, legacy);
    let reloaded = 0;
    WH.setupHostRules(host, legacy, { me: 'p1', reload: () => reloaded++ });
    for (let i = 0; i < 100 && !H.signedFor(host.entries.rules.v, host.entries.rules.t); i++) await settle();
    // the creator is the host now: a key, the same rules – signed
    const m = readManifest(built.id);
    assert.ok(H.isHostKey(m.hostKey));
    assert.equal(m.host, 'p1');
    assert.equal(reloaded, 1);
    assert.deepEqual(H.unsigned(host.get('rules')), docRules, 'the rules stay as they are');
    assert.ok(host.entries.rules.t > 1000, 'newer than the old entry, so it wins everywhere');
    assert.equal(await H.verifyHostRules(built.id, m.hostKey, host.get('rules'), host.entries.rules.t), true);
    assert.deepEqual(host.get(H.HOST_DOC_KEY), { slot: 'p1', key: m.hostKey });

    // the partner (2.8.2, joined back then: no key yet) learns it from the doc, once
    partnerSide = true;
    const imported = { ...structuredClone(legacy), imported: true };
    WH.initRules(partner, imported);
    WH.setupHostRules(partner, imported, { me: 'p2' });
    assert.equal(partner.hostKey, null);
    partner.merge(host.entries);
    await settle();
    assert.equal(partner.hostKey, m.hostKey);
    assert.deepEqual(metaCalls, [[`/api/runs/${built.id}/meta`, { hostKey: m.hostKey, host: 'p1' }]], 'stored in the partner’s run');
    assert.deepEqual(H.unsigned(partner.get('rules')), docRules);
    // from now on a change of the partner's doesn't count on the host's side – nor a key the partner announces
    partner.set('rules', { ...docRules, dupes: 'both' });
    partner.set(H.HOST_DOC_KEY, { slot: 'p2', key: (await build()).hostKey });
    host.merge(partner.entries);
    await settle();
    assert.equal(R.rules(host, legacy).dupes, 'off');
    assert.equal(host.get(H.HOST_DOC_KEY).key, m.hostKey);
    // the host's next change reaches the partner (whose own unsigned edit loses to it)
    partnerSide = false;
    await WH.writeHostRules(host, m, { ...docRules, dupes: 'player' }, 'p1');
    partner.merge(host.entries);
    await settle();
    assert.equal(R.rules(partner, imported).dupes, 'player');

    // a solo Nuzlocke from before: nothing changes
    const solo = { ...structuredClone(legacy), mode: 'nuzlocke', players: { p1: PLAYERS.p1 }, rules: { dupes: 'off' } };
    const sd = mkDoc('x', 'aaaa9999');
    WH.initRules(sd, solo);
    WH.setupHostRules(sd, solo, { me: 'p1' });
    assert.equal(sd.guard, null);
    assert.equal(sd.hostKey, null);
    assert.deepEqual(sd.get('rules'), { dupes: 'off' });
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
