import { slotInfo } from "./slot.js";
import { Leaderboard } from "./leaderboard.js";
import {
  WORLD, WIN_R2, newBeacon, advanceAirdrop, handleBeaconAction,
  damageBeacon, dropBeacon, dist2,
} from "./beacon.js";
import { encode, decode, clamp, PROTO_VERSION } from "./protocol.js";

const TICK_MS = 66;          // ~15 Hz simulation + broadcast
const POS_MAX_JUMP = 600;    // sanity clamp on reported movement per update (anti-teleport-ish)
const FILL_BOTS_TO = 3;      // keep this many competitors when humans are few
const BOT_NAMES_A = ["นัก", "เสือ", "เงา", "พราน", "โร", "ฮัน", "ไค", "ซิน", "ดิน", "ม่าน"];
const BOT_NAMES_B = ["ล่า", "เถื่อน", "ดำ", "เร็ว", "เดี่ยว", "ป่า", "เพลิง", "ฟ้า"];
const BOT_COLS = ["#3a6ea5", "#a53a5a", "#6a8a3a", "#8a5a2a", "#5a3a8a"];

const rand = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rand(a, b + 1));
const botName = () => BOT_NAMES_A[ri(0, BOT_NAMES_A.length - 1)] + BOT_NAMES_B[ri(0, BOT_NAMES_B.length - 1)];

export class GameRoom {
  constructor() {
    this.players = new Map(); // id -> {ws,name,x,y,dir,hp,carrying,last}
    this.bots = [];
    this.beacon = newBeacon();
    this.board = new Leaderboard();
    this.slot = slotInfo();
    this.spawnBots();
    this.timer = setInterval(() => this.update(), TICK_MS);
    this.lastTick = Date.now();
  }

  onConnect(ws) {
    ws.id = Math.random().toString(36).slice(2, 9);
    ws.isAlive = true;
    ws.on("message", (buf) => this.onMessage(ws, buf));
    ws.on("close", () => this.onClose(ws));
    ws.on("pong", () => { ws.isAlive = true; });
    ws.send(encode({
      t: "welcome",
      v: PROTO_VERSION,
      id: ws.id,
      slot: slotInfo(),
      board: this.board.list(),
    }));
  }

  onMessage(ws, buf) {
    try { this._onMessage(ws, buf); }
    catch (e) { console.error("onMessage failed:", e); }
  }

  _onMessage(ws, buf) {
    const m = decode(buf);
    if (!m || typeof m.t !== "string") return;

    if (m.t === "join") {
      this.players.set(ws.id, {
        ws,
        name: String(m.name || "player").slice(0, 16),
        x: WORLD.W / 2, y: WORLD.H / 2, dir: 1, hp: 100, carrying: false,
        last: Date.now(),
      });
      this.refreshBots();
      ws.send(encode({ t: "board", winners: this.board.list() }));
      return;
    }

    const p = this.players.get(ws.id);
    if (!p) return;
    p.last = Date.now();

    if (m.t === "pos") {
      const nx = clamp(+m.x || p.x, 0, WORLD.W);
      const ny = clamp(+m.y || p.y, 0, WORLD.H);
      // ignore absurd jumps but accept normal movement
      if (Math.abs(nx - p.x) < POS_MAX_JUMP && Math.abs(ny - p.y) < POS_MAX_JUMP) {
        p.x = nx; p.y = ny;
      } else { p.x = nx; p.y = ny; } // first update / respawn: accept
      p.dir = m.dir === -1 ? -1 : 1;
      p.hp = clamp(+m.hp || 0, 0, 999);
      p.carrying = !!m.carrying;
    } else if (m.t === "beacon") {
      const changed = handleBeaconAction(this.beacon, { id: ws.id, x: p.x, y: p.y }, m.action);
      if (changed) this.broadcastSnapshot();
    } else if (m.t === "beaconDmg") {
      // only let non-owners chip a planted beacon (you can't break your own)
      if (this.beacon.owner !== ws.id && damageBeacon(this.beacon, m.amt)) {
        this.broadcast({ t: "event", kind: "landed", data: { x: this.beacon.x, y: this.beacon.y } });
      }
    } else if (m.t === "ping") {
      ws.send(encode({ t: "pong" }));
    }
  }

