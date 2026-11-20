// The page the system browser shows after "Sign in with Discord" (http://127.0.0.1:<port>/auth/done, ./index.mjs):
// "You're signed in – you can close this tab", in the app's language and look. Static HTML with no script at all and
// a CSP that allows nothing but this server's own stylesheet and fonts. Its texts are the app's i18n keys (declared in
// web/lib/authtexts.mjs, so the extract script and the translators see them) read from web/i18n/<lang>.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_DIR } from '../paths.mjs';

const LANGS = ['en', 'de', 'fr', 'es', 'it'];
const dicts = new Map();
function dict(lang) {
  if (!dicts.has(lang)) {
    try {
      dicts.set(lang, JSON.parse(readFileSync(join(WEB_DIR, 'i18n', `${lang}.json`), 'utf8')));
    } catch {
      dicts.set(lang, {});
    }
  }
  return dicts.get(lang);
}

/** The outcomes the page knows (anything else reads as "failed"). */
export const AUTH_RESULTS = ['ok', 'failed', 'mismatch', 'expired', 'denied', 'offline', 'suspended', 'none', 'bad'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The page for one outcome. Every text is escaped (they come from translation files, still never trusted as HTML). */
export function authPage(result, lang = 'en') {
  const l = LANGS.includes(lang) ? lang : 'en';
  const tr = (k, fallback) => dict(l)[k] || dict('en')[k] || fallback;
  const ok = result === 'ok';
  const text = {
    ok: tr('auth.okText', 'You can close this tab and go back to souldew.'),
    mismatch: tr('auth.mismatchText', 'This sign-in link doesn’t belong to the sign-in souldew started. Go back to souldew and start again.'),
    expired: tr('auth.expiredText', 'This sign-in took too long. Go back to souldew and start again.'),
    none: tr('auth.expiredText', 'This sign-in took too long. Go back to souldew and start again.'),
    denied: tr('auth.cancelledText', 'You cancelled the sign-in – nothing was shared with souldew. You can close this tab.'),
    offline: tr('auth.offlineText', 'souldew couldn’t reach the account service. Check your internet connection, then try again in souldew.'),
    suspended: tr('auth.suspendedText', 'This souldew account is suspended.'),
  }[result] || tr('auth.failText', 'Go back to souldew and try again.');
  const title = ok ? tr('auth.okTitle', 'You’re signed in') : result === 'denied' ? tr('auth.deniedTitle', 'Sign-in cancelled') : tr('auth.failTitle', 'Signing in didn’t work');
  return `<!doctype html>
<html lang="${l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>souldew</title>
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<style>
html,body{margin:0;height:100%;background:#1b1a1f;color:#ebe6da;font-family:'IBM Plex Sans','Segoe UI',system-ui,sans-serif}
body{display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{max-width:420px;text-align:center;background:#222128;border:1px solid #0f0e12;border-radius:18px;padding:36px 32px 32px;box-shadow:inset 0 1px 0 #ffffff08,0 1px 0 #0006}
.mark{display:block;margin:0 auto 18px;image-rendering:pixelated}
h1{font-family:'Pixelify Sans','Silkscreen',ui-monospace,monospace;font-weight:600;font-size:24px;margin:0 0 10px}
p{color:#a9a59b;font-size:15px;line-height:1.55;margin:0}
.led{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:2px;background:${ok ? '#6fb39b' : '#dc7268'};box-shadow:0 0 6px ${ok ? '#6fb39b' : '#dc7268'}}
</style></head><body><main>
<svg class="mark" width="64" height="32" viewBox="0 0 32 16" shape-rendering="crispEdges" aria-hidden="true"><path fill="#8cb0ff" d="M4 2h6v2H4zM2 4h2v8H2zM10 4h2v2h-2zM10 10h2v2h-2zM4 12h6v2H4z"/><path fill="#ff8fdc" d="M22 2h6v2h-6zM28 4h2v8h-2zM20 4h2v2h-2zM20 10h2v2h-2zM22 12h6v2h-6z"/><path fill="#f2ffdc" d="M12 6h8v4h-8z"/></svg>
<h1><span class="led"></span>${esc(title)}</h1>
<p>${esc(text)}</p>
</main></body></html>`;
}

/** Response headers of that page: nothing may run, nothing may frame it, nothing is cached or sent on as a referrer. */
export const AUTH_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
