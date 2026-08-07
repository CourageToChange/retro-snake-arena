"use strict";

const crypto = require("crypto");

const RULESET_VERSION = 1;
const MODES = Object.freeze(["arena", "classic", "rune"]);
const MODE_SET = new Set(MODES);
const RUN_TOKEN_TTL_MS = 30 * 60 * 1000;
const REPORTED_DURATION_CLOCK_TOLERANCE_MS = 5_000;

const CLASSIC_BOARD_CELLS = 32 * 32;
const CLASSIC_START_LENGTH = 4;
const CLASSIC_MAX_FOOD = CLASSIC_BOARD_CELLS - CLASSIC_START_LENGTH;
const CLASSIC_MAX_SCORE = (6 * 10) + (3 * 20) + (2 * 30) + ((CLASSIC_MAX_FOOD - 11) * 40);
const ARENA_MAX_CUT_REWARD = 36 * 3;
const ARENA_ROCKET_MAGAZINE = 3;
const ARENA_PROJECTILE_LIFETIME_MS = 1_600;
const ARENA_MAX_SCORE = Math.floor(
  (ARENA_MAX_CUT_REWARD * ARENA_ROCKET_MAGAZINE * RUN_TOKEN_TTL_MS) /
  ARENA_PROJECTILE_LIFETIME_MS
);

// These are intentionally derived from the shipped rules rather than chosen as
// round guesses:
//
// - Classic uses a 32 * 32 = 1,024-cell board and starts at length 4, leaving
//   1,020 possible food-growth cells. Its score tiers require 6 foods * 10 to
//   reach 60, then 3 * 20 to reach 120, then 2 * 30 to reach 180; the remaining
//   1,009 foods score 40 each. The board-derived ceiling is therefore
//   60 + 60 + 60 + 40,360 = 40,540. Its highest food is 40 points at level 4;
//   SPEED changes the fastest 95 ms move interval to round(95 / 1.4) = 68 ms,
//   so ceil(40,000 / 68) = 589 points/s.
// - Rune's largest atomic reward is the 500-point portal on a 155 ms move, so
//   ceil(500,000 / 155) = 3,226. Three 100-point runes plus the portal also make
//   800 an absolute run maximum.
// - Arena permits overlapping pickups, so its client rules have no strict
//   physical ceiling. The short-burst rate allows its maximum combo cut reward
//   (36 * the 3x combo cap = 108) once on each of the UI's 120 supported updates:
//   108 * 120 = 12,960 points/s. The generous sustained-session ceiling assumes
//   a full 3-rocket magazine earns that maximum 108-point cut once per rocket
//   during every 1.6-second projectile lifetime for the full 1,800-second token:
//   floor(108 * 3 * 1,800 / 1.6) = 364,500. Real play also has to find rockets,
//   aim, and travel between targets, so this sits comfortably above a real run.
const MODE_PLAUSIBILITY = Object.freeze({
  arena: Object.freeze({
    maxScorePerSecond: 108 * 120,
    minDurationMs: Math.ceil((2 * 1000) / 120),
    maxScore: ARENA_MAX_SCORE
  }),
  classic: Object.freeze({
    maxScorePerSecond: Math.ceil((40 * 1000) / Math.round(95 / 1.4)),
    minDurationMs: 2500 + Math.round(95 / 1.4),
    maxScore: CLASSIC_MAX_SCORE
  }),
  rune: Object.freeze({
    maxScorePerSecond: Math.ceil((500 * 1000) / 155),
    minDurationMs: 2500 + (12 * 155),
    maxScore: (3 * 100) + 500
  })
});

class RunTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunTokenError";
    this.code = code;
  }
}

