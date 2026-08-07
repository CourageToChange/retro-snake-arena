(function (root, factory) {
  "use strict";
  const rules = factory();
  if (typeof module === "object" && module.exports) module.exports = rules;
  if (root) root.ArenaRules = rules;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FOOD_KINDS = {
    berry: { label: "Berry", mass: 1, r: 11, color: "#ff6fb1", shape: "berry", weight: 54 },
    apple: { label: "Apple", mass: 2, r: 14, color: "#ff7474", shape: "apple", weight: 30 },
    melon: { label: "Melon", mass: 4, r: 18, color: "#5cf0a5", shape: "melon", weight: 12 },
    gold: { label: "Gold", mass: 8, r: 22, color: "#ffd86b", shape: "star", weight: 4 }
  };

  const ITEM_KINDS = {
    mega: { cat: "grow", icon: "cherry", color: "#ff4d6d", r: 15, mass: 5, weight: 24 },
    thunder: { cat: "ability", icon: "thunder", color: "#ffd23f", r: 13, ability: "speed", dur: 5, weight: 15 },
    mushroom: { cat: "ability", icon: "mushroom", color: "#c0392b", r: 13, ability: "slow", dur: 4, weight: 13 },
    magnet: { cat: "ability", icon: "magnet", color: "#b06bff", r: 12, ability: "magnet", dur: 6, weight: 10 },
    ghost: { cat: "ability", icon: "ghost", color: "#5ffbf1", r: 13, ability: "ghost", dur: 4, weight: 10 },
    rocket: { cat: "weapon", icon: "rocket", color: "#ff9f43", r: 13, weight: 14 },
    bomb: { cat: "hazard", icon: "bomb", color: "#20242b", r: 14, weight: 14 }
  };

  const ITEM_LABELS = {
    speed: "FAST",
    slow: "SLOW",
    magnet: "MAGNET",
    ghost: "GHOST"
  };

  const ROCKETS = {
    maxAmmo: 3,
    speed: 720,
    life: 1.6,
    radius: 8,
    cutMin: 5,
    cutMax: 24
  };

  const SKY_DROP = {
    minDelay: 18,
    maxDelay: 32,
    telegraph: 3.0,
    fall: 1.15,
    active: 12,
    radius: 24,
    rewards: ["mass", "speed", "ghost", "rockets"]
  };

  const COMBO = {
    window: 3.2,
    nearMissCooldown: 1.4
  };

  const ARENA_BALANCE = {
    maxMass: 500
  };

  const PALETTES = {
    classic: { body: "#46f2a4", glow: "#46f2a4" },
    neon: { body: "#e85cff", glow: "#e85cff" },
    block: { body: "#ffcf5a", glow: "#ffcf5a" },
    stripe: { body: "#ff5d73", glow: "#ff5d73" },
    chrome: { body: "#c8d7e1", glow: "#c8d7e1" },
    mint: { body: "#9af06f", glow: "#9af06f" }
  };

  const HEAD_SHAPES = {
    round: { label: "Round" },
    viper: { label: "Pointed" },
    cobra: { label: "Wide" },
    diamond: { label: "Diamond" },
    square: { label: "Pixel" }
  };

  const BOT_NAMES = [
    "Vyper", "Coil", "Slinky", "Noodle", "Mamba", "Fang", "Hiss", "Zigzag",
    "Boa", "Pixel", "Glitch", "Echo", "Nova", "Comet", "Drift", "Quark",
    "Bolt", "Sly", "Loop", "Twist", "Jade", "Cobra", "Wisp", "Rocket"
  ];

  return Object.freeze({
    FOOD_KINDS,
    ITEM_KINDS,
    ITEM_LABELS,
    ROCKETS,
    SKY_DROP,
    COMBO,
    ARENA_BALANCE,
    PALETTES,
    PALETTE_LIST: Object.values(PALETTES),
    HEAD_SHAPES,
    BOT_NAMES
  });
});
