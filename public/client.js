// A keystroke aimed at a text box is not a game control. Without this, the WASD
// bindings below swallowed the very letters people need to type: entering
// "Adam" in the initials box produced "m", because W, A, S and D each hit
// preventDefault() before the character could reach the field. Reported by a
// play-tester who could not type his own name.
function isTypingTarget(target) {
  if (!target || typeof target.tagName !== "string") return false;
  const tag = target.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

const canvas = document.querySelector("#board");
const ctx = canvas.getContext("2d");
const statusEl = document.querySelector("#status");
const roomCodeEl = document.querySelector("#roomCode");
const levelTextEl = document.querySelector("#levelText");
const bestScoreEl = document.querySelector("#bestScore");
const gameStatusEl = document.querySelector("#gameStatus");
const scoreboardEl = document.querySelector("#scoreboard");
const nameEl = document.querySelector("#playerName");
const restartBtn = document.querySelector("#restartBtn");
const skinGrid = document.querySelector("#skinGrid");
const muteBtn = document.querySelector("#muteBtn");
const tickSoundToggle = document.querySelector("#tickSoundToggle");
const gameWrapEl = document.querySelector(".game-wrap");
const boardStageEl = document.querySelector("#boardStage");
const classicOverlayEl = document.querySelector("#classicOverlay");
const classicPauseBtn = document.querySelector("#classicPauseBtn");
const controlsEl = document.querySelector(".controls");
const mazeBtn = document.querySelector("#mazeBtn");
const mazeRewardEl = document.querySelector("#mazeReward");
const classicScoreNoticeEl = document.querySelector("#classicScoreNotice");
const adventure = window.ClassicAdventure;

const COUNTDOWN_TOTAL_MS = 2500;
const LEVEL_PAUSE_MS = 800;
const HIGH_SCORE_KEY = "snakeHighScore";
const MUTE_KEY = "snakeMuted";
const MOVE_TICK_KEY = "snakeMoveTick";
const CLASSIC_MAX_DPR = 2.5;
const CLASSIC_MAX_BACKING = 4096;
const CLASSIC_MIN_CANVAS = 96;
const BOMB_SCORE_BONUS = 25;
const BOMB_CLEAR_RADIUS = 5;
const LEVEL_META = [
  { name: "Grid One", moveMs: 180, accent: "#46f2a4", obstacles: [] },
  { name: "Neon Sprint", moveMs: 140, accent: "#56c7ff", obstacles: [] },
  {
    name: "Circuit Break",
    moveMs: 115,
    accent: "#ffcf5a",
    obstacles: [
      ...range(9, 23).map((x) => ({ x, y: 10 })),
      ...range(9, 23).map((x) => ({ x, y: 21 }))
    ]
  },
  {
    name: "Core Maze",
    moveMs: 95,
    accent: "#ff5d73",
    obstacles: [
      ...range(6, 14).map((y) => ({ x: 8, y })),
      ...range(18, 26).map((y) => ({ x: 23, y })),
      ...range(12, 20).map((x) => ({ x, y: 16 }))
    ]
  }
];

const skins = {
  classic: { colors: ["#46f2a4", "#227a55"], glow: "#46f2a4" },
  neon: { colors: ["#56c7ff", "#e85cff"], glow: "#e85cff" },
  block: { colors: ["#ffcf5a", "#bf6b2f"], glow: "#ffcf5a" },
  stripe: { colors: ["#ffffff", "#ff5d73"], glow: "#ff5d73" },
  chrome: { colors: ["#c8d7e1", "#5e7483"], glow: "#c8d7e1" }
};

const powerUpMeta = {
  speed: { color: "#56c7ff", label: "SPEED" },
  shrink: { color: "#ffcf5a", label: "SHRINK" },
  shield: { color: "#46f2a4", label: "SHIELD" },
  bomb: { color: "#ff5d73", label: "BOMB" }
};

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  setMuted(muted) {
    this.muted = muted;
  }

  resume() {
    const ctx = this.ensure();
    if (ctx?.state === "suspended") ctx.resume();
  }

  eat() {
    this.tone(440, 880, 0.08, "triangle", 0.065);
  }

  death() {
    this.tone(260, 60, 0.2, "sawtooth", 0.075);
  }

  levelUp() {
    [261.63, 329.63, 392].forEach((freq, index) => {
      this.tone(freq, freq * 1.02, 0.09, "square", 0.05, index * 0.095);
    });
  }

  rune(index) {
    const roots = [392, 523.25, 659.25];
    const root = roots[Math.max(0, Math.min(roots.length - 1, index))];
    this.tone(root, root * 1.25, 0.16, "sine", 0.065);
  }

  bomb() {
    this.tone(150, 48, 0.24, "sawtooth", 0.075);
  }

  victory() {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
      this.tone(freq, freq * 1.01, 0.13, "triangle", 0.055, index * 0.09);
    });
  }

  move() {
    if (!moveTickEnabled) return;
    this.tone(110, 82, 0.01, "square", 0.012);
  }

  countdown(go) {
    this.tone(go ? 880 : 330, go ? 1175 : 330, 0.085, go ? "square" : "sine", 0.055);
  }

  tone(startFreq, endFreq, duration, type, gainValue, delay = 0) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  ensure() {
    if (!window.AudioContext && !window.webkitAudioContext) return null;
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }
}

let selectedSkin = "classic";
let mode = "idle";
const playerId = "solo";
let soloState = null;
let soloTimer = null;
let soloDirection = "right";
let soloNextDirection = "right";
let soloCountdownUntil = 0;
let soloLevelPauseUntil = 0;
let soloLastMoveAt = 0;
let soloPaused = false;
let soloPauseStartedAt = 0;
let soloEffects = {};
let soloNewBest = false;
let levelOverlay = { text: "", until: 0, accent: "#ffcf5a" };
let particles = [];
let confetti = [];
let deathEffects = new Map();
let lastFrameAt = performance.now();
let lastCountdownKey = "";
let highScore = Number(localStorage.getItem(HIGH_SCORE_KEY) || 0);
let moveTickEnabled = localStorage.getItem(MOVE_TICK_KEY) !== "false";
let muted = localStorage.getItem(MUTE_KEY) === "true";
let classicCanvasSize = Number(canvas.getAttribute("width")) || 768;
let classicCanvasDpr = 1;
let classicResizePending = true;
let classicResizeObserver = null;
let gameWakeLock = null;
let bombCoreUnlocked = adventure ? localStorage.getItem(adventure.UNLOCK_KEY) === "true" : false;
let classicScoreRun = null;

const sound = new SoundEngine();
sound.setMuted(muted);

init();

