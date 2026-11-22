#!/usr/bin/env node
// The release build for macOS: souldew.app signed with the Developer ID (hardened runtime, every program and library in
// it signed – the bundled Java, the fast player, the link host, the 3DS player and their cores), notarized by Apple and
// stapled, in a DMG that is signed, notarized and stapled as well. Gatekeeper then opens it like any other app – no
// "Open Anyway" – and the keychain item of a signed-in player keeps working across updates (the signature stays the
// same). `npm run dist` stays the ad-hoc build for development.
//
//   npm run dist:mac-signed                       → dist/souldew-<version>-arm64.dmg (what `npm run release` picks up)
//   npm run dist:mac-signed -- --out <dir>        another output folder (a dry run)
//   npm run dist:mac-signed -- --no-notarize      signed only (quicker, for a local check – never for a release)
//   node scripts/dist-mac-signed.mjs --verify <souldew.app> [--dmg <file>] [--roms <dir>]   only the checks (see below)
//
// Needs (nothing of it in the repository):
//   ~/.souldew-keys/developer-id.p12       the Developer ID Application certificate with its key and Apple's G2
//                                           intermediate (SLS_DEVID_P12 for another place)
//   ~/.souldew-keys/developer-id.p12.pass  its password (SLS_DEVID_PASS_FILE)
//   a notarytool keychain profile "souldew" (xcrun notarytool store-credentials souldew --apple-id … --team-id
//   VWQM7SSK3D; SLS_NOTARY_PROFILE for another name) – the app-specific password stays in the login keychain
//   Xcode's command line tools (codesign, notarytool, stapler), the parts `npm run dist` checks (JRE, 3DS, fast player)
//
// The certificate goes into a keychain of its own for this build only (a random password, its key open to codesign
// without asking, deleted at the end), so no keychain dialog ever comes up and the login keychain isn't touched.
// codesign finds an identity only in a keychain on the search list: the build keychain is put in front of it for the
// build and the list is put back as it was afterwards (also on Ctrl+C). The
// password file is read here and handed to `security import` only. The certificate's name (the account holder's legal
// name) never reaches the output: it is replaced with "<Developer ID>" in everything printed.
//
// The checks after the build (also on their own: --verify): codesign --verify --deep --strict, spctl (Gatekeeper),
// stapler validate, every Mach-O file signed with the hardened runtime and the Team ID, the entitlements of the
// programs souldew starts, `java -version` from inside the bundle – and the app started hidden with a scratch profile:
// its server answers, the randomizer's Java check passes, and with --roms a GBA and a DS game boot in the fast player.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
const has = (name) => args.includes(`--${name}`);

export const TEAM_ID = process.env.SLS_TEAM_ID || 'VWQM7SSK3D';
const P12 = resolve(process.env.SLS_DEVID_P12 || join(homedir(), '.souldew-keys', 'developer-id.p12'));
const PASS_FILE = resolve(process.env.SLS_DEVID_PASS_FILE || join(homedir(), '.souldew-keys', 'developer-id.p12.pass'));
const PROFILE = process.env.SLS_NOTARY_PROFILE || 'souldew';
/** The programs souldew starts itself – each needs the JIT entitlements of build/entitlements.mac.inherit.plist. */
export const CHILD_PROGRAMS = ['tools/jre/darwin-arm64/bin/java', 'tools/native/darwin-arm64/retrohost', 'tools/native/darwin-arm64/linkhost', 'tools/ctr/darwin-arm64/ctrhost'];
export const JIT_ENTITLEMENTS = ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation'];

// ---- output without the certificate's name -----------------------------------------------------------------------
let secretName = null; // "Developer ID Application: <name> (<team>)" once known – only ever used to redact it
/** `text` with the certificate's name (and the bare personal name in it) replaced. */
export function redact(text, name = secretName) {
  let out = String(text);
  if (!name) return out;
  const person = name.replace(/^Developer ID Application:\s*/, '').replace(/\s*\([A-Z0-9]{10}\)\s*$/, '');
  for (const s of [name, person].filter((x) => x && x.length >= 3)) out = out.split(s).join(s === name ? '<Developer ID>' : '<name>');
  return out;
}
const say = (...a) => console.log(redact(a.join(' ')));

