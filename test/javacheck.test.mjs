// The Java check (server/lib/toolchain.mjs detectJava, #40): on macOS 27 with System Integrity Protection off, every
// HotSpot JVM on Apple Silicon dies at start (SIGBUS in CodeHeap::allocate) – the bundled one and any the player
// installs. souldew said "Java wasn't found" and the player reinstalled Java in vain. Now a Java that starts and crashes
// is told apart (the page says what to do), every candidate's answer goes into "Save diagnostics", and a check that
// runs out of time (a first start that XProtect scans) is tried once more with a longer limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { detectJava, javaCrashed, JAVA_CHECK_MS } from '../server/lib/toolchain.mjs';

const HOME = homedir();
const BUNDLED = `${HOME}/Applications/souldew.app/Contents/Resources/tools/jre/darwin-arm64/bin/java`;
const CRASH = {
  status: null, signal: 'SIGBUS', stdout: '',
  stderr: '#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n#  SIGBUS (0xa) at pc=0x0000000104c5c3b8, pid=1234, tid=259\n#\n# JRE version:  (17.0.21.1+2) (build )\n# Problematic frame:\n# V  [libjvm.dylib+0x5c3b8]  CodeHeap::allocate(unsigned long)+0x48\n',
};
const OK = { status: 0, signal: null, stdout: '', stderr: 'openjdk version "17.0.21.1" 2025-10-21\nOpenJDK Runtime Environment Temurin-17.0.21.1+2 (build 17.0.21.1+2)\n' };
const NONE = { status: null, signal: null, error: Object.assign(new Error('spawnSync java ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' };
const TIMEOUT = { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };

/** A spawnSync stand-in: each path answers from its own list (the last answer repeats). */
function fake(answers) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, timeout: opts.timeout });
    const list = answers[bin];
    const n = calls.filter((c) => c.bin === bin).length;
    return list[Math.min(n, list.length) - 1];
  };
  return { spawn, calls };
}

test('javacheck: a crash is a signal, the exit codes a signal turns into, or the JVM\'s crash report – not a missing file', () => {
  assert.equal(javaCrashed(CRASH), true);
  assert.equal(javaCrashed({ status: 134, signal: null, stderr: '' }), true, 'Java\'s own abort');
  assert.equal(javaCrashed({ status: 138, signal: null, stderr: '' }), true, '128 + SIGBUS (a shell in between)');
  assert.equal(javaCrashed({ status: 1, signal: null, stderr: 'Error occurred during initialization of VM\nCodeHeap: could not reserve' }), true);
  assert.equal(javaCrashed(NONE), false);
  assert.equal(javaCrashed(OK), false);
  assert.equal(javaCrashed({ status: 1, signal: null, stderr: 'Unrecognized option: -version' }), false);
});

test('javacheck: every Java crashing (SIP off) – not "missing" but crashed, each candidate in the diagnostics, home shortened', () => {
  const { spawn } = fake({ [BUNDLED]: [CRASH], java: [NONE], '/opt/homebrew/opt/openjdk/bin/java': [CRASH] });
  const j = detectJava(true, { spawn, candidates: () => [BUNDLED, 'java', '/opt/homebrew/opt/openjdk/bin/java'] });
  assert.equal(j.ok, false);
  assert.equal(j.crashed, true);
  assert.equal(j.checked.length, 3);
  const [bundled, path, brew] = j.checked;
  assert.equal(bundled.signal, 'SIGBUS');
  assert.equal(bundled.crashed, true);
  assert.match(bundled.out, /CodeHeap::allocate/);
  assert.ok(bundled.out.split('\n').length <= 6, 'the first lines only');
  assert.ok(bundled.path.startsWith('~/'), 'no home folder (the account name) in the diagnostics');
  assert.ok(!JSON.stringify(j.checked).includes(HOME));
  assert.deepEqual(path, { path: 'java', error: 'ENOENT' });
  assert.equal(brew.crashed, true);
});

test('javacheck: nothing installed at all stays "missing" (not crashed); a working one later in the list wins', () => {
  const none = detectJava(true, { spawn: fake({ a: [NONE], b: [NONE] }).spawn, candidates: () => ['a', 'b'] });
  assert.equal(none.ok, false);
  assert.equal(none.crashed, false);
  const found = detectJava(true, { spawn: fake({ a: [CRASH], b: [OK] }).spawn, candidates: () => ['a', 'b'] });
  assert.equal(found.ok, true);
  assert.equal(found.major, 17);
  assert.equal(found.bin, 'b');
  assert.equal(found.checked[0].crashed, true, 'the one that crashed is still in the diagnostics');
});

test('javacheck: a check that runs out of time is tried once more (a first start scanned by XProtect), with a longer limit', () => {
  const { spawn, calls } = fake({ a: [TIMEOUT, OK] });
  const j = detectJava(true, { spawn, candidates: () => ['a'] });
  assert.equal(j.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(j.checked[0].tries, 2);
  assert.ok(calls.every((c) => c.timeout === JAVA_CHECK_MS));
  assert.ok(JAVA_CHECK_MS >= 30000, 'longer than the 15 s before');
  // twice out of time: given up on, the next one asked
  const twice = fake({ a: [TIMEOUT, TIMEOUT], b: [OK] });
  const k = detectJava(true, { spawn: twice.spawn, candidates: () => ['a', 'b'] });
  assert.equal(twice.calls.filter((c) => c.bin === 'a').length, 2);
  assert.equal(k.bin, 'b');
  assert.equal(k.checked[0].error, 'ETIMEDOUT');
});

test('javacheck: the page says it – the new-run assistant, errors from a build, Settings › About, "Save diagnostics"; every language', () => {
  const wizard = readFileSync(new URL('../web/views/soullink.mjs', import.meta.url), 'utf8');
  assert.match(wizard, /missingTool === 'javaCrash' \? javaCrashText\(/);
  const errors = readFileSync(new URL('../web/lib/errors.mjs', import.meta.url), 'utf8');
  assert.match(errors, /javaCrash: \(\) => javaCrashText\(\)/);
  const ui = readFileSync(new URL('../web/lib/ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /fetch\('\/api\/diagnostics\/java'\)/);
  assert.match(ui, /players, java, account:/);
  const app = readFileSync(new URL('../server/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /\/\^\\\/api\\\/diagnostics\\\/java\$\/, \(\) => javaDiagnostics\(\)/);
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const L = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of ['err.javaCrashMac', 'err.javaCrash', 'new.javaCrashSolo', 'new.javaCrashLink', 'set.javaCrashed']) assert.ok(L[k], `${lang}: ${k}`);
    assert.match(L['err.javaCrashMac'], /SIP/, `${lang}: names SIP`);
  }
});