function init() {
  renderSkinChoices();
  updateMuteButton();
  bestScoreEl.textContent = highScore;
  restartBtn.disabled = true;
  restartBtn.title = "Start a Classic game to restart.";
  tickSoundToggle.checked = moveTickEnabled;
  updateAdventureButtons();
  document.title = "RETRO SNAKE ARENA";
  setupClassicViewport();

  document.querySelector("#soloBtn").addEventListener("click", () => {
    enterGameFullscreen();
    sound.resume();
    startSolo();
  });
  if (mazeBtn) mazeBtn.addEventListener("click", () => {
    enterGameFullscreen();
    sound.resume();
    startMazeTrial();
  });
  restartBtn.addEventListener("click", () => {
    sound.resume();
    hideClassicOverlay();
    restartGame();
  });
  if (classicPauseBtn) {
    classicPauseBtn.addEventListener("click", () => setClassicPaused(!soloPaused));
  }
  muteBtn.addEventListener("click", toggleMute);
  tickSoundToggle.addEventListener("change", () => {
    moveTickEnabled = tickSoundToggle.checked;
    localStorage.setItem(MOVE_TICK_KEY, moveTickEnabled ? "true" : "false");
  });
  document.querySelectorAll("[data-dir]").forEach((button) => {
    button.addEventListener("click", () => setDirection(button.dataset.dir));
  });

  window.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) return;
    if ((event.code === "Escape" || event.code === "KeyP") &&
        (mode === "solo" || mode === "maze") && soloState) {
      event.preventDefault();
      setClassicPaused(!soloPaused);
      return;
    }
    const map = {
      ArrowUp: "up",
      KeyW: "up",
      ArrowDown: "down",
      KeyS: "down",
      ArrowLeft: "left",
      KeyA: "left",
      ArrowRight: "right",
      KeyD: "right"
    };
    if (map[event.code]) {
      event.preventDefault();
      setDirection(map[event.code]);
    }
  });

  fitClassicBoard();
  requestAnimationFrame(drawLoop);
}

function setupClassicViewport() {
  queueClassicResize();
  window.addEventListener("resize", queueClassicResize);
  window.addEventListener("orientationchange", queueClassicResize);
  document.addEventListener("fullscreenchange", queueClassicResize);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", queueClassicResize);

  if ("ResizeObserver" in window) {
    classicResizeObserver = new ResizeObserver(queueClassicResize);
    [gameWrapEl, boardStageEl, controlsEl].forEach((el) => {
      if (el) classicResizeObserver.observe(el);
    });
  }
}

function enterGameFullscreen() {
  requestGameWakeLock();
  if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) return;
  const target = document.documentElement;
  const request = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
  if (!request) return;
  try {
    const result = request.call(target);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Fullscreen is best-effort because browsers can reject it outside user gestures.
  }
}

window.enterGameFullscreen = enterGameFullscreen;

async function requestGameWakeLock() {
  if (!navigator.wakeLock || document.visibilityState !== "visible") return;
  if (gameWakeLock) return;
  try {
    gameWakeLock = await navigator.wakeLock.request("screen");
    gameWakeLock.addEventListener("release", () => {
      gameWakeLock = null;
    });
  } catch {
    // Wake Lock is optional and can be denied by browser/device policy.
  }
}

async function releaseGameWakeLock() {
  const lock = gameWakeLock;
  gameWakeLock = null;
  if (!lock) return;
  try {
    await lock.release();
  } catch {
    // Ignore release races when the browser already released it.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.body.classList.contains("is-playing")) {
    requestGameWakeLock();
  }
});

window.requestGameWakeLock = requestGameWakeLock;
window.releaseGameWakeLock = releaseGameWakeLock;

function queueClassicResize() {
  classicResizePending = true;
}

function fitClassicBoard() {
  if (!gameWrapEl) return;

  const isPlaying = document.body.classList.contains("is-playing");
  let availableWidth;
  let availableHeight;

  if (isPlaying && boardStageEl) {
    // In play the board is sized from the board stage — a grid track that the
    // viewport sizes directly (100svh shell minus the rail and controls). The
    // HUD never competes with the board for height; it takes what it needs and
    // the stage gets everything left over.
    availableWidth = boardStageEl.clientWidth;
    availableHeight = boardStageEl.clientHeight;
  } else {
    const wrapStyle = getComputedStyle(gameWrapEl);
    const paddingX = cssPx(wrapStyle.paddingLeft) + cssPx(wrapStyle.paddingRight);
    availableWidth = gameWrapEl.clientWidth - paddingX;
    availableHeight = Math.min(viewportHeight() * 0.72, 820);
  }

  availableWidth = Math.max(CLASSIC_MIN_CANVAS, availableWidth || classicCanvasSize);
  availableHeight = Math.max(CLASSIC_MIN_CANVAS, availableHeight || classicCanvasSize);

  const displaySize = Math.max(
    CLASSIC_MIN_CANVAS,
    Math.floor(Math.min(availableWidth, availableHeight))
  );
  const maxDprByBacking = CLASSIC_MAX_BACKING / displaySize;
  const dpr = Math.max(1, Math.min(CLASSIC_MAX_DPR, maxDprByBacking, window.devicePixelRatio || 1));
  const backingSize = Math.max(1, Math.round(displaySize * dpr));

  canvas.style.width = `${displaySize}px`;
  canvas.style.height = `${displaySize}px`;
  if (canvas.width !== backingSize || canvas.height !== backingSize) {
    canvas.width = backingSize;
    canvas.height = backingSize;
  }

  classicCanvasSize = displaySize;
  classicCanvasDpr = dpr;
  classicResizePending = false;
}

function prepareClassicCanvas() {
  if (classicResizePending) fitClassicBoard();
  ctx.setTransform(classicCanvasDpr, 0, 0, classicCanvasDpr, 0, 0);
  return classicCanvasSize;
}

function viewportHeight() {
  return Math.round(
    window.visualViewport?.height ||
    window.innerHeight ||
    document.documentElement.clientHeight ||
    classicCanvasSize
  );
}

