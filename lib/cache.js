'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Small TTL cache with in-flight de-duplication.
 *
 * Two identical upstream requests made within the TTL (for example a search
 * immediately followed by the first refresh, or the same flight open in two
 * tabs) are answered from memory, which keeps API usage low.
 *
 * When `file` is given, entries are also persisted to disk. That is used for
 * slow-changing reference data (airport coordinates, airline names) so a
 * server restart does not spend requests re-fetching them.
 */
class TtlCache {
  constructor({ file = null, maxEntries = 500 } = {}) {
    this.map = new Map();
    this.inflight = new Map();
    this.file = file;
    this.maxEntries = maxEntries;
    this.saveTimer = null;
    if (file) this.load();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    if (this.file) this.scheduleSave();
  }

  /** Returns the cached value, or runs `producer` once even if called concurrently. */
  async wrap(key, ttlMs, producer) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw)) {
        if (entry && entry.expires > now) this.map.set(key, entry);
      }
    } catch {
      /* no cache file yet */
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)));
      } catch {
        /* disk cache is best-effort */
      }
    }, 1000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }
}

module.exports = { TtlCache };
