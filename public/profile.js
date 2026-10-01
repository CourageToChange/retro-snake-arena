"use strict";

// Per-account profile sync: when signed in, the player's chosen display name and
// game settings are saved to their account and restored on any device they log
// in from. Settings live in localStorage; this mirrors them to the server.
(function () {
  const SETTING_KEYS = [
    "arenaQuality", "arenaSensitivity", "arenaSoundOn",
    "arenaReducedMotion", "arenaTouchControl", "arenaLeftHanded",
    "arenaHeadShape", "arenaSkin", "arenaDisplayName", "arenaInitials"
  ];
  const origSet = localStorage.setItem.bind(localStorage);
  let saveTimer = null;

  function loggedIn() {
    return !!(window.SnakeAuth && window.SnakeAuth.isLoggedIn && window.SnakeAuth.isLoggedIn());
  }

  function gatherSettings() {
    const s = {};
    for (const k of SETTING_KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) s[k] = v;
    }
    return s;
  }

  function scheduleSave() {
    if (!loggedIn()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch("/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          displayName: localStorage.getItem("arenaDisplayName") || "",
          settings: gatherSettings()
        })
      }).catch(() => {});
    }, 800);
  }

  // Capture every settings change (setup screen AND in-game) without hooking each
  // control: any `arena*` localStorage write schedules a save when signed in.
  localStorage.setItem = function (k, v) {
    origSet(k, v);
    if (typeof k === "string" && k.indexOf("arena") === 0) scheduleSave();
  };

  async function loadProfile() {
    if (!loggedIn()) return;
    try {
      const res = await fetch("/user/profile", { credentials: "same-origin" });
      const data = await res.json();
      if (!data || !data.loggedIn) return;
      if (data.settings && typeof data.settings === "object") {
        // origSet (not the patched setter) so applying the saved profile does not
        // immediately echo back to the server.
        for (const k of SETTING_KEYS) {
          if (data.settings[k] !== undefined && data.settings[k] !== null) {
            origSet(k, String(data.settings[k]));
          }
        }
      }
      if (data.displayName) origSet("arenaDisplayName", data.displayName);
      window.dispatchEvent(new CustomEvent("snakeprofileloaded"));
    } catch {
      // best-effort
    }
  }

  window.SnakeProfile = { loadProfile, scheduleSave };
})();
