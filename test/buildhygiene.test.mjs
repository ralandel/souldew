// Build hygiene for 3.0.1: native binaries without the build machine's paths (scripts/buildpaths.mjs – the home folder
// holds the account name, often the owner's own), the tests on Node 22 like CI, and the signed macOS release build
// (scripts/dist-mac-signed.mjs: Developer ID, hardened runtime, the programs souldew starts with their JIT
// entitlements, the certificate's name never printed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { prefixMapFlags, prefixMapEnv, prefixMapCmake, filesWithPath } from '../scripts/buildpaths.mjs';
import { redact, signedConfig, CHILD_PROGRAMS, JIT_ENTITLEMENTS, TEAM_ID } from '../scripts/dist-mac-signed.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('buildpaths: the checkout and the home folder are mapped away – for the compilers called directly, CMake and make', () => {
  assert.deepEqual(prefixMapFlags('/Users/kim/souldew', '/Users/kim'), ['-ffile-prefix-map=/Users/kim/souldew=/souldew', '-ffile-prefix-map=/Users/kim=/build']);
  assert.deepEqual(prefixMapFlags('/home/runner/work/souldew', '/home/runner'), ['-ffile-prefix-map=/home/runner/work/souldew=/souldew', '-ffile-prefix-map=/home/runner=/build']);
  assert.deepEqual(prefixMapFlags('/src', '/'), ['-ffile-prefix-map=/src=/souldew'], 'no home to map');
  const env = prefixMapEnv(['-ffile-prefix-map=/a=/b'], { CFLAGS: '-O2', PATH: '/bin' });
  assert.equal(env.CFLAGS, '-O2 -ffile-prefix-map=/a=/b');
  assert.equal(env.CXXFLAGS, '-ffile-prefix-map=/a=/b');
  assert.equal(env.OBJCFLAGS, '-ffile-prefix-map=/a=/b');
  assert.equal(env.PATH, '/bin');
  assert.deepEqual(prefixMapCmake(['-X'], {}), ['-DCMAKE_C_FLAGS=-X', '-DCMAKE_CXX_FLAGS=-X', '-DCMAKE_OBJC_FLAGS=-X', '-DCMAKE_OBJCXX_FLAGS=-X']);
});

test('buildpaths: --check finds a built file that still holds the home folder (any depth, binary or text)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-buildpaths-'));
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'clean.dylib'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]));
    writeFileSync(join(dir, 'sub', 'leaky.dylib'), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(`assert failed: /Users/kim/souldew/_ref/x.c:12\0`)]));
    assert.deepEqual(filesWithPath(dir, '/Users/kim'), ['sub/leaky.dylib']);
    assert.deepEqual(filesWithPath(dir, '/Users/sam'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildpaths: both build scripts compile with it and their --check refuses a leak', () => {
  for (const f of ['scripts/build-native.mjs', 'scripts/build-ctr.mjs']) {
    const s = read(f);
    assert.match(s, /const PREFIX_MAP = prefixMapFlags\(root\);/, f);
    assert.match(s, /env: prefixMapEnv\(PREFIX_MAP\)/, `${f}: every step's environment`);
    assert.match(s, /prefixMapCmake\(PREFIX_MAP\)/, `${f}: CMake's own variables (a cached build folder)`);
    assert.match(s, /const leaks = existsSync\(out\) \? filesWithPath\(out\) : \[\];/, `${f}: --check`);
  }
  assert.match(read('scripts/build-native.mjs'), /const words = cmd === cc \|\| cmd === cxx \? \[\.\.\.PREFIX_MAP, \.\.\.a\] : a;/);
  assert.match(read('scripts/build-ctr.mjs'), /run\(cc, \['-O2', '-Wall', \.\.\.PREFIX_MAP,/);
});

test('npm run test:node22: the whole suite on Node 22, as CI runs it', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:node22'], 'npx -y node@22 --test --test-timeout=600000 "test/*.test.mjs"');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=600000 "test/*.test.mjs"', 'the same files and timeout');
  assert.equal(pkg.scripts['dist:mac-signed'], 'node scripts/dist-mac-signed.mjs');
});