/** Runs a command; its output is redacted before it is shown. `secret`: arguments not to show (replaced with ***). */
function run(cmd, a, { quiet = false, allowFail = false, secret = [], env, cwd, timeout } = {}) {
  if (!quiet) say(`$ ${cmd} ${a.map((x) => (secret.includes(x) ? '***' : x)).join(' ')}`);
  const r = spawnSync(cmd, a, { encoding: 'utf8', env: env || process.env, cwd: cwd || root, maxBuffer: 64 * 1024 * 1024, timeout });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && !allowFail) {
    console.error(redact(out).trim().split('\n').slice(-30).join('\n'));
    throw new Error(`${basename(cmd)} failed (${r.status ?? r.signal ?? r.error?.code})`);
  }
  return { ok: r.status === 0, out, status: r.status };
}

/** A command whose output streams through (redacted, line by line) – electron-builder, notarytool. */
function stream(cmd, a, { env } = {}) {
  say(`$ ${cmd} ${a.join(' ')}`);
  return new Promise((res, rej) => {
    const p = spawn(cmd, a, { cwd: root, env: env || process.env });
    const pipe = (from, to) => {
      let rest = '';
      from.on('data', (d) => {
        const lines = (rest + d).split('\n');
        rest = lines.pop();
        for (const l of lines) to.write(`${redact(l)}\n`);
      });
      from.on('end', () => rest && to.write(`${redact(rest)}\n`));
    };
    pipe(p.stdout, process.stdout);
    pipe(p.stderr, process.stderr);
    p.on('error', rej);
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${basename(cmd)} failed (${code})`))));
  });
}

// ---- the build keychain --------------------------------------------------------------------------------------------
/** A keychain with the Developer ID only, for this build → { keychain, hash, remove() }. */
function buildKeychain() {
  if (!existsSync(P12) || !existsSync(PASS_FILE)) throw new Error(`The Developer ID certificate isn't there (${P12} and its .pass file) – see the top of this script.`);
  const dir = mkdtempSync(join(tmpdir(), 'souldew-sign-'));
  const keychain = join(dir, 'build.keychain-db');
  const pw = randomBytes(24).toString('hex');
  // the user's keychain search list as it is – put back at the end
  const listed = run('/usr/bin/security', ['list-keychains', '-d', 'user'], { quiet: true }).out.split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...listed], { quiet: true, allowFail: true });
    run('/usr/bin/security', ['delete-keychain', keychain], { quiet: true, allowFail: true });
    rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = () => {
    remove();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    run('/usr/bin/security', ['create-keychain', '-p', pw, keychain], { secret: [pw] });
    run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]);
    run('/usr/bin/security', ['unlock-keychain', '-p', pw, keychain], { secret: [pw] });
    const pass = readFileSync(PASS_FILE, 'utf8').replace(/\r?\n$/, '');
    // -T: codesign may use the key without asking; the partition list below says the same for the newer access rules
    run('/usr/bin/security', ['import', P12, '-k', keychain, '-f', 'pkcs12', '-P', pass, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'], { secret: [pass] });
    run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', pw, keychain], { secret: [pw], quiet: false });
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain, ...listed]);
    const ids = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain], { quiet: true }).out;
    const line = ids.split('\n').find((l) => /Developer ID Application/.test(l) && l.includes(`(${TEAM_ID})`));
    const m = line && line.match(/\b([0-9A-F]{40})\b\s+"([^"]+)"/);
    if (!m) throw new Error(`No valid "Developer ID Application" certificate of team ${TEAM_ID} in ${P12}`);
    secretName = m[2];
    say(`signing identity: ${m[1].slice(0, 8)}… (<Developer ID>, team ${TEAM_ID})`);
    return { keychain, hash: m[1], remove };
  } catch (e) {
    remove();
    throw e;
  }
}