class RunTokenSigner {
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.ttlMs = Number.isInteger(options.ttlMs) ? options.ttlMs : RUN_TOKEN_TTL_MS;
    this.key = options.key ? asKeyBuffer(options.key) : signingKeyFromEnvironment(options.logger);
  }

  issue(mode, userId, overrides = {}) {
    assertMode(mode);
    const issuedAt = integerOr(overrides.issuedAt, this.now());
    const expiry = integerOr(overrides.expiry, issuedAt + this.ttlMs);
    if (expiry <= issuedAt) throw new TypeError("Run token expiry must follow issue time");

    const payload = {
      mode,
      rulesetVersion: RULESET_VERSION,
      issuedAt,
      expiry,
      userId: String(userId || "anonymous"),
      nonce: crypto.randomBytes(18).toString("base64url")
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return {
      runToken: `${encoded}.${this.sign(encoded)}`,
      rulesetVersion: RULESET_VERSION,
      issuedAt
    };
  }

  verify(token, expected = {}) {
    if (typeof token !== "string" || token.length < 20 || token.length > 2048) {
      throw new RunTokenError("malformed", "Invalid run token.");
    }
    const parts = token.split(".");
    if (parts.length !== 2 || !isBase64Url(parts[0]) || !isBase64Url(parts[1])) {
      throw new RunTokenError("malformed", "Invalid run token.");
    }

    const expectedSignature = Buffer.from(this.sign(parts[0]), "ascii");
    const actualSignature = Buffer.from(parts[1], "ascii");
    if (actualSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
      throw new RunTokenError("signature", "Invalid run token.");
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw new RunTokenError("malformed", "Invalid run token.");
    }
    validatePayload(payload);

    const now = this.now();
    if (payload.expiry <= now) throw new RunTokenError("expired", "Run token expired.");
    if (payload.issuedAt > now + REPORTED_DURATION_CLOCK_TOLERANCE_MS) {
      throw new RunTokenError("future", "Invalid run token.");
    }
    if (expected.mode && payload.mode !== expected.mode) {
      throw new RunTokenError("mode", "Run token was issued for a different mode.");
    }
    if (expected.userId !== undefined && payload.userId !== String(expected.userId)) {
      throw new RunTokenError("user", "Run token belongs to a different player.");
    }
    return payload;
  }

  sign(encodedPayload) {
    return crypto.createHmac("sha256", this.key).update(encodedPayload).digest("base64url");
  }
}

function validateScorePlausibility(mode, score, durationMs, issuedAt, now = Date.now()) {
  assertMode(mode);
  const rules = MODE_PLAUSIBILITY[mode];
  if (!Number.isInteger(durationMs) || durationMs < rules.minDurationMs) {
    throw new RunTokenError("duration", "Run duration is implausibly short.");
  }
  if (durationMs > Math.max(0, now - issuedAt) + REPORTED_DURATION_CLOCK_TOLERANCE_MS) {
    throw new RunTokenError("duration", "Run duration exceeds the server-observed run time.");
  }
  if (rules.maxScore !== null && score > rules.maxScore) {
    throw new RunTokenError("score", "Score is not plausible for this mode.");
  }
  const maximumForDuration = Math.floor((durationMs * rules.maxScorePerSecond) / 1000);
  if (score > maximumForDuration) {
    throw new RunTokenError("score", "Score is not plausible for this run duration.");
  }
  return { maximumForDuration, rules };
}

function signingKeyFromEnvironment(logger = console) {
  const configured = String(process.env.RUN_TOKEN_SECRET || "").trim();
  if (configured) return Buffer.from(configured, "utf8");
  if (process.env.NODE_ENV === "production") {
    throw new Error("RUN_TOKEN_SECRET must be set when NODE_ENV=production.");
  }
  const generated = crypto.randomBytes(32);
  const log = logger && (logger.warn || logger.log);
  if (typeof log === "function") {
    log.call(logger, "RUN_TOKEN_SECRET is unset; generated an ephemeral random run-token key for this process.");
  }
  return generated;
}

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RunTokenError("malformed", "Invalid run token.");
  }
  if (!MODE_SET.has(payload.mode) || payload.rulesetVersion !== RULESET_VERSION ||
      !Number.isInteger(payload.issuedAt) || !Number.isInteger(payload.expiry) ||
      payload.expiry <= payload.issuedAt || typeof payload.userId !== "string" ||
      payload.userId.length < 1 || payload.userId.length > 128 ||
      typeof payload.nonce !== "string" || payload.nonce.length < 16 || payload.nonce.length > 128) {
    throw new RunTokenError("malformed", "Invalid run token.");
  }
}

function assertMode(mode) {
  if (!MODE_SET.has(mode)) throw new TypeError("Invalid game mode");
}

function isBase64Url(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function integerOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function asKeyBuffer(value) {
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), "utf8");
}

module.exports = {
  MODES,
  MODE_SET,
  RULESET_VERSION,
  RUN_TOKEN_TTL_MS,
  MODE_PLAUSIBILITY,
  RunTokenError,
  RunTokenSigner,
  validateScorePlausibility,
  tokenFingerprint
};
