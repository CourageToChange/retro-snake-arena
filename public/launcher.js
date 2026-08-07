"use strict";

// One signed token belongs to one run. The gameplay engines keep the returned
// handle and finish or cancel it; failures resolve quietly so a score service
// problem can never interrupt play.
(function installRunScoreClient() {
  const modes = new Set(["arena", "classic", "rune"]);
  let nextRunId = 1;

  function begin(mode) {
    if (!modes.has(mode)) throw new TypeError("Invalid run mode");
    const run = {
      id: nextRunId++,
      mode,
      startedAt: performance.now(),
      ended: false,
      tokenReady: null
    };
    run.tokenReady = fetch("/arena/run/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ mode })
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.runToken !== "string" || !data.runToken) {
        return { ok: false, status: response.status };
      }
      return { ok: true, runToken: data.runToken };
    }).catch(() => ({ ok: false, status: 0 }));
    return run;
  }

  function cancel(run) {
    if (run) run.ended = true;
  }

  async function submit(run, details) {
    if (!run || run.ended || !modes.has(run.mode)) {
      return { ok: false, status: 0, reason: "inactive" };
    }
    run.ended = true;
    const score = Math.round(Number(details?.score) || 0);
    const durationMs = Math.max(1, Math.round(performance.now() - run.startedAt));
    if (score < 1) return { ok: true, skipped: true, durationMs };

    const token = await run.tokenReady;
    if (!token.ok) return { ok: false, status: token.status, reason: "start" };

    try {
      const response = await fetch("/arena/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          mode: run.mode,
          name: String(details?.name || "Player"),
          score,
          runToken: token.runToken,
          durationMs
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true || data.mode !== run.mode) {
        return { ok: false, status: response.status, reason: "rejected", data, durationMs };
      }
      return { ok: true, status: response.status, data, durationMs };
    } catch {
      return { ok: false, status: 0, reason: "network", durationMs };
    }
  }

  window.SnakeRunScores = Object.freeze({ begin, cancel, submit });
})();