function cssPx(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderSkinChoices() {
  skinGrid.innerHTML = "";
  Object.entries(skins).forEach(([name, skin]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `skin ${name === selectedSkin ? "active" : ""}`;
    button.title = name;
    button.setAttribute("aria-label", name + " colour");
    button.setAttribute("aria-pressed", name === selectedSkin ? "true" : "false");
    const swatch = document.createElement("span");
    swatch.style.setProperty("--skin-a", skin.colors[0]);
    swatch.style.setProperty("--skin-b", skin.colors[1]);
    button.appendChild(swatch);
    button.addEventListener("click", () => {
      selectedSkin = name;
      renderSkinChoices();
    });
    skinGrid.appendChild(button);
  });
}

function startSolo() {
  prepareSoloSession("solo");

  soloState = {
    roomCode: "SOLO",
    boardSize: 32,
    level: 1,
    levelName: "Grid One",
    levelAccent: "#46f2a4",
    obstacles: [],
    food: { x: 20, y: 12 },
    powerUp: null,
    playerEffects: { solo: {} },
    countdownMs: COUNTDOWN_TOTAL_MS,
    levelBanner: "",
    levelBannerMs: 0,
    running: true,
    message: "",
    players: [{
      id: "solo",
      name: playerName(),
      skin: selectedSkin,
      score: 0,
      alive: true,
      direction: "right",
      snake: [{ x: 6, y: 16 }, { x: 5, y: 16 }, { x: 4, y: 16 }, { x: 3, y: 16 }]
    }]
  };
  soloState.powerUp = Math.random() < 0.15 ? randomPowerUp(soloState) : null;
  soloTimer = setInterval(tickSolo, 45);
  updateHud(soloState);
}

function startMazeTrial() {
  if (!adventure) {
    setStatus("Rune Maze is unavailable.");
    return;
  }
  prepareSoloSession("maze");
  const start = adventure.START;
  soloDirection = "down";
  soloNextDirection = "down";
  soloState = {
    roomCode: "MAZE",
    boardSize: adventure.BOARD_SIZE,
    level: 1,
    levelName: "Rune 0/3",
    levelAccent: adventure.RUNES[0].color,
    obstacles: adventure.obstaclesFor(0),
    food: null,
    powerUp: null,
    playerEffects: { solo: {} },
    countdownMs: COUNTDOWN_TOTAL_MS,
    levelBanner: "RUNE MAZE",
    levelBannerMs: 0,
    running: true,
    message: "",
    maze: {
      collected: 0,
      runes: adventure.RUNES,
      gates: adventure.GATES,
      portal: adventure.PORTAL
    },
    players: [{
      id: "solo",
      name: playerName(),
      skin: selectedSkin,
      score: 0,
      alive: true,
      direction: "down",
      snake: [
        { x: start.x, y: start.y },
        { x: start.x, y: start.y - 1 },
        { x: start.x, y: start.y - 2 },
        { x: start.x, y: start.y - 3 }
      ]
    }]
  };
  levelOverlay = {
    text: "RUNE MAZE - FIND TIDE",
    until: performance.now() + 1400,
    accent: adventure.RUNES[0].color
  };
  soloTimer = setInterval(tickSolo, 45);
  updateHud(soloState);
}

function prepareSoloSession(nextMode) {
  stopSolo();
  cancelClassicScoreRun();
  classicScoreRun = window.SnakeRunScores
    ? window.SnakeRunScores.begin(nextMode === "maze" ? "rune" : "classic")
    : null;
  if (classicScoreNoticeEl) classicScoreNoticeEl.textContent = "";
  mode = nextMode;
  gameWrapEl.hidden = false;
  soloPaused = false;
  if (classicPauseBtn) classicPauseBtn.setAttribute("aria-pressed", "false");
  hideClassicOverlay();
  soloDirection = "right";
  soloNextDirection = "right";
  soloEffects = {};
  soloNewBest = false;
  soloLastMoveAt = performance.now();
  soloCountdownUntil = performance.now() + COUNTDOWN_TOTAL_MS;
  soloLevelPauseUntil = 0;
  particles = [];
  confetti = [];
  deathEffects = new Map();
  document.body.classList.add("is-playing");
  queueClassicResize();
}

function tickSolo() {
  if (!soloState || soloPaused) return;
  const now = performance.now();
  soloState.countdownMs = Math.max(0, soloCountdownUntil - now);
  soloState.levelBannerMs = Math.max(0, soloLevelPauseUntil - now);
  refreshSoloEffects(now);

  const player = soloState.players[0];
  if (!player.alive || !soloState.running || soloState.countdownMs > 0 || soloState.levelBannerMs > 0) {
    updateHud(soloState);
    return;
  }

  if (mode === "maze") {
    tickMaze(now, player);
    return;
  }

  if (now - soloLastMoveAt < soloMoveInterval(now)) return;
  soloLastMoveAt = now;
  player.direction = soloNextDirection;
  soloDirection = soloNextDirection;
  sound.move();

  const delta = dir(soloDirection);
  const head = player.snake[0];
  let next = { x: head.x + delta.x, y: head.y + delta.y };
  const shielded = hasSoloEffect("shield", now);

  if (outside(next, soloState.boardSize)) {
    if (shielded) next = wrap(next, soloState.boardSize);
    else return finishSoloGame();
  }

  const ate = same(next, soloState.food);
  const tookPowerUp = soloState.powerUp && same(next, soloState.powerUp);
  const body = ate ? player.snake : player.snake.slice(0, -1);

  if (!shielded && (hitsObstacle(soloState, next) || body.some((part) => same(part, next)))) {
    return finishSoloGame();
  }

  player.snake.unshift(next);
  if (ate) {
    player.score += 10 * soloState.level;
    spawnFoodBurst(soloState.food, player.skin);
    sound.eat();
    updateSoloLevel(player.score);
    soloState.food = placeSoloFood(soloState);
    soloState.powerUp = Math.random() < 0.15 ? randomPowerUp(soloState) : null;
  } else {
    player.snake.pop();
  }

  if (tookPowerUp && soloState.powerUp) {
    applySoloPowerUp(soloState.powerUp.type, now);
    soloState.powerUp = null;
  }

  updateHud(soloState);
}

function tickMaze(now, player) {
  if (now - soloLastMoveAt < soloMoveInterval(now)) return;
  soloLastMoveAt = now;
  player.direction = soloNextDirection;
  soloDirection = soloNextDirection;
  sound.move();

  const delta = dir(soloDirection);
  const head = player.snake[0];
  const next = { x: head.x + delta.x, y: head.y + delta.y };
  const body = player.snake.slice(0, -1);
  if (outside(next, soloState.boardSize) || hitsObstacle(soloState, next) || body.some((part) => same(part, next))) {
    finishMazeGame();
    return;
  }

  player.snake.unshift(next);
  player.snake.pop();

  const before = soloState.maze.collected;
  const after = adventure.collectRune(before, next);
  if (after > before) collectMazeRune(after, next, player);

  if (adventure.portalOpen(soloState.maze.collected) && same(next, soloState.maze.portal)) {
    completeMaze(player);
    return;
  }
  updateHud(soloState);
}

function collectMazeRune(collected, position, player) {
  const rune = adventure.RUNES[collected - 1];
  soloState.maze.collected = collected;
  soloState.obstacles = adventure.obstaclesFor(collected);
  soloState.levelName = `Rune ${collected}/${adventure.RUNES.length}`;
  soloState.levelAccent = rune.color;
  player.score += 100;
  spawnColorBurst(position, rune.color, 18);
  sound.rune(collected - 1);
  flashCanvas(rune.color);
  const nextRune = adventure.currentRune(collected);
  levelOverlay = {
    text: nextRune ? `${rune.name} GATE OPEN - FIND ${nextRune.name}` : "ALL RUNES - ENTER THE PORTAL",
    until: performance.now() + 1350,
    accent: rune.color
  };
}

function finishMazeGame() {
  const player = soloState.players[0];
  player.alive = false;
  soloState.running = false;
  soloState.message = "Maze lost";
  deathEffects.set(player.id, performance.now());
  sound.death();
  updateHud(soloState);
  submitClassicScore("rune", player.score, 0);
  scheduleClassicResult(soloState, 900);
}

function completeMaze(player) {
  const newlyUnlocked = !bombCoreUnlocked;
  soloState.running = false;
  soloState.message = newlyUnlocked ? "Bomb Core unlocked" : "Maze cleared";
  player.score += 500;
  if (!bombCoreUnlocked) {
    bombCoreUnlocked = true;
    localStorage.setItem(adventure.UNLOCK_KEY, "true");
    updateAdventureButtons();
  }
  spawnColorBurst(soloState.maze.portal, "#ffcf5a", 32);
  spawnConfetti(player.skin);
  sound.victory();
  levelOverlay = {
    text: newlyUnlocked ? "BOMB CORE UNLOCKED FOR SOLO" : "RUNE MAZE CLEARED",
    until: performance.now() + 1800,
    accent: "#ffcf5a"
  };
  updateHud(soloState);
  submitClassicScore("rune", player.score, 0);
  scheduleClassicResult(soloState, 1900);
}

function finishSoloGame() {
  const player = soloState.players[0];
  player.alive = false;
  soloState.running = false;
  deathEffects.set(player.id, performance.now());
  sound.death();

  const previousBest = highScore;
  if (player.score > highScore) {
    highScore = player.score;
    soloNewBest = true;
    localStorage.setItem(HIGH_SCORE_KEY, String(highScore));
    soloState.message = "Game over - NEW BEST!";
  } else {
    soloState.message = "Game over";
  }
  updateHud(soloState);
  submitClassicScore("classic", player.score, previousBest);
  scheduleClassicResult(soloState, 900);
}

function updateSoloLevel(score) {
  const oldLevel = soloState.level;
  const nextLevel = Math.min(LEVEL_META.length, 1 + Math.floor(score / 60));
  soloState.level = nextLevel;
  const meta = LEVEL_META[nextLevel - 1];
  soloState.levelName = meta.name;
  soloState.levelAccent = meta.accent;
  soloState.obstacles = meta.obstacles;

  if (nextLevel > oldLevel) {
    const now = performance.now();
    soloLevelPauseUntil = now + LEVEL_PAUSE_MS;
    soloState.levelBanner = `LEVEL ${nextLevel} - ${meta.name.toUpperCase()}`;
    soloState.levelBannerMs = LEVEL_PAUSE_MS;
    levelOverlay = { text: soloState.levelBanner, until: soloLevelPauseUntil, accent: meta.accent };
    sound.levelUp();
    flashCanvas(meta.accent);
  }
}

function restartGame() {
  hideClassicOverlay();
  if (mode === "solo") return startSolo();
  if (mode === "maze") return startMazeTrial();
}

function setDirection(direction) {
  if (soloPaused) return;
  if (mode === "solo" || mode === "maze") {
    if (!isReverse(soloDirection, direction)) soloNextDirection = direction;
  }
}

// ---- Pause + the single overlay slot (pause / result, mutually exclusive) --
function classicRunLive() {
  return Boolean(soloState && soloState.running && soloState.players[0].alive &&
    (mode === "solo" || mode === "maze"));
}

function setClassicPaused(paused) {
  if (paused && !classicRunLive()) return;
  if (paused === soloPaused) return;
  soloPaused = paused;
  if (classicPauseBtn) classicPauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
  if (paused) {
    soloPauseStartedAt = performance.now();
    showClassicOverlay(buildPauseCard());
    requestAnimationFrame(() => document.getElementById("classicResumeBtn")?.focus());
  } else {
    // Shift every wall-clock anchor forward by the paused span so timers,
    // countdowns and power-up effects do not advance while the game was paused.
    const pausedFor = performance.now() - soloPauseStartedAt;
    soloCountdownUntil += pausedFor;
    soloLevelPauseUntil += pausedFor;
    soloLastMoveAt += pausedFor;
    if (levelOverlay.until > 0) levelOverlay.until += pausedFor;
    for (const name of Object.keys(soloEffects)) soloEffects[name] += pausedFor;
    hideClassicOverlay();
  }
  updateHud(soloState);
}

function showClassicOverlay(card) {
  if (!classicOverlayEl) return;
  classicOverlayEl.replaceChildren(card);
  classicOverlayEl.hidden = false;
}

function hideClassicOverlay() {
  if (!classicOverlayEl) return;
  classicOverlayEl.hidden = true;
  classicOverlayEl.replaceChildren();
}

function overlayButton(id, label, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  if (className) button.className = className;
  button.textContent = label;
  return button;
}

function buildOverlayCard(tagText, titleText) {
  const card = document.createElement("section");
  card.className = "overlay-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");

  const tag = document.createElement("p");
  tag.className = "mode-tag";
  tag.textContent = tagText;
  const title = document.createElement("h2");
  title.textContent = titleText;
  card.append(tag, title);
  return card;
}

