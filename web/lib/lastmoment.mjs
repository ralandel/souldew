// The game's last moment before it is closed from the UI ("Close game", switching game or run): the play view takes
// "where you left off" and the last battery save while its player is still there – and the session ends once the
// state's bytes are in hand. The fast player (lib/nativeplayer.mjs) and the 3DS player (lib/ctrplayer.mjs) answer
// getState through their frame: taken only in the play view's cleanup, the frame was gone before the answer came, and
// a game closed in them never had a "where you left off" of that moment.

/** The longest a close waits for the player's state (a DS state is ≈ 20 MB; a stuck player must not keep the game open). */
export const LAST_STATE_WAIT_MS = 3000;

/**
 * One per app. The running play view registers what it does in the game's last moment (`set` – it returns the state
 * promise, or null when there is nothing to take); `close(end)` runs that first and `end` once the state arrived (or
 * after `wait` ms) – right away when no game is registered. Asked again while waiting, it waits for the same close.
 */
export function lastMoment({ wait = LAST_STATE_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let take = null;
  let closing = null;
  return {
    /** The running game's last moment; returns the function that takes it away again (the play view's cleanup). */
    set(fn) {
      take = fn;
      return () => {
        if (take === fn) take = null;
      };
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