  onClose(ws) {
    const p = this.players.get(ws.id);
    if (p && this.beacon.owner === ws.id) {
      dropBeacon(this.beacon, p.x, p.y); // carried/planted -> crate so others can take it
    }
    this.players.delete(ws.id);
    this.refreshBots();
  }

  humanCount() {
    return this.players.size;
  }

  // ---- server bots (simplified competitors so the island never feels empty) ----
  spawnBots() {
    this.bots = [];
    for (let i = 0; i < FILL_BOTS_TO; i++) {
      const edge = ri(0, 3);
      let x, y;
      if (edge === 0) { x = rand(120, WORLD.W - 120); y = 120; }
      else if (edge === 1) { x = rand(120, WORLD.W - 120); y = WORLD.H - 120; }
      else if (edge === 2) { x = 120; y = rand(120, WORLD.H - 120); }
      else { x = WORLD.W - 120; y = rand(120, WORLD.H - 120); }
      this.bots.push({
        id: "bot" + i, name: botName(), x, y, dir: 1, hp: 90, maxhp: 90,
        col: BOT_COLS[i % BOT_COLS.length], t: rand(1, 3), tx: x, ty: y,
        carryT: 0, home: null,
      });
    }
  }

  // Keep enough competitors alive: real players replace bots. With >=2 humans we
  // drop the bots entirely; otherwise top up to FILL_BOTS_TO.
  refreshBots() {
    const humans = this.humanCount();
    const want = humans >= 2 ? 0 : Math.max(0, FILL_BOTS_TO - humans);
    if (want === 0) {
      // if a bot holds the beacon, drop it back to a crate before removing
      if (this.bots.some((b) => b.id === this.beacon.owner)) dropBeacon(this.beacon);
      this.bots = [];
    } else if (this.bots.length < want) {
      const have = this.bots.length;
      for (let i = have; i < want; i++) {
        this.bots.push({
          id: "bot" + i, name: botName(), x: rand(120, WORLD.W - 120), y: 120,
          dir: 1, hp: 90, maxhp: 90, col: BOT_COLS[i % BOT_COLS.length],
          t: rand(1, 3), tx: rand(120, WORLD.W - 120), ty: rand(120, WORLD.H - 120),
          carryT: 0, home: null,
        });
      }
    }
  }

  botTick(dt) {
    const b = this.beacon;
    for (const bot of this.bots) {
      let gx = null, gy = null, speed = 58;
      if (b.state === "carried" && b.owner === bot.id) {
        bot.carryT += dt; b.x = bot.x; b.y = bot.y;
        const home = bot.home || { x: bot.x, y: bot.y };
        if (dist2(bot.x, bot.y, home.x, home.y) < 36 * 36 || bot.carryT > 13) {
          handleBeaconAction(b, { id: bot.id, x: bot.x, y: bot.y }, "plant");
        } else { gx = home.x; gy = home.y; speed = 66; }
      } else if (b.state === "planted" && b.owner === bot.id) {
        gx = b.x + Math.sin(Date.now() / 600) * 30;
        gy = b.y + Math.cos(Date.now() / 700) * 30; speed = 52;
      } else if (b.state === "planted" && b.owner !== bot.id) {
        gx = b.x; gy = b.y; speed = 70;
        if (dist2(bot.x, bot.y, b.x, b.y) < 26 * 26) damageBeacon(b, 7 * dt);
      } else if (b.state === "crate") {
        gx = b.x; gy = b.y; speed = 78;
        if (dist2(bot.x, bot.y, b.x, b.y) < 28 * 28) {
          b.state = "carried"; b.owner = bot.id; bot.carryT = 0;
          bot.home = {
            x: clamp(b.x + rand(-140, 140), 260, WORLD.W - 260),
            y: clamp(b.y + rand(-140, 140), 260, WORLD.H - 260),
          };
        }
      } else if (b.state === "incoming") {
        gx = b.x; gy = b.y; speed = 64;
      } else { // roam
        bot.t -= dt;
        if (bot.t <= 0) {
          bot.t = rand(2, 5);
          bot.tx = clamp(bot.x + rand(-220, 220), 100, WORLD.W - 100);
          bot.ty = clamp(bot.y + rand(-220, 220), 100, WORLD.H - 100);
        }
        gx = bot.tx; gy = bot.ty; speed = 50;
      }
      if (gx != null) {
        const dx = gx - bot.x, dy = gy - bot.y, d = Math.hypot(dx, dy) || 1;
        if (d > 4) {
          bot.x += (dx / d) * speed * dt;
          bot.y += (dy / d) * speed * dt;
          bot.dir = dx > 2 ? 1 : dx < -2 ? -1 : bot.dir;
        }
      }
    }
  }