function buildPauseCard() {
  const card = buildOverlayCard(
    `${mode === "maze" ? "Rune Maze" : "Classic"} · ${playerName()}`,
    "Paused"
  );
  const actions = document.createElement("div");
  actions.className = "overlay-actions";

  const resume = overlayButton("classicResumeBtn", "Resume", "primary-action");
  resume.addEventListener("click", () => setClassicPaused(false));
  const restart = overlayButton("classicPauseRestartBtn", "Restart", "");
  restart.addEventListener("click", () => {
    setClassicPaused(false);
    restartGame();
  });
  const quit = overlayButton("classicPauseQuitBtn", "Quit to menu", "danger-btn");
  wireQuitConfirm(quit, () => stopClassicGame());

  actions.append(resume, restart, quit);
  card.append(actions);
  return card;
}

// Quitting a live run discards the score, so the quit button arms first and
// only quits on a second tap within a short window (UX-04).
function wireQuitConfirm(button, onQuit) {
  let armedAt = 0;
  button.addEventListener("click", () => {
    const now = performance.now();
    if (now - armedAt < 3000) {
      armedAt = 0;
      onQuit();
      return;
    }
    armedAt = now;
    button.classList.add("confirming");
    button.textContent = "Tap again to quit";
    setTimeout(() => {
      if (armedAt && performance.now() - armedAt >= 2900) {
        armedAt = 0;
        button.classList.remove("confirming");
        button.textContent = "Quit to menu";
      }
    }, 3000);
  });
}

function scheduleClassicResult(finishedState, delayMs) {
  setTimeout(() => {
    if (soloState !== finishedState || soloState.running || soloPaused) return;
    if (mode !== "solo" && mode !== "maze") return;
    showClassicResult(finishedState);
  }, delayMs);
}

function showClassicResult(state) {
  const player = state.players[0];
  const cleared = mode === "maze" && adventure.portalOpen(state.maze.collected);
  const card = buildOverlayCard(
    `${mode === "maze" ? "Rune Maze" : "Classic"} · ${player.name}`,
    cleared ? "Maze cleared" : "Game over"
  );

  const scoreBlock = document.createElement("div");
  scoreBlock.className = "result-score";
  const scoreLabel = document.createElement("span");
  scoreLabel.textContent = "Score";
  const scoreValue = document.createElement("strong");
  scoreValue.textContent = player.score.toLocaleString("en-GB");
  scoreBlock.append(scoreLabel, scoreValue);

  const best = document.createElement("p");
  best.className = "result-best" + (soloNewBest ? " record" : "");
  best.id = "classicResultBest";
  best.textContent = soloNewBest
    ? "New personal best"
    : mode === "maze" ? "" : `Best ${highScore.toLocaleString("en-GB")}`;

  const notice = document.createElement("p");
  notice.className = "overlay-notice";
  notice.id = "classicResultNotice";
  notice.setAttribute("role", "status");

  const actions = document.createElement("div");
  actions.className = "overlay-actions";
  const again = overlayButton("classicPlayAgainBtn", "Play again", "primary-action");
  again.addEventListener("click", () => {
    sound.resume();
    restartGame();
  });
  const change = overlayButton("classicChangeModeBtn", "Change mode", "");
  change.addEventListener("click", () => stopClassicGame());
  actions.append(again, change);

  card.append(scoreBlock, best, notice, actions);
  showClassicOverlay(card);
  requestAnimationFrame(() => again.focus());
}

