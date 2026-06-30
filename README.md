# Last Short Island — Online Multiplayer

Top-down survival/extraction game. Real-time 10-minute rounds: prep, grab the
mid-island **airdrop beacon (📡)**, plant and defend it until the round ends to
win. Originally a single-file HTML game with AI bots — now an **authoritative
WebSocket server** so real players share one island, see each other move, fight
over the same beacon, and land on a shared leaderboard.

Deployable on [Render](https://render.com) straight from GitHub.

## How it works

```
GitHub  ──push──▶  Render Web Service (Node)
                        │ express  → serves the client (public/) + /healthz
                        │ ws       → realtime game on /ws
                        │ GameRoom → authoritative tick loop (~15 Hz)
                        ▼
                   Browser client (public/index.html + net.js)
                   render + input + your own PvE + interpolation
```

**Server is authoritative over what must be shared:** the 10-minute round clock,
every player's position, the airdrop/beacon (state · owner · position · HP), the
round winner, and the leaderboard.

**Per-player and client-side (MVP):** your movement, monsters, resource nodes,
crafting, inventory, and base building. These stay local; the beacon, airdrop,
other players, and win/leaderboard are synced.

When fewer than 2 real players are online, the server fills the island with up to
3 simplified bot competitors so it never feels empty; real players replace them.

The client **degrades gracefully**: with no connection (offline / `file://` /
Render cold-start) it runs exactly like the original single-player + local-bots
game. Everything network-related is guarded by `NET.connected`.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```

Open the URL in two browser windows (or a phone + a computer on the same host) to
test multiplayer.

## Deploy to Render

1. Push this repo to GitHub.
2. Render Dashboard → **New → Blueprint** (it reads `render.yaml`), or
   **New → Web Service** with: Runtime **Node**, Build `npm install`, Start
   `npm start`, Health Check `/healthz`.
3. Deploy → you get `https://<name>.onrender.com`. Every push auto-deploys.

> **Free plan note:** the service in `render.yaml` is `plan: free`, which **sleeps
> after ~15 min idle** — the first visitor then waits ~30–60 s for a cold start.
> For an always-on server switch `plan: free` → `plan: starter` (paid), or ping
> the URL periodically with an external uptime monitor.

## Project layout

```
├─ render.yaml          Render blueprint (free plan)
├─ package.json
├─ server/
│  ├─ index.js          express + ws bootstrap, /healthz, heartbeat
│  ├─ room.js           GameRoom: tick loop, players, server bots, broadcast
│  ├─ beacon.js         authoritative airdrop/beacon + win radius
│  ├─ slot.js           10-minute round clock
│  ├─ leaderboard.js    shared winners (JSON-persisted)
│  └─ protocol.js       message shapes + helpers
└─ public/
   ├─ index.html        the game (original + minimal net hooks)
   └─ net.js            WebSocket client layer
```

## Protocol (JSON over WebSocket, `/ws`)

**Client → Server:** `join{name}` · `pos{x,y,dir,hp,carrying}` (~10 Hz) ·
`beacon{action:"grab"|"plant"|"lift",x,y}` · `beaconDmg{amt}` · `ping`

**Server → Client:** `welcome{id,slot,board}` ·
`snapshot{now,slot,players,bots,beacon}` (~15 Hz) ·
`event{kind:"airdrop"|"landed"|"win"|"reset",data}` · `board{winners}` · `pong`

## Status & roadmap

- **Phase 0 — pipeline:** ✅ deployable, serves the game on Render.
- **Phase 1 — MVP multiplayer:** ✅ shared round clock, live player positions,
  authoritative airdrop/beacon, server-decided winner, shared leaderboard,
  filler bots, auto-reconnect, disconnect drops the carried beacon.
- **Phase 2 — authoritative world (next):** move monsters/resources/beacon-HP
  fully server-side, interest management for the 6400×4400 world, server-side
  validation (anti-cheat).
- **Phase 3 — hardening:** multiple rooms/shards, rate limiting, DB-backed
  leaderboard on a persistent disk.

### MVP caveats
- Positions and `beaconDmg` are client-reported (trusted for now) — Phase 2 moves
  validation server-side.
- The server doesn't track inventories, so the leaderboard uses a flat victory
  value (200). The winner's own summary still shows their real bag value.
- The leaderboard JSON lives on the (ephemeral on free tier) filesystem; set
  `DATA_DIR` to a persistent disk to keep it across redeploys.
