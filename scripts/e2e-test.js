"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium, devices } = require("playwright");

let browser = null;
let serverModule = null;
let databasePath = "";
const completedTests = [];

async function main() {
  databasePath = path.join(os.tmpdir(), "snake-v1-cut-e2e-" + process.pid + "-" + Date.now() + ".sqlite");
  process.env.DB_PATH = databasePath;
  process.env.DETAILED_HEALTH = "1";

  try {
    serverModule = require("../server");
    const server = await serverModule.startServer(0);
    const address = server.address();
    assert(address && typeof address === "object", "E2E server did not expose an address");
    const baseUrl = "http://127.0.0.1:" + address.port;

    try {
      browser = process.env.E2E_CDP_URL
        ? await chromium.connectOverCDP(process.env.E2E_CDP_URL)
        : await chromium.launch({ headless: true, executablePath: findBrowserExecutable() });
    } catch (error) {
      if (String(error && error.message).includes("spawn EPERM") && process.env.E2E_REQUIRE_BROWSER !== "1") {
        console.warn("e2e skipped: browser child processes are blocked; set E2E_CDP_URL or E2E_REQUIRE_BROWSER=1");
        return;
      }
      throw error;
    }

    const arenaEvidence = await runTest(
      "Arena supports input movement, scoring, death, and restart",
      () => verifyArenaSolo(baseUrl)
    );
    const classicEvidence = await runTest(
      "Classic supports input movement, scoring, death, and restart",
      () => verifyClassic(baseUrl)
    );
    const mazeEvidence = await runTest(
      "Rune Maze supports input movement, scoring, death, and restart",
      () => verifyRuneMaze(baseUrl)
    );
    const landingEvidence = await runTest(
      "landing exposes exactly three reachable offline modes and same-origin requests",
      () => verifyLandingSurface(baseUrl)
    );
    const mobilePortraitEvidence = await runTest(
      "mobile 360x800 portrait Classic: viewport-sized board, touch steering, touch/keyboard pause, result overlay",
      () => verifyMobileClassicPortrait(baseUrl)
    );
    const mobileLandscapeEvidence = await runTest(
      "mobile 800x360 landscape Classic: board and every control stay on screen",
      () => verifyMobileClassicLandscape(baseUrl)
    );
    const mobileArenaEvidence = await runTest(
      "mobile 360x800 Arena: touch steering, centred pause, confirmed quit, tutorial/result exclusivity",
      () => verifyMobileArena(baseUrl)
    );

    console.log("E2E browser test passed:");
    printEvidence("Landing", landingEvidence);
    printEvidence("Arena solo", arenaEvidence);
    printEvidence("Classic Snake", classicEvidence);
    printEvidence("Rune Maze", mazeEvidence);
    printEvidence("Mobile Classic portrait", mobilePortraitEvidence);
    printEvidence("Mobile Classic landscape", mobileLandscapeEvidence);
    printEvidence("Mobile Arena", mobileArenaEvidence);
    console.log("New tests executed (none skipped):");
    for (const result of completedTests) console.log("- " + result.name + " (" + result.ms + " ms)");
  } finally {
    if (browser) {
      await browser.close();
      browser = null;
    }
    if (serverModule) {
      await serverModule.stopServer();
      assert.equal(serverModule.server.listening, false, "E2E server is still listening after stopServer()");
      serverModule._test.closeDatabase();
    }
    cleanupDatabase(databasePath);
    console.log("E2E cleanup verified: browser closed, server stopped, temporary database removed");
  }
}

async function verifyLandingSurface(baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const monitored = await monitoredPage(context);
  const page = monitored.page;
  try {
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.ArenaGame && window.ClassicGame);
    const surface = await assertModeSurface(page);
    await page.waitForLoadState("networkidle");
    assertNoBrowserErrors(monitored.errors, "Landing");
    assertSameOriginRequests(monitored.requests, baseUrl, "Landing");
    return {
      summary: surface.modeLaunchIds.join(", ") + "; " + monitored.requests.length + " same-origin requests"
    };
  } finally {
    await context.close();
  }
}

