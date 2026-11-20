// souldew – desktop app shell (macOS, Windows and Linux).
// Starts the local server in-process on a free port and shows the UI in a native window.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, session, powerSaveBlocker, screen, safeStorage } from 'electron';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync } from 'node:fs';
import { setupUpdater } from './updater.mjs';
import { appImageFromEnv, appImageRelaunch, autoCheckOn } from './update-core.mjs';
import { applyInstallerChoices } from './installerchoices.mjs';
import { writeFileAtomic } from '../server/lib/fsutil.mjs';
import { RENDERER_COOKIE } from '../server/lib/guard.mjs';
import { randomBytes } from 'node:crypto';
import { grantPicked } from '../server/lib/grants.mjs';
import { chromiumSwitches, startDecision, crashDecision, gpuInfoSummary, safeGraphicsRequested, withoutSafeGraphics } from '../shared/gpu.mjs';
import { sameOrigin, safeExternalUrl, subframeNavigationAllowed, permissionAllowed, isTrustedIpcSender, titleBarColors, initialWindowSize, signInUrl } from './guards.mjs';
import { appLang, textsFor } from './texts.mjs';
import { EDITION } from '../shared/edition.mjs';
import { validUiScale, fitUiScale, windowChromeAt } from '../shared/uiscale.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// An installed app takes no account service, dev pack or dev key from the environment (server/app.mjs DEV_SWITCHES –
// the server drops them as well): only development (`npm run app`) and tests may point it elsewhere.
if (app.isPackaged) for (const k of ['SLS_ACCOUNTS_URL', 'SLS_PLUS_DEV_PACK', 'SLS_PLUS_DEV_KEY', 'SLS_ACCOUNTS_DEV_ENT_KEY']) delete process.env[k];
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const LINUX = process.platform === 'linux';
app.setName(EDITION.name);
// Windows: the same id as the installer's shortcuts (package.json → build.appId), so the taskbar groups the window
// with a pinned shortcut and shows the app's own name and icon.
if (WIN) app.setAppUserModelId(EDITION.appId);
// This build's own data folder (shared/edition.mjs), never the official app's "SoulLink Studio" one: runs, saves,
// settings and the web storage stay apart, so both apps can be installed side by side. (macOS: ~/Library/Application
// Support/<folder>, Windows: %APPDATA%\<folder>, Linux: ~/.config/<folder> – $XDG_CONFIG_HOME.)
// An explicit --user-data-dir (tests, a second profile) still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), EDITION.dataFolder));
// Boot chime + emulator audio without a prior click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The game must keep running when the window is covered by another app: without these Chromium treats an
// occluded window as hidden and stops drawing it – the emulator, live tracking and the partner's picture freeze.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Writable data lives in the data folder (see above); bundled tools sit next to the code.
process.env.SLS_DATA_DIR = app.getPath('userData');
process.env.SLS_TOOLS_DIR = app.isPackaged ? join(process.resourcesPath, 'tools') : join(here, '..', 'tools');
// Where "Search my Mac / PC" looks first: the real Downloads / Desktop / Documents folders (Windows may have moved
// them to OneDrive or another drive, Linux names them per language in ~/.config/user-dirs.dirs – Electron knows both).
process.env.SLS_USER_DIRS = JSON.stringify(['downloads', 'desktop', 'documents'].map((k) => {
  try {
    return app.getPath(k);
  } catch {
    return null;
  }
}).filter(Boolean));

// A second start only brings the running window to the front (second-instance below) – it must not boot a server
// and a window of its own while app.quit() is still on its way.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