function setScoreNotice(text) {
  if (classicScoreNoticeEl) classicScoreNoticeEl.textContent = text;
  const resultNotice = document.getElementById("classicResultNotice");
  if (resultNotice) resultNotice.textContent = text;
}

// Classic and Rune are held to the same fixed 60fps as Arena. The board itself
// steps on its own timer, so this only paces the drawing — but uncapped it still
// repainted at the display's refresh (100+ on a high-refresh monitor) for no
// visible benefit. Same drift-corrected accumulator as arena.js.
const CLASSIC_FRAME_INTERVAL = 1000 / 60;
let classicNextFrameDue = 0;

function drawLoop(timestamp) {
  // Arena runs its own loop and hides the Classic board, so at this point
  // #board measures 0x0 with a null offsetParent and everything below paints
  // into nothing. Skip the work, but keep the rAF alive so returning to Classic
  // can never find a dead loop. Re-anchor the pacing on the way back.
  // Measured 2026-08-14: 600 discarded draw() calls per 10s of Arena, 203.5 ms
  // of main thread, about 0.34 ms stolen from every Arena frame.
  if (document.body.classList.contains("arena-active")) {
    classicNextFrameDue = 0;
    lastFrameAt = timestamp;
    requestAnimationFrame(drawLoop);
    return;
  }
  if (classicNextFrameDue === 0) classicNextFrameDue = timestamp;
  if (timestamp < classicNextFrameDue - 0.5) {
    requestAnimationFrame(drawLoop);
    return;
  }
  classicNextFrameDue += CLASSIC_FRAME_INTERVAL;
  if (classicNextFrameDue < timestamp) classicNextFrameDue = timestamp + CLASSIC_FRAME_INTERVAL;
  const delta = Math.min(48, timestamp - lastFrameAt);
  lastFrameAt = timestamp;
  updateParticles(delta);
  // Freeze the animation clock while paused so countdowns and level banners do
  // not advance behind the pause overlay.
  draw(soloState, soloPaused ? soloPauseStartedAt : timestamp);
  requestAnimationFrame(drawLoop);
}

function draw(state, now) {
  const size = prepareClassicCanvas();
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#030609";
  ctx.fillRect(0, 0, size, size);

  const boardSize = state?.boardSize || 32;
  const cell = size / boardSize;
  drawGrid(boardSize, cell, size);

  if (!state) {
    centerText("RETRO SNAKE ARENA", "Choose a single-player mode");
    drawCrtOverlay(size);
    return;
  }

  if (state.maze) drawMazeBoard(state, cell, now);
  else {
    ctx.fillStyle = "#243442";
    state.obstacles.forEach((part) => fillCell(part, cell, 3));
  }

  if (state.powerUp) drawPowerUp(state.powerUp, cell, now);
  if (state.food) drawFood(state.food, cell, now);

  state.players.forEach((player) => drawSnake(player, cell, now, state.playerEffects?.[player.id] || {}));
  drawParticles(cell);

  const countdownMs = countdownRemaining(state);
  if (countdownMs > 0) {
    drawCountdown(countdownMs, state.roomCode);
  } else {
    lastCountdownKey = "";
  }

  if (levelOverlay.until > now) drawLevelOverlay(levelOverlay.text, levelOverlay.accent);

  if (!state.running && state.message && countdownMs <= 0 && levelOverlay.until <= now) {
    const subtitle = mode === "maze"
      ? (adventure.portalOpen(state.maze.collected) ? "Bomb Core is ready in Solo" : "Press restart to retry the maze")
      : soloNewBest ? "NEW BEST! Press restart for another run" : "Press restart for another round";
    centerText(state.message.toUpperCase(), subtitle);
  }

  drawCrtOverlay(size);
}

function drawGrid(boardSize, cell, size) {
  ctx.strokeStyle = "rgba(86, 199, 255, 0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= boardSize; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell);
    ctx.lineTo(size, i * cell);
    ctx.stroke();
  }
}

function drawMazeBoard(state, cell, now) {
  ctx.fillStyle = "#27384a";
  adventure.WALLS.forEach((part) => fillCell(part, cell, Math.max(1, cell * 0.12)));

  const pulse = 0.58 + Math.sin(now / 180) * 0.22;
  adventure.GATES.slice(state.maze.collected).forEach((gate) => {
    ctx.fillStyle = hexToRgba(gate.color, pulse);
    fillCell(gate, cell, Math.max(1, cell * 0.08));
    ctx.strokeStyle = gate.color;
    ctx.lineWidth = Math.max(1, cell * 0.08);
    ctx.strokeRect(gate.x * cell + 2, gate.y * cell + 2, cell - 4, cell - 4);
  });

  adventure.RUNES.forEach((rune, index) => {
    if (index < state.maze.collected) return;
    drawMazeRune(rune, index, index === state.maze.collected, cell, now);
  });
  drawMazePortal(state.maze.portal, adventure.portalOpen(state.maze.collected), cell, now);
  drawMazeObjective(state.maze.collected, cell);
}

function drawMazeRune(rune, index, active, cell, now) {
  const x = rune.x * cell + cell / 2;
  const y = rune.y * cell + cell / 2;
  const bob = active ? Math.sin(now / 180) * cell * 0.08 : 0;
  const radius = cell * (active ? 0.34 : 0.25);
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = active ? rune.color : hexToRgba(rune.color, 0.24);
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
  ctx.strokeStyle = active ? "#edf7ff" : hexToRgba(rune.color, 0.42);
  ctx.lineWidth = Math.max(1, cell * 0.08);
  ctx.strokeRect(-radius, -radius, radius * 2, radius * 2);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = active ? "#030609" : hexToRgba("#edf7ff", 0.55);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.max(8, Math.floor(cell * 0.42))}px "Press Start 2P", "Courier New", monospace`;
  ctx.fillText(String(index + 1), x, y + bob);
  ctx.restore();
}

function drawMazePortal(portal, open, cell, now) {
  const x = portal.x * cell + cell / 2;
  const y = portal.y * cell + cell / 2;
  const pulse = 0.84 + Math.sin(now / 150) * 0.12;
  ctx.save();
  ctx.strokeStyle = open ? "#ffcf5a" : "rgba(145, 164, 181, 0.2)";
  ctx.lineWidth = Math.max(2, cell * 0.13);
  ctx.beginPath();
  ctx.arc(x, y, cell * 0.34 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, cell * 0.18 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawMazeObjective(collected, cell) {
  const rune = adventure.currentRune(collected);
  const text = rune ? `RUNE ${collected + 1}/${adventure.RUNES.length}: ${rune.name}` : "PORTAL OPEN";
  ctx.save();
  ctx.fillStyle = "rgba(3, 6, 9, 0.74)";
  ctx.fillRect(cell * 10, cell * 0.3, cell * 12, cell * 1.15);
  ctx.fillStyle = rune ? rune.color : "#ffcf5a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.max(9, Math.floor(cell * 0.52))}px "Press Start 2P", "Courier New", monospace`;
  ctx.fillText(text, cell * 16, cell * 0.88);
  ctx.restore();
}

