"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function publicAssetPath(url) {
  if (url === "/") return path.join(publicDir, "index.html");
  return path.join(publicDir, url.replace(/^\/+/, ""));
}

function parseArray(source, name) {
  const match = source.match(new RegExp("const\\s+" + name + "\\s*=\\s*(\\[[\\s\\S]*?\\]);"));
  check(match, "Could not find " + name + " in service worker");
  return JSON.parse(match[1]);
}

function sorted(values) {
  return [...values].sort();
}

function sameValues(actual, expected, label) {
  check(
    JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected)),
    label + " mismatch\nactual: " + JSON.stringify(actual) + "\nexpected: " + JSON.stringify(expected)
  );
}

function assertAsset(url, label) {
  const filePath = publicAssetPath(url);
  check(fs.existsSync(filePath), label + " is missing: " + url);
  check(fs.statSync(filePath).size > 0, label + " is empty: " + url);
}

const manifest = JSON.parse(read("public/manifest.webmanifest"));
check(manifest.id === "/", "Manifest id must remain /");
check(manifest.start_url === "/", "Manifest start_url must remain /");
check(manifest.scope === "/", "Manifest scope must remain /");
check(manifest.display === "fullscreen", "Manifest display must remain fullscreen");
check(Array.isArray(manifest.icons) && manifest.icons.length >= 5, "Manifest icon set is incomplete");

for (const icon of manifest.icons) {
  check(icon.src && icon.sizes && icon.type, "Every manifest icon needs src, sizes and type");
  assertAsset(icon.src, "Manifest icon");
}

check(Array.isArray(manifest.shortcuts), "Manifest shortcuts must be an array");
sameValues(
  manifest.shortcuts.map((shortcut) => shortcut.url),
  ["/#arena-local", "/#rune-maze"],
  "Manifest shortcuts"
);
for (const shortcut of manifest.shortcuts) {
  check(shortcut.name && shortcut.short_name && shortcut.description, "Every shortcut needs names and a description");
  check(Array.isArray(shortcut.icons) && shortcut.icons.length > 0, "Every shortcut needs an icon");
  shortcut.icons.forEach((icon) => assertAsset(icon.src, "Shortcut icon"));
}

const sw = read("public/sw.js");
check(sw.includes('const CACHE_NAME = "retro-snake-arena-v47";'), "Service worker cache must be v47");
const shellAssets = parseArray(sw, "SHELL_ASSETS");
const livePaths = parseArray(sw, "LIVE_PATHS");
const expectedShell = [
  "/",
  "/styles.css",
  "/classicAdventure.js",
  "/client.js",
  "/profile.js",
  "/auth.js",
  "/launcher.js",
  "/arena/arena.css",
  "/arena/arenaRules.js",
  "/arena/arena.js",
  "/fonts/press-start-2p.woff2",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/maskable-icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-icon-512.png"
];
sameValues(shellAssets, expectedShell, "Service worker app shell");
check(new Set(shellAssets).size === shellAssets.length, "Service worker shell contains duplicates");
shellAssets.forEach((asset) => assertAsset(asset, "Service worker shell asset"));
sameValues(
  livePaths,
  ["/health", "/arena/leaderboard", "/arena/score", "/arena/best", "/auth/", "/user/profile"],
  "Service worker live paths"
);
for (const livePath of livePaths) {
  check(!shellAssets.includes(livePath), "Live endpoint must not be pre-cached: " + livePath);
}

const html = read("public/index.html");
const scriptSources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
sameValues(
  scriptSources,
  [
    "/classicAdventure.js",
    "/client.js",
    "/profile.js",
    "/auth.js",
    "/arena/arenaRules.js",
    "/arena/arena.js",
    "/launcher.js"
  ],
  "HTML script sources"
);
scriptSources.forEach((source) => assertAsset(source, "HTML script"));

function scriptIndex(source) {
  const index = html.indexOf('src="' + source + '"');
  check(index >= 0, "Missing script tag: " + source);
  return index;
}

check(scriptIndex("/classicAdventure.js") < scriptIndex("/client.js"), "Classic adventure must load before Classic client");
check(scriptIndex("/arena/arenaRules.js") < scriptIndex("/arena/arena.js"), "Arena rules must load before Arena");
check(scriptIndex("/arena/arena.js") < scriptIndex("/launcher.js"), "Arena must load before launcher");

for (const id of [
  "singlePlayerBtn",
  "spPlayBtn",
  "soloBtn",
  "mazeBtn",
  "board",
  "arenaRoot",
  "arenaCanvas",
  "arenaObjective"
]) {
  check(html.includes('id="' + id + '"'), "Required surviving DOM id is missing: " + id);
}

for (const id of [
  "createCoopBtn",
  "coopInvite",
  "coopLobby",
  "arenaOnlineBtn",
  "arenaWatchBtn",
  "multiplayerBtn",
  "moreModesBtn",
  "bombVaultBtn",
  "spectatorCount",
  "copyRoomBtn",
  "arenaChat"
]) {
  check(!html.includes('id="' + id + '"'), "Removed DOM id still exists: " + id);
}

const launcher = read("public/launcher.js");
check(launcher.includes("function launchLocalArena()"), "Local Arena launcher is missing");
check(launcher.includes("function launchRuneMaze()"), "Rune Maze launcher is missing");
check(launcher.includes('location.hash === "#arena-local"'), "Local Arena hash route is missing");
check(launcher.includes('location.hash === "#rune-maze"'), "Rune Maze hash route is missing");

