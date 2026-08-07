"use strict";

const path = require("path");
const Database = require("better-sqlite3");
const { MODES, RULESET_VERSION } = require("./integrity");

function openDatabase(dbPath = process.env.DB_PATH || path.join(__dirname, "..", "leaderboard.sqlite")) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db);
  return db;
}

function migrateDatabase(db) {
  const report = {
    arenaLeaderboard: ensureArenaLeaderboard(db),
    arenaUserBest: ensureArenaUserBest(db),
    users: ensureUsers(db),
    sessions: ensureSessions(db),
    userProfile: ensureUserProfile(db),
    spentRunTokens: ensureSpentRunTokens(db)
  };
  return report;
}

function ensureArenaLeaderboard(db) {
  let changed = false;
  if (!tableExists(db, "arena_leaderboard")) {
    db.prepare(`
      CREATE TABLE arena_leaderboard (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'arena' CHECK (mode IN ('arena', 'classic', 'rune')),
        ruleset_version INTEGER NOT NULL DEFAULT ${RULESET_VERSION},
        created_at TEXT NOT NULL
      )
    `).run();
    changed = true;
  } else {
    let columns = tableColumns(db, "arena_leaderboard");
    if (!columns.some((column) => column.name === "mode")) {
      db.prepare("ALTER TABLE arena_leaderboard ADD COLUMN mode TEXT NOT NULL DEFAULT 'arena'").run();
      changed = true;
      columns = tableColumns(db, "arena_leaderboard");
    }
    if (!columns.some((column) => column.name === "ruleset_version")) {
      db.prepare(`ALTER TABLE arena_leaderboard ADD COLUMN ruleset_version INTEGER NOT NULL DEFAULT ${RULESET_VERSION}`).run();
      changed = true;
    }
    const repairedModes = db.prepare(
      "UPDATE arena_leaderboard SET mode = 'arena' WHERE mode IS NULL OR mode NOT IN ('arena', 'classic', 'rune')"
    ).run().changes;
    const repairedVersions = db.prepare(
      `UPDATE arena_leaderboard SET ruleset_version = ${RULESET_VERSION} WHERE ruleset_version IS NULL OR ruleset_version < 1`
    ).run().changes;
    changed = changed || repairedModes > 0 || repairedVersions > 0;
  }

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_arena_leaderboard_mode_ruleset_score
    ON arena_leaderboard (mode, ruleset_version, score DESC, created_at ASC)
  `).run();
  return changed;
}

function ensureArenaUserBest(db) {
  if (!tableExists(db, "arena_user_best")) {
    createArenaUserBestTable(db, "arena_user_best");
    return true;
  }

  const columns = tableColumns(db, "arena_user_best");
  const primaryKey = columns.filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  const targetPrimaryKey = ["user_id", "mode", "ruleset_version"];
  const hasRequiredColumns = ["user_id", "mode", "ruleset_version", "name", "best", "updated_at"]
    .every((name) => columns.some((column) => column.name === name));
  const correctPrimaryKey = JSON.stringify(primaryKey) === JSON.stringify(targetPrimaryKey);
  if (hasRequiredColumns && correctPrimaryKey) return false;

  const hasMode = columns.some((column) => column.name === "mode");
  const hasRuleset = columns.some((column) => column.name === "ruleset_version");
  const rows = db.prepare(`
    SELECT user_id AS userId,
           ${hasMode ? "mode" : "'arena'"} AS mode,
           ${hasRuleset ? "ruleset_version" : String(RULESET_VERSION)} AS rulesetVersion,
           name, best, updated_at AS updatedAt
    FROM arena_user_best
  `).all();

  const bestRows = new Map();
  for (const row of rows) {
    const mode = MODES.includes(row.mode) ? row.mode : "arena";
    const rulesetVersion = Number.isInteger(row.rulesetVersion) && row.rulesetVersion > 0
      ? row.rulesetVersion
      : RULESET_VERSION;
    const key = `${row.userId}:${mode}:${rulesetVersion}`;
    const current = bestRows.get(key);
    if (!current || Number(row.best) > Number(current.best)) {
      bestRows.set(key, { ...row, mode, rulesetVersion });
    }
  }

  db.transaction(() => {
    db.prepare("DROP TABLE IF EXISTS arena_user_best_v2_migration").run();
    createArenaUserBestTable(db, "arena_user_best_v2_migration");
    const insert = db.prepare(`
      INSERT INTO arena_user_best_v2_migration
        (user_id, mode, ruleset_version, name, best, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of bestRows.values()) {
      insert.run(row.userId, row.mode, row.rulesetVersion, row.name, row.best, row.updatedAt);
    }
    db.prepare("DROP TABLE arena_user_best").run();
    db.prepare("ALTER TABLE arena_user_best_v2_migration RENAME TO arena_user_best").run();
  })();
  return true;
}

