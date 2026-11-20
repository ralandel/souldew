// The native hosts' filter for a core's messages (native/ctr-host/coremsg.h): melonDS DS sends an empty on-screen
// message every frame, and a DS player's diagnostics (Linux, souldew 2.8.3) held nothing but thousands of
// "[core message] " lines in the host's stderr. The real C code, compiled with a small driver; needs a C compiler (cc),
// skipped without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const header = new URL('../native/ctr-host/coremsg.h', import.meta.url);
const cc = ['cc', 'clang', 'gcc'].find((c) => spawnSync(c, ['--version']).status === 0);

// reads lines "<time> <message>" from stdin (the message may be empty; "\0" stands for NULL), prints what is logged
const DRIVER = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "coremsg.h"
int main(void) {
  char line[600];
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\n")] = 0;
    char *sp = strchr(line, ' ');
    double t = atof(line);
    const char *msg = sp ? sp + 1 : "";
    if (!strcmp(msg, "\\0")) msg = NULL;
    unsigned rep;
    if (core_msg_wanted(msg, t, &rep)) printf("%s|%u\n", msg, rep);
  }
  return 0;
}
`;

/** Runs the driver over [[t, msg]…]; returns the logged [msg, repeats-before] pairs. */
function run(feed) {
  const dir = mkdtempSync(join(tmpdir(), 'coremsg-'));
  try {
    const src = join(dir, 'driver.c');
    const exe = join(dir, 'driver');
    writeFileSync(src, DRIVER);
    const b = spawnSync(cc, ['-O1', '-Wall', '-Werror', '-I', fileURLToPath(new URL('.', header)), '-o', exe, src]);
    assert.equal(b.status, 0, String(b.stderr));
    const r = spawnSync(exe, { input: feed.map(([t, m]) => `${t} ${m}`).join('\n') + '\n' });
    assert.equal(r.status, 0, String(r.stderr));
    return String(r.stdout)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const i = l.lastIndexOf('|');
        return [l.slice(0, i), Number(l.slice(i + 1))];
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('core messages: the empty ones melonDS DS sends every frame never reach the log', { skip: !cc && 'no C compiler' }, () => {
  // a minute at 60 frames a second, as melonDS DS 1.4.0's on-screen display: an empty message per frame
  const feed = Array.from({ length: 3600 }, (_, i) => [(i / 60).toFixed(4), '']);
  feed.splice(100, 0, ['1.67', ' \t ']); // (only white space: nothing to read either)
  feed.splice(200, 0, ['3.3', '\\0']); // (no text at all)
  assert.deepEqual(run(feed), []);
});

test('core messages: a real one is logged, the same again within 10 s is not – its repeats are said with the next one', { skip: !cc && 'no C compiler' }, () => {
  const feed = [];
  for (let i = 0; i < 600; i++) feed.push([(i / 60).toFixed(4), 'Layout 1/1']); // 10 s of the same message every frame
  feed.push(['10.5', 'Layout 1/1']); // more than 10 s after it was logged: logged again
  feed.push(['11', 'Saved']);
  feed.push(['11.5', 'Saved']);
  feed.push(['12', '']);
  feed.push(['12.5', 'Layout 1/1']); // another message in between: the same one counts as new
  assert.deepEqual(run(feed), [
    ['Layout 1/1', 0],
    ['Layout 1/1', 599],
    ['Saved', 0],
    ['Layout 1/1', 1],
  ]);
});

test('the fast player’s host routes both message kinds through the filter', () => {
  const src = readFileSync(new URL('../native/retro-host/retrohost.c', import.meta.url), 'utf8');
  assert.match(src, /#include "coremsg\.h"/);
  assert.match(src, /RETRO_ENVIRONMENT_SET_MESSAGE\)\) \{ core_message\(/);
  assert.match(src, /RETRO_ENVIRONMENT_SET_MESSAGE_EXT\)\) \{ core_message\(/);
  assert.doesNotMatch(src, /logf_\("\[core message\] %s", \(\(const struct/, 'no message goes to the log unfiltered');
});
