// This build's identity and the servers it talks to – the one file a fork edits (souldew Renaissance).
//
// Imported by the Electron shell, the local server and the page (as /shared/edition.mjs, or relatively from web/lib),
// so it must stay plain data: no Node or DOM APIs. package.json → build (productName, appId, …) repeats the name for
// electron-builder, which can't read this file; keep both in step (test/edition.test.mjs checks it).
//
// Everything network-related is namespaced (netId, topicRoot) so this build never meets the official souldew app or
// other forks in a room, even on a shared broker: a run made here can only be joined from this build.

export const EDITION = Object.freeze({
  /** Shown in the window title, the installer, shortcuts and Settings › About. */
  name: 'souldew Renaissance',
  /** The data folder under the OS app-data folder (runs, saves, library, settings). Never shared with the official app. */
  dataFolder: 'souldew Renaissance',
  /** Windows' AppUserModelID – must equal package.json → build.appId (taskbar grouping, notifications). */
  appId: 'com.pkmnrenaissance.souldew',
  /** Port of the local server the window loads. A fixed one keeps the page's storage across restarts; it differs from
   *  the official app's 47390 so both can run side by side. Taken → a random port (electron/main.mjs). */
  port: 47391,

  // ---- live sync (web/lib/sync.mjs, web/lib/invitecode.mjs) ------------------------------------------------------
  /** Trystero app id and key-derivation salt: changing it makes every existing run unreachable. */
  netId: 'souldew-renaissance-v1',
  /** Root of every MQTT topic (run sync and invite codes). The VPS broker's ACL only allows `souldew/#`. */
  topicRoot: 'souldew/renaissance',
  /** MQTT brokers (WSS). Publishes go to all of them; one working broker shared by all players is enough. */
  brokers: ['wss://souldew.pkmnrenaissance.com/mqtt'],
  /** Nostr relays for WebRTC signalling (Trystero). Without a reachable one, sync still runs over the brokers
   *  (partner screen as still pictures instead of video). */
  signalRelays: ['wss://souldew.pkmnrenaissance.com/nostr'],
  /** STUN/TURN for the direct links. Replaces Trystero's default public STUN servers entirely. The TURN credential
   *  ships inside the app, so the server limits it (quotas, no private peers) – see deploy/README.md. */
  iceServers: [
    { urls: 'stun:souldew.pkmnrenaissance.com:3478' },
    {
      urls: [
        'turn:souldew.pkmnrenaissance.com:3478?transport=udp',
        'turn:souldew.pkmnrenaissance.com:3478?transport=tcp',
        'turns:souldew.pkmnrenaissance.com:5349?transport=tcp',
      ],
      username: 'souldew',
      credential: '5ce3bf1fd3de842a666584b8cd95c232',
    },
  ],

  // ---- the official project's online services ----------------------------------------------------------------
  /** "Share to Discord" / Hall of Fame bot (server/lib/liveruns.mjs). null: off, and its buttons and settings hide. */
  liveRunsUrl: null,
  /** The anonymous "playing now" heartbeat to that bot (server/lib/presence.mjs). false: never sent, setting hidden. */
  presence: false,

  /** Public addresses shown in the app (shared/links.mjs). */
  links: {
    // the original author's – souldew Renaissance is built on their work
    coffee: 'https://buymeacoffee.com/souldew',
    github: 'https://github.com/ralandel/souldew',
    issues: 'https://github.com/ralandel/souldew/issues',
    releases: 'https://github.com/ralandel/souldew/releases',
    streamApiDocs: 'https://github.com/ralandel/souldew/blob/main/docs/STREAM_API.md',
    privacy: 'https://github.com/ralandel/souldew/blob/main/docs/PRIVACY.md',
    privacyDocs: 'https://github.com/ralandel/souldew/blob/main/docs/PRIVACY.md',
  },
});

/** Origins (wss://host[:port]) the page may open sockets to – the brokers and the signalling relays (server/lib/csp.mjs). */
export function syncOrigins(edition = EDITION) {
  const out = [];
  for (const u of [...edition.brokers, ...edition.signalRelays]) {
    try {
      const url = new URL(u);
      if (url.protocol === 'wss:') out.push(`wss://${url.host}`);
    } catch {
      // not a URL – left out (and so blocked by the CSP)
    }
  }
  return [...new Set(out)];
}
