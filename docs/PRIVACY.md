# Privacy: what souldew sends

> **souldew Renaissance** (this build) differs from the official souldew described below:
>
> - **No “playing now” count, no daily usage count, no souldew account, no souldew+ (nor its trial), no partner finder, no Discord live runs** – it never contacts
>   api.souldew.app or accounts.souldew.app (`shared/edition.mjs`: `presence: false`, `accounts: false`,
>   `liveRunsUrl: null`).
> - **Playing with others** goes through the souldew Renaissance server, `souldew.pkmnrenaissance.com` (MQTT broker,
>   Nostr relay for WebRTC signalling, STUN/TURN), end-to-end encrypted with the invite's key – not through public
>   brokers and relays.
> - **The update check** asks GitHub for `ralandel/souldew`'s latest release; it is the only thing sent by itself and
>   can be switched off (Settings › About, or on the Windows installer's privacy page).
> - Its data folder is `souldew Renaissance` (Windows: `%APPDATA%\souldew Renaissance`), never the official app's.

souldew collects no personal data and has no tracking – the only usage numbers are the anonymous counts below. Your games, save files and runs stay on your computer;
between players only tracker data travels, encrypted with the key from your invite. The privacy policy:
<https://souldew.app/privacy.html> (the website's, German and legally binding: <https://souldew.app/datenschutz.html>).

souldew sends two things by itself, and both can be switched off: the anonymous **“playing now”** count with its
**daily usage count** (below – one switch for both) and the **update check** (see [Other connections](#other-connections)). On Windows the installer shows this before it
installs anything – see [The Windows installer](#the-windows-installer).

## “Playing now”

The souldew Discord shows how many people are playing in souldew right now – the locked channel
“🎮 Playing now: N” and the bot's status (“Watching 42 trainers play souldew”). The team sees the same totals by
system, mode and version, to see how busy it gets and to plan for it.

### When

Only while a game **actually runs** in souldew's own players – the fast player, the 3DS player or the browser
player – from the moment the game has started (not while it loads) until it closes. Not in the library, not in a run's
board, not while an external emulator (mGBA, melonDS, Azahar) runs on its own.

- Once when the game has started, then once a minute (the bot may ask for a slower beat, up to every 15 minutes).
- Once more, “stopped”, when you close the game, switch the setting off, or quit souldew (at most 1.5 seconds; a
  crash or a lost connection simply means no more heartbeats – the bot forgets the game after 3 minutes).
- Offline, or when the bot can't be reached: nothing happens. No retry queue, no error, no log entry.

### What

The local souldew server (on your computer, not the page) sends one request:

```http
POST https://api.souldew.app/presence
Content-Type: application/json

{"sid":"3q2-7wZbQ0m0Zb5n9mCk4A","system":"gba","mode":"soullink","v":"2.7.4"}
```

| Field    | What it is                                                                                              |
|----------|---------------------------------------------------------------------------------------------------------|
| `sid`    | 16 random bytes (base64url), made when the game starts. New for every game, never written to disk, not derived from anything – not from your computer, your name, the run or the game. |
| `system` | `gb` (Game Boy and Game Boy Color), `gba`, `nds` or `3ds`.                                               |
| `mode`   | `solo` (a game from the library), `nuzlocke`, `soullink` or `together` (Play together).                  |
| `v`      | the souldew version, e.g. `2.7.4`.                                                                       |

When the game closes: `{"sid":"…","stop":true}`. If `api.souldew.app` gives no answer at all (some DNS filters), the
same request goes to the bot's older address `souldew-discord-bot.sweeparena.workers.dev` – the same bot.

**Never sent:** your name or player name, a Discord account, the game's title or code, the ROM or anything about it,
file paths, run names, partners, Pokémon, progress, settings, or anything about your computer beyond what every
internet request carries (your IP address, see below).

### What the bot keeps

The bot is a Cloudflare Worker with a Cloudflare D1 database, run by the souldew team:

- **Per running game:** the `sid`, `system`, `mode`, `v` and the time of the last heartbeat. Deleted once the game has
  sent nothing for 3 minutes (the cleanup runs every 5 minutes), or at once with the “stopped” message.
- **History:** only totals – how many games ran, by system and by mode – one entry per 5 minutes, kept 90 days.
- **Not kept:** your IP address. Cloudflare necessarily sees it to deliver the request; the bot doesn't store it and
  doesn't log request bodies. To stop floods it allows each address 30 heartbeats a minute, using Cloudflare's
  in-memory rate limiter keyed by a hash of the address – nothing is written down.
- There are no profiles: a `sid` can't be linked to a person, and a new game gets a new one.

Anyone can read the totals: <https://api.souldew.app/presence> →
`{"online":42,"bySystem":{…},"byMode":{…},"byVersion":{…},"updated":"…","window":180}`.

### Switching it off

Settings › Online › **“Count me in ‘playing now’ (anonymous)”** – on by default (also in the welcome tour and on the
Windows installer's privacy page). Off applies at once: a running game
sends “stopped” right away and nothing more. The setting is stored in your local `config.json` as `"presence": false`.

The code: [`web/lib/presence.mjs`](../web/lib/presence.mjs) (when a game runs) and
[`server/lib/presence.mjs`](../server/lib/presence.mjs) (the request).

## Daily usage count

Under the same switch as “playing now”: once a day souldew counts that it was used – so the team can see how many
people use it, which versions and systems, and whether people come back. There is no id for your computer or for you.

### When

Once a day, the first time souldew runs that day (a little after start; if it can't reach the bot it tries again the
next hour – nothing is queued). Only the installed app sends it, never a development build.

### What

```http
POST https://api.souldew.app/usage
Content-Type: application/json

{"day_id":"Jb3x1kz0QmW8bC2yT5nV0A","v":"3.0.1","os":"mac","arch":"arm64","first_week":"2026-W47","active7":3,"active28":9,"new":false}
```

| Field        | What it is                                                                                          |
|--------------|-----------------------------------------------------------------------------------------------------|
| `day_id`     | 16 random bytes, made for that day only and kept in memory only – so a retry the same day isn't counted twice. Tomorrow's is a new one; they can't be linked. |
| `v`          | the souldew version.                                                                                |
| `os`, `arch` | `mac`, `win` or `linux`; `x64` or `arm64`.                                                          |
| `first_week` | the calendar week souldew was first used on this computer (e.g. `2026-W47`) – to see how many people come back after their first week. |
| `active7`    | on how many of the last 7 days souldew ran here (today included), 1–7; `active28` the same for 28 days. |
| `new`        | `true` on the day of the first use.                                                                 |

To work these out, souldew keeps a small file next to `config.json`, `usage.json`, on your computer: the first-use date
and the dates (no times) souldew ran in the last 28 days. It never leaves your computer as such. Nothing is recorded
in it while the switch is off.

### What the bot keeps

Only totals per day: how many apps sent the ping, how many were new, by version, system and processor, and per
first-use week how many were active that day (plus the sums the weekly and monthly estimates are made from). Kept 400
days. The `day_id` is kept two days (only to count a retry once), then deleted. No IP address is stored, no body is
logged, and nothing links one day's ping to another's. The team sees these totals on a password-protected page.

### Switching it off

The same switch: Settings › Online › **“Count me in ‘playing now’ (anonymous)”** – off, and neither the heartbeat nor
the daily count is sent. The code: [`server/lib/usage.mjs`](../server/lib/usage.mjs).

## Other connections

For completeness – none of these carry anything about you beyond the request itself:

- **Updates:** at start and every four hours the desktop app downloads the signed `latest.json` of the newest release
  from GitHub (`github.com/souldewapp/souldew/releases/latest/download/latest.json`) to see whether there is a new
  version. Switch: Settings › About › **“Check for updates automatically”** (`"updateCheck": false` in `config.json`;
  also in the welcome tour and on the Windows installer's page). Off: souldew only asks when you click “Check for
  updates”; a download only ever starts when you click “Update”.
- **Playing together:** SoulLink apps find each other over public Nostr relays and then connect directly (WebRTC),
  with a public MQTT broker as a fallback. Only encrypted tracker data – never games or saves.
- **Pictures:** Pokémon sprites and game covers are loaded from public GitHub repositories (PokeAPI,
  libretro-thumbnails, `raw.githubusercontent.com`) and cached – the default sprites once in the background after the
  first start, so boards work offline. The souldew+ preview pictures (the library's handheld tile, the souldew+ page)
  come from `accounts.souldew.app/v1/previews`, signed, at most every 10 minutes – no sign-in, nothing about you.
- **Your souldew account, only once you sign in:** `accounts.souldew.app` – the session, your profile, friends and
  their online status, invites, souldew+ (also the 7-day souldew+ trial: the service remembers, as a keyed hash of
  your Discord id, that your Discord account used it – so it can't be started twice). Signed out, nothing goes there.
- **“Find a SoulLink partner”, only when you post:** what you type in the form (game, partners, language and time
  zone, when you play, rules) goes through `accounts.souldew.app` to the souldew Discord bot, which posts it in
  #find-a-partner under your Discord name – like the bot's own form on Discord.
- **Discord, only if you set it up:** a Discord webhook you enter for a run, or Live runs (Settings › Discord), which
  post the events you share.

## The Windows installer

Before it installs anything, the Windows installer shows a **Privacy** page: the text above in short (what souldew
sends by itself, what it sends only when you use a feature, and what the installer changes on your PC), a link to the
privacy policy, and a checkbox for each of the two automatic connections – “Count me in ‘playing now’ (anonymous)” and
“Check for updates automatically”. Both are ticked as your settings have them (on, unless you switched them off in
the app). What you change there goes into `installer-choices.json` in your data folder; souldew applies it once at
its next start and deletes the file. The in-app update runs the installer silently (`/S --updated`): no page, your
settings stay as they are. (The code: [`build/installer.nsh`](../build/installer.nsh),
[`electron/installerchoices.mjs`](../electron/installerchoices.mjs).)

What the installer changes on your PC: souldew goes into `%LOCALAPPDATA%\Programs\souldew`, for your Windows user only
and without administrator rights; the Start menu gets “souldew” and “souldew (safe graphics)”, the desktop a shortcut,
and Settings › Apps an entry to uninstall it. No file types, no web links (URL protocols), no services, no autostart.
Your data lives in `%APPDATA%\SoulLink Studio`.

Uninstalling (Settings › Apps, or “Uninstall souldew.exe” in the install folder) asks whether your data folder should
go too – “No” is the default and keeps your runs, saves, settings, trophies and library for a later installation –
and removes the program, both Start menu entries, the desktop shortcut and the entry in Settings › Apps. An update
never asks and never deletes anything.
