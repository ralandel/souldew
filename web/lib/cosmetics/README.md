# web/lib/cosmetics – souldew+ cosmetics

Skins, profile banners, nameplates and avatar frames – and the souldew+ part of "Your handheld" (the 3D launch animation lives in `web/lib/handheld/`). **The engines and runtimes in this folder are app code (open source). The premium content isn't.** Premium content means skin stylesheets and their assets, banner recipes, nameplate windows, frame recipes and the handheld's souldew+ wraps, stickers and launch looks (Gold, Clear shell, Holo label, the Rare start, holo / glitter). It arrives as a signed, per-account encrypted pack, and is only ever decrypted in memory, in the renderer.

Import from `index.mjs` (plain functions) and `components.mjs` (Preact). Treat the names below as a stable interface: the profile / friends UI and the account client depend on them.

## Public interface (`index.mjs`)

### Skins

| Name | What it does |
|---|---|
| `applySkin(id \| null)` | Commits the player's skin. `null` or `'classic'` is the look the app ships with. Returns `false` while the skin isn't owned yet: the wish is remembered and applied once the pack is loaded and owns it. Persisting the choice is the caller's job (`save({ skin })`, config key `skin`). |
| `previewSkin(id)` / `endPreview()` | Tries a skin on the whole app without saving it, then puts the committed one back. Settings calls `endPreview()` when it unmounts. `previewSkin` returns `false` when that skin's stylesheet isn't in memory. |
| `listSkins()` | `[{ id, name, hint, group: 'dark' \| 'light', plus, sw, owned, available }]` – classic and the colour skins (souldew+ themes are colour only; an id the catalog doesn't have, e.g. a 2.x edition still in someone's config, is classic). |
| `skinState()` / `onSkinChange(fn)` | `{ committed, pending, previewing, visible }`. |

### Banners, nameplates, frames

| Name | What it does |
|---|---|
| `mountBanner(el, id, { intro = true, reducedMotion, focusY, animate })` | Fills `el` (the profile strip) and returns `{ destroy(), replay(), mounted, stats }`. |
| `mountNameplate(el, id, { reducedMotion, hoverTarget, animate, plateBg })` | Draws the banner's nameplate window behind a list row. It stays still until the row is hovered, and it fades into the row's own background colour, which it re-reads when the skin changes. |
| `mountFrame(el, id, size, { intro = true, reducedMotion, animate, hoverTarget })` | `el` is the avatar box and `size` its css size. The frame is one absolutely positioned canvas inserted right after the `<img>`, so it takes no space. Overhang: 15 % per side (at most 16 px) at 56 px and up, 2 native pixels for 20–55 px, and no frame below 20 px. Small frames animate while their row (`.cos-nameplate` / `[data-cos-row]`) is hovered. |
| `setReducedMotion(true \| false \| null)` | Overrides `prefers-reduced-motion` for all of the above. `null` follows the OS again. |

### Launch animation

The 2D souldew+ launch animations (13, and the free "Cartridge" as a catalog item) are gone since 3.0: not in the
catalog, the pack, the previews or Settings. The launch is your handheld in 3D (`web/views/launchstage.mjs`,
`web/lib/handheld/`) for Supporter and souldew+; without a membership the app's own 2D module (`web/views/cartinsert.mjs`)
plays. What each tier gets: `shared/handheld.mjs` › `launchTier` / `launchRights`. A pack that still carries
`launch.mjs` (an older one) loads; that file is left alone.

### Catalog and pack

| Name | What it does |
|---|---|
| `catalog()` | `{ banners, frames, nameplates, skins, collections }`. Each item is `{ id, name, collection, collectionName, rarity, pairsWith, plus, owned, available, sw, … }`. `owned` means usable now; `available` means the content is in memory (owned, or from a preview pack). This catalog is public data: names and swatches only, no art or recipes. `collectionName`, the collections' `name` and the skins' `hint` come in the player's language (`strings.mjs`: keys `plus.coll.<banners\|frames>.<id>` and `plus.hint.<id>`, added to the dictionaries by `scripts/extract-i18n.mjs`); the items' own names stay as they are. |
| `packState()` | `{ entitled, preview, previewUntil, previewLoading, until, packVersion, loading, error }`. `error` is one of `null`, `'offline'`, `'expired'`, `'key'`, `'signature'`, `'manifest'`, `'decrypt'`, `'hash'`, `'watermark'` or `'download'`. |
| `startPackPreview()` / `endPackPreview()` | The 15-minute live theme preview for non-members (see below). |
| `refreshPack()` / `forgetPack()` | Loads or re-checks the pack, or forgets it right away (sign-out). The app calls `refreshPack()` at boot, and it re-checks every 6 h and at `until`. The app's provider (`web/lib/account.mjs` `cosmeticsPackAccess`) waits until the account is known – while the saved sign-in is still being read, "signed out" never wipes a member's pack. |
| `onChange(fn)` | Notifies when content or entitlement changes. |
| `setPackAccessProvider(fn)` / `getPackAccess(opts)` | The account client's hook (see below). |
| `setPlusHandler(fn)` / `openPlus(info)` | Where "Get souldew+" and "Keep … with souldew+" lead. The default opens the Buy Me a Coffee page. |

