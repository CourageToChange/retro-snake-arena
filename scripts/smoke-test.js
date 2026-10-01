"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { migrateDatabase, tableColumns } = require("../server/database");
const {
  RUN_TOKEN_TTL_MS,
  RunTokenError,
  RunTokenSigner,
  validateScorePlausibility
} = require("../server/integrity");
const { TtlRateLimiter } = require("../server/rateLimiter");
const { HASHED_ASSETS, renderShell } = require("../server/shellAssets");

const tempStem = path.join(os.tmpdir(), "snake-v1-server-smoke-" + process.pid + "-" + Date.now());
const databasePath = tempStem + ".sqlite";
process.env.DB_PATH = databasePath;
process.env.DETAILED_HEALTH = "1";
process.env.MAX_ACCOUNTS = "20";
process.env.NODE_ENV = "test";
process.env.RUN_TOKEN_SECRET = "smoke-only-run-token-secret-not-for-production";

const { server, startServer, stopServer, _test } = require("../server");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(baseUrl, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  const fetchOptions = { ...options, headers };
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.json);
    delete fetchOptions.json;
  }
  return fetch(baseUrl + route, fetchOptions);
}

async function jsonResponse(baseUrl, route, options = {}) {
  const response = await request(baseUrl, route, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

function ipHeaders(ip, extras = {}) {
  return { "cf-connecting-ip": ip, ...extras };
}

async function startRun(baseUrl, mode, headers = {}) {
  const requestHeaders = withUniqueRunStartIp(headers);
  const result = await jsonResponse(baseUrl, "/arena/run/start", {
    method: "POST",
    headers: requestHeaders,
    json: { mode }
  });
  check(result.response.status === 200, `Run start failed for ${mode}`);
  check(
    result.body && typeof result.body.runToken === "string" &&
      result.body.rulesetVersion === 1 && Number.isInteger(result.body.issuedAt),
    `Run-start payload is wrong for ${mode}`
  );
  check(
    JSON.stringify(Object.keys(result.body).sort()) ===
      JSON.stringify(["issuedAt", "rulesetVersion", "runToken"].sort()),
    "Run-start response shape drifted from the API contract"
  );
  return result.body;
}

let runStartIpSequence = 1;
function withUniqueRunStartIp(headers) {
  const hasClientIp = Object.keys(headers).some((name) => name.toLowerCase() === "cf-connecting-ip");
  if (hasClientIp) return headers;
  const sequence = runStartIpSequence++;
  const third = Math.floor((sequence - 1) / 250);
  const fourth = ((sequence - 1) % 250) + 1;
  return ipHeaders(`198.18.${third}.${fourth}`, headers);
}

async function submitScore(baseUrl, body, headers = {}) {
  return jsonResponse(baseUrl, "/arena/score", { method: "POST", headers, json: body });
}

function scoreBody(mode, runToken, score, durationMs, name = "SMO") {
  return { mode, name, score, runToken, durationMs };
}

function removeDatabaseFiles(stem) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = stem + suffix;
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  }
}

function allFalse(report) {
  return Object.values(report).every((value) => value === false);
}

function verifyGeneratedKeyFallback() {
  const configured = process.env.RUN_TOKEN_SECRET;
  const nodeEnvironment = process.env.NODE_ENV;
  const messages = [];
  delete process.env.RUN_TOKEN_SECRET;
  process.env.NODE_ENV = "test";
  try {
    const signer = new RunTokenSigner({ logger: { warn: (message) => messages.push(message) } });
    const issued = signer.issue("arena", "anonymous");
    check(issued.runToken.includes("."), "Generated-key signer did not issue a token");
    check(messages.some((message) => /generated an ephemeral random/i.test(message)),
      "Unset signing key did not log random generation");
  } finally {
    process.env.RUN_TOKEN_SECRET = configured;
    process.env.NODE_ENV = nodeEnvironment;
  }
}

function verifyProductionSecretFailure() {
  const configured = process.env.RUN_TOKEN_SECRET;
  const nodeEnvironment = process.env.NODE_ENV;
  delete process.env.RUN_TOKEN_SECRET;
  process.env.NODE_ENV = "production";
  let failure = null;
  try {
    new RunTokenSigner();
  } catch (error) {
    failure = error;
  } finally {
    process.env.RUN_TOKEN_SECRET = configured;
    process.env.NODE_ENV = nodeEnvironment;
  }
  check(failure && /RUN_TOKEN_SECRET must be set when NODE_ENV=production/i.test(failure.message),
    "Production signer construction did not refuse an empty RUN_TOKEN_SECRET clearly");

  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const signerConstruction = serverSource.indexOf("const runTokens = new RunTokenSigner()");
  const databaseOpen = serverSource.indexOf("const db = openDatabase()");
  const listenCall = serverSource.indexOf("server.listen(");
  check(signerConstruction >= 0 && databaseOpen > signerConstruction && listenCall > signerConstruction,
    "Server startup no longer constructs the production signer before database open/listen");
  return {
    refusedBeforeDatabaseOrListen: true,
    message: failure.message
  };
}