function drawFood(pos, cell, now) {
  const pulse = 0.5 + Math.sin(now / 130) * 0.5;
  const inset = 8 - pulse * 3;
  const centerX = pos.x * cell + cell / 2;
  const centerY = pos.y * cell + cell / 2;

  ctx.save();
  ctx.shadowColor = "#ffcf5a";
  ctx.shadowBlur = 22;
  ctx.fillStyle = "#ffcf5a";
  ctx.beginPath();
  ctx.arc(centerX, centerY, Math.max(4, cell / 2 - inset), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPowerUp(powerUp, cell, now) {
  const meta = powerUpMeta[powerUp.type] || powerUpMeta.speed;
  const pulse = 0.5 + Math.sin(now / 150) * 0.5;
  const x = powerUp.x * cell + cell / 2;
  const y = powerUp.y * cell + cell / 2;
  const radius = cell * (0.28 + pulse * 0.05);

  ctx.save();
  ctx.shadowColor = meta.color;
  ctx.shadowBlur = 18;
  ctx.fillStyle = "rgba(3, 6, 9, 0.94)";
  ctx.beginPath();
  ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = meta.color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = meta.color;

  if (powerUp.type === "speed") drawBolt(x, y, cell);
  if (powerUp.type === "shrink") drawScissors(x, y, cell);
  if (powerUp.type === "shield") drawShield(x, y, cell);
  if (powerUp.type === "bomb") drawBomb(x, y, cell);
  ctx.restore();
}

function drawSnake(player, cell, now, effects) {
  const skin = skins[player.skin] || skins.classic;
  player.snake.forEach((part, index) => {
    const isHead = index === 0;
    let color = isHead ? skin.colors[0] : skin.colors[index % skin.colors.length];

    if (!player.alive) color = deathColor(player.id, now);

    ctx.save();
    if (isHead && player.alive) {
      const cx = part.x * cell + cell / 2;
      const cy = part.y * cell + cell / 2;
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 1.25);
      halo.addColorStop(0, hexToRgba(skin.glow, 0.32));
      halo.addColorStop(1, hexToRgba(skin.glow, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 1.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = skin.glow;
      ctx.shadowBlur = 24;
    }
    ctx.fillStyle = color;
    fillCell(part, cell, isHead ? 5 : 3);

    if (isHead && effects.shield) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#46f2a4";
      ctx.lineWidth = 3;
      ctx.strokeRect(part.x * cell + 3, part.y * cell + 3, cell - 6, cell - 6);
    }

    if (isHead && effects.speed) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(86, 199, 255, 0.42)";
      const delta = dir(player.direction);
      ctx.fillRect(
        part.x * cell + cell / 2 - delta.x * cell * 0.65,
        part.y * cell + cell / 2 - delta.y * cell * 0.65,
        Math.max(3, cell * 0.25),
        Math.max(3, cell * 0.25)
      );
    }
    ctx.restore();
  });
}

function deathColor(id, now) {
  const started = deathEffects.get(id);
  if (!started) return "#4d5660";
  const elapsed = now - started;
  if (elapsed < 300) return Math.floor(elapsed / 50) % 2 === 0 ? "#edf7ff" : "#222932";
  if (elapsed < 650) {
    const t = (elapsed - 300) / 350;
    return mixColor("#edf7ff", "#4d5660", t);
  }
  return "#4d5660";
}

function drawParticles(cell) {
  for (const particle of particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - particle.age / particle.life);
    ctx.fillStyle = particle.color;
    ctx.shadowColor = particle.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(particle.x * cell, particle.y * cell, particle.size * cell, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (const drop of confetti) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - drop.age / drop.life);
    ctx.fillStyle = drop.color;
    ctx.translate(drop.x * cell, drop.y * cell);
    ctx.rotate(drop.rotation);
    ctx.fillRect(-drop.size * cell, -drop.size * cell, drop.size * cell * 2, drop.size * cell * 2);
    ctx.restore();
  }
}

function drawCountdown(ms, roomCode) {
  const label = countdownLabel(ms);
  const key = `${roomCode}-${label}`;
  if (key !== lastCountdownKey) {
    sound.countdown(label === "GO");
    lastCountdownKey = key;
  }

  ctx.save();
  const size = classicCanvasSize;
  ctx.fillStyle = "rgba(3, 6, 9, 0.62)";
  ctx.fillRect(0, 0, size, size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = label === "GO" ? "#46f2a4" : "#ffcf5a";
  ctx.shadowColor = ctx.fillStyle;
  ctx.shadowBlur = 28;
  ctx.font = canvasFont(size, 118, 48, "bold");
  ctx.fillText(label, size / 2, size / 2);
  ctx.restore();
}

function drawLevelOverlay(text, accent) {
  ctx.save();
  const size = classicCanvasSize;
  const band = Math.max(64, 160 * (size / 768));
  ctx.fillStyle = "rgba(3, 6, 9, 0.58)";
  ctx.fillRect(0, size / 2 - band / 2, size, band);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 24;
  ctx.font = canvasFont(size, 42, 18, "bold");
  fitCanvasText(text, size - 24, size / 2, size / 2);
  ctx.restore();
}

function drawCrtOverlay(size) {
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.06)";
  for (let y = 0; y < size; y += 3) ctx.fillRect(0, y, size, 1);
  const vignette = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.72);
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.34)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
}

function centerText(title, subtitle) {
  ctx.save();
  const size = classicCanvasSize;
  const scale = size / 768;
  const band = Math.max(74, 156 * scale);
  ctx.fillStyle = "rgba(3, 6, 9, 0.72)";
  ctx.fillRect(0, size / 2 - band / 2, size, band);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#edf7ff";
  ctx.font = canvasFont(size, 36, 16, "bold");
  fitCanvasText(title, size - 22, size / 2, size / 2 - 16 * scale);
  ctx.fillStyle = "#94a8b8";
  ctx.font = canvasFont(size, 18, 11);
  fitCanvasText(subtitle, size - 22, size / 2, size / 2 + 32 * scale);
  ctx.restore();
}

function updateHud(state) {
  roomCodeEl.textContent = state.roomCode;
  levelTextEl.textContent = mode === "maze" ? state.levelName : `${state.level} ${state.levelName}`;
  bestScoreEl.textContent = highScore;
  gameStatusEl.textContent = statusText(state);
  restartBtn.disabled = false;
  restartBtn.title = "Restart game";
  document.documentElement.style.setProperty("--level-accent", state.levelAccent || "#ffcf5a");

  scoreboardEl.innerHTML = "";
  state.players
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((player) => {
      const skin = skins[player.skin] || skins.classic;
      const effects = state.playerEffects?.[player.id] || {};
      const row = document.createElement("div");
      row.className = `score ${player.alive ? "" : "dead"}`;
      row.innerHTML = `
        <span class="swatch"></span>
        <strong>${escapeHtml(player.name)}${player.id === playerId ? " *" : ""}</strong>
        <span>${effectText(effects)}</span>
        <span>${player.score}${player.alive ? "" : ' <span class="badge">KO</span>'}</span>
      `;
      const swatch = row.querySelector(".swatch");
      if (swatch) {
        swatch.style.setProperty("--skin-a", skin.colors[0]);
        swatch.style.setProperty("--skin-b", skin.colors[1]);
      }
      scoreboardEl.appendChild(row);
    });

  updateTitle(state);
}