### Components (`components.mjs`)

| Component | What it renders |
|---|---|
| `<Banner id size="profile \| friend \| card \| fill" shade intro reducedMotion />` | Sizes are 160 px, 92 px, 54 px, or the parent's height. Use `shade` for the fade under the name: it is mixed from the skin's own `--shell`. This fixes the design's fixed `#1b1a1fcc` gradient, which muddied banners on light skins. Without content (locked, or the pack not loaded) the banner shows its palette as a quiet strip. |
| `<Frame id size>{img, presence dot…}</Frame>` | An avatar box with the frame drawn round it. Children after the `<img>` paint above the frame. `useFrame(ref, id, size, opts)` does the same for your own markup. |
| `<Nameplate id>{row content}</Nameplate>` | A row with the nameplate behind it. |
| `<CosmeticPicker kind="banners \| frames \| nameplates" value onPick none reducedMotion />` | A grid grouped by collection, with Free first and the collection that matches the current skin next. Cards show live previews (mounted only once on screen, animated on hover or while selected), rarity, a "Matches your theme" or "Twin of …" hint, and a quiet souldew+ mark on locked items. `onPick(id, item)` fires for locked items too: check `item.owned` and offer `openPlus()`. |
| `<PlusMark />`, `useCosmetics()`, `useVisibleSkin()` | Small helpers. |

Every component destroys its runtime on unmount, so no timer, observer or worker is left behind. Every one pauses off-screen and in hidden tabs, and follows reduced motion.

## The account client's part: `setPackAccessProvider(fn)`

`fn({ purpose: 'pack' | 'preview' })` resolves to one of:

