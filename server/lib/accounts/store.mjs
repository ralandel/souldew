// Where the souldew account's tokens live (the session itself: ./session.mjs).
//
// Only ever encrypted by the operating system: the desktop app hands the local server Electron's safeStorage (macOS
// Keychain, Windows DPAPI, the Secret Service / KWallet on Linux) as `secure`. The tokens are written as one encrypted
// blob (account.bin in the data folder, mode 0600) – never as text, never into config.json, a run folder, the page,
// diagnostics or a log line. Without a usable keychain (the browser build of `npm start`, a Linux desktop without a
// keyring – Electron then only offers its "basic_text" fallback, which is plain text in disguise) the store refuses to
// write anything: the session stays in memory until the app closes, and the page says so (Settings › Account).
//
// The keychain is asked only when there is something to ask it for: a saved sign-in to read (account.bin exists) or a
// sign-in to keep. A player who never signs in never makes souldew read or create its keychain item – on macOS every
// update of an unsigned build is a "new app" to that item, and touching it means a password prompt. Every keychain call
// may take as long as such a prompt stays open, so all of them are awaited (never at server start – ./session.mjs load).
import { readFileSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA_DIR, DEV, APP_ROOT } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';

/** The encrypted blob (in development the ignored runs/ folder, like config.json). */
export const accountFile = () => join(DEV ? join(APP_ROOT, 'runs') : DATA_DIR, 'account.bin');

const unreadable = () => Object.assign(new Error('The saved sign-in could not be read'), { code: 'unreadable' });

/**
 * secure: { available(), encrypt(string), decrypt(Buffer) } or null – each may answer directly or with a promise
 * (available → boolean, encrypt → Buffer, decrypt → string).
 * Returns { persistent(), load(), save(obj, { signIn }), clear() }:
 * - persistent(): false once it is known that nothing can be kept (no keychain) – never asks the keychain itself;
 * - load() → the saved object or null (nothing saved: the keychain is not asked at all). A blob that can't be opened
 *   (the keychain said no or isn't there any more, another user, a reinstalled OS) rejects with code 'unreadable' and
 *   is removed – the player signs in again instead of being asked for the keychain at every start;
 * - save(obj) → true (kept encrypted) / false (memory only); writes and clear() keep their order.
 */
export function createTokenStore(secure, { file = accountFile() } = {}) {
  let memory = null;
  let usable = null; // the keychain: null = not asked yet, then true / false
  let gen = 0; // bumps on clear(): a save that was waiting for the keychain must not bring the tokens back
  let queue = Promise.resolve();
  const later = (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  async function ask() {
    if (!secure) return false;
    if (usable !== null) return usable;
    try {
      usable = (await secure.available()) === true;
    } catch {
      usable = false;
    }
    return usable;
  }
  return {
    persistent: () => !!secure && usable !== false,
    load() {
      return later(async () => {
        if (memory || !secure || !existsSync(file)) return memory;
        try {
          if (!(await ask())) throw unreadable();
          const obj = JSON.parse(await secure.decrypt(readFileSync(file)));
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw unreadable();
          return obj;
        } catch {
          rmSync(file, { force: true });
          throw unreadable();
        }
      });
    },
    save(obj, { signIn = false } = {}) {
      const at = gen;
      return later(async () => {
        if (at !== gen) return false;
        if (signIn && usable === false) usable = null; // a new sign-in asks once more (a keyring unlocked meanwhile)
        if (!(await ask())) {
          if (at === gen) memory = obj;
          return false;
        }
        let blob;
        try {
          blob = await secure.encrypt(JSON.stringify(obj));
        } catch (e) {
          // the keychain refused (macOS: "Deny") – memory only until the app closes, and the page says so
          usable = false;
          if (at === gen) memory = obj;
          throw e;
        }
        if (at !== gen) return false; // signed out while the keychain was asked
        mkdirSync(dirname(file), { recursive: true });
        writeFileAtomic(file, blob);
        try {
          chmodSync(file, 0o600);
        } catch {
          // a file system without modes (Windows: the profile folder is private anyway)
        }
        memory = null;
        return true;
      });
    },
    clear() {
      gen++;
      memory = null;
      rmSync(file, { force: true });
    },
  };
}