test('signed macOS build: the certificate\'s name (a legal name) never reaches the output', () => {
  const name = 'Developer ID Application: Kim Example (VWQM7SSK3D)';
  assert.equal(redact(`signing file=souldew.app identityName=${name}`, name), 'signing file=souldew.app identityName=<Developer ID>');
  assert.equal(redact('Authority=Developer ID Application: Kim Example (VWQM7SSK3D)\nTeamIdentifier=VWQM7SSK3D', name), 'Authority=<Developer ID>\nTeamIdentifier=VWQM7SSK3D');
  assert.equal(redact('a line naming Kim Example alone', name), 'a line naming <name> alone');
  assert.equal(redact('nothing to hide', null), 'nothing to hide');
  // nothing in the repository names the account holder or holds the certificate
  const script = read('scripts/dist-mac-signed.mjs');
  assert.doesNotMatch(script, /Developer ID Application: [A-Z]/, 'no certificate name in the script');
  assert.match(script, /'-P', pass, /, 'the password goes to security import only');
  assert.match(script, /secret: \[pass\]/, 'and is never printed');
  assert.match(script, /delete-keychain/, 'the build keychain goes');
  assert.match(script, /run\('\/usr\/bin\/security', \['list-keychains', '-d', 'user', '-s', \.\.\.listed\]/, 'the keychain search list is put back as it was');
});

test('signed macOS build: the config – identity from the build keychain, hardened runtime, entitlements, notarization, a signed DMG', () => {
  const base = JSON.parse(read('package.json')).build;
  const cfg = signedConfig(base, { identity: 'A'.repeat(40), out: '/tmp/out', notarize: true });
  assert.equal(cfg.mac.identity, 'A'.repeat(40));
  assert.equal(cfg.mac.hardenedRuntime, true);
  assert.equal(cfg.mac.notarize, true);
  assert.equal(cfg.mac.entitlements, 'build/entitlements.mac.plist');
  assert.equal(cfg.mac.entitlementsInherit, 'build/entitlements.mac.inherit.plist');
  assert.equal(cfg.dmg.sign, true);
  assert.equal(cfg.directories.output, '/tmp/out');
  assert.deepEqual(cfg.mac.extraResources, base.mac.extraResources, 'the same parts as `npm run dist`');
  assert.equal(base.mac.identity, '-', 'npm run dist stays ad hoc');
  assert.equal(signedConfig(base, { identity: 'x', out: 'o', notarize: false }).mac.notarize, false);
  assert.equal(TEAM_ID, 'VWQM7SSK3D');
  // the programs souldew starts get the JIT (Java's HotSpot, melonDS / mGBA, Azahar's dynarmic)
  for (const f of ['build/entitlements.mac.plist', 'build/entitlements.mac.inherit.plist']) {
    const plist = read(f);
    for (const k of JIT_ENTITLEMENTS) assert.match(plist, new RegExp(`<key>${k.replace(/\./g, '\\.')}</key>\\s*<true/>`), `${f}: ${k}`);
    assert.doesNotMatch(plist, /app-sandbox|device\.camera|device\.audio-input/, `${f}: nothing more`);
  }
  assert.deepEqual(CHILD_PROGRAMS.map((p) => p.split('/').pop()), ['java', 'retrohost', 'linkhost', 'ctrhost']);
});

test('signed macOS build: no "Open Anyway" / right-click hints for the Mac app any more', () => {
  for (const f of ['README.md', 'site/index.html', 'site/de/index.html', 'web/views/update.mjs', 'web/i18n/en.json', 'web/i18n/de.json']) {
    const s = read(f);
    assert.doesNotMatch(s, /Open Anyway|Dennoch öffnen|not notarized|nicht notarisiert|upd\.gatekeeper/, f);
  }
  assert.ok(!homedir() || !read('scripts/dist-mac-signed.mjs').includes(homedir()), 'no home folder in the script');
});
