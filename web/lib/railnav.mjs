// The rail's order (owner's choice "B – by use", app.mjs): the three entries you play with every day, a line, Friends
// and Trophies, a line, Connection and Stream – and at the foot, in one row, souldew+ (where "Buy me a coffee" was) with
// Settings and Help as icon buttons. Nothing is left out; signed out there is no Friends entry. Pure, so
// test/railnav.test.mjs checks it without a page.

export const NAV_GROUPS = [['library', 'soullink', 'nuzlocke'], ['friends', 'trophies'], ['link', 'stream']];
/** The foot row's sections after souldew+ (icon buttons, labelled for screen readers and in a tooltip). */
export const FOOT_SECTIONS = ['settings', 'guide'];
/** Every page the rail reaches – a section with its own route (#/<id>). */
export const RAIL_ROUTES = [...NAV_GROUPS.flat(), 'plus', ...FOOT_SECTIONS];

/** The groups as they are drawn: only the entries there are (no Friends signed out), no empty group. */
export function railGroups(available) {
  const has = available instanceof Set ? (id) => available.has(id) : () => true;
  return NAV_GROUPS.map((ids) => ids.filter(has)).filter((ids) => ids.length);
}
