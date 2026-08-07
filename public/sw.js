"use strict";

const CACHE_NAME = "retro-snake-arena-v47";
const SHELL_ASSETS = [
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

const LIVE_PATHS = [
  "/health",
  "/arena/leaderboard",
  "/arena/score",
  "/arena/best",
  "/auth/",
  "/user/profile"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isLivePath(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
  );
});

function isLivePath(pathname) {
  return LIVE_PATHS.some((path) => pathname === path || pathname.startsWith(path));
}
