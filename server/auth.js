"use strict";

const crypto = require("crypto");
const { TtlRateLimiter, rateLimitMiddleware } = require("./rateLimiter");
const { migrateDatabase } = require("./database");

const SESSION_COOKIE = "rsa_session";
const SESSION_DAYS = 30;
const MAX_AUTH_ATTEMPTS = 12;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_LIMITER_MAX_ENTRIES = 4096;
const AUTH_ME_MAX_ATTEMPTS = 120;
const MAX_ACCOUNTS = readPositiveIntEnv("MAX_ACCOUNTS", 500);
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_VERIFY_TIMEOUT_MS = 5_000;

function installAuth(app, db, helpers) {
  migrateDatabase(db);
  const cleanName = helpers.cleanName;
  const clientIp = helpers.clientIp || ((req) => req.ip || req.socket.remoteAddress || "unknown");
  const googleAttempts = new TtlRateLimiter({
    maxAttempts: MAX_AUTH_ATTEMPTS,
    windowMs: AUTH_WINDOW_MS,
    maxEntries: AUTH_LIMITER_MAX_ENTRIES
  });
  const meAttempts = new TtlRateLimiter({
    maxAttempts: AUTH_ME_MAX_ATTEMPTS,
    windowMs: AUTH_WINDOW_MS,
    maxEntries: AUTH_LIMITER_MAX_ENTRIES
  });

  app.post("/auth/logout", (req, res) => {
    const token = readSessionToken(req);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get(
    "/auth/me",
    rateLimitMiddleware(meAttempts, clientIp, "Too many session checks. Try again shortly."),
    (req, res) => {
      const user = userFromRequest(db, req);
      res.json({ ok: true, user });
    }
  );

  app.get("/auth/config", (_req, res) => {
    res.json({ ok: true, googleClientId: GOOGLE_CLIENT_ID || null });
  });

  app.post(
    "/auth/google",
    rateLimitMiddleware(googleAttempts, clientIp),
    asyncHandler(async (req, res) => {
      if (!GOOGLE_CLIENT_ID) {
        return res.status(503).json({ ok: false, error: "Google sign-in is not configured." });
      }
      const credential = String(req.body?.credential || "");
      if (!credential || credential.length > 4096) {
        return res.status(400).json({ ok: false, error: "Missing Google credential." });
      }

      let profile = null;
      try {
        profile = await verifyGoogleToken(credential, GOOGLE_CLIENT_ID);
      } catch {
        profile = null;
      }
      if (!profile) return res.status(401).json({ ok: false, error: "Google sign-in failed." });

      let user = db.prepare(
        "SELECT id, google_sub AS googleSub, name, created_at AS createdAt FROM users WHERE google_sub = ?"
      ).get(profile.sub);
      const requestedName = req.body?.name ? cleanName(req.body.name) : "";
      if (!user) {
        if (accountCount(db) >= MAX_ACCOUNTS) {
          return res.status(403).json({ ok: false, error: "Registrations are closed." });
        }
        const info = db.prepare(`
          INSERT INTO users (google_sub, name, created_at)
          VALUES (?, ?, ?)
        `).run(profile.sub, requestedName || "Player", nowIso());
        user = db.prepare(
          "SELECT id, google_sub AS googleSub, name, created_at AS createdAt FROM users WHERE id = ?"
        ).get(info.lastInsertRowid);
      } else if (requestedName && requestedName !== user.name) {
        db.prepare("UPDATE users SET name = ? WHERE id = ?").run(requestedName, user.id);
        user.name = requestedName;
      }

      const session = createSession(db, user.id);
      setSessionCookie(req, res, session.token, session.expiresAt);
      res.json({ ok: true, user: publicUser(user) });
    })
  );

  return { googleAttempts, meAttempts };
}

// Verify only the claims needed to bind a session to Google's stable opaque
// subject. Contact details are neither read from the response nor stored.
async function verifyGoogleToken(credential, clientId) {
  if (typeof fetch !== "function") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_VERIFY_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential),
      { signal: controller.signal }
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (!data) return null;
  const issuer = String(data.iss || "");
  if (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") return null;
  if (String(data.aud || "") !== clientId) return null;
  const expires = Number(data.exp || 0);
  if (!expires || expires * 1000 <= Date.now()) return null;
  const sub = String(data.sub || "").trim();
  if (!sub || sub.length > 255) return null;
  return { sub };
}

function userFromRequest(db, req) {
  const token = readSessionToken(req);
  if (!token) return null;
  const row = db.prepare(`
    SELECT users.id, users.google_sub AS googleSub, users.name,
           users.created_at AS createdAt
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashToken(token), nowIso());
  return publicUser(row);
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, createdAt: user.createdAt };
}

function createSession(db, userId, now = Date.now()) {
  cleanExpiredSessions(db, now);
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = new Date(now);
  const expiresAt = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), userId, createdAt.toISOString(), expiresAt.toISOString());
  return { token, expiresAt };
}

function createTestSession(db, googleSub, name = "Test Player") {
  const safeSub = String(googleSub || "").trim();
  if (!safeSub || safeSub.length > 255) throw new TypeError("A test Google subject is required");
  db.prepare(`
    INSERT INTO users (google_sub, name, created_at) VALUES (?, ?, ?)
    ON CONFLICT(google_sub) DO UPDATE SET name = excluded.name
  `).run(safeSub, String(name || "Test Player"), nowIso());
  const user = db.prepare("SELECT id FROM users WHERE google_sub = ?").get(safeSub);
  const session = createSession(db, user.id);
  return `${SESSION_COOKIE}=${session.token}`;
}

function cleanExpiredSessions(db, now = Date.now()) {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(new Date(now).toISOString()).changes;
}

function accountCount(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
}

function setSessionCookie(req, res, token, expiresAt) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function readSessionToken(req) {
  return parseCookies(req.headers.cookie || "")[SESSION_COOKIE] || "";
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isSecureRequest(req) {
  return req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function nowIso() {
  return new Date().toISOString();
}

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return value;
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  installAuth,
  userFromRequest,
  cleanExpiredSessions,
  _test: {
    verifyGoogleToken,
    parseCookies,
    hashToken,
    accountCount,
    createSession,
    createTestSession,
    cleanExpiredSessions,
    limits: {
      maxAccounts: MAX_ACCOUNTS,
      maxAuthAttempts: MAX_AUTH_ATTEMPTS,
      maxMeAttempts: AUTH_ME_MAX_ATTEMPTS,
      maxLimiterEntries: AUTH_LIMITER_MAX_ENTRIES
    }
  }
};