function statusText(state) {
  if (soloPaused) return "Paused";
  const countdownMs = countdownRemaining(state);
  if (countdownMs > 0) return countdownLabel(countdownMs);
  if (levelOverlay.until > performance.now()) return "Level up";
  if (mode === "maze" && state.running) {
    const rune = adventure.currentRune(state.maze.collected);
    return rune ? `Find ${rune.name}` : "Enter portal";
  }
  return state.message || (state.running ? "Live" : "Ready");
}

function updateTitle(state) {
  if (mode === "solo") {
    document.title = `Score: ${state.players[0].score} - Solo`;
    return;
  }
  if (mode === "maze") {
    document.title = `Rune ${state.maze.collected}/${adventure.RUNES.length} - Maze`;
    return;
  }
  document.title = "RETRO SNAKE ARENA";
}

function toggleMute() {
  muted = !muted;
  localStorage.setItem(MUTE_KEY, muted ? "true" : "false");
  sound.setMuted(muted);
  updateMuteButton();
}

function updateMuteButton() {
  muteBtn.textContent = muted ? "Muted" : "Sound";
  muteBtn.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
}

function updateAdventureButtons() {
  if (!mazeBtn || !mazeRewardEl) return;
  if (!adventure) {
    mazeBtn.disabled = true;
    mazeRewardEl.textContent = "Unavailable";
    return;
  }
  mazeRewardEl.textContent = bombCoreUnlocked ? "Bomb Core unlocked" : "Unlock Bomb Core";
  mazeBtn.classList.toggle("unlocked", bombCoreUnlocked);
  mazeBtn.title = bombCoreUnlocked
    ? "Replay the Rune Maze. Bomb pickups are unlocked in Solo."
    : "Open three rune gates to unlock Bomb pickups in Solo.";
}

function spawnFoodBurst(cell, skinName) {
  const skin = skins[skinName] || skins.classic;
  const count = 8 + Math.floor(Math.random() * 5);
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.004 + Math.random() * 0.008;
    particles.push({
      x: cell.x + 0.5,
      y: cell.y + 0.5,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 0.08 + Math.random() * 0.08,
      age: 0,
      life: 400,
      color: Math.random() > 0.5 ? skin.colors[0] : skin.glow
    });
  }
}

function spawnColorBurst(cell, color, count) {
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.004 + Math.random() * 0.01;
    particles.push({
      x: cell.x + 0.5,
      y: cell.y + 0.5,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 0.08 + Math.random() * 0.1,
      age: 0,
      life: 480 + Math.random() * 220,
      color
    });
  }
}

function spawnConfetti(skinName) {
  const skin = skins[skinName] || skins.classic;
  for (let i = 0; i < 70; i += 1) {
    confetti.push({
      x: Math.random() * 32,
      y: -Math.random() * 8,
      vx: -0.002 + Math.random() * 0.004,
      vy: 0.004 + Math.random() * 0.009,
      rotation: Math.random() * Math.PI,
      spin: -0.01 + Math.random() * 0.02,
      size: 0.07 + Math.random() * 0.08,
      age: 0,
      life: 2200 + Math.random() * 800,
      color: Math.random() > 0.5 ? skin.colors[0] : skin.colors[1]
    });
  }
}

function updateParticles(delta) {
  particles.forEach((particle) => {
    particle.age += delta;
    particle.x += particle.vx * delta;
    particle.y += particle.vy * delta;
  });
  particles = particles.filter((particle) => particle.age < particle.life);

  confetti.forEach((drop) => {
    drop.age += delta;
    drop.x += drop.vx * delta;
    drop.y += drop.vy * delta;
    drop.rotation += drop.spin * delta;
  });
  confetti = confetti.filter((drop) => drop.age < drop.life);
}

function flashCanvas(accent) {
  canvas.style.setProperty("--level-accent", accent);
  canvas.classList.remove("level-flash");
  void canvas.offsetWidth;
  canvas.classList.add("level-flash");
}

function canvasFont(size, basePx, minPx, weight = "") {
  const px = Math.max(minPx, Math.round(size * (basePx / 768)));
  return `${weight ? `${weight} ` : ""}${px}px "Press Start 2P", "Courier New", monospace`;
}

function fitCanvasText(text, maxWidth, x, y) {
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }

  const original = ctx.font;
  const match = original.match(/(\d+)px/);
  const startPx = match ? Number(match[1]) : 16;
  for (let px = startPx - 1; px >= 10; px -= 1) {
    ctx.font = original.replace(/\d+px/, `${px}px`);
    if (ctx.measureText(text).width <= maxWidth) break;
  }
  ctx.fillText(text, x, y);
  ctx.font = original;
}

function fillCell(pos, cell, inset) {
  const safeInset = Math.min(inset, cell * 0.35);
  ctx.fillRect(
    pos.x * cell + safeInset,
    pos.y * cell + safeInset,
    Math.max(1, cell - safeInset * 2),
    Math.max(1, cell - safeInset * 2)
  );
}

function drawBolt(x, y, cell) {
  ctx.beginPath();
  ctx.moveTo(x + cell * 0.05, y - cell * 0.34);
  ctx.lineTo(x - cell * 0.18, y + cell * 0.02);
  ctx.lineTo(x + cell * 0.03, y + cell * 0.02);
  ctx.lineTo(x - cell * 0.07, y + cell * 0.34);
  ctx.lineTo(x + cell * 0.22, y - cell * 0.08);
  ctx.lineTo(x + cell * 0.02, y - cell * 0.08);
  ctx.closePath();
  ctx.fill();
}

function drawScissors(x, y, cell) {
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x - cell * 0.16, y + cell * 0.15, cell * 0.1, 0, Math.PI * 2);
  ctx.arc(x + cell * 0.16, y + cell * 0.15, cell * 0.1, 0, Math.PI * 2);
  ctx.moveTo(x - cell * 0.05, y + cell * 0.06);
  ctx.lineTo(x + cell * 0.22, y - cell * 0.22);
  ctx.moveTo(x + cell * 0.05, y + cell * 0.06);
  ctx.lineTo(x - cell * 0.22, y - cell * 0.22);
  ctx.stroke();
}

function drawShield(x, y, cell) {
  ctx.beginPath();
  ctx.moveTo(x, y - cell * 0.32);
  ctx.lineTo(x + cell * 0.26, y - cell * 0.16);
  ctx.lineTo(x + cell * 0.19, y + cell * 0.2);
  ctx.lineTo(x, y + cell * 0.34);
  ctx.lineTo(x - cell * 0.19, y + cell * 0.2);
  ctx.lineTo(x - cell * 0.26, y - cell * 0.16);
  ctx.closePath();
  ctx.fill();
}

