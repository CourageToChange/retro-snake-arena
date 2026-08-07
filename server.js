"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const {
  installAuth,
  userFromRequest,
  cleanExpiredSessions,
  _test: authTest
} = require("./server/auth");
const { clientIp } = require("./server/clientIp");
const { openDatabase } = require("./server/database");
const { TtlRateLimiter, rateLimitMiddleware } = require("./server/rateLimiter");
const {
  MODE_SET,
  MODES,
  RULESET_VERSION,
  MODE_PLAUSIBILITY,
  RunTokenError,
  RunTokenSigner,
  validateScorePlausibility,
  tokenFingerprint
} = require("./server/integrity");

const PORT = Number(process.env.PORT || 3000);
const CSP = "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' data:; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; manifest-src 'self'; worker-src 'self'";
const SCORE_WINDOW_MS = 5 * 60 * 1000;
const SCORE_MAX_IN_WINDOW = 10;
const SCORE_LIMITER_MAX_ENTRIES = 4096;
const RUN_START_MAX_IN_WINDOW = 60;
const READ_MAX_IN_WINDOW = 120;
const PROFILE_WRITE_MAX_IN_WINDOW = 20;
const LEADERBOARD_KEEP_ROWS = 200;
const MAX_LEADERBOARD_LIMIT = 50;
const MAINTENANCE_INTERVAL_MS = 60 * 1000;

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
const server = http.createServer(app);
const runTokens = new RunTokenSigner();
const db = openDatabase();
const scoreAttempts = new TtlRateLimiter({
  maxAttempts: SCORE_MAX_IN_WINDOW,
  windowMs: SCORE_WINDOW_MS,
  maxEntries: SCORE_LIMITER_MAX_ENTRIES
});
const runStartAttempts = new TtlRateLimiter({
  maxAttempts: RUN_START_MAX_IN_WINDOW,
  windowMs: SCORE_WINDOW_MS,
  maxEntries: SCORE_LIMITER_MAX_ENTRIES
});
const bestReadAttempts = new TtlRateLimiter({
  maxAttempts: READ_MAX_IN_WINDOW,
  windowMs: SCORE_WINDOW_MS,
  maxEntries: SCORE_LIMITER_MAX_ENTRIES
});
const leaderboardReadAttempts = new TtlRateLimiter({
  maxAttempts: READ_MAX_IN_WINDOW,
  windowMs: SCORE_WINDOW_MS,
  maxEntries: SCORE_LIMITER_MAX_ENTRIES
});
const profileReadAttempts = new TtlRateLimiter({
  maxAttempts: READ_MAX_IN_WINDOW,
  windowMs: SCORE_WINDOW_MS,
  maxEntries: SCORE_LIMITER_MAX_ENTRIES
});
const profileWriteAttempts = new TtlRateLimiter({
  maxAttempts: PROFILE_WRITE_MAX_IN_WINDOW,
  windowMs: SCORE_WINDOW_MS,
  maxEntries: SCORE_LIMITER_MAX_ENTRIES
});
let maintenanceTimer = null;

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=()"
  );
  next();
});

app.use(express.json({ limit: "4kb" }));
const authRuntime = installAuth(app, db, { cleanName, clientIp });

app.get("/health", (_req, res) => {
  res.json(healthPayload(detailedHealthEnabled()));
});

app.post(
  "/arena/run/start",
  rateLimitMiddleware(runStartAttempts, clientIp, "Too many run starts. Try again shortly."),
  (req, res) => {
    const mode = validMode(req.body?.mode);
    if (!mode) return invalidMode(res);
    const user = userFromRequest(db, req);
    res.json(runTokens.issue(mode, runIdentity(user)));
  }
);

app.post("/arena/score", (req, res) => {
  const mode = validMode(req.body?.mode);
  if (!mode) return invalidMode(res);
  if (!scoreAttempts.allow(clientIp(req))) {
    return res.status(429).json({ ok: false, error: "Too many score submissions. Try again shortly." });
  }

  const score = req.body?.score;
  const durationMs = req.body?.durationMs;
  const runToken = req.body?.runToken;
  if (!Number.isInteger(score) || score < 1 || score > 1_000_000) {
    return res.status(400).json({ ok: false, error: "Invalid score." });
  }
  if (!Number.isInteger(durationMs) || durationMs < 1) {
    return res.status(400).json({ ok: false, error: "Invalid run duration." });
  }
  if (typeof runToken !== "string" || !runToken) {
    return res.status(400).json({ ok: false, error: "Missing run token." });
  }

  const user = userFromRequest(db, req);
  const name = cleanInitials(req.body?.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: "Initials must be exactly 3 letters or digits." });
  }
  let payload;
  try {
    payload = runTokens.verify(runToken, { mode, userId: runIdentity(user) });
    validateScorePlausibility(mode, score, durationMs, payload.issuedAt);
    const result = acceptScoreOnce({
      tokenHash: tokenFingerprint(runToken),
      tokenExpiry: payload.expiry,
      user,
      mode,
      name,
      score
    });
    return res.json({ ok: true, mode, ...result });
  } catch (error) {
    if (error instanceof RunTokenError) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    throw error;
  }
});

