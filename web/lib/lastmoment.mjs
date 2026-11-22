// The game's last moment before it is closed from the UI ("Close game", switching game or run): the play view takes
// "where you left off" and the last battery save while its player is still there – and the session ends once the
// state's bytes are in hand. The fast player (lib/nativeplayer.mjs) and the 3DS player (lib/ctrplayer.mjs) answer
// getState through their frame: taken only in the play view's cleanup, the frame was gone before the answer came, and
// a game closed in them never had a "where you left off" of that moment.
// Quitting the whole app (the window closed, Cmd+Q, Alt+F4, an update's restart) takes the same moment (quit): the
// desktop shell waits until the state and the battery save are uploaded – the page and its server go away right after.

/** The longest a close waits for the player's state (a DS state is ≈ 20 MB; a stuck player must not keep the game open). */
export const LAST_STATE_WAIT_MS = 3000;
/** Quitting: the longest the uploads may take after that (the state and the save go to the local server). */
export const LAST_UPLOAD_WAIT_MS = 5000;

/**
 * One per app. The running play view registers what it does in the game's last moment (`set` – it returns the state
 * promise, or null when there is nothing to take); `close(end)` runs that first and `end` once the state arrived (or
 * after `wait` ms) – right away when no game is registered. Asked again while waiting, it waits for the same close.
 */
export function lastMoment({ wait = LAST_STATE_WAIT_MS, uploadWait = LAST_UPLOAD_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let take = null;
  let flush = null;
  let closing = null;
  let quitting = null;
  // `p`, or nothing after `ms` – whichever comes first (never rejects)
  const within = (p, ms) => {
    let timer = null;
    const timeout = new Promise((res) => {
      timer = setTimer(res, ms);
    });
    return Promise.race([Promise.resolve(p).catch(() => null), timeout]).then(() => clearTimer(timer));
  };
  return {
    /**
     * The running game's last moment; returns the function that takes it away again (the play view's cleanup).
     * `settled()`: a promise of the uploads that moment started (the state, the battery save) – quit waits for it.
     */
    set(fn, settled = null) {
      take = fn;
      flush = settled;
      return () => {
        if (take === fn) {
          take = null;
          flush = null;
        }
      };
    },
    /**
     * The app quits: the running game's last moment (once), then its uploads – each bounded, the game keeps running
     * (the window closes right after). Resolves when done; at once without a game.
     */
    quit() {
      if (quitting) return quitting;
      const fn = take;
      const done = flush;
      take = null;
      flush = null;
      if (!fn) return Promise.resolve();
      let pending = null;
      try {
        pending = fn();
      } catch {
        pending = null;
      }
      quitting = within(pending, wait).then(() => (done ? within(done(), uploadWait) : null)).then(() => {
        quitting = null;
      });
      return quitting;
    },
    /** Takes the last moment (once), then `end()`. Resolves when `end` ran. */
    close(end) {
      if (closing) return closing.then(() => {}); // (a second click while the state comes: one close)
      const fn = take;
      take = null;
      let pending = null;
      try {
        pending = fn ? fn() : null;
      } catch {
        pending = null;
      }
      if (!pending || typeof pending.then !== 'function') {
        end();
        return Promise.resolve();
      }
      let timer = null;
      const timeout = new Promise((res) => {
        timer = setTimer(res, wait);
      });
      closing = Promise.race([Promise.resolve(pending).catch(() => null), timeout]).then(() => {
        clearTimer(timer);
        closing = null;
        end();
      });
      return closing;
    },
  };
}