// config.json in the data folder – the file the server reads and writes (server/lib/paths.mjs CONFIG_PATH with
// SLS_DATA_DIR = userData). The graphics backend has to be read from it here, before the app is ready.
const CONFIG_FILE = join(app.getPath('userData'), 'config.json');
function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
/** t(key, english) in the app language (electron/texts.mjs) – after `ready` (the system language comes from Electron). */
const dictionaries = new Map();
function mainTexts() {
  const lang = appLang(readConfig().lang, app.getLocale());
  if (!dictionaries.has(lang)) dictionaries.set(lang, textsFor(lang, join(here, '..', 'web', 'i18n')));
  return dictionaries.get(lang);
}
function patchConfig(patch) {
  if (!patch) return;
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileAtomic(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  } catch (e) {
    console.warn('writing config.json failed:', e.message);
  }
}

// Windows: what the player ticked on the installer's privacy page ("playing now", automatic update check) – into
// config.json once, before the update check and the local server read it (electron/installerchoices.mjs). A silent
// install (the in-app update) leaves no choices, so it changes nothing.
if (primary) {
  const applied = applyInstallerChoices({ dir: app.getPath('userData'), readConfig, patchConfig });
  if (applied) console.log('installer choices applied:', JSON.stringify(applied));
}

// Graphics backend (Settings › General, shared/gpu.mjs) plus the power-user flags from SOULDEW_CHROMIUM_FLAGS. Only
// the first instance counts its start – a second one quits right away. A start that never shows the window with a
// chosen backend is remembered (gpuStart); after a few of them the backend goes back to "Automatic".
// A safe start (--safe-graphics, shared/gpu.mjs) draws without the graphics card and leaves the setting and its start
// count alone: it is how a player whose window stays blank gets to Settings to pick another backend.
const gpu = { backend: 'auto', switches: [], pending: false, safe: safeGraphicsRequested(process.argv, process.env) };
if (primary) {
  if (gpu.safe) {
    app.disableHardwareAcceleration();
  } else {
    const { backend, patch } = startDecision(readConfig(), process.platform);
    patchConfig(patch);
    gpu.backend = backend;
    gpu.pending = backend !== 'auto';
  }
  gpu.switches = chromiumSwitches({ backend: gpu.backend, platform: process.platform, envFlags: process.env.SOULDEW_CHROMIUM_FLAGS || '', safe: gpu.safe });
  for (const [name, value] of gpu.switches) {
    if (value == null) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
}
/** The window showed (or the start failed for another reason): this start doesn't count against the backend. */
function gpuStartOk() {
  if (!gpu.pending) return;
  gpu.pending = false;
  patchConfig({ gpuStart: null });
}
// A GPU process that keeps crashing with a chosen backend: the next start uses "Automatic" (and says so once). Only
// while the setting still is the backend this session runs with – a newer choice of the user stays.
let gpuCrashes = 0;
// Every child process that went away, with the time (for "Save diagnostics": a GPU process restart takes the game's
// graphics context and, with it, its sound – the emulator then re-inits its audio in a new AudioContext).
const goneLog = [];
app.on('child-process-gone', (e, details) => {
  goneLog.push({ at: new Date().toISOString(), type: details?.type ?? null, reason: details?.reason ?? null, exitCode: details?.exitCode ?? null });
  if (goneLog.length > 20) goneLog.shift();
  if (details?.type !== 'GPU' || details.reason === 'clean-exit' || gpu.safe) return;
  gpuCrashes++;
  console.warn(`GPU process gone (${details.reason}, ${gpuCrashes}×)`);
  const patch = crashDecision(gpu.backend, gpuCrashes);
  if (patch && readConfig().gpuBackend === gpu.backend) patchConfig(patch);
});

let win = null;
let serverUrl = null;
let goOffline = null; // the souldew account's "I'm offline now" (server/lib/accounts) – awaited once before quitting

async function boot() {
  const { startServer } = await import('../server/app.mjs');
  // A fixed port keeps the page origin stable, so localStorage and EmulatorJS' IndexedDB survive
  // restarts; only if it's taken fall back to a random one.
  // the window's per-launch secret for the account and souldew+ routes (server/lib/guard.mjs rendererSecretError): an
  // HttpOnly, SameSite=Strict cookie in the window's own cookie jar – the server never serves it, so another program on
  // this computer that talks HTTP to 127.0.0.1 can't learn it
  const rendererSecret = randomBytes(32).toString('base64url');
  // deferAccount: the saved sign-in (and with it the keychain) only once the window is open – never on the way to it
  const accountHelpers = { secureStore, openExternal: openSignIn, focus: focusWindow, packaged: app.isPackaged, rendererSecret, deferAccount: true };
  const started = await startServer({ port: EDITION.port, ...accountHelpers }).catch((e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    return startServer({ port: 0, ...accountHelpers });
  });
  serverUrl = started.url;
  goOffline = started.goOffline;
  await session.defaultSession.cookies.set({ url: serverUrl, name: RENDERER_COOKIE, value: rendererSecret, httpOnly: true, sameSite: 'strict', path: '/' });
  createWindow();
  started.loadAccount(); // in the background: the page shows "signed out" until it is done
}

/**
 * The souldew account's tokens are kept only where the OS encrypts them (server/lib/accounts/store.mjs): macOS Keychain,
 * Windows DPAPI, the Secret Service / KWallet on Linux. Electron's "basic_text" fallback on a Linux desktop without a
 * keyring is plain text in disguise – that counts as no keychain (the session then lives in memory only).
 * The store asks only when there is a saved sign-in to read or a sign-in to keep – never at start for a player who
 * isn't signed in. On macOS the keychain is read with the async API: Chromium reads it on a worker thread, so a
 * keychain prompt (an unsigned build after an update is a "new app" to the item) never freezes the app while it is
 * open, and Electron asks only once per launch. Same key, same "v10" format as the sync API. Windows (DPAPI never
 * prompts) and Linux keep the sync API and its backend check.
 */
const secureStore = MAC
  ? {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptStringAsync(text),
      decrypt: async (buf) => (await safeStorage.decryptStringAsync(buf)).result,
    }
  : {
      available: () => {
        if (!safeStorage.isEncryptionAvailable()) return false;
        if (LINUX && typeof safeStorage.getSelectedStorageBackend === 'function') return !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend());
        return true;
      },
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buf) => safeStorage.decryptString(buf),
    };