function drawBomb(x, y, cell) {
  ctx.beginPath();
  ctx.arc(x, y + cell * 0.06, cell * 0.23, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(2, cell * 0.08);
  ctx.beginPath();
  ctx.moveTo(x + cell * 0.12, y - cell * 0.14);
  ctx.quadraticCurveTo(x + cell * 0.24, y - cell * 0.34, x + cell * 0.34, y - cell * 0.25);
  ctx.stroke();
}

function randomPowerUp(state) {
  const types = bombCoreUnlocked ? Object.keys(powerUpMeta) : Object.keys(powerUpMeta).filter((type) => type !== "bomb");
  const type = types[Math.floor(Math.random() * types.length)];
  const spot = placeSoloOpenCell(state, true);
  return { ...spot, type, ...powerUpMeta[type] };
}

function applySoloPowerUp(type, now) {
  const player = soloState.players[0];
  if (type === "shrink") {
    player.snake = player.snake.slice(0, Math.max(2, player.snake.length - 4));
    return;
  }
  if (type === "speed") soloEffects.speed = now + 5000;
  if (type === "shield") soloEffects.shield = now + 4000;
  if (type === "bomb") {
    const head = player.snake[0];
    soloState.obstacles = soloState.obstacles.filter((obstacle) => (
      Math.abs(obstacle.x - head.x) + Math.abs(obstacle.y - head.y) > BOMB_CLEAR_RADIUS
    ));
    player.score += BOMB_SCORE_BONUS;
    spawnColorBurst(head, powerUpMeta.bomb.color, 24);
    flashCanvas(powerUpMeta.bomb.color);
    sound.bomb();
  }
}

function refreshSoloEffects(now) {
  for (const [name, until] of Object.entries(soloEffects)) {
    if (until <= now) delete soloEffects[name];
  }
  soloState.playerEffects = { solo: {} };
  for (const [name, until] of Object.entries(soloEffects)) {
    soloState.playerEffects.solo[name] = Math.max(0, until - now);
  }
}

function hasSoloEffect(name, now) {
  return Boolean(soloEffects[name] && soloEffects[name] > now);
}

function soloMoveInterval(now) {
  if (mode === "maze") return adventure.MOVE_MS;
  const base = LEVEL_META[soloState.level - 1].moveMs;
  return hasSoloEffect("speed", now) ? Math.round(base / 1.4) : base;
}

function placeSoloFood(state) {
  return placeSoloOpenCell(state, false);
}

function placeSoloOpenCell(state, includeFood) {
  const blocked = new Set(state.obstacles.map(key));
  state.players[0].snake.forEach((part) => blocked.add(key(part)));
  if (includeFood && state.food) blocked.add(key(state.food));
  if (state.powerUp) blocked.add(key(state.powerUp));

  for (let i = 0; i < 500; i += 1) {
    const spot = {
      x: Math.floor(Math.random() * state.boardSize),
      y: Math.floor(Math.random() * state.boardSize)
    };
    if (!blocked.has(key(spot))) return spot;
  }
  return { x: 15, y: 15 };
}

function countdownRemaining(state) {
  return Math.max(0, soloCountdownUntil - performance.now(), state?.countdownMs || 0);
}

function countdownLabel(ms) {
  if (ms > 1800) return "3";
  if (ms > 1100) return "2";
  if (ms > 400) return "1";
  return "GO";
}

function effectText(effects) {
  const labels = [];
  if (effects.speed) labels.push("SPD");
  if (effects.shield) labels.push("SHD");
  return labels.join(" ");
}

function playerName() {
  return nameEl.value.trim() || "Player";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function cancelClassicScoreRun() {
  if (classicScoreRun && window.SnakeRunScores) {
    window.SnakeRunScores.cancel(classicScoreRun);
  }
  classicScoreRun = null;
}

async function submitClassicScore(scoreMode, score, previousBest = 0) {
  const run = classicScoreRun;
  classicScoreRun = null;
  if (!run || !window.SnakeRunScores) {
    if (score > 0) setScoreNotice("Score not saved.");
    return;
  }

  // Only a score that beats the player's own stored best is submitted
  // (ADR-005): practice runs and early deaths never touch /arena/score, so
  // the 10-per-5-min submission limiter stops biting during normal play.
  const storedBest = Math.max(
    previousBest || 0,
    window.SnakeBests ? window.SnakeBests.get(scoreMode) : 0
  );
  if (score > 0 && score <= storedBest) {
    setScoreNotice(`Your best ${storedBest.toLocaleString("en-GB")} stands. Beat it to save.`);
    return;
  }
  const initials = window.SnakeInitials ? window.SnakeInitials() : "";
  if (score > 0 && !initials) {
    setScoreNotice("Set 3 leaderboard initials on the menu to save scores.");
    return;
  }

  const result = await window.SnakeRunScores.submit(run, {
    name: initials || "XXX",
    score
  });
  // Raise the stored best only once the server has accepted the run. Raising it
  // first meant a run that was never saved (bad initials, a 429, a rejection)
  // could stop a later, genuinely better-than-saved score from being submitted.
  if (result.ok && !result.skipped && window.SnakeBests) {
    window.SnakeBests.update(scoreMode, result.data && result.data.loggedIn ? result.data.best : score);
  }
  const expectedMode = scoreMode === "rune" ? "maze" : "solo";
  if (mode !== expectedMode || !soloState || soloState.running) return;

  if (result.ok) {
    if (window.refreshBestLine) window.refreshBestLine();
    if (result.skipped) return;
    if (result.data.personalBest) {
      setScoreNotice("Personal best " + result.data.best.toLocaleString("en-GB"));
    } else if (result.data.loggedIn) {
      setScoreNotice(`Your best ${result.data.best.toLocaleString("en-GB")} stands.`);
    } else {
      setScoreNotice("Sign in to save scores.");
    }
    return;
  }

  // A rejected or rate-limited submission must be visible, never silent.
  const detail = result.data && result.data.error ? ` ${result.data.error}` : "";
  setScoreNotice(result.status === 429
    ? "Score save paused. Try another run shortly."
    : `Score not saved.${detail}`);
}

function stopSolo() {
  if (soloTimer) clearInterval(soloTimer);
  soloTimer = null;
}

function stopClassicGame(opts = {}) {
  stopSolo();
  cancelClassicScoreRun();
  soloPaused = false;
  if (classicPauseBtn) classicPauseBtn.setAttribute("aria-pressed", "false");
  hideClassicOverlay();
  if (classicScoreNoticeEl) classicScoreNoticeEl.textContent = "";
  mode = "idle";
  soloState = null;
  gameWrapEl.hidden = true;
  levelOverlay = { text: "", until: 0, accent: "#ffcf5a" };
  restartBtn.disabled = true;
  restartBtn.title = "Start a Classic game to restart.";
  if (!opts.keepPlayingClass) document.body.classList.remove("is-playing");
  document.title = "RETRO SNAKE ARENA";
}

window.ClassicGame = {
  stop: stopClassicGame,
  startMaze: startMazeTrial,
  snapshot() {
    if (!soloState) return null;
    return JSON.parse(JSON.stringify(soloState));
  }
};

function dir(direction) {
  return {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  }[direction];
}

function isReverse(a, b) {
  return (a === "up" && b === "down") ||
    (a === "down" && b === "up") ||
    (a === "left" && b === "right") ||
    (a === "right" && b === "left");
}

function outside(pos, boardSize) {
  return pos.x < 0 || pos.y < 0 || pos.x >= boardSize || pos.y >= boardSize;
}

function wrap(pos, boardSize) {
  return {
    x: (pos.x + boardSize) % boardSize,
    y: (pos.y + boardSize) % boardSize
  };
}

function hitsObstacle(state, pos) {
  return state.obstacles.some((obstacle) => same(obstacle, pos));
}

function same(a, b) {
  return a?.x === b?.x && a?.y === b?.y;
}

function key(pos) {
  return `${pos.x},${pos.y}`;
}

function range(start, end) {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixColor(a, b, t) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function parseHex(hex) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}
