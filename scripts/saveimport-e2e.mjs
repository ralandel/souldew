// End-to-end check of "Import a save file" in the real app UI (Electron from node_modules, a scratch data folder,
// muted): the game's library entry has no save; the dialog is opened from the game's details, the file is picked, what
// the dialog says is kept, the save is imported – then the game is started in the play view and the check waits until
// the imported team is in the game's memory (the first Pokémon's bytes from the save, found in RAM after "Continue").
// With --other <file> it also checks the running-game guard (the dialog while the game runs, the server's refusal),
// a save of another game (the warning, "Import it anyway") and the Undo from the toast.
//
// With --run the save goes into a solo Nuzlocke of the game (built here, no randomizer) from the board's Files menu: the
// confirmation, the log line, and the save's Pokémon set aside rather than counted.
//
//   node scripts/saveimport-e2e.mjs --rom <game file> --save <save file> [--as dsv|rtc44] [--other <save>] [--run] --out <dir> [--show]
//
// The ROM's folder becomes the library (put the one game in a folder of its own). Never commit ROMs, saves or the
// screenshots.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);

if (!process.versions.electron) {
  const electron = (await import('electron')).default;
  const p = spawn(electron, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  p.on('exit', (c) => process.exit(c ?? 1));
} else {
  const { app, BrowserWindow } = await import('electron');
  const S = await import(pathToFileURL(join(root, 'shared', 'savefile.mjs')).href);
  const rom = resolve(opt('rom'));
  const savIn = resolve(opt('save'));
  const out = resolve(opt('out'));
  const data = join(out, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'E2E', libraryFolders: [dirname(rom)], bootAnimation: false, sounds: false, nativeCore: true, presence: false }));
  process.env.SLS_DATA_DIR = data;
  process.env.NO_OPEN = '1';
  app.commandLine.appendSwitch('mute-audio');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.setPath('userData', join(data, 'electron'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sha = (b) => createHash('sha1').update(b).digest('hex').slice(0, 12);
  const res = { rom: basename(rom), save: basename(savIn), notes: [], steps: [] };
  const step = (name, v) => {
    res.steps.push({ name, ...v });
    console.log(`  ${name}: ${JSON.stringify(v)}`);
  };

  /** The save as it goes in (--as dsv: DeSmuME's footer around it – the layout web/player.html writes for DeSmuME). */
  function asFile(raw, as) {
    if (as === 'dsv') {
      const txt = Buffer.from('|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:');
      const foot = Buffer.alloc(24);
      [raw.length, raw.length, 3, 3, raw.length, 0].forEach((v, i) => foot.writeUInt32LE(v, i * 4));
      return Buffer.concat([raw, txt, foot, Buffer.from('|-DESMUME SAVE-|')]);
    }
    if (as === 'rtc44') return Buffer.concat([raw, Buffer.alloc(44)]);
    return raw;
  }

  /** The first party Pokémon's bytes in a save (what the game copies into its memory when it continues). */
  function firstMon(u8, system) {
    const u32 = (o) => u8.readUInt32LE(o);
    if (system === 'gb') return u8.subarray(0x2f2c + 8, 0x2f2c + 8 + 44);
    if (system === 'gbc') return S.saveFamily(u8, 'gbc') === 'crystal' ? u8.subarray(0x2865 + 8, 0x2865 + 8 + 48) : u8.subarray(0x288a + 8, 0x288a + 8 + 48);
    if (system === 'gba') {
      let best = null;
      for (const slot of [0, 0xe000]) {
        const secs = [];
        let idx = -1;
        for (let i = 0; i < 14; i++) {
          const o = slot + i * 0x1000;
          if (u32(o + 0xff8) !== 0x08012025) break;
          secs[u8.readUInt16LE(o + 0xff4)] = o;
          idx = u32(o + 0xffc);
        }
        if (secs.length === 14 && (!best || idx > best.idx)) best = { secs, idx };
      }
      const frlg = u32(best.secs[0] + 0xac) === 1;
      const team = best.secs[1] + (frlg ? 0x38 : 0x238);
      return u8.subarray(team, team + 100);
    }
    // DS Gen 4 (HeartGold / SoulSilver: the General block, the newer of the two halves – its party at 0x98)
    const L = [['dp', 0xc100, 0x14, 0x98], ['pt', 0xcf2c, 0x14, 0xa0], ['hgss', 0xf628, 0x10, 0x98]].find(([f]) => f === S.saveFamily(u8, 'nds'));
    const halves = [0, 0x40000].filter((b) => u32(b + L[1] - 0x0c) === L[1]).map((b) => ({ b, n: u32(b + L[1] - L[2]) })).sort((a, z) => z.n - a.n);
    const at = halves[0].b + L[3];
    return u8.subarray(at, at + 136);
  }
  const RAM = { gb: [[0xc000, 0x2000]], gbc: [[0xc000, 0x2000]], gba: [[0x02000000, 0x40000], [0x03000000, 0x8000]], nds: [[0x02000000, 0x400000]] };

  app.whenReady().then(async () => {
    let code = 1;
    let failShot = null;
    try {
      const { startServer } = await import(pathToFileURL(join(root, 'server', 'app.mjs')).href);
      const { url } = await startServer({ port: 0 });
      const lib = await fetch(`${url}/api/library`).then((r) => r.json());
      const r = lib.roms.find((x) => x.name === basename(rom));
      if (!r) throw new Error(`${basename(rom)} isn't in the library`);
      const system = r.system;
      res.system = system;
      const raw = readFileSync(savIn);
      const file = join(out, `import-${basename(savIn)}${opt('as') ? `.${opt('as')}` : ''}`);
      const picked = asFile(raw, opt('as'));
      writeFileSync(file, picked);
      // what the server must keep: the picked file brought into souldew's layout (shared/savefile.mjs)
      const fam = S.familyOfGame(r.gameId);
      const expect = Buffer.from(S.normalizeSave(new Uint8Array(picked), system, { expected: S.familySize(r.gameId), clock: S.familyClock(fam) }).bytes);
      const win = new BrowserWindow({ show: flag('show'), width: 1280, height: 860, webPreferences: { backgroundThrottling: false } });
      win.webContents.setAudioMuted(true);
      const js = (c) => win.webContents.executeJavaScript(c);
      const shot = async (name) => writeFileSync(join(out, `${name}.png`), (await win.capturePage()).toPNG());
      failShot = () => shot('failed').catch(() => {});
      const until = async (cond, ms = 20000, what = cond) => {
        const t0 = Date.now();
        for (;;) {
          const v = await js(cond).catch(() => null);
          if (v) return v;
          if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
          await sleep(200);
        }
      };
      const click = (selector, text) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => ${text ? `b.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) return false; el.click(); return true; })()`);
      win.webContents.debugger.attach('1.3');
      const cdp = (m, p) => win.webContents.debugger.sendCommand(m, p);
      const pickFile = async (path) => {
        const { root: doc } = await cdp('DOM.getDocument', { depth: -1, pierce: true });
        const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: '.save-import input[type=file]' });
        if (!nodeId) throw new Error('no file input in the dialog');
        await cdp('DOM.setFileInputFiles', { nodeId, files: [path] });
      };
      const dialogText = () => js("document.querySelector('.save-import')?.innerText || ''");
      const openDialog = async ({ reload = true } = {}) => {
        if (reload) await win.loadURL(`${url}/#/library`);
        else await js("location.hash = '#/library'"); // (a reload would end the running game)
        await until("document.querySelector('button.cart .owned-dot')", 30000, 'the library');
        // (the library's "Ready to play" card: its Details button – else the game's cartridge on the shelf)
        if (!(await click('button', 'Details'))) await js("[...document.querySelectorAll('.shelf button.cart')].find((b) => b.querySelector('.owned-dot')).click()");
        await until("[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent.includes('Import a save file'))", 10000, 'the game details');
        await click('dialog[open] button', 'Import a save file');
        await until("document.querySelector('.save-import')", 5000, 'the import dialog');
      };

      // --run: a solo Nuzlocke of the game (no randomizer), the save imported from the board's Files menu
      let run = null;
      if (flag('run')) {
        const built = await fetch(`${url}/api/runs/build`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' },
          body: JSON.stringify({ romId: r.id, gameId: r.gameId, randomize: false, mode: 'nuzlocke', players: { p1: { name: 'E2E' } }, name: 'Import test' }) }).then((x) => x.json());
        if (!built.manifest?.id) throw new Error(`the run wasn’t built: ${JSON.stringify(built).slice(0, 200)}`);
        run = built.manifest;
        await win.loadURL(`${url}/#/nuzlocke?run=${run.id}`);
        await until("[...document.querySelectorAll('.files-menu button')].length", 30000, 'the board');
        await click('.files-menu button', 'Files');
        await until("[...document.querySelectorAll('.run-menu button')].some((b) => b.textContent.includes('Import a save file'))", 5000, 'the Files menu');
        await click('.run-menu button', 'Import a save file');
        await until("document.querySelector('.save-import')", 5000, 'the import dialog');
      }

      // 1. import into the library entry or the run (no save yet)
      if (!run) await openDialog();
      await pickFile(file);
      await until("document.querySelector('.save-import .chip.ok, .save-import .warning, .save-import [role=alert]')", 15000, 'the check');
      step('check', { text: (await dialogText()).replace(/\s+/g, ' ').slice(0, 600) });
      await shot('1-check');
      if (run) {
        // a run: nothing goes in before "I understand"
        const blocked = await js("[...document.querySelectorAll('dialog[open] .modal-foot button')].find((b) => b.textContent.includes('Import save'))?.disabled");
        step('confirmation', { blockedFirst: blocked === true });
        if (blocked !== true) res.notes.push('a run’s save could be replaced without the confirmation');
        await click('.save-import label.check', 'I understand');
        await sleep(200);
      }
      if (!(await click('dialog[open] .modal-foot button', 'Import save'))) throw new Error('no Import button');
      await until("[...document.querySelectorAll('.toast')].some((x) => x.textContent.includes('Save imported'))", 15000, 'the toast');
      await shot('2-imported');
      const savePath = run ? join(data, 'runs', run.id, run.outputs.p1.rom.replace(/\.\w+$/, '.sav')) : join(data, 'Saves', `${createHash('sha1').update(r.id).digest('hex').slice(0, 16)}.sav`);
      const onDisk = existsSync(savePath) ? readFileSync(savePath) : null;
      // "Save a copy" as the page's link fetches it (from the page: the server's guard wants the app's own origin)
      const exportPath = run ? `/api/runs/${run.id}/download?what=save&slot=p1` : `/api/saves/solo/download?id=${encodeURIComponent(r.id)}`;
      const exported = Buffer.from(await js(`fetch('${exportPath}').then((x) => x.arrayBuffer()).then((b) => { const u = new Uint8Array(b); let s = ''; for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000)); return btoa(s); })`), 'base64');
      step('disk', { size: onDisk?.length, sameAsSave: !!onDisk && onDisk.equals(expect), exportSame: !!onDisk && exported.equals(onDisk), exportSize: exported.length, sha: onDisk && sha(onDisk) });
      if (!onDisk || !onDisk.equals(expect)) res.notes.push('the save on disk isn’t the normalized import');
      if (!exported.equals(onDisk || Buffer.alloc(0))) res.notes.push('"Save a copy" differs from the save');

      // 2. play: the game must continue from it
      await win.loadURL(run ? `${url}/#/play?run=${run.id}` : `${url}/#/play?rom=${encodeURIComponent(r.id)}`);
      const frameJs = (c) => js(`(async () => { const f = document.querySelector('iframe'); const w = f && f.contentWindow; if (!w || !w.__emu) return null; const e = w.__emu; return (${c}); })()`);
      const t0 = Date.now();
      while (!(await frameJs('!!e.ready'))) {
        if (Date.now() - t0 > 90000) throw new Error('no game after 90 s');
        await sleep(300);
      }
      const player = await js("document.querySelector('iframe').getAttribute('src')");
      step('player', { player: /playernative/.test(player) ? 'native' : 'browser', bootSave: await frameJs('e.bootSave?.()') });
      const mon = firstMon(onDisk, system);
      const ramHas = async () => {
        for (const [a, n] of RAM[system]) {
          const b64 = await frameJs(`(() => { const u = e.read(${a}, ${n}); if (!u) return null; let s = ''; for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000)); return btoa(s); })()`);
          if (b64 && Buffer.from(b64, 'base64').indexOf(mon) >= 0) return true;
        }
        return false;
      };
      const press = async (k, frames = 8) => {
        await frameJs(`(e.hold(${JSON.stringify([k])}), true)`);
        await sleep(frames * 17);
        await frameJs('(e.hold([]), true)');
      };
      const native = /playernative/.test(player);
      if (!native) res.notes.push('the browser player ran – this check presses buttons in the fast player only');
      await sleep(3000);
      const before = await ramHas();
      let found = false;
      let presses = 0;
      // in the game: the team's bytes in memory (Gen 3 has them there at the title already – it reads the save to show
      // "Continue") and the place sign of the play view showing where the save was made
      const inGame = () => js("/you are here/i.test(document.body.innerText)");
      let place = false;
      // (the DS games read their save at power-on too, and the play view names the place from the save on disk before the
      // game runs: a DS game gets its intro, title and "Continue" pressed through first – the last screenshot shows where)
      const least = { nds: 30, gba: 8 }[system] || 0;
      for (; presses < 60 && !(found && place && presses >= least); presses++) {
        await press(presses % 6 === 5 ? 'start' : 'a');
        await sleep(1300);
        found = await ramHas();
        place = found && (await inGame());
      }
      for (let i = 0; i < 4; i++) await press('a'), await sleep(800); // (FireRed's recap, the trainer card)
      for (let i = 0; i < 3; i++) await press('b'), await sleep(500);
      await sleep(1500);
      await shot('3-continued');
      const where = await js("(document.body.innerText.match(/you are here\\s*\\n\\s*([^\\n]+)/i) || [])[1] || null");
      step('continue', { inRamBefore: before, inRamAfter: found, inGame: place, where, presses });
      if (!found || !place) res.notes.push('the game didn’t continue from the imported save');

      // the run afterwards: the log line, the marker done, the save's Pokémon set aside (no catch), run.json noted
      if (run) {
        await sleep(6000); // (the page puts its doc on disk)
        // (read from the run folder: the server answers only the app's own page)
        const doc = JSON.parse(readFileSync(join(data, 'runs', run.id, 'doc.json'), 'utf8'));
        const v = (k) => doc[k]?.v ?? null;
        const keys = Object.keys(doc).filter((k) => doc[k]?.v != null);
        const m = JSON.parse(readFileSync(join(data, 'runs', run.id, 'run.json'), 'utf8'));
        const got = {
          feed: keys.filter((k) => k.startsWith('feed:')).map((k) => v(k)).filter((f) => f.type === 'saveImport').map((f) => f.text),
          marker: v('simport:p1'),
          ignored: keys.filter((k) => k.startsWith('ign:p1:')).map((k) => v(k).reason),
          catches: keys.filter((k) => k.startsWith('enc:')).length,
          badgeLines: keys.filter((k) => k.startsWith('feed:') && v(k).type === 'badge').length,
          saveImports: m.saveImports?.p1?.length || 0,
        };
        step('run', got);
        if (!got.feed.length) res.notes.push('no log line for the import');
        if (!got.ignored.length || got.ignored.some((x) => x !== 'imported')) res.notes.push('the save’s Pokémon weren’t set aside');
        if (got.catches) res.notes.push('the save’s Pokémon became catches');
        if (!got.saveImports) res.notes.push('run.json doesn’t note the import');
      }

      // 3. the guard, another game's save, Undo
      if (opt('other')) {
        await openDialog({ reload: false }); // (the game still runs – the session lives across the sections)
        const guard = await dialogText();
        const refused = await fetch(`${url}/api/saves/import?id=${encodeURIComponent(r.id)}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: raw }).then((x) => x.json().then((j) => ({ status: x.status, code: j.code })));
        step('guard', { says: /is running/.test(guard), server: refused });
        await shot('4-running');
        if (!/is running/.test(guard) || refused.code !== 'saveGameRunning') res.notes.push('the running game wasn’t guarded');
        await click('.save-import button', 'Close game');
        await until("!document.querySelector('.save-import .warning') || !/is running/.test(document.querySelector('.save-import').innerText)", 20000, 'the game to close');
        // the native host ends with its page – give it its moment
        for (let i = 0; i < 40 && (await fetch(`${url}/api/saves/import/last?id=${encodeURIComponent(r.id)}`).then((x) => x.json())).running; i++) await sleep(250);
        const beforeOther = readFileSync(savePath);
        await pickFile(resolve(opt('other')));
        await until("document.querySelector('.save-import .warning, .save-import .chip.ok, .save-import [role=alert]')", 15000, 'the check of the other save');
        const warned = await dialogText();
        await shot('5-mismatch');
        step('mismatch', { warned: /looks like a save of/.test(warned), text: warned.replace(/\s+/g, ' ').slice(0, 300) });
        const goBefore = await js("[...document.querySelectorAll('dialog[open] .modal-foot button')].find((b) => b.textContent.includes('Import save'))?.disabled");
        await click('.save-import label.check', 'Import it anyway');
        await sleep(200);
        await click('dialog[open] .modal-foot button', 'Import save');
        await until("[...document.querySelectorAll('.toast')].some((x) => x.textContent.includes('Save imported'))", 15000, 'the second import');
        const replaced = readFileSync(savePath);
        await click('.toast-action', 'Undo');
        await until("[...document.querySelectorAll('.toast')].some((x) => x.textContent.includes('Import undone'))", 15000, 'the undo');
        await shot('6-undone');
        const back = readFileSync(savePath);
        step('undo', { blockedUntilAnyway: goBefore === true, replacedChanged: !replaced.equals(beforeOther), restored: back.equals(beforeOther) });
        if (!back.equals(beforeOther)) res.notes.push('Undo didn’t bring the save back');
        if (goBefore !== true) res.notes.push('another game’s save could be imported without "Import it anyway"');
      }
      res.ok = !res.notes.length;
      code = res.ok ? 0 : 1;
    } catch (e) {
      res.notes.push(String(e?.message || e));
      res.ok = false;
      await failShot?.();
    }
    writeFileSync(join(out, 'result.json'), JSON.stringify(res, null, 1));
    console.log(`${res.ok ? 'ok' : 'FAILED'} – ${res.notes.join('; ')} – ${out}`);
    app.exit(code);
  });
}
