// Native builds without the build machine's paths: compilers write the source paths into the binaries (__FILE__ in
// asserts and log lines, debug info) – on a Mac that's /Users/<account name>/…, the account name often the owner's own
// name. scripts/build-native.mjs and scripts/build-ctr.mjs compile with -ffile-prefix-map (clang and gcc, MinGW too),
// so the home folder reads /build and the checkout /souldew; their --check fails when a built file still holds the
// home folder (a part built before this, or a build step that ignored the flags).
import { homedir } from 'node:os';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The compiler flags that map the checkout and the home folder away (the longer prefix first – it wins either way). */
export function prefixMapFlags(root, home = homedir()) {
  const maps = [];
  if (root) maps.push(`-ffile-prefix-map=${root}=/souldew`);
  if (home && home !== '/' && !(root && root === home)) maps.push(`-ffile-prefix-map=${home}=/build`);
  return maps;
}

/**
 * The environment for a build step: CFLAGS / CXXFLAGS / OBJCFLAGS / OBJCXXFLAGS with the flags added to what is set
 * already (CMake reads them when it configures a build folder, most Makefiles add to them).
 */
export function prefixMapEnv(flags, env = process.env) {
  const out = { ...env };
  for (const k of ['CFLAGS', 'CXXFLAGS', 'OBJCFLAGS', 'OBJCXXFLAGS']) out[k] = [env[k], ...flags].filter(Boolean).join(' ');
  return out;
}

/**
 * CMake arguments that set the same flags on every configure – an existing build folder keeps the flags of its first
 * configure in its cache otherwise.
 */
export function prefixMapCmake(flags, env = process.env) {
  const join2 = (k) => [env[k], ...flags].filter(Boolean).join(' ');
  return [`-DCMAKE_C_FLAGS=${join2('CFLAGS')}`, `-DCMAKE_CXX_FLAGS=${join2('CXXFLAGS')}`, `-DCMAKE_OBJC_FLAGS=${join2('OBJCFLAGS')}`, `-DCMAKE_OBJCXX_FLAGS=${join2('OBJCXXFLAGS')}`];
}

/**
 * The files in `dir` (any depth) that contain `needle` (the home folder) → [relative path]. Text files count too:
 * a SOURCES.txt with the path would publish it all the same.
 */
export function filesWithPath(dir, needle = homedir()) {
  if (!needle || needle === '/') return [];
  // The check keeps a person's account name out of locally built parts. A CI runner's home (/home/runner,
  // C:\Users\runneradmin) names nobody – and the Windows 3DS core is cross-built in a container whose paths the prefix
  // map can't fully reach – so there it would only fail the release build.
  if (process.env.GITHUB_ACTIONS === 'true' && /^(\/home\/runner|\/Users\/runner|[A-Za-z]:\\Users\\runneradmin)$/.test(needle)) return [];
  const want = Buffer.from(needle, 'utf8');
  const hits = [];
  const walk = (d, rel) => {
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p, rel ? `${rel}/${name}` : name);
      else if (s.isFile() && readFileSync(p).includes(want)) hits.push(rel ? `${rel}/${name}` : name);
    }
  };
  walk(dir, '');
  return hits;
}
