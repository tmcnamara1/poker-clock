# Poker Clock

A poker tournament clock for home games. The clock runs full-screen on a laptop or TV. You control it from your phone, and players can follow along on theirs.

## Features

- **Big-screen clock** with the current blinds, ante, next level, time to the next break, and level progress.
- **Automatic levels.** When a level ends, an alert plays, the blinds go up on screen, and the next level's timer starts on its own. Breaks are handled the same way.
- **Adjustable timing.** Set each level's length individually, or set every level at once. Add or remove a minute mid-level. Comes with three presets: Standard (20 min), Turbo (10 min), and Deep (30 min).
- **Phone remote.** Scan a QR code to start, pause, skip levels, adjust time, and edit the blind structure.
- **Two roles:**
  - *Host:* full control. The host link carries a secret key.
  - *Player:* view-only, plus Call the Clock. Players join by scanning the QR code on the main screen.
- **Warning chime** before the blinds go up (off, 30s, 1m, or 2m).
- **Voice announcer** in *Pro* or *Trash talk* mode. It uses the browser's built-in text-to-speech, so it costs nothing.
- **Call the Clock.** Any phone can trigger a full-screen 20–60 second countdown on the TV, with ticking and a "TIME!" buzzer.
- **Survives accidents.** The game state lives on the server, so a refresh, a sleeping laptop, or a dead phone loses nothing. Levels advance on schedule even if no screen is open.

## How it works

- `src/worker.js` is a Cloudflare Worker. It serves the pages and routes each game to its own **Durable Object** (`Room`).
- The Room stores the state and sends live updates to every connected screen over WebSockets. It also advances levels with an alarm at the exact end time.
- The clock stores *when the level ends*, not a ticking countdown. Every screen calculates the time remaining from that one shared timestamp, so all screens stay in sync.
- `public/` contains the static front end. It's plain HTML, CSS, and JavaScript with no build step.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:8787
npm test           # in a second terminal, while dev is running
```

## Deploy to Cloudflare from GitHub

One-time setup:

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**.
2. Connect GitHub and pick this repo.
3. Leave the build command empty and keep the deploy command as `npx wrangler deploy`.
4. Click **Deploy**.

The dev site will be at `https://poker-clock.<your-subdomain>.workers.dev`. After that, every push to `main` deploys automatically.

To deploy manually instead, run `npx wrangler login` and then `npm run deploy`.

**Custom domain (later):** once the domain is on your Cloudflare account, go to **Worker → Settings → Domains & Routes → Add custom domain**.

## Usage

1. Open the site on the laptop or TV and click **Start a new game on this screen**. You get a two-word game code like `lucky-river`.
   - The setup screen shows a QR code for your phone, plus quick choices for level length, the first break, and the starting blinds.
   - Click **Turn on the clock** when you're ready.
2. Scan the setup screen's QR code with your phone to become the host. You can also find it later under `S` (or ⚙) → **Host phone**.
3. Players scan the QR code in the corner of the main screen, or type the game code on the home page.

Keyboard shortcuts on the main screen: `Space` start/pause · `←` `→` previous/next level · `↑` `↓` ±1 minute · `C` call the clock · `S` settings · `F` fullscreen.

## Roadmap ideas

- Bust-out button with an elimination animation and a players-remaining count
- Player list, rebuys and add-ons, payout calculator
- Blind structure generator based on chip set and target game length