async function verifyArenaSolo(baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installArenaProbe(context);
  const monitored = await monitoredPage(context);
  const page = monitored.page;
  try {
    await page.goto(baseUrl + "/?arenaProfile=1", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.ArenaGame && window.ClassicGame);
    await page.locator("#singlePlayerBtn").click();
    await page.locator("#spSetup").waitFor({ state: "visible" });
    await page.locator("#playerName").fill("E2E Arena");
    await page.locator("#spPlayBtn").click();
    await page.locator("#arenaRoot").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const canvas = document.querySelector("#arenaCanvas");
      const probe = window.__snakeArenaProbe;
      return canvas && canvas.width > 100 && canvas.height > 100 &&
        probe && probe.player && probe.foods && probe.foods.length > 0;
    });
    await waitForCanvasPaint(page, "#arenaCanvas");
    const evidence = await canvasEvidence(page, "#arenaCanvas");
    assertCanvasEvidence(evidence, "Arena solo");
    assert.equal(await page.locator("body.arena-active").count(), 1, "Arena active body state is missing");

    const beforeMovement = await arenaSnapshot(page);
    await page.keyboard.down("ArrowLeft");
    let afterMovement;
    try {
      await page.waitForFunction((before) => {
        const player = window.__snakeArenaProbe && window.__snakeArenaProbe.player;
        if (!player || !player.alive) return false;
        const moved = Math.hypot(player.x - before.x, player.y - before.y);
        const turn = Math.atan2(Math.sin(player.angle - before.angle), Math.cos(player.angle - before.angle));
        return moved > 18 && turn < -0.12;
      }, beforeMovement, { timeout: 4000 });
      afterMovement = await arenaSnapshot(page);
    } finally {
      await page.keyboard.up("ArrowLeft");
    }
    const movedDistance = Math.hypot(
      afterMovement.x - beforeMovement.x,
      afterMovement.y - beforeMovement.y
    );
    const turnDelta = signedAngleDelta(beforeMovement.angle, afterMovement.angle);
    assert(movedDistance > 18, "Arena position did not change after ArrowLeft input");
    assert(turnDelta < -0.12, "Arena heading did not turn left after ArrowLeft input");

    const scoreBefore = afterMovement.score;
    const scored = await steerArenaUntilScoreIncreases(page, scoreBefore, 12000);
    assert(scored.score > scoreBefore, "Arena score did not increase after real food collection");
    await page.waitForFunction((minimum) => (
      Number(document.querySelector("#arenaScore")?.textContent || 0) > minimum
    ), scoreBefore, { timeout: 3000 });

    const dead = await steerArenaToBoundaryDeath(page, 25000);
    assert.equal(dead.alive, false, "Arena player did not die at the world boundary");
    await page.locator("#arenaDeath").waitFor({ state: "visible" });
    assert.equal((await page.locator("#arenaDeath h2").textContent()).trim(), "You died", "Arena death UI is missing");
    const deathScore = Number(await page.locator("#arenaDeathScore").textContent());
    assert.equal(deathScore, Math.round(dead.score), "Arena death UI does not show the final score");
    assert((await page.locator("#arenaDeathReason").textContent()).includes("Cause:"), "Arena death UI is missing a cause");

    const deadSpawnCount = dead.spawnCount;
    await page.locator("#arenaRespawn").click();
    // Wait only for the durable fact that a new run began. The snake's live state is
    // deliberately NOT part of the wait condition - see the probe comment above.
    await page.waitForFunction((previousSpawns) => {
      const probe = window.__snakeArenaProbe;
      return probe && probe.spawnCount > previousSpawns && probe.player;
    }, deadSpawnCount, { timeout: 4000 });
    const spawned = await page.evaluate(() => ({
      score: window.__snakeArenaProbe.lastSpawnScore,
      alive: window.__snakeArenaProbe.lastSpawnAlive
    }));
    assert.equal(spawned.score, 0, "Arena restart did not reset the score");
    assert.equal(spawned.alive, true, "Arena restart did not create a live snake");
    await page.locator("#arenaDeath").waitFor({ state: "hidden" });

    assertNoBrowserErrors(monitored.errors, "Arena solo");
    assertSameOriginRequests(monitored.requests, baseUrl, "Arena solo");
    return {
      summary: "moved " + movedDistance.toFixed(1) + "px-equivalent, turned " +
        turnDelta.toFixed(2) + "rad, score " + scoreBefore + "→" + scored.score +
        ", death score " + deathScore + ", respawn score " + spawned.score,
      canvas: evidence
    };
  } finally {
    await context.close();
  }
}

async function verifyClassic(baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const monitored = await monitoredPage(context);
  const page = monitored.page;
  try {
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.ClassicGame && document.querySelector("#soloBtn"));
    // Incomplete initials: this run can never be submitted (Rune Maze covers the submit path).
    await page.evaluate(() => {
      const input = document.querySelector("#playerInitials");
      input.value = "A";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => document.querySelector("#soloBtn").click());
    await page.waitForFunction(() => {
      const state = window.ClassicGame && window.ClassicGame.snapshot();
      return state && state.roomCode === "SOLO";
    });
    await page.locator(".game-wrap").waitFor({ state: "visible" });
    await waitForCanvasPaint(page, "#board");
    const initial = await classicSnapshot(page);
    assert.equal(initial.roomCode, "SOLO", "Classic did not enter solo mode");
    assert.equal(initial.boardSize, 32, "Classic board size changed");
    assert.equal(initial.players.length, 1, "Classic should have exactly one player");
    const evidence = await canvasEvidence(page, "#board");
    assertCanvasEvidence(evidence, "Classic Snake");

    const scored = await driveGridModeToScore(page, "classic", initial.players[0].score, 15000);
    assert(scored.state.players[0].score > initial.players[0].score, "Classic score did not increase after eating food");
    assert(scored.movement, "Classic did not prove movement after a direction key");

    const dead = await continueGridUntilDeath(page, 15000);
    assert.equal(dead.players[0].alive, false, "Classic did not reach game over");
    await page.waitForFunction(() => /Game over/i.test(document.querySelector("#gameStatus")?.textContent || ""));
    const scoreboardText = await page.locator("#scoreboard").textContent();
    assert(scoreboardText.includes(String(dead.players[0].score)), "Classic game-over UI is missing the score");
    assert(scoreboardText.includes("KO"), "Classic game-over UI is missing the KO state");
    assert.equal(await page.locator("#restartBtn").isEnabled(), true, "Classic restart is not enabled after death");
    // No initials are set, so the score is never submitted: the stored best must not rise,
    // or a run that was never saved would block a later, genuinely better-than-saved one.
    await page.waitForFunction(() => /initials/i.test(document.getElementById("classicScoreNotice")?.textContent || ""));
    assert.equal(await page.evaluate(() => localStorage.getItem("arenaBest:classic")), null,
      "Classic raised the stored best for a score that was never saved");

    await page.locator("#restartBtn").click();
    await page.waitForFunction(() => {
      const state = window.ClassicGame && window.ClassicGame.snapshot();
      const player = state && state.players && state.players[0];
      return state && state.roomCode === "SOLO" && state.running && state.countdownMs > 0 &&
        player && player.alive && player.score === 0;
    });
    const restarted = await classicSnapshot(page);
    assert.equal(restarted.players[0].score, 0, "Classic restart did not reset the score");
    assert.equal(restarted.players[0].alive, true, "Classic restart did not create a live snake");

    assertNoBrowserErrors(monitored.errors, "Classic Snake");
    assertSameOriginRequests(monitored.requests, baseUrl, "Classic Snake");
    return {
      summary: "key " + scored.movement.key + " moved " + pointText(scored.movement.before) +
        "→" + pointText(scored.movement.after) + ", score " +
        initial.players[0].score + "→" + scored.state.players[0].score +
        ", game over " + dead.players[0].score + ", restart 0",
      canvas: evidence
    };
  } finally {
    await context.close();
  }
}

