// Java + Universal Pokemon Randomizer ZX detection, download and invocation.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, statfsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, delimiter, dirname, resolve, sep } from 'node:path';
import { listZip, readZipEntry } from './zip.mjs';
import { TOOLS_DIR, BUNDLED_TOOLS, CACHE_DIR } from './paths.mjs';
import { httpError, removeQuietly } from './fsutil.mjs';
import { redactHome } from './ctr.mjs';
import { PRESETS, buildValues, toProperties } from '../../shared/randomizer-options.mjs';

export const UPR_VERSION = '4.6.1';
export const UPR_URL = 'https://github.com/Ajarmar/universal-pokemon-randomizer-zx/releases/download/v4.6.1/PokeRandoZX-v4_6_1.zip';
export const UPR_ZIP_SHA256 = '26051fe8a6665ea0582dfcd4d1c3e4889da42a2f731f5fc530fff0cb691a43fd';
const BUNDLED_JAR = join(BUNDLED_TOOLS, 'upr', 'PokeRandoZX.jar');
export const UPR_JAR = existsSync(BUNDLED_JAR) ? BUNDLED_JAR : join(TOOLS_DIR, 'upr', 'PokeRandoZX.jar');
export const BRIDGE_DIR = join(BUNDLED_TOOLS, 'upr-bridge');
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const bundledJava = (arch) => join(BUNDLED_TOOLS, 'jre', `${process.platform}-${arch}`, 'bin', JAVA_EXE);
const BUNDLED_JAVA = bundledJava(process.arch);
// An arm64 Windows PC runs the bundled x64 runtime through Windows' x64 emulation.
const BUNDLED_FALLBACK = process.platform === 'win32' && process.arch === 'arm64' ? bundledJava('x64') : null;

/**
 * JVM options for the randomizer. UTF-8 as the default charset: Java 17 on Windows would otherwise read and write
 * text in the ANSI code page (cp1252), unlike macOS – the same seed must give the same game on every computer.
 */
export const JAVA_OPTS = ['-Xmx1g', '-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'];

/**
 * A 3DS game (Gen 6/7) needs far more Java heap: UPR ZX's own launcher starts it with -Xmx4608M (Sun runs out of memory
 * below ~2 GB). Only a ceiling – Java takes what it uses.
 */
export const CTR_HEAP = '-Xmx4608m';
/** Rebuilding a 3DS game writes ~3 GB and hashes it: minutes on a slow disk. */
export const CTR_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * JVM options of one bridge call. `ctr`: a 3DS game – the larger heap. `workDir`: UPR's working folder (the patched
 * SysConstants in tools/upr-bridge reads -Dsouldew.upr.root; without it UPR writes next to its jar, inside the app).
 */
export function javaOptsFor({ ctr = false, workDir = null } = {}) {
  const root = workDir ? [`-Dsouldew.upr.root=${workDir}`] : [];
  if (!ctr) return [...JAVA_OPTS, ...root];
  return [CTR_HEAP, ...JAVA_OPTS.filter((o) => !o.startsWith('-Xmx')), ...root];
}

/**
 * The @@ lines of the bridge's output → { json, warnings, error, settingsString, done, code, step, files }.
 * Other lines (UPR's own "NCCH: …" chatter) are ignored.
 */
export function parseBridgeOutput(out) {
  const result = { json: null, warnings: [], error: null, settingsString: null, done: null, code: null, step: null, files: null };
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^@@(\w+) (.*)$/);
    if (!m) continue;
    let value;
    try {
      value = JSON.parse(m[2]);
    } catch {
      continue; // a garbled line must not throw inside an event handler (= server crash)
    }
    if (m[1] === 'JSON') result.json = value;
    else if (m[1] === 'WARN') result.warnings.push(value);
    else if (m[1] === 'ERROR') result.error = value;
    else if (m[1] === 'SETTINGS') result.settingsString = value;
    else if (m[1] === 'DONE') result.done = value;
    else if (m[1] === 'CODE') result.code = value;
    else if (m[1] === 'STEP') result.step = value;
    else if (m[1] === 'FILES') result.files = value;
  }
  return result;
}

