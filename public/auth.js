(function () {
  "use strict";

  const signedOut = document.getElementById("authSignedOut");
  const signedIn = document.getElementById("authSignedIn");
  const logoutBtn = document.getElementById("authLogoutBtn");
  const userEl = document.getElementById("authUserName");
  const messageEl = document.getElementById("authMessage");
  const playerNameEl = document.getElementById("playerName");
  const googleHolder = document.getElementById("googleSignin");
  const fallbackBtn = document.getElementById("googleFallbackBtn");

  if (!signedOut || !signedIn) return;

  let currentUser = null;
  let gsiReady = false;

  // Read-only login state used by profile synchronization.
  window.SnakeAuth = {
    isLoggedIn() { return !!currentUser; },
    currentUser() { return currentUser; }
  };

  bootAuth();
  if (logoutBtn) logoutBtn.addEventListener("click", () => logout());
  if (fallbackBtn) {
    fallbackBtn.addEventListener("click", () => {
      if (gsiReady && window.google && google.accounts && google.accounts.id) {
        google.accounts.id.prompt(); // FedCM account chooser
      } else {
        setMessage("Google sign-in is unavailable right now.", false);
      }
    });
  }

  async function bootAuth() {
    await refreshUser();
    if (currentUser) {
      setMessage("", false);
      return;
    }
    await initGoogle();
  }

  async function refreshUser() {
    try {
      const data = await fetchJson("/auth/me");
      currentUser = data.user || null;
      render();
      // Covers signing in from another tab and coming back: the session is
      // restored here rather than through the credential callback.
      if (currentUser) redeemHeldRunIfAny();
    } catch {
      setMessage("Account status unavailable.", true);
    }
  }

  function showFallback() {
    if (fallbackBtn) fallbackBtn.hidden = false;
    if (googleHolder) googleHolder.hidden = true;
  }

  function showGoogleButton() {
    if (fallbackBtn) fallbackBtn.hidden = true;
    if (googleHolder) googleHolder.hidden = false;
  }

  async function initGoogle() {
    gsiReady = false;
    let clientId = null;
    try {
      const cfg = await fetchJson("/auth/config");
      clientId = cfg.googleClientId;
    } catch {}
    // Always show OUR own clean button. The GSI auto-rendered button degrades to an
    // ugly "Sign in with Google. Opens in new tab" text link whenever third-party
    // cookies are blocked (Incognito, and increasingly the default in modern
    // browsers). We trigger sign-in via FedCM on click instead, which needs no
    // third-party cookies and stays reliable everywhere.
    showFallback();
    if (!clientId) return;
    await loadGsi();
    if (!(window.google && google.accounts && google.accounts.id)) return;
    google.accounts.id.initialize({
      client_id: clientId,
      callback: onGoogleCredential,
      use_fedcm_for_prompt: true
    });
    gsiReady = true;
    google.accounts.id.prompt(); // optional One Tap on load (via FedCM)
  }

  function loadGsi() {
    return new Promise((resolve) => {
      if (window.google && window.google.accounts) return resolve();
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }

  async function onGoogleCredential(response) {
    if (!response || !response.credential) return;
    try {
      const data = await fetchJson("/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential: response.credential })
      });
      currentUser = data.user;
      setMessage("Signed in.", false);
      render();
      // A run played signed-out is held client-side rather than thrown away.
      // Redeem it now, while its token is still inside the server's 30-minute
      // window, so "sign in to keep that score" actually keeps it.
      redeemHeldRunIfAny();
    } catch (err) {
      setMessage(err.message || "Google sign-in failed.", true);
    }
  }


  async function redeemHeldRunIfAny() {
    const scores = window.SnakeRunScores;
    if (!scores || typeof scores.redeemHeldRun !== "function") return;
    if (!scores.peekHeldRun()) return;
    const result = await scores.redeemHeldRun();
    if (!result || !result.ok) return;
    const data = result.data || {};
    const held = result.held || {};
    const message = data.globalBest
      ? "Saved. New top score " + held.score + "."
      : data.personalBest
        ? "Saved. Personal best " + held.score + "."
        : "Saved your " + held.score + " run.";
    setMessage(message, false);
    if (typeof window.refreshBestLine === "function") window.refreshBestLine();
    document.dispatchEvent(new CustomEvent("snake:held-run-saved", { detail: { data, held } }));
  }

  async function logout() {
    try {
      await fetchJson("/auth/logout", { method: "POST" });
      currentUser = null;
      if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
      setMessage("Signed out.", false);
      render();
      await initGoogle();
    } catch (err) {
      setMessage(err.message || "Sign out failed.", true);
    }
  }

  function render() {
    const isIn = !!currentUser;
    signedOut.hidden = isIn;
    signedIn.hidden = !isIn;
    if (userEl) userEl.textContent = isIn ? currentUser.name : "";
    if (isIn && playerNameEl) {
      const saved = localStorage.getItem("arenaDisplayName");
      playerNameEl.value = saved || currentUser.name || playerNameEl.value;
    }
    if (window.refreshBestLine) window.refreshBestLine();
    // Pull the saved per-account display name + settings (async; refreshes UI).
    if (isIn && window.SnakeProfile && window.SnakeProfile.loadProfile) window.SnakeProfile.loadProfile();
  }

  function setMessage(text, isError) {
    if (!messageEl) return;
    messageEl.textContent = text || "";
    messageEl.classList.toggle("error", !!isError);
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...(options || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
})();