async function verifyRuneMaze(baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const monitored = await monitoredPage(context);
  const page = monitored.page;
  try {
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.ClassicGame && document.querySelector("#mazeBtn"));
    await page.evaluate(() => document.querySelector("#mazeBtn").click());
    await page.waitForFunction(() => {
      const state = window.ClassicGame && window.ClassicGame.snapshot();
      return state && state.roomCode === "MAZE";
    });
    await page.locator(".game-wrap").waitFor({ state: "visible" });
    await waitForCanvasPaint(page, "#board");
    const initial = await classicSnapshot(page);
    assert.equal(initial.roomCode, "MAZE", "Rune Maze landing control did not launch adventure mode");
    assert.equal(initial.maze.runes.length, 3, "Rune Maze state is missing runes");
    assert.equal(initial.maze.gates.length, 3, "Rune Maze state is missing gates");
    assert.equal(initial.maze.portal.x, 29, "Rune Maze portal state changed");
    const evidence = await canvasEvidence(page, "#board");
    assertCanvasEvidence(evidence, "Rune Maze");

    const scored = await driveGridModeToScore(page, "maze", initial.players[0].score, 18000);
    assert.equal(scored.state.maze.collected, 1, "Rune Maze did not collect the first rune through gameplay");
    assert(scored.state.players[0].score > initial.players[0].score, "Rune Maze score did not increase after collecting a rune");
    assert(scored.movement, "Rune Maze did not prove movement after a direction key");

    const dead = await continueGridUntilDeath(page, 10000);
    assert.equal(dead.players[0].alive, false, "Rune Maze did not reach game over");
    await page.waitForFunction(() => /Maze lost/i.test(document.querySelector("#gameStatus")?.textContent || ""));
    const scoreboardText = await page.locator("#scoreboard").textContent();
    assert(scoreboardText.includes(String(dead.players[0].score)), "Rune Maze game-over UI is missing the score");
    assert(scoreboardText.includes("KO"), "Rune Maze game-over UI is missing the KO state");

    await page.locator("#restartBtn").click();
    await page.waitForFunction(() => {
      const state = window.ClassicGame && window.ClassicGame.snapshot();
      const player = state && state.players && state.players[0];
      return state && state.roomCode === "MAZE" && state.running && state.countdownMs > 0 &&
        state.maze.collected === 0 && player && player.alive && player.score === 0;
    });
    const restarted = await classicSnapshot(page);
    assert.equal(restarted.maze.collected, 0, "Rune Maze restart did not reset rune progress");
    assert.equal(restarted.players[0].score, 0, "Rune Maze restart did not reset the score");

    assertNoBrowserErrors(monitored.errors, "Rune Maze");
    assertSameOriginRequests(monitored.requests, baseUrl, "Rune Maze");
    return {
      summary: "key " + scored.movement.key + " moved " + pointText(scored.movement.before) +
        "→" + pointText(scored.movement.after) + ", rune score " +
        initial.players[0].score + "→" + scored.state.players[0].score +
        ", maze lost " + dead.players[0].score + ", restart 0",
      canvas: evidence
    };
  } finally {
    await context.close();
  }
}

// ---- Mobile coverage (real touch, 360px portrait + landscape) --------------
// These contexts are why UX-01..UX-05 shipped unseen: the suite used to be
// desktop-only. Every context emulates a phone (devices[...] base, hasTouch)
// and exercises actual touch input.
const MOBILE_PORTRAIT = { width: 360, height: 800 };
const MOBILE_LANDSCAPE = { width: 800, height: 360 };

function mobileContextOptions(viewport) {
  return {
    ...devices["Pixel 7"],
    viewport,
    hasTouch: true,
    isMobile: true
  };
}

async function waitGridPlaying(page) {
  await page.waitForFunction(() => {
    const state = window.ClassicGame && window.ClassicGame.snapshot();
    const player = state && state.players && state.players[0];
    return state && state.running && state.countdownMs <= 0 &&
      state.levelBannerMs <= 0 && player && player.alive;
  }, null, { timeout: 9000 });
}

async function assertControlOnScreen(page, selector, viewport, label) {
  const box = await page.locator(selector).boundingBox();
  assert(box, label + " " + selector + " has no layout box");
  assert(box.y >= 0 && box.x >= 0, label + " " + selector + " is above/left of the viewport");
  assert(
    box.y + box.height <= viewport.height && box.x + box.width <= viewport.width,
    label + " " + selector + " falls below/beside the viewport fold: " + JSON.stringify(box)
  );
  assert(
    box.width >= 44 && box.height >= 44,
    label + " " + selector + " touch target is under 44px: " +
      Math.round(box.width) + "x" + Math.round(box.height)
  );
  return box;
}

async function launchClassicOnPhone(page) {
  await page.waitForFunction(() => window.ClassicGame && document.querySelector("#soloBtn"));
  await page.locator("#soloBtn").tap();
  await page.waitForFunction(() => {
    const state = window.ClassicGame && window.ClassicGame.snapshot();
    return state && state.roomCode === "SOLO";
  });
  await page.locator(".game-wrap").waitFor({ state: "visible" });
  await waitForCanvasPaint(page, "#board");
}