let javaCache = null;

/** Installed JDKs / JREs in the usual Windows folders (…\Java\jdk-17\bin\java.exe, Adoptium, Microsoft, Zulu …). */
export function windowsJavaCandidates(env = process.env, list = readdirSync) {
  const found = [];
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean);
  // 'jdk-21.0.4.7-hotspot' → 21, 'jdk1.8.0_202' / 'jre1.8.0' → 8
  const major = (name) => {
    const m = /(\d+)(?:\.(\d+))?/.exec(name);
    return !m ? 0 : m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1]);
  };
  for (const root of [...new Set(roots)]) {
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
      let names = [];
      try {
        names = list(join(root, vendor));
      } catch {
        continue;
      }
      for (const name of names) found.push({ path: join(root, vendor, name, 'bin', 'java.exe'), major: major(name) });
    }
  }
  // newest first, so a current Java wins over an old Java 8 left behind
  return found.sort((a, b) => b.major - a.major).map((f) => f.path);
}

function javaCandidates() {
  // The bundled runtime comes first: both players then use the identical Java version,
  // which keeps seeded randomization byte-identical across machines.
  const list = [BUNDLED_JAVA];
  if (BUNDLED_FALLBACK) list.push(BUNDLED_FALLBACK);
  if (process.env.JAVA_HOME) list.push(join(process.env.JAVA_HOME, 'bin', JAVA_EXE));
  list.push('java');
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) list.push(join(r.stdout.trim(), 'bin', 'java'));
    list.push('/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java');
    list.push('/opt/homebrew/opt/openjdk/bin/java');
  }
  if (process.platform === 'win32') list.push(...windowsJavaCandidates());
  return list;
}

/**
 * How long `java -version` may take. A Java started for the first time can be slow: macOS's XProtect scans a new
 * binary before it runs (seconds on a busy Mac), antivirus on Windows does the same. A check that ran out is tried
 * once more – the scan is done by then.
 */
export const JAVA_CHECK_MS = 40000;

/**
 * Did this Java crash rather than answer? On macOS 27 with System Integrity Protection off, every HotSpot JVM on Apple
 * Silicon dies while it sets up its code cache (SIGBUS in CodeHeap::allocate, #40) – the bundled one and any the
 * player installs. A signal, the exit codes a signal turns into (128 + 6 SIGABRT, + 10 SIGBUS, + 11 SIGSEGV; Java's
 * own crash handler exits with 134) or the JVM's crash report.
 */
export function javaCrashed(r) {
  if (!r || r.error?.code === 'ENOENT') return false;
  if (['SIGBUS', 'SIGSEGV', 'SIGABRT', 'SIGILL', 'SIGTRAP'].includes(r.signal)) return true;
  if ([134, 135, 138, 139].includes(r.status)) return true;
  return /CodeHeap|SIGBUS|SIGSEGV|A fatal error has been detected by the Java Runtime/i.test(`${r.stderr || ''}${r.stdout || ''}`);
}

