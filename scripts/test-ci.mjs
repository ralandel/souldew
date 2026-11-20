#!/usr/bin/env node
// The test suite for CI and the release build (souldew Renaissance): every test file once, then the files that failed
// once more on their own. A handful of upstream tests time things (in-memory broker lingers, ROM scans that "take too
// long", the invite code's expiry); on a busy runner with every file in parallel one of them can miss its window and
// stop a release that is fine. A file that fails again alone fails the job – a real bug still stops it.
//
//   node scripts/test-ci.mjs            what `npm test` runs, plus the one retry
//   node scripts/test-ci.mjs <files>    the same for these files only
//
// The failing files come from a tiny reporter (this file, imported by `node --test --test-reporter=…`): every
// `test:fail` event carries the file it came from.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, '..', '..');

/** node --test reporter: one line per failing file (deduplicated by the caller). */
export default async function* failedFiles(source) {
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data?.file && !event.data.todo && !event.data.skip) yield `${event.data.file}\n`;
  }
}

function run(files, failedOut) {
  const args = ['--test', '--test-timeout=600000', '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(SELF).href}`, `--test-reporter-destination=${failedOut}`, ...files];
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const dir = mkdtempSync(join(tmpdir(), 'souldew-test-ci-'));
  const out = join(dir, 'failed.txt');
  const files = process.argv.slice(2);
  let code = run(files.length ? files : ['test/*.test.mjs'], out);
  if (code !== 0) {
    let failed = [];
    try {
      failed = [...new Set(readFileSync(out, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))];
    } catch {
      // no list: nothing to retry – the first run's result stands
    }
    // only test files of this repo, and not too many: a broken build fails everywhere, a retry wouldn't help
    failed = failed.map((f) => relative(ROOT, f.startsWith('file:') ? fileURLToPath(f) : f).replaceAll('\\', '/'))
      .filter((f) => /^test\/[\w.-]+\.test\.mjs$/.test(f));
    if (failed.length && failed.length <= 5) {
      console.log(`\n::warning::Retrying ${failed.length} failed test file(s) on their own: ${failed.join(', ')}`);
      code = run(failed, join(dir, 'failed-again.txt'));
      if (code === 0) console.log('::warning::They passed on their own – timing-sensitive tests, not a broken build.');
    }
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