function verifyAbsoluteScoreCeilings() {
  const expected = {
    arena: Math.floor(((36 * 3) * 3 * RUN_TOKEN_TTL_MS) / 1_600),
    classic: (6 * 10) + (3 * 20) + (2 * 30) + ((((32 * 32) - 4) - 11) * 40),
    rune: (3 * 100) + 500
  };
  check(RUN_TOKEN_TTL_MS === 30 * 60 * 1000, "Run-token TTL is not 30 minutes");

  const evidence = {};
  for (const mode of ["arena", "classic"]) {
    const rules = _test.constants.plausibility[mode];
    check(rules.maxScore === expected[mode], `${mode} score ceiling drifted from its rules derivation`);
    const oversizedScore = rules.maxScore + 1;
    const durationMs = Math.max(
      rules.minDurationMs,
      Math.ceil((oversizedScore * 1000) / rules.maxScorePerSecond)
    );
    check(durationMs < RUN_TOKEN_TTL_MS, `${mode} ceiling cannot be exercised within the token TTL`);
    check(Math.floor((durationMs * rules.maxScorePerSecond) / 1000) >= oversizedScore,
      `${mode} ceiling probe would fail only the duration-rate check`);

    let rejection = null;
    try {
      validateScorePlausibility(mode, oversizedScore, durationMs, 0, durationMs);
    } catch (error) {
      rejection = error;
    }
    check(rejection instanceof RunTokenError && rejection.code === "score",
      `${mode} absolute ceiling did not reject a rate-valid oversized score`);
    evidence[mode] = { maxScore: rules.maxScore, oversizedScore, rateValidDurationMs: durationMs };
  }

  const runeRules = _test.constants.plausibility.rune;
  check(runeRules.maxScore === expected.rune, "Rune score ceiling changed");
  validateScorePlausibility("rune", runeRules.maxScore, runeRules.minDurationMs, 0, runeRules.minDurationMs);
  evidence.rune = { maxScore: runeRules.maxScore, baselineAccepted: true };
  evidence.runTokenTtlMs = RUN_TOKEN_TTL_MS;
  return evidence;
}