/** "Sign in with Discord": the system browser at the accounts service (guards.mjs signInUrl: https, or a local test service). */
function openSignIn(url) {
  const safe = signInUrl(url);
  if (!safe) throw new Error('not a sign-in address');
  shell.openExternal(safe);
}
/** The browser handed the sign-in back: the app comes forward. */
function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * The window frame per platform. macOS: the page reaches under the title bar, traffic lights inset at the top left.
 * Windows: likewise, with the minimize / maximize / close buttons drawn by Windows over the top right corner in the
 * app's colours (titleBarOverlay; the page keeps that corner free and makes the top strip draggable). There is no
 * visible menu bar on Windows – the menu's keyboard shortcuts still work. Linux: the desktop's own frame and title
 * bar (window decorations differ between GNOME, KDE, Steam Deck's desktop mode … and X11 / Wayland, so the app doesn't
 * draw its own); the menu bar stays hidden until Alt is pressed. The page needs no room for window buttons there
 * (styles.css .platform-linux).
 */
function windowChrome(z = 1) {
  const c = windowChromeAt(z);
  if (MAC) return { titleBarStyle: 'hiddenInset', trafficLightPosition: c.lights };
  if (WIN) return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1c1b21', symbolColor: '#ebe6da', height: c.titleBar } };
  return { autoHideMenuBar: true };
}

/**
 * Interface size (Settings › General, shared/uiscale.mjs): the window's zoom. `chosen` is config.json's uiScale (the page
 * saves it through the server and tells the window at once); `applied` is what the window shows – the chosen size, or a
 * smaller one while the window is too small for it (fitUiScale), back up when it grows. The traffic lights / the Windows
 * title bar buttons move and grow with it, so the page's title strip still fits around them.
 */
