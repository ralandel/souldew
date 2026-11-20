# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private vulnerability reporting
([report a vulnerability](https://github.com/souldewapp/souldew/security/advisories/new)), or contact the maintainers privately. Include the
souldew version, what an attacker could do, and steps to reproduce. You'll get an answer as soon as possible; please
give us time to ship a fix before disclosing details.

## Scope

souldew runs a local HTTP server and talks to other players over public relays. Things we especially want to hear
about:

- **Local server** (`server/`): requests from other websites or other machines reaching the API (host check, origin
  and `Sec-Fetch-Site` check and the app header in `server/lib/guard.mjs`; GETs that hand out the run pack, a run's
  files (including library ROMs/patches and saves), the spoiler log, the Discord webhook, the stream token, folders,
  the app event stream or the mGBA live-bridge Lua script additionally need the app header or a same-origin request –
  `PRIVATE_GETS`), library paths from the page reaching files outside the approved places
  (discovery folders, library folders, picks in the native dialog – see docs/DEVELOPMENT.md, "Library paths"), path traversal in file routes, the
  overlay API or the Pokélink bridge leaking room keys, file paths or spoilers.
- **Invite codes** (`web/lib/invitecode.mjs`): ways to join a run without the host's approval, guessing or reusing a
  code, reading the run pack from the relay, or getting the pack without the host typing in the 4 confirmation digits
  the joining player's app shows. (Known limit: nothing commits either side to its key before it sees the other's, so
  somebody in the middle who can keep the real partner's messages from the host could pick a key until the digits
  match – closing that needs a new wire version.)
- **Sync** (`web/lib/sync.mjs`, `web/lib/doc.mjs`): reading or forging another run's data without its key, or a
  partner's data causing code execution or damage on your machine (e.g. through names or run packs).
- **Updater** (`electron/updater.mjs`): installing an update that isn't signed with the release key or doesn't match
  the announced version and checksum.
- **Electron shell** (`electron/`): navigation, IPC or permission handling that lets web content escape the sandbox.

Out of scope: problems that need an attacker who already controls your computer, and anything inside the emulated games.

## What the stream features show on purpose

The OBS overlays, the open stream API (`/api/v1`) and the Pokélink bridge exist to put the run on stream, so what they
serve is readable by design – to the pages and programs listed in [docs/STREAMING.md](docs/STREAMING.md) and
[docs/STREAM_API.md](docs/STREAM_API.md):

- **Readable (spoiler-class, by design):** player names and colours, teams with nicknames, levels, HP, status, held
  items (and moves for Pokélink themes), badges, play time, location and current battle, encounters, links, the
  graveyard and the log. In a randomized run that tells what everybody got – that's what a stream shows.
- **Never served:** room keys and secrets, invite codes, device IDs, the Discord webhook, the spoiler log, ROMs, saves,
  savestates, file names and folders.
- **Stream API** (`server/lib/streamapi.mjs`): with the token, whoever has it; without, OBS (no Origin, or its
  `http://absolute` local files), scripts and souldew's own pages. Pages opened from disk (Origin `null` – shared with
  sandboxed frames on any website) and other `localhost` pages only after the Stream page's switch, which starts on
  for installs set up before it existed (so their layouts keep working) and off for new ones.
- **Pokélink bridge** (`server/lib/pokelink.mjs`): readable to themes opened from disk (`file://`, Origin `null`),
  Pokélink's own sites and souldew's own pages; pages of other local web servers only after the switch on the Stream
  page. Because a page opened from disk sends Origin `null` – which a sandboxed frame on a website sends too – a
  browser that lets public websites reach `127.0.0.1` could let such a frame read the teams while the bridge is on.
  The bridge is off until you switch it on.

A way to read anything from the "never" list, or to read the stream data from a page or machine that isn't allowed
there, is a vulnerability we want to hear about.

## The souldew account and souldew+ (3.0)

The account service (souldew-accounts, its own SECURITY.md) is the trust root for everything other players see. On
this computer:

- **Who may act as the account:** the local server's account and souldew+ routes (`/api/account*`, `/api/plus*`) need,
  in the desktop app, a per-launch random secret on top of the app header: electron/main.mjs sets it as an HttpOnly,
  SameSite=Strict cookie in the app window's own cookie jar, the server never serves it (`server/lib/guard.mjs`
  `rendererSecretError`). Another program on the computer – another user's on a shared machine – that talks HTTP to
  127.0.0.1 gets `403`. A second sign-in on top of a running session is refused, and the sign-in address is never handed
  to the caller (only the system browser gets it).
- **Sign-in hand-off:** a wrong `state` on `/auth/done` never cancels the waiting sign-in, and the result page shows
  only for the redirect the server just made (a one-time nonce) – a website can't fake "You're signed in".
- **Development switches** (`SLS_ACCOUNTS_URL`, `SLS_PLUS_DEV_PACK`, `SLS_PLUS_DEV_KEY`, `SLS_ACCOUNTS_DEV_ENT_KEY`) are
  ignored by an installed (packaged) app; a session is bound to the service address that issued it.
- **souldew+ decisions** come only from the entitlement token verified against the pinned key
  (`server/lib/accounts/enttoken.mjs`: signature, `aud`, `iss`, `sub`, `sid`, `tier`, `exp` with 5 minutes of clock
  skew; offline its `grace_until`, and a clock set back behind the latest time seen counts as expired). Packs: the
  manifest signature is checked against the pinned pack key in the local server before anything is downloaded, and
  again with every file in the page. `npm run dist*` / `npm run release` stop while either pinned key is a placeholder
  (`scripts/check-pinned-keys.mjs`).
- **Pack code** (frames, launch animations) runs in a module worker inside a sandboxed iframe with an opaque origin
  and `connect-src 'none'` (`web/lib/cosmetics/sandbox.mjs`) – it can't call the local API, read the account or reach
  the network.

Known limits:

- **Friend invites fill in the 4 confirmation digits.** A run invite delivered through the account service carries the
  invite code, and the joining app fills in the digits itself, so the host's "Allow" trusts the service (and the friend
  it delivered to) instead of a code read out over voice chat. Someone controlling the account service could therefore
  sit in the middle of a friend-invite join once the host clicks Allow. Joining with a code read out by the host keeps
  the old guarantee.
- "Appear offline" and the presence privacy are kept with the session; with neither known (first start, profile
  unreadable) nothing about the game is sent.