async function verifyMobileClassicPortrait(baseUrl) {
  const context = await browser.newContext(mobileContextOptions(MOBILE_PORTRAIT));
  const monitored = await monitoredPage(context);
  const page = monitored.page;
  try {
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    await launchClassicOnPhone(page);

    // UX-01: the board is sized from the viewport, not from HUD leftovers.
    const boardBox = await page.locator("#board").boundingBox();
    const pxPerCell = boardBox.width / 32;
    assert(
      pxPerCell >= 10,
      "Mobile board is under 10px per cell: " + boardBox.width + "px wide (" +
        pxPerCell.toFixed(2) + "px/cell)"
    );
    assert(
      boardBox.width >= MOBILE_PORTRAIT.width * 0.85,
      "Mobile board uses under 85% of the 360px viewport width: " + boardBox.width
    );

    // Every control is on screen and a legal touch target (UX-02 / WCAG 2.2).
    for (const selector of [
      '[data-dir="up"]', '[data-dir="down"]', '[data-dir="left"]', '[data-dir="right"]',
      "#restartBtn", "#classicPauseBtn"
    ]) {
      await assertControlOnScreen(page, selector, MOBILE_PORTRAIT, "Mobile portrait Classic");
    }

    await waitGridPlaying(page);

    // Real touch steering through the d-pad.
    await page.locator('[data-dir="up"]').tap();
    await page.waitForFunction(() => {
      const state = window.ClassicGame && window.ClassicGame.snapshot();
      return state && state.players[0].direction === "up";
    }, null, { timeout: 4000 });

    // UX-03: pause via the on-screen control freezes the simulation.
    await page.locator("#classicPauseBtn").tap();
    await page.locator("#classicOverlay").waitFor({ state: "visible" });
    assert(
      (await page.locator("#classicOverlay").textContent()).includes("Paused"),
      "Classic pause overlay did not appear after tapping the rail pause button"
    );
    const frozenBefore = await classicSnapshot(page);
    await page.waitForTimeout(400);
    const frozenAfter = await classicSnapshot(page);
    assert.deepEqual(
      frozenAfter.players[0].snake[0],
      frozenBefore.players[0].snake[0],
      "Classic snake kept moving while paused"
    );

    // Resume via touch, then pause + resume via keyboard (Esc / P).
    await page.locator("#classicResumeBtn").tap();
    await page.locator("#classicOverlay").waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await page.locator("#classicOverlay").waitFor({ state: "visible" });
    await page.keyboard.press("KeyP");
    await page.locator("#classicOverlay").waitFor({ state: "hidden" });
    const resumed = await classicSnapshot(page);
    assert.equal(resumed.running, true, "Classic did not resume after keyboard pause");

    // Death brings the result card into the same overlay slot.
    await continueGridUntilDeath(page, 15000);
    await page.locator("#classicOverlay").waitFor({ state: "visible" });
    const resultText = await page.locator("#classicOverlay").textContent();
    assert(/Game over/i.test(resultText), "Classic result overlay did not appear after death");
    const againBox = await assertControlOnScreen(
      page, "#classicPlayAgainBtn", MOBILE_PORTRAIT, "Mobile portrait Classic result"
    );
    assert(againBox, "Classic result Play again is missing");

    await page.locator("#classicPlayAgainBtn").tap();
    await page.waitForFunction(() => {
      const state = window.ClassicGame && window.ClassicGame.snapshot();
      const player = state && state.players && state.players[0];
      return state && state.roomCode === "SOLO" && state.running &&
        player && player.alive && player.score === 0;
    }, null, { timeout: 5000 });

    assertNoBrowserErrors(monitored.errors, "Mobile Classic portrait");
    assertSameOriginRequests(monitored.requests, baseUrl, "Mobile Classic portrait");
    return {
      summary: "board " + Math.round(boardBox.width) + "x" + Math.round(boardBox.height) +
        " = " + pxPerCell.toFixed(2) + "px/cell at 360x800, touch d-pad + pause + result OK"
    };
  } finally {
    await context.close();
  }
}

async function verifyMobileClassicLandscape(baseUrl) {
  const context = await browser.newContext(mobileContextOptions(MOBILE_LANDSCAPE));
  const monitored = await monitoredPage(context);
  const page = monitored.page;
  try {
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    await launchClassicOnPhone(page);

    // UX-02: landscape is playable — board above its old 96px floor and every
    // control (including d-pad Down and Restart) reachable without scrolling.
    const boardBox = await page.locator("#board").boundingBox();
    const pxPerCell = boardBox.height / 32;
    assert(boardBox.height > 96, "Landscape board hit the old 96px floor");
    assert(
      boardBox.y + boardBox.height <= MOBILE_LANDSCAPE.height,
      "Landscape board overflows the viewport: " + JSON.stringify(boardBox)
    );
    for (const selector of [
      '[data-dir="down"]', '[data-dir="up"]', "#restartBtn", "#classicPauseBtn"
    ]) {
      await assertControlOnScreen(page, selector, MOBILE_LANDSCAPE, "Mobile landscape Classic");
    }

    await waitGridPlaying(page);
    await page.locator("#classicPauseBtn").tap();
    await page.locator("#classicOverlay").waitFor({ state: "visible" });
    await page.locator("#classicResumeBtn").tap();
    await page.locator("#classicOverlay").waitFor({ state: "hidden" });

    assertNoBrowserErrors(monitored.errors, "Mobile Classic landscape");
    assertSameOriginRequests(monitored.requests, baseUrl, "Mobile Classic landscape");
    return {
      summary: "board " + Math.round(boardBox.width) + "x" + Math.round(boardBox.height) +
        " = " + pxPerCell.toFixed(2) + "px/cell at 800x360, all controls on screen"
    };
  } finally {
    await context.close();
  }
}