const client = read("public/client.js");
check(client.includes("function startSolo()"), "Classic solo start path is missing");
check(client.includes("function startMazeTrial()"), "Rune Maze start path is missing");
check(client.includes("window.ClassicGame"), "Classic public launcher API is missing");
check(client.includes("snapshot()"), "Classic browser-test snapshot is missing");

const adventure = require(path.join(publicDir, "classicAdventure.js"));
check(adventure.BOARD_SIZE === 32, "Rune Maze board size changed");
check(adventure.RUNES.length === 3, "Rune Maze must retain three runes");
check(adventure.GATES.length === 3, "Rune Maze must retain three gates");
check(adventure.portalOpen(3), "Rune Maze portal must open after all runes");

function canReach(start, target, obstacles, boardSize) {
  const blocked = new Set(obstacles.map((cell) => cell.x + "," + cell.y));
  const queue = [start];
  const seen = new Set([start.x + "," + start.y]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const cell = queue[cursor];
    if (cell.x === target.x && cell.y === target.y) return true;
    for (const step of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: cell.x + step[0], y: cell.y + step[1] };
      const key = next.x + "," + next.y;
      if (next.x < 0 || next.y < 0 || next.x >= boardSize || next.y >= boardSize) continue;
      if (blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return false;
}

let mazePosition = adventure.START;
for (let collected = 0; collected < adventure.RUNES.length; collected += 1) {
  const rune = adventure.RUNES[collected];
  check(
    canReach(mazePosition, rune, adventure.obstaclesFor(collected), adventure.BOARD_SIZE),
    "Rune " + (collected + 1) + " is unreachable"
  );
  mazePosition = rune;
}
check(
  canReach(mazePosition, adventure.PORTAL, adventure.obstaclesFor(3), adventure.BOARD_SIZE),
  "Rune Maze portal is unreachable"
);

const arenaRules = require(path.join(publicDir, "arena", "arenaRules.js"));
check(Object.keys(arenaRules.FOOD_KINDS).length >= 4, "Arena food rules are incomplete");
check(Object.keys(arenaRules.ITEM_KINDS).length >= 7, "Arena item rules are incomplete");
check(Object.keys(arenaRules.HEAD_SHAPES).length >= 5, "Arena head choices are incomplete");
check(arenaRules.BOT_NAMES.length >= 20, "Arena bot roster is incomplete");

const arenaSource = read("public/arena/arena.js");
check(arenaSource.includes("window.ArenaGame"), "Arena public API is missing");
check(arenaSource.includes("function start(opts)"), "Arena solo start function is missing");
check(
  arenaSource.includes('fetch("/arena/leaderboard?mode=arena&limit=10"'),
  "Arena mode leaderboard fetch is missing"
);
check(launcher.includes('fetch("/arena/run/start"'), "Signed run start request is missing");
check(launcher.includes('fetch("/arena/score"'), "Signed score submission is missing");
check(launcher.includes("runToken: token.runToken"), "Score submission run token is missing");
check(launcher.includes("durationMs"), "Score submission duration is missing");
check(
  launcher.includes('fetch("/arena/best?mode=" + encodeURIComponent(mode)'),
  "Per-mode menu score fetch is missing"
);

const styles = read("public/styles.css");
const arenaStyles = read("public/arena/arena.css");
check(arenaStyles.includes(".arena-solo-objective"), "Solo Arena objective style is missing");
for (const selector of [
  ".coop-",
  "body.arena-coop",
  ".arena-objective",
  ".arena-chat",
  ".arena-online-cta",
  ".arena-watch-cta",
  ".mode-soon",
  ".bomb-vault-cta"
]) {
  check(!styles.includes(selector) && !arenaStyles.includes(selector), "Removed CSS selector remains: " + selector);
}

check(!fs.existsSync(path.join(publicDir, "arena", "arenaNet.js")), "Removed browser networking module still exists");
check(!fs.existsSync(path.join(root, "server", "arenaWorld.js")), "Removed server world module still exists");

const server = read("server.js");
for (const route of ["/arena/leaderboard", "/arena/score", "/arena/best", "/user/profile"]) {
  check(server.includes('"' + route + '"'), "Required server route is missing: " + route);
}
for (const removedFragment of [
  'require("ws")',
  "WebSocketServer",
  'server.on("upgrade"',
  '"/arena/rooms"',
  '"/rooms/create"',
  '"/rooms/join"'
]) {
  check(!server.includes(removedFragment), "Removed server networking fragment remains: " + removedFragment);
}
check(read("server/auth.js").includes("function installAuth"), "Authentication server module is missing");
check(read("public/auth.js").includes("/auth/config"), "Authentication client path is missing");
check(read("public/profile.js").includes("/user/profile"), "Profile client path is missing");

const cutSurface = [
  html,
  launcher,
  styles,
  arenaStyles,
  sw,
  read("public/manifest.webmanifest"),
  server
].join("\n");
for (const term of [
  "coop",
  "arenaNet",
  "arenaWorld",
  "watch-online",
  "arena-online",
  "vault",
  "multiplayerBtn",
  "moreModesBtn"
]) {
  check(!cutSurface.toLowerCase().includes(term.toLowerCase()), "Removed product term remains in runtime surface: " + term);
}

console.log("Asset validation passed:");
console.log("- manifest has exactly the two surviving PWA shortcuts");
console.log("- service worker v47 shell (incl. self-hosted font) and live endpoint lists are valid");
console.log("- HTML scripts exist and load in dependency order");
console.log("- Arena solo, Classic, and Rune Maze launch/runtime hooks remain");
console.log("- removed networking, placeholder, and Vault surfaces are absent");