const ui = { chosen: 1, applied: 1, sent: '' };
function uiState() {
  let display = null;
  try {
    const d = screen.getDisplayMatching(win.getBounds());
    display = { w: d.size.width, h: d.size.height, scale: d.scaleFactor };
  } catch {
    // no display information
  }
  const [w, h] = win ? win.getContentSize() : [0, 0];
  return { chosen: ui.chosen, applied: ui.applied, fit: fitUiScale(1.75, { w, h }), display, win: { w, h } };
}
let uiTimer = null;
function applyUiScale() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const z = fitUiScale(ui.chosen, { w, h });
  if (z !== ui.applied) {
    ui.applied = z;
    win.webContents.setZoomFactor(z);
    const c = windowChromeAt(z);
    if (MAC) win.setWindowButtonPosition?.(c.lights);
    if (WIN) win.setTitleBarOverlay({ height: c.titleBar });
  }
  // (the page hears it once the size settles – resizing sends a stream of these)
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    if (!win) return;
    const st = uiState();
    const key = JSON.stringify(st);
    if (key === ui.sent) return;
    ui.sent = key;
    send('ui-scale', st);
  }, 200);
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  // Never larger than the screen: the Steam Deck's is 1280×800, smaller than the window's usual size.
  let workArea = null;
  try {
    workArea = screen.getPrimaryDisplay().workAreaSize;
  } catch {
    // no display information – the usual size
  }
  const size = initialWindowSize(workArea);
  ui.chosen = validUiScale(readConfig().uiScale);
  ui.applied = fitUiScale(ui.chosen, { w: size.width, h: size.height });
  ui.sent = '';
  win = new BrowserWindow({
    ...size,
    title: EDITION.name,
    backgroundColor: '#1b1a1f',
    ...windowChrome(ui.applied),
    // the window / taskbar icon when running from source (`npm run app`) – and always on Linux, where X11 window
    // managers take it from the window (a packaged app elsewhere uses the icon of its .exe / .app)
    ...((!app.isPackaged && !MAC) || LINUX ? { icon: join(here, '..', 'build', 'icon.png') } : {}),
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep the emulator and live sync running when the window is behind others
      zoomFactor: ui.applied, // the interface size (above) from the first picture on
    },
  });
  // a window too small for the chosen interface size shows a smaller one; the page hears the screen for its hint
  win.on('resize', applyUiScale);
  win.on('moved', applyUiScale);
  // (Chromium keeps the zoom per address – a reload keeps it, this makes sure)
  win.webContents.on('did-finish-load', () => win?.webContents.setZoomFactor(ui.applied));
  win.once('ready-to-show', () => {
    gpuStartOk();
    win.show();
    applyUiScale(); // (the content size is known now – on Linux the frame takes some of the window's)
  });
  // Window fullscreen (macOS: green button / ⌃⌘F, Windows / Linux: F11): the page folds the side rail away
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));
  win.webContents.on('did-finish-load', () => send('fullscreen', win.isFullScreen()));
  win.loadURL(serverUrl);
  // External links open in the default browser, never inside the app – and only https links. The app never
  // opens a second window of its own (it would get the preload bridge), so new windows are always denied.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  // Origin comparison, not startsWith: 'http://localhost:47390@evil.com/' starts with the app URL.
  win.webContents.on('will-navigate', (e) => {
    if (sameOrigin(e.url, serverUrl)) return;
    e.preventDefault();
    openExternalSafe(e.url);
  });
  // The emulator iframe (and any other subframe) stays on the app origin; it never opens anything outside.
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || subframeNavigationAllowed(e.url, serverUrl)) return;
    e.preventDefault();
  });
  // A server-side redirect must not leave the app origin either (main frame or iframe).
  win.webContents.on('will-redirect', (e) => {
    if (sameOrigin(e.url, serverUrl)) return;
    e.preventDefault();
  });
  // Closing the window (or quitting – Cmd+Q / Alt+F4 close it too) while the game has progress since the last
  // in-game save asks first. The page reports that state with its texts in the UI language.
  win.webContents.on('did-navigate', () => {
    unsaved = null; // a reloaded page reports again once its game runs
  });
  win.on('close', (e) => {
    if (closeOk || !unsaved) return;
    e.preventDefault();
    if (asking) return;
    asking = true;
    const u = unsaved;
    dialog.showMessageBox(win, { type: 'warning', buttons: [u.keep, u.quit], defaultId: 0, cancelId: 0, message: u.title, detail: u.text })
      .then(({ response }) => {
        if (response !== 1) {
          app.emit('sls-quit-cancelled'); // e.g. a pending update install must not start (electron/updater.mjs)
          return;
        }
        closeOk = true;
        app.quit();
      })
      .finally(() => {
        asking = false;
      });
  });
  win.on('closed', () => {
    win = null;
  });
}