async function verifyMobileArena(baseUrl) {
  const context = await browser.newContext(mobileContextOptions(MOBILE_PORTRAIT));
  await installArenaProbe(context);
  const monitored = await monitoredPage(context);
  const page = monitored.page;
  try {
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.ArenaGame && window.ClassicGame);
    await page.locator("#singlePlayerBtn").tap();
    await page.locator("#spSetup").waitFor({ state: "visible" });
    await page.locator("#playerName").fill("E2E Mobile");
    await page.locator("#spPlayBtn").tap();
    await page.locator("#arenaRoot").waitFor({ state: "visible" });
    // Wait on the durable spawn record, not the live flag, matching verifyArenaSolo above.
    // Polling `player.alive` is a race: an Arena snake can spawn, eat and die inside one
    // animation frame, and once it dies the result overlay waits for input, so `alive` never
    // returns to true and the wait burns its entire timeout. That is why raising this from
    // 4s to 30s never helped. Desktop Arena never checked `alive`, which is exactly why only
    // the mobile test failed, and only on the runs where the spawn happened to die early.
    await page.waitForFunction(() => {
      const probe = window.__snakeArenaProbe;
      return probe && probe.player && probe.spawnCount > 0 && probe.lastSpawnAlive;
    });

    // The old steering-region controls and unsafe live settings surface are gone.
    assert.equal(
      await page.locator("#arenaExit").count(),
      0,
      "The legacy steering-region Exit button still exists"
    );
    assert.equal(await page.locator("#arenaSettingsToggle").count(), 0, "Arena settings gear still exists");
    assert.equal(await page.locator("#arenaSettingsPanel").count(), 0, "Arena live settings panel still exists");
    await page.locator("#arenaMobileScore").waitFor({ state: "visible" });
    await page.locator("#arenaRankChip").waitFor({ state: "visible" });
    const pauseBox = await assertControlOnScreen(
      page, "#arenaPauseBtn", MOBILE_PORTRAIT, "Mobile Arena"
    );
    const pauseCenterX = pauseBox.x + pauseBox.width / 2;
    assert(
      Math.abs(pauseCenterX - MOBILE_PORTRAIT.width / 2) <= 40,
      "Arena pause control is not centred outside the steering halves: x=" + pauseCenterX
    );
    await assertControlOnScreen(page, "#arenaBoostBtn", MOBILE_PORTRAIT, "Mobile Arena");
    assert.equal(
      await page.locator("#arenaFireBtn").isVisible(),
      false,
      "Arena FIRE is visible at the zero-ammo spawn state"
    );

    // Touch help uses the reserved status line instead of covering the controls.
    assert.equal(await page.locator("#arenaHint").isVisible(), false, "Touch tutorial card covers the Arena");
    await page.locator("#arenaToast").waitFor({ state: "visible" });
    assert.equal(await page.locator("#arenaToast").getAttribute("role"), "status");
    assert.equal(await page.locator("#arenaToast").getAttribute("aria-live"), "polite");

    // Synthetic touch starts on both screen halves must be accepted by the
    // canvas. DOM controls still intercept their own touch starts.
    const touchStartsPrevented = await page.evaluate(() => {
      const canvas = document.getElementById("arenaCanvas");
      return [90, 270].map((clientX, index) => {
        const identifier = 40 + index;
        const start = new Event("touchstart", { bubbles: true, cancelable: true });
        Object.defineProperty(start, "changedTouches", {
          value: [{ identifier, clientX, clientY: 400 }]
        });
        canvas.dispatchEvent(start);
        const end = new Event("touchend", { bubbles: true, cancelable: true });
        Object.defineProperty(end, "changedTouches", {
          value: [{ identifier, clientX, clientY: 400 }]
        });
        canvas.dispatchEvent(end);
        return start.defaultPrevented;
      });
    });
    assert.deepEqual(touchStartsPrevented, [true, true], "Arena canvas rejected a steering-side touch");

    // Real touch steering: a drag beginning anywhere on the canvas turns the snake.
    //
    // This sequence needs the player ALIVE from the drag through to the pause tap,
    // but Arena has ~20 bots and a legitimate death mid-window is normal gameplay -
    // it is not a steering defect. Retry the whole steer on death rather than
    // failing, and only give up if every attempt dies. The assertions below are
    // unchanged; this only removes the dependence on surviving a bot encounter.
    const cdp = await context.newCDPSession(page);
    const startX = MOBILE_PORTRAIT.width * 0.75;
    let steered = false;
    let lastSteerError = null;
    for (let attempt = 0; attempt < 3 && !steered; attempt += 1) {
      if (attempt > 0) {
        // Previous attempt died mid-steer: take the death overlay's respawn and retry.
        const deathVisible = await page.locator("#arenaDeath").isVisible().catch(() => false);
        if (deathVisible) {
          await page.locator("#arenaRespawn").click();
          await page.locator("#arenaDeath").waitFor({ state: "hidden", timeout: 5000 });
        }
      }
      const steerBefore = await arenaSnapshot(page);
      // Drag PERPENDICULAR to the snake's current heading rather than always
      // straight up. The spawn heading is effectively random, so a fixed upward
      // drag asked for no turn at all whenever the snake already happened to be
      // pointing up - the assertion then failed with the player alive, which this
      // loop deliberately does not retry. Requesting a ~90 degree turn makes the
      // check strictly stronger and independent of the spawn.
      const steerTarget = steerBefore.angle + Math.PI / 2;
      const dragX = startX + Math.cos(steerTarget) * 80;
      const dragY = 400 + Math.sin(steerTarget) * 80;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: startX, y: 400, id: 1 }]
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: dragX, y: dragY, id: 1 }]
      });
      try {
        await page.waitForFunction((before) => {
          const player = window.__snakeArenaProbe && window.__snakeArenaProbe.player;
          if (!player || !player.alive) return false;
          const turn = Math.atan2(
            Math.sin(player.targetAngle - before.angle),
            Math.cos(player.targetAngle - before.angle)
          );
          return Math.abs(turn) > 0.15;
        }, { angle: steerBefore.angle }, { timeout: 4000 });
        steered = true;
      } catch (error) {
        lastSteerError = error;
        const alive = await page.evaluate(() => {
          const probe = window.__snakeArenaProbe;
          return Boolean(probe && probe.player && probe.player.alive);
        });
        // Still alive and yet no turn = steering genuinely failed. Do not retry.
        if (alive) throw error;
      } finally {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
    }
    assert(steered, "Touch steering never turned the snake across 3 attempts: " +
      (lastSteerError && lastSteerError.message));

    // Pause via touch freezes the player; quit needs a confirming second tap.
    // The pause guard in arena.js refuses to pause a dead player, so make a
    // death during the steering window a clear failure instead of a 30s timeout.
    const aliveBeforePause = await page.evaluate(() => {
      const probe = window.__snakeArenaProbe;
      return Boolean(probe && probe.player && probe.player.alive);
    });
    assert(aliveBeforePause, "Arena player died before the pause tap");
    await page.locator("#arenaPauseBtn").tap();
    await page.locator("#arenaPause").waitFor({ state: "visible" });
    await page.locator("#arenaTouchControlSel").waitFor({ state: "visible" });
    await page.locator("#arenaLeftHandedToggle").waitFor({ state: "visible" });
    await page.locator("#arenaReducedMotion").waitFor({ state: "visible" });
    await page.locator("#arenaSoundOn").waitFor({ state: "visible" });
    const arenaFrozenBefore = await arenaSnapshot(page);
    await page.waitForTimeout(400);
    const arenaFrozenAfter = await arenaSnapshot(page);
    assert.equal(arenaFrozenAfter.x, arenaFrozenBefore.x, "Arena player kept moving while paused");
    assert.equal(arenaFrozenAfter.y, arenaFrozenBefore.y, "Arena player kept moving while paused");

    await page.locator("#arenaQuitBtn").tap();
    // Poll: the synthesized click trails the tap gesture slightly on mobile.
    await page.waitForFunction(
      () => document.getElementById("arenaQuitBtn").textContent.includes("Tap again"),
      null,
      { timeout: 2000 }
    ).catch(() => {
      assert.fail("Arena quit did not arm a confirmation on first tap");
    });
    assert.equal(
      await page.locator("#arenaRoot").isVisible(),
      true,
      "Arena quit ended the run without confirmation"
    );
    await page.locator("#arenaQuitBtn").tap();
    await page.locator("#arenaRoot").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("body.is-playing").count(),
      0,
      "Arena quit did not return to the menu"
    );

    // UX-05: on death the result owns the slot — the tutorial cannot cover
    // "Play again".
    const spawnsBeforeReplay = await page.evaluate(
      () => (window.__snakeArenaProbe && window.__snakeArenaProbe.spawnCount) || 0
    );
    await page.locator("#singlePlayerBtn").tap();
    await page.locator("#spPlayBtn").tap();
    await page.locator("#arenaRoot").waitFor({ state: "visible" });
    // Same race as the first spawn wait: match on a NEW spawn having happened, not on the
    // snake still being alive by the time the poll gets around to looking.
    await page.waitForFunction((previousSpawns) => {
      const probe = window.__snakeArenaProbe;
      return probe && probe.player && probe.spawnCount > previousSpawns && probe.lastSpawnAlive;
    }, spawnsBeforeReplay);
    await steerArenaToBoundaryDeath(page, 30000);
    await page.locator("#arenaDeath").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#arenaHint").isVisible(),
      false,
      "The touch tutorial is visible over the Arena result"
    );
    const respawnBox = await page.locator("#arenaRespawn").boundingBox();
    const covering = await page.evaluate((point) => {
      const element = document.elementFromPoint(point.x, point.y);
      return element ? element.id || element.className || element.tagName : "none";
    }, { x: respawnBox.x + respawnBox.width / 2, y: respawnBox.y + respawnBox.height / 2 });
    assert.equal(covering, "arenaRespawn", "Arena Play again is covered by: " + covering);

    assertNoBrowserErrors(monitored.errors, "Mobile Arena");
    assertSameOriginRequests(monitored.requests, baseUrl, "Mobile Arena");
    return {
      summary: "touch drag steered, pause centred at x=" + Math.round(pauseCenterX) +
        ", two-tap quit held, result owns the overlay slot"
    };
  } finally {
    await context.close();
  }
}