  // ---- round resolution ----
  resolveEnd() {
    const b = this.beacon;
    let winner = null; // {name, isHuman, id}
    if (b.state === "planted" && b.hp > 0 && b.owner) {
      const human = this.players.get(b.owner);
      if (human && dist2(human.x, human.y, b.x, b.y) < WIN_R2) {
        winner = { id: b.owner, name: human.name, isHuman: true };
      } else {
        const bot = this.bots.find((x) => x.id === b.owner);
        if (bot && dist2(bot.x, bot.y, b.x, b.y) < WIN_R2) {
          winner = { id: bot.id, name: bot.name, isHuman: false };
        }
      }
    }
    if (winner) {
      // MVP: server doesn't track inventories, so use a flat victory value.
      this.board.push(winner.name, 200);
      this.broadcast({
        t: "event", kind: "win",
        data: { winnerId: winner.id, winnerName: winner.name, isHuman: winner.isHuman, val: 200 },
      });
      this.broadcast({ t: "board", winners: this.board.list() });
    } else {
      this.broadcast({ t: "event", kind: "win", data: { winnerId: null, winnerName: null, val: 0 } });
    }
  }

  update() {
    try { this._update(); }
    catch (e) { console.error("tick update failed:", e); }
  }

  _update() {
    const nowMs = Date.now();
    const dt = Math.min(0.25, (nowMs - this.lastTick) / 1000) || 0;
    this.lastTick = nowMs;

    const s = slotInfo(nowMs);
    if (s.id !== this.slot.id) {
      this.resolveEnd();
      this.beacon = newBeacon();
      this.slot = s;
      this.spawnBots();
      this.refreshBots();
      this.broadcast({ t: "event", kind: "reset", data: { slot: { id: s.id, remain: s.remain } } });
    }

    const ev = advanceAirdrop(this.beacon, s.remain);
    if (ev) this.broadcast({ t: "event", kind: ev, data: { x: this.beacon.x, y: this.beacon.y } });

    this.botTick(dt);
    this.broadcastSnapshot(s);
  }

  broadcastSnapshot(s = slotInfo()) {
    const players = [];
    for (const [id, p] of this.players) {
      players.push({ id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, hp: p.hp, carrying: p.carrying });
    }
    const bots = this.bots.map((b) => ({
      id: b.id, name: b.name, x: Math.round(b.x), y: Math.round(b.y), dir: b.dir,
      hp: b.hp, maxhp: b.maxhp, col: b.col, carrying: this.beacon.owner === b.id && this.beacon.state === "carried",
    }));
    this.broadcast({
      t: "snapshot", now: Date.now(),
      slot: { remain: s.remain, id: s.id },
      players, bots, beacon: this.beacon,
    });
  }

  broadcast(obj) {
    const s = encode(obj);
    for (const p of this.players.values()) {
      if (p.ws.readyState === 1) {
        try { p.ws.send(s); } catch { /* ignore */ }
      }
    }
  }

  dispose() {
    clearInterval(this.timer);
  }
}
