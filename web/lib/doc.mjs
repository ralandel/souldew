// Shared run document: a last-writer-wins map (a tiny state-based CRDT).
// Every key holds { v, t, by }: value, logical timestamp, device id. Merging keeps the entry
// with the larger (t, by) pair, so both players converge no matter the order messages arrive
// in, duplicates (P2P + relay) are harmless, and offline edits merge cleanly later.

import { api } from './api.mjs';

/** Waits before retrying a failed server save (then it waits for the next change). */
const SAVE_RETRY_MS = [2000, 5000, 15000, 30000];

const DEVICE_KEY = 'sl-device-id';

export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'dev-' + Math.random().toString(36).slice(2, 8);
  }
}

const newer = (a, b) => !b || a.t > b.t || (a.t === b.t && a.by > b.by);
/** Keys that would reach Object.prototype through plain-object access. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Remote timestamps are clamped to now + 1 day (the server's merge of uploads, mergeDocEntries in
 *  server/lib/build.mjs, uses the same bounds) – except the host's signed rules, which keep the timestamp they are
 *  signed for. */
const MAX_SKEW = 86400000;
/** Changes are written (browser copy and server) this long after the last one – live HP changes several times a
 *  second in a battle, and each write turns the whole doc into JSON. */
const PERSIST_MS = 600;

/** Docs with changes not in the browser copy yet: written right away when the page goes (reload, closing). */
const unsaved = new Set();
export function persistLocalNow() {
  for (const d of unsaved) d._persistLocal();
}
if (typeof addEventListener === 'function') addEventListener('pagehide', persistLocalNow);

export class RunDoc {
  constructor(runId) {
    this.runId = runId;
    this.entries = {};
    this.clock = 0;
    this.by = deviceId();
    this.listeners = new Set();
    this.localListeners = new Set(); // called with entries changed locally (to broadcast)
    this.saveTimer = null;
    // guard(key, entry) for entries from the link: true (take it), 'signed' (take it at its exact timestamp, even one
    // more than a day ahead – the host's signature is for it), false (drop it) or a Promise of either – merged again
    // once it settles. For keys only one player may write (lib/hostrules.mjs: the host's rules).
    this.guard = null;
    // outranks(key, a, b): true when entry `a` beats entry `b` whatever their timestamps (lib/hostrules.mjs: once the
    // host's key is known, the host's signed rules beat any unsigned ones – a partner's clock running ahead, or an
    // unsigned entry the host's doc never took, must not keep them out)
    this.outranks = null;
  }

  /** Does entry `a` replace `b` for `key`? The newer one – unless one of them outranks the other (see outranks). */
  _wins(key, a, b) {
    if (!b) return true;
    if (this.outranks) {
      if (this.outranks(key, a, b)) return true;
      if (this.outranks(key, b, a)) return false;
    }
    return newer(a, b);
  }