async function classicSnapshot(page) {
  return page.evaluate(() => window.ClassicGame && window.ClassicGame.snapshot());
}

async function driveGridModeToScore(page, mode, initialScore, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let movement = null;
  while (Date.now() < deadline) {
    const state = await classicSnapshot(page);
    assert(state, mode + " snapshot disappeared during gameplay");
    const player = state.players[0];
    if (player.score > initialScore) return { state, movement };
    assert(player.alive && state.running, mode + " died before its score increased");

    if (state.countdownMs > 0 || state.levelBannerMs > 0) {
      await page.waitForFunction(() => {
        const next = window.ClassicGame && window.ClassicGame.snapshot();
        return next && next.countdownMs <= 0 && next.levelBannerMs <= 0;
      }, null, { timeout: 5000 });
      continue;
    }

    const target = mode === "maze"
      ? state.maze.runes[state.maze.collected]
      : state.food;
    assert(target, mode + " has no scoring target");
    const path = findGridPath(state, target);
    assert(path && path.length > 0, mode + " could not find a safe route to its scoring target");
    const direction = path[0];
    const key = directionKey(direction);
    const before = { ...player.snake[0], score: player.score };
    await page.keyboard.press(key);
    await page.waitForFunction((previous) => {
      const next = window.ClassicGame && window.ClassicGame.snapshot();
      const nextPlayer = next && next.players && next.players[0];
      if (!nextPlayer) return false;
      const head = nextPlayer.snake[0];
      return !nextPlayer.alive || nextPlayer.score > previous.score ||
        head.x !== previous.x || head.y !== previous.y;
    }, before, { timeout: 2200 });

    const afterState = await classicSnapshot(page);
    const afterPlayer = afterState.players[0];
    const after = afterPlayer.snake[0];
    const delta = directionDelta(direction);
    if (
      !movement &&
      after.x - before.x === delta.x &&
      after.y - before.y === delta.y
    ) {
      movement = {
        key,
        direction,
        before: { x: before.x, y: before.y },
        after: { x: after.x, y: after.y }
      };
    }
    if (afterPlayer.score > initialScore) return { state: afterState, movement };
  }
  throw new Error(mode + " did not increase its score before the gameplay deadline");
}

async function continueGridUntilDeath(page, timeoutMs) {
  const state = await classicSnapshot(page);
  const player = state && state.players && state.players[0];
  assert(player && player.alive, "Grid mode was not alive before the death run");
  await page.keyboard.press(directionKey(player.direction));
  await page.waitForFunction(() => {
    const next = window.ClassicGame && window.ClassicGame.snapshot();
    const nextPlayer = next && next.players && next.players[0];
    return nextPlayer && !nextPlayer.alive && !next.running;
  }, null, { timeout: timeoutMs });
  return classicSnapshot(page);
}

function findGridPath(state, target) {
  const player = state.players[0];
  const head = player.snake[0];
  const blocked = new Set((state.obstacles || []).map(cellKey));
  for (const part of player.snake.slice(1, -1)) blocked.add(cellKey(part));
  const directions = ["up", "right", "down", "left"];
  const queue = [{ x: head.x, y: head.y, path: [] }];
  const seen = new Set([cellKey(head)]);
  const reverse = oppositeDirection(player.direction);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.x === target.x && current.y === target.y) return current.path;
    const ordered = directions.slice().sort((left, right) => {
      const leftDelta = directionDelta(left);
      const rightDelta = directionDelta(right);
      const leftDistance = Math.abs(current.x + leftDelta.x - target.x) +
        Math.abs(current.y + leftDelta.y - target.y);
      const rightDistance = Math.abs(current.x + rightDelta.x - target.x) +
        Math.abs(current.y + rightDelta.y - target.y);
      return leftDistance - rightDistance;
    });
    for (const direction of ordered) {
      if (current.path.length === 0 && direction === reverse) continue;
      const delta = directionDelta(direction);
      const next = { x: current.x + delta.x, y: current.y + delta.y };
      const key = cellKey(next);
      if (
        next.x < 0 || next.y < 0 ||
        next.x >= state.boardSize || next.y >= state.boardSize ||
        blocked.has(key) || seen.has(key)
      ) continue;
      seen.add(key);
      queue.push({ x: next.x, y: next.y, path: current.path.concat(direction) });
    }
  }
  return null;
}

