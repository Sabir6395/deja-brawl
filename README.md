# Déjà Brawl

*Your past is their problem.*

A real-time multiplayer browser arena for 2–6 players. Every 12-second loop you play is recorded and replayed as a ghost in every later loop — and your ghosts are lethal to everyone except you.

## How to play

1. Move with **WASD** / arrow keys (or drag your thumb on a phone). Grab gold coins.
2. Every loop, your movement is recorded as a **ghost** that replays next loop.
3. **Other players' ghosts kill you.** Yours don't — use them as traps.
4. Points: coin +1 · your ghost kills someone +3 · survive a loop +2 · last alive +3. Highest after 6 loops wins.

Create a room, share the 4-letter code or invite link, and the host presses Start. No login, no install.

## Run locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open http://localhost:3000. To play from a phone on the same Wi-Fi, open `http://<your-computer's-IP>:3000`.

## Deploy on Render

1. Push this repo to GitHub.
2. On [Render](https://render.com): **New → Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/health`
4. Deploy, then open the `https://<your-app>.onrender.com` URL.

The free tier sleeps when idle, so the first visit can take 30–60 s to wake up. Open `/health` before sharing the link.

## Tech

Node.js, Express, Socket.io, HTML5 Canvas, vanilla JS. The server is authoritative at 20 Hz; clients send only input. All tunable numbers live in `shared/config.js`.