function ensureUsers(db) {
  if (!tableExists(db, "users")) {
    createUsersTable(db, "users");
    return true;
  }

  const columns = tableColumns(db, "users");
  const names = new Set(columns.map((column) => column.name));
  const forbidden = ["email", "password_hash", "password_salt"];
  const googleColumn = columns.find((column) => column.name === "google_sub");
  const exactColumns = ["id", "google_sub", "name", "created_at"].every((name) => names.has(name)) &&
    forbidden.every((name) => !names.has(name));
  const googleIsRequired = googleColumn && googleColumn.notnull === 1;
  if (exactColumns && googleIsRequired && hasUniqueSingleColumnIndex(db, "users", "google_sub")) {
    return false;
  }

  const hasGoogleSub = names.has("google_sub");
  const hasName = names.has("name");
  const hasCreatedAt = names.has("created_at");
  const rows = db.prepare(`
    SELECT id,
           ${hasGoogleSub ? "google_sub" : "NULL"} AS googleSub,
           ${hasName ? "name" : "'Player'"} AS name,
           ${hasCreatedAt ? "created_at" : "NULL"} AS createdAt
    FROM users
    ORDER BY id ASC
  `).all();

  const seenSubjects = new Set();
  const migratedRows = rows.map((row) => {
    let googleSub = String(row.googleSub || "").trim();
    if (!googleSub || seenSubjects.has(googleSub)) googleSub = `legacy-unlinked:${row.id}`;
    seenSubjects.add(googleSub);
    return {
      id: row.id,
      googleSub,
      name: String(row.name || "Player"),
      createdAt: row.createdAt || new Date(0).toISOString()
    };
  });

  const foreignKeysWereEnabled = Boolean(db.pragma("foreign_keys", { simple: true }));
  if (foreignKeysWereEnabled) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.prepare("DROP TABLE IF EXISTS users_v2_migration").run();
      createUsersTable(db, "users_v2_migration");
      const insert = db.prepare(`
        INSERT INTO users_v2_migration (id, google_sub, name, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const row of migratedRows) insert.run(row.id, row.googleSub, row.name, row.createdAt);
      db.prepare("DROP TABLE users").run();
      db.prepare("ALTER TABLE users_v2_migration RENAME TO users").run();
    })();
  } finally {
    if (foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
  }
  return true;
}

function ensureSessions(db) {
  const created = !tableExists(db, "sessions");
  if (created) {
    db.prepare(`
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `).run();
  }
  db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at)").run();
  return created;
}

function ensureUserProfile(db) {
  if (tableExists(db, "user_profile")) return false;
  db.prepare(`
    CREATE TABLE user_profile (
      user_id INTEGER PRIMARY KEY,
      display_name TEXT,
      settings TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `).run();
  return true;
}

function ensureSpentRunTokens(db) {
  const created = !tableExists(db, "spent_run_tokens");
  if (created) {
    db.prepare(`
      CREATE TABLE spent_run_tokens (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )
    `).run();
  }
  db.prepare("CREATE INDEX IF NOT EXISTS idx_spent_run_tokens_expiry ON spent_run_tokens (expires_at)").run();
  return created;
}

function createArenaUserBestTable(db, tableName) {
  db.prepare(`
    CREATE TABLE ${tableName} (
      user_id INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('arena', 'classic', 'rune')),
      ruleset_version INTEGER NOT NULL,
      name TEXT NOT NULL,
      best INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, mode, ruleset_version)
    )
  `).run();
}

function createUsersTable(db, tableName) {
  db.prepare(`
    CREATE TABLE ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function hasUniqueSingleColumnIndex(db, tableName, columnName) {
  const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all();
  return indexes.some((index) => {
    if (!index.unique) return false;
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all();
    return columns.length === 1 && columns[0].name === columnName;
  });
}

module.exports = {
  openDatabase,
  migrateDatabase,
  tableExists,
  tableColumns
};