// ---- the build -----------------------------------------------------------------------------------------------------
/** package.json's build config with signing for the release: the identity, the hardened runtime, the entitlements. */
export function signedConfig(base, { identity, out, notarize }) {
  const cfg = JSON.parse(JSON.stringify(base));
  cfg.directories = { ...(cfg.directories || {}), output: out };
  cfg.mac = {
    ...cfg.mac,
    identity,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    notarize: !!notarize, // electron-builder: the .app, before it goes into the DMG (APPLE_KEYCHAIN_PROFILE)
    target: [{ target: 'dmg', arch: ['arm64'] }],
  };
  cfg.dmg = { ...(cfg.dmg || {}), sign: true };
  return cfg;
}

async function build() {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = resolve(opt('out', join(root, 'dist')));
  const notarize = !has('no-notarize');
  // electron-builder collects the app's dependencies by walking node_modules – through a linked one (a worktree sharing
  // another's) it finds only the top level and the app ships without socket.io's own dependencies
  if (lstatSync(join(root, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('node_modules is a link – run `npm ci` in this checkout first (the app\'s dependencies are collected from it)');
  // the same gates as `npm run dist`: the real pinned keys, the JRE, the 3DS and fast player parts (no build paths)
  run(process.execPath, ['scripts/check-pinned-keys.mjs']);
  run(process.execPath, ['scripts/fetch-jre.mjs', 'arm64']);
  run(process.execPath, ['scripts/build-ctr.mjs', '--check']);
  run(process.execPath, ['scripts/build-native.mjs', '--check']);
  if (notarize) {
    const h = run('/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE], { quiet: true, allowFail: true });
    if (!h.ok) throw new Error(`The notarytool keychain profile "${PROFILE}" doesn't work: ${redact(h.out).trim().split('\n').pop()}`);
  }
  const kc = buildKeychain();
  const cfgFile = join(dirname(kc.keychain), 'electron-builder.json');
  try {
    writeFileSync(cfgFile, JSON.stringify(signedConfig(pkg.build, { identity: kc.hash, out, notarize }), null, 2));
    const env = {
      ...process.env,
      CSC_KEYCHAIN: kc.keychain, // (the identity is looked up there only)
      CUSTOM_DMGBUILD_PATH: 'scripts/dmgbuild-wrapper.mjs',
      ...(notarize ? { APPLE_KEYCHAIN_PROFILE: PROFILE } : {}),
    };
    delete env.CSC_LINK; // (never a certificate from somewhere else)
    delete env.CSC_NAME;
    const builder = join(root, 'node_modules', '.bin', 'electron-builder');
    await stream(builder, ['--mac', 'dmg', '--arm64', '--config', cfgFile, '--publish', 'never'], { env });
  } finally {
    kc.remove();
  }
  const dmg = join(out, `souldew-${pkg.version}-arm64.dmg`);
  const app = join(out, 'mac-arm64', 'souldew.app');
  if (!existsSync(dmg) || !existsSync(app)) throw new Error(`The build left no ${dmg} / ${app}`);
  if (notarize) {
    // the DMG itself (the app inside was notarized and stapled before it went in)
    await stream('/usr/bin/xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', PROFILE, '--wait']);
    run('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
  }
  await verify(app, { dmg, notarized: notarize, roms: opt('roms') });
  say(`\n✓ ${dmg}\n  signed (Developer ID, team ${TEAM_ID})${notarize ? ', notarized and stapled' : ' – NOT notarized (--no-notarize)'}`);
}

// ---- the checks ----------------------------------------------------------------------------------------------------
const isMachO = (file) => {
  try {
    const fd = openSync(file, 'r');
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, 0);
    closeSync(fd);
    const m = b.readUInt32BE(0);
    return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xfeedface, 0xcefaedfe].includes(m);
  } catch {
    return false;
  }
};
function machOFiles(dir, list = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p, { throwIfNoEntry: false });
    if (!s || s.isSymbolicLink()) continue; // (a framework's Versions/Current: the same files once)
    if (s.isDirectory()) machOFiles(p, list);
    else if (s.isFile() && s.size > 4 && isMachO(p)) list.push(p);
  }
  return list;
}

