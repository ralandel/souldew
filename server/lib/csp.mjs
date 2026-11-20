// Content-Security-Policy for the app's HTML pages, sent as a response header by the static handler.
// Inline <script> blocks are allowed by their SHA-256 hash, computed from the file when it is served,
// so editing an inline script never needs a manual hash update (and nothing else inline can run).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { syncOrigins, EDITION } from '../../shared/edition.mjs';

/** 'sha256-…' sources for every inline <script> (no src attribute) in an HTML document. */
export function inlineScriptHashes(html) {
  // The HTML parser turns CRLF / CR into LF before the browser hashes the script text.
  const text = String(html).replace(/\r\n?/g, '\n');
  const out = [];
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\ssrc\s*=/i.test(` ${m[1]}`)) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return [...new Set(out)];
}

/** The sockets the page may open: this build's brokers and signalling relays (shared/edition.mjs). Nothing else –
 *  not the public brokers or Nostr relays the official app uses. */
export const syncSources = () => syncOrigins(EDITION);

/**
 * The policy for one HTML page.
 *   emulator – the page boots EmulatorJS (player.html, emu-test.html): its cores are compiled to WASM, the
 *              core's JS is injected as a blob: <script>, and the 7z/zip extractors run in blob: workers
 *              that inherit this policy and call eval() (Emscripten's old cwrap) → 'unsafe-eval'.
 *              No outside network at all: that also blocks EmulatorJS' update check and CDN fallback.
 *   otherwise – the app UI / OBS overlay: same-origin scripts only, plus the sync relays.
 */
export function cspFor(html, { connect = syncSources() } = {}) {
  const emulator = /vendor\/emulatorjs\//.test(html);
  const hashes = inlineScriptHashes(html);
  const script = ["'self'", ...hashes, ...(emulator ? ["'wasm-unsafe-eval'", "'unsafe-eval'", 'blob:'] : [])];
  const directives = {
    'default-src': ["'self'"],
    'script-src': script,
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'frame-src': ["'self'"],
    'connect-src': ["'self'", 'blob:', 'data:', ...(emulator ? [] : connect)],
    'img-src': ["'self'", 'data:', 'blob:', 'https://raw.githubusercontent.com'],
    'media-src': ["'self'", 'data:', 'blob:'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

/**
 * The sandboxed iframe that runs souldew+ pack code (web/cosmetics-sandbox.html, web/lib/cosmetics/sandbox.mjs): its
 * one script, a data: module worker importing the public engine modules – and nothing else. No network
 * (connect-src 'none'), no images, styles, fonts, frames or forms.
 */
export const SANDBOX_CSP = [
  "default-src 'none'", "script-src 'self'", "worker-src 'self' data:", "connect-src 'none'", "img-src 'none'", "style-src 'none'",
  "font-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
].join('; ');

const cache = new Map(); // path → { mtimeMs, size, header }
/**
 * Extra response headers for a file the static handler serves: the CSP for .html pages; CORS for the public cosmetics
 * engine modules (the sandboxed iframe's worker has an opaque origin and imports them cross-origin – public code, no
 * credentials); {} otherwise.
 */
export function pageHeaders(path) {
  const p = String(path).replace(/\\/g, '/');
  if (/\/web\/lib\/cosmetics\/.+\.mjs$/.test(p)) return { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
  if (/\/web\/cosmetics-sandbox\.html$/.test(p)) {
    return { 'Content-Security-Policy': SANDBOX_CSP, 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };
  }
  if (/\/web\/lib\/cosmetics\/sandbox-frame\.js$/.test(p)) return { 'Cross-Origin-Resource-Policy': 'cross-origin' };
  if (!/\.html?$/i.test(path)) return {};
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.headers;
    const headers = {
      'Content-Security-Policy': cspFor(readFileSync(path, 'utf8')),
      // Cross-origin isolation: lets the emulator use threads (SharedArrayBuffer) – the multi-threaded DS core
      // keeps fast-forward at full speed. Everything the pages load is same-origin, so nothing else changes.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    };
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, headers });
    return headers;
  } catch {
    return {}; // missing file → serveFile answers 404 anyway
  }
}