| Value | Meaning |
|---|---|
| `{ packId, version, manifest, signature, keyId, watermark, key, files: [{ path, url }], until }` | purpose `'pack'`: the account owns souldew+ (tier `plus` or `patron`). This is the service's download answer (API.md §10.2) plus the account's pack key (§8.2, base64url). |
| `{ …same…, expiresAt, preview: true }` | purpose `'preview'`: a 15-minute live theme preview (§10.4). `key` is the preview's own key, `keyId` its `pv_…` id. |
| `{ key, keyId, until, offline: true }` | The service is unreachable. The account client returns the entitlement it kept in safeStorage, so the cached pack keeps working for the 7-day grace period. |
| `null` | Signed out, or no souldew+. The cache is wiped. |
| throw | Counts as offline (without a key, the cache is kept but can't be read). For `'preview'` the error carries `code`: `rate_limited`, `limit_reached`, `none`, `signed_out`. |

The member pack is loaded by `refreshPack()` (boot, every 6 h, at `until`). A preview is never started on its own: Settings calls `startPackPreview()` when a signed-in non-member presses "Try for 15 minutes", and `endPackPreview()` (or the timer at `expiresAt`) drops it. A preview is fetched through the local server without being stored, kept in memory only, and carries skins only.

Without a provider, the default reads the dev pack from `/api/plus/dev/access`, which only exists when the server runs with `SLS_PLUS_DEV_PACK`.

## Pack format (`pack/format.mjs`) – one format, the accounts service's

```
manifest.json  { format: 1, id, version, kind, title, created, files: [{ path, sha256, size, type, executable }] }
               signed ONCE, offline, by the owner's pack tool (souldew-accounts tools/pack-build.mjs) – Ed25519
envelope       one per file, made by the service per account at download time:
               "SDP1" | u16 headerLength | header JSON { v: 1, pack, version, path, wm, kid, nonce } | AES-256-GCM(file)
               the header is the GCM additional data; text files (.css .js .mjs .json .txt) end with "\n/*sdwm:<wm>*/\n"
```

**Why this one and not a single encrypted archive** (the format this module started with):
- *Security is the same.* The signature covers the manifest, and the manifest's SHA-256 covers every byte of every file;
  the key is per account (per preview for previews); GCM authenticates every file and its header (pack, path, key id,
  watermark); the page uses nothing until **all** files passed (`openPack` is all or nothing). Only the owner's machine
  signs – the Worker only verifies and encrypts.
- *It fits the Worker.* Encrypting a whole archive per download means holding a pack-sized plaintext and ciphertext in a
  128 MB isolate; per-file envelopes are at most 8 MB each and R2 keeps the plain, signed files the Worker re-checks.
- *Smaller updates.* The local cache keys envelopes by path + content hash + key id: a new pack version downloads only
  the files that changed. A new key (sign out everywhere, unlink, takeover) downloads everything again.
- *Previews.* A preview pack is just another signed manifest (stylesheets + images ≤ 512 px, no `contents.json`) with
  a key for that preview only – no second container format.

**Files:** `contents.json`, `banners.json` (recipes as data, nameplate windows included), `skins/<id>.css` (colour only today; the format still allows `url('pack:fonts/…')` / `pack:assets/…` with `fonts/*.woff2`, `assets/*.svg`), `frames.mjs` (the part that must stay code: per-pixel recipe functions), `handheld/*` (the wraps, the stickers' atlas and the souldew+ launch looks – see Free vs. pack). Preview pack: `skins/<id>.css` (the service would also take `fonts/*.woff2` and `assets/*.png` ≤ 512 px, but the colour skins need neither).

**Verification order (`openPack`):**
1. Ed25519 over the manifest bytes against a pinned key (`pack/keys.mjs`: the owner's production key – the local server checks it too before it downloads anything; a dev key only when the local server offers one – `SLS_PLUS_DEV_PACK`, or `SLS_PLUS_DEV_KEY` with a service on this computer, never in a packaged build).
2. Manifest shape, and id / version equal to what the service issued.
3. For every file: envelope framing, header bound to this pack / path / key id, GCM tag, watermark trailer, size, SHA-256.

Only then is anything used.

## Where code from a pack runs (`sandbox.mjs`)

`frames.mjs` runs in a **module worker inside a sandboxed iframe** (`/cosmetics-sandbox.html`, `sandbox="allow-scripts"` – an opaque origin; its own CSP has `connect-src 'none'`, no images, styles or fonts). Pack code there can't call the local API (the server refuses `Origin: null`, and the app window's secret cookie is never sent from there), can't read the page, its storage or the account, and has no network. The worker's imports are rewritten (`'@cosmetics/…'`) to the app's public engine modules (served with CORS for this). Canvases never cross into the sandbox: the page keeps them, the worker draws into stand-ins (`canvas-proxy.mjs`) and sends the pictures back as ImageData through the iframe's relay (`sandbox-frame.js`). Nothing from a pack ever runs in the Node / main process: the local server only checks the manifest signature, stores, serves and wipes the encrypted envelopes (`server/lib/pluspack.mjs`).

Skin CSS is injected as a `<style>` (allowed by `style-src 'unsafe-inline'`). Fonts and art become `data:` URLs (allowed by `font-src` / `img-src data:`). Banner recipes are plain data, run by the public engine on the main thread.

## Free vs. pack

**Free (in the app):**
- the classic skin;
- banners LCD Grid and Plain Dusk (`content/banners-free.mjs`);
- the earned banner Summit Dawn (`content/banners-earned.mjs`) – free with its trophy (Hardcore Legend), never sold, so
  it ships like the free ones; `catalog()` lists it in the collection `earned` with `earned: true`, owned once the
  trophy is on this computer (`setEarnedTrophies`, fed by `web/lib/trophies.mjs`);
- frames Plain and Pencil (`content/frames-free.mjs`);
- the 3.0 launch animation's scene and "Your colours" (`web/lib/handheld/`, three.js vendored in `web/vendor/three/`,
  loaded only for the launch and the editor), the free wrap Plain Dusk and the free and earned stickers as a pre-built
  atlas (`web/assets/handheld/`, `scripts/build-handheld-atlas.mjs`);
- the public catalog (`content/catalog.mjs`: names, collections, rarities, swatches, pairings; the handheld's in
  `shared/handheld.mjs`).

**Pack:**
- 16 colour skins (colour only – no fonts, no art);
- 133 banners (125 at launch plus 8 monthly drops) with their nameplate windows;
- 71 frames;
- "Your handheld": `handheld/wraps.json` (the six souldew+ wraps' compositions – their art is the pack's banner recipes),
  the souldew+ stickers' pre-built atlas `handheld/stickers.png` + `stickers-cut.png` + `stickers.json`, and
  `handheld/looks.json` – the souldew+ looks of the 3.0 launch: Gold, Clear shell (its plastic and the board inside),
  Holo label, the Rare start's light and the holo / glitter sticker finishes, as material values, a board recipe, a
  foil pattern and a few lines of fragment code (`contents.json` › `handheld`; built by `scripts/plus-dev-pack.mjs
  --handheld <design/plus/handheld>`, checked by `web/lib/handheld/looks.mjs cleanLooks`). The public scene draws only
  "Your colours" and vinyl: without this data a souldew+ look, finish or Rare start isn't drawn, whatever a client
  switches on. The fragment code runs on the GPU inside the scene's own shader (no JavaScript, no page access): only
  statements over the variables the shader offers – no `#` lines, no declarations, no texture reads, no loops.

## Preview media (`previews.mjs`) – what everyone sees before buying

Nobody buys what they can't see. Every premium banner, nameplate and frame has a still (PNG, display
size ×2) and a short loop (animated WebP, native size, ≤ 150 KB), every colour skin a still of the app in it, every
souldew+ sticker and wrap a product shot (turned a few degrees, resampled, a light sheen – `scripts/handheld/preview-shot.mjs`:
a sticker IS its pixel art, so a clean ×6 copy would be the sticker itself) – rendered offline from the design sources (`scripts/plus-previews.mjs`, `scripts/plus-skin-shots.mjs`; `plus-dev-pack.mjs
--previews-source`). Pictures only: no recipe, code or stylesheet, so the accounts service hands them to anyone (API.md
§10.6, a pack of kind `previews`). The local server (`server/lib/pluspreviews.mjs`) fetches the manifest (no account
needed), checks its signature against the pinned pack key and every picture's SHA-256, and serves them at
`/api/plus/previews/file?path=<kind>/<id>.<png|webp>`. In the page: `previewSrc(kind, id, { loop })`, `<PreviewPicture>`.
The launch looks of "Your handheld" ("Your colours", Gold, Holo label, the Clear shell in each of its four colours) are
a still and a 3-second loop each (`launch/<name>.png|webp`), drawn by the real launch scene with the pack's looks data
(`scripts/handheld/launch-shots.mjs`, run by `plus-dev-pack.mjs --previews-source`) – the souldew+ page's launch cards
(`views/launchlooks.mjs`). The souldew+ wraps' pictures also dress the 3D handheld on the souldew+ page for anyone without
the pack (`web/lib/handheld/wrap.mjs previewArt`: the picture levelled, read at its art pixels and continued past its
edges – marked as a preview, never put on the account's handheld).
Where: a locked card in `<CosmeticPicker>` (the loop while hovered / focused / chosen, never with reduced motion), a
locked theme for someone who can't try it live (signed out: a still of the app in it – signed-in non-members keep the
15-minute live preview), and `PlusShowcase` ("What souldew+ holds", Settings › Account, signed in or out).

