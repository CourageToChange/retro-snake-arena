"use strict";

// Content-addressed URLs for the shell's CSS and JS, computed at startup.
//
// WHY. Measured 2026-09-16: the origin sends `Cache-Control: public, max-age=0` on everything,
// and Cloudflare rewrites that to `max-age=14400` for static extensions while leaving `/` alone
// (it is classified DYNAMIC). So a returning player could run four-hour-old JS against a
// freshly deployed page, and `/sw.js` was getting the same 4 hours, which makes a stale updater.
//
// The zone's Browser Cache TTL is what does the rewriting, and the API grant cannot read or
// write zone settings, so shortening it is not available to us. A content-addressed URL
// sidesteps the TTL completely instead: a URL the edge has never seen cannot be stale.
//
// HOW, and why it is shaped this way. This project has no build step, by design, and no
// dependencies. Adding a bundler to fix a caching wrinkle would be a bad trade. So the hash is
// computed from the file contents when the server boots, the files on disk keep their real
// names, and `/` and `/sw.js` are rewritten as they are served. Nothing on disk is generated,
// so there is nothing to keep in sync by hand and no drift to guard against.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Only the files that actually change on a deploy. Fonts and icons are excluded deliberately:
// they are stable, a stale icon harms nobody, and keeping the set small keeps the hash stable
// across deploys that did not touch behaviour.
const HASHED_ASSETS = [
  "/styles.css",
  "/arena/arena.css",
  "/classicAdventure.js",
  "/client.js",
  "/profile.js",
  "/auth.js",
  "/arena/arenaRules.js",
  "/arena/arena.js",
  "/launcher.js"
];

const HASH_LENGTH = 12;
const HASH_PATTERN = new RegExp("^/([0-9a-f]{" + HASH_LENGTH + "})(/.*)$");

function assetFile(assetPath) {
  return path.join(PUBLIC_DIR, assetPath.replace(/^\/+/, ""));
}

// The path goes into the digest as well as the bytes, so renaming a file changes the URL even
// if its contents are identical.
function computeHash(assets = HASHED_ASSETS, readFile = fs.readFileSync) {
  const digest = crypto.createHash("sha256");
  for (const assetPath of [...assets].sort()) {
    digest.update(assetPath);
    digest.update("\0");
    digest.update(readFile(assetFile(assetPath)));
    digest.update("\0");
  }
  return digest.digest("hex").slice(0, HASH_LENGTH);
}

function hashedUrl(assetPath, hash) {
  return "/a/" + hash + assetPath;
}

// Rewrite every reference, and REFUSE if any of them was not found.
//
// A missed replacement is the dangerous failure here: the page would still work, still pass
// every test, and silently serve unhashed URLs, so the fix would quietly become a no-op. A
// rename is exactly what would cause it. Throwing means the build gate catches it before the
// container is swapped, which is loud, rather than a page that looks fine and is not fixed.
function rewriteReferences(source, hash, label, assets = HASHED_ASSETS) {
  let out = source;
  for (const assetPath of assets) {
    const quoted = '"' + assetPath + '"';
    const parts = out.split(quoted);
    if (parts.length < 2) {
      throw new Error(
        label + " does not reference " + quoted + ", so its URL would not be content-addressed. " +
        "If the asset was renamed or removed, update HASHED_ASSETS in server/shellAssets.js."
      );
    }
    out = parts.join('"' + hashedUrl(assetPath, hash) + '"');
  }
  return out;
}

function renderShell({ readFile = fs.readFileSync } = {}) {
  const hash = computeHash(HASHED_ASSETS, readFile);
  const indexHtml = rewriteReferences(
    readFile(assetFile("/index.html"), "utf8"), hash, "index.html"
  );

  // The cache name carries the hash so each deploy activates into a clean cache and `activate`
  // deletes the previous one. The `v47` in the source file stays the hand-maintained part, and
  // `scripts/validate-app-assets.js` still pins it there, unchanged.
  let serviceWorker = rewriteReferences(
    readFile(assetFile("/sw.js"), "utf8"), hash, "sw.js"
  );
  const namePattern = /const CACHE_NAME = "([^"]+)";/;
  if (!namePattern.test(serviceWorker)) {
    throw new Error("sw.js has no CACHE_NAME to stamp, so a deploy would reuse the old cache.");
  }
  serviceWorker = serviceWorker.replace(
    namePattern, (_m, name) => 'const CACHE_NAME = "' + name + "-" + hash + '";'
  );

  return { hash, indexHtml, serviceWorker };
}

module.exports = {
  HASHED_ASSETS,
  HASH_LENGTH,
  HASH_PATTERN,
  PUBLIC_DIR,
  computeHash,
  hashedUrl,
  renderShell,
  rewriteReferences
};