function verifyMigrationProof() {
  const legacyPath = tempStem + "-legacy.sqlite";
  const copiedPath = tempStem + "-legacy-copy.sqlite";
  removeDatabaseFiles(legacyPath);
  removeDatabaseFiles(copiedPath);

  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE arena_leaderboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL
    );
    CREATE TABLE arena_user_best (
      user_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      best INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      google_sub TEXT
    );
    CREATE UNIQUE INDEX idx_users_google_sub
      ON users(google_sub) WHERE google_sub IS NOT NULL;
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE user_profile (
      user_id INTEGER PRIMARY KEY,
      display_name TEXT,
      settings TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const createdAt = "2026-07-21T20:00:00.000Z";
  legacy.prepare(`
    INSERT INTO users
      (id, email, name, password_hash, password_salt, created_at, google_sub)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run("owner@example.test", "Owner", "legacy-hash", "legacy-salt", createdAt, "google-owner-sub");
  legacy.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)"
  ).run("legacy-session-hash", createdAt, "2099-01-01T00:00:00.000Z");
  legacy.prepare(
    "INSERT INTO arena_user_best (user_id, name, best, updated_at) VALUES (1, ?, ?, ?)"
  ).run("Owner", 12480, createdAt);
  const insertScore = legacy.prepare(
    "INSERT INTO arena_leaderboard (name, score, source, created_at) VALUES (?, ?, 'local', ?)"
  );
  for (let index = 1; index <= 33; index += 1) {
    insertScore.run("Legacy " + index, 1000 + index, new Date(Date.parse(createdAt) + index).toISOString());
  }
  legacy.close();

  fs.copyFileSync(legacyPath, copiedPath);
  const copy = new Database(copiedPath);
  try {
    copy.pragma("foreign_keys = ON");
  const firstReport = migrateDatabase(copy);
  const rows = copy.prepare(`
    SELECT mode, ruleset_version AS rulesetVersion FROM arena_leaderboard ORDER BY id
  `).all();
  check(rows.length === 33, "Migration did not preserve all 33 legacy scores");
  check(rows.every((row) => row.mode === "arena" && row.rulesetVersion === 1),
    "Legacy scores were not backfilled to arena/ruleset 1");

  const best = copy.prepare(`
    SELECT user_id AS userId, mode, ruleset_version AS rulesetVersion, best
    FROM arena_user_best
  `).all();
  check(best.length === 1 && best[0].userId === 1 && best[0].mode === "arena" &&
    best[0].rulesetVersion === 1 && best[0].best === 12480,
  "Legacy personal best was not preserved/backfilled");

  const userColumns = tableColumns(copy, "users").map((column) => column.name).sort();
  check(
    JSON.stringify(userColumns) === JSON.stringify(["created_at", "google_sub", "id", "name"]),
    "Users migration did not remove contact/password columns"
  );
  const user = copy.prepare(
    "SELECT id, google_sub AS googleSub, name, created_at AS createdAt FROM users"
  ).get();
  check(user.id === 1 && user.googleSub === "google-owner-sub" && user.name === "Owner" &&
    user.createdAt === createdAt, "Users migration did not preserve the linked account");
  check(copy.prepare("SELECT COUNT(*) AS count FROM sessions").get().count === 1,
    "Users migration did not preserve the existing session");

  const sessionIndexNames = copy.prepare("PRAGMA index_list(sessions)").all()
    .map((index) => index.name)
    .sort();
  check(sessionIndexNames.filter((name) => name === "idx_sessions_expires_at").length === 1,
    "Sessions expiry index was not created exactly once");
  const sessionDeletePlan = copy.prepare(
    "EXPLAIN QUERY PLAN DELETE FROM sessions WHERE expires_at <= ?"
  ).all("2026-07-22T00:00:00.000Z").map((row) => String(row.detail || ""));
  check(sessionDeletePlan.some((detail) => /USING (?:COVERING )?INDEX idx_sessions_expires_at/i.test(detail)),
    "Expired-session DELETE does not use idx_sessions_expires_at: " + sessionDeletePlan.join(" | "));
  check(sessionDeletePlan.every((detail) => !/\bSCAN sessions\b/i.test(detail)),
    "Expired-session DELETE still performs a sessions table scan: " + sessionDeletePlan.join(" | "));

  const beforeSecondRun = JSON.stringify({
    rows,
    best,
    user,
    userColumns,
    sessionIndexNames,
    sessionDeletePlan
  });
  const secondReport = migrateDatabase(copy);
  const afterSecondRun = JSON.stringify({
    rows: copy.prepare("SELECT mode, ruleset_version AS rulesetVersion FROM arena_leaderboard ORDER BY id").all(),
    best: copy.prepare(`
      SELECT user_id AS userId, mode, ruleset_version AS rulesetVersion, best
      FROM arena_user_best
    `).all(),
    user: copy.prepare("SELECT id, google_sub AS googleSub, name, created_at AS createdAt FROM users").get(),
    userColumns: tableColumns(copy, "users").map((column) => column.name).sort(),
    sessionIndexNames: copy.prepare("PRAGMA index_list(sessions)").all()
      .map((index) => index.name)
      .sort(),
    sessionDeletePlan: copy.prepare(
      "EXPLAIN QUERY PLAN DELETE FROM sessions WHERE expires_at <= ?"
    ).all("2026-07-22T00:00:00.000Z").map((row) => String(row.detail || ""))
  });
  check(!allFalse(firstReport), "First migration incorrectly reported no work");
  check(allFalse(secondReport), "Second migration was not a no-op");
  check(beforeSecondRun === afterSecondRun, "Second migration changed preserved data");
    return {
      sourceRows: 33,
      preservedRows: rows.length,
      backfill: "mode=arena,rulesetVersion=1",
      userColumns,
      sessionDeletePlan,
      sessionExpiryIndexCount: 1,
      secondRun: "no-op"
    };
  } finally {
    if (copy.open) copy.close();
    removeDatabaseFiles(legacyPath);
    removeDatabaseFiles(copiedPath);
  }
}

function verifyLimiterEviction() {
  let now = 1_000;
  const limiter = new TtlRateLimiter({
    maxAttempts: 2,
    windowMs: 500,
    maxEntries: 32,
    now: () => now
  });
  let accepted = 0;
  for (let index = 0; index < 5_000; index += 1) {
    if (limiter.allow("198.51.100." + index)) accepted += 1;
  }
  check(accepted === 32, "Bounded limiter did not fail closed at its key cap");
  check(limiter.size === 32, "Limiter Map grew beyond its configured bound");
  now += 501;
  limiter.evictExpired();
  check(limiter.size === 0, "Limiter did not evict expired keys by TTL");
  check(limiter.allow("203.0.113.1"), "Limiter did not admit a key after TTL eviction");
  return { inserted: 5000, maximumSize: 32, sizeAfterTtl: 0 };
}

async function verifyNoPerRequestSessionSweep(baseUrl, cookie) {
  const expiredTokenHash = "expired-session-request-path-proof";
  const probe = new Database(databasePath);
  try {
    const user = probe.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get();
    check(user && user.id, "Session sweep probe could not find its fixture user");
    probe.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      expiredTokenHash,
      user.id,
      "2000-01-01T00:00:00.000Z",
      "2000-01-02T00:00:00.000Z"
    );
  } finally {
    probe.close();
  }

  const identity = await jsonResponse(baseUrl, "/auth/me", {
    headers: ipHeaders("192.0.2.70", { cookie })
  });
  check(identity.response.status === 200 && identity.body.user,
    "Identity lookup failed during the per-request sweep probe");

  const afterLookup = new Database(databasePath);
  let remaining;
  try {
    remaining = afterLookup.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?"
    ).get(expiredTokenHash).count;
  } finally {
    afterLookup.close();
  }
  check(remaining === 1, "Identity lookup still swept expired sessions per request");

  const removed = _test.cleanupExpiredSessions();
  check(removed >= 1, "Maintenance session cleanup did not remove the expired probe row");
  const afterMaintenance = new Database(databasePath);
  try {
    check(afterMaintenance.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?"
    ).get(expiredTokenHash).count === 0, "Maintenance left the expired session probe row behind");
  } finally {
    afterMaintenance.close();
  }
  return { afterIdentityLookup: remaining, maintenanceRemoved: removed };
}

async function verifyNewEndpointRateLimits(baseUrl, cookie) {
  const budgets = _test.constants.rateLimits;
  const sharedHeaders = ipHeaders("192.0.2.200", { cookie });
  const probes = [
    {
      key: "runStart",
      label: "POST /arena/run/start",
      route: "/arena/run/start",
      method: "POST",
      json: { mode: "arena" }
    },
    { key: "bestRead", label: "GET /arena/best", route: "/arena/best?mode=arena" },
    {
      key: "leaderboardRead",
      label: "GET /arena/leaderboard",
      route: "/arena/leaderboard?mode=arena"
    },
    { key: "profileRead", label: "GET /user/profile", route: "/user/profile" },
    {
      key: "profileWrite",
      label: "PUT /user/profile",
      route: "/user/profile",
      method: "PUT",
      json: { settings: { arenaQuality: "high" } }
    },
    { key: "authMe", label: "GET /auth/me", route: "/auth/me" }
  ];
  const evidence = {};

  for (const probe of probes) {
    const budget = budgets[probe.key];
    check(Number.isInteger(budget) && budget > 0, `Missing limiter budget for ${probe.label}`);
    let last = null;
    for (let attempt = 1; attempt <= budget + 1; attempt += 1) {
      const options = { headers: sharedHeaders };
      if (probe.method) options.method = probe.method;
      if (probe.json !== undefined) options.json = probe.json;
      last = await jsonResponse(baseUrl, probe.route, options);
      if (attempt <= budget) {
        check(last.response.status === 200,
          `${probe.label} rejected allowed request ${attempt}/${budget}`);
      } else {
        check(last.response.status === 429, `${probe.label} did not reject request ${attempt}`);
        check(last.body && last.body.ok === false && typeof last.body.error === "string" && last.body.error,
          `${probe.label} 429 body is not the short JSON error shape`);
      }
    }
    evidence[probe.label] = {
      budget,
      firstRejectedAttempt: budget + 1,
      status: last.response.status,
      error: last.body.error
    };
  }

  const sizes = _test.rateLimiterSizes();
  check(Object.values(sizes).every((size) => size <= _test.constants.scoreLimiterMaxEntries),
    "A newly added endpoint limiter exceeded its bounded-map cap");
  evidence.mapSizes = sizes;
  return evidence;
}

async function run() {
  let started = false;
  let boundPort = null;
  let migrationEvidence;
  let limiterEvidence;
  let productionSecretEvidence;
  let ceilingEvidence;
  let forgedEvidence;
  let oversizedForgeryEvidence;
  let legitimateEvidence;
  let sessionSweepEvidence;
  let endpointLimitEvidence;
  try {
    verifyGeneratedKeyFallback();
    productionSecretEvidence = verifyProductionSecretFailure();
    migrationEvidence = verifyMigrationProof();
    limiterEvidence = verifyLimiterEviction();
    ceilingEvidence = verifyAbsoluteScoreCeilings();

    await startServer(0);
    started = true;
    const address = server.address();
    check(address && typeof address === "object", "Server did not expose a bound address");
    boundPort = address.port;
    const baseUrl = "http://127.0.0.1:" + boundPort;

    const staticRoutes = [
      "/", "/styles.css", "/classicAdventure.js", "/client.js", "/profile.js",
      "/auth.js", "/launcher.js", "/arena/arena.css", "/arena/arenaRules.js",
      "/arena/arena.js", "/manifest.webmanifest", "/sw.js", "/icons/icon.svg",
      "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-icon.svg",
      "/icons/maskable-icon-512.png"
    ];
    for (const route of staticRoutes) {
      const response = await request(baseUrl, route);
      const body = await response.arrayBuffer();
      check(response.status === 200, "Static route failed: " + route + " (" + response.status + ")");
      check(body.byteLength > 0, "Static route returned an empty body: " + route);
    }

    // Content-addressed shell assets (S14). The point of the whole change is that a deploy
    // moves the asset URL, so a four-hour edge cache cannot serve stale JS against fresh HTML.
    const shell = renderShell();
    check(/^[0-9a-f]{12}$/.test(shell.hash), "Shell hash is not a 12-character hex digest");

    const servedHome = await (await request(baseUrl, "/")).text();
    for (const asset of HASHED_ASSETS) {
      check(
        servedHome.includes('"/a/' + shell.hash + asset + '"'),
        "Served HTML does not point at the content-addressed " + asset
      );
      check(
        !servedHome.includes('"' + asset + '"'),
        "Served HTML still carries the unhashed reference to " + asset +
        ", so returning players can run it stale"
      );
    }

    const hashedAsset = await request(baseUrl, "/a/" + shell.hash + "/arena/arena.js");
    const hashedBody = await hashedAsset.text();
    check(hashedAsset.status === 200, "A content-addressed asset did not serve");
    const immutableHeader = hashedAsset.headers.get("cache-control") || "";
    check(
      immutableHeader.includes("immutable") && immutableHeader.includes("max-age=31536000"),
      "The current hash must be promised immutable, got: " + immutableHeader
    );
    const plainAsset = await request(baseUrl, "/arena/arena.js");
    check(hashedBody === await plainAsset.text(),
      "The content-addressed asset served different bytes from its real path");

    // A stale reference must still WORK. It is the one request a client with an old sw.js
    // makes, and a 404 there would break the shell rather than quietly self-heal.
    const staleHash = await request(baseUrl, "/a/000000000000/arena/arena.js");
    check(staleHash.status === 200, "A stale asset hash must still serve, not 404");
    const staleHeader = staleHash.headers.get("cache-control") || "";
    check(!staleHeader.includes("immutable"),
      "A stale hash must NOT be promised immutable, got: " + staleHeader);
    await staleHash.text();

    const missingHashed = await request(baseUrl, "/a/" + shell.hash + "/not-a-real-asset.js");
    check(missingHashed.status === 404, "A missing asset under a valid hash must 404");
    await missingHashed.text();

    for (const escape of ["/a/" + shell.hash + "/../server.js",
                          "/a/" + shell.hash + "/../../server.js"]) {
      const climbed = await request(baseUrl, escape);
      check(climbed.status !== 200, "Path traversal served a file: " + escape);
      await climbed.text();
    }

    const servedWorker = await (await request(baseUrl, "/sw.js")).text();
    check(servedWorker.includes('"retro-snake-arena-v47-' + shell.hash + '"'),
      "The served service worker does not stamp the shell hash into its cache name");
    for (const asset of HASHED_ASSETS) {
      check(servedWorker.includes('"/a/' + shell.hash + asset + '"'),
        "The served service worker pre-caches the unhashed " + asset);
    }

    // The files ON DISK must stay canonical. Nothing is generated into public/, which is what
    // lets scripts/validate-app-assets.js keep asserting against the real source unchanged.
    const diskHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    check(diskHtml.includes('src="/client.js"'),
      "public/index.html was rewritten on disk; the rewrite must happen at serve time only");

    const home = await request(baseUrl, "/");
    const csp = home.headers.get("content-security-policy") || "";
    check(home.headers.get("x-content-type-options") === "nosniff", "nosniff header is missing");
    check(home.headers.get("x-frame-options") === "SAMEORIGIN", "frame protection header is missing");
    check((home.headers.get("permissions-policy") || "").includes("camera=()"), "permissions policy is missing");
    check(!csp.includes("ws:") && !csp.includes("wss:"), "CSP still permits removed WebSocket connections");
    await home.text();

    let result = await jsonResponse(baseUrl, "/health");
    check(result.response.status === 200 && result.body.ok === true &&
      result.body.app === "retro-snake-arena", "Detailed health payload is wrong");
    check(Object.keys(result.body).length === 2, "Health payload exposes removed runtime state");
    check(JSON.stringify(_test.healthPayload(false)) === JSON.stringify({ ok: true }),
      "Minimal health payload changed");

    for (const route of ["/arena/arenaNet.js", "/arena/rooms", "/leaderboard"]) {
      const response = await request(baseUrl, route);
      await response.text();
      check(response.status === 404, "Removed route is still served: " + route);
    }

    for (const route of ["/auth/register", "/auth/login"]) {
      const removed = await jsonResponse(baseUrl, route, {
        method: "POST",
        headers: ipHeaders("198.51.100.2"),
        json: { email: "removed@example.test", password: "unused-password" }
      });
      check(removed.response.status === 404, "Legacy password route is still installed: " + route);
    }

    for (const mode of _test.constants.modes) {
      result = await jsonResponse(baseUrl, "/arena/leaderboard?mode=" + mode);
      check(result.response.status === 200 && Array.isArray(result.body) && result.body.length === 0,
        `Empty ${mode} leaderboard payload is wrong`);
      result = await jsonResponse(baseUrl, "/arena/best?mode=" + mode);
      check(result.response.status === 200 && result.body.loggedIn === false &&
        result.body.mode === mode && result.body.personalBest === null &&
        result.body.globalTop === 0 && result.body.globalTopName === null,
      `Empty ${mode} best payload is wrong`);
    }

    result = await jsonResponse(baseUrl, "/arena/best?mode=ARENA");
    check(result.response.status === 400, "Uppercase mode was accepted");
    result = await jsonResponse(baseUrl, "/arena/leaderboard");
    check(result.response.status === 400, "Missing leaderboard mode was accepted");
    result = await jsonResponse(baseUrl, "/arena/leaderboard?mode=arena&limit=51");
    check(result.response.status === 400, "Oversized leaderboard limit was accepted");
    result = await jsonResponse(baseUrl, "/arena/run/start", {
      method: "POST", json: { mode: "other" }
    });
    check(result.response.status === 400, "Invalid run-start mode was accepted");

    result = await submitScore(baseUrl, {
      mode: "arena", name: "Missing", score: 10, durationMs: 1000
    }, ipHeaders("198.51.100.10"));
    check(result.response.status === 400, "Score without a run token was accepted");

    // Leaderboard identity is exactly 3 initials (A-Z, 0-9): reject, never sanitise.
    for (const badName of ["AB", "ABCD", "A<1", "a b", "", "Player"]) {
      const badInitialsRun = await startRun(baseUrl, "arena");
      result = await submitScore(
        baseUrl,
        scoreBody("arena", badInitialsRun.runToken, 10, 1000, badName),
        ipHeaders("198.51.100.21")
      );
      check(result.response.status === 400 && /initials/i.test(result.body.error),
        `Score with invalid initials "${badName}" was accepted`);
    }

    const forgedStart = await startRun(baseUrl, "arena");
    const [forgedPayload, forgedSignature] = forgedStart.runToken.split(".");
    const forgedToken = forgedPayload + "." +
      (forgedSignature[0] === "A" ? "B" : "A") + forgedSignature.slice(1);
    result = await submitScore(
      baseUrl,
      scoreBody("arena", forgedToken, 42, 1000, "FOR"),
      ipHeaders("198.51.100.11")
    );
    check(result.response.status === 400, "Forged run token was accepted");
    forgedEvidence = { status: result.response.status, body: result.body };

    const now = Date.now();
    const expired = _test.issueRunToken("arena", "anonymous", {
      issuedAt: now - 10_000,
      expiry: now - 1
    });
    result = await submitScore(
      baseUrl,
      scoreBody("arena", expired.runToken, 20, 1000, "EXP"),
      ipHeaders("198.51.100.12")
    );
    check(result.response.status === 400 && /expired/i.test(result.body.error),
      "Expired run token was not rejected");

    const wrongMode = await startRun(baseUrl, "arena");
    result = await submitScore(
      baseUrl,
      scoreBody("classic", wrongMode.runToken, 10, 3000, "WRO"),
      ipHeaders("198.51.100.13")
    );
    check(result.response.status === 400 && /different mode/i.test(result.body.error),
      "Wrong-mode run token was not rejected");

    const implausible = await startRun(baseUrl, "arena");
    result = await submitScore(
      baseUrl,
      scoreBody("arena", implausible.runToken, 1_000_000, 17, "IMP"),
      ipHeaders("198.51.100.14")
    );
    check(result.response.status === 400 && /plausible/i.test(result.body.error),
      "Implausible Arena score was accepted");

    const shortClassic = await startRun(baseUrl, "classic");
    result = await submitScore(
      baseUrl,
      scoreBody("classic", shortClassic.runToken, 10, 2000, "TSH"),
      ipHeaders("198.51.100.15")
    );
    check(result.response.status === 400 && /short/i.test(result.body.error),
      "Implausibly short Classic run was accepted");

    const oversizedRune = await startRun(baseUrl, "rune");
    result = await submitScore(
      baseUrl,
      scoreBody("rune", oversizedRune.runToken, 801, 4360, "TMU"),
      ipHeaders("198.51.100.16")
    );
    check(result.response.status === 400, "Rune score above its absolute cap was accepted");

    const noGameplayRuns = {
      arena: await startRun(baseUrl, "arena"),
      classic: await startRun(baseUrl, "classic"),
      rune: await startRun(baseUrl, "rune")
    };
    const forgeryWaitMs = Math.max(
      _test.constants.plausibility.arena.minDurationMs,
      _test.constants.plausibility.classic.minDurationMs,
      _test.constants.plausibility.rune.minDurationMs
    ) + 100;
    await new Promise((resolve) => setTimeout(resolve, forgeryWaitMs));

    oversizedForgeryEvidence = { waitedMs: forgeryWaitMs };
    for (const [index, mode] of ["arena", "classic"].entries()) {
      const rules = _test.constants.plausibility[mode];
      const oversizedScore = rules.maxScore + 1;
      result = await submitScore(
        baseUrl,
        scoreBody(mode, noGameplayRuns[mode].runToken, oversizedScore, rules.minDurationMs, "NOG"),
        ipHeaders("198.51.100." + (60 + index))
      );
      check(result.response.status === 400 && /plausible/i.test(result.body.error),
        `No-gameplay ${mode} score above ${rules.maxScore} was accepted`);
      oversizedForgeryEvidence[mode] = {
        maxScore: rules.maxScore,
        submittedScore: oversizedScore,
        status: result.response.status,
        error: result.body.error
      };
    }

    const runeRules = _test.constants.plausibility.rune;
    result = await submitScore(
      baseUrl,
      scoreBody("rune", noGameplayRuns.rune.runToken, runeRules.maxScore, runeRules.minDurationMs,
        "RUN"),
      ipHeaders("198.51.100.62")
    );
    check(result.response.status === 200 && result.body.ok === true,
      "Legitimate Rune ceiling baseline was rejected");
    oversizedForgeryEvidence.rune = {
      submittedScore: runeRules.maxScore,
      status: result.response.status,
      accepted: true
    };

    const guestRun = await startRun(baseUrl, "arena");
    result = await submitScore(
      baseUrl,
      scoreBody("arena", guestRun.runToken, 42, 1000, "GUE"),
      ipHeaders("198.51.100.17")
    );
    check(result.response.status === 200 && result.body.ok === true &&
      result.body.loggedIn === false && result.body.mode === "arena" &&
      result.body.personalBest === false && result.body.previousBest === 0 &&
      result.body.best === 42 && result.body.globalBest === false && result.body.globalTop === 0,
    "Valid anonymous score response is wrong");
    legitimateEvidence = { status: result.response.status, body: result.body };

    result = await submitScore(
      baseUrl,
      scoreBody("arena", guestRun.runToken, 42, 1000, "GU2"),
      ipHeaders("198.51.100.18")
    );
    check(result.response.status === 400 && /already been used/i.test(result.body.error),
      "Replayed run token was accepted");
    result = await jsonResponse(baseUrl, "/arena/leaderboard?mode=arena");
    check(result.body.length === 0, "Anonymous score leaked into the shared board");

    const expiring = _test.issueRunToken("arena", "anonymous", {
      issuedAt: Date.now() - 1000,
      expiry: Date.now() + 250
    });
    result = await submitScore(
      baseUrl,
      scoreBody("arena", expiring.runToken, 1, 1000, "EX2"),
      ipHeaders("198.51.100.19")
    );
    check(result.response.status === 200, "Short-lived valid token was not accepted");
    const spentBeforeCleanup = _test.countSpentRunTokens();
    await new Promise((resolve) => setTimeout(resolve, 275));
    check(_test.cleanupExpiredRunTokens() >= 1, "Expired spent-token cleanup removed nothing");
    check(_test.countSpentRunTokens() < spentBeforeCleanup,
      "Expired spent-token row remained after cleanup");

    const cookie = _test.createUserSession("smoke-google-sub", "Owner");
    check(_test.countUsers() === 1, "Unexpected account count after signed-in fixture creation");
    result = await jsonResponse(baseUrl, "/auth/me", { headers: { cookie } });
    check(result.response.status === 200 && result.body.user && result.body.user.name === "Owner",
      "Google-sub-only session lookup failed");
    check(result.body.user.email === undefined && result.body.user.googleSub === undefined,
      "Auth response exposed an email or Google subject");
    sessionSweepEvidence = await verifyNoPerRequestSessionSweep(baseUrl, cookie);

    result = await jsonResponse(baseUrl, "/user/profile", {
      method: "PUT",
      headers: { cookie },
      json: {
        displayName: "<Arena Hero>",
        settings: {
          arenaQuality: "high",
          arenaSoundOn: true,
          arenaHeadShape: "viper",
          secretSetting: "must not persist"
        }
      }
    });
    check(result.response.status === 200 && result.body.ok === true, "Profile update failed");
    result = await jsonResponse(baseUrl, "/user/profile", { headers: { cookie } });
    check(result.body.displayName === "Arena Hero", "Profile display name was not sanitized");
    check(result.body.settings.arenaQuality === "high" && result.body.settings.arenaSoundOn === "true",
      "Allowed profile settings were not saved");
    check(result.body.settings.secretSetting === undefined, "Disallowed profile setting was saved");
    result = await jsonResponse(baseUrl, "/auth/me", { headers: { cookie } });
    check(result.body.user.name === "Arena Hero", "Chosen display name did not become the account name");

    const signedScores = {
      arena: { score: 500, durationMs: 1000 },
      classic: { score: 400, durationMs: 3000 },
      rune: { score: 600, durationMs: 4360 }
    };
    for (const [mode, values] of Object.entries(signedScores)) {
      const run = await startRun(baseUrl, mode, { cookie });
      result = await submitScore(
        baseUrl,
        scoreBody(mode, run.runToken, values.score, values.durationMs, "ARH"),
        ipHeaders("203.0.113." + (20 + Object.keys(signedScores).indexOf(mode)), { cookie })
      );
      check(result.response.status === 200 && result.body.ok === true &&
        result.body.loggedIn === true && result.body.mode === mode &&
        result.body.personalBest === true && result.body.previousBest === 0 &&
        result.body.best === values.score && result.body.globalBest === true &&
        result.body.globalTop === values.score,
      `Signed-in ${mode} score response is wrong`);
    }

    for (const [mode, values] of Object.entries(signedScores)) {
      result = await jsonResponse(baseUrl, "/arena/best?mode=" + mode, { headers: { cookie } });
      check(result.body.loggedIn === true && result.body.mode === mode &&
        result.body.personalBest === values.score && result.body.globalTop === values.score &&
        result.body.globalTopName === "ARH",
      `${mode} best endpoint is not mode-separated`);
      result = await jsonResponse(baseUrl, "/arena/leaderboard?mode=" + mode + "&limit=10");
      check(result.body.length === 1 && result.body[0].score === values.score,
        `${mode} leaderboard is not mode-separated`);
      check(
        JSON.stringify(Object.keys(result.body[0]).sort()) ===
          JSON.stringify(["createdAt", "name", "score"].sort()),
        `${mode} leaderboard row shape drifted from the API contract`
      );
    }

    const signedToken = await startRun(baseUrl, "arena", { cookie });
    result = await submitScore(
      baseUrl,
      scoreBody("arena", signedToken.runToken, 300, 1000, "NOC"),
      ipHeaders("203.0.113.30")
    );
    check(result.response.status === 400 && /different player/i.test(result.body.error),
      "Signed-in run token was accepted without its session");

    const sanitizedRun = await startRun(baseUrl, "arena", { cookie });
    result = await submitScore(
      baseUrl,
      scoreBody("arena", sanitizedRun.runToken, 501, 1000, "her"),
      ipHeaders("203.0.113.31", { cookie })
    );
    check(result.response.status === 200, "Signed score with lowercase initials was rejected");
    result = await jsonResponse(baseUrl, "/arena/leaderboard?mode=arena");
    check(result.body.some((row) => row.name === "HER"), "Leaderboard initials were not uppercased");
    check(result.body.every((row) => !/[<>]/.test(row.name)),
      "Leaderboard returned a name containing markup");

    // A signed-in run that is NOT a new personal best is accepted but adds no row.
    const rowsBeforeRepeat = _test.countLeaderboardRows("arena");
    const repeatRun = await startRun(baseUrl, "arena", { cookie });
    result = await submitScore(
      baseUrl,
      scoreBody("arena", repeatRun.runToken, 200, 1000, "ARH"),
      ipHeaders("203.0.113.32", { cookie })
    );
    check(result.response.status === 200 && result.body.personalBest === false &&
      result.body.best === 501,
      "Signed-in repeat run response is wrong");
    check(_test.countLeaderboardRows("arena") === rowsBeforeRepeat,
      "A run that was not a personal best added a leaderboard row");

    for (let score = 1; score <= 230; score += 1) {
      _test.recordArenaScore("SED", 1000 + score, "arena");
    }
    for (let score = 1; score <= 25; score += 1) {
      _test.recordArenaScore("CSE", 700 + score, "classic");
    }
    check(_test.countLeaderboardRows("arena") <= 200, "Arena retention cap failed");
    check(_test.countLeaderboardRows("classic") === 26,
      "Busy Arena mode evicted Classic score history");
    result = await jsonResponse(baseUrl, "/arena/leaderboard?mode=arena&limit=10");
    check(result.body.length === 10, "Arena leaderboard did not honor limit=10");
    for (let index = 1; index < result.body.length; index += 1) {
      check(result.body[index - 1].score >= result.body[index].score,
        "Arena leaderboard is not score-sorted");
    }

    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const run = await startRun(baseUrl, "arena");
      result = await submitScore(
        baseUrl,
        scoreBody("arena", run.runToken, attempt, 1000, "LIM"),
        ipHeaders("192.0.2.44")
      );
      if (attempt <= 10) check(result.response.status === 200,
        "Score limiter rejected allowed request " + attempt);
      else check(result.response.status === 429, "Score limiter did not reject request 11");
    }
    check(_test.scoreLimiterSize <= _test.constants.scoreLimiterMaxEntries,
      "Server score limiter exceeded its hard key bound");
    check(_test.authLimiterSize <= _test.constants.authLimiterMaxEntries,
      "Auth limiter exceeded its hard key bound");
    endpointLimitEvidence = await verifyNewEndpointRateLimits(baseUrl, cookie);

    result = await jsonResponse(baseUrl, "/auth/logout", {
      method: "POST",
      headers: { cookie, "x-forwarded-proto": "https" }
    });
    check(result.response.status === 200 && result.body.ok === true, "Logout failed");
    const clearedCookie = result.response.headers.get("set-cookie") || "";
    check(clearedCookie.includes("HttpOnly") && clearedCookie.includes("SameSite=Lax") &&
      clearedCookie.includes("Secure") && clearedCookie.includes("Max-Age=0"),
    "Logout cookie lost its security attributes");
    result = await jsonResponse(baseUrl, "/auth/me", { headers: { cookie } });
    check(result.body.user === null, "Logged-out session remained valid");

    console.log("Migration proof: " + JSON.stringify(migrationEvidence));
    console.log("Limiter eviction proof: " + JSON.stringify(limiterEvidence));
    console.log("Production secret proof: " + JSON.stringify(productionSecretEvidence));
    console.log("Score ceiling derivation proof: " + JSON.stringify(ceilingEvidence));
    console.log("Negative test evidence (forged rejected): " + JSON.stringify(forgedEvidence));
    console.log("No-gameplay ceiling proof: " + JSON.stringify(oversizedForgeryEvidence));
    console.log("Negative test evidence (legitimate accepted): " + JSON.stringify(legitimateEvidence));
    console.log("Session request-path cleanup proof: " + JSON.stringify(sessionSweepEvidence));
    console.log("Endpoint limiter proof: " + JSON.stringify(endpointLimitEvidence));
    console.log("Smoke test passed:");
    console.log("- per-mode/ruleset leaderboard, best, retention and response shapes");
    console.log("- HMAC token missing/forged/expired/replayed/wrong-mode/player binding");
    console.log("- derived absolute ceilings, 30-minute TTL and Arena/Classic no-gameplay rejection");
    console.log("- unchanged legitimate Rune baseline and anonymous-vs-signed-in persistence");
    console.log("- all newly limited routes/methods return 429 after independent bounded budgets");
    console.log("- indexed timer cleanup with no identity-request session sweep");
    console.log("- production missing-secret refusal before listen");
    console.log("- copied legacy database preservation/backfill/idempotence and limiter eviction");
  } finally {
    if (started) await stopServer();
    check(!server.listening, "Smoke-test server is still listening after stopServer()");
    _test.closeDatabase();
    removeDatabaseFiles(databasePath);
    removeDatabaseFiles(tempStem + "-legacy.sqlite");
    removeDatabaseFiles(tempStem + "-legacy-copy.sqlite");
    removeDatabaseFiles(tempStem + "-production.sqlite");

    if (boundPort !== null) {
      let stillReachable = false;
      try {
        const response = await fetch("http://127.0.0.1:" + boundPort + "/health", {
          signal: AbortSignal.timeout(250)
        });
        stillReachable = response.ok;
      } catch {
        stillReachable = false;
      }
      check(!stillReachable, "Stopped smoke listener is still reachable on port " + boundPort);
    }
    console.log("Smoke cleanup verified: listener unreachable, server stopped, temporary databases removed");
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
