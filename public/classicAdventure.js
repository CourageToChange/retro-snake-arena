"use strict";

(function (root, factory) {
  const adventure = factory();
  if (typeof module === "object" && module.exports) module.exports = adventure;
  if (root) root.ClassicAdventure = adventure;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const BOARD_SIZE = 32;
  const MOVE_MS = 155;
  const UNLOCK_KEY = "snakeBombCoreUnlocked";
  const START = { x: 6, y: 16 };
  const PORTAL = { x: 29, y: 23 };
  const GATES = [
    { x: 11, y: 16, color: "#56c7ff" },
    { x: 20, y: 8, color: "#e85cff" },
    { x: 27, y: 23, color: "#ffcf5a" }
  ];
  const RUNES = [
    { x: 6, y: 6, name: "TIDE", color: "#56c7ff" },
    { x: 16, y: 25, name: "BLOOM", color: "#e85cff" },
    { x: 24, y: 4, name: "SPARK", color: "#ffcf5a" }
  ];

  const WALLS = uniqueCells([
    ...verticalWall(11, 2, 30, 16),
    ...verticalWall(20, 2, 30, 8),
    ...verticalWall(27, 2, 30, 23),
    ...horizontalWall(11, 2, 10, 5),
    ...horizontalWall(20, 13, 19, 15),
    ...horizontalWall(10, 22, 27, 24),
    ...horizontalWall(27, 2, 9, 7),
    ...horizontalWall(16, 13, 19, 18)
  ]);

  function obstaclesFor(collected) {
    const openCount = clampCollected(collected);
    return [
      ...WALLS.map(copyCell),
      ...GATES.slice(openCount).map(copyCell)
    ];
  }

  function currentRune(collected) {
    return RUNES[clampCollected(collected)] || null;
  }

  function collectRune(collected, position) {
    const rune = currentRune(collected);
    if (!rune || !same(rune, position)) return clampCollected(collected);
    return clampCollected(collected) + 1;
  }

  function portalOpen(collected) {
    return clampCollected(collected) >= RUNES.length;
  }

  function clampCollected(value) {
    return Math.max(0, Math.min(RUNES.length, Math.floor(Number(value) || 0)));
  }

  function verticalWall(x, startY, endY, gapY) {
    const cells = [];
    for (let y = startY; y < endY; y += 1) {
      if (y !== gapY) cells.push({ x, y });
    }
    return cells;
  }

  function horizontalWall(y, startX, endX, gapX) {
    const cells = [];
    for (let x = startX; x < endX; x += 1) {
      if (x !== gapX) cells.push({ x, y });
    }
    return cells;
  }

  function uniqueCells(cells) {
    const found = new Set();
    return cells.filter((cell) => {
      const id = `${cell.x},${cell.y}`;
      if (found.has(id)) return false;
      found.add(id);
      return true;
    });
  }

  function copyCell(cell) {
    return { ...cell };
  }

  function same(a, b) {
    return a?.x === b?.x && a?.y === b?.y;
  }

  return Object.freeze({
    BOARD_SIZE,
    MOVE_MS,
    UNLOCK_KEY,
    START: Object.freeze(START),
    PORTAL: Object.freeze(PORTAL),
    GATES: Object.freeze(GATES.map(Object.freeze)),
    RUNES: Object.freeze(RUNES.map(Object.freeze)),
    WALLS: Object.freeze(WALLS.map(Object.freeze)),
    obstaclesFor,
    currentRune,
    collectRune,
    portalOpen
  });
});
