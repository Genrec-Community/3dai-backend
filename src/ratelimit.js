'use strict';
// Fixed-window per-user limiter. In-memory: fine for a single instance.

function createLimiter({ max, windowMs = 60_000, now = Date.now }) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

module.exports = { createLimiter };
