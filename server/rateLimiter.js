"use strict";

class TtlRateLimiter {
  constructor(options = {}) {
    this.maxAttempts = positiveInteger(options.maxAttempts, "maxAttempts");
    this.windowMs = positiveInteger(options.windowMs, "windowMs");
    this.maxEntries = positiveInteger(options.maxEntries || 4096, "maxEntries");
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.buckets = new Map();
  }

  allow(rawKey) {
    const now = this.now();
    this.evictExpired(now);

    const key = String(rawKey || "unknown");
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Fail closed once the bounded map is full. Evicting a still-live bucket
      // would let that client bypass its limit merely by flooding new keys.
      if (this.buckets.size >= this.maxEntries) return false;
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    return bucket.count <= this.maxAttempts;
  }

  evictExpired(now = this.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    return this.buckets.size;
  }

  clear() {
    this.buckets.clear();
  }

  get size() {
    return this.buckets.size;
  }
}

function rateLimitMiddleware(limiter, keyForRequest, message = "Too many attempts. Try again shortly.") {
  return (req, res, next) => {
    if (!limiter.allow(keyForRequest(req))) {
      return res.status(429).json({ ok: false, error: message });
    }
    next();
  };
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

module.exports = { TtlRateLimiter, rateLimitMiddleware };