function directionDelta(direction) {
  return {
    up: { x: 0, y: -1 },
    right: { x: 1, y: 0 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 }
  }[direction];
}

function directionKey(direction) {
  return {
    up: "ArrowUp",
    right: "ArrowRight",
    down: "ArrowDown",
    left: "ArrowLeft"
  }[direction];
}

function oppositeDirection(direction) {
  return { up: "down", down: "up", left: "right", right: "left" }[direction];
}

function cellKey(cell) {
  return cell.x + "," + cell.y;
}

function pointText(point) {
  return "(" + point.x + "," + point.y + ")";
}

async function assertModeSurface(page) {
  const state = await page.evaluate(() => {
    const expectedModeIds = ["singlePlayerBtn", "soloBtn", "mazeBtn"];
    const modeLaunchIds = Array.from(document.querySelectorAll("button[id], a[id]"))
      .map((element) => element.id)
      .filter((id) => /singlePlayer|solo|maze|coop|multiplayer|arenaOnline|arenaWatch|bombVault|moreModes/i.test(id));
    const bodyText = (document.body.textContent || "").toLowerCase();
    const forbiddenPhrases = [
      "co-op",
      "coop",
      "multiplayer",
      "coming soon",
      "arena online",
      "watch online",
      "bomb vault"
    ].filter((phrase) => bodyText.includes(phrase));
    return {
      expectedModeIds,
      modeLaunchIds,
      missingModeIds: expectedModeIds.filter((id) => !document.getElementById(id)),
      unreachableModeIds: expectedModeIds.filter((id) => {
        const element = document.getElementById(id);
        if (!element || element.disabled) return true;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width <= 0 || rect.height <= 0 || style.display === "none" ||
          style.visibility === "hidden" || style.pointerEvents === "none";
      }),
      removedIds: [
      "createCoopBtn",
      "arenaOnlineBtn",
      "arenaWatchBtn",
      "multiplayerBtn",
      "moreModesBtn",
      "bombVaultBtn",
      "coopInvite",
      "coopLobby",
      "arenaChat"
    ].filter((id) => document.getElementById(id)),
      forbiddenPhrases,
    browserNetworkingApi: typeof window.ArenaNet
    };
  });
  assert.deepEqual(state.missingModeIds, [], "One or more of the three mode launch controls is missing");
  assert.deepEqual(state.unreachableModeIds, [], "One or more of the three modes is not reachable from the landing screen");
  assert.deepEqual(
    state.modeLaunchIds.slice().sort(),
    state.expectedModeIds.slice().sort(),
    "The landing document exposes a mode outside Arena, Classic, and Rune Maze"
  );
  assert.deepEqual(state.removedIds, [], "Removed UI remains in the browser DOM");
  assert.deepEqual(state.forbiddenPhrases, [], "Removed/placeholder mode copy remains in the browser DOM");
  assert.equal(state.browserNetworkingApi, "undefined", "Removed browser networking API is still exposed");
  return state;
}

async function installArenaProbe(context) {
  await context.addInitScript(() => {
    const nativePush = Array.prototype.push;
    const probe = {
      player: null,
      foods: null,
      spawnCount: 0
    };
    Object.defineProperty(window, "__snakeArenaProbe", {
      configurable: true,
      value: probe
    });
    Array.prototype.push = function (...items) {
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        if (
          item.isPlayer === true &&
          Number.isFinite(item.x) &&
          Number.isFinite(item.y) &&
          Array.isArray(item.trail) &&
          Array.isArray(item.body)
        ) {
          probe.player = item;
          probe.spawnCount += 1;
          // Capture the state AT SPAWN. Polling for it later is a race: an Arena
          // snake can spawn, eat and die inside a single animation frame (measured
          // at 13ms), so `alive && score === 0` may never be true when the poll runs.
          probe.lastSpawnScore = Number(item.score) || 0;
          probe.lastSpawnAlive = item.alive !== false;
        }
        if (
          Number.isFinite(item.x) &&
          Number.isFinite(item.y) &&
          Number.isFinite(item.mass) &&
          Number.isFinite(item.r) &&
          typeof item.color === "string" &&
          typeof item.label === "string" &&
          typeof item.shape === "string" &&
          Number.isFinite(item.phase)
        ) {
          probe.foods = this;
        }
      }
      return Reflect.apply(nativePush, this, items);
    };
  });
}

async function arenaSnapshot(page) {
  return page.evaluate(() => {
    const probe = window.__snakeArenaProbe;
    const player = probe && probe.player;
    if (!player) return null;
    return {
      x: player.x,
      y: player.y,
      angle: player.angle,
      targetAngle: player.targetAngle,
      mass: player.mass,
      score: player.score,
      alive: player.alive,
      spawnCount: probe.spawnCount,
      foodCount: probe.foods ? probe.foods.length : 0
    };
  });
}

async function steerArenaUntilScoreIncreases(page, initialScore, timeoutMs) {
  const canvas = page.locator("#arenaCanvas");
  const box = await canvas.boundingBox();
  assert(box, "Arena canvas has no input box");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = await page.evaluate(() => {
      const probe = window.__snakeArenaProbe;
      const player = probe && probe.player;
      if (!player || !player.alive || !probe.foods) return null;
      let nearest = null;
      let nearestDistance = Infinity;
      for (const food of probe.foods) {
        const distance = (food.x - player.x) ** 2 + (food.y - player.y) ** 2;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = food;
        }
      }
      return nearest ? {
        playerX: player.x,
        playerY: player.y,
        score: player.score,
        alive: player.alive,
        targetX: nearest.x,
        targetY: nearest.y
      } : null;
    });
    assert(target && target.alive, "Arena player died before collecting food");
    if (target.score > initialScore) return arenaSnapshot(page);
    const angle = Math.atan2(target.targetY - target.playerY, target.targetX - target.playerX);
    await page.mouse.move(
      box.x + box.width / 2 + Math.cos(angle) * 260,
      box.y + box.height / 2 + Math.sin(angle) * 260
    );
    try {
      await page.waitForFunction((before) => {
        const player = window.__snakeArenaProbe && window.__snakeArenaProbe.player;
        return !player || !player.alive || player.score > before.score ||
          Math.hypot(player.x - before.x, player.y - before.y) > 10;
      }, { x: target.playerX, y: target.playerY, score: initialScore }, { timeout: 1200 });
    } catch (error) {
      if (!String(error && error.message).includes("Timeout")) throw error;
    }
    const current = await arenaSnapshot(page);
    if (current && current.score > initialScore) return current;
  }
  throw new Error("Arena did not collect a real food item before the scoring deadline");
}