/** Everything that must hold for a release build (throws on the first problem). */
export async function verify(app, { dmg = null, notarized = true, roms = null } = {}) {
  say('\n— checks —');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  // every Mach-O file: signed by the team, hardened runtime, a secure timestamp
  const files = machOFiles(join(app, 'Contents'));
  let n = 0;
  for (const f of files) {
    const d = run('/usr/bin/codesign', ['-dvvv', f], { quiet: true, allowFail: true }).out;
    const rel = f.slice(app.length + 1);
    if (!d.includes(`TeamIdentifier=${TEAM_ID}`)) throw new Error(`${rel}: not signed by team ${TEAM_ID}`);
    if (!/flags=0x[0-9a-f]*\(.*runtime.*\)/.test(d) && !/Runtime Version=/.test(d)) throw new Error(`${rel}: no hardened runtime`);
    if (!/Timestamp=/.test(d)) throw new Error(`${rel}: no secure timestamp`);
    n++;
  }
  say(`${n} Mach-O files: team ${TEAM_ID}, hardened runtime, timestamp ✓`);
  // the programs souldew starts: their JIT entitlements
  for (const rel of CHILD_PROGRAMS) {
    const f = join(app, 'Contents', 'Resources', rel);
    if (!existsSync(f)) throw new Error(`${rel} is missing from the app`);
    const ent = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', f], { quiet: true }).out;
    for (const k of JIT_ENTITLEMENTS) if (!ent.includes(k)) throw new Error(`${rel}: entitlement ${k} missing`);
  }
  say(`entitlements of ${CHILD_PROGRAMS.map((p) => basename(p)).join(', ')} ✓`);
  if (notarized) {
    run('/usr/sbin/spctl', ['-a', '-vv', '-t', 'exec', app]);
    run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    if (dmg) {
      run('/usr/sbin/spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmg]);
      run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    }
  }
  // the bundled Java starts under the hardened runtime
  const java = run(join(app, 'Contents', 'Resources', 'tools', 'jre', 'darwin-arm64', 'bin', 'java'), ['-version']).out;
  say(`java -version from the bundle: ${java.split('\n')[0]}`);
  await launchCheck(app, { roms });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((r) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); r(true); });
  s.once('error', () => r(false));
});

/**
 * The app started hidden (open -j -g: no window comes forward, nothing takes the focus) with a scratch profile – no
 * keychain item, no sign-in, muted – then asked through its server: the Java check, the randomizer on a GBA game, and a
 * GBA and a DS game in the fast player (the signed host and cores). Quit at the end.
 */
