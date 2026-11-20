// Settings: which sections there are, which settings live in which section, and how the settings search finds them.
// Pure data and functions (no DOM, no t()) – the view (views/settings.mjs) renders each entry as one <Item id=…>, and
// test/settings.test.mjs checks that every entry is rendered and every old setting still has its entry.
//
// An entry's `keys` are the i18n keys of its label and hint: the search looks through their English text and their
// text in the current language. `kw` are extra words to find it by – synonyms, and the word players use in the other
// app languages (searching "gamepad", "vorspulen" or "manette" should land on the right setting either way).
import { EDITION } from '../../shared/edition.mjs';

/** Sections in tab order. `hidden`: wired up, but not shown (Account in a build without the souldew account). */
export const SECTIONS = [
  { id: 'general' },
  { id: 'play' },
  { id: 'controls' },
  { id: 'games' },
  { id: 'online' },
  { id: 'account', hidden: !EDITION.accounts },
  { id: 'about' },
];

export const VISIBLE_SECTIONS = SECTIONS.filter((s) => !s.hidden).map((s) => s.id);

const TURBO = 'turbo fast forward fast-forward fastforward speed speed up vorspulen schnellvorlauf geschwindigkeit avance rapide vitesse avance rápido velocidad avanti veloce velocità';
const PIC = 'picture image display video screen bild anzeige écran pantalla imagen immagine schermo';

