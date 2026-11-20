// "Leave with unsaved changes?" for the app's own screens (the profile editor): a screen registers a guard; when the
// route is about to change, the guard sees the new address and may hold the change (it then asks, and navigates
// itself once the player chooses to leave). app.mjs useRoute puts the old address back while a guard holds.
let guard = null;

/** fn(nextHash) → true holds the route change. Returns the function that removes this guard. */
export function setLeaveGuard(fn) {
  guard = typeof fn === 'function' ? fn : null;
  const mine = guard;
  return () => {
    if (guard === mine) guard = null;
  };
}

/** Does a guard hold the change to `nextHash`? A guard that throws never traps the player. */
export function leaveHeld(nextHash) {
  if (!guard) return false;
  try {
    return guard(nextHash) === true;
  } catch (e) {
    console.error(e);
    return false;
  }
}