let unsaved = null; // { title, text, keep, quit } while the running game has unsaved in-game progress
let closeOk = false;
let asking = false;
/** IPC is only answered for the app window's main frame on the app origin (see guards.mjs). */
const trusted = (e) => isTrustedIpcSender(e, win?.webContents, serverUrl);
/** ipcMain.handle with the sender check: anything else gets an error instead of the handler. */
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!trusted(e)) throw new Error('Not allowed');
  return fn(e, ...args);
});
const openExternalSafe = (url) => {
  const safe = safeExternalUrl(url);
  if (safe) shell.openExternal(safe);
};

ipcMain.on('unsaved', (e, info) => {
  if (!trusted(e)) return;
  const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  const u = info && typeof info === 'object' ? { title: str(info.title, 200), text: str(info.text, 1000), keep: str(info.keep, 60), quit: str(info.quit, 60) } : null;
  unsaved = u && u.title && u.keep && u.quit ? u : null;
});

// While a game runs the display stays on: playing with a controller, the OS sees no input and would dim and sleep
// mid-battle. (EmulatorJS asks for a screen wake lock itself – Electron has no permission for it.)
let awake = null;
ipcMain.on('playing', (e, on) => {
  if (!trusted(e)) return;
  if (on && awake === null) awake = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && awake !== null) {
    powerSaveBlocker.stop(awake);
    awake = null;
  }
});

const send = (channel, ...args) => win?.webContents.send(channel, ...args);

// The menu bar speaks the app's language: the page sends its labels once it knows the language, and on every change.
ipcMain.on('menu-labels', (e, labels) => {
  if (!trusted(e) || !labels || typeof labels !== 'object') return;
  buildMenu(labels);
});

// Windows: the window buttons take the colour of the page's top edge (it changes with Settings › Appearance).
ipcMain.on('titlebar-colors', (e, colors) => {
  if (!trusted(e) || !WIN || !win) return;
  const c = titleBarColors(colors);
  if (c) win.setTitleBarOverlay({ ...c, height: windowChromeAt(ui.applied).titleBar });
});

// The interface size: `v` a size to show from now on (the page saved it in config.json), nothing = just ask. Answers with
// what the window shows and the screen it is on (shared/uiscale.mjs suggestUiScale).
handle('ui-scale', (e, v) => {
  if (v !== undefined) ui.chosen = validUiScale(v);
  applyUiScale();
  return uiState();
});

/**
 * labels: the page's texts in the app language (see 'menu-labels'); until the page has sent them the same texts from
 * its dictionaries (mainTexts).
 * macOS gets the usual app menu; Windows has no visible menu bar (titleBarOverlay), so there the menu only carries
 * the keyboard shortcuts (Ctrl instead of ⌘, F11 for fullscreen) – Settings and Quit move into "File". Linux: the same
 * menu as Windows, hidden until Alt is pressed (autoHideMenuBar).
 */