export const SETTINGS = [
  // General
  { id: 'language', section: 'general', keys: ['set.language'], kw: 'translation translate locale sprache langue idioma lingua english deutsch français español italiano' },
  { id: 'name', section: 'general', keys: ['set.name'], kw: 'player name nickname username spielername nom pseudo nombre jugador nome giocatore' },
  { id: 'ui-scale', section: 'general', keys: ['set.uiScale', 'set.uiScaleHint'],
    kw: 'interface ui size scale scaling zoom bigger smaller larger text font readable small tiny large screen big monitor 4k 1440p high resolution dpi hidpi '
      + 'oberfläche größe skalierung vergrößern verkleinern schrift text lesbar bildschirm interface taille échelle agrandir texte écran interfaz tamaño escala agrandar texto pantalla dimensione scala ingrandire testo schermo' },
  { id: 'animations', section: 'general', keys: ['set.boot'], kw: 'boot intro start-up startup cartridge animation motion reduce motion' },
  { id: 'sounds', section: 'general', keys: ['set.soundsAll'], kw: 'audio chime ping notification sfx effects töne geräusche klänge sons sonidos suoni' },
  { id: 'tour', section: 'general', keys: ['set.replayOnboarding', 'fs.showAgain', 'wn.open'], kw: 'onboarding welcome intro tutorial first start first steps checklist whats new news 3.0 update neuigkeiten neu nouveautés novedades novità willkommen erste schritte bienvenue premiers pas bienvenida primeros pasos benvenuto primi passi' },
  { id: 'theme', section: 'general', keys: ['set.appearance', 'set.theme', 'set.themeText', 'theme.classic', 'theme.contrast', 'theme.deutan', 'theme.tritan'],
    kw: 'appearance colour color colors colours dark mode high contrast colour-blind colorblind color blind accessibility a11y design look darstellung farbe farbenblind kontrast couleur daltonien contraste color daltónico colore daltonico' },
  { id: 'skin', section: 'general', keys: ['skin.title', 'skin.note', 'skin.dark', 'skin.light'],
    kw: 'theme themes skin skins souldew+ plus look style light mode dark mode thema design aussehen hell dunkel thème apparence clair sombre tema aspecto claro oscuro aspetto chiaro scuro' },
  // Play
  { id: 'launch', section: 'play', keys: ['launch.title', 'launch.hint3', 'set.gameStart', 'hh.title', 'hh.dress'],
    kw: 'launch start startup start-up boot intro animation cartridge module slot souldew+ plus spielstart startanimation modul démarrage lancement inicio arranque avvio handheld device console skin wrap sticker stickers design designs gold clear holo rare quick handheld konsole gerät aufkleber sticker skin design console autocollant pegatina adesivo' },
  { id: 'full-turbo', section: 'play', keys: ['set.fullTurbo', 'set.fullTurboHint'], kw: `${TURBO} performance` },
  { id: 'speed-guard', section: 'play', keys: ['set.speedGuard', 'set.speedGuardHint'], kw: `${TURBO} slow lag stutter performance` },
  { id: 'turbo-max', section: 'play', keys: ['set.turboMax', 'set.turboMaxHint'], kw: `${TURBO} unlimited maximum` },
  { id: 'turbo-audio', section: 'play', keys: ['play.turboAudio', 'play.turboAudioHint', 'set.sound'],
    kw: `${TURBO} sound audio music mute crackle volume ton musik son musique sonido música suono musica` },
  { id: 'whole-pixels', section: 'play', keys: ['set.wholePixels', 'set.wholePixelsHint'], kw: `${PIC} pixel integer scaling sharp crisp blurry pixels` },
  { id: 'gb-look', section: 'play', keys: ['set.gbLook', 'set.gbLookHint'], kw: `${PIC} game boy gameboy gbc colour color palette green screen red blue yellow` },
  { id: 'ctr-scale', section: 'play', keys: ['set.ctrScale', 'set.ctrScaleHint', 'set.ctrFfHint'], kw: `${PIC} 3ds resolution upscale sharp hd auflösung résolution resolución risoluzione fast-forward hint` },
  { id: 'native', section: 'play', keys: ['set.native', 'set.nativeHint'], kw: 'fast player emulator melonds mgba sameboy libretro performance speed core schneller player lecteur rapide reproductor rápido' },
  { id: 'engine', section: 'play', keys: ['set.engine', 'set.engineHint'], kw: 'souldew engine beta trade battle link cable tausch kampf échange combat intercambio combate scambio lotta' },
  // Controls
  { id: 'keyboard', section: 'controls', keys: ['set.keyboard', 'set.controlsText2', 'ctl.presets', 'guide.shortcuts', 'ctl.sneakHint'],
    kw: 'keys keyboard key bindings keybindings remap rebind wasd arrows zqsd azerty tastatur tasten tastenbelegung clavier touches teclado teclas tastiera tasti '
      + `shortcut shortcuts hotkey hotkeys ${TURBO} pause screenshot quick save load state mute fullscreen reset kurzbefehl tastenkürzel raccourci atajo scorciatoia `
      + 'circle pad half tilt sneak walk slowly 3ds schleichen' },
  { id: 'controller', section: 'controls', keys: ['pad.title', 'pad.text', 'pad.use', 'pad.layouts', 'pad.sneak'],
    kw: 'gamepad game pad joystick joypad pad xbox playstation ps4 ps5 dualsense dualshock switch pro joy-con 8bitdo steam deck bluetooth usb bindings remap manette mando' },
  { id: 'pad-nav', section: 'controls', keys: ['pad.nav', 'pad.navHint'], kw: 'gamepad controller joystick navigate navigation menus couch big picture d-pad manette mando' },
  // Games
  { id: 'library', section: 'games', keys: ['set.library', 'set.libraryText', 'lib.reveal', 'set.addFolder'],
    kw: 'roms rom folder folders path location storage directory include scan ordner bibliothek dossier carpeta cartella' },
  { id: 'emulator-for', section: 'games', keys: ['set.useEmu', 'set.emuText', 'set.builtin', 'set.emulators'],
    kw: 'emulator external azahar mgba melonds built-in builtin system play with emulateur emulador emulatore' },
  { id: 'install', section: 'games', keys: ['set.install', 'set.emulators', 'set.mgbaScriptAgain'],
    kw: 'install download external emulator melonds mgba azahar script installieren installer instalar installare' },
  // Online
  { id: 'share-screen', section: 'online', keys: ['set.shareScreenAll', 'set.shareScreenHint'],
    kw: 'multiplayer partner players screen share sharing watch soullink stream bildschirm teilen écran partager pantalla compartir schermo condividere' },
  { id: 'discord', section: 'online', keys: ['live.title', 'live.codeLabel'], kw: 'discord live runs hall of fame bot connect link code share post' },
  { id: 'presence', section: 'online', keys: ['set.presence', 'set.presenceHint'], kw: 'playing now player count anonymous heartbeat privacy statistics discord spielen gerade anonym datenschutz joueurs anonyme jugadores anónimo giocatori anonimo' },
  { id: 'coffee-pop', section: 'online', keys: ['set.coffeePop', 'set.coffeePopHint', 'nav.stream'], kw: 'stream streaming obs overlay alerts coffee legendary twitch youtube' },
  // Account
  { id: 'account', section: 'account', keys: ['acct.title', 'acct.signIn', 'acct.handle', 'acct.friendCode', 'acct.signOut', 'acct.signOutAll'],
    kw: 'account sign in login log in discord profile handle friend code sign out log out konto anmelden abmelden compte connexion déconnexion cuenta iniciar sesión account accedi esci' },
  { id: 'account-privacy', section: 'account', keys: ['acct.privacy', 'acct.profileVis', 'acct.presenceVis', 'acct.showRuns', 'acct.showLocation', 'acct.askToJoin', 'acct.requestsFrom', 'acct.showOnThanks'],
    kw: 'privacy presence online offline appear offline invisible friends stats runs profile visible thank you thanks supporters wall danke unterstützer merci soutiens gracias grazie privatsphäre datenschutz confidentialité privacidad privacy' },
  { id: 'plus-show', section: 'account', keys: ['plusShow.title', 'plusShow.themes'], kw: 'souldew+ plus preview previews look see themes banners frames nameplates launch animations vorschau aperçu vista anteprima' },
  { id: 'plus', section: 'account', keys: ['acct.linkTitle', 'acct.linkEmail', 'acct.claimedDiscord', 'acct.unlink'], kw: 'souldew+ plus supporter membership buy me a coffee bmc donate link unlink email premium cosmetics banner frame mitgliedschaft' },
  { id: 'account-sessions', section: 'account', keys: ['acct.devices', 'acct.devicesText', 'acct.thisDevice'], kw: 'sessions devices signed in computers sign out device geräte sitzungen appareils sessions dispositivos sesiones dispositivi sessioni' },
  { id: 'account-data', section: 'account', keys: ['acct.dataTitle', 'acct.export', 'acct.delete'], kw: 'export download gdpr dsgvo data delete account remove rgpd datos dati' },
  // About
  { id: 'updates', section: 'about', keys: ['set.versionUpdates', 'upd.check', 'upd.auto', 'upd.autoHint'],
    kw: 'update updates version release download upgrade new version automatic automatically privacy offline aktualisierung automatisch datenschutz mise à jour automatique confidentialité actualización automática privacidad aggiornamento automatico privacy' },
  { id: 'backup', section: 'about', keys: ['set.backupOpen', 'set.backupMade'], kw: 'backup back up restore copy safety upgrade 3.0 sicherung datensicherung sauvegarde copia de seguridad copia di sicurezza' },
  { id: 'gpu', section: 'about', keys: ['set.gpu', 'set.gpuHint', 'set.trouble'],
    kw: 'graphics backend vulkan opengl direct3d d3d11 gpu graphics card driver stutter crackle blank window black screen grafik grafikkarte graphique gráfica grafica' },
  { id: 'ctr-renderer', section: 'about', keys: ['set.ctrRenderer', 'set.ctrRendererHint', 'set.trouble'],
    kw: '3ds renderer vulkan software graphics card driver crash stops grafik graphique gráfica grafica' },
  { id: 'diagnostics', section: 'about', keys: ['play.diag', 'play.diagHint', 'set.trouble'],
    kw: 'diagnostics diagnosis bug report log logs debug support problem error fehler diagnose diagnostic diagnóstico diagnostica' },
  { id: 'credits', section: 'about', keys: ['set.randomizer', 'set.data', 'set.emuCore', 'set.github', 'set.reportBug', 'rail.coffee'],
    kw: 'credits about randomizer java licence license pokeapi github source bug coffee donate support legal trademark' },
  { id: 'nag', section: 'about', keys: ['set.nag', 'set.nagHint'], kw: 'joke license licence shareware nag popup window' },
];