/** One candidate's answer, as diagnostics keep it: the path, how it ended, the first lines it wrote (home shortened). */
function javaTry(bin, r, tries) {
  const text = `${r.stderr || ''}${r.stdout || ''}`;
  return {
    path: redactHome(bin),
    exit: r.status ?? null,
    signal: r.signal || null,
    ...(r.error ? { error: r.error.code || r.error.name || 'error' } : {}),
    ...(tries > 1 ? { tries } : {}),
    ...(javaCrashed(r) ? { crashed: true } : {}),
    // (a JVM crash report starts with lines of nothing but "#": left out, so the signal and the frame fit)
    out: redactHome(text.split(/\r?\n/).filter((l) => l.replace(/^#/, '').trim()).slice(0, 6).join('\n')).slice(0, 800),
  };
}

/**
 * The first Java that answers `-version` (the bundled one first) → { ok, bin, version, major, bundled, vendor, checked }.
 * None: { ok: false, crashed } – crashed when one of them started and crashed (the page then says why instead of
 * "Java wasn't found"). `checked`: every candidate's answer, for "Save diagnostics".
 * `spawn`/`candidates`: for tests.
 */
export function detectJava(force = false, { spawn = spawnSync, candidates = javaCandidates, timeoutMs = JAVA_CHECK_MS } = {}) {
  if (javaCache && !force) return javaCache;
  const checked = [];
  for (const bin of candidates()) {
    let r = null;
    let tries = 0;
    try {
      // windowsHide: java.exe is a console program – without it every check would flash a console window
      do {
        tries++;
        r = spawn(bin, ['-version'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
      } while (tries < 2 && r?.error?.code === 'ETIMEDOUT');
    } catch (e) {
      r = { status: null, signal: null, error: e, stderr: '', stdout: '' };
    }
    const text = `${r.stderr || ''}${r.stdout || ''}`;
    const m = text.match(/version "([^"]+)"/);
    if (r.status === 0 && m) {
      const raw = m[1];
      const major = raw.startsWith('1.') ? Number(raw.split('.')[1]) : Number(raw.split(/[.+-]/)[0]);
      checked.push(javaTry(bin, r, tries));
      javaCache = { ok: major >= 8, bin, version: raw, major, bundled: bin === BUNDLED_JAVA || bin === BUNDLED_FALLBACK, vendor: text.split(/\r?\n/)[1]?.trim() || '', checked };
      return javaCache;
    }
    // (a name that isn't there – "java" without an installed Java – is no news: only kept short)
    checked.push(r.error?.code === 'ENOENT' ? { path: redactHome(bin), error: 'ENOENT' } : javaTry(bin, r, tries));
  }
  javaCache = { ok: false, bin: null, version: null, major: 0, crashed: checked.some((c) => c.crashed), checked };
  return javaCache;
}

/** What "Save diagnostics" keeps of the Java check: the answer and every candidate's (paths with the home shortened). */
export function javaDiagnostics() {
  const j = detectJava();
  return { ok: j.ok, version: j.version, major: j.major, bundled: !!j.bundled, crashed: !!j.crashed, path: j.bin ? redactHome(j.bin) : null, checked: j.checked || [] };
}

/** The missing tool for the page: 'java' (none found), 'javaCrash' (Java starts and crashes – #40), 'upr', or null. */
export function missingToolNow() {
  const j = detectJava();
  if (!j.ok) return j.crashed ? 'javaCrash' : 'java';
  return uprStatus().installed ? null : 'upr';
}

export function uprStatus() {
  return {
    version: UPR_VERSION,
    installed: existsSync(UPR_JAR),
    bridge: existsSync(join(BRIDGE_DIR, 'SoulLinkBridge.class')),
    jar: UPR_JAR,
  };
}

export async function installUpr() {
  const res = await fetch(UPR_URL);
  if (!res.ok) throw httpError(502, `Downloading the randomizer failed (HTTP ${res.status})`, 'uprDownload', { detail: `HTTP ${res.status}` });
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== UPR_ZIP_SHA256) throw httpError(502, 'The randomizer download is damaged (its checksum doesn’t match) – nothing was installed', 'uprChecksum');
  mkdirSync(join(TOOLS_DIR, 'upr'), { recursive: true });
  const tmp = join(TOOLS_DIR, 'upr', 'download.zip');
  writeFileSync(tmp, buf);
  try {
    const entry = listZip(tmp).find((e) => e.name.endsWith('PokeRandoZX.jar'));
    if (!entry) throw httpError(502, 'PokeRandoZX.jar is missing from the randomizer download', 'uprChecksum');
    writeFileSync(UPR_JAR + '.part', readZipEntry(tmp, entry));
    renameSync(UPR_JAR + '.part', UPR_JAR);
  } finally {
    rmSync(tmp, { force: true });
  }
  return uprStatus();
}

/**
 * What the new-run wizard needs to know about a Gen 1–5 game (POST /api/rom/inspect): UPR ZX's `info`, with a trial
 * run of the recommended preset (`gen`: the game's generation, for that preset's values) – the whole randomization in
 * memory, nothing written (SoulLinkBridge info). A game UPR can't load → { unsupported: true, reason: 'unreadable' };
 * one it loads but can't randomize (a ROM hack or release whose data isn't where UPR expects it) → reason 'randoCrash'
 * with `what`, the exception's class: the page says so before a run is built, instead of a failed build. Java or the
 * randomizer missing → `missingTool`. Never the bridge's own output (#43). `run`: runBridge (tests pass a stand-in).
 */
export async function inspectRom(path, { gen = null, run = runBridge, dir = CACHE_DIR } = {}) {
  const props = join(dir, `trial-${randomBytes(6).toString('hex')}.properties`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(props, toProperties(buildValues(PRESETS[0].values, gen)));
    const out = await run(['info', path, props, '1']);
    const info = out.json || {};
    if (typeof info.trial === 'string') {
      // the trial's stack trace (the bridge prints it after "@@TRIAL <exception>") – for the diagnostics, not the page's text
      const stderr = String(out.stderr || '');
      const at = stderr.lastIndexOf('@@TRIAL ');
      const trace = at >= 0 ? randomizerTrace({ error: stderr.slice(at + 8).split(/\r?\n/)[0], stderr: stderr.slice(at) }) : undefined;
      return { ...info, unsupported: true, reason: 'randoCrash', what: info.trial, trace };
    }
    return info;
  } catch (e) {
    const missingTool = missingToolNow();
    if (!missingTool) console.warn('[inspect]', e.message);
    return { unsupported: true, reason: missingTool ? null : 'unreadable', missingTool };
  } finally {
    try {
      rmSync(props, { force: true });
    } catch (e) {
      console.warn(`[inspect] the trial's settings file couldn’t be removed (${e.code || 'error'})`); // (never the wizard's answer)
    }
  }
}

/**
 * A randomizer run that failed, as the answer the page shows: in words, with a code it translates – never the
 * randomizer's own output (#43). UPR ZX stopping with a Java exception (data it doesn't expect – a ROM hack, a release
 * it doesn't know) → 422 'randoFailed', naming only the exception's class for a bug report ("Index 1286 out of bounds
 * for length 1268" and the like say nothing to a player); a timeout → 504 'randoTimeout'; a file it couldn't read or
 * write → 'randoNoSpace' / 'randoNoAccess' / 'randoReadFailed' / 'randoIoFailed' with the system's reason, which file and
 * the free space then (ioFailure). Errors that are answers already (Java or the randomizer missing, an invalid seed …)
 * pass through. The bridge's output stays on the error (`details`) for the server's log. `statfs`: tests.
 */
export function randomizerError(e, { statfs = statfsSync } = {}) {
  if (!e || e.status || !e.details) return e;
  if (e.code === 'timeout') return Object.assign(httpError(504, 'The randomizer took too long and was stopped', 'randoTimeout'), { details: e.details });
  // a file it couldn't read or write (UPR's RandomizerIOException and the like): that, in words – not "its data isn't
  // where the randomizer expects it", which sent a player whose build stopped at a file looking for a broken game (Discord,
  // Alpha Sapphire on a Mac: "Randomizer error: RandomizerIOException")
  const io = ioFailure(e.details);
  if (io) {
    const files = e.details.files || {};
    const free = freeGb(files.output ? dirname(files.output) : files.work, statfs);
    const vars = { what: io.error, where: io.where, op: io.op, ...(free != null ? { free } : {}), trace: randomizerTrace(e.details) };
    const file = { game: 'the game file', output: 'the new game in the run folder', work: 'the randomizer’s working files' }[io.where] || 'a file';
    const text = {
      randoNoSpace: [507, `The disk ran full while the randomizer was writing ${file} (${io.error})`],
      randoNoAccess: [403, `souldew isn’t allowed to use ${file} (${io.error})`],
      randoReadFailed: [422, `The game file couldn’t be read completely (${io.error})`],
      randoIoFailed: [422, `The randomizer stopped at a file error: ${io.error} (${file})`],
    }[io.code];
    return Object.assign(httpError(text[0], text[1], io.code, vars), { details: e.details });
  }
  const cls = String(e.details.error || e.details.stderr || '').match(/\b(?:[a-z]\w*\.)+([A-Z]\w*(?:Exception|Error))\b/)?.[1] || null;
  return Object.assign(httpError(422, `The randomizer can’t build this game${cls ? ` (${cls})` : ''} – play it without the randomizer`, 'randoFailed', {
    what: cls || `exit ${e.details.exitCode}`,
    trace: randomizerTrace(e.details),
  }), { details: e.details });
}

/**
 * Where in the randomizer it stopped: the exception's message and the first frames of its Java stack trace, shortened to
 * "RomHandler.method:line" (UPR ZX's classes, the bridge's own). The app keeps them in its diagnostics, so a player's
 * report names the game data the randomizer choked on – "Index 707 out of bounds for length 375" alone doesn't (pitcher_14's
 * reports, 2.7.4). Only class names and line numbers: no paths, no ROM data.
 */
/**
 * A path inside a message, the whole of it – its last part too, which can be the user's folder ("x.nds (in C:\Users\Max)"):
 * from a drive (C:\ or C:/), a UNC share or a root with a folder after it (\\server\…, /Users/…, but not the
 * "com/dabomstew" of a class name), a relative path starting at a user folder's parent or a ".." ("Users\Max\…",
 * "..\Max Mustermann\…") or any word with a backslash in it (a class name never has one). Folder names may hold spaces
 * ("C:\Users\Max Mustermann\…", "/Users/anna maria/Library/Application Support/…"), so it runs to the line's last
 * separator and then to the reason Java puts after a file (" (No such file or directory)"), a ")" or the line's end – a
 * message with text after a path loses a little of it rather than show a user name.
 */
export const PATH_IN_TEXT = /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|(?<![\w.$-])(?:\.\.?|[Uu]sers|home)[\\/]|(?<![^\s"'(=,])[^\s"'(=,\\/]*\\|(?<![\w.$-])[\\/](?=[^\r\n]*[\\/]))(?:[^\r\n]*[\\/])?[^\r\n]*?(?=\s\(|\)|[\r\n]|$)/g;

export function randomizerTrace(details = {}) {
  const lines = String(details.stderr || '').split(/\r?\n/);
  const msg = (String(details.error || '').trim() || lines.find((l) => /(?:Exception|Error)\b/.test(l)) || '')
    .replace(PATH_IN_TEXT, '…') // a file the randomizer named: neither where it lies nor its name (a user's folder can be both)
    .trim()
    .slice(0, 200);
  const frames = [];
  for (const l of lines) {
    if (l.startsWith('Caused by: ')) break; // (the cause has its own lines below)
    const m = l.match(/^\s*at\s+(?:[\w$]+\.)*([\w$]+\.[\w$<>]+)\((?:[\w$]+\.java:(\d+)|[^)]*)\)/);
    if (!m) continue;
    frames.push(m[2] ? `${m[1]}:${m[2]}` : m[1]);
    if (frames.length >= 8) break;
  }
  // the innermost cause – for a wrapped error the one that names what really went wrong: "Error when building romfs: File:
  // a/0/8/2" alone hid the "No space left on device" behind it – with its first frames, Java's own too (they say
  // whether it was reading or writing: RandomAccessFile.writeBytes)
  const chain = javaExceptions(details);
  const root = chain.length > 1 && chain[chain.length - 1].frames.length ? chain[chain.length - 1] : null; // (a stack trace's "Caused by:")
  const cause = root ? [`Caused by: ${root.cls}${root.message ? `: ${root.message}` : ''}`.replace(PATH_IN_TEXT, '…').trim().slice(0, 200), ...root.frames.filter((f, i, a) => a.indexOf(f) === i).slice(0, 4)] : [];
  return msg || frames.length ? [msg, ...frames, ...cause].filter(Boolean) : undefined;
}

const EXCEPTION_LINE = /^(?:Caused by: )?((?:[a-z_$][\w$]*\.)+[A-Z][\w$]*)(?::\s?(.*))?$/;
const FRAME_LINE = /^\s+at\s+(?:[\w.$-]+\/)?(?:[\w$]+\.)*([\w$]+\.[\w$<>]+)\((?:[\w$]+\.java:(\d+)|[^)]*)\)/;

/**
 * The exceptions of the bridge's failure, outermost first: { cls, message, frames } – from the stack trace on stderr (the
 * outer exception, then every "Caused by:"), else from the @@ERROR text (String(t): "…RandomizerIOException:
 * java.io.IOException: No space left on device"). Frames as "Class.method" or "Class.method:line"; Java's own classes
 * (java.base/java.io.RandomAccessFile.writeBytes) too.
 */
export function javaExceptions(details = {}) {
  const chain = [];
  let current = null;
  for (const l of String(details.stderr || '').split(/\r?\n/)) {
    const frame = current && l.match(FRAME_LINE);
    if (frame) {
      current.frames.push(frame[2] ? `${frame[1]}:${frame[2]}` : frame[1]);
      continue;
    }
    const ex = (chain.length === 0 || l.startsWith('Caused by: ')) && l.match(EXCEPTION_LINE);
    if (ex && /(?:Exception|Error)$/.test(ex[1])) chain.push((current = { cls: ex[1], message: (ex[2] || '').trim(), frames: [] }));
    else if (/^\S/.test(l)) current = null; // (another line: "Suppressed:", the bridge's own output …)
  }
  // an exception made from its cause (UPR's new RandomizerIOException(e)) carries the cause as its message – when the
  // trace has no "Caused by:" line for it, that message is the cause
  for (let last = chain[chain.length - 1], i = 0; last && i < 5; last = chain[chain.length - 1], i++) {
    const inner = last.message.match(EXCEPTION_LINE);
    if (!inner || !/(?:Exception|Error)$/.test(inner[1])) break;
    chain.push({ cls: inner[1], message: (inner[2] || '').trim(), frames: [] });
  }
  if (chain.length) return chain;
  // no stack trace: the @@ERROR text, split at each "pkg.Class(Exception|Error): "
  const text = String(details.error || '').trim();
  const parts = text.split(/:\s(?=(?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)\b)/);
  for (const p of parts) {
    const ex = p.match(EXCEPTION_LINE);
    if (!ex || !/(?:Exception|Error)$/.test(ex[1])) break;
    chain.push({ cls: ex[1], message: (ex[2] || '').trim(), frames: [] });
  }
  return chain;
}

const IO_CLASS = /(?:IOException|FileNotFoundException|EOFException|CannotWriteToLocationException|AccessDeniedException|NoSuchFileException|FileSystemException)$/;
// the system's words (Java passes them on – macOS/Linux in English, Windows in the system's language: English, German)
const NO_SPACE = /No space left on device|not enough space on the disk|Disk quota exceeded|nicht genügend Speicherplatz/i;
const NO_ACCESS = /Permission denied|Operation not permitted|Access is denied|Read-only file system|Zugriff verweigert/i;
const UNREADABLE = /Input\/output error|Resource deadlock avoided|Operation timed out|Device not configured|Stale NFS file handle|No such device|Bad file descriptor|No such file or directory|cannot find the (?:file|path) specified|kann die angegebene (?:Datei|Pfad)/i;

/**
 * A randomizer run that stopped at a file – UPR ZX wraps every IOException in its RandomizerIOException (Windows' "Access
 * is denied" on the output in CannotWriteToLocationException) – as { code, error, where, op }, else null:
 *   error  the system's words ("No space left on device", "Permission denied", "EOFException" when a file ended early) –
 *          never a path
 *   where  which file: 'game' (the game it reads), 'output' (the game, log or data it writes into the run folder), 'work'
 *          (its working files, UPR's unpacked game files in the cache) or null – by the path in the message
 *          (`details.files`, runBridge) or else by the frames (who was reading or writing)
 *   op     'read' | 'write' | null
 *   code   'randoNoSpace' | 'randoNoAccess' | 'randoReadFailed' (the game file can't be read: an external drive, a
 *          network folder, an iCloud file not on the Mac, a damaged copy) | 'randoIoFailed'
 */
export function ioFailure(details = {}) {
  const chain = javaExceptions(details);
  // (the innermost one counts: a RandomizerIOException around data UPR choked on – "Error when building romfs" around
  // a NegativeArraySizeException – is no file error)
  const root = chain[chain.length - 1];
  if (!root || !IO_CLASS.test(root.cls)) return null;
  const simple = root.cls.split('.').pop();
  const winDenied = simple === 'CannotWriteToLocationException';
  // "<path> (Permission denied)": the path, and the reason Java puts after it
  let path = null;
  let reason = root.message;
  const m = root.message.match(/^(.*\S)\s\(([^()]+)\)$/);
  if (m && /[\\/]/.test(m[1])) [path, reason] = [m[1], m[2]];
  else if (/^(?:[A-Za-z]:)?[\\/]/.test(root.message) && !/\s\(/.test(root.message)) [path, reason] = [root.message, ''];
  // UPR on Windows: "The randomizer cannot write to this location: C:\…" – thrown for "Access is denied" only
  if (winDenied) [path, reason] = [root.message.replace(/^.*?location:\s*/, '') || null, 'Access is denied'];
  const error = (reason.replace(PATH_IN_TEXT, '…').trim() || simple).slice(0, 120);
  const { op, where } = locate(path, details.files, root.frames, chain.flatMap((x) => x.frames), winDenied);
  const code = NO_SPACE.test(reason) ? 'randoNoSpace'
    : NO_ACCESS.test(reason) || winDenied ? 'randoNoAccess'
      : where === 'game' && (UNREADABLE.test(reason) || simple === 'EOFException') ? 'randoReadFailed'
        : 'randoIoFailed';
  return { code, error, where, op };
}

const samePath = (a, b) => !!a && !!b && resolve(a).normalize('NFC') === resolve(b).normalize('NFC');
const isUnder = (p, dir) => !!p && !!dir && (resolve(p).normalize('NFC') + sep).startsWith(resolve(dir).normalize('NFC') + sep);

/**
 * Which file and what it was doing: the path in the message first; else Java's own frames on top of the cause – a
 * RandomAccessFile read is the game (UPR keeps it open), a RandomAccessFile write the new .cxi, FileInput/OutputStream
 * UPR's working files (RomfsFile, the code in NCCH) or, from a save (Gen 1–5) or the bridge, the run folder.
 */
function locate(path, files = {}, rootFrames = [], allFrames = [], winDenied = false) {
  const top = rootFrames.join(' ');
  const all = allFrames.join(' ');
  let op = /FileOutputStream\.|RandomAccessFile\.write/.test(top) ? 'write' : /FileInputStream\.|RandomAccessFile\.read|readFileFullyIntoBuffer/.test(top) ? 'read' : null;
  let where = null;
  if (path) {
    if (samePath(path, files.game)) where = 'game';
    else if (isUnder(path, files.work)) where = 'work';
    else if (files.output && isUnder(path, dirname(files.output))) where = 'output';
  }
  if (!where) {
    if (/RandomAccessFile\.read/.test(top)) where = 'game';
    else if (/RandomAccessFile\.write/.test(top)) where = 'output';
    else if (/File(?:Input|Output)Stream\./.test(top)) {
      where = /RomfsFile\.|NCCH\.(?:getCode|writeCode)/.test(all) ? 'work' : /saveRom|SoulLinkBridge\.randomize/.test(all) ? 'output' : /loadRom|isLoadable|FromFile/.test(all) ? 'game' : null;
    } else if (/NCCH\.<init>|readFileSystem|getCXIOffsetInFile|FromFile|loadRom|isLoadable/.test(all)) where = 'game';
    else if (winDenied) where = 'output';
  }
  if (!op && where) op = where === 'game' ? 'read' : 'write';
  return { op, where };
}

/** Free GB on the drive of `dir` ("1.2"), or null when the system can't tell. */
function freeGb(dir, statfs = statfsSync) {
  if (!dir) return null;
  try {
    const s = statfs(dir);
    return ((Number(s.bavail) * Number(s.bsize)) / 1024 ** 3).toFixed(1);
  } catch {
    return null;
  }
}

/**
 * Run the SoulLinkBridge (see tools/upr-bridge/SoulLinkBridge.java). Resolves with parsed @@ lines.
 * `ctr`: a 3DS game – bigger heap, its own working folder under the cache (removed afterwards), a longer timeout.
 * `onLine`: called with every line the bridge prints while it runs (progress of a 3DS build).
 * A failure carries `code` when the bridge named one ('encrypted', 'memory', 'timeout').
 */
export function runBridge(args, { timeoutMs, ctr = false, onLine = null, spawnFn = spawn, removeDir = undefined } = {}) {
  const java = detectJava();
  if (!java.ok && java.crashed) return Promise.reject(httpError(409, 'Java crashes on this computer (on a Mac usually because System Integrity Protection is turned off).', 'javaCrash'));
  if (!java.ok) return Promise.reject(httpError(409, 'Java 8+ wasn’t found. Install Java (e.g. Temurin 21 from adoptium.net).', 'javaMissing'));
  if (!existsSync(UPR_JAR)) return Promise.reject(httpError(409, 'Universal Pokemon Randomizer ZX is missing – reinstall souldew, or play without the randomizer.', 'uprMissing'));
  const limit = timeoutMs ?? (ctr ? CTR_TIMEOUT_MS : 180000);
  // every run's own folder for the game files UPR unpacks (a 3DS game: hundreds of MB) – never inside the app, never
  // shared: two runs on the same game (the wizard's check while a build runs) took each other's files away
  const workDir = join(CACHE_DIR, ctr ? 'upr-3ds' : 'upr-work', randomBytes(6).toString('hex'));
  mkdirSync(workDir, { recursive: true });
  return new Promise((resolve, reject) => {
    // the bridge folder first: it carries a fixed copy of UPR's Effectiveness (EnumMap instead of HashMap – the order
    // of a HashMap of enums depends on the JVM, so "sensible items" on Gen 4/5 gave different ROMs per Java version)
    // and of SysConstants (the working folder above)
    const cp = [BRIDGE_DIR, UPR_JAR].join(delimiter);
    const child = spawnFn(java.bin, [...javaOptsFor({ ctr, workDir }), '-cp', cp, 'SoulLinkBridge', ...args], {
      cwd: workDir,
      windowsHide: true, // no console window next to the app while the randomizer runs
    });
    let out = '';
    let err = '';
    let partial = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limit);
    child.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) {
        try {
          onLine(l);
        } catch {
          // progress only – never the build's failure
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    // the answer first, then the working folder – best effort: on Windows a scanner holding one of UPR's files made
    // rmSync throw inside this handler, the promise never settled and the wizard hung on "Checking the game …"
    const cleanup = () => {
      clearTimeout(timer);
      setImmediate(() => removeQuietly(workDir, { rm: removeDir, label: 'randomizer' }));
    };
    child.on('error', (e) => {
      reject(e);
      cleanup();
    });
    child.on('close', (code) => {
      cleanup();
      // `code`: the code the bridge named (@@CODE), `exitCode`: the process' exit code
      const result = { ...parseBridgeOutput(out), exitCode: code, stdout: out, stderr: err };
      if (code !== 0 || result.error) {
        // the files of this call, so a file error can say which one (ioFailure) – they stay on the server
        result.files = { game: args[1] || null, output: args[0] === 'randomize' ? args[2] || null : null, work: workDir };
        const detail = timedOut ? `timed out after ${Math.round(limit / 1000)} s` : result.error || err.split(/\r?\n/).find((l) => l.trim())?.trim() || `exit code ${code}`;
        const e = new Error(`Randomizer error: ${detail}`);
        e.details = result;
        e.code = timedOut ? 'timeout' : result.code || (/OutOfMemoryError/.test(err) ? 'memory' : null);
        reject(e);
        return;
      }
      resolve(result);
    });
  });
}