function buildMenu(labels = {}) {
  const l = (key, fallback) => (typeof labels[key] === 'string' && labels[key] ? labels[key].slice(0, 80) : fallback);
  const t = mainTexts();
  const nav = (route) => () => send('navigate', route);
  const emu = (action) => () => send('emu', action);
  // The emulator's shortcuts are the player's (Settings › Controls – any key, or none): the page sends them as
  // accelerators and handles the keys itself, so the menu only shows them – it never takes a key from the game.
  const keys = labels.keys && typeof labels.keys === 'object' ? labels.keys : {};
  const shown = (id, fallback) => {
    const k = Object.hasOwn(keys, id) ? keys[id] : fallback;
    return typeof k === 'string' && /^(?:(?:Cmd|Ctrl|Alt|Shift)\+){0,4}(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Tab|Return|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|num[0-9]|numadd|numsub|nummult|numdiv|numdec|[;=,\-./`[\]\\'])$/.test(k)
      ? { accelerator: k, registerAccelerator: false } : {};
  };
  const settings = { label: l('settings', t('menu.settings', 'Settings …')), accelerator: 'CmdOrCtrl+,', click: nav('settings') };
  const template = [
    ...(MAC ? [{
      label: EDITION.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settings,
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: l('file', t('menu.file', 'File')),
      submenu: [
        { label: l('addGames', t('menu.addGames', 'Add games …')), accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'add-games') },
        { label: l('revealLibrary', MAC ? t('menu.revealLibrary', 'Show library folder in Finder') : WIN ? t('menu.revealLibraryWin', 'Show library folder in Explorer')
          : t('menu.revealLibraryLinux', 'Show library folder in the file manager')), click: () => send('menu', 'reveal-library') },
        { type: 'separator' },
        // Windows: no Ctrl+W – it would close the window and with it the app; Alt+F4 does that the Windows way
        ...(MAC ? [{ role: 'close' }] : [settings, { type: 'separator' }, { role: 'quit', label: l('quit', t('menu.quit', 'Quit')) }]),
      ],
    },
    { role: 'editMenu' },
    // the interface size (shared/uiscale.mjs): the page handles the keys – while a game fills the window a shortcut of
    // Settings › Controls on the same key (⌘+ / ⌘− are the game speed) goes first, so the menu only shows them
    {
      label: l('view', t('menu.view', 'View')),
      submenu: [
        { label: l('uiBigger', t('menu.uiBigger', 'Bigger interface')), accelerator: 'CmdOrCtrl+Plus', registerAccelerator: false, click: () => send('menu', 'ui-in') },
        { label: l('uiSmaller', t('menu.uiSmaller', 'Smaller interface')), accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => send('menu', 'ui-out') },
        { label: l('uiReset', t('menu.uiReset', 'Interface at 100 %')), accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => send('menu', 'ui-reset') },
      ],
    },
    {
      label: l('go', t('menu.go', 'Go')),
      submenu: [
        { label: l('library', t('nav.library', 'Library')), accelerator: 'CmdOrCtrl+1', click: nav('library') },
        { label: l('soullink', t('nav.soullink', 'SoulLink')), accelerator: 'CmdOrCtrl+2', click: nav('soullink') },
        { label: l('nuzlocke', t('nav.nuzlocke', 'Nuzlocke')), accelerator: 'CmdOrCtrl+3', click: nav('nuzlocke') },
        { label: l('link', t('nav.link', 'Connection')), accelerator: 'CmdOrCtrl+4', click: nav('link') },
        { label: l('stream', t('nav.stream', 'Stream')), accelerator: 'CmdOrCtrl+5', click: nav('stream') },
      ],
    },
    {
      label: l('emulator', t('menu.emulator', 'Emulator')),
      submenu: [
        { label: l('pause', t('keys.pause', 'Pause / resume')), ...shown('pause', 'P'), click: emu('pause') },
        { label: l('turbo', t('menu.turbo', 'Toggle turbo')), ...shown('turbo', 'T'), click: emu('turbo') },
        { label: l('faster', t('menu.faster', 'Faster')), ...shown('faster', MAC ? 'Cmd+Plus' : 'Ctrl+Plus'), click: emu('faster') },
        { label: l('slower', t('menu.slower', 'Slower')), ...shown('slower', MAC ? 'Cmd+-' : 'Ctrl+-'), click: emu('slower') },
        { type: 'separator' },
        { label: l('quicksave', t('menu.quicksave', 'Quick save')), ...shown('quicksave', 'F5'), click: emu('quicksave') },
        { label: l('quickload', t('menu.quickload', 'Quick load')), ...shown('quickload', 'F8'), click: emu('quickload') },
        { label: l('screenshot', t('keys.screenshot', 'Screenshot')), ...shown('screenshot', 'F12'), click: emu('screenshot') },
        { label: l('mute', t('keys.mute', 'Sound on/off')), ...shown('mute', 'M'), click: emu('mute') },
        { type: 'separator' },
        { label: l('fullscreen', t('menu.fullscreen', 'Fullscreen')), accelerator: MAC ? 'Ctrl+Cmd+F' : 'F11', role: 'togglefullscreen' },
      ],
    },
    ...(MAC ? [{ role: 'windowMenu' }] : []),
    {
      role: 'help',
      submenu: [
        { label: l('shortcuts', t('menu.shortcuts', 'Keyboard shortcuts')), accelerator: 'CmdOrCtrl+/', click: () => send('menu', 'shortcuts') },
        { label: l('guide', t('menu.guide', 'Guide')), click: nav('guide') },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

handle('pick-files', async (e, opts) => {
  if (!opts || typeof opts !== 'object') opts = {};
  const t = mainTexts();
  const r = await dialog.showOpenDialog(win, {
    title: typeof opts.title === 'string' && opts.title ? opts.title.slice(0, 200) : t('lib.addTitle', 'Add games to souldew'),
    properties: opts.folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    filters: opts.folder ? undefined : [
      { name: t('dialog.fileTypes', 'ROMs, patches & archives'), extensions: ['gb', 'gbc', 'sgb', 'gba', 'nds', '3ds', 'cci', 'cxi', 'cia', '3dsx', 'zcci', 'zcxi', 'z3dsx', 'zip', 'xdelta', 'vcdiff', 'bps', 'ups', 'ips', 'json'] },
    ],
  });
  if (r.canceled) return [];
  // What the player picked here may be imported / included by the library (server/lib/grants.mjs) – registered from the
  // dialog's own result in this process, so the page can't add paths of its choosing.
  grantPicked(r.filePaths, { folder: !!opts.folder });
  return r.filePaths;
});
handle('reveal', (e, path) => {
  // an absolute local path of this platform (/Users/… on macOS, C:\… on Windows, /home/… on Linux) – no network or device paths
  // (\\server\…, \\?\…, \\.\…): showing one would make Windows contact that server or open a device
  if (typeof path === 'string' && path.length < 4096 && isAbsolute(path) && !/^[\\/]{2}/.test(path) && !path.includes('\0')) shell.showItemInFolder(path);
});
handle('open-external', (e, url) => openExternalSafe(url));
handle('app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged, dataDir: app.getPath('userData'), platform: process.platform }));
// The graphics backend this session runs with (Settings compares it with the saved one) and, for "Save diagnostics",
// the switches, Chromium's feature status and the graphics cards with their drivers.
handle('gpu-info', async () => {
  let info = null;
  try {
    info = gpuInfoSummary(await app.getGPUInfo('basic'));
  } catch {
    // no GPU information (e.g. the GPU process is down)
  }
  let featureStatus = null;
  try {
    featureStatus = app.getGPUFeatureStatus();
  } catch {}
  return { backend: gpu.backend, safe: gpu.safe, switches: gpu.switches.map(([n, v]) => (v == null ? `--${n}` : `--${n}=${v}`)), featureStatus, info, processesGone: goneLog.slice() };
});
// "Restart now" (e.g. after changing the graphics backend): quit as usual – the unsaved-progress question may still
// keep the game open – and start again once quitting is final. Linux: the AppImage file, as the updater does. After a
// safe start the new one is a normal start (the same arguments without --safe-graphics; SOULDEW_SAFE_GRAPHICS isn't
// passed on either).
let relaunching = false;
handle('relaunch', () => {
  relaunching = true;
  app.quit();
});
app.on('sls-quit-cancelled', () => {
  relaunching = false;
});
app.on('will-quit', () => {
  if (!relaunching) return;
  const appImage = app.isPackaged && LINUX ? appImageFromEnv() : null;
  if (gpu.safe) delete process.env.SOULDEW_SAFE_GRAPHICS;
  const argv = gpu.safe ? withoutSafeGraphics(process.argv) : process.argv;
  if (appImage) app.relaunch(appImageRelaunch(appImage, argv));
  else app.relaunch(gpu.safe ? { args: argv.slice(1) } : undefined);
});

// Quitting for real (every window is closed, nothing can call it off any more): tell the account service the player is
// offline before the process ends – otherwise friends see them online for another 3 minutes. Every will-quit listener
// (the relaunch above, the updater's installer) has run in this same round; the process then ends with app.exit(),
// which keeps a planned relaunch and doesn't emit will-quit again. Bounded: goOffline gives up after 1.5 s and returns
// at once when signed out or invisible; OFFLINE_WAIT_MS is the outer limit.
const OFFLINE_WAIT_MS = 2000;
let offlineSent = false;
app.on('will-quit', (e) => {
  if (offlineSent || !goOffline) return;
  offlineSent = true;
  e.preventDefault();
  let timer = null;
  const timeout = new Promise((res) => { timer = setTimeout(res, OFFLINE_WAIT_MS); });
  Promise.race([Promise.resolve().then(() => goOffline()).catch(() => {}), timeout]).finally(() => {
    clearTimeout(timer);
    app.exit(0);
  });
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());

// Quitting with a game running: the anonymous "playing now" count (server/lib/presence.mjs) hears "stopped" first –
// at most 1.5 s, offline it gives up silently. Called off ("keep playing"): the next quit tells it again.
let presenceStopped = false;
app.on('before-quit', (e) => {
  if (presenceStopped || !serverUrl) return; // (no server, no game)
  presenceStopped = true;
  e.preventDefault();
  import('../server/lib/presence.mjs').then((m) => m.stopPresence(1500)).catch(() => {}).finally(() => app.quit());
});
app.on('sls-quit-cancelled', () => {
  presenceStopped = false;
});
app.on('activate', () => {
  if (!win && serverUrl) createWindow();
});

/**
 * Permissions: only what the app uses (guards.mjs APP_PERMISSIONS: fullscreen, clipboard write), only for the
 * app origin. Everything else – camera, microphone, notifications, geolocation, MIDI, HID/USB/serial,
 * pointer lock, external protocols … – is denied, for requests and for permission queries alike.
 */
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permissionAllowed(permission, details?.requestingUrl || wc?.getURL?.() || '', serverUrl));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, serverUrl));
  ses.setDevicePermissionHandler(() => false);
}

app.whenReady().then(async () => {
  if (!primary) return;
  setupPermissions();
  buildMenu();
  setupUpdater({ send, trusted, autoCheck: () => autoCheckOn(readConfig()) });
  try {
    await boot();
  } catch (e) {
    gpuStartOk(); // not the graphics backend's fault – it doesn't count as a failed start
    const t = mainTexts();
    dialog.showErrorBox(t('app.startFailed', 'souldew couldn’t start'), String(e?.stack || e));
    app.quit();
  }
});