export const settingById = (id) => SETTINGS.find((s) => s.id === id) || null;

/** Lower case, accents and punctuation folded away: "Écran", "ecran" and "écran" all match. */
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[’'"“”„«»()[\]{}.,:;!?…/\\|*+]/g, ' ').replace(/\s+/g, ' ').trim();

/** The search's words (a query of only spaces has none). */
export const queryWords = (q) => norm(q).split(' ').filter(Boolean);

/** Every word somewhere in the text – words in any order, each one also inside a longer word ("pad" finds "gamepad"). */
export const matches = (words, hay) => words.length > 0 && words.every((w) => hay.includes(w));

/**
 * The text an entry is found by: its label and hint in English and in the current language, its keywords and its
 * section's name (both languages). `english` / `local`: key → text; `sectionName(id)` → [english, local].
 */
export function haystack(entry, { english = {}, local = {}, sectionName = () => [] } = {}) {
  const parts = [entry.kw, ...sectionName(entry.section)];
  for (const k of entry.keys) parts.push(english[k], local[k]);
  return norm(parts.filter(Boolean).join(' '));
}

/**
 * Which entries match the query, per section in tab order: [{ section, ids: [...] }], sections without hits left out.
 * `extra(id)`: more text for an entry (the view passes what it shows – emulator names, option labels …).
 * `available(id)`: whether the entry is on this computer at all (a Windows-only setting on a Mac is not).
 */
export function searchSettings(query, texts = {}, { extra = () => '', available = () => true, sections = VISIBLE_SECTIONS } = {}) {
  const words = queryWords(query);
  if (!words.length) return [];
  const out = [];
  for (const section of sections) {
    const ids = SETTINGS.filter((e) => e.section === section && available(e.id) && matches(words, `${haystack(e, texts)} ${norm(extra(e.id))}`)).map((e) => e.id);
    if (ids.length) out.push({ section, ids });
  }
  return out;
}

/**
 * The section and setting a Settings URL asks for (#/settings?s=play&f=turbo-audio). An unknown or hidden section
 * falls back to the setting's own section, then to the remembered tab, then to General – a deep link with only
 * `f=` still lands right.
 */
export function settingsRoute(params = {}, remembered = null) {
  const f = params.f && settingById(params.f) ? params.f : null;
  const ok = (s) => VISIBLE_SECTIONS.includes(s);
  const fromSetting = f ? settingById(f).section : null;
  let section = ok(params.s) ? params.s : ok(fromSetting) ? fromSetting : ok(remembered) ? remembered : VISIBLE_SECTIONS[0];
  // a setting asked for in another section than its own: its own wins (old links keep working when things move)
  if (f && fromSetting !== section && ok(fromSetting)) section = fromSetting;
  return { section, setting: f };
}

/** The URL parameters that open a setting (navigate('settings', settingsLink('turbo-audio'))). */
export function settingsLink(id) {
  const e = settingById(id);
  if (e) return { s: e.section, f: id };
  return VISIBLE_SECTIONS.includes(id) ? { s: id } : {};
}
