// The project's public addresses – shown in the sidebar, in Settings › About and on the stream overlays' coffee
// pop-up (shared/coffee.mjs). web/lib/links.mjs re-exports them for the app. They live in shared/edition.mjs.
import { EDITION } from './edition.mjs';

export const LINKS = { ...EDITION.links };