## Dev pack

```
node scripts/plus-dev-pack.mjs --design <design/plus> --out <dir outside the repo>   # test pack + access.json + dev key
node scripts/plus-dev-pack.mjs --design <design/plus> --catalog                       # regenerate content/*.mjs
SLS_PLUS_DEV_PACK=<dir> node server/index.mjs
localStorage['sl-plus-dev-preview'] = '1'      # try the non-member flow (preview pack, "Keep … with souldew+")
```

`--source <dir>` / `--preview-source <dir>` write the unsigned pack folders the owner's pack tool signs for production (`node tools/pack-build.mjs <dir> --id souldew-plus --kind mixed …` and `--id skins-preview --kind preview`). `scripts/plus-e2e.mjs` runs the whole chain against the real service in `wrangler dev`.

## Tests

| File | What it covers |
|---|---|
| `test/cosmetics-pack.test.mjs` | Signatures, per-file envelopes, watermark trailers, hashes, manifest shape, an envelope made like the Worker makes it. |
| `test/cosmetics-cache.test.mjs` | The server cache (SSRF allow-list, small updates, grace, wipe) and the client lifecycle (member, signed out, expired, key changed, offline grace, bad signature, damaged download, live preview). |
| `test/cosmetics-skins.test.mjs` | Apply, preview and revert; pending wishes; losing the membership; `data:` asset inlining. |
| `test/cosmetics-runtime.test.mjs` | Draw, pause off-screen, reduced motion, worker wiring, destroy without leaks. |
| `test/cosmetics-sandbox.test.mjs` | Real Chromium: pack code in the sandboxed iframe reaches no API, no config, no network – and its frame still paints. |
| `test/skin-proof.test.mjs` | Every skin on 11 real app views in Electron, comparing element boxes, text and generated text with classic. Needs a pack: set `SLS_PLUS_PROOF_PACK`, or have the design folder next to the checkout. |
