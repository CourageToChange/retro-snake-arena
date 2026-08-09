# Retro Snake Arena

> Personal hobby project. Built for fun to run on a private home server. It is
> not a product, has no warranty, and is not affiliated with, endorsed by, or
> connected to any other game.
>
> The source code is MIT licensed ([LICENSE](LICENSE)). Original artwork and
> audio are licensed separately under Creative Commons. The self-hosted
> Press Start 2P font uses the SIL Open Font License. Details are in
> [ASSETS-LICENSE](ASSETS-LICENSE).

A browser Snake game with three single-player modes, built with vanilla
JavaScript and HTML Canvas on a small Node/Express back end. No build step, no
front-end framework, and no third-party runtime dependencies beyond Express and
SQLite.

**Live at [snake.noorfamily.uk](https://snake.noorfamily.uk).**

Read the full case study at [noor.noorfamily.uk](https://noor.noorfamily.uk).

See the [player guide](USER-GUIDE.md) for phone and desktop controls.

## Modes

- **Arena** — a continuous open world with free movement, around twenty bot
  snakes, power-ups, rockets, and a boost.
- **Classic** — traditional 32×32 grid Snake. One life, escalating speed, and
  your own body as the hazard.
- **Rune Maze** — a maze run: reach three rune gates in order and the final
  portal on the same 32×32 grid. Clearing it unlocks a Bomb Core power-up in
  Classic.

## Scores and sign-in

Playing signed out works fully: runs are scored, this browser remembers local
bests, and the shared top scores are shown. Google sign-in saves a personal best
per mode to the account. A signed-in score that beats the stored best can enter
the shared leaderboard for that mode.

The public board uses exactly three initials, limited to A–Z and 0–9. They are
uppercased and validated by the server. The display name remains separate and is
used inside the game, not on the public board.

Scores are reported by the browser, so the shared boards do not pretend to be a
verified world record. Each run is issued a short-lived, single-use signed token
when it starts, and a submitted score is rejected unless it carries a valid token
for that run and falls within limits derived from the game's own rules. The
browser submits only a score that beats the stored best for its mode. Only
signed-in scores reach the shared board. The wording on screen is "Top score"
and "Personal best", never "world record".

Accounts store a Google account identifier, a chosen display name, and supported
game settings — graphics quality, sound, control preferences and snake
appearance — so they follow you between devices. No email address and no
password are stored.

## Phone layout and pause

Classic and Rune Maze keep the 32×32 grid. At a 360×800 portrait viewport, the
board renders at 338×338 CSS pixels, or 10.56 pixels per cell. At 800×360
landscape, it renders at 280×280, or 8.75 pixels per cell, with every control on
screen.

All three modes pause from the on-screen pause button or **Escape/P**. Quitting
a live run requires a confirming second tap or click. Arena places its pause and
quit flow outside the touch steering regions.

## Install and run

Requirements: Node.js 18 or newer, and npm.

```bash
npm install
npm start
```

The server listens on `PORT` when set, otherwise port `3000`.

```bash
npm test
```

`npm test` runs JavaScript syntax checks, installable-app asset validation, HTTP
smoke tests, and a Playwright browser suite. The browser tests cover all three
modes plus real touch input at 360×800 portrait and 800×360 landscape sizes,
pause behavior, protected quitting, result actions, and console errors. Set
`E2E_REQUIRE_BROWSER=1` to make an unavailable browser fail the run rather than
skip it.

## Configuration

- `PORT` — listen port (default `3000`).
- `RUN_TOKEN_SECRET` — HMAC key for signing run tokens. **Required in
  production: the server refuses to start without it when `NODE_ENV=production`.**
  Outside production an ephemeral random key is generated per process, so a
  restart invalidates any run in progress and rejects its score.
- `DETAILED_HEALTH=1` — include runtime details in `/health` (local/test only).

## Endpoints

- `GET /` — the game client.
- `GET /health` — minimal `{ "ok": true }` by default.
- `POST /arena/run/start` — begins a run and returns a signed run token.
- `POST /arena/score` — submits a score for a run; requires a valid token.
- `GET /arena/best?mode=<mode>` — personal best and top score for a mode.
- `GET /arena/leaderboard?mode=<mode>` — the top scores for a mode.

## Deployment

It runs on a Proxmox server in my house, in a hardened Docker container: read-only
root filesystem, all Linux capabilities dropped, non-root, memory and CPU capped,
inside its own VM. The only way in is an outbound Cloudflare Tunnel, so there are
no inbound ports on the origin and my home IP stays out of it. I keep the full
build procedure in a private runbook rather than here.

## Runtime data

The SQLite database (`leaderboard.sqlite` and its sidecar files) and
`node_modules/` are created locally and ignored by git. Recreate dependencies
with `npm install`.
