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

// Minimal monster stats (positions/HP/AI are authoritative here; the client
// renders kind-specific visuals). Server AI is simplified to chase + siege.
const MOBS = {
  wolf: { hp: 18, sp: 96, dmg: 7, r: 13, detect: 300 },
  boar: { hp: 40, sp: 70, dmg: 15, r: 16, detect: 280 },
  bat: { hp: 9, sp: 130, dmg: 4, r: 9, detect: 430 },
  scorpion: { hp: 32, sp: 104, dmg: 12, r: 14, detect: 330 },
  bear: { hp: 85, sp: 74, dmg: 22, r: 19, detect: 300 },
};
function pickKind() {
  const r = Math.random();
  if (r < 0.6) return "wolf";
  if (r < 0.78) return "boar";
  if (r < 0.9) return "bat";
  if (r < 0.97) return "scorpion";
  return "bear";
}
const botName = () => BOT_NAMES_A[ri(0, BOT_NAMES_A.length - 1)] + BOT_NAMES_B[ri(0, BOT_NAMES_B.length - 1)];

export class GameRoom {
  constructor() {
    this.players = new Map(); // id -> {ws,name,x,y,dir,hp,carrying,last}
    this.bots = [];
    this.deadNodes = new Map(); // node index -> respawn-at ms (shared resource depletion)
    this.builds = new Map();    // id -> {id,t,x,y,hp} shared walls/doors (shared forts)
    this._bid = 1;
    this.mobs = [];             // shared authoritative monsters
    this._mid = 1;
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
      nodes: [...this.deadNodes.keys()], // currently depleted nodes (for mid-round joiners)
      builds: [...this.builds.values()], // shared walls/doors already standing
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
    } else if (m.t === "node") {
      // a player harvested node #i; deplete it for everyone until it respawns
      const i = m.i | 0;
      const rt = clamp(+m.rt || 30, 1, 600);
      if (i >= 0 && i < 20000 && !this.deadNodes.has(i)) {
        this.deadNodes.set(i, Date.now() + rt * 1000);
        this.broadcast({ t: "event", kind: "node", data: { i, dead: true } });
      }
    } else if (m.t === "build") {
      this.handleBuild(m);
    } else if (m.t === "mobHit") {
      // player-reported damage on a shared monster; server is authoritative on death
      const id = m.id | 0;
      const dmg = clamp(+m.dmg || 0, 0, 500);
      const i = this.mobs.findIndex((x) => x.id === id);
      if (i >= 0) {
        this.mobs[i].hp -= dmg;
        if (this.mobs[i].hp <= 0) {
          const dead = this.mobs.splice(i, 1)[0];
          this.broadcast({
            t: "event", kind: "mob",
            data: { op: "del", id: dead.id, kind: dead.kind, x: Math.round(dead.x), y: Math.round(dead.y), killer: ws.id },
          });
        }
      }
    } else if (m.t === "ping") {
      ws.send(encode({ t: "pong" }));
    }
  }

  // Shared walls/doors so forts are visible to everyone (and, later, so
  // server-side monsters can path around them).
  handleBuild(m) {
    if (m.op === "add") {
      const bt = m.bt === "door" ? "door" : m.bt === "wall" ? "wall" : null;
      if (!bt) return;
      const x = clamp(Math.round(+m.x || 0), 0, WORLD.W);
      const y = clamp(Math.round(+m.y || 0), 0, WORLD.H);
      // no stacking on the same tile
      for (const b of this.builds.values()) {
        if (Math.abs(b.x - x) < 8 && Math.abs(b.y - y) < 8) return;
      }
      if (this.builds.size > 4000) return; // hard cap
      const b = { id: this._bid++, t: bt, x, y, hp: bt === "wall" ? 300 : 200 };
      this.builds.set(b.id, b);
      this.broadcast({ t: "event", kind: "build", data: { op: "add", b } });
    } else if (m.op === "del") {
      const id = m.id | 0;
      if (this.builds.delete(id)) {
        this.broadcast({ t: "event", kind: "build", data: { op: "del", id } });
      }
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

  // Filler bots just wander now — they no longer contest the beacon, so real
  // players can grab/plant/defend it without bots snatching it.
  botTick(dt) {
    for (const bot of this.bots) {
      bot.t -= dt;
      if (bot.t <= 0) {
        bot.t = rand(2, 5);
        bot.tx = clamp(bot.x + rand(-220, 220), 100, WORLD.W - 100);
        bot.ty = clamp(bot.y + rand(-220, 220), 100, WORLD.H - 100);
      }
      const dx = bot.tx - bot.x, dy = bot.ty - bot.y, d = Math.hypot(dx, dy) || 1;
      if (d > 4) {
        bot.x += (dx / d) * 50 * dt;
        bot.y += (dy / d) * 50 * dt;
        bot.dir = dx > 2 ? 1 : dx < -2 ? -1 : bot.dir;
      }
    }
  }

  // ---- shared monsters ----
  // Walls and (closed) doors block monsters. Monsters can't open doors, so a
  // walled fort with doors genuinely keeps them out.
  mobBlocked(x, y) {
    for (const b of this.builds.values()) {
      if (Math.abs(x - b.x) < 22 && Math.abs(y - b.y) < 22) return true;
    }
    return false;
  }

  mobMove(mob, sx, sy, sp, dt) {
    const nx = clamp(mob.x + sx * sp * dt, 40, WORLD.W - 40);
    const ny = clamp(mob.y + sy * sp * dt, 40, WORLD.H - 40);
    let mx = false, my = false;
    if (!this.mobBlocked(nx, mob.y)) { mob.x = nx; mx = true; }
    if (!this.mobBlocked(mob.x, ny)) { mob.y = ny; my = true; }
    if (!mx && !my) { // corner: try sliding perpendicular around the wall
      const px = -sy, py = sx;
      const ax = clamp(mob.x + px * sp * dt, 40, WORLD.W - 40);
      const ay = clamp(mob.y + py * sp * dt, 40, WORLD.H - 40);
      if (!this.mobBlocked(ax, ay)) { mob.x = ax; mob.y = ay; }
    }
    if (sx > 0.2) mob.dir = 1; else if (sx < -0.2) mob.dir = -1;
  }

  nearestTarget(mob) {
    let best = null, bd = Infinity;
    const consider = (e) => { const d = dist2(mob.x, mob.y, e.x, e.y); if (d < bd) { bd = d; best = e; } };
    for (const p of this.players.values()) consider(p);
    for (const b of this.bots) consider(b);
    return best;
  }

  mobTick(dt, s) {
    const esc = s.remain > 240 ? 0.3 : s.remain > 120 ? 0.6 : s.remain > 60 ? 0.85 : 1;
    const cap = Math.round(8 + esc * 14) + Math.min(12, this.players.size * 3);
    const anyone = this.players.size + this.bots.length > 0;

    // spawn over time, away from players, in open ground
    if (anyone && this.mobs.length < cap && Math.random() < dt * (1.0 + esc * 2.0)) {
      for (let k = 0; k < 12; k++) {
        const x = rand(120, WORLD.W - 120), y = rand(120, WORLD.H - 120);
        if (this.mobBlocked(x, y)) continue;
        let near = false;
        for (const p of this.players.values()) { if (dist2(x, y, p.x, p.y) < 360 ** 2) { near = true; break; } }
        if (near) continue;
        const kind = pickKind();
        this.mobs.push({ id: this._mid++, kind, x, y, dir: 1, hp: MOBS[kind].hp, maxhp: MOBS[kind].hp, t: rand(1, 3), tx: x, ty: y });
        break;
      }
    }

    for (const mob of this.mobs) {
      const st = MOBS[mob.kind] || MOBS.wolf;
      // chase the nearest survivor only when within detection range (avoidable,
      // like the original). The beacon is NOT a target — monsters never swarm it.
      const t = this.nearestTarget(mob);
      const sees = t && dist2(mob.x, mob.y, t.x, t.y) < st.detect * st.detect;
      let tx, ty;
      if (sees) { tx = t.x; ty = t.y; }
      else { // wander, drifting gently toward the nearest survivor so the island isn't dead
        mob.t -= dt;
        if (mob.t <= 0) {
          mob.t = rand(2, 4);
          if (t) {
            const ang = Math.atan2(t.y - mob.y, t.x - mob.x) + rand(-0.9, 0.9);
            mob.tx = clamp(mob.x + Math.cos(ang) * 220, 60, WORLD.W - 60);
            mob.ty = clamp(mob.y + Math.sin(ang) * 220, 60, WORLD.H - 60);
          } else {
            mob.tx = clamp(mob.x + rand(-180, 180), 60, WORLD.W - 60);
            mob.ty = clamp(mob.y + rand(-180, 180), 60, WORLD.H - 60);
          }
        }
        tx = mob.tx; ty = mob.ty;
      }
      const dx = tx - mob.x, dy = ty - mob.y, d = Math.hypot(dx, dy) || 1;
      const sp = sees ? st.sp : 42;
      if (d > 4) this.mobMove(mob, dx / d, dy / d, sp, dt);
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
      this.deadNodes.clear(); // fresh island next round
      this.builds.clear();    // forts don't carry across rounds
      this.mobs = [];
      this.slot = s;
      this.spawnBots();
      this.refreshBots();
      this.broadcast({ t: "event", kind: "reset", data: { slot: { id: s.id, remain: s.remain, seed: s.seed } } });
    }

    // respawn depleted nodes for everyone when their timer elapses
    for (const [i, at] of this.deadNodes) {
      if (nowMs >= at) {
        this.deadNodes.delete(i);
        this.broadcast({ t: "event", kind: "node", data: { i, dead: false } });
      }
    }

    const ev = advanceAirdrop(this.beacon, s.remain);
    if (ev) this.broadcast({ t: "event", kind: ev, data: { x: this.beacon.x, y: this.beacon.y } });

    this.botTick(dt);
    this.mobTick(dt, s);
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
    const mobs = this.mobs.map((m) => ({
      id: m.id, kind: m.kind, x: Math.round(m.x), y: Math.round(m.y), dir: m.dir, hp: Math.round(m.hp), maxhp: m.maxhp,
    }));
    this.broadcast({
      t: "snapshot", now: Date.now(),
      slot: { remain: s.remain, id: s.id, seed: s.seed },
      players, bots, beacon: this.beacon, mobs,
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