  tick() {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  get(key, fallback = undefined) {
    const e = this.entries[key];
    return e && e.v !== null ? e.v : fallback;
  }

  /** All live entries whose key starts with prefix → { suffix: value }. */
  scan(prefix) {
    const out = {};
    for (const [k, e] of Object.entries(this.entries)) {
      if (k.startsWith(prefix) && e.v !== null) out[k.slice(prefix.length)] = e.v;
    }
    return out;
  }

  set(key, value) {
    const entry = { v: value === undefined ? null : value, t: this.tick(), by: this.by };
    if (!this._wins(key, entry, this.entries[key])) return; // (it can't replace what outranks it – not even here)
    this.entries[key] = entry;
    this._changed([key], { [key]: entry });
  }

  /** Several writes as one change notification / one network message. */
  batch(writes) {
    const changed = {};
    for (const [key, value] of Object.entries(writes)) {
      const entry = { v: value === undefined ? null : value, t: this.tick(), by: this.by };
      if (!this._wins(key, entry, this.entries[key])) continue;
      this.entries[key] = entry;
      changed[key] = entry;
    }
    const keys = Object.keys(changed);
    if (keys.length) this._changed(keys, changed);
  }

  /**
   * Write `value` at the timestamp `t` it was made for (the host's signed rules carry theirs – lib/hostrules.mjs), if
   * that is newer than what the key holds. true when it was written.
   */
  setAt(key, value, t) {
    if (!Number.isFinite(t)) return false;
    const entry = { v: value === undefined ? null : value, t, by: this.by };
    if (!this._wins(key, entry, Object.hasOwn(this.entries, key) ? this.entries[key] : undefined)) return false;
    this.entries[key] = entry;
    if (t > this.clock) this.clock = t;
    this._changed([key], { [key]: entry });
    return true;
  }

  del(key) {
    this.set(key, null);
  }

  /** info (optional, from the link): { live: sent right after the change, offset: our clock minus the sender's }
   *  – handed to subscribers as their third argument. */
  merge(remote, info = null, { own = false } = {}) {
    const changed = [];
    const maxT = Date.now() + MAX_SKEW;
    for (const [k, raw] of Object.entries(remote || {})) {
      // Entries come from the partner (untrusted): no prototype keys, sane shape, no timestamps far in the
      // future (one would win every later edit of that key forever).
      if (UNSAFE_KEYS.has(k) || !raw || typeof raw !== 'object' || typeof raw.t !== 'number' || !Number.isFinite(raw.t)) continue;
      const v = raw.v === undefined ? null : raw.v;
      const by = typeof raw.by === 'string' ? raw.by.slice(0, 64) : '';
      let e = { v, t: Math.min(raw.t, maxT), by };
      // This computer's own copy (load): the host's signed rules keep the timestamp they were signed for – they were
      // checked when they came in, and a clamped one no longer matches its signature.
      if (own && raw.t > maxT && k === 'rules' && v && typeof v === 'object' && typeof v.sig === 'string' && v.rev === raw.t) e = { v, t: raw.t, by };
      const known = Object.hasOwn(this.entries, k) ? this.entries[k] : undefined;
      if (this.guard) {
        // The guard sees the timestamp as sent: the host's signature is for exactly that one (a host whose clock is
        // more than a day ahead of ours, or that followed a partner's clock that far).
        const exact = raw.t > maxT ? { v, t: raw.t, by } : e;
        if (this._wins(k, exact, known)) {
          const ok = this.guard(k, exact);
          if (ok === 'signed') e = exact; // the host's signature vouches for it: kept as signed
          else if (ok !== true) {
            if (ok && typeof ok.then === 'function') ok.then((yes) => yes && this.merge({ [k]: exact }, info), () => {});
            continue;
          }
        }
      }
      if (this._wins(k, e, known)) {
        this.entries[k] = e;
        changed.push(k);
      }
      // (a far-future signed entry is kept, but doesn't drag this doc's clock along further than any other entry)
      const tc = Math.min(e.t, maxT);
      if (tc > this.clock) this.clock = tc;
    }
    if (changed.length) this._changed(changed, null, true, info);
    return changed;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onLocalChange(fn) {
    this.localListeners.add(fn);
    return () => this.localListeners.delete(fn);
  }

  _changed(keys, localEntries, remote = false, info = null) {
    if (localEntries) for (const fn of this.localListeners) fn(localEntries);
    for (const fn of this.listeners) fn(keys, remote, info);
    this._persistSoon();
  }

  _persistSoon() {
    unsaved.add(this);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this._persistLocal();
      this._saveToServer();
    }, PERSIST_MS);
  }

  /** The browser's copy of the doc (kept when the server can't be reached). */
  _persistLocal() {
    unsaved.delete(this);
    try {
      localStorage.setItem(`sl-doc-${this.runId}`, JSON.stringify(this.entries));
    } catch {
      // quota / private mode — server copy still works
    }
  }

  /**
   * Write the doc to the server. A failed write (server busy, app restarting) is tried again a few times, more
   * slowly each time – a newer change restarts that anyway. The localStorage copy keeps it safe meanwhile.
   */
  _saveToServer(attempt = 0) {
    return api.put(`/api/runs/${this.runId}/doc`, this.entries).catch(() => {
      if (attempt >= SAVE_RETRY_MS.length) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this._saveToServer(attempt + 1), SAVE_RETRY_MS[attempt]);
    });
  }

  async load() {
    let local = null;
    try {
      local = JSON.parse(localStorage.getItem(`sl-doc-${this.runId}`) || 'null');
    } catch {
      local = null;
    }
    const server = await api.get(`/api/runs/${this.runId}/doc`).catch(() => null);
    // Merge both: whichever copy is newer per key wins.
    this.merge(server || {}, null, { own: true });
    this.merge(local || {}, null, { own: true });
    return this;
  }
}