// Launch Arena mode from the start screen. Maps the chosen Classic skin
// to an Arena palette so the snake colour carries over.
(function () {
  const skinPalettes = {
    classic: { body: "#46f2a4", glow: "#46f2a4" },
    neon: { body: "#e85cff", glow: "#e85cff" },
    block: { body: "#ffcf5a", glow: "#ffcf5a" },
    stripe: { body: "#ff5d73", glow: "#ff5d73" },
    chrome: { body: "#c8d7e1", glow: "#c8d7e1" }
  };
  const headShapes = (window.ArenaRules && window.ArenaRules.HEAD_SHAPES) || { round: { label: "Round" } };
  const headKeys = Object.keys(headShapes);
  let selectedHeadShape = normalizeHeadShape(localStorage.getItem("arenaHeadShape"));

  function normalizeHeadShape(value) {
    return headShapes[value] ? value : "round";
  }

  function currentPalette() {
    const active = document.querySelector(".skin.active");
    const skin = active ? active.title : "classic";
    return skinPalettes[skin] || skinPalettes.classic;
  }

  function roundRect(ctx, x, y, w, h, rad) {
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
  }

  // Draw a small stylised snake head so players can SEE each choice before they
  // pick. Decorative only — it does not have to match the in-game render exactly.
  function drawHead(ctx, shape, palette, cx, cy, r) {
    const body = (palette && palette.body) || "#46f2a4";
    const glow = (palette && palette.glow) || body;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.shadowColor = glow;
    ctx.shadowBlur = r * 0.7;
    ctx.fillStyle = body;
    ctx.beginPath();
    if (shape === "diamond") {
      ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
    } else if (shape === "square") {
      const s = r * 0.92; roundRect(ctx, -s, -s, s * 2, s * 2, r * 0.32);
    } else if (shape === "viper") {
      ctx.ellipse(0, 0, r * 1.14, r * 0.8, 0, 0, Math.PI * 2);
    } else if (shape === "cobra") {
      ctx.ellipse(0, r * 0.08, r * 1.2, r, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    // Rosy cheeks.
    ctx.fillStyle = "rgba(255,120,150,0.45)";
    ctx.beginPath();
    ctx.ellipse(r * 0.52, r * 0.3, r * 0.2, r * 0.13, 0, 0, Math.PI * 2);
    ctx.ellipse(-r * 0.52, r * 0.3, r * 0.2, r * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();

    // Big cute eyes.
    const ex = r * 0.4, ey = -r * 0.12, er = r * 0.32;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.arc(-ex, ey, er, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#10151c";
    ctx.beginPath();
    ctx.arc(ex + er * 0.12, ey + er * 0.12, er * 0.56, 0, Math.PI * 2);
    ctx.arc(-ex + er * 0.12, ey + er * 0.12, er * 0.56, 0, Math.PI * 2);
    ctx.fill();
    // Sparkle highlights.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(ex + er * 0.36, ey - er * 0.3, er * 0.24, 0, Math.PI * 2);
    ctx.arc(-ex + er * 0.36, ey - er * 0.3, er * 0.24, 0, Math.PI * 2);
    ctx.fill();

    // Little smile.
    ctx.strokeStyle = "rgba(12,18,26,0.8)";
    ctx.lineWidth = Math.max(1.4, r * 0.09);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, r * 0.18, r * 0.32, 0.18 * Math.PI, 0.82 * Math.PI);
    ctx.stroke();

    ctx.restore();
  }

  function updateHeadPreview() {
    const cv = document.getElementById("headPreview");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 240, h = cv.clientHeight || 160;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const palette = currentPalette();
    for (let i = 5; i >= 1; i -= 1) {
      ctx.globalAlpha = 0.22 + (5 - i) * 0.12;
      drawHead(ctx, "round", palette, w / 2 - 18 - i * 17, h / 2 + 5, 13 - i);
    }
    ctx.globalAlpha = 1;
    drawHead(ctx, selectedHeadShape, palette, w / 2 + 18, h / 2, 30);
  }

  function renderHeadChoices() {
    const wrap = document.getElementById("arenaHeadPicker");
    if (!wrap) return;
    wrap.innerHTML = "";
    headKeys.forEach((key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `arena-head-choice ${key === selectedHeadShape ? "active" : ""}`;
      button.dataset.shape = key;
      button.title = headShapes[key].label;
      button.setAttribute("aria-label", `${headShapes[key].label} head`);
      const cv = document.createElement("canvas");
      cv.width = 64;
      cv.height = 40;
      drawHead(cv.getContext("2d"), key, currentPalette(), 32, 20, 13);
      const label = document.createElement("span");
      label.className = "head-label";
      label.textContent = headShapes[key].label;
      button.appendChild(cv);
      button.appendChild(label);
      button.addEventListener("click", () => {
        selectedHeadShape = key;
        localStorage.setItem("arenaHeadShape", selectedHeadShape);
        renderHeadChoices();
        updateHeadPreview();
      });
      wrap.appendChild(button);
    });
  }
  renderHeadChoices();
  updateHeadPreview();

  // Recolour the head previews when the snake colour (skin) changes.
  const skinGridEl = document.getElementById("skinGrid");
  if (skinGridEl) {
    skinGridEl.addEventListener("click", () => { renderHeadChoices(); updateHeadPreview(); });
  }

  const sens = document.getElementById("arenaSens");
  if (sens) {
    const saved = parseFloat(localStorage.getItem("arenaSensitivity"));
    if (!isNaN(saved)) sens.value = saved;
    const applySens = () => {
      localStorage.setItem("arenaSensitivity", sens.value);
      if (window.ArenaGame && window.ArenaGame.setSensitivity) window.ArenaGame.setSensitivity(sens.value);
    };
    sens.addEventListener("input", applySens);
    applySens();
  }

  // Start-screen settings. These write the same localStorage keys the Arena
  // reads on launch, so choices made on the menu apply when a game starts.
  function bindSetupSetting(id, key, kind, defaultValue) {
    const el = document.getElementById(id);
    if (!el) return;
    const stored = localStorage.getItem(key);
    if (kind === "select") {
      el.value = stored !== null ? stored : defaultValue;
      el.addEventListener("change", () => localStorage.setItem(key, el.value));
    } else {
      // boolean checkbox; defaultValue is the value when nothing is stored
      const on = stored === null ? defaultValue : stored !== "false";
      el.checked = on;
      el.addEventListener("change", () => localStorage.setItem(key, el.checked ? "true" : "false"));
    }
  }
  bindSetupSetting("setupQuality", "arenaQuality", "select", "balanced");
  bindSetupSetting("setupShowFps", "arenaShowFps", "bool", false);
  bindSetupSetting("setupSound", "arenaSoundOn", "bool", true);
  bindSetupSetting("setupReducedMotion", "arenaReducedMotion", "bool", false);
  bindSetupSetting("setupLeftHanded", "arenaLeftHanded", "bool", false);
  bindSetupSetting("setupTouchControl", "arenaTouchControl", "select", "joystick");
  bindSetupSetting("setupMaxFps", "arenaMaxFps", "select", "0");

  // Display name: persist what the player types. It is used for saved scores
  // and is stored in the signed-in player's profile.
  const nameInput = document.getElementById("playerName");
  if (nameInput) {
    const savedName = localStorage.getItem("arenaDisplayName");
    if (savedName && !nameInput.value) nameInput.value = savedName;
    nameInput.addEventListener("input", () => {
      const v = nameInput.value.trim();
      if (v) localStorage.setItem("arenaDisplayName", v);
    });
  }

  // Leaderboard initials (ADR-006): exactly 3 chars, A-Z / 0-9, uppercased —
  // the only name on the public board. Until the player edits the field it
  // auto-derives from the display name.
  const initialsInput = document.getElementById("playerInitials");
  let initialsTouched = false;

  function deriveInitials(name) {
    const base = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return (base + "XXX").slice(0, 3);
  }

  function refreshInitials() {
    if (!initialsInput) return;
    const saved = localStorage.getItem("arenaInitials");
    if (saved) {
      initialsInput.value = saved;
      initialsTouched = true;
    } else if (!initialsTouched) {
      initialsInput.value = deriveInitials(nameInput ? nameInput.value : "");
    }
  }

  if (initialsInput) {
    refreshInitials();
    initialsInput.addEventListener("input", () => {
      initialsTouched = true;
      const v = initialsInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
      if (v !== initialsInput.value) initialsInput.value = v;
      if (v) localStorage.setItem("arenaInitials", v);
    });
  }
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      if (!initialsTouched && initialsInput) {
        initialsInput.value = deriveInitials(nameInput.value);
      }
    });
  }

  // The validated initials used on every score submission ("" when invalid, so
  // the UI can say so instead of posting a name the server must reject).
  window.SnakeInitials = function () {
    const raw = (initialsInput && initialsInput.value) || localStorage.getItem("arenaInitials") || "";
    const value = String(raw).trim().toUpperCase();
    return /^[A-Z0-9]{3}$/.test(value) ? value : "";
  };

  // Per-mode personal bests stored locally (raised from the server's personal
  // best whenever the menu fetches it). Score submissions consult this so only
  // a new best is ever submitted (ADR-005).
  window.SnakeBests = {
    get(mode) {
      const value = Number(localStorage.getItem("arenaBest:" + mode));
      return Number.isFinite(value) && value > 0 ? value : 0;
    },
    update(mode, score) {
      const value = Math.round(Number(score) || 0);
      if (value > this.get(mode)) localStorage.setItem("arenaBest:" + mode, String(value));
    }
  };

  // Remember the chosen snake colour (skin) per account too.
  if (skinGridEl) {
    skinGridEl.addEventListener("click", () => {
      const active = document.querySelector(".skin.active");
      if (active && active.title) localStorage.setItem("arenaSkin", active.title);
    });
  }

  // Re-apply settings to the setup controls after a saved profile loads on sign-in.
  function setVal(id, key, kind, fallback) {
    const el = document.getElementById(id);
    if (!el) return;
    const v = localStorage.getItem(key);
    if (kind === "bool") el.checked = v === null ? !!fallback : v !== "false";
    else if (v !== null) el.value = v;
  }
  function refreshSetupControls() {
    setVal("setupQuality", "arenaQuality", "select");
    setVal("setupShowFps", "arenaShowFps", "bool", false);
    setVal("setupSound", "arenaSoundOn", "bool", true);
    setVal("setupReducedMotion", "arenaReducedMotion", "bool", false);
    setVal("setupLeftHanded", "arenaLeftHanded", "bool", false);
    setVal("setupTouchControl", "arenaTouchControl", "select");
    setVal("setupMaxFps", "arenaMaxFps", "select");
    if (sens) {
      const sv = parseFloat(localStorage.getItem("arenaSensitivity"));
      if (!isNaN(sv)) sens.value = sv;
    }
    const dn = localStorage.getItem("arenaDisplayName");
    if (nameInput && dn) nameInput.value = dn;
    refreshInitials();
    selectedHeadShape = normalizeHeadShape(localStorage.getItem("arenaHeadShape"));
    const sk = localStorage.getItem("arenaSkin");
    if (sk) {
      const btn = document.querySelector('.skin[title="' + sk + '"]');
      if (btn && !btn.classList.contains("active")) btn.click();
    }
    renderHeadChoices();
    updateHeadPreview();
  }
  window.addEventListener("snakeprofileloaded", refreshSetupControls);

  function selectedProfile() {
    const name = (document.getElementById("playerName").value || "Player").trim();
    const active = document.querySelector(".skin.active");
    const skin = active ? active.title : "classic";
    return { name, skin, palette: skinPalettes[skin] || skinPalettes.classic, headShape: selectedHeadShape };
  }

  function launchLocalArena() {
    const profile = selectedProfile();
    if (window.enterGameFullscreen) window.enterGameFullscreen();
    if (window.ClassicGame && window.ClassicGame.stop) window.ClassicGame.stop({ keepPlayingClass: true });
    document.body.classList.add("is-playing");
    window.ArenaGame.start({ name: profile.name, palette: profile.palette, headShape: profile.headShape });
  }

  function launchRuneMaze() {
    if (window.enterGameFullscreen) window.enterGameFullscreen();
    if (window.ArenaGame && window.ArenaGame.stop) window.ArenaGame.stop();
    if (window.ClassicGame && window.ClassicGame.startMaze) window.ClassicGame.startMaze();
  }

  // ----- Single Player flow: landing -> setup (pick head/colour) -> play -----
  const landingEl = document.getElementById("setup");
  const spSetupEl = document.getElementById("spSetup");
  const singleBtn = document.getElementById("singlePlayerBtn");
  const spBackBtn = document.getElementById("spBackBtn");
  const spPlayBtn = document.getElementById("spPlayBtn");

  function showSpSetup() {
    if (spSetupEl) spSetupEl.hidden = false;
    if (singleBtn) singleBtn.classList.add("selected");
    renderHeadChoices();
    updateHeadPreview();
  }
  function showLanding() {
    if (landingEl) landingEl.hidden = false;
    if (spSetupEl) spSetupEl.hidden = false;
  }
  if (singleBtn) singleBtn.addEventListener("click", showSpSetup);
  if (spBackBtn) spBackBtn.addEventListener("click", showLanding);
  if (spPlayBtn) spPlayBtn.addEventListener("click", launchLocalArena);

  // Each card owns its mode-specific score line. Names are always inserted as
  // text nodes, even though the server also sanitises them.
  async function updateBestLine() {
    await Promise.all(["arena", "classic", "rune"].map(updateModeScore));
  }

  async function updateModeScore(mode) {
    const el = document.querySelector('[data-mode-score="' + mode + '"]');
    if (!el) return;
    try {
      const response = await fetch("/arena/best?mode=" + encodeURIComponent(mode), {
        credentials: "same-origin"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.mode !== mode) throw new Error("Invalid score response");
      renderModeScore(el, data);
    } catch {
      el.textContent = "No scores yet";
      el.dataset.scoreState = "empty";
    }
  }

  function renderModeScore(el, data) {
    const top = Number.isInteger(data.globalTop) && data.globalTop > 0 ? data.globalTop : 0;
    const personal = Number.isInteger(data.personalBest) && data.personalBest > 0
      ? data.personalBest
      : 0;
    // Raise the locally stored best from the server's per-account best so the
    // only-submit-a-new-best rule holds across devices.
    if (data.loggedIn && personal > 0 && window.SnakeBests) {
      window.SnakeBests.update(data.mode, personal);
    }
    const parts = [];
    const value = (score) => {
      const strong = document.createElement("strong");
      strong.textContent = score.toLocaleString("en-GB");
      return strong;
    };

    if (top > 0) {
      parts.push(document.createTextNode("Top score "), value(top));
      if (data.globalTopName) {
        const name = document.createElement("strong");
        name.textContent = String(data.globalTopName);
        parts.push(document.createTextNode(" by "), name);
      }
      el.dataset.scoreState = "scored";
    } else {
      parts.push(document.createTextNode("No scores yet"));
      el.dataset.scoreState = "empty";
    }

    if (data.loggedIn) {
      parts.push(document.createTextNode(" · Your best "));
      if (personal > 0) parts.push(value(personal));
      else parts.push(document.createTextNode("—"));
    }
    el.replaceChildren(...parts);
  }
  window.refreshBestLine = updateBestLine;
  updateBestLine();

  function launchFromHash() {
    if (location.hash === "#arena-local" || location.hash === "#arena") {
      launchLocalArena();
    } else if (location.hash === "#rune-maze") {
      launchRuneMaze();
    }
  }

  window.addEventListener("load", launchFromHash);
  window.addEventListener("hashchange", launchFromHash);
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
}