async function launchCheck(app, { roms = null } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'souldew-verify-'));
  const config = { onboarded: true, lang: 'en', playerName: 'Lena', bootAnimation: false, sounds: false, presence: false, volume: 0, ...(roms ? { libraryFolders: [resolve(roms)] } : {}) };
  writeFileSync(join(profile, 'config.json'), JSON.stringify(config));
  const busy = await portOpen(47390); // (an installed souldew running: the started app takes another port – not checked here)
  let port = busy ? null : 47390;
  run('/usr/bin/open', ['-j', '-g', '-n', '-a', app, '--args', `--user-data-dir=${profile}`, '--use-mock-keychain', '--mute-audio']);
  try {
    if (!port) {
      // find the port of the app we started: the process with our profile in its arguments
      for (let i = 0; i < 60 && !port; i++) {
        await sleep(1000);
        const ps = run('/bin/ps', ['-axo', 'pid=,command='], { quiet: true }).out.split('\n').find((l) => l.includes(profile) && l.includes('/MacOS/souldew'));
        const pid = ps && ps.trim().split(/\s+/)[0];
        const ls = pid ? run('/usr/sbin/lsof', ['-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-nP'], { quiet: true, allowFail: true }).out : '';
        const m = ls.match(/127\.0\.0\.1:(\d+)|localhost:(\d+)|\*:(\d+)/);
        if (m) port = Number(m[1] || m[2] || m[3]);
      }
    }
    if (!port) throw new Error('the started app\'s server wasn\'t found');
    const base = `http://127.0.0.1:${port}`;
    const get = (p) => fetch(base + p, { headers: { 'x-soullink': '1' } }).then((r) => r.json());
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) }).then((r) => r.json());
    let status = null;
    for (let i = 0; i < 120 && !status; i++) {
      status = await get('/api/status').catch(() => null);
      if (!status) await sleep(1000);
    }
    if (!status) throw new Error('the app\'s server didn\'t answer');
    if (!status.java?.ok || !status.java.bundled) throw new Error(`the app's Java check: ${JSON.stringify(status.java)}`);
    say(`started hidden, server on ${port}, Java ${status.java.version} (bundled) ✓`);
    if (!roms) return say('(no --roms: games not booted)');
    let lib = null;
    for (let i = 0; i < 60; i++) {
      lib = await get('/api/library').catch(() => null);
      if (lib?.roms?.some((r) => r.system === 'gba') && lib.roms.some((r) => r.system === 'nds')) break;
      await sleep(1000);
    }
    for (const system of ['gba', 'nds']) {
      const rom = lib?.roms?.find((r) => r.system === system);
      if (!rom) throw new Error(`no ${system} game in ${roms}`);
      const src = `/api/library/rom?id=${encodeURIComponent(rom.id)}`;
      if (system === 'gba') {
        // the randomizer's trial run: the bundled Java with UPR, under the hardened runtime
        const inspect = await post('/api/rom/inspect', { romId: rom.id });
        if (!inspect?.info?.pokemonCount) throw new Error(`the randomizer couldn't read ${rom.name}: ${JSON.stringify(inspect?.info || inspect).slice(0, 300)}`);
        say(`randomizer (UPR on the bundled Java): ${rom.gameId || rom.name}, ${inspect.info.pokemonCount} Pokémon ✓`);
      }
      const started = await post('/api/native/start', { rom: src, key: `verify-${system}`, system });
      if (!started?.id) throw new Error(`the fast player didn't start ${system}: ${JSON.stringify(started).slice(0, 300)}`);
      let frames = 0;
      for (let i = 0; i < 30 && frames < 120; i++) {
        await sleep(1000);
        const st = await get('/api/native/status').catch(() => null);
        const events = st?.session?.events || [];
        frames = Math.max(0, ...events.filter((e) => e.event === 'stats').map((e) => e.frame || 0));
        if (st?.session?.exit) throw new Error(`the fast player ended: ${JSON.stringify(st.session.exit)} ${String(st.session.stderr || '').slice(-400)}`);
      }
      if (frames < 120) throw new Error(`${system}: the game didn't run (${frames} frames)`);
      say(`${system}: ${rom.gameId || rom.name} boots in the fast player (signed retrohost + core), ${frames} frames ✓`);
      await post('/api/native/stop', { id: started.id }).catch(() => {});
    }
  } finally {
    // quit the app we started (only that one: by its profile)
    const ps = run('/bin/ps', ['-axo', 'pid=,command='], { quiet: true }).out.split('\n').filter((l) => l.includes(profile) && l.includes('/MacOS/souldew'));
    for (const l of ps) {
      const pid = Number(l.trim().split(/\s+/)[0]);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // gone
      }
    }
    await sleep(3000);
    rmSync(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = opt('verify');
  (target ? verify(resolve(target), { dmg: opt('dmg'), notarized: !has('no-notarize'), roms: opt('roms') }) : build()).catch((e) => {
    console.error(`\n✗ ${redact(e.message)}`);
    process.exit(1);
  });
}