app.get(
  "/arena/best",
  rateLimitMiddleware(bestReadAttempts, clientIp, "Too many best-score requests. Try again shortly."),
  (req, res) => {
    const mode = validMode(req.query.mode);
    if (!mode) return invalidMode(res);
    const user = userFromRequest(db, req);
    const top = globalTopEntry(mode);
    res.json({
      loggedIn: Boolean(user),
      mode,
      personalBest: user ? userBest(user.id, mode) : null,
      globalTop: top.score,
      globalTopName: top.name
    });
  }
);

app.get(
  "/arena/leaderboard",
  rateLimitMiddleware(
    leaderboardReadAttempts,
    clientIp,
    "Too many leaderboard requests. Try again shortly."
  ),
  (req, res) => {
    const mode = validMode(req.query.mode);
    if (!mode) return invalidMode(res);
    const limit = leaderboardLimit(req.query.limit);
    if (!limit) return res.status(400).json({ ok: false, error: "Invalid leaderboard limit." });
    const rows = db.prepare(`
      SELECT name, score, created_at AS createdAt
      FROM arena_leaderboard
      WHERE mode = ? AND ruleset_version = ?
      ORDER BY score DESC, created_at ASC
      LIMIT ?
    `).all(mode, RULESET_VERSION, limit);
    res.json(rows.map((row) => ({ ...row, name: boardName(row.name) })));
  }
);

app.get(
  "/user/profile",
  rateLimitMiddleware(profileReadAttempts, clientIp, "Too many profile requests. Try again shortly."),
  (req, res) => {
    const user = userFromRequest(db, req);
    if (!user) return res.json({ ok: true, loggedIn: false, displayName: "", settings: {} });
    const profile = getUserProfile(user.id);
    res.json({ ok: true, loggedIn: true, displayName: profile.displayName || user.name, settings: profile.settings });
  }
);

app.put(
  "/user/profile",
  rateLimitMiddleware(profileWriteAttempts, clientIp, "Too many profile updates. Try again shortly."),
  (req, res) => {
    const user = userFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: "Sign in required." });
    const displayName = req.body?.displayName ? cleanName(req.body.displayName) : "";
    const settings = sanitizeSettings(req.body?.settings);
    saveUserProfile(user.id, displayName, settings);
    res.json({ ok: true });
  }
);

app.use("/.well-known", express.static(path.join(__dirname, "public", ".well-known")));
app.use(express.static(path.join(__dirname, "public")));

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

function startServer(port = PORT) {
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      startMaintenance();
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`Retro Snake Arena running at http://localhost:${actualPort}`);
      resolve(server);
    };
    server.once("error", onError);
    server.listen(port, onListening);
  });
}

function stopServer() {
  stopMaintenance();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function startMaintenance() {
  stopMaintenance();
  runMaintenance();
  maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
  if (typeof maintenanceTimer.unref === "function") maintenanceTimer.unref();
}

function runMaintenance() {
  cleanupExpiredRunTokens();
  cleanExpiredSessions(db);
  scoreAttempts.evictExpired();
  runStartAttempts.evictExpired();
  bestReadAttempts.evictExpired();
  leaderboardReadAttempts.evictExpired();
  profileReadAttempts.evictExpired();
  profileWriteAttempts.evictExpired();
  authRuntime.googleAttempts.evictExpired();
  authRuntime.meAttempts.evictExpired();
}

function stopMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}

function acceptScoreOnce(submission) {
  return db.transaction(() => {
    cleanupExpiredRunTokens();
    const spent = db.prepare(
      "INSERT OR IGNORE INTO spent_run_tokens (token_hash, expires_at) VALUES (?, ?)"
    ).run(submission.tokenHash, submission.tokenExpiry);
    if (spent.changes !== 1) throw new RunTokenError("replayed", "Run token has already been used.");
    return recordScoreWithBests(submission.user, submission.mode, submission.name, submission.score);
  })();
}

