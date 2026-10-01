/*
 * Retro Snake Arena - "Arena (.io)" mode (Phase 1)
 * -------------------------------------------------
 * A slither.io-style continuous game. Fully client-side for Phase 1.
 * Self-contained: exposes window.ArenaGame.{start, stop} and wires its own
 * buttons. It does NOT touch the Classic grid game in client.js.
 *
 * Design notes for whoever picks this up next (see NEXT_STEPS.md):
 *  - World is continuous floats, circular boundary of radius WORLD_RADIUS.
 *  - The player and every bot use the SAME snake model + movement, so bots
 *    look identical to real snakes.
 *  - Body is a trail-resample: we record the head path and place segments at a
 *    fixed arc-length spacing along it (classic slither motion).
 *  - Movement is delta-time based so it is frame-rate independent.
 *  - Boost is implemented for players and bots; bots use a conservative intent
 *    layer so they sprint only when the path ahead is readable.
 */
(function () {

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

  "use strict";

  // ---- Config -------------------------------------------------------------
  const WORLD_RADIUS = 2200;        // circular world; diameter ~4400 (tighter = more fights)
  const FOOD_TARGET = 620;          // plain edibles kept alive (lower count, denser world)
  const BOT_TARGET = 20;            // Computer-controlled snakes kept alive
  const FOOD_RADIUS = 9;            // world units
  const FOOD_MASS = 1;              // mass gained per orb
  const BASE_SEGMENTS = 10;
  const SEG_SPACING_FACTOR = 0.62;  // spacing = radius * this
  const TURN_RATE = 3.4;            // max radians/sec the head can turn
  const BOT_SENSE_FOOD = 360;       // how far bots look for food
  const BOT_SENSE_DANGER = 240;     // how far bots react to bigger snakes
  const MAX_SEGMENTS = 110;         // cap for perf
  const TWO_PI = Math.PI * 2;
  const ARENA_RULES = window.ArenaRules || {};
  const HEAD_SHAPES = ARENA_RULES.HEAD_SHAPES || { round: { label: "Round" } };
  const HEAD_SHAPE_KEYS = Object.keys(HEAD_SHAPES);
  // Quality changes ONLY visual richness (resolution, effects, decor) — never
  // gameplay. All tiers render crisp (smoothing on, sane DPR); higher tiers just
  // add more particles/decor/glow. Bot smartness, world, food and view are tier-
  // independent so there is no competitive advantage to any setting.
  const QUALITY_TIERS = {
    low: { dprCap: 2, deco: 36, snow: 60, rain: 80, shake: 5, effectScale: 0.6, particleCap: 170, effectCap: 90, scenery: 2048 },
    balanced: { dprCap: 2.5, deco: 72, snow: 100, rain: 130, shake: 6, effectScale: 0.82, particleCap: 260, effectCap: 130, scenery: 2560 },
    high: { dprCap: Infinity, deco: 96, snow: 140, rain: 180, shake: 8, effectScale: 1, particleCap: 380, effectCap: 190, scenery: 3072 }
  };
  // NOTE: there is deliberately NO automatic quality downshift. Respect the
  // player's chosen tier (and their saved account setting) rather than silently
  // switching mid-game. Frame rate is held at 60 by the gate in loop().

  const BOT_AI_BASE = 0.075;        // bot reaction time — fixed, NOT quality-dependent
  const BOT_PROBE_DISTANCES = [70, 130, 210];
  const BOT_HEADING_OFFSETS = {
    skilled: [0, -0.28, 0.28, -0.58, 0.58, -0.95, 0.95, -1.45, 1.45],
    steady: [0, -0.38, 0.38, -0.82, 0.82, -1.25, 1.25],
    basic: [0, -0.55, 0.55, -1.05, 1.05]
  };

  const FOOD_KINDS = ARENA_RULES.FOOD_KINDS || {
    berry: { label: "Berry", mass: 1, r: 11, color: "#ff6fb1", shape: "berry", weight: 54 },
    apple: { label: "Apple", mass: 2, r: 14, color: "#ff7474", shape: "apple", weight: 30 },
    melon: { label: "Melon", mass: 4, r: 18, color: "#5cf0a5", shape: "melon", weight: 12 },
    gold: { label: "Gold", mass: 8, r: 22, color: "#ffd86b", shape: "star", weight: 4 }
  };

  const PALETTES = ARENA_RULES.PALETTE_LIST || [
    { body: "#46f2a4", glow: "#46f2a4" },
    { body: "#56c7ff", glow: "#56c7ff" },
    { body: "#ffcf5a", glow: "#ffcf5a" },
    { body: "#ff5d73", glow: "#ff5d73" },
    { body: "#e85cff", glow: "#e85cff" },
    { body: "#c8d7e1", glow: "#c8d7e1" },
    { body: "#9af06f", glow: "#9af06f" }
  ];

  const BOT_NAMES = ARENA_RULES.BOT_NAMES || [
    "Vyper", "Coil", "Slinky", "Noodle", "Mamba", "Fang", "Hiss", "Zigzag",
    "Boa", "Pixel", "Glitch", "Echo", "Nova", "Comet", "Drift", "Quark",
    "Bolt", "Sly", "Loop", "Twist", "Jade", "Cobra", "Wisp", "Rocket"
  ];

  // ---- Items & Powers -----------------------------------------------------
  // Special pickups beyond the basic food orbs. Categories: grow, ability
  // (timed, auto-applied), hazard (avoid!), and weapon (gives ammo to fire).
  const ITEM_TARGET = 40;            // special items/drops kept alive (more to fight over)
  const MAGNET_RADIUS = 260;         // how far the magnet ability pulls orbs
  const MISSILE_MAX = 3;             // max missile charges a player can hold
  // Each item is a recognizable object drawn as a little icon (see drawItemIcon).
  const ITEM_KINDS = ARENA_RULES.ITEM_KINDS || {
    mega:     { cat: "grow",    icon: "cherry",   color: "#ff4d6d", r: 15, mass: 5, weight: 24 },
    thunder:  { cat: "ability", icon: "thunder",  color: "#ffd23f", r: 13, ability: "speed", dur: 5, weight: 15 },
    mushroom: { cat: "ability", icon: "mushroom", color: "#c0392b", r: 13, ability: "slow",  dur: 4, weight: 13 },
    magnet:   { cat: "ability", icon: "magnet",   color: "#b06bff", r: 12, ability: "magnet", dur: 6, weight: 10 },
    ghost:    { cat: "ability", icon: "ghost",    color: "#5ffbf1", r: 13, ability: "ghost",  dur: 4, weight: 10 },
    rocket:   { cat: "weapon",  icon: "rocket",   color: "#ff8c1a", r: 13, weight: 14 },
    bomb:     { cat: "hazard",  icon: "bomb",     color: "#20242b", r: 14, weight: 14 }
  };
  const ITEM_LABEL = ARENA_RULES.ITEM_LABELS || { speed: "FAST", slow: "SLOW", magnet: "MAGNET", ghost: "GHOST" };
  const EFFECT_HUD = {
    speed: { code: "FA", duration: ITEM_KINDS.thunder?.dur || 5 },
    slow: { code: "SL", duration: ITEM_KINDS.mushroom?.dur || 4 },
    magnet: { code: "MA", duration: ITEM_KINDS.magnet?.dur || 6 },
    ghost: { code: "GH", duration: ITEM_KINDS.ghost?.dur || 4 }
  };

  const SKY_DROP_MIN_DELAY = ARENA_RULES.SKY_DROP?.minDelay || 18;
  const SKY_DROP_MAX_DELAY = ARENA_RULES.SKY_DROP?.maxDelay || 32;
  const SKY_DROP_TELEGRAPH = ARENA_RULES.SKY_DROP?.telegraph || 3.0;
  const SKY_DROP_FALL = ARENA_RULES.SKY_DROP?.fall || 1.15;
  const SKY_DROP_ACTIVE = ARENA_RULES.SKY_DROP?.active || 12;
  const SKY_DROP_RADIUS = ARENA_RULES.SKY_DROP?.radius || 24;
  const SKY_DROP_REWARDS = ARENA_RULES.SKY_DROP?.rewards || ["mass", "speed", "ghost", "rockets"];
  const COMBO_WINDOW = ARENA_RULES.COMBO?.window || 3.2;
  const NEAR_MISS_COOLDOWN = ARENA_RULES.COMBO?.nearMissCooldown || 1.4;
  const MAX_MASS = ARENA_RULES.ARENA_BALANCE?.maxMass || 500;
  const PERF_PROFILE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) &&
    new URLSearchParams(location.search).get("arenaProfile") === "1";
  const nativeRandom = Math.random;
  let performanceRandomState = 0x51a7c0de;

  // ---- Biomes -------------------------------------------------------------
  // Soft coloured regions placed around the world so it feels like a place,
  // not a box. Currently visual + named (shown in HUD/minimap); gameplay
  // flavour per biome is a hook for later.
  const BIOMES = [
    { name: "The Nexus",     x: 0,     y: 0,     r: 950,  accent: "#56c7ff" },
    { name: "Verdant Fields", x: -1500, y: -1250, r: 1150, accent: "#46f2a4" },
    { name: "Ember Wastes",  x: 1550,  y: -1150, r: 1150, accent: "#ff5d73" },
    { name: "Neon Sea",      x: 1450,  y: 1350,  r: 1150, accent: "#56c7ff" },
    { name: "Violet Drift",  x: -1500, y: 1350,  r: 1150, accent: "#b06bff" }
  ];

  // ---- Environments & weather --------------------------------------------
  // A landscape theme + a weather/time mode are randomized on every game so no
  // two runs look the same. Themes set the sky gradient and the scenery type;
  // weather adds an ambient tint and precipitation; lighting/shadows are faked.
  const ENVIRONMENTS = {
    desert:   { name: "Desert",   sky: ["#caa15f", "#7d4f27"], deco: "dunes",  dot: "rgba(255,240,200,0.05)" },
    beach:    { name: "Beach",    sky: ["#5fc6da", "#1f6f93"], deco: "waves",  dot: "rgba(255,255,255,0.06)" },
    forest:   { name: "Forest",   sky: ["#356b41", "#0f2a1a"], deco: "trees",  dot: "rgba(120,255,170,0.05)" },
    mountain: { name: "Mountains", sky: ["#5f7088", "#222a38"], deco: "peaks", dot: "rgba(200,220,255,0.05)" },
    tundra:   { name: "Tundra",   sky: ["#b9d7e8", "#5f87a6"], deco: "drifts", dot: "rgba(255,255,255,0.08)" }
  };
  const WEATHERS = ["day", "night", "snow", "storm"];

  // ---- State --------------------------------------------------------------
  let root, canvas, ctx;
  let running = false;
  let paused = false;
  let rafId = 0;
  let lastTs = 0;
  let cw = 0, ch = 0, dpr = 1;
  let zoomFactor = 1; // phones zoom out a bit more so you can see around you

  let snakes = [];        // all snakes (player + bots)
  let player = null;
  let foods = [];         // basic orbs: { x, y, r, mass, color }
  let items = [];         // special pickups: { x, y, type, ...ITEM_KINDS[type] }
  let projectiles = [];   // fired missiles: { x, y, vx, vy, life }
  let missileAmmo = 0;    // player's missile charges
  let objective = null;   // current rotating goal { type, text, target, progress, reward }
  let skyDrop = null;     // rare contested reward fruit from above
  let skyDropTimer = 12;
  let env = ENVIRONMENTS.forest;   // randomized landscape theme
  let weather = "day";             // randomized weather/time mode
  let decoPoints = [];             // scenery positions (trees, dunes, peaks...)
  let weatherP = [];               // snow/rain particles (screen-space)
  let lightningFlash = 0;          // 0..1 storm flash intensity
  let lightningTimer = 4;
  let particles = [];
  let effects = [];
  let screenShake = 0;
  let shakeX = 0;
  let shakeY = 0;
  let headPulse = 0;
  let comboCount = 0;
  let comboTimer = 0;
  let comboMultiplier = 1;
  let comboBest = 0;
  let comboAnnouncedMax = 1;   // highest multiplier announced this RUN (not this life)
  let nearMissCooldown = 0;
  let feed = [];
  let lastDeathReason = "";
  let lastPlayerRank = null;
  let rankFlashTimer = null;
  let fireWasReady = false;
  const pendingDeathSnakes = [];
  const pendingDeathReasons = [];

  const camera = { x: 0, y: 0, scale: 1, targetScale: 1 };
  const pointer = { x: 0, y: 0, active: false }; // screen-space; steer uses angle from screen centre
  const keys = { left: false, right: false };    // keyboard rotate (A/D or arrows)
  const joystick = { active: false, id: null, baseX: 0, baseY: 0, x: 0, y: 0 }; // mobile touch
  let leftHanded = false;      // mirror touch layout (steer right, actions left)
  let touchControl = "joystick"; // "joystick" (drag) or "arrows" (turn buttons)
  // Frame rate is FIXED at 60 for every device — no longer a user setting.
  // Uncapped rAF ran at the display's refresh (100+ on a high-refresh monitor),
  // which is wasted work; and once the renderer misses that budget the browser
  // falls to a vsync DIVISOR, so a 144Hz display drops 144 -> 72 -> 48 -> 36 in
  // hard steps. That cliff is what made fullscreen feel like ~30 while a smaller
  // window sat at 100+. Asking for 60 leaves a 16.7ms budget the renderer can
  // actually hit, so the cadence stays even.
  const TARGET_FPS = 60;
  const FRAME_INTERVAL = 1000 / TARGET_FPS;
  let nextFrameDue = 0;
  let isPhone = false;         // small screen: smaller, less cluttered floating text
  let controlMode = "mouse";   // "mouse" | "keys" — keyboard latches and wins until the mouse moves
  let usingTouch = false;      // mobile: aim rockets by auto-targeting instead of a hover cursor
  let boosting = false;        // hold to boost (drains mass)
  let boostDropTimer = 0;
  let sensitivity = 0.6;       // keyboard turn sensitivity (0.3..1.3), user-adjustable
  let difficulty = 0;          // 0..~1.4 progressive challenge; rises with size + time alive
  let difficultyStart = 0;     // performance.now() when the current life began
  let arenaScoreRun = null;
  let displayedDeathRun = null;
  let qualityTier = "balanced";
  let qualityUserOverride = false;
  let reducedMotion = false;
  let soundOn = true;
  let frameMs = 0;
  let hudThrottle = 0;
  let playerName = "Player";
  let playerPalette = PALETTES[0];
  let playerHeadShape = "round";
  let performanceExplosionTimer = 0;

  const sound = makeSound();
  const glowSprites = new Map();
  let skyCanvas = null;
  let sceneryCanvas = null;
  let scenerySize = 0;

  // ---- Public API ---------------------------------------------------------
  function start(opts) {
    opts = opts || {};
    cancelArenaScoreRun();
    arenaScoreRun = window.SnakeRunScores ? window.SnakeRunScores.begin("arena") : null;
    displayedDeathRun = null;
    if (PERF_PROFILE) {
      performanceRandomState = 0x51a7c0de;
      Math.random = nextPerformanceRandom;
    }
    playerName = (opts.name || "Player").slice(0, 14);
    playerPalette = opts.palette || PALETTES[0];
    playerHeadShape = normalizeHeadShape(opts.headShape);

    const savedSens = parseFloat(localStorage.getItem("arenaSensitivity"));
    if (!isNaN(savedSens)) sensitivity = clamp(savedSens, 0.3, 1.3);
    loadQualityPreference();
    const savedReducedMotion = localStorage.getItem("arenaReducedMotion");
    reducedMotion = savedReducedMotion === null
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : savedReducedMotion === "true";
    soundOn = localStorage.getItem("arenaSoundOn") !== "false";
    leftHanded = localStorage.getItem("arenaLeftHanded") === "true";
    touchControl = localStorage.getItem("arenaTouchControl") === "arrows" ? "arrows" : "joystick";
    sound.setMuted(!soundOn);

    ensureDom();
    if (window.requestGameWakeLock) window.requestGameWakeLock();
    resetToastQueue();
    syncSettingsControls();
    maybeShowControlsHint();
    root.hidden = false;
    root.classList.remove("show-cursor");
    root.classList.toggle("arena-left", leftHanded);
    root.classList.toggle("arrows-mode", touchControl === "arrows");
    root.classList.toggle("arena-reduced-motion", reducedMotion);
    document.body.classList.add("arena-active");
    document.body.classList.add("is-playing");
    document.title = "Arena - Retro Snake Arena";
    resize();

    pickEnvironment();
    snakes = [];
    foods = [];
    items = [];
    projectiles = [];
    missileAmmo = 0;
    boosting = false;
    boostDropTimer = 0;
    objective = null;
    skyDrop = null;
    skyDropTimer = 8 + Math.random() * 8;
    particles = [];
    effects = [];
    screenShake = 0;
    shakeX = 0;
    shakeY = 0;
    headPulse = 0;
    resetCombo();
    comboBest = 0;
    // Deliberately reset per RUN, not per life: respawn() leaves it alone so a
    // player who dies often is not re-told about x1.25 every life.
    comboAnnouncedMax = 1;
    difficulty = 0;
    difficultyStart = performance.now();
    feed = [];
    lastDeathReason = "";
    lastPlayerRank = null;
    fireWasReady = false;
    for (let i = 0; i < FOOD_TARGET; i += 1) foods.push(randomFood());
    for (let i = 0; i < ITEM_TARGET; i += 1) items.push(randomItem());

    player = makeSnake({
      isPlayer: true,
      name: playerName,
      palette: playerPalette,
      headShape: playerHeadShape,
      mass: PERF_PROFILE ? MAX_MASS : undefined
    });
    if (PERF_PROFILE) {
      player.score = 650;
      player.effects.ghost = 3600;
    }
    snakes.push(player);
    for (let i = 0; i < BOT_TARGET; i += 1) {
      snakes.push(makeBot(PERF_PROFILE ? 60 + (i % 6) * 55 : undefined));
    }

    if (PERF_PROFILE) {
      skyDrop = {
        x: player.x + 170,
        y: player.y - 120,
        reward: "mass",
        state: "active",
        age: 0,
        phase: 0
      };
      performanceExplosionTimer = 0.15;
    }

    camera.x = player.x;
    camera.y = player.y;
    camera.scale = camera.targetScale = zoomForMass(player.mass);

    running = true;
    paused = false;
    lastTs = performance.now();
    sound.resume();
    sound.startAmbient(env.name, weather);
    fetchArenaLeaderboard();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
    hidePause();
    hideDeath();
    announceEnvironment(true);   // a new run always orients the player
  }

  function stop() {
    running = false;
    paused = false;
    resetToastQueue();
    clearTimeout(rankFlashTimer);
    rankFlashTimer = null;
    cancelArenaScoreRun();
    displayedDeathRun = null;
    hidePause();
    hideDeath(false);
    cancelAnimationFrame(rafId);
    if (PERF_PROFILE) Math.random = nativeRandom;
    sound.stopAmbient();
    if (root) root.hidden = true;
    document.body.classList.remove("arena-active");
    document.body.classList.remove("is-playing");
    if (window.releaseGameWakeLock) window.releaseGameWakeLock();
    document.title = "Retro Snake Arena";
  }

  // ---- Snake factory ------------------------------------------------------
  // The player used to respawn at a FIXED world origin with no clearance check, so
  // hitting "Play again" while a bot happened to be crossing (0,0) spawned you
  // straight into it and killed you instantly - sometimes repeatedly. Pick the
  // origin when it is clear, otherwise search outward for somewhere that is.
  const SPAWN_CLEARANCE = 220;
  function findSafeSpawn() {
    const clearance2 = SPAWN_CLEARANCE * SPAWN_CLEARANCE;
    const isClear = (x, y) => {
      for (const other of snakes) {
        if (!other || !other.alive) continue;
        if ((other.x - x) ** 2 + (other.y - y) ** 2 < clearance2) return false;
        for (let i = 0; i < other.body.length; i += 2) {
          const b = other.body[i];
          if ((b.x - x) ** 2 + (b.y - y) ** 2 < clearance2) return false;
        }
      }
      return true;
    };
    if (isClear(0, 0)) return { x: 0, y: 0 };
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const p = randomWorldPoint(WORLD_RADIUS * 0.6);
      if (isClear(p.x, p.y)) return p;
    }
    // Nowhere provably clear (very crowded world): take the point furthest from
    // any living snake rather than falling back to a known-occupied origin.
    let best = { x: 0, y: 0 };
    let bestD2 = -1;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const p = randomWorldPoint(WORLD_RADIUS * 0.6);
      let nearest2 = Infinity;
      for (const other of snakes) {
        if (!other || !other.alive) continue;
        nearest2 = Math.min(nearest2, (other.x - p.x) ** 2 + (other.y - p.y) ** 2);
      }
      if (nearest2 > bestD2) { bestD2 = nearest2; best = p; }
    }
    return best;
  }

  function makeSnake(cfg) {
    const angle = Math.random() * TWO_PI;
    const spawn = cfg.isPlayer ? findSafeSpawn() : randomWorldPoint(WORLD_RADIUS * 0.85);
    const snake = {
      isPlayer: !!cfg.isPlayer,
      name: cfg.name,
      palette: cfg.palette,
      headShape: normalizeHeadShape(cfg.headShape || randomHeadShape()),
      x: spawn.x,
      y: spawn.y,
      angle,
      targetAngle: angle,
      mass: cfg.mass || 6,
      score: 0, // total points gained this life (uncapped, unlike mass/size)
      trail: [],
      body: [],
      radius: 6,
      segCount: BASE_SEGMENTS,
      alive: true,
      effects: {}, // active timed abilities: name -> seconds remaining
      ammo: 0,
      fireCooldown: 1 + Math.random() * 2,
      boosting: false,
      boostDropTimer: 0,
      aiTimer: 0,
      aiThreats: [],
      wander: Math.random() * TWO_PI,
      wanderTimer: 0,
      skill: cfg.isPlayer ? 1 : Math.random(),
      aggression: cfg.isPlayer ? 0 : 0.5 + Math.random() * 0.25 + Math.random() * 0.25, // bots: how keen to hunt (most are predators now)
      caution: cfg.isPlayer ? 0 : 0.5 + Math.random() * 0.24 + Math.random() * 0.22,
      boostBias: cfg.isPlayer ? 0 : 0.45 + Math.random() * 0.5,
      lookAhead: cfg.isPlayer ? 1 : 0.75 + Math.random() * 0.5
    };
    recomputeSize(snake);
    // Seed the trail straight behind the head so the body has length at spawn.
    const spacing = snake.radius * SEG_SPACING_FACTOR;
    for (let i = 0; i < snake.segCount * 2; i += 1) {
      snake.trail.push({ x: snake.x - Math.cos(angle) * spacing * i, y: snake.y - Math.sin(angle) * spacing * i });
    }
    buildBody(snake);
    return snake;
  }

  function makeBot(profileMass) {
    const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)];
    const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    return makeSnake({
      isPlayer: false,
      name,
      palette,
      headShape: randomHeadShape(),
      mass: profileMass || 4 + Math.random() * 30
    });
  }

  function recomputeSize(snake) {
    snake.mass = clamp(Number.isFinite(snake.mass) ? snake.mass : 4, 4, MAX_MASS);
    snake.radius = 6 + Math.sqrt(snake.mass) * 0.7;
    snake.segCount = Math.min(MAX_SEGMENTS, Math.round(BASE_SEGMENTS + snake.mass * 0.9));
  }

  function snakeSpeed(snake) {
    // Bigger snakes are slightly slower. Speed power and boost multiply this.
    let sp = Math.max(108, 198 - snake.radius * 1.6) * 0.915; // 8.5% slower for control
    if (hasEffect(snake, "speed")) sp *= 1.6;
    if (hasEffect(snake, "slow")) sp *= 0.5;
    const isBoosting = snake.isPlayer ? boosting : snake.boosting;
    if (isBoosting && snake.mass > (snake.isPlayer ? 5 : 8)) sp *= snake.isPlayer ? 1.8 : (1.45 + snake.aggression * 0.28);
    return sp;
  }

  function zoomForMass(mass) {
    // Start fairly close to the player for an intimate feel, then zoom out
    // gently as the snake grows so you can see more of the world.
    return clamp(1.25 - Math.sqrt(mass) * 0.02, 0.62, 1.25) * zoomFactor;
  }

  // ---- Main loop ----------------------------------------------------------
  function loop(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (paused) {
      // Keep the rAF alive but freeze the simulation clock so resume does not
      // lurch forward by the paused span.
      lastTs = ts;
      return;
    }
    // Hold to 60fps. Deliberately a drift-corrected accumulator, not
    // `ts - lastTs < interval`: that naive form only lets a frame through once the
    // gap EXCEEDS the interval, so on a 144Hz display (6.94ms per refresh) it
    // passed every 3rd frame and delivered 48fps, not 60. Advancing a due-time by
    // exactly one interval lets the cadence alternate 2,2,3 refreshes and average
    // a true 60.
    if (nextFrameDue === 0) nextFrameDue = ts;
    if (ts < nextFrameDue - 0.5) return;
    nextFrameDue += FRAME_INTERVAL;
    // Re-anchor after a stall (tab in the background, a long GC) so we don't then
    // sprint through a backlog of catch-up frames.
    if (nextFrameDue < ts) nextFrameDue = ts + FRAME_INTERVAL;
    const dt = Math.min(0.05, (ts - lastTs) / 1000); // clamp big gaps (tab switch)
    lastTs = ts;
    update(dt, ts);
    render(ts);
  }

  function update(dt, ts) {
    updateDifficulty();
    updateCombo(dt);

    // Steering
    if (player.alive) steerPlayer(player, dt);
    for (const s of snakes) {
      if (!s.alive || s.isPlayer) continue;
      steerBot(s, dt);
    }

    // Movement + body rebuild
    for (const s of snakes) {
      if (!s.alive) continue;
      moveSnake(s, dt);
    }

    // Eating basic orbs
    for (const s of snakes) {
      if (!s.alive) continue;
      tickEffects(s, dt);
      eatFood(s);
      pickUpSkyDrop(s);
      pickUpItems(s);
      applyMagnet(s, dt);
    }
    updateSkyDrop(dt);
    if (PERF_PROFILE) {
      if (!skyDrop) {
        skyDrop = { reward: "mass", phase: 0 };
      }
      skyDrop.x = player.x + 170;
      skyDrop.y = player.y - 120;
      skyDrop.state = "active";
      skyDrop.age = 0;
      performanceExplosionTimer -= dt;
      if (performanceExplosionTimer <= 0) {
        spawnBombExplosion(player.x + 90, player.y + 70);
        performanceExplosionTimer = 1.5;
      }
    }

    // Player-only systems layered over shared snake/item simulation.
    if (player.alive) {
      handleBoost(dt);
      updateObjective();
    }
    handleBotBoosts(dt);
    updateBotWeapons(dt);
    updateProjectiles(dt);

    // Collisions (after everyone has moved this frame)
    let pendingDeathCount = 0;
    for (const s of snakes) {
      if (!s.alive) continue;
      if (outsideWorld(s)) {
        pendingDeathSnakes[pendingDeathCount] = s;
        pendingDeathReasons[pendingDeathCount] = "the glowing wall";
        pendingDeathCount += 1;
        continue;
      }
      const hitBy = hitsAnotherSnake(s);
      if (hitBy) {
        pendingDeathSnakes[pendingDeathCount] = s;
        pendingDeathReasons[pendingDeathCount] = `${hitBy.name}'s body`;
        pendingDeathCount += 1;
      }
    }
    for (let i = 0; i < pendingDeathCount; i += 1) {
      killSnake(pendingDeathSnakes[i], pendingDeathReasons[i]);
      pendingDeathSnakes[i] = null;
      pendingDeathReasons[i] = null;
    }
    if (player.alive) checkNearMiss();

    // Maintain population
    while (aliveBotCount() < BOT_TARGET) {
      snakes.push(makeBot());
    }
    // Drop fully-dead bots from the array occasionally to keep it tidy
    if (snakes.length > BOT_TARGET + 40) {
      let write = 0;
      for (let i = 0; i < snakes.length; i += 1) {
        const snake = snakes[i];
        if (!snake.alive && !snake.isPlayer) continue;
        snakes[write] = snake;
        write += 1;
      }
      snakes.length = write;
    }
    while (foods.length < FOOD_TARGET) foods.push(randomFood());
    while (items.length < ITEM_TARGET) items.push(randomItem());

    // Camera follow + zoom
    camera.targetScale = zoomForMass(player.mass);
    camera.scale += (camera.targetScale - camera.scale) * Math.min(1, dt * 3);
    const cx = player.alive ? player.x : camera.x;
    const cy = player.alive ? player.y : camera.y;
    camera.x += (cx - camera.x) * Math.min(1, dt * 6);
    camera.y += (cy - camera.y) * Math.min(1, dt * 6);

    updateParticles(dt);
    updateEffects(dt);
    if (!reducedMotion) updateWeather(dt);

    hudThrottle -= dt;
    if (hudThrottle <= 0) { updateHud(); hudThrottle = 0.15; }
  }

  // ---- Environment --------------------------------------------------------
  function pickEnvironment() {
    const keys = Object.keys(ENVIRONMENTS);
    env = ENVIRONMENTS[keys[Math.floor(Math.random() * keys.length)]];
    weather = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];

    decoPoints = [];
    const quality = currentQuality();
    const decoCount = quality.deco;
    for (let i = 0; i < decoCount; i += 1) {
      const p = randomWorldPoint(WORLD_RADIUS * 0.98);
      decoPoints.push({ x: p.x, y: p.y, s: 0.7 + Math.random() * 1.1 });
    }

    weatherP = [];
    if (weather === "snow" || weather === "storm") {
      const n = weather === "snow" ? quality.snow : quality.rain;
      for (let i = 0; i < n; i += 1) weatherP.push(newWeatherParticle());
    }
    lightningFlash = 0;
    lightningTimer = 3 + Math.random() * 4;
    rebuildStaticScenery();
  }

  function newWeatherParticle() {
    return {
      x: Math.random(),
      y: Math.random(),
      spd: weather === "snow" ? (0.04 + Math.random() * 0.05) : (0.5 + Math.random() * 0.4),
      drift: weather === "snow" ? (Math.random() - 0.5) * 0.05 : 0.12,
      len: weather === "snow" ? 0 : (10 + Math.random() * 14),
      size: weather === "snow" ? (1.5 + Math.random() * 2) : 1
    };
  }

  function updateWeather(dt) {
    for (const p of weatherP) {
      p.y += p.spd * dt;
      p.x += p.drift * dt;
      if (p.y > 1.05) { p.y = -0.05; p.x = Math.random(); }
      if (p.x > 1.05) p.x = -0.05; else if (p.x < -0.05) p.x = 1.05;
    }
    if (weather === "storm") {
      lightningTimer -= dt;
      if (lightningTimer <= 0) { lightningFlash = 1; lightningTimer = 3 + Math.random() * 5; }
    }
    if (lightningFlash > 0) lightningFlash = Math.max(0, lightningFlash - dt * 2.5);
  }

  // ---- Steering -----------------------------------------------------------
  function steerPlayer(s, dt) {
    let target = null;
    let scale = 1;
    if (joystick.active) {
      // Mobile: aim from joystick base toward current touch. Boost is a
      // separate on-screen button now, so steering never boosts by accident.
      const dx = joystick.x - joystick.baseX;
      const dy = joystick.y - joystick.baseY;
      const mag = Math.hypot(dx, dy);
      if (mag > 8) target = Math.atan2(dy, dx);
    } else if (keys.left || keys.right) {
      // Keyboard: hold to rotate left/right (drive feel), scaled by sensitivity.
      if (keys.left && !keys.right) target = s.angle - 1.3;
      else if (keys.right && !keys.left) target = s.angle + 1.3;
      scale = sensitivity;
    } else if (controlMode === "keys") {
      // Keyboard latched: keys released but mouse hasn't moved -> hold heading
      // straight (FPS feel) instead of snapping back to the cursor.
      target = null;
    } else {
      // Desktop: aim toward the cursor (head is at screen centre).
      const dx = pointer.x - cw / 2;
      const dy = pointer.y - ch / 2;
      if (dx !== 0 || dy !== 0) target = Math.atan2(dy, dx);
    }
    if (target !== null) s.targetAngle = target;
    turnToward(s, dt, scale);
  }

  // Progressive challenge: the longer you survive and the bigger you grow, the
  // more the world turns on you. Cheap to compute once per frame.
  function updateDifficulty() {
    const secs = (performance.now() - difficultyStart) / 1000;
    const byTime = Math.min(1, secs / 150);
    const byMass = (player && player.alive) ? Math.min(1, Math.max(0, (player.mass - 12) / 380)) : 0;
    difficulty = Math.min(1.4, byTime * 0.5 + byMass);
  }

  function steerBot(s, dt) {
    s.aiTimer -= dt;
    if (s.aiTimer > 0) {
      turnToward(s, dt);
      return;
    }
    s.aiTimer = botReactionDelay(s);

    s.wanderTimer -= dt;
    if (s.wanderTimer <= 0) {
      const edgeness = Math.hypot(s.x, s.y) / WORLD_RADIUS;
      if (edgeness > 0.55) {
        // Near the edge: head back toward the busy centre instead of looping.
        s.wander = Math.atan2(-s.y, -s.x) + (Math.random() - 0.5) * 1.0;
      } else {
        s.wander += (Math.random() - 0.5) * 1.0;
      }
      s.wanderTimer = 0.7 + Math.random() * 1.1;
    }
    let goal = s.wander;
    let decided = false;
    let intent = "wander";

    // 1) Flee the nearest bigger snake (survival first).
    let threat = null, threatD = BOT_SENSE_DANGER * BOT_SENSE_DANGER;
    for (const o of snakes) {
      if (o === s || !o.alive) continue;
      if (o.mass > s.mass * 1.1) {
        const d = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
        if (d < threatD) { threatD = d; threat = o; }
      }
    }
    if (threat) { goal = Math.atan2(s.y - threat.y, s.x - threat.x); decided = true; intent = "escape"; }

    // 2) Avoid obvious hazards before chasing rewards.
    if (!decided && !hasEffect(s, "ghost")) {
      let danger = null, dangerD = 320 * 320;
      for (const it of items) {
        if (!isDangerItem(it)) continue;
        const d = (it.x - s.x) ** 2 + (it.y - s.y) ** 2;
        if (d < dangerD) { dangerD = d; danger = it; }
      }
      if (danger) { goal = Math.atan2(s.y - danger.y, s.x - danger.x); decided = true; intent = "avoid"; }
    }

    // 3) Contest rare sky-drops when they are nearby and not too dangerous.
    if (!decided && skyDrop && skyDrop.state !== "cooldown") {
      const d = (skyDrop.x - s.x) ** 2 + (skyDrop.y - s.y) ** 2;
      const sense = skyDrop.state === "active" ? 1200 : 850;
      if (d < sense * sense) {
        goal = Math.atan2(skyDrop.y - s.y, skyDrop.x - s.x);
        decided = true;
        intent = "reward";
      }
    }

    // 4) Useful items are worth contesting.
    if (!decided) {
      let item = null, itemD = 460 * 460;
      for (const it of items) {
        if (isDangerItem(it)) continue;
        const d = (it.x - s.x) ** 2 + (it.y - s.y) ** 2;
        if (d < itemD) { itemD = d; item = it; }
      }
      if (item) { goal = Math.atan2(item.y - s.y, item.x - s.x); decided = true; intent = "reward"; }
    }

    // 5) HUNT — most bots actively try to cut snakes off, not just survive. They
    // pick the best victim (anyone meaningfully smaller, within a wide range) and
    // steer to a point AHEAD of its head to intercept. The player is hunted harder
    // the more it scores, so leading the board draws a pack and the lead is hard
    // to hold — which is what makes a high score a real achievement.
    const playerBias = player ? Math.min(0.75, (player.score || 0) / 1400) : 0;
    if (!decided && s.aggression + difficulty * 0.5 + playerBias > 0.5) {
      const huntRange2 = (BOT_SENSE_DANGER * 2.6) ** 2;
      let prey = null, preyScore = -Infinity;
      for (const o of snakes) {
        if (o === s || !o.alive) continue;
        const sizeGate = o.isPlayer ? s.mass * (0.95 + (difficulty + playerBias) * 0.6) : s.mass * 0.92;
        if (o.mass >= sizeGate) continue;
        const d2 = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
        if (d2 > huntRange2) continue;
        let sc = (o.mass + 25) * 700 - d2; // close + juicy targets rank highest
        if (o.isPlayer) sc *= 1 + difficulty * 0.8 + playerBias;
        if (sc > preyScore) { preyScore = sc; prey = o; }
      }
      if (prey) {
        const side = Math.sign((s.x - prey.x) * -Math.sin(prey.angle) + (s.y - prey.y) * Math.cos(prey.angle)) || 1;
        const lead = 80 + s.aggression * 110 + difficulty * 70;
        const cross = 26 + s.radius * 1.5;
        const tx = prey.x + Math.cos(prey.angle) * lead - Math.sin(prey.angle) * cross * side;
        const ty = prey.y + Math.sin(prey.angle) * lead + Math.cos(prey.angle) * cross * side;
        goal = Math.atan2(ty - s.y, tx - s.x);
        decided = true;
        intent = "cut";
      }
    }

    // 6) Feast on the most VALUABLE food in reach (not just the nearest) — this
    // pulls bots onto dead-snake piles and gold fruit, so they race for points too
    // and clean up the easy mass instead of leaving it lying around for the player.
    if (!decided) {
      const foodRange2 = (BOT_SENSE_FOOD * 2.2) ** 2;
      let best = null, bestVal = 0;
      for (const f of foods) {
        const d2 = (f.x - s.x) ** 2 + (f.y - s.y) ** 2;
        if (d2 > foodRange2) continue;
        const val = (f.mass || 1) / (50 + Math.sqrt(d2));
        if (val > bestVal) { bestVal = val; best = f; }
      }
      if (best) { goal = Math.atan2(best.y - s.y, best.x - s.x); intent = "food"; }
    }

    // 7) Hard override: turn back if hugging the boundary.
    if (Math.hypot(s.x, s.y) > WORLD_RADIUS - 260) {
      goal = Math.atan2(-s.y, -s.x);
      intent = "wall";
    }

    refreshBotThreats(s);
    s.targetAngle = safeBotHeading(s, goal, intent);
    updateBotBoostIntent(s, intent, s.targetAngle);
    turnToward(s, dt);
  }

  function botReactionDelay(s) {
    const base = BOT_AI_BASE + Math.random() * 0.04;
    return base * (1.18 - Math.min(0.75, s.skill || 0) * 0.42);
  }

  function updateBotBoostIntent(s, intent, goal) {
    if (s.isPlayer) return;
    const turn = Math.abs(normalizeAngle(goal - s.angle));
    const wallClearance = WORLD_RADIUS - Math.hypot(s.x, s.y) - s.radius;
    const forwardClearance = botClearanceScore(s, s.angle);
    const pathReadable = turn < 0.7 && wallClearance > 340 && forwardClearance > -80;
    const canBoost = s.mass > 8 && pathReadable && intent !== "avoid" && intent !== "wall";
    const wantsBoost =
      intent === "escape" ||
      intent === "reward" ||
      (intent === "cut" && s.aggression > 0.52) ||
      (intent === "food" && s.mass < 16 && s.boostBias > 0.7);
    s.boosting = canBoost && wantsBoost && (s.boosting || Math.random() < s.boostBias);
  }

  function safeBotHeading(s, goal, intent) {
    const offsets = (s.skill || 0) > 0.68
      ? BOT_HEADING_OFFSETS.skilled
      : (s.skill || 0) > 0.34
        ? BOT_HEADING_OFFSETS.steady
        : BOT_HEADING_OFFSETS.basic;
    // Commit harder to a kill (less caution) and be extra careful when fleeing, so
    // bots actually land cuts instead of always swerving away at the last moment.
    const cautionWeight = intent === "cut" ? s.caution * 0.5
      : intent === "escape" || intent === "avoid" ? s.caution * 1.35
      : s.caution;
    // When committing to a cut, weight forward progress higher too.
    const progressWeight = intent === "cut" ? 95 : 70;
    let best = goal;
    let bestScore = -Infinity;
    for (const offset of offsets) {
      const angle = normalizeAngle(goal + offset);
      const progress = Math.cos(normalizeAngle(angle - goal)) * progressWeight;
      const clearance = botClearanceScore(s, angle);
      const score = progress + clearance * cautionWeight;
      if (score > bestScore) {
        bestScore = score;
        best = angle;
      }
    }
    return best;
  }

  function refreshBotThreats(s) {
    const threats = s.aiThreats;
    let count = 0;
    for (const other of snakes) {
      if (other === s || !other.alive || (other.x - s.x) ** 2 + (other.y - s.y) ** 2 > 900 * 900) continue;
      threats[count] = other;
      count += 1;
    }
    threats.length = count;
  }

  function botClearanceScore(s, angle) {
    const reach = s.lookAhead || 1;
    let score = 0;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);

    for (let probeIndex = 0; probeIndex < BOT_PROBE_DISTANCES.length; probeIndex += 1) {
      const distAhead = BOT_PROBE_DISTANCES[probeIndex] * reach;
      const pointX = s.x + ca * (distAhead + s.radius * 2);
      const pointY = s.y + sa * (distAhead + s.radius * 2);
      const wallClearance = WORLD_RADIUS - Math.hypot(pointX, pointY) - s.radius * 2.5;
      if (wallClearance < 0) score -= 1200;
      else score += Math.min(140, wallClearance) * 0.32;

      for (const other of s.aiThreats) {
        const danger = s.radius + other.radius + 18;
        const danger2 = danger * danger;
        const headD2 = (other.x - pointX) ** 2 + (other.y - pointY) ** 2;
        if (headD2 < danger2) score -= other.mass > s.mass ? 260 : 170;

        for (let i = 0; i < other.body.length; i += 4) {
          const b = other.body[i];
          const d2 = (b.x - pointX) ** 2 + (b.y - pointY) ** 2;
          if (d2 > danger2) continue;
          const pressure = 1 - d2 / danger2;
          score -= pressure * (other.mass > s.mass ? 260 : 160);
        }
      }
    }
    return score;
  }

  function turnToward(s, dt, scale) {
    let diff = normalizeAngle(s.targetAngle - s.angle);
    const maxStep = TURN_RATE * (scale || 1) * dt;
    if (diff > maxStep) diff = maxStep;
    else if (diff < -maxStep) diff = -maxStep;
    s.angle = normalizeAngle(s.angle + diff);
  }

  // ---- Movement -----------------------------------------------------------
  function moveSnake(s, dt) {
    const speed = snakeSpeed(s);
    s.x += Math.cos(s.angle) * speed * dt;
    s.y += Math.sin(s.angle) * speed * dt;

    // Record head into the trail, then trim by arc length.
    s.trail.unshift({ x: s.x, y: s.y });
    const maxLen = s.segCount * s.radius * SEG_SPACING_FACTOR + 60;
    let total = 0;
    for (let i = 1; i < s.trail.length; i += 1) {
      total += dist(s.trail[i - 1], s.trail[i]);
      if (total > maxLen) { s.trail.length = i + 1; break; }
    }
    buildBody(s);
  }

  // Resample the head trail at fixed spacing to get evenly spaced body segments.
  function buildBody(s) {
    const spacing = s.radius * SEG_SPACING_FACTOR;
    const pts = s.trail;
    const out = [{ x: pts[0].x, y: pts[0].y }];
    let prev = pts[0];
    let need = spacing;
    let i = 1;
    while (out.length < s.segCount && i < pts.length) {
      const cur = pts[i];
      const segLen = dist(prev, cur);
      if (segLen < need) {
        need -= segLen;
        prev = cur;
        i += 1;
      } else {
        const t = need / segLen;
        const np = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
        out.push(np);
        prev = np;
        need = spacing;
      }
    }
    while (out.length < s.segCount) out.push({ x: prev.x, y: prev.y });
    s.body = out;
  }

  // ---- Eating -------------------------------------------------------------
  function eatFood(s) {
    for (let i = foods.length - 1; i >= 0; i -= 1) {
      const f = foods[i];
      const reach = s.radius + (f.r || FOOD_RADIUS);
      const d2 = (f.x - s.x) ** 2 + (f.y - s.y) ** 2;
      if (d2 <= reach * reach) {
        let gain = f.mass;
        if (s.isPlayer) gain += addComboEvent("FRUIT", f.mass, f.x, f.y, f.color, 1);
        s.mass += gain;
        s.score += gain;
        recomputeSize(s);
        spawnEatFeedback(s, f, gain);
        foods.splice(i, 1);
        if (s.isPlayer) { sound.eat(); objectiveProgress("orbs", 1); }
      }
    }
  }

  // ---- Items, abilities, weapons -----------------------------------------
  function tickEffects(s, dt) {
    for (const k in s.effects) {
      s.effects[k] -= dt;
      if (s.effects[k] <= 0) delete s.effects[k];
    }
  }

  function hasEffect(s, name) {
    return !!(s && s.effects && s.effects[name] > 0);
  }

  // Magnet power: pull nearby orbs toward the player.
  function applyMagnet(s, dt) {
    if (!hasEffect(s, "magnet")) return;
    const r2 = MAGNET_RADIUS * MAGNET_RADIUS;
    for (const f of foods) {
      const dx = s.x - f.x, dy = s.y - f.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < r2 && d2 > 1) {
        const d = Math.sqrt(d2);
        const pull = Math.min(d, 340 * dt);
        f.x += (dx / d) * pull;
        f.y += (dy / d) * pull;
      }
    }
  }

  function pickUpItems(s) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      const reach = s.radius + it.r;
      if ((it.x - s.x) ** 2 + (it.y - s.y) ** 2 <= reach * reach) {
        applyItem(s, it);
        items.splice(i, 1);
      }
    }
  }

  function updateSkyDrop(dt) {
    if (!skyDrop) {
      skyDropTimer -= dt;
      if (skyDropTimer <= 0) spawnSkyDrop();
      return;
    }

    skyDrop.age += dt;
    if (skyDrop.state === "telegraph" && skyDrop.age >= SKY_DROP_TELEGRAPH) {
      skyDrop.state = "falling";
      skyDrop.age = 0;
      addRing(skyDrop.x, skyDrop.y, "#ffcf5a", 20, 120, 0.55, 3);
      addFloatingText(skyDrop.x, skyDrop.y, "LOOK UP", "#ffcf5a");
    } else if (skyDrop.state === "falling" && skyDrop.age >= SKY_DROP_FALL) {
      skyDrop.state = "active";
      skyDrop.age = 0;
      addRing(skyDrop.x, skyDrop.y, "#ffcf5a", 18, 150, 0.65, 4);
      spawnBurst(skyDrop.x, skyDrop.y, "#ffcf5a", 22);
      spawnSparkles(skyDrop.x, skyDrop.y, "#fff1b8", 18, 180);
      addFloatingText(skyDrop.x, skyDrop.y, "STAR FRUIT", "#ffcf5a");
      shake(0.25);
    } else if (skyDrop.state === "active" && skyDrop.age >= SKY_DROP_ACTIVE) {
      skyDrop = null;
      resetSkyDropTimer();
    }
  }

  function spawnSkyDrop() {
    const p = randomWorldPoint(WORLD_RADIUS * (0.52 + Math.random() * 0.38));
    const reward = SKY_DROP_REWARDS[Math.floor(Math.random() * SKY_DROP_REWARDS.length)];
    skyDrop = {
      x: p.x,
      y: p.y,
      reward,
      state: "telegraph",
      age: 0,
      phase: Math.random() * TWO_PI
    };
    addRing(p.x, p.y, "#ffcf5a", 24, 170, 0.8, 2);
    spawnSparkles(p.x, p.y, "#ffcf5a", 10, 120);
    showToast("SKY DROP INCOMING");
  }

  function resetSkyDropTimer() {
    skyDropTimer = SKY_DROP_MIN_DELAY + Math.random() * (SKY_DROP_MAX_DELAY - SKY_DROP_MIN_DELAY);
  }

  function pickUpSkyDrop(s) {
    if (!skyDrop || skyDrop.state !== "active" || !s.alive) return;
    const reach = s.radius + SKY_DROP_RADIUS;
    const d2 = (skyDrop.x - s.x) ** 2 + (skyDrop.y - s.y) ** 2;
    if (d2 > reach * reach) return;

    applySkyDropReward(s, skyDrop);
    if (s.isPlayer) {
      spawnPickupFeedback({ x: skyDrop.x, y: skyDrop.y }, { color: "#ffcf5a", r: SKY_DROP_RADIUS }, "DROP");
      spawnHeartPops(skyDrop.x, skyDrop.y, "#ffcf5a", 7);
    } else {
      spawnBurst(skyDrop.x, skyDrop.y, "#ffcf5a", 18);
    }
    addRing(skyDrop.x, skyDrop.y, "#ffffff", 20, 190, 0.58, 3);
    skyDrop = null;
    resetSkyDropTimer();
  }

  function applySkyDropReward(s, drop) {
    if (drop.reward === "mass") {
      s.mass += 24;
      s.score += 24;
      recomputeSize(s);
    } else if (drop.reward === "speed") {
      s.effects.speed = 6;
    } else if (drop.reward === "ghost") {
      s.effects.ghost = 4.5;
    } else if (drop.reward === "rockets") {
      if (s.isPlayer) missileAmmo = Math.min(MISSILE_MAX, missileAmmo + 2);
      else {
        s.mass += 14;
        s.score += 14;
        recomputeSize(s);
      }
    }
    if (s.isPlayer) {
      addComboEvent("DROP", 8, drop.x, drop.y, "#ffcf5a", 3);
      sound.power();
      showToast(`SKY DROP: ${drop.reward.toUpperCase()}`);
      headPulse = Math.max(headPulse, 0.36);
    }
  }

  function applyItem(s, it) {
    const def = ITEM_KINDS[it.type];
    if (def.cat === "grow") {
      const bonus = s.isPlayer ? addComboEvent("MEGA", def.mass, it.x, it.y, def.color, 2) : 0;
      s.mass += def.mass + bonus;
      s.score += def.mass + bonus;
      recomputeSize(s);
      if (s.isPlayer) {
        spawnPickupFeedback(it, def, `+${def.mass}`);
        sound.eat();
        objectiveProgress("mega", 1);
      } else {
        spawnBurst(it.x, it.y, def.color, 8);
      }
    } else if (def.cat === "ability") {
      s.effects[def.ability] = def.dur;
      if (s.isPlayer) {
        spawnPickupFeedback(it, def, ITEM_LABEL[def.ability] || "POWER");
        sound.power();
      } else {
        spawnBurst(it.x, it.y, def.color, 8);
      }
    } else if (def.cat === "weapon") {
      if (s.isPlayer) missileAmmo = Math.min(MISSILE_MAX, missileAmmo + 1);
      else s.ammo = Math.min(MISSILE_MAX, (s.ammo || 0) + 1);
      if (s.isPlayer) {
        spawnPickupFeedback(it, def, "+ROCKET");
        // The FIRE button materialises next to the thumb on this pickup; its own
        // 150ms scale-in sits in peripheral vision while the player watches the
        // centre of the screen, so say it in the message slot too.
        if (missileAmmo === 1) showToast("ROCKET READY");
        sound.power();
      } else {
        spawnBurst(it.x, it.y, def.color, 8);
      }
    } else if (def.cat === "hazard") {
      // Bomb: harmless while Ghosting, otherwise it explodes and kills you.
      if (hasEffect(s, "ghost")) {
        if (s.isPlayer) spawnPickupFeedback(it, def, "GHOST");
        else spawnBurst(it.x, it.y, def.color, 8);
      } else {
        spawnBombExplosion(it.x, it.y);
        killSnake(s, "a bomb");
      }
    }
  }

  // Boost: spend mass for speed and leave a trail of orbs behind you.
  function handleBoost(dt) {
    if (!boosting) return;
    if (player.mass <= 5) { boosting = false; return; }
    boostDropTimer = handleSnakeBoost(player, dt, boostDropTimer, 7, 0.1, 5);
  }

  function handleBotBoosts(dt) {
    for (const s of snakes) {
      if (!s.alive || s.isPlayer || !s.boosting) continue;
      if (s.mass <= 8) { s.boosting = false; continue; }
      s.boostDropTimer = handleSnakeBoost(s, dt, s.boostDropTimer || 0, 4.2, 0.16, 8);
    }
  }

  function handleSnakeBoost(s, dt, timer, drain, interval, minMass) {
    s.mass = Math.max(minMass, s.mass - drain * dt);
    recomputeSize(s);
    timer -= dt;
    if (timer <= 0 && foods.length < FOOD_TARGET + 300) {
      timer = interval;
      const tail = s.body[s.body.length - 1] || s;
      foods.push({
        x: tail.x + (Math.random() - 0.5) * 8,
        y: tail.y + (Math.random() - 0.5) * 8,
        r: FOOD_RADIUS,
        mass: 1,
        color: s.palette.body
      });
    }
    return timer;
  }

  // Aim direction for weapons: the cursor on desktop (steer with keyboard),
  // or auto-target the nearest enemy on touch devices.
  function getAimAngle() {
    if (usingTouch) {
      let best = null, bestD = Infinity;
      for (const o of snakes) {
        if (!o.alive || o.isPlayer) continue;
        const d = (o.x - player.x) ** 2 + (o.y - player.y) ** 2;
        if (d < bestD) { bestD = d; best = o; }
      }
      if (best) return Math.atan2(best.y - player.y, best.x - player.x);
      return player.angle;
    }
    const dx = pointer.x - cw / 2, dy = pointer.y - ch / 2;
    if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx);
    return player.angle;
  }

  function fireMissile() {
    if (!running || !player.alive || missileAmmo <= 0) return;
    missileAmmo -= 1;
    fireMissileFrom(player, getAimAngle());
    sound.fire();
    updateHud();
  }

  function fireMissileFrom(owner, aim) {
    const sp = 560;
    projectiles.push({
      owner,
      x: owner.x + Math.cos(aim) * owner.radius,
      y: owner.y + Math.sin(aim) * owner.radius,
      vx: Math.cos(aim) * sp,
      vy: Math.sin(aim) * sp,
      life: 1.6
    });
  }

  function updateProjectiles(dt) {
    let write = 0;
    for (let i = 0; i < projectiles.length; i += 1) {
      const p = projectiles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (Math.hypot(p.x, p.y) > WORLD_RADIUS) { p.life = 0; continue; }
      for (const o of snakes) {
        if (!o.alive || o === p.owner) continue;
        const hit = projectileHitIndex(p, o);
        if (hit >= 0) {
          cutSnake(o, hit, p, p.owner);
          if (p.owner && p.owner.isPlayer) objectiveProgress("cut", 1);
          p.life = 0;
          break;
        }
      }
      if (p.life > 0) {
        projectiles[write] = p;
        write += 1;
      }
    }
    projectiles.length = write;
  }

  function updateBotWeapons(dt) {
    for (const s of snakes) {
      if (!s.alive || s.isPlayer) continue;
      s.fireCooldown = Math.max(0, (s.fireCooldown || 0) - dt);
      if (!s.ammo || s.fireCooldown > 0) continue;
      const target = botWeaponTarget(s);
      if (!target) continue;
      s.ammo -= 1;
      s.fireCooldown = 2.2 + Math.random() * 2.2;
      fireMissileFrom(s, Math.atan2(target.y - s.y, target.x - s.x));
      spawnBurst(s.x, s.y, "#ff8c1a", 6);
    }
  }

  function botWeaponTarget(s) {
    let best = null;
    let bestD = 680 * 680;
    for (const o of snakes) {
      if (o === s || !o.alive) continue;
      if (o.mass > s.mass * 1.6) continue;
      const d = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  function projectileHitIndex(p, o) {
    const rr = (o.radius + 6) ** 2;
    if ((o.x - p.x) ** 2 + (o.y - p.y) ** 2 <= rr) return 0;
    for (let i = 0; i < o.body.length; i += 2) {
      const b = o.body[i];
      if ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 <= rr) return i;
    }
    return -1;
  }

  // Rockets CUT a snake (shorten it) rather than killing it. The severed tail
  // becomes food; the snake survives, smaller.
  function cutSnake(o, hitIndex, impact, attacker) {
    const total = Math.max(1, o.body.length);
    const originalMass = o.mass;
    const keepFrac = clamp(hitIndex / total, 0.2, 0.95);
    const newMass = Math.max(4, o.mass * keepFrac);
    const lost = Math.max(0, o.mass - newMass);
    const start = Math.max(1, hitIndex);
    const dropChunks = Math.max(1, Math.floor((total - start) / 2));
    for (let i = start; i < total; i += 2) {
      const b = o.body[i];
      foods.push({
        x: b.x + (Math.random() - 0.5) * 8,
        y: b.y + (Math.random() - 0.5) * 8,
        r: FOOD_RADIUS,
        mass: Math.max(1, Math.round(lost / dropChunks)),
        color: o.palette.body
      });
    }
    o.mass = newMass;
    recomputeSize(o);
    o.trail.length = Math.min(o.trail.length, Math.max(8, hitIndex * 2 + 4));
    spawnCutFeedback(o, impact || o.body[Math.min(hitIndex, o.body.length - 1)] || o);
    // Only surface cuts the player is part of — bot-vs-bot churn was constantly
    // flashing the feed and cluttering the screen.
    if (attacker && (attacker.isPlayer || o.isPlayer)) {
      const actor = attacker.isPlayer ? "You" : attacker.name;
      const target = o.isPlayer ? "you" : o.name;
      addFeed(`${actor} cut ${target}`, attacker.palette?.body || "#ffcf5a");
    }
    if (attacker && attacker.isPlayer && player && player.alive) rewardCut(originalMass, impact || o);
  }

  // ---- Objectives / challenges -------------------------------------------
  function newObjective() {
    const pool = [
      () => ({ type: "orbs", text: "Eat 15 orbs", target: 15, progress: 0, reward: 20 }),
      () => ({ type: "mega", text: "Collect 3 mega fruit", target: 3, progress: 0, reward: 25 }),
      () => ({ type: "cut", text: "Cut a snake with a rocket", target: 1, progress: 0, reward: 30 }),
      () => ({ type: "length", text: "Reach length 60", target: 60, progress: 0, reward: 25 }),
      () => {
        const b = BIOMES[1 + Math.floor(Math.random() * (BIOMES.length - 1))];
        return { type: "biome", text: `Travel to ${b.name}`, target: 1, progress: 0, reward: 20, biome: b.name };
      }
    ];
    objective = pool[Math.floor(Math.random() * pool.length)]();
  }

  function objectiveProgress(type, n) {
    if (objective && objective.type === type) objective.progress += n;
  }

  function updateObjective() {
    if (!objective) { newObjective(); return; }
    if (objective.type === "length") objective.progress = Math.round(player.mass);
    if (objective.type === "biome" && biomeAt(player.x, player.y) === objective.biome) objective.progress = 1;
    if (objective.progress >= objective.target) {
      player.mass += objective.reward;
      player.score += objective.reward;
      recomputeSize(player);
      spawnBurst(player.x, player.y, "#ffd23f", 24);
      sound.power();
      showToast(`GOAL +${objective.reward}`);
      newObjective();
    }
  }

  let toastTimer = null;
  let toastQueue = [];
  let toastActive = false;
  const TOAST_VISIBLE_MS = 1800;
  const TOAST_MAX_AGE_MS = 3000;

  // Single source of truth for "is the phone HUD active", matching the CSS
  // capability query in arena.css. Cached, because updateHud() consults it ~6.7x/s.
  const phoneLayoutQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse), (max-height: 500px)")
    : null;
  function isPhoneLayout() {
    return phoneLayoutQuery ? phoneLayoutQuery.matches : false;
  }

  // Biome/weather is re-randomised on every respawn, so announcing it each time
  // produced roughly one message every nine seconds on its own. Announce only when
  // it actually changed, or after a decent gap.
  let lastEnvAnnouncement = "";
  let lastEnvAnnouncedAt = 0;
  const ENV_ANNOUNCE_COOLDOWN_MS = 20000;

  function announceEnvironment(force) {
    const text = `${env.name} · ${weather.toUpperCase()}`;
    const now = Date.now();
    if (!force && text === lastEnvAnnouncement
        && now - lastEnvAnnouncedAt < ENV_ANNOUNCE_COOLDOWN_MS) return;
    lastEnvAnnouncement = text;
    lastEnvAnnouncedAt = now;
    showToast(text);
  }

  function showToast(text) {
    const el = document.getElementById("arenaToast");
    if (!el) return;
    // Derive the budget from the slot's real width rather than assuming a 360px
    // phone: a 390px or 412px handset has a wider slot and was being given 60.
    // Only on phones - the desktop toast is shrink-wrapped, so its clientWidth
    // depends on the text already in it and would give a circular answer.
    let mobileBudget = 60;
    if (isPhoneLayout()) {
      const slotWidth = el.clientWidth || 0;
      mobileBudget = slotWidth > 0 ? Math.max(10, Math.floor((slotWidth - 20) / 12)) : 26;
    }
    const glyphs = Array.from(String(text));
    const message = glyphs.length > mobileBudget
      ? glyphs.slice(0, mobileBudget - 1).join("") + "…"
      : glyphs.join("");
    toastQueue.push({ text: message, queuedAt: Date.now() });
    drainToastQueue();
  }

  function drainToastQueue() {
    if (toastActive) return;
    const el = document.getElementById("arenaToast");
    if (!el) return;
    const now = Date.now();
    toastQueue = toastQueue.filter((item) => now - item.queuedAt <= TOAST_MAX_AGE_MS);
    const next = toastQueue.shift();
    if (!next) return;

    toastActive = true;
    el.textContent = next.text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      toastTimer = setTimeout(() => {
        toastActive = false;
        drainToastQueue();
      }, 250);
    }, TOAST_VISIBLE_MS);
  }

  function resetToastQueue() {
    clearTimeout(toastTimer);
    toastTimer = null;
    toastQueue = [];
    toastActive = false;
    const el = document.getElementById("arenaToast");
    if (el) {
      el.classList.remove("show");
      el.textContent = "";
    }
  }

  // ---- Combo / risk-reward -----------------------------------------------
  function updateCombo(dt) {
    if (comboTimer > 0) {
      comboTimer = Math.max(0, comboTimer - dt);
      if (comboTimer === 0) {
        comboCount = 0;
        comboMultiplier = 1;
      }
    }
    if (nearMissCooldown > 0) nearMissCooldown = Math.max(0, nearMissCooldown - dt);
  }

  function addComboEvent(label, baseReward, x, y, color, weight) {
    if (comboTimer <= 0) comboCount = 0;
    comboCount += weight || 1;
    comboBest = Math.max(comboBest, comboCount);
    comboTimer = COMBO_WINDOW;
    comboMultiplier = 1 + Math.min(2, Math.floor(comboCount / 4) * 0.25);
    // Announce a multiplier only the first time it is reached in a run. The combo
    // window lapsing resets the multiplier, so comparing against the previous value
    // re-announced x1.25 every few seconds - over half of all messages on screen.
    if (comboMultiplier > comboAnnouncedMax) {
      comboAnnouncedMax = comboMultiplier;
      showToast(`COMBO ×${comboMultiplier.toFixed(2)}`);
    }

    const bonus = Math.floor(baseReward * (comboMultiplier - 1));
    // Routine fruit no longer pops a combo label (it's already in the HUD and was
    // the main source of on-screen clutter). Only notable events get a label.
    if (label !== "FRUIT") {
      const suffix = bonus > 0 ? ` +${bonus}` : "";
      addFloatingText(x, y, `${label} x${comboMultiplier.toFixed(2)}${suffix}`, color || "#ffcf5a");
    }
    return bonus;
  }

  function rewardCut(targetMass, impact) {
    const bigger = targetMass > player.mass;
    const base = bigger ? Math.min(36, Math.round((targetMass - player.mass) * 0.16) + 12) : 8;
    const bonus = addComboEvent(bigger ? "BIG CUT" : "CUT", base, impact.x, impact.y, "#ffcf5a", bigger ? 4 : 2);
    player.mass += base + bonus;
    player.score += base + bonus;
    recomputeSize(player);
    headPulse = Math.max(headPulse, 0.3);
  }

  function checkNearMiss() {
    if (nearMissCooldown > 0 || hasEffect(player, "ghost")) return;
    const nearPad = 24 + player.radius * 0.8;
    for (const other of snakes) {
      if (other === player || !other.alive) continue;
      const danger = (player.radius + other.radius) * 0.82;
      const near = danger + nearPad;
      const near2 = near * near;
      const danger2 = danger * danger;
      for (let i = 0; i < other.body.length; i += 3) {
        const p = other.body[i];
        const d2 = (p.x - player.x) ** 2 + (p.y - player.y) ** 2;
        if (d2 > danger2 && d2 <= near2) {
          nearMissCooldown = NEAR_MISS_COOLDOWN;
          addComboEvent("THREAD", 4, player.x, player.y, "#56c7ff", 2);
          return;
        }
      }
    }
  }

  function resetCombo() {
    comboCount = 0;
    comboTimer = 0;
    comboMultiplier = 1;
    nearMissCooldown = 0;
  }

  // ---- Collisions ---------------------------------------------------------
  function outsideWorld(s) {
    return Math.hypot(s.x, s.y) > WORLD_RADIUS - s.radius;
  }

  // Head-vs-other-body. Self-collision disabled (slither rules).
  function hitsAnotherSnake(s) {
    if (hasEffect(s, "ghost")) return null; // Ghost power: pass through snakes.
    const hr = s.radius;
    for (const other of snakes) {
      if (other === s || !other.alive) continue;
      // Sample every other segment for performance; bodies are dense enough.
      const step = 2;
      const rr = (hr + other.radius) * 0.82;
      const rr2 = rr * rr;
      for (let i = 0; i < other.body.length; i += step) {
        const p = other.body[i];
        const d2 = (p.x - s.x) ** 2 + (p.y - s.y) ** 2;
        if (d2 <= rr2) return other;
      }
    }
    return null;
  }

  function killSnake(s, reason) {
    s.alive = false;
    // Convert body into a trail of food so others can feast.
    const drop = Math.max(4, Math.floor(s.body.length / 2));
    for (let i = 0; i < s.body.length; i += Math.max(1, Math.floor(s.body.length / drop))) {
      const p = s.body[i];
      foods.push({
        x: p.x + (Math.random() - 0.5) * 10,
        y: p.y + (Math.random() - 0.5) * 10,
        r: FOOD_RADIUS + 2,
        mass: Math.max(1, Math.round(s.mass / drop)),
        color: s.palette.body
      });
    }
    spawnDeathFeedback(s);
    if (s.isPlayer) {
      const completedRun = arenaScoreRun;
      const deathDurationMs = completedRun
        ? Math.max(1, Math.round(performance.now() - completedRun.startedAt))
        : Math.max(1, Math.round(performance.now() - difficultyStart));
      const deathComboBest = comboBest;
      arenaScoreRun = null;
      displayedDeathRun = completedRun;
      boosting = false;
      resetCombo();
      lastDeathReason = reason || "collision";
      addFeed(`You died to ${lastDeathReason}`, "#ff5d73");
      sound.death();
      showDeath(Math.round(s.score), lastDeathReason, {
        length: Math.round(s.mass),
        durationMs: deathDurationMs,
        combo: deathComboBest
      });
      submitArenaScore(Math.round(s.score), completedRun);
    }
    // Bot deaths no longer spam the feed (they happen constantly in the arena).

    // Release a dead bot's geometry now instead of holding it until the array
    // compacts at BOT_TARGET + 40. Nothing reads it: hitsAnotherSnake,
    // findSafeSpawn, drawSnakes and projectileHitIndex all skip !alive, no snake
    // is ever revived in place, and the food drop and death feedback above have
    // already consumed what they need. Measured 2026-08-14: dead snakes were
    // holding up to ~9,900 trail points. The player's is kept, because the death
    // overlay is still on screen looking at it.
    if (!s.isPlayer) {
      s.trail = [];
      s.body = [];
    }
  }

  // ---- Particles ----------------------------------------------------------
  function spawnBurst(x, y, color, count) {
    if (reducedMotion) count = Math.min(4, count);
    const quality = currentQuality();
    count = Math.ceil(count * quality.effectScale);
    const cap = quality.particleCap;
    for (let i = 0; i < count && particles.length < cap; i += 1) {
      const a = Math.random() * TWO_PI;
      const sp = 30 + Math.random() * 120;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.4,
        age: 0,
        r: 2 + Math.random() * 3,
        color
      });
    }
  }

  function spawnSparkles(x, y, color, count, speed) {
    if (reducedMotion) count = Math.min(3, count);
    count = Math.ceil(count * currentQuality().effectScale);
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * TWO_PI;
      const sp = (speed || 120) * (0.35 + Math.random() * 0.75);
      addEffect({
        kind: "spark",
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: 3 + Math.random() * 4,
        rot: Math.random() * TWO_PI,
        spin: (Math.random() - 0.5) * 7,
        color,
        age: 0,
        life: 0.45 + Math.random() * 0.35
      });
    }
  }

  function spawnHeartPops(x, y, color, count) {
    if (reducedMotion) count = Math.min(2, count);
    count = Math.ceil(count * currentQuality().effectScale);
    for (let i = 0; i < count; i += 1) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.4;
      const sp = 55 + Math.random() * 85;
      addEffect({
        kind: "heart",
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: 5 + Math.random() * 4,
        color,
        age: 0,
        life: 0.7 + Math.random() * 0.3
      });
    }
  }

  function spawnEatFeedback(s, f, amount) {
    const rich = (f.mass || 1) >= 4 || f.type === "gold" || f.shape === "star";
    spawnBurst(f.x, f.y, f.color, rich ? 14 : 8);
    spawnSparkles(f.x, f.y, rich ? "#fff1b8" : f.color, rich ? 10 : 5, rich ? 155 : 95);
    if (rich && s.isPlayer) spawnHeartPops(f.x, f.y, f.color, 3);
    addRing(f.x, f.y, f.color, 6, rich ? 52 : 34, rich ? 0.42 : 0.32, rich ? 3 : 2);
    if (s.isPlayer) { addEatText(f.x, f.y, amount, f.color); headPulse = Math.max(headPulse, 0.22); }
  }

  function spawnPickupFeedback(it, def, label) {
    spawnBurst(it.x, it.y, def.color, 14);
    spawnSparkles(it.x, it.y, def.color, 10, 140);
    if (def.cat !== "hazard") spawnHeartPops(it.x, it.y, def.color, 3);
    addRing(it.x, it.y, def.color, def.r, def.r * 3.2, 0.42, 3);
    addFloatingText(it.x, it.y, label, def.color);
    addEffect({ kind: "fly", x: it.x, y: it.y, toX: 145, toY: 92, color: def.color, r: 9, age: 0, life: 0.55 });
    headPulse = Math.max(headPulse, 0.28);
  }

  function spawnBombExplosion(x, y) {
    addRing(x, y, "#ffae42", 12, 150, 0.62, 5);
    addRing(x, y, "#ff5d73", 24, 220, 0.78, 3);
    addFlash(x, y, "#ffae42", 150, 0.24);
    addFloatingText(x, y, "BOOM", "#ffae42");
    spawnBurst(x, y, "#ffae42", 42);
    spawnBurst(x, y, "#20242b", 28);
    spawnDebris(x, y, "#ffae42", 26, 180);
    spawnSparkles(x, y, "#ffcf5a", 18, 210);
    shake(1.05);
  }

  function spawnCutFeedback(s, impact) {
    const x = impact.x || s.x;
    const y = impact.y || s.y;
    addFlash(x, y, "#ffffff", 60, 0.18);
    addRing(x, y, s.palette.glow, 8, 95, 0.42, 3);
    addFloatingText(x, y, "CUT", s.palette.glow);
    spawnBurst(x, y, s.palette.glow, 18);
    spawnSparkles(x, y, "#ffffff", 8, 170);
    spawnDebris(x, y, s.palette.body, 18, 120);
    shake(0.32);
  }

  function spawnDeathFeedback(s) {
    addRing(s.x, s.y, s.palette.glow, s.radius, s.radius * 6, 0.55, 4);
    addFlash(s.x, s.y, s.palette.glow, s.radius * 8, 0.25);
    spawnBurst(s.x, s.y, s.palette.glow, 26);
    spawnSparkles(s.x, s.y, s.palette.glow, 12, 150);
    spawnDebris(s.x, s.y, s.palette.body, 20, 150);
    if (s.isPlayer) shake(0.58);
  }

  function spawnDebris(x, y, color, count, speed) {
    if (reducedMotion) count = Math.min(4, count);
    count = Math.ceil(count * currentQuality().effectScale);
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * TWO_PI;
      const sp = speed * (0.45 + Math.random() * 0.75);
      addEffect({
        kind: "debris",
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: 2 + Math.random() * 4,
        color,
        age: 0,
        life: 0.55 + Math.random() * 0.35
      });
    }
  }

  function addRing(x, y, color, r0, r1, life, width) {
    addEffect({ kind: "ring", x, y, color, r0, r1, width, age: 0, life });
  }

  function addFlash(x, y, color, r, life) {
    addEffect({ kind: "flash", x, y, color, r, age: 0, life });
  }

  function addFloatingText(x, y, text, color) {
    addEffect({ kind: "text", x, y, text, color, rise: isPhone ? 34 : 46, age: 0, life: isPhone ? 0.62 : 0.75 });
  }

  // Merge rapid fruit pickups into ONE rising "+total" that follows the head, so
  // collecting a big pile shows e.g. "+57" instead of burying the screen in numbers.
  let eatAccum = 0;
  let eatAccumEffect = null;
  let eatAccumUntil = 0;
  function addEatText(x, y, amount, color) {
    const now = performance.now();
    if (eatAccumEffect && now < eatAccumUntil && effects.indexOf(eatAccumEffect) !== -1) {
      eatAccum += amount;
      eatAccumEffect.text = `+${eatAccum}`;
      eatAccumEffect.x = x;
      eatAccumEffect.y = y;
      eatAccumEffect.age = 0; // keep it fresh/visible while still eating
      eatAccumUntil = now + 280;
      return;
    }
    eatAccum = amount;
    eatAccumEffect = { kind: "text", x, y, text: `+${amount}`, color, rise: isPhone ? 34 : 46, age: 0, life: isPhone ? 0.62 : 0.78 };
    addEffect(eatAccumEffect);
    eatAccumUntil = now + 280;
  }

  function addEffect(effect) {
    const cap = currentQuality().effectCap;
    if (effects.length >= cap) effects.shift();
    effects.push(effect);
  }

  function shake(amount) {
    if (reducedMotion) return;
    screenShake = Math.max(screenShake, amount);
  }

  function updateParticles(dt) {
    let write = 0;
    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      particles[write] = p;
      write += 1;
    }
    particles.length = write;
  }

  function updateEffects(dt) {
    if (headPulse > 0) headPulse = Math.max(0, headPulse - dt * 4.5);
    if (screenShake > 0 && !reducedMotion) {
      screenShake = Math.max(0, screenShake - dt * 3.8);
      const strength = screenShake * currentQuality().shake;
      shakeX = (Math.random() - 0.5) * strength;
      shakeY = (Math.random() - 0.5) * strength;
    } else {
      screenShake = 0;
      shakeX = 0;
      shakeY = 0;
    }

    let write = 0;
    for (let i = 0; i < effects.length; i += 1) {
      const e = effects[i];
      e.age += dt;
      if (e.age >= e.life) continue;
      if (e.vx || e.vy) {
        e.x += (e.vx || 0) * dt;
        e.y += (e.vy || 0) * dt;
        e.vx *= 0.97;
        e.vy *= 0.97;
      }
      effects[write] = e;
      write += 1;
    }
    effects.length = write;
  }

  // ---- Rendering ----------------------------------------------------------
  function render(ts) {
    frameMs = ts || performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (screenShake > 0 && !reducedMotion) ctx.translate(shakeX, shakeY);
    drawSky();
    drawWorldScenery();
    drawBoundary();
    drawSkyDrop();
    drawFoods();
    drawItems();
    drawSnakes();
    drawProjectiles();
    drawParticles();
    drawEffects();
    drawLighting();
    if (!reducedMotion) drawWeather();
    drawControls();
    // Minimap removed — it was cluttered and not useful in single player.
  }

  function drawSky() {
    if (skyCanvas) {
      ctx.drawImage(skyCanvas, 0, 0, cw, ch);
      return;
    }
    drawSkyGradient(ctx, cw, ch);
  }

  function drawSkyGradient(targetCtx, width, height) {
    const g = targetCtx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, env.sky[0]);
    g.addColorStop(1, env.sky[1]);
    targetCtx.fillStyle = g;
    targetCtx.fillRect(0, 0, width, height);
  }

  function rebuildStaticScenery() {
    if (!ctx || cw <= 0 || ch <= 0) return;
    rebuildSkyCanvas();
    rebuildWorldSceneryCanvas();
  }

  function rebuildSkyCanvas() {
    const canvasEl = document.createElement("canvas");
    canvasEl.width = Math.max(1, Math.round(cw * dpr));
    canvasEl.height = Math.max(1, Math.round(ch * dpr));
    const sctx = canvasEl.getContext("2d");
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSkyGradient(sctx, cw, ch);

    if (weather === "night" || weather === "storm") {
      sctx.fillStyle = weather === "night" ? "rgba(255,255,255,0.5)" : "rgba(220,230,255,0.32)";
      const stars = qualityTier === "high" ? 80 : qualityTier === "balanced" ? 54 : 30;
      for (let i = 0; i < stars; i += 1) {
        const x = ((i * 197.3) % Math.max(1, cw));
        const y = ((i * 89.7) % Math.max(1, ch * 0.72));
        const r = i % 7 === 0 ? 1.5 : 1;
        sctx.globalAlpha = 0.25 + ((i * 37) % 60) / 100;
        sctx.beginPath();
        sctx.arc(x, y, r, 0, TWO_PI);
        sctx.fill();
      }
      sctx.globalAlpha = 1;
    }

    skyCanvas = canvasEl;
  }

  function rebuildWorldSceneryCanvas() {
    const quality = currentQuality();
    const size = quality.scenery || 2048;
    const canvasEl = document.createElement("canvas");
    canvasEl.width = size;
    canvasEl.height = size;
    const sctx = canvasEl.getContext("2d");
    const worldPx = size / (WORLD_RADIUS * 2);

    for (const d of decoPoints) {
      drawDecoOn(sctx, env.deco, worldToScenery(d.x, size), worldToScenery(d.y, size), worldPx * d.s);
    }

    const grid = 130;
    sctx.fillStyle = env.dot;
    const dot = Math.max(1, 2 * worldPx);
    for (let x = -WORLD_RADIUS; x <= WORLD_RADIUS; x += grid) {
      for (let y = -WORLD_RADIUS; y <= WORLD_RADIUS; y += grid) {
        sctx.fillRect(worldToScenery(x, size), worldToScenery(y, size), dot, dot);
      }
    }

    for (const b of BIOMES) {
      const x = worldToScenery(b.x, size);
      const y = worldToScenery(b.y, size);
      const r = b.r * worldPx;
      const g = sctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(b.accent, 0.16));
      g.addColorStop(1, rgba(b.accent, 0));
      sctx.fillStyle = g;
      sctx.beginPath();
      sctx.arc(x, y, r, 0, TWO_PI);
      sctx.fill();
    }

    sceneryCanvas = canvasEl;
    scenerySize = size;
  }

  function drawWorldScenery() {
    if (!sceneryCanvas || !scenerySize) {
      drawDecorations();
      drawBackground();
      drawBiomes();
      return;
    }

    const viewW = cw / camera.scale;
    const viewH = ch / camera.scale;
    const viewLeft = camera.x - viewW / 2;
    const viewTop = camera.y - viewH / 2;
    const srcLeft = clamp(viewLeft, -WORLD_RADIUS, WORLD_RADIUS);
    const srcTop = clamp(viewTop, -WORLD_RADIUS, WORLD_RADIUS);
    const srcRight = clamp(viewLeft + viewW, -WORLD_RADIUS, WORLD_RADIUS);
    const srcBottom = clamp(viewTop + viewH, -WORLD_RADIUS, WORLD_RADIUS);
    if (srcRight <= srcLeft || srcBottom <= srcTop) return;

    const worldPx = scenerySize / (WORLD_RADIUS * 2);
    const sx = (srcLeft + WORLD_RADIUS) * worldPx;
    const sy = (srcTop + WORLD_RADIUS) * worldPx;
    const sw = (srcRight - srcLeft) * worldPx;
    const sh = (srcBottom - srcTop) * worldPx;
    const dx = (srcLeft - viewLeft) * camera.scale;
    const dy = (srcTop - viewTop) * camera.scale;
    const dw = (srcRight - srcLeft) * camera.scale;
    const dh = (srcBottom - srcTop) * camera.scale;
    ctx.drawImage(sceneryCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function worldToScenery(value, size) {
    return (value + WORLD_RADIUS) * size / (WORLD_RADIUS * 2);
  }

  function drawDecorations() {
    for (const d of decoPoints) {
      const s = worldToScreen(d.x, d.y);
      if (s.x < -90 || s.x > cw + 90 || s.y < -90 || s.y > ch + 90) continue;
      drawDecoOn(ctx, env.deco, s.x, s.y, camera.scale * d.s);
    }
  }

  function drawDecoOn(targetCtx, type, x, y, sc) {
    targetCtx.save();
    targetCtx.translate(x, y);
    if (type === "trees") {
      const h = 42 * sc;
      targetCtx.fillStyle = "rgba(40,30,20,0.6)";
      targetCtx.fillRect(-h * 0.07, -h * 0.05, h * 0.14, h * 0.3);
      targetCtx.fillStyle = "rgba(22,64,38,0.75)";
      targetCtx.beginPath(); targetCtx.moveTo(0, -h); targetCtx.lineTo(h * 0.5, 0); targetCtx.lineTo(-h * 0.5, 0); targetCtx.closePath(); targetCtx.fill();
    } else if (type === "peaks") {
      const h = 72 * sc;
      targetCtx.fillStyle = "rgba(64,76,98,0.5)";
      targetCtx.beginPath(); targetCtx.moveTo(0, -h); targetCtx.lineTo(h * 0.7, 0); targetCtx.lineTo(-h * 0.7, 0); targetCtx.closePath(); targetCtx.fill();
      targetCtx.fillStyle = "rgba(232,242,255,0.55)";
      targetCtx.beginPath(); targetCtx.moveTo(0, -h); targetCtx.lineTo(h * 0.22, -h * 0.68); targetCtx.lineTo(-h * 0.22, -h * 0.68); targetCtx.closePath(); targetCtx.fill();
    } else if (type === "dunes") {
      const w = 95 * sc;
      targetCtx.fillStyle = "rgba(180,130,70,0.3)";
      targetCtx.beginPath(); targetCtx.ellipse(0, 0, w, w * 0.4, 0, Math.PI, 0); targetCtx.fill();
    } else if (type === "waves") {
      const w = 70 * sc;
      targetCtx.strokeStyle = "rgba(255,255,255,0.16)";
      targetCtx.lineWidth = 2 * sc;
      targetCtx.beginPath();
      targetCtx.moveTo(-w, 0);
      targetCtx.quadraticCurveTo(-w * 0.5, -8 * sc, 0, 0);
      targetCtx.quadraticCurveTo(w * 0.5, 8 * sc, w, 0);
      targetCtx.stroke();
    } else if (type === "drifts") {
      const w = 82 * sc;
      targetCtx.fillStyle = "rgba(255,255,255,0.2)";
      targetCtx.beginPath(); targetCtx.ellipse(0, 0, w, w * 0.34, 0, Math.PI, 0); targetCtx.fill();
    }
    targetCtx.restore();
  }

  function drawLighting() {
    if (weather === "night") { ctx.fillStyle = "rgba(6,8,28,0.5)"; ctx.fillRect(0, 0, cw, ch); }
    else if (weather === "storm") { ctx.fillStyle = "rgba(8,10,20,0.5)"; ctx.fillRect(0, 0, cw, ch); }
    else if (weather === "snow") { ctx.fillStyle = "rgba(210,225,240,0.1)"; ctx.fillRect(0, 0, cw, ch); }

    if (lightningFlash > 0) {
      ctx.fillStyle = `rgba(220,230,255,${0.55 * lightningFlash})`;
      ctx.fillRect(0, 0, cw, ch);
    }

    const v = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.32, cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, weather === "day" ? "rgba(0,0,0,0.32)" : "rgba(0,0,0,0.5)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, cw, ch);

    if (player.alive) {
      const hp = worldToScreen(player.x, player.y);
      const lr = (weather === "night" || weather === "storm") ? 260 : 180;
      const warm = (weather === "night" || weather === "storm") ? 0.22 : 0.12;
      const lg = ctx.createRadialGradient(hp.x, hp.y, 0, hp.x, hp.y, lr);
      lg.addColorStop(0, `rgba(255,240,200,${warm})`);
      lg.addColorStop(1, "rgba(255,240,200,0)");
      ctx.fillStyle = lg;
      ctx.fillRect(hp.x - lr, hp.y - lr, lr * 2, lr * 2);
    }
  }

  function drawWeather() {
    if (weather === "snow") {
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (const p of weatherP) {
        ctx.beginPath();
        ctx.arc(p.x * cw, p.y * ch, p.size, 0, TWO_PI);
        ctx.fill();
      }
      ctx.restore();
    } else if (weather === "storm") {
      ctx.save();
      ctx.strokeStyle = "rgba(150,180,220,0.5)";
      ctx.lineWidth = 1.5;
      for (const p of weatherP) {
        const x = p.x * cw, y = p.y * ch;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 3, y + p.len);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawBiomes() {
    for (const b of BIOMES) {
      const c = worldToScreen(b.x, b.y);
      const r = b.r * camera.scale;
      if (c.x + r < 0 || c.x - r > cw || c.y + r < 0 || c.y - r > ch) continue;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, rgba(b.accent, 0.16));
      g.addColorStop(1, rgba(b.accent, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, TWO_PI);
      ctx.fill();
    }
  }

  function drawMinimap() {
    const size = Math.min(150, Math.round(Math.min(cw, ch) * 0.32));
    const pad = 16;
    const cxm = cw - pad - size / 2;
    const cym = ch - 96 - size / 2;
    const rm = size / 2;
    const scale = rm / WORLD_RADIUS;

    ctx.save();
    ctx.fillStyle = "rgba(3, 6, 9, 0.6)";
    ctx.strokeStyle = "rgba(86, 199, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cxm, cym, rm, 0, TWO_PI);
    ctx.fill();
    ctx.stroke();
    ctx.clip();

    for (const b of BIOMES) {
      ctx.fillStyle = rgba(b.accent, 0.3);
      ctx.beginPath();
      ctx.arc(cxm + b.x * scale, cym + b.y * scale, b.r * scale, 0, TWO_PI);
      ctx.fill();
    }
    for (const s of snakes) {
      if (!s.alive || s.isPlayer) continue;
      ctx.fillStyle = s.palette.body;
      ctx.fillRect(cxm + s.x * scale - 1, cym + s.y * scale - 1, 2, 2);
    }
    if (player.alive) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cxm + player.x * scale, cym + player.y * scale, 3, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawItems() {
    const margin = 50;
    for (const it of items) {
      const s = worldToScreen(it.x, it.y);
      if (s.x < -margin || s.x > cw + margin || s.y < -margin || s.y > ch + margin) continue;
      const def = ITEM_KINDS[it.type];
      const r = Math.max(5, it.r * camera.scale);
      drawShadow(s.x, s.y, r);
      drawGlowSprite(s.x, s.y, r * 2.2, def.color, 0.72);
      ctx.save();
      ctx.translate(s.x, s.y);
      drawItemIcon(def.icon, r, def.color);
      if (!reducedMotion && def.cat !== "hazard" && r > 5) {
        drawIdleSparkles(r * 0.82, frameMs * 0.004 + it.x * 0.01, def.color);
      }
      ctx.restore();
    }
  }

  // Little vector icons so every pickup is instantly recognizable.
  function drawItemIcon(icon, r, color) {
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (icon === "cherry") {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(-r * 0.35, r * 0.25, r * 0.6, 0, TWO_PI); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.4, r * 0.35, r * 0.55, 0, TWO_PI); ctx.fill();
      ctx.strokeStyle = "#46f2a4"; ctx.beginPath();
      ctx.moveTo(-r * 0.35, -r * 0.35); ctx.quadraticCurveTo(r * 0.1, -r, r * 0.4, -r * 0.25); ctx.stroke();
      drawCuteFace(r * 0.7, "#3b0615");
    } else if (icon === "thunder") {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(r * 0.1, -r); ctx.lineTo(-r * 0.5, r * 0.15); ctx.lineTo(0, r * 0.15);
      ctx.lineTo(-r * 0.15, r); ctx.lineTo(r * 0.6, -r * 0.2); ctx.lineTo(r * 0.1, -r * 0.2);
      ctx.closePath(); ctx.fill();
      drawCuteFace(r * 0.55, "#3b2b00");
    } else if (icon === "mushroom") {
      ctx.fillStyle = "#f2e7d5"; // stem
      ctx.fillRect(-r * 0.32, 0, r * 0.64, r * 0.8);
      ctx.fillStyle = color; // red cap
      ctx.beginPath(); ctx.arc(0, 0, r * 0.85, Math.PI, 0); ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.2, r * 0.14, 0, TWO_PI); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.3, -r * 0.3, r * 0.12, 0, TWO_PI); ctx.fill();
      drawBadFace(r * 0.78, "#3b0606");
    } else if (icon === "magnet") {
      ctx.strokeStyle = color; ctx.lineWidth = r * 0.5;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.55, Math.PI, 0); ctx.stroke();
      ctx.strokeStyle = "#e74c3c"; ctx.lineWidth = r * 0.22;
      ctx.beginPath(); ctx.moveTo(-r * 0.55, 0); ctx.lineTo(-r * 0.55, r * 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r * 0.55, 0); ctx.lineTo(r * 0.55, r * 0.5); ctx.stroke();
      drawCuteFace(r * 0.52, "#2b113d");
    } else if (icon === "ghost") {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(0, -r * 0.1, r * 0.7, Math.PI, 0);
      ctx.lineTo(r * 0.7, r * 0.6); ctx.lineTo(r * 0.35, r * 0.3); ctx.lineTo(0, r * 0.6);
      ctx.lineTo(-r * 0.35, r * 0.3); ctx.lineTo(-r * 0.7, r * 0.6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#05121a";
      ctx.beginPath(); ctx.arc(-r * 0.25, -r * 0.1, r * 0.13, 0, TWO_PI); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.25, -r * 0.1, r * 0.13, 0, TWO_PI); ctx.fill();
    } else if (icon === "rocket") {
      ctx.fillStyle = "#e8eef5"; // body
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.quadraticCurveTo(r * 0.5, -r * 0.2, r * 0.4, r * 0.5);
      ctx.lineTo(-r * 0.4, r * 0.5); ctx.quadraticCurveTo(-r * 0.5, -r * 0.2, 0, -r); ctx.fill();
      ctx.fillStyle = color; // nose + flame
      ctx.beginPath(); ctx.arc(0, -r * 0.35, r * 0.22, 0, TWO_PI); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-r * 0.25, r * 0.5); ctx.lineTo(0, r); ctx.lineTo(r * 0.25, r * 0.5); ctx.closePath(); ctx.fill();
    } else if (icon === "bomb") {
      ctx.fillStyle = "#20242b";
      ctx.beginPath(); ctx.arc(0, r * 0.15, r * 0.8, 0, TWO_PI); ctx.fill();
      ctx.strokeStyle = "#8a6d3b"; ctx.lineWidth = r * 0.18;
      ctx.beginPath(); ctx.moveTo(r * 0.25, -r * 0.5); ctx.quadraticCurveTo(r * 0.7, -r * 0.7, r * 0.55, -r); ctx.stroke();
      ctx.fillStyle = "#ffae42";
      ctx.beginPath(); ctx.arc(r * 0.55, -r, r * 0.18, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath(); ctx.arc(-r * 0.25, -r * 0.15, r * 0.2, 0, TWO_PI); ctx.fill();
      drawBadFace(r * 0.88, "#f2e7d5");
    } else {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TWO_PI); ctx.fill();
    }
  }

  function drawShadow(x, y, r) {
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    ctx.ellipse(x + r * 0.35, y + r * 0.55, r * 0.95, r * 0.5, 0, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }

  function drawProjectiles() {
    for (const p of projectiles) {
      const s = worldToScreen(p.x, p.y);
      drawGlowSprite(s.x, s.y, Math.max(14, 18 * camera.scale), "#ff8c1a", 0.75);
      ctx.save();
      ctx.fillStyle = "#ffd23f";
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(2, 5 * camera.scale), 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
  }

  // Draw the aim guide, plus a reticle (desktop) or joystick (mobile) so the
  // player never loses track of where they are steering.
  function drawControls() {
    if (!player.alive) return;
    const head = worldToScreen(player.x, player.y);

    // Aim guide: a short dashed line from the head along the current heading.
    ctx.save();
    ctx.strokeStyle = "rgba(237, 247, 255, 0.22)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);
    ctx.lineTo(head.x + Math.cos(player.angle) * 95, head.y + Math.sin(player.angle) * 95);
    ctx.stroke();
    ctx.restore();

    // Weapon aim line from the head toward the cursor when armed (desktop).
    if (!usingTouch && missileAmmo > 0 && controlMode === "mouse") {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 140, 26, 0.5)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 7]);
      ctx.beginPath();
      ctx.moveTo(head.x, head.y);
      ctx.lineTo(pointer.x, pointer.y);
      ctx.stroke();
      ctx.restore();
    }

    if (joystick.active) {
      let kx = joystick.x, ky = joystick.y;
      const dx = kx - joystick.baseX, dy = ky - joystick.baseY;
      const d = Math.hypot(dx, dy);
      if (d > 46) { kx = joystick.baseX + dx / d * 46; ky = joystick.baseY + dy / d * 46; }
      ctx.save();
      ctx.strokeStyle = "rgba(86, 199, 255, 0.5)";
      ctx.fillStyle = "rgba(86, 199, 255, 0.12)";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(joystick.baseX, joystick.baseY, 46, 0, TWO_PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "rgba(86, 199, 255, 0.85)";
      ctx.beginPath(); ctx.arc(kx, ky, 18, 0, TWO_PI); ctx.fill();
      ctx.restore();
    } else if (controlMode === "mouse") {
      // Desktop crosshair reticle at the cursor (only in mouse mode).
      ctx.save();
      ctx.strokeStyle = "rgba(70, 242, 164, 0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pointer.x, pointer.y, 10, 0, TWO_PI); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pointer.x - 16, pointer.y); ctx.lineTo(pointer.x - 5, pointer.y);
      ctx.moveTo(pointer.x + 5, pointer.y); ctx.lineTo(pointer.x + 16, pointer.y);
      ctx.moveTo(pointer.x, pointer.y - 16); ctx.lineTo(pointer.x, pointer.y - 5);
      ctx.moveTo(pointer.x, pointer.y + 5); ctx.lineTo(pointer.x, pointer.y + 16);
      ctx.stroke();
      ctx.restore();
    }
  }

  function worldToScreen(x, y) {
    return {
      x: (x - camera.x) * camera.scale + cw / 2,
      y: (y - camera.y) * camera.scale + ch / 2
    };
  }

  function drawBackground() {
    const grid = 130;
    const left = camera.x - cw / 2 / camera.scale;
    const top = camera.y - ch / 2 / camera.scale;
    const right = camera.x + cw / 2 / camera.scale;
    const bottom = camera.y + ch / 2 / camera.scale;
    ctx.fillStyle = env.dot;
    const startX = Math.floor(left / grid) * grid;
    const startY = Math.floor(top / grid) * grid;
    for (let x = startX; x < right; x += grid) {
      for (let y = startY; y < bottom; y += grid) {
        const s = worldToScreen(x, y);
        ctx.fillRect(s.x, s.y, 2, 2);
      }
    }
  }

  function drawBoundary() {
    const c = worldToScreen(0, 0);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 93, 115, 0.16)";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(c.x, c.y, WORLD_RADIUS * camera.scale, 0, TWO_PI);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 93, 115, 0.55)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(c.x, c.y, WORLD_RADIUS * camera.scale, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }

  function drawSkyDrop() {
    if (!skyDrop) return;
    const s = worldToScreen(skyDrop.x, skyDrop.y);
    const pulse = reducedMotion ? 0 : Math.sin(frameMs * 0.008 + skyDrop.phase) * 0.5 + 0.5;
    const groundR = SKY_DROP_RADIUS * camera.scale;

    ctx.save();
    ctx.globalAlpha = 0.55 + pulse * 0.25;
    ctx.strokeStyle = "#ffcf5a";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, groundR * (2.2 + pulse * 0.3), 0, TWO_PI);
    ctx.stroke();
    ctx.setLineDash([]);

    const beamH = skyDrop.state === "active" ? 70 : 220;
    const beam = ctx.createLinearGradient(s.x, s.y - beamH, s.x, s.y + 20);
    beam.addColorStop(0, "rgba(255,207,90,0)");
    beam.addColorStop(0.55, "rgba(255,207,90,0.18)");
    beam.addColorStop(1, "rgba(255,207,90,0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y - beamH * 0.35, groundR * 0.7, beamH * 0.55, 0, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    const fallT = skyDrop.state === "falling" ? clamp(skyDrop.age / SKY_DROP_FALL, 0, 1) : 1;
    const z = skyDrop.state === "telegraph" ? 260 : (1 - easeOut(fallT)) * 260;
    if (skyDrop.state !== "telegraph") {
      drawGlowSprite(s.x, s.y - z * camera.scale, Math.max(24, groundR * 2.4), "#ffcf5a", 0.78);
      ctx.save();
      ctx.translate(s.x, s.y - z * camera.scale);
      ctx.rotate(reducedMotion ? 0 : frameMs * 0.004);
      ctx.fillStyle = "#ffcf5a";
      drawStar(0, 0, Math.max(12, groundR * 0.92), Math.max(6, groundR * 0.44), 5);
      drawCuteFace(Math.max(8, groundR * 0.7), "#332500");
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = skyDrop.state === "active" ? 0.35 : 0.22;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + groundR * 0.85, groundR * 1.2, groundR * 0.42, 0, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }

  function drawGlowSprite(x, y, radius, color, alpha) {
    if (qualityTier === "low" || radius <= 0) return;
    const sprite = glowSprite(radius, color);
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.drawImage(sprite.canvas, x - sprite.size / 2, y - sprite.size / 2, sprite.size, sprite.size);
    ctx.restore();
  }

  function glowSprite(radius, color) {
    const spriteDpr = Math.max(1, Math.ceil(dpr || 1));
    const size = Math.max(10, Math.ceil(radius * 2));
    const key = `${spriteDpr}:${size}:${color}`;
    const cached = glowSprites.get(key);
    if (cached) return cached;

    const canvasEl = document.createElement("canvas");
    canvasEl.width = size * spriteDpr;
    canvasEl.height = size * spriteDpr;
    const gctx = canvasEl.getContext("2d");
    gctx.setTransform(spriteDpr, 0, 0, spriteDpr, 0, 0);
    const center = size / 2;
    const gradient = gctx.createRadialGradient(center, center, 0, center, center, size / 2);
    gradient.addColorStop(0, rgba(color, qualityTier === "balanced" ? 0.42 : 0.58));
    gradient.addColorStop(0.42, rgba(color, qualityTier === "balanced" ? 0.2 : 0.28));
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    gctx.fillStyle = gradient;
    gctx.fillRect(0, 0, size, size);

    const sprite = { canvas: canvasEl, size };
    glowSprites.set(key, sprite);
    if (glowSprites.size > 160) glowSprites.delete(glowSprites.keys().next().value);
    return sprite;
  }

  function drawFoods() {
    const margin = 40;
    for (const f of foods) {
      const s = worldToScreen(f.x, f.y);
      if (s.x < -margin || s.x > cw + margin || s.y < -margin || s.y > ch + margin) continue;
      const bob = reducedMotion ? 0 : Math.sin(frameMs * 0.004 + (f.phase || 0)) * 2.2;
      const r = (f.r || FOOD_RADIUS) * camera.scale;
      const y = s.y + bob;
      drawGlowSprite(s.x, y, r * (f.type === "gold" ? 2.8 : 2.15), f.color, f.type === "gold" ? 0.85 : 0.68);
      ctx.save();
      ctx.translate(s.x, y);
      drawFoodIcon(f, Math.max(2, r));
      if (!reducedMotion && (f.type === "gold" || f.shape === "star") && r > 4) {
        drawIdleSparkles(r, frameMs * 0.004 + (f.phase || 0), "#fff1b8");
      }
      ctx.restore();
    }
  }

  function drawFoodIcon(f, r) {
    const shape = f.shape || "orb";
    ctx.fillStyle = f.color;
    if (shape === "apple") {
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 0.82, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = "#46f2a4";
      ctx.beginPath();
      ctx.ellipse(r * 0.28, -r * 0.78, r * 0.26, r * 0.14, -0.7, 0, TWO_PI);
      ctx.fill();
      drawCuteFace(r, "#231014");
    } else if (shape === "melon") {
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.05, r * 0.78, -0.2, 0, TWO_PI);
      ctx.fill();
      ctx.strokeStyle = "rgba(3, 60, 38, 0.42)";
      ctx.lineWidth = Math.max(1, r * 0.12);
      for (let i = -1; i <= 1; i += 1) {
        ctx.beginPath();
        ctx.ellipse(i * r * 0.25, 0, r * 0.14, r * 0.68, -0.2, 0, TWO_PI);
        ctx.stroke();
      }
      drawCuteFace(r, "#05291b");
    } else if (shape === "star") {
      drawStar(0, 0, r * 1.05, r * 0.48, 5);
      drawCuteFace(r * 0.9, "#332500");
    } else if (shape === "berry") {
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.78, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.32)";
      ctx.beginPath();
      ctx.arc(-r * 0.25, -r * 0.28, r * 0.18, 0, TWO_PI);
      ctx.fill();
      drawCuteFace(r, "#2a0718");
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TWO_PI);
      ctx.fill();
    }
  }

  function drawCuteFace(r, color) {
    if (r < 5) return;
    ctx.save();
    ctx.fillStyle = color;
    const eye = Math.max(1, r * 0.11);
    ctx.beginPath();
    ctx.arc(-r * 0.27, -r * 0.06, eye, 0, TWO_PI);
    ctx.arc(r * 0.27, -r * 0.06, eye, 0, TWO_PI);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.arc(0, r * 0.12, r * 0.23, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  function drawBadFace(r, color) {
    if (r < 5) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(-r * 0.42, -r * 0.18);
    ctx.lineTo(-r * 0.18, -r * 0.04);
    ctx.moveTo(r * 0.42, -r * 0.18);
    ctx.lineTo(r * 0.18, -r * 0.04);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-r * 0.28, r * 0.02, r * 0.06, 0, TWO_PI);
    ctx.arc(r * 0.28, r * 0.02, r * 0.06, 0, TWO_PI);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, r * 0.34, r * 0.24, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
    ctx.restore();
  }

  function drawStar(x, y, outer, inner, points) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i += 1) {
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const rr = i % 2 === 0 ? outer : inner;
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  function drawHeart(x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.65);
    ctx.bezierCurveTo(x - r * 1.05, y, x - r * 0.82, y - r * 0.75, x - r * 0.28, y - r * 0.45);
    ctx.bezierCurveTo(x, y - r * 0.82, x + r * 0.28, y - r * 0.45, x + r * 0.28, y - r * 0.45);
    ctx.bezierCurveTo(x + r * 0.82, y - r * 0.75, x + r * 1.05, y, x, y + r * 0.65);
    ctx.closePath();
    ctx.fill();
  }

  function drawIdleSparkles(r, phase, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.72;
    for (let i = 0; i < 3; i += 1) {
      const a = phase + i * TWO_PI / 3;
      const rr = r * (1.02 + 0.16 * Math.sin(phase * 1.7 + i));
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr * 0.72;
      drawStar(x, y, Math.max(2, r * 0.16), Math.max(1, r * 0.07), 4);
    }
    ctx.restore();
  }

  function drawSnakes() {
    // Draw bots first, player last (on top).
    for (const s of snakes) {
      if (s.alive && !s.isPlayer) drawSnake(s);
    }
    if (player.alive) drawSnake(player);
  }

  function drawSnake(s) {
    const r = s.radius * camera.scale;
    ctx.save();
    ctx.fillStyle = s.palette.body;
    // Tail -> head so the head overlaps cleanly.
    const bodyStep = s.isPlayer ? 1 : (qualityTier === "low" || camera.scale < 0.65 ? 2 : 1);
    // The glow radius, colour and alpha are the same for every segment of this
    // snake, so resolve the sprite once instead of rebuilding a cache key string
    // and doing a save/restore per segment (419-1021 of them a frame).
    // Measured 2026-08-14: drawSnake 3.308 -> 2.566 ms/frame at CPU x4, and
    // proven pixel-identical (0 differing bytes of 4,410,000).
    const glowR = r * (s.isPlayer ? 2.25 : 1.85);
    const glowSpr = (qualityTier === "low" || glowR <= 0) ? null : glowSprite(glowR, s.palette.glow);
    const glowAlpha = s.isPlayer ? 0.52 : 0.36;
    const dotR = Math.max(1.5, r);
    const prevAlpha = ctx.globalAlpha;
    for (let i = s.body.length - 1; i >= 0; i -= bodyStep) {
      const p = worldToScreen(s.body[i].x, s.body[i].y);
      if (p.x < -r || p.x > cw + r || p.y < -r || p.y > ch + r) continue;
      if (glowSpr) {
        ctx.globalAlpha = glowAlpha;
        ctx.drawImage(glowSpr.canvas, p.x - glowSpr.size / 2, p.y - glowSpr.size / 2, glowSpr.size, glowSpr.size);
        ctx.globalAlpha = prevAlpha;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();

    // Head + eyes
    const head = worldToScreen(s.x, s.y);
    const pulseScale = s.isPlayer ? 1 + headPulse * 0.22 : 1;
    drawGlowSprite(head.x, head.y, r * (s.isPlayer ? 2.8 : 2.15), s.palette.glow, s.isPlayer ? 0.76 : 0.48);
    drawHead(s, head, r, pulseScale);

    // Active-power aura ring around the player's head.
    if (s.isPlayer) {
      const aura = hasEffect(s, "ghost") ? "#5ffbf1"
        : hasEffect(s, "speed") ? "#ffd23f"
        : hasEffect(s, "slow") ? "#c0392b"
        : hasEffect(s, "magnet") ? "#b06bff" : null;
      if (aura) {
        drawGlowSprite(head.x, head.y, r * 3.4, aura, 0.5);
        ctx.save();
        ctx.strokeStyle = aura;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(head.x, head.y, r * 1.7, 0, TWO_PI);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Name label
    if (r > 4 && (s.isPlayer || qualityTier !== "low")) {
      ctx.save();
      ctx.fillStyle = "rgba(237, 247, 255, 0.85)";
      ctx.font = `${Math.max(10, Math.round(r * 0.9))}px "Press Start 2P", "Courier New", monospace`;
      ctx.textAlign = "center";
      ctx.fillText(s.name, head.x, head.y - r - 6);
      ctx.restore();
    }
  }

  function drawHead(s, head, r, pulseScale) {
    const size = Math.max(2, r * 1.08 * pulseScale);
    const worried = s.isPlayer && playerNearDanger();
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(s.angle);
    drawHeadShape(s.headShape, size, s.palette.body);
    drawHeadFace(size, worried, s);
    ctx.restore();
  }

  function drawHeadShape(shape, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    if (shape === "viper") {
      ctx.moveTo(r * 1.22, 0);
      ctx.quadraticCurveTo(r * 0.2, -r * 0.95, -r * 0.8, -r * 0.62);
      ctx.quadraticCurveTo(-r * 1.05, 0, -r * 0.8, r * 0.62);
      ctx.quadraticCurveTo(r * 0.2, r * 0.95, r * 1.22, 0);
    } else if (shape === "cobra") {
      ctx.moveTo(r * 1.05, 0);
      ctx.quadraticCurveTo(r * 0.45, -r * 1.18, -r * 0.72, -r * 0.92);
      ctx.quadraticCurveTo(-r * 1.16, -r * 0.28, -r * 0.78, 0);
      ctx.quadraticCurveTo(-r * 1.16, r * 0.28, -r * 0.72, r * 0.92);
      ctx.quadraticCurveTo(r * 0.45, r * 1.18, r * 1.05, 0);
    } else if (shape === "diamond") {
      ctx.moveTo(r * 1.08, 0);
      ctx.lineTo(0, -r * 0.98);
      ctx.lineTo(-r * 0.98, 0);
      ctx.lineTo(0, r * 0.98);
      ctx.closePath();
    } else if (shape === "square") {
      roundedHeadRect(-r * 0.92, -r * 0.82, r * 1.86, r * 1.64, r * 0.34);
    } else {
      ctx.arc(0, 0, r, 0, TWO_PI);
    }
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.ellipse(r * 0.15, -r * 0.32, r * 0.48, r * 0.18, -0.25, 0, TWO_PI);
    ctx.fill();
  }

  function roundedHeadRect(x, y, w, h, radius) {
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
  }

  function drawHeadFace(r, worried, s) {
    const blink = !reducedMotion && Math.sin(frameMs * 0.004 + (s.name || "").length) > 0.965;
    for (let sign = -1; sign <= 1; sign += 2) {
      const x = r * 0.32;
      const y = sign * r * 0.36;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.22, blink ? r * 0.035 : r * 0.29, 0, 0, TWO_PI);
      ctx.fill();
      if (!blink) {
        ctx.fillStyle = "#05121a";
        ctx.beginPath();
        ctx.arc(x + r * 0.07, y, r * 0.12, 0, TWO_PI);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath();
        ctx.arc(x + r * 0.11, y - r * 0.07, r * 0.045, 0, TWO_PI);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(255,130,168,0.32)";
      ctx.beginPath();
      ctx.arc(-r * 0.05, sign * r * 0.58, r * 0.13, 0, TWO_PI);
      ctx.fill();
    }

    ctx.strokeStyle = "#05121a";
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.lineCap = "round";
    ctx.beginPath();
    if (worried) ctx.arc(r * 0.56, 0, r * 0.18, Math.PI * 1.12, Math.PI * 1.88);
    else ctx.arc(r * 0.52, 0, r * 0.2, Math.PI * 0.12, Math.PI * 0.88);
    ctx.stroke();
  }

  function playerNearDanger() {
    if (!player || !player.alive) return false;
    if (WORLD_RADIUS - Math.hypot(player.x, player.y) < 280) return true;
    for (const s of snakes) {
      if (s === player || !s.alive || s.mass <= player.mass * 1.08) continue;
      if ((s.x - player.x) ** 2 + (s.y - player.y) ** 2 < 260 * 260) return true;
    }
    return false;
  }

  function drawParticles() {
    for (const p of particles) {
      const s = worldToScreen(p.x, p.y);
      if (s.x < -16 || s.x > cw + 16 || s.y < -16 || s.y > ch + 16) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, p.r * camera.scale, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawEffects() {
    for (const e of effects) {
      const t = clamp(e.age / e.life, 0, 1);
      const alpha = 1 - t;
      ctx.save();
      if (e.kind === "ring") {
        const s = worldToScreen(e.x, e.y);
        const r = (e.r0 + (e.r1 - e.r0) * easeOut(t)) * camera.scale;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = Math.max(2, e.width * camera.scale + 5);
        ctx.globalAlpha = alpha * 0.18;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, TWO_PI);
        ctx.stroke();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = Math.max(1, e.width * camera.scale);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, TWO_PI);
        ctx.stroke();
      } else if (e.kind === "text") {
        const s = worldToScreen(e.x, e.y - e.rise * t);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = e.color;
        ctx.font = `bold ${Math.max(isPhone ? 9 : 13, (isPhone ? 12 : 18) * camera.scale)}px "Press Start 2P", "Courier New", monospace`;
        ctx.textAlign = "center";
        ctx.strokeStyle = "rgba(3, 6, 9, 0.7)";
        ctx.lineWidth = 3;
        ctx.strokeText(e.text, s.x, s.y);
        ctx.fillText(e.text, s.x, s.y);
      } else if (e.kind === "debris") {
        const s = worldToScreen(e.x, e.y);
        const r = Math.max(1.5, e.r * camera.scale * (1 - t * 0.35));
        if (s.x < -r || s.x > cw + r || s.y < -r || s.y > ch + r) {
          ctx.restore();
          continue;
        }
        drawGlowSprite(s.x, s.y, r * 2.6, e.color, alpha * 0.34);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, TWO_PI);
        ctx.fill();
      } else if (e.kind === "spark") {
        const s = worldToScreen(e.x, e.y);
        const r = Math.max(2, e.r * camera.scale * (1 - t * 0.22));
        if (s.x < -r || s.x > cw + r || s.y < -r || s.y > ch + r) {
          ctx.restore();
          continue;
        }
        ctx.translate(s.x, s.y);
        ctx.rotate((e.rot || 0) + (e.spin || 0) * e.age);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = e.color;
        drawStar(0, 0, r, r * 0.45, 5);
      } else if (e.kind === "heart") {
        const s = worldToScreen(e.x, e.y);
        const r = Math.max(3, e.r * camera.scale * (1 - t * 0.18));
        if (s.x < -r || s.x > cw + r || s.y < -r || s.y > ch + r) {
          ctx.restore();
          continue;
        }
        ctx.translate(s.x, s.y);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = e.color;
        drawHeart(0, 0, r);
      } else if (e.kind === "flash") {
        const s = worldToScreen(e.x, e.y);
        const r = e.r * camera.scale * (1 + t * 0.8);
        ctx.globalAlpha = alpha * 0.45;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, TWO_PI);
        ctx.fill();
      } else if (e.kind === "fly") {
        const from = worldToScreen(e.x, e.y);
        const toX = e.toX;
        const toY = e.toY;
        const k = easeOut(t);
        const x = from.x + (toX - from.x) * k;
        const y = from.y + (toY - from.y) * k;
        drawGlowSprite(x, y, Math.max(12, e.r * 2.6), e.color, alpha * 0.48);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(5, e.r * (1 - t * 0.4)), 0, TWO_PI);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ---- HUD ----------------------------------------------------------------
  function updateHud() {
    // Read the capability query once per call, then skip the desktop-only surfaces
    // on phones. This runs ~6.7x/s and was rebuilding a 5-row innerHTML leaders
    // list, the kill feed and document.title inside elements that are display:none
    // under the phone media query.
    const phoneLayout = isPhoneLayout();
    const scoreEl = document.getElementById("arenaScore");
    const mobileScoreEl = document.getElementById("arenaMobileScore");
    const rankEl = document.getElementById("arenaRanks");
    const scoreText = String(Math.round(player.score));
    if (scoreEl) scoreEl.textContent = scoreText;
    if (mobileScoreEl) {
      const formattedScore = Math.round(player.score).toLocaleString("en-GB");
      const scoreLength = Array.from(formattedScore).length;
      const scoreWidth = scoreLength <= 3 ? 84 : scoreLength === 4 ? 108 : 120;
      mobileScoreEl.textContent = formattedScore;
      mobileScoreEl.setAttribute("aria-label", `Score ${formattedScore}`);
      mobileScoreEl.style.fontSize = scoreLength <= 5 ? "20px" : scoreLength === 6 ? "16px" : "14px";
      mobileScoreEl.parentElement?.style.setProperty("--arena-score-width", `${scoreWidth}px`);
    }

    const effEl = document.getElementById("arenaEffects");
    const activeEffects = [];
    for (const key of Object.keys(EFFECT_HUD)) {
      if (player.effects[key] > 0) activeEffects.push(key);
    }
    if (effEl) {
      effEl.textContent = activeEffects
        .map((key) => `${ITEM_LABEL[key]} ${player.effects[key].toFixed(1)}s`)
        .join("   ");
    }
    renderPowerupPills(activeEffects.slice(0, 4));

    const ammoEl = document.getElementById("arenaAmmo");
    if (ammoEl) ammoEl.textContent = String(missileAmmo);
    const fireBtn = document.getElementById("arenaFireBtn");
    const fireBadge = document.getElementById("arenaFireAmmo");
    const fireReady = missileAmmo > 0;
    if (fireBtn) {
      if (fireReady && !fireWasReady) {
        fireBtn.hidden = false;
        fireBtn.classList.add("ammo-ready");
        setTimeout(() => fireBtn.classList.remove("ammo-ready"), 150);
      } else {
        fireBtn.hidden = !fireReady;
      }
      fireBtn.setAttribute("aria-label", fireReady
        ? `Fire rocket, ${missileAmmo} remaining`
        : "Fire rocket, no ammunition");
      if (!fireReady) {
        fireBtn.classList.remove("active");
        fireBtn.setAttribute("aria-pressed", "false");
      }
    }
    if (fireBadge) fireBadge.textContent = String(missileAmmo);
    fireWasReady = fireReady;

    const boostBtn = document.getElementById("arenaBoostBtn");
    if (boostBtn) {
      const boostAvailable = player.alive && player.mass > 5;
      boostBtn.setAttribute("aria-disabled", boostAvailable ? "false" : "true");
      boostBtn.setAttribute("aria-pressed", boosting && boostAvailable ? "true" : "false");
      if (!boostAvailable) boostBtn.classList.remove("active");
    }

    const comboEl = document.getElementById("arenaCombo");
    if (comboEl) {
      comboEl.textContent = comboCount > 0
        ? `Combo ${comboCount}  ×${comboMultiplier.toFixed(2)}  ${comboTimer.toFixed(1)}s`
        : "";
    }
    const comboTrack = document.getElementById("arenaComboTrack");
    const comboBar = document.getElementById("arenaComboBar");
    if (comboTrack) comboTrack.hidden = comboTimer <= 0;
    if (comboBar) comboBar.style.width = `${clamp(comboTimer / COMBO_WINDOW, 0, 1) * 100}%`;
    const biomeEl = document.getElementById("arenaBiome");
    if (biomeEl && player.alive && !phoneLayout) biomeEl.textContent = biomeAt(player.x, player.y);
    const objEl = document.getElementById("arenaObjective");
    if (objEl && objective && !phoneLayout) {
      objEl.textContent = `Goal: ${objective.text} (${Math.min(objective.progress, objective.target)}/${objective.target})`;
    }

    // Rank by the same metric the chip 288px to the left displays. It used to sort
    // by mass while sitting beside a score chip - two different numbers, neither
    // labelled. "Ranked by mass, not score" was one of the spec's own reasons for
    // deleting the leaders panel; the chip had inherited it.
    const ranked = snakes.filter((s) => s.alive)
      .slice()
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const rankChip = document.getElementById("arenaRankChip");
    if (rankChip) {
      const playerRank = ranked.findIndex((s) => s.isPlayer);
      // Show the field size too: a bare "#20" at spawn reads as a scoreboard
      // position out of nothing, which is demotivating and uninterpretable.
      rankChip.textContent = playerRank >= 0 ? `${playerRank + 1}/${ranked.length}` : "--";
      rankChip.setAttribute("aria-label", playerRank >= 0
        ? `Rank ${playerRank + 1} of ${ranked.length}`
        : "Current rank unavailable");
      if (lastPlayerRank !== null && playerRank >= 0 && playerRank < lastPlayerRank && !reducedMotion) {
        rankChip.classList.remove("improved");
        void rankChip.offsetWidth;
        rankChip.classList.add("improved");
        clearTimeout(rankFlashTimer);
        rankFlashTimer = setTimeout(() => rankChip.classList.remove("improved"), 250);
      }
      lastPlayerRank = playerRank >= 0 ? playerRank : null;
    }

    if (rankEl && !phoneLayout) {
      const top = ranked.slice(0, 5);
      rankEl.innerHTML = top.map((s, idx) => {
        const me = s.isPlayer ? " arena-me" : "";
        return `<li class="arena-rank${me}"><span class="arena-rank-pos">${idx + 1}</span>` +
          `<span class="arena-dot"></span>` +
          `<span class="arena-rank-name">${escapeHtml(s.name)}</span>` +
          // Show the value the list is now sorted by. It displayed mass while
          // sorting by mass; sorting by score and still printing mass made the
          // desktop leaders board read out of order (22, 29, 23, 21, 25).
          `<span class="arena-rank-score">${Math.round(s.score || 0)}</span></li>`;
      }).join("");
      rankEl.querySelectorAll(".arena-dot").forEach((dot, idx) => {
        dot.style.setProperty("--arena-dot", top[idx]?.palette?.body || "#46f2a4");
      });
    }
    if (!phoneLayout) {
      document.title = player.alive
        ? `Arena: ${Math.round(player.mass)} - ${biomeAt(player.x, player.y)}`
        : "Arena - Respawn";
      renderFeed();
    }
  }

  function renderPowerupPills(activeEffects) {
    const container = document.getElementById("arenaPowerups");
    if (!container) return;
    const fragment = document.createDocumentFragment();
    for (const key of activeEffects) {
      const meta = EFFECT_HUD[key];
      const remaining = player.effects[key];
      const pill = document.createElement("span");
      pill.className = "arena-powerup-pill";
      pill.textContent = meta.code;
      pill.setAttribute("role", "img");
      pill.setAttribute("aria-label", `${ITEM_LABEL[key]}, ${remaining.toFixed(1)} seconds remaining`);
      pill.style.setProperty("--effect-progress", `${clamp(remaining / meta.duration, 0, 1) * 100}%`);
      fragment.appendChild(pill);
    }
    container.replaceChildren(fragment);
  }

  // The top score, kept from the last leaderboard fetch. A held (signed-out) run
  // never reaches the server, so there is no response to learn it from.
  let latestArenaTop = 0;

  async function fetchArenaLeaderboard() {
    const el = document.getElementById("arenaBest");
    if (!el) return;
    try {
      const response = await fetch("/arena/leaderboard?mode=arena&limit=10", {
        credentials: "same-origin"
      });
      const rows = await response.json().catch(() => []);
      if (!response.ok || !Array.isArray(rows)) throw new Error("Invalid leaderboard response");
      latestArenaTop = rows.length && Number.isFinite(Number(rows[0].score))
        ? Number(rows[0].score)
        : latestArenaTop;
      renderArenaLeaderboard(el, rows);
    } catch {
      renderArenaLeaderboard(el, []);
    }
  }

  function renderArenaLeaderboard(el, rows) {
    el.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "arena-rank";
      const label = document.createElement("span");
      label.className = "arena-rank-name";
      label.textContent = "No scores yet";
      empty.appendChild(label);
      el.appendChild(empty);
      return;
    }

    rows.forEach((row, index) => {
      const item = document.createElement("li");
      item.className = "arena-rank";
      const position = document.createElement("span");
      position.className = "arena-rank-pos";
      position.textContent = String(index + 1);
      const name = document.createElement("span");
      name.className = "arena-rank-name";
      name.textContent = String(row.name || "Player");
      const score = document.createElement("span");
      score.className = "arena-rank-score";
      score.textContent = Number.isInteger(row.score) ? row.score.toLocaleString("en-GB") : "—";
      item.append(position, name, score);
      el.appendChild(item);
    });
  }

  function cancelArenaScoreRun() {
    if (arenaScoreRun && window.SnakeRunScores) {
      window.SnakeRunScores.cancel(arenaScoreRun);
    }
    arenaScoreRun = null;
  }

  async function submitArenaScore(score, run) {
    const bestEl = document.getElementById("arenaDeathBest");
    const noticeEl = document.getElementById("arenaScoreNotice");
    if (!run || !window.SnakeRunScores) {
      if (noticeEl && score > 0) noticeEl.textContent = "Score not saved.";
      return;
    }

    // Only a score that beats the player's own stored best is submitted
    // (ADR-005), so restart churn never hits the submission rate limiter.
    const storedBest = window.SnakeBests ? window.SnakeBests.get("arena") : 0;
    if (score > 0 && score <= storedBest) {
      if (bestEl) bestEl.textContent = "Your best " + formatServerScore(storedBest) + " stands";
      if (noticeEl) noticeEl.textContent = "Beat your best to save a new score.";
      return;
    }
    const initials = window.SnakeInitials ? window.SnakeInitials() : "";
    if (score > 0 && !initials) {
      if (noticeEl) noticeEl.textContent = "Set 3 leaderboard initials on the menu to save scores.";
      return;
    }

    // Signed out: hold the run rather than spending its token on a submission the
    // server will validate and then deliberately not record. Redeemed for real if
    // the player signs in within the token's 30 minutes.
    const signedIn = window.SnakeAuth ? window.SnakeAuth.isLoggedIn() : false;
    if (!signedIn) {
      const held = await window.SnakeRunScores.holdRun(run, { name: initials || "XXX", score });
      if (held && window.SnakeBests) window.SnakeBests.update("arena", score);
      if (displayedDeathRun !== run) return;
      if (bestEl) {
        const top = latestArenaTop;
        if (held && top && score > top) {
          bestEl.textContent = "You beat the top score with " + formatServerScore(score) +
            " · sign in to keep it";
          bestEl.classList.add("record");
          showToast("Sign in to keep that score");
          sound.power();
        } else if (held) {
          bestEl.textContent = "Score " + formatServerScore(score) + " · sign in to keep it";
        } else if (top) {
          bestEl.textContent = "Top score " + formatServerScore(top);
        }
      }
      if (noticeEl && held) noticeEl.textContent = "Sign in and this run is saved automatically.";
      return;
    }

    const result = await window.SnakeRunScores.submit(run, { name: initials || "XXX", score });
    // Raise the stored best only once the server has accepted the run, so a run that
    // was never saved cannot block a later, better-than-saved score.
    if (result.ok && !result.skipped && window.SnakeBests) {
      window.SnakeBests.update("arena", result.data && result.data.loggedIn ? result.data.best : score);
    }
    if (displayedDeathRun !== run) return;

    if (result.ok) {
      if (noticeEl) noticeEl.textContent = "";
      if (result.skipped) return;
      const data = result.data;
      fetchArenaLeaderboard();
      if (window.refreshBestLine) window.refreshBestLine();
      if (!bestEl) return;
      bestEl.classList.remove("record");
      if (data.globalBest) {
        bestEl.textContent = "New top score " + formatServerScore(data.globalTop);
        bestEl.classList.add("record");
        showToast("New top score");
        sound.power();
      } else if (data.personalBest) {
        bestEl.textContent = "Personal best " + formatServerScore(data.best);
        showToast("Personal best");
        sound.power();
      } else if (data.loggedIn) {
        bestEl.textContent = "Your best " + formatServerScore(data.best) +
          " · Top score " + formatServerScore(data.globalTop);
      } else if (data.globalTop) {
        // A signed-out player who has just BEATEN the record used to be shown the
        // very score they beat, with no acknowledgement of it — which reads as if
        // nothing happened. A play-tester hit exactly this and was, fairly, annoyed.
        // The server does not store anonymous scores, so it reports globalBest:false
        // and returns the previous top; the comparison has to happen here.
        if (score > data.globalTop) {
          bestEl.textContent = "You beat the top score with " + formatServerScore(score) +
            " · sign in to save it";
          bestEl.classList.add("record");
          showToast("Sign in to keep that score");
          sound.power();
        } else {
          bestEl.textContent = "Top score " + formatServerScore(data.globalTop) +
            " · Sign in to save yours";
        }
      } else {
        bestEl.textContent = "";
      }
      return;
    }

    if (noticeEl) {
      const detail = result.data && result.data.error ? ` ${result.data.error}` : "";
      noticeEl.textContent = result.status === 429
        ? "Score save paused. Try another run shortly."
        : `Score not saved.${detail}`;
    }
  }

  function formatServerScore(value) {
    return Number.isInteger(value) && value >= 0 ? value.toLocaleString("en-GB") : "—";
  }

  function showDeath(score, reason, stats) {
    // One overlay slot: the result wins over the tutorial and the pause card.
    const hintEl = document.getElementById("arenaHint");
    if (hintEl) hintEl.hidden = true;
    hidePause();
    const overlay = document.getElementById("arenaDeath");
    const scoreEl = document.getElementById("arenaDeathScore");
    const reasonEl = document.getElementById("arenaDeathReason");
    const playerEl = document.getElementById("arenaDeathPlayer");
    const lengthEl = document.getElementById("arenaDeathLength");
    const timeEl = document.getElementById("arenaDeathTime");
    const comboEl = document.getElementById("arenaDeathCombo");
    const noticeEl = document.getElementById("arenaScoreNotice");
    if (scoreEl) scoreEl.textContent = String(score);
    if (reasonEl) reasonEl.textContent = reason ? "Cause: " + reason : "";
    if (playerEl) playerEl.textContent = playerName;
    if (lengthEl) lengthEl.textContent = String(stats?.length || 0);
    if (timeEl) timeEl.textContent = formatDuration(stats?.durationMs || 0);
    if (comboEl) comboEl.textContent = String(stats?.combo || 0);
    if (noticeEl) noticeEl.textContent = score > 0 ? "Saving score…" : "";
    const bestEl = document.getElementById("arenaDeathBest");
    if (bestEl) { bestEl.textContent = ""; bestEl.classList.remove("record"); }
    if (overlay) {
      overlay.hidden = false;
      setArenaDialogState(true);
      requestAnimationFrame(() => document.getElementById("arenaRespawn")?.focus());
    }
    if (root) root.classList.add("show-cursor"); // restore the mouse on death
  }

  function hideDeath(focusCanvas) {
    const overlay = document.getElementById("arenaDeath");
    if (overlay) overlay.hidden = true;
    setArenaDialogState(anyArenaOverlayOpen());
    if (root && !anyArenaOverlayOpen()) root.classList.remove("show-cursor");
    if (focusCanvas && canvas) canvas.focus({ preventScroll: true });
  }

  // The pause card shares the single overlay slot with the tutorial and the
  // result dialog; only one is ever visible at a time.
  function setPaused(next) {
    if (next && (!running || !player || !player.alive)) return;
    if (next === paused) return;
    paused = next;
    const pauseBtn = document.getElementById("arenaPauseBtn");
    if (pauseBtn) pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
    const overlay = document.getElementById("arenaPause");
    if (paused) {
      keys.left = false;
      keys.right = false;
      boosting = false;
      joystick.active = false;
      joystick.id = null;
      document.getElementById("arenaBoostBtn")?.classList.remove("active");
      document.getElementById("arenaBoostBtn")?.setAttribute("aria-pressed", "false");
      document.getElementById("arenaFireBtn")?.classList.remove("active");
      document.getElementById("arenaFireBtn")?.setAttribute("aria-pressed", "false");
      document.querySelectorAll(".arena-arrow-btn.active").forEach((button) => button.classList.remove("active"));
      syncSettingsControls();
      const hintEl = document.getElementById("arenaHint");
      if (hintEl) hintEl.hidden = true;
      const playerEl = document.getElementById("arenaPausePlayer");
      if (playerEl) playerEl.textContent = playerName;
      const quitBtn = document.getElementById("arenaQuitBtn");
      if (quitBtn) {
        quitBtn.classList.remove("confirming");
        quitBtn.textContent = "Quit to menu";
      }
      if (overlay) overlay.hidden = false;
      setArenaDialogState(true);
      sound.stopAmbient();
      if (root) root.classList.add("show-cursor");
      requestAnimationFrame(() => document.getElementById("arenaResumeBtn")?.focus());
    } else {
      hidePause();
      if (running && soundOn) sound.startAmbient(env.name, weather);
    }
  }

  function hidePause() {
    paused = false;
    const pauseBtn = document.getElementById("arenaPauseBtn");
    if (pauseBtn) pauseBtn.setAttribute("aria-pressed", "false");
    const overlay = document.getElementById("arenaPause");
    if (overlay) overlay.hidden = true;
    setArenaDialogState(anyArenaOverlayOpen());
    if (root && !anyArenaOverlayOpen()) root.classList.remove("show-cursor");
  }

  function anyArenaOverlayOpen() {
    const death = document.getElementById("arenaDeath");
    const pause = document.getElementById("arenaPause");
    return Boolean((death && !death.hidden) || (pause && !pause.hidden));
  }

  function setArenaDialogState(open) {
    if (!root) return;
    const slot = document.getElementById("arenaOverlaySlot");
    Array.from(root.children).forEach((child) => {
      if (child !== slot) child.inert = open;
    });
  }

  function formatDuration(durationMs) {
    const seconds = Math.max(0, Math.floor(durationMs / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes + ":" + String(seconds % 60).padStart(2, "0");
  }

  function addFeed(text, color) {
    feed.unshift({ text, color, age: performance.now() });
    feed = feed.slice(0, 5);
    renderFeed();
  }

  function renderFeed() {
    const el = document.getElementById("arenaFeed");
    if (!el) return;
    const now = performance.now();
    feed = feed.filter((item) => now - item.age < 6500);
    el.innerHTML = feed.map((item) => (
      `<div class="arena-feed-item">${escapeHtml(item.text)}</div>`
    )).join("");
    el.querySelectorAll(".arena-feed-item").forEach((node, idx) => {
      node.style.setProperty("--event-color", feed[idx]?.color || "#edf7ff");
    });
  }

  function respawn() {
    cancelArenaScoreRun();
    arenaScoreRun = window.SnakeRunScores ? window.SnakeRunScores.begin("arena") : null;
    displayedDeathRun = null;
    // Drop the old dead snake(s) so they do not accumulate across respawns.
    snakes = snakes.filter((s) => s.alive);
    missileAmmo = 0;
    projectiles = [];
    boosting = false;
    effects = [];
    screenShake = 0;
    headPulse = 0;
    resetCombo();
    comboBest = 0;
    lastDeathReason = "";
    lastPlayerRank = null;
    fireWasReady = false;
    // Fresh world each life: new biome + weather so a respawn feels like a new
    // run (also rebuilds the cached scenery/sky for the new environment).
    pickEnvironment();
    difficultyStart = performance.now();
    player = makeSnake({ isPlayer: true, name: playerName, palette: playerPalette, headShape: playerHeadShape });
    snakes.push(player);
    camera.x = player.x;
    camera.y = player.y;
    addRing(player.x, player.y, player.palette.glow, 12, 120, 0.55, 3);
    spawnSparkles(player.x, player.y, player.palette.glow, 12, 130);
    spawnHeartPops(player.x, player.y, player.palette.body, 3);
    addFloatingText(player.x, player.y, "READY", player.palette.glow);
    headPulse = 0.32;
    hideDeath(true);
    sound.resume();
    if (soundOn) sound.startAmbient(env.name, weather);
    resetToastQueue();
    announceEnvironment();
  }

  // ---- DOM / wiring -------------------------------------------------------
  function ensureDom() {
    root = document.getElementById("arenaRoot");
    canvas = document.getElementById("arenaCanvas");
    // Use the DEFAULT 2D context. A low-latency presentation hint was tried and
    // removed because it caused heavy flicker on Chrome. rAF already gives smooth,
    // tear-free vsync, so no special context flags are needed.
    ctx = canvas.getContext("2d");

    if (root.dataset.wired === "1") return;
    root.dataset.wired = "1";

    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
      usingTouch = false;
      // Moving the mouse hands control back to the mouse — but only when no
      // steering key is held, so the keyboard stays in charge while in use.
      if (!keys.left && !keys.right) controlMode = "mouse";
    });

    // Left mouse click fires a rocket (toward the cursor).
    canvas.addEventListener("mousedown", (e) => { if (e.button === 0) fireMissile(); });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Mobile: the canvas is a virtual steering joystick. A drag may begin
    // anywhere on the canvas; DOM controls above it own their own touch starts.
    // The steering finger is tracked by identifier so a second touch (a button)
    // can never hijack it.
    canvas.addEventListener("touchstart", (e) => {
      if (touchControl === "arrows") return; // arrows mode steers via buttons, not drag
      if (joystick.id !== null) return;
      const rect = canvas.getBoundingClientRect();
      for (const t of e.changedTouches) {
        joystick.id = t.identifier;
        joystick.active = true;
        usingTouch = true;
        joystick.baseX = joystick.x = t.clientX - rect.left;
        joystick.baseY = joystick.y = t.clientY - rect.top;
        e.preventDefault();
        break;
      }
    }, { passive: false });
    canvas.addEventListener("touchmove", (e) => {
      if (joystick.id === null) return;
      const rect = canvas.getBoundingClientRect();
      for (const t of e.changedTouches) {
        if (t.identifier !== joystick.id) continue;
        joystick.x = t.clientX - rect.left;
        joystick.y = t.clientY - rect.top;
        e.preventDefault();
        break;
      }
    }, { passive: false });
    // Lifting the steering finger only ends steering; boost is held via its own
    // button and must not be cancelled here.
    const endTouch = (e) => {
      if (e && e.changedTouches) {
        for (const t of e.changedTouches) {
          if (t.identifier === joystick.id) { joystick.active = false; joystick.id = null; break; }
        }
      } else {
        joystick.active = false;
        joystick.id = null;
      }
    };
    canvas.addEventListener("touchend", endTouch, { passive: false });
    canvas.addEventListener("touchcancel", endTouch, { passive: false });

    // Dedicated mobile BOOST (hold) and FIRE (tap) buttons.
    const boostBtn = document.getElementById("arenaBoostBtn");
    if (boostBtn) {
      const startBoost = (e) => {
        if (e) e.preventDefault();
        if (!player || !player.alive || player.mass <= 5 || paused) return;
        boosting = true;
        boostBtn.classList.add("active");
        boostBtn.setAttribute("aria-pressed", "true");
      };
      const stopBoost = (e) => {
        if (e) e.preventDefault();
        boosting = false;
        boostBtn.classList.remove("active");
        boostBtn.setAttribute("aria-pressed", "false");
      };
      boostBtn.addEventListener("touchstart", startBoost, { passive: false });
      boostBtn.addEventListener("touchend", stopBoost, { passive: false });
      boostBtn.addEventListener("touchcancel", stopBoost, { passive: false });
      boostBtn.addEventListener("mousedown", startBoost);
      boostBtn.addEventListener("mouseup", stopBoost);
      boostBtn.addEventListener("mouseleave", stopBoost);
      // These are real <button>s in the tab order, so a screen-reader double-tap
      // (which dispatches click, not touchstart) and Enter/Space have to work.
      // Hold semantics do not survive a click, so give it a short timed pulse.
      // detail === 0 means keyboard or assistive tech: a real touch or mouse press
      // also emits a click, and without this guard every ordinary tap on BOOST
      // bought an extra 600ms of boost after the player had already let go.
      boostBtn.addEventListener("click", (e) => {
        if (!e || e.detail !== 0) return;
        e.preventDefault();
        if (boosting) return;   // a real hold is already in progress
        startBoost();
        setTimeout(stopBoost, 600);
      });
    }
    const fireBtn = document.getElementById("arenaFireBtn");
    if (fireBtn) {
      const doFire = (e) => {
        if (e) e.preventDefault();
        usingTouch = true;
        fireBtn.classList.add("active");
        fireBtn.setAttribute("aria-pressed", "true");
        fireMissile();
        setTimeout(() => {
          fireBtn.classList.remove("active");
          fireBtn.setAttribute("aria-pressed", "false");
        }, 100);
      };
      fireBtn.addEventListener("touchstart", doFire, { passive: false });
      fireBtn.addEventListener("mousedown", doFire);
      // mousedown does not fire for an assistive-technology activation; click does.
      fireBtn.addEventListener("click", (e) => {
        if (e && e.detail === 0) doFire(e);   // detail 0 = keyboard / AT, not a real mouse
      });
    }

    // Optional on-screen turn arrows (an alternative to the drag joystick).
    const bindArrow = (btn, side) => {
      if (!btn) return;
      const press = (e) => { if (e) e.preventDefault(); keys[side] = true; controlMode = "keys"; usingTouch = true; btn.classList.add("active"); };
      const release = (e) => { if (e) e.preventDefault(); keys[side] = false; btn.classList.remove("active"); };
      btn.addEventListener("touchstart", press, { passive: false });
      btn.addEventListener("touchend", release, { passive: false });
      btn.addEventListener("touchcancel", release, { passive: false });
      btn.addEventListener("mousedown", press);
      btn.addEventListener("mouseup", release);
      btn.addEventListener("mouseleave", release);
      btn.addEventListener("click", (e) => {
        if (e && e.detail !== 0) return;      // real mouse already handled above
        e.preventDefault();
        press();
        setTimeout(release, 220);
      });
    };
    bindArrow(document.getElementById("arenaLeftBtn"), "left");
    bindArrow(document.getElementById("arenaRightBtn"), "right");

    // Keyboard: A/D or Left/Right to steer; W/Up (or Shift) to boost forward.
    // Esc or P pauses; while paused, steering input is ignored.
    window.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target)) return;
      if (!running) return;
      if (e.code === "Escape" || e.code === "KeyP") {
        const deathOpen = !document.getElementById("arenaDeath")?.hidden;
        if (!deathOpen && player && player.alive) {
          e.preventDefault();
          setPaused(!paused);
        }
        return;
      }
      if (paused) return;
      if (e.code === "ArrowLeft" || e.code === "KeyA") { keys.left = true; controlMode = "keys"; e.preventDefault(); }
      if (e.code === "ArrowRight" || e.code === "KeyD") { keys.right = true; controlMode = "keys"; e.preventDefault(); }
      if (e.code === "KeyW" || e.code === "ArrowUp" || e.code === "ShiftLeft" || e.code === "ShiftRight") { boosting = true; e.preventDefault(); }
    });
    window.addEventListener("keyup", (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.code === "ArrowLeft" || e.code === "KeyA") keys.left = false;
      if (e.code === "ArrowRight" || e.code === "KeyD") keys.right = false;
      if (e.code === "KeyW" || e.code === "ArrowUp" || e.code === "ShiftLeft" || e.code === "ShiftRight") boosting = false;
    });

    // Pause lives on the top-centre rail button and on Esc/P. DOM hit testing
    // keeps it separate from canvas steering. Quitting a live run goes through
    // the pause overlay with a two-tap confirm, so a mis-grab cannot end a run.
    const pauseBtn = document.getElementById("arenaPauseBtn");
    if (pauseBtn) pauseBtn.addEventListener("click", () => setPaused(!paused));
    const resumeBtn = document.getElementById("arenaResumeBtn");
    if (resumeBtn) resumeBtn.addEventListener("click", () => setPaused(false));
    const restartRunBtn = document.getElementById("arenaRestartRunBtn");
    if (restartRunBtn) restartRunBtn.addEventListener("click", () => { setPaused(false); respawn(); });
    const quitBtn = document.getElementById("arenaQuitBtn");
    if (quitBtn) {
      // Armed state lives in the DOM (the "confirming" class): setPaused already
      // clears it when the pause card opens, so a fresh pause always needs a
      // fresh confirm. quitArmedAt only bounds how long the arm lasts.
      let quitArmedAt = 0;
      quitBtn.addEventListener("click", () => {
        const now = performance.now();
        if (quitBtn.classList.contains("confirming") && now - quitArmedAt < 3000) {
          quitArmedAt = 0;
          quitBtn.classList.remove("confirming");
          quitBtn.textContent = "Quit to menu";
          setPaused(false);
          stop();
          document.body.classList.remove("is-playing");
          if (window.refreshBestLine) window.refreshBestLine();
          return;
        }
        quitArmedAt = now;
        quitBtn.classList.add("confirming");
        quitBtn.textContent = "Tap again to quit";
        setTimeout(() => {
          if (quitBtn.classList.contains("confirming") && performance.now() - quitArmedAt >= 2900) {
            quitArmedAt = 0;
            quitBtn.classList.remove("confirming");
            quitBtn.textContent = "Quit to menu";
          }
        }, 3000);
      });
    }
    const respawnBtn = document.getElementById("arenaRespawn");
    if (respawnBtn) respawnBtn.addEventListener("click", respawn);
    const exitDeadBtn = document.getElementById("arenaExitDead");
    if (exitDeadBtn) exitDeadBtn.addEventListener("click", () => { stop(); document.body.classList.remove("is-playing"); if (window.refreshBestLine) window.refreshBestLine(); });

    wireSetting("arenaSoundOn", "arenaSoundOn", (v) => {
      soundOn = v;
      sound.setMuted(!v);
      if (v && !paused) {
        sound.resume();
        sound.startAmbient(env.name, weather);
      }
    });
    wireSetting("arenaReducedMotion", "arenaReducedMotion", (v) => {
      reducedMotion = v;
      root.classList.toggle("arena-reduced-motion", reducedMotion);
    });

    // In-game phone-control switches (apply live).
    const tcSel = document.getElementById("arenaTouchControlSel");
    if (tcSel) {
      tcSel.addEventListener("change", () => {
        touchControl = tcSel.value === "arrows" ? "arrows" : "joystick";
        localStorage.setItem("arenaTouchControl", touchControl);
        root.classList.toggle("arrows-mode", touchControl === "arrows");
        joystick.active = false;
        joystick.id = null;
      });
    }
    const lhToggle = document.getElementById("arenaLeftHandedToggle");
    if (lhToggle) {
      lhToggle.addEventListener("change", () => {
        leftHanded = lhToggle.checked;
        localStorage.setItem("arenaLeftHanded", leftHanded ? "true" : "false");
        root.classList.toggle("arena-left", leftHanded);
      });
    }
    const hintDismiss = document.getElementById("arenaHintDismiss");
    if (hintDismiss) {
      hintDismiss.addEventListener("click", () => {
        localStorage.setItem("arenaControlsSeen", "true");
        const hint = document.getElementById("arenaHint");
        if (hint) hint.hidden = true;
      });
    }

    // Coalesce resize into one rAF. Each resize() reallocates the main canvas
    // (900x2000x4 = 7.2 MB) and rebuilds a 2560x2560 scenery canvas, and a phone
    // showing or hiding its URL bar fires this continuously. Measured 2026-08-14:
    // 30 events cost 77.2 ms, 72.5 ms of it rebuilding scenery. Same pending-flag
    // shape client.js already uses for classicResizePending.
    let resizePending = false;
    window.addEventListener("resize", () => {
      if (!running || resizePending) return;
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        if (running) resize();
      });
    });
  }

  function resize() {
    const deviceDpr = window.devicePixelRatio || 1;
    const quality = currentQuality();
    dpr = Number.isFinite(quality.dprCap) ? Math.min(quality.dprCap, deviceDpr) : deviceDpr;
    cw = root.clientWidth;
    ch = root.clientHeight;
    // Smaller screens (phones) zoom out more for a wider, less cramped view.
    isPhone = Math.min(cw, ch) <= 540;
    zoomFactor = isPhone ? 0.78 : 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    // Smoothing ON for every tier so even Low looks crisp (never pixelated).
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = qualityTier === "low" ? "medium" : "high";
    pointer.x = cw / 2;
    pointer.y = ch / 2 - 1; // nudge so we have an initial heading
    rebuildStaticScenery();
  }

  // ---- Helpers ------------------------------------------------------------
  function randomFood() {
    const p = randomWorldPoint(WORLD_RADIUS * 0.97);
    const type = weightedFoodType();
    const def = FOOD_KINDS[type];
    return {
      x: p.x,
      y: p.y,
      type,
      shape: def.shape,
      label: def.label,
      r: def.r,
      mass: def.mass,
      color: def.color,
      phase: Math.random() * TWO_PI
    };
  }

  function weightedFoodType() {
    const entries = Object.entries(FOOD_KINDS);
    let total = 0;
    for (const [, d] of entries) total += d.weight;
    let roll = Math.random() * total;
    for (const [k, d] of entries) { roll -= d.weight; if (roll <= 0) return k; }
    return "berry";
  }

  function randomItem() {
    const type = weightedItemType();
    const def = ITEM_KINDS[type];
    const p = randomWorldPoint(WORLD_RADIUS * 0.95);
    return { x: p.x, y: p.y, type, r: def.r, color: def.color };
  }

  function weightedItemType() {
    const entries = Object.entries(ITEM_KINDS);
    let total = 0;
    for (const [, d] of entries) total += d.weight;
    let roll = Math.random() * total;
    for (const [k, d] of entries) { roll -= d.weight; if (roll <= 0) return k; }
    return "mega";
  }

  function randomWorldPoint(maxR) {
    const a = Math.random() * TWO_PI;
    const r = Math.sqrt(Math.random()) * maxR;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  function nextPerformanceRandom() {
    performanceRandomState = (performanceRandomState * 1664525 + 1013904223) >>> 0;
    return performanceRandomState / 0x100000000;
  }

  function biomeAt(x, y) {
    let found = null, best = Infinity;
    for (const b of BIOMES) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d < b.r && d < best) { best = d; found = b; }
    }
    return found ? found.name : "The Void";
  }

  function rgba(hex, a) {
    const v = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
  }

  // sqrt(dx*dx+dy*dy) rather than Math.hypot: this runs ~10,400 times a frame
  // (the trail trim and buildBody's resample), and hypot pays for overflow-safe
  // scaling and a varargs path we never need. World coords are bounded by
  // +/-2200 and per-frame deltas are a few px, so there is no overflow path.
  // Measured 2026-08-14: moveSnake 1.167 -> 0.754 ms/frame at CPU x4.
  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function easeOut(t) { return 1 - (1 - t) * (1 - t); }
  function isDangerItem(it) { return it && (it.type === "bomb" || it.type === "mushroom"); }
  function aliveBotCount() {
    let count = 0;
    for (const s of snakes) if (s.alive && !s.isPlayer) count += 1;
    return count;
  }
  function currentQuality() {
    return QUALITY_TIERS[qualityTier] || QUALITY_TIERS.balanced;
  }
  function normalizeHeadShape(value) {
    return HEAD_SHAPES[value] ? value : "round";
  }
  function randomHeadShape() {
    return HEAD_SHAPE_KEYS[Math.floor(Math.random() * HEAD_SHAPE_KEYS.length)] || "round";
  }
  function normalizeQualityTier(value) {
    return QUALITY_TIERS[value] ? value : "balanced";
  }
  function loadQualityPreference() {
    const saved = localStorage.getItem("arenaQuality");
    if (saved) {
      qualityUserOverride = true;
      setQualityTier(saved, false);
      return;
    }

    if (localStorage.getItem("arenaLowQuality") === "true") {
      qualityUserOverride = true;
      setQualityTier("low", false);
      return;
    }

    qualityUserOverride = false;
    setQualityTier("balanced", false);
  }
  function setQualityTier(value, persist) {
    qualityTier = normalizeQualityTier(value);
    if (persist) {
      qualityUserOverride = true;
      localStorage.setItem("arenaQuality", qualityTier);
      localStorage.removeItem("arenaLowQuality");
    }
  }
  function applyQualityTier(value, persist) {
    setQualityTier(value, persist);
    syncSettingsControls();
    if (running) {
      resize();
      pickEnvironment();
      if (soundOn) sound.startAmbient(env.name, weather);
      updateHud();
    }
  }
  function wireSetting(id, key, apply) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      localStorage.setItem(key, el.checked ? "true" : "false");
      apply(el.checked);
      updateHud();
    });
  }
  function syncSettingsControls() {
    const soundEl = document.getElementById("arenaSoundOn");
    const motion = document.getElementById("arenaReducedMotion");
    if (soundEl) soundEl.checked = soundOn;
    if (motion) motion.checked = reducedMotion;
    const tcSel = document.getElementById("arenaTouchControlSel");
    if (tcSel) tcSel.value = touchControl;
    const lhToggle = document.getElementById("arenaLeftHandedToggle");
    if (lhToggle) lhToggle.checked = leftHanded;
  }

  function maybeShowControlsHint() {
    const hint = document.getElementById("arenaHint");
    if (!hint) return;
    const runs = Number(localStorage.getItem("arenaControlsRuns") || 0);
    const seen = localStorage.getItem("arenaControlsSeen") === "true";
    if (isPhoneLayout()) {
      hint.hidden = true;
      // Phones get no persistent tutorial card (it covered both buttons it was
      // describing), so this message is the ONLY explanation of the touch model a
      // phone player ever gets. It used to be shown once and the "seen" flag was
      // written BEFORE it displayed, so missing it - mid-fade, during load, while
      // looking at the snake - meant never being told at all. Show it on the first
      // three runs, and only count a run once the message has actually been queued.
      if (!seen && runs < 3) {
        showToast("DRAG ANYWHERE TO STEER");
        localStorage.setItem("arenaControlsRuns", String(runs + 1));
        if (runs + 1 >= 3) localStorage.setItem("arenaControlsSeen", "true");
      }
      return;
    }
    hint.hidden = seen;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function normalizeAngle(a) {
    while (a > Math.PI) a -= TWO_PI;
    while (a < -Math.PI) a += TWO_PI;
    return a;
  }
  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
  }

  // Minimal Web Audio sound (independent of Classic SoundEngine to stay self-contained).
  function makeSound() {
    let actx = null;
    let muted = false;
    let ambient = null;
    function ensure() {
      if (!window.AudioContext && !window.webkitAudioContext) return null;
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      return actx;
    }
    function stopAmbient() {
      if (!ambient) return;
      if (ambient.timer) clearInterval(ambient.timer);
      for (const node of ambient.nodes) {
        try { node.stop?.(); } catch {}
        try { node.disconnect?.(); } catch {}
      }
      try { ambient.gain.disconnect(); } catch {}
      ambient = null;
    }
    function startAmbient(envName, weatherName) {
      stopAmbient();
      if (muted) return;
      const a = ensure();
      if (!a) return;
      const now = a.currentTime;
      const base = weatherName === "night" ? 72
        : weatherName === "storm" ? 58
        : weatherName === "snow" ? 92
        : envName === "Beach" ? 84
        : envName === "Desert" ? 66 : 78;
      const gain = a.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.012, now + 0.8);
      gain.connect(a.destination);
      const o1 = a.createOscillator();
      const o2 = a.createOscillator();
      o1.type = "sine";
      o2.type = weatherName === "storm" ? "sawtooth" : "triangle";
      o1.frequency.setValueAtTime(base, now);
      o2.frequency.setValueAtTime(base * 1.505, now);
      const g1 = a.createGain();
      const g2 = a.createGain();
      g1.gain.setValueAtTime(0.7, now);
      g2.gain.setValueAtTime(weatherName === "storm" ? 0.12 : 0.22, now);
      o1.connect(g1); o2.connect(g2);
      g1.connect(gain); g2.connect(gain);
      o1.start(now); o2.start(now);
      let step = 0;
      const motif = weatherName === "storm" ? [1, 1.189, 0.84, 1.414]
        : weatherName === "night" ? [1, 1.125, 1.5, 1.25]
        : weatherName === "snow" ? [1, 1.25, 1.5, 2]
        : [1, 1.25, 1.5, 1.875];
      const timer = setInterval(() => {
        if (muted) return;
        const octave = step % 8 >= 4 ? 2 : 1;
        const freq = base * motif[step % motif.length] * octave;
        tone(freq, freq * 1.01, 0.18, weatherName === "storm" ? "triangle" : "sine", 0.012);
        step += 1;
      }, weatherName === "storm" ? 2200 : 1800);
      ambient = { gain, nodes: [o1, o2, g1, g2], timer };
    }
    function tone(f1, f2, dur, type, gainV) {
      if (muted) return;
      const a = ensure();
      if (!a) return;
      const now = a.currentTime;
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f1, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, f2), now + dur);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(gainV, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(gain); gain.connect(a.destination);
      osc.start(now); osc.stop(now + dur + 0.03);
    }
    return {
      resume() { const a = ensure(); if (a && a.state === "suspended") a.resume(); },
      setMuted(m) { muted = m; if (muted) stopAmbient(); },
      startAmbient,
      stopAmbient,
      eat() { tone(520, 900, 0.06, "triangle", 0.04); },
      death() { tone(260, 60, 0.25, "sawtooth", 0.07); },
      power() { tone(660, 1180, 0.12, "square", 0.05); },
      fire() { tone(900, 200, 0.12, "sawtooth", 0.05); }
    };
  }

  // ---- Expose -------------------------------------------------------------
  window.ArenaGame = {
    start,
    stop,
    setMuted: (m) => sound.setMuted(m),
    setSensitivity: (v) => { const n = parseFloat(v); if (!isNaN(n)) sensitivity = clamp(n, 0.3, 1.3); }
  };
})();