async function steerArenaToBoundaryDeath(page, timeoutMs) {
  const canvas = page.locator("#arenaCanvas");
  const box = await canvas.boundingBox();
  assert(box, "Arena canvas has no input box");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const before = await arenaSnapshot(page);
    assert(before, "Arena probe lost the player before death");
    if (!before.alive) return before;
    const radius = Math.hypot(before.x, before.y);
    const angle = radius > 25 ? Math.atan2(before.y, before.x) : before.angle;
    await page.mouse.move(
      box.x + box.width / 2 + Math.cos(angle) * 300,
      box.y + box.height / 2 + Math.sin(angle) * 300
    );
    try {
      await page.waitForFunction((position) => {
        const player = window.__snakeArenaProbe && window.__snakeArenaProbe.player;
        return !player || !player.alive || Math.hypot(player.x - position.x, player.y - position.y) > 12;
      }, { x: before.x, y: before.y }, { timeout: 1200 });
    } catch (error) {
      if (!String(error && error.message).includes("Timeout")) throw error;
    }
  }
  throw new Error("Arena did not reach the real world boundary before the death deadline");
}

function signedAngleDelta(before, after) {
  return Math.atan2(Math.sin(after - before), Math.cos(after - before));
}

async function waitForCanvasPaint(page, selector) {
  await page.waitForFunction((canvasSelector) => {
    const canvas = document.querySelector(canvasSelector);
    if (!canvas || canvas.width <= 100 || canvas.height <= 100) return false;
    const sample = document.createElement("canvas");
    sample.width = 16;
    sample.height = 16;
    const sampleContext = sample.getContext("2d", { willReadFrequently: true });
    sampleContext.drawImage(canvas, 0, 0, 16, 16);
    const pixels = sampleContext.getImageData(0, 0, 16, 16).data;
    const colors = new Set();
    let lit = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      colors.add(
        pixels[index] + "," + pixels[index + 1] + "," +
        pixels[index + 2] + "," + pixels[index + 3]
      );
      if (pixels[index + 3] > 0 && pixels[index] + pixels[index + 1] + pixels[index + 2] > 24) lit += 1;
    }
    return colors.size >= 3 && lit >= 3;
  }, selector, { timeout: 5000 });
}

async function canvasEvidence(page, selector) {
  return page.locator(selector).evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const width = canvas.width;
    const height = canvas.height;
    const stepX = Math.max(1, Math.floor(width / 64));
    const stepY = Math.max(1, Math.floor(height / 64));
    const colors = new Set();
    let visibleSamples = 0;
    let sampled = 0;
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const pixel = context.getImageData(x, y, 1, 1).data;
        colors.add(pixel[0] + "," + pixel[1] + "," + pixel[2] + "," + pixel[3]);
        if (pixel[3] > 0 && pixel[0] + pixel[1] + pixel[2] > 24) visibleSamples += 1;
        sampled += 1;
      }
    }
    return {
      width,
      height,
      cssWidth: Math.round(rect.width),
      cssHeight: Math.round(rect.height),
      colors: colors.size,
      visibleSamples,
      sampled,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(canvas).display !== "none"
    };
  });
}

function assertCanvasEvidence(evidence, label) {
  assert.equal(evidence.visible, true, label + " canvas is not visible");
  assert(evidence.width > 100 && evidence.height > 100, label + " canvas backing store is too small");
  assert(evidence.cssWidth > 100 && evidence.cssHeight > 100, label + " canvas layout is too small");
  assert(evidence.colors >= 3, label + " canvas appears blank (too few sampled colors)");
  assert(evidence.visibleSamples >= 3, label + " canvas appears blank (no lit samples)");
}

async function monitoredPage(context) {
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => requests.push(request.url()));
  return { page, errors, requests };
}

function assertNoBrowserErrors(errors, label) {
  assert.equal(errors.length, 0, label + " browser errors:\n" + errors.join("\n"));
}

function assertSameOriginRequests(requests, baseUrl, label) {
  const expectedOrigin = new URL(baseUrl).origin;
  const external = requests.filter((requestUrl) => {
    const parsed = new URL(requestUrl);
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return false;
    return parsed.origin !== expectedOrigin;
  });
  assert.equal(
    external.length,
    0,
    label + " made external network requests" + (external.length ? ":\n" + external.join("\n") : "")
  );
}

async function runTest(name, test) {
  const started = process.hrtime.bigint();
  try {
    const evidence = await test();
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    completedTests.push({ name, ms });
    console.log("PASS " + name + " (" + ms + " ms)");
    return evidence;
  } catch (error) {
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    console.error("FAIL " + name + " (" + ms + " ms)");
    throw error;
  }
}

function printEvidence(label, evidence) {
  const canvas = evidence.canvas || evidence;
  let output = "- " + label + ": " + (evidence.summary || "");
  if (canvas && Number.isFinite(canvas.width)) {
    if (evidence.summary) output += "; ";
    output += canvas.width + "x" + canvas.height + " backing, " +
      canvas.cssWidth + "x" + canvas.cssHeight + " CSS, " +
      canvas.colors + " sampled colors, " +
      canvas.visibleSamples + "/" + canvas.sampled + " lit samples";
  }
  console.log(output);
}

function findBrowserExecutable() {
  const candidates = [
    process.env.E2E_BROWSER_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    chromium.executablePath()
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("No Playwright-compatible browser found; set E2E_BROWSER_PATH.");
  return executable;
}

function cleanupDatabase(filePath) {
  if (!filePath) return;
  for (const suffix of ["", "-shm", "-wal"]) {
    const candidate = filePath + suffix;
    if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