function cleanupExpiredRunTokens(now = Date.now()) {
  return db.prepare("DELETE FROM spent_run_tokens WHERE expires_at <= ?").run(now).changes;
}

function globalTopEntry(mode) {
  const row = db.prepare(`
    SELECT name, score
    FROM arena_leaderboard
    WHERE mode = ? AND ruleset_version = ?
    ORDER BY score DESC, created_at ASC
    LIMIT 1
  `).get(mode, RULESET_VERSION);
  return row ? { score: row.score, name: boardName(row.name) } : { score: 0, name: null };
}

function userBest(userId, mode) {
  if (!userId) return 0;
  const row = db.prepare(`
    SELECT best FROM arena_user_best
    WHERE user_id = ? AND mode = ? AND ruleset_version = ?
  `).get(userId, mode, RULESET_VERSION);
  return row?.best || 0;
}

function recordScoreWithBests(user, mode, name, score) {
  const previousGlobal = globalTopEntry(mode).score;
  let previousBest = 0;
  let personalBest = false;

  if (user) {
    previousBest = userBest(user.id, mode);
    if (score > previousBest) {
      personalBest = true;
      db.prepare(`
        INSERT INTO arena_user_best
          (user_id, mode, ruleset_version, name, best, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, mode, ruleset_version) DO UPDATE SET
          best = excluded.best,
          name = excluded.name,
          updated_at = excluded.updated_at
      `).run(user.id, mode, RULESET_VERSION, name, score, new Date().toISOString());
    }
    recordScore(mode, name, score);
  }

  return {
    loggedIn: Boolean(user),
    personalBest,
    previousBest,
    best: Math.max(previousBest, score),
    globalBest: Boolean(user) && score > previousGlobal,
    globalTop: user ? Math.max(previousGlobal, score) : previousGlobal
  };
}

function recordScore(mode, name, score, rulesetVersion = RULESET_VERSION) {
  if (!MODE_SET.has(mode)) return false;
  if (!Number.isInteger(score) || score < 1 || score > 1_000_000) return false;
  const initials = cleanInitials(name);
  if (!initials) return false;
  db.prepare(`
    INSERT INTO arena_leaderboard (name, score, mode, ruleset_version, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(initials, score, mode, rulesetVersion, new Date().toISOString());
  pruneLeaderboard(mode, rulesetVersion);
  return true;
}

function pruneLeaderboard(mode, rulesetVersion = RULESET_VERSION) {
  db.prepare(`
    DELETE FROM arena_leaderboard
    WHERE mode = ? AND ruleset_version = ?
      AND id NOT IN (
        SELECT id FROM arena_leaderboard
        WHERE mode = ? AND ruleset_version = ?
        ORDER BY score DESC, created_at ASC
        LIMIT ?
      )
  `).run(mode, rulesetVersion, mode, rulesetVersion, LEADERBOARD_KEEP_ROWS);
}

const PROFILE_SETTING_KEYS = [
  "arenaQuality", "arenaSensitivity", "arenaSoundOn", "arenaShowFps", "arenaReducedMotion",
  "arenaTouchControl", "arenaLeftHanded", "arenaMaxFps", "arenaHeadShape", "arenaSkin", "arenaDisplayName"
];

function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object") return {};
  const settings = {};
  for (const key of PROFILE_SETTING_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    settings[key] = String(raw[key]).slice(0, 40);
  }
  return settings;
}

function getUserProfile(userId) {
  if (!userId) return { displayName: "", settings: {} };
  const row = db.prepare(
    "SELECT display_name AS displayName, settings FROM user_profile WHERE user_id = ?"
  ).get(userId);
  if (!row) return { displayName: "", settings: {} };
  let settings = {};
  try {
    settings = row.settings ? JSON.parse(row.settings) : {};
  } catch {
    settings = {};
  }
  return { displayName: row.displayName || "", settings };
}

function saveUserProfile(userId, displayName, settings) {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO user_profile (user_id, display_name, settings, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = excluded.display_name,
        settings = excluded.settings,
        updated_at = excluded.updated_at
    `).run(userId, displayName || null, JSON.stringify(settings || {}), now);
    if (displayName) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(displayName, userId);
  })();
}

function healthPayload(detailed) {
  return detailed ? { ok: true, app: "retro-snake-arena" } : { ok: true };
}

function detailedHealthEnabled() {
  return process.env.DETAILED_HEALTH === "1";
}

function validMode(value) {
  return typeof value === "string" && MODE_SET.has(value) ? value : "";
}

function invalidMode(res) {
  return res.status(400).json({ ok: false, error: "Invalid mode." });
}

function leaderboardLimit(value) {
  if (value === undefined) return 10;
  if (!/^\d+$/.test(String(value))) return 0;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_LEADERBOARD_LIMIT ? limit : 0;
}

function runIdentity(user) {
  return user ? `user:${user.id}` : "anonymous";
}

function cleanName(name) {
  const value = String(name || "Player").trim().replace(/[^\w -]/g, "").slice(0, 14);
  return value || "Player";
}

// Public leaderboard identity is arcade-style initials: exactly 3 characters,
// A-Z and 0-9 only, uppercased. Anything else is rejected, never sanitised
// into acceptance (decision: no free-text names on the public board).
const INITIALS_PATTERN = /^[A-Z0-9]{3}$/;

// The leaderboard is public, unauthenticated and shown to strangers, so a plain
// [A-Z0-9]{3} filter is not enough on its own - three characters is exactly enough
// room for the obvious ones. Rejected the same way as a malformed entry (400).
const BLOCKED_INITIALS = new Set([
  "ASS", "CUM", "FAG", "FUK", "FUC", "GAY", "JEW", "KKK", "NIG", "NGR",
  "PIS", "POO", "SEX", "SHT", "TIT", "TWT", "VAG", "WOG", "CNT", "DIK",
  "FCK", "PSY", "RAP", "SUK", "WAN", "HOE", "PRK", "SLT", "BCH", "PRN"
]);

function cleanInitials(value) {
  const initials = String(value || "").trim().toUpperCase();
  if (!INITIALS_PATTERN.test(initials)) return "";
  if (BLOCKED_INITIALS.has(initials)) return "";
  return initials;
}

// Rows recorded before the initials rule may hold legacy free-text names.
// They stay in the database, but the public board never renders them.
function boardName(value) {
  const initials = String(value || "").trim().toUpperCase();
  return INITIALS_PATTERN.test(initials) ? initials : "···";
}

module.exports = {
  app,
  server,
  startServer,
  stopServer,
  _test: {
    clientIp,
    healthPayload,
    recordArenaScore(name, score, mode = "arena") {
      return recordScore(mode, name, score);
    },
    countLeaderboardRows(mode = "arena", rulesetVersion = RULESET_VERSION) {
      return db.prepare(`
        SELECT COUNT(*) AS count FROM arena_leaderboard
        WHERE mode = ? AND ruleset_version = ?
      `).get(mode, rulesetVersion).count;
    },
    countUsers() {
      return db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    },
    createUserSession(googleSub, name) {
      return authTest.createTestSession(db, googleSub, cleanName(name));
    },
    issueRunToken(mode, userId = "anonymous", overrides = {}) {
      return runTokens.issue(mode, userId, overrides);
    },
    cleanupExpiredRunTokens,
    cleanupExpiredSessions(now = Date.now()) {
      return cleanExpiredSessions(db, now);
    },
    countSpentRunTokens() {
      return db.prepare("SELECT COUNT(*) AS count FROM spent_run_tokens").get().count;
    },
    get scoreLimiterSize() {
      return scoreAttempts.size;
    },
    get authLimiterSize() {
      return authRuntime.googleAttempts.size;
    },
    rateLimiterSizes() {
      return {
        runStart: runStartAttempts.size,
        bestRead: bestReadAttempts.size,
        leaderboardRead: leaderboardReadAttempts.size,
        profileRead: profileReadAttempts.size,
        profileWrite: profileWriteAttempts.size,
        authMe: authRuntime.meAttempts.size
      };
    },
    constants: {
      modes: MODES,
      rulesetVersion: RULESET_VERSION,
      plausibility: MODE_PLAUSIBILITY,
      leaderboardKeepRows: LEADERBOARD_KEEP_ROWS,
      scoreLimiterMaxEntries: SCORE_LIMITER_MAX_ENTRIES,
      authLimiterMaxEntries: authTest.limits.maxLimiterEntries,
      rateLimits: Object.freeze({
        runStart: RUN_START_MAX_IN_WINDOW,
        bestRead: READ_MAX_IN_WINDOW,
        leaderboardRead: READ_MAX_IN_WINDOW,
        profileRead: READ_MAX_IN_WINDOW,
        profileWrite: PROFILE_WRITE_MAX_IN_WINDOW,
        authMe: authTest.limits.maxMeAttempts
      })
    },
    closeDatabase() {
      stopMaintenance();
      if (db.open) db.close();
    }
  }
};
