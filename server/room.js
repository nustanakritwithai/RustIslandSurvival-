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
// Thai wildlife. zone = the biome risk it belongs to; w = spawn weight.
const MOBS = {
  deer:     { hp: 16,  sp: 122, dmg: 5,  r: 14, zone: 1, w: 0.5 },
  buffalo:  { hp: 55,  sp: 66,  dmg: 16, r: 18, zone: 1, w: 0.28 },
  tiger:    { hp: 46,  sp: 110, dmg: 21, r: 15, zone: 2, w: 0.14 },
  elephant: { hp: 165, sp: 60,  dmg: 28, r: 24, zone: 2, w: 0.08 },
};
// pick a monster kind that belongs in a biome of the given risk level
function pickKindForRisk(risk) {
  const pool = []; let tot = 0;
  for (const k in MOBS) { if (MOBS[k].zone <= risk) { pool.push([k, MOBS[k].w]); tot += MOBS[k].w; } }
  if (!pool.length) return null;
  let r = Math.random() * tot;
  for (const [k, w] of pool) { r -= w; if (r <= 0) return k; }
  return pool[0][0];
}

// Island biomes (mirrors the client ZONES). Each (x,y,w,h) rect has a risk level;
// monsters spawn and roam only in biomes matching their zone.
const ZONES = [
  { x: 2850, y: 1920, w: 700, h: 560, risk: 0 },   // base
  { x: 0, y: 0, w: WORLD.W, h: 360, risk: 0 },      // beaches
  { x: 0, y: WORLD.H - 360, w: WORLD.W, h: 360, risk: 0 },
  { x: 0, y: 360, w: 320, h: WORLD.H - 720, risk: 0 },
  { x: WORLD.W - 320, y: 360, w: 320, h: WORLD.H - 720, risk: 0 },
  { x: 320, y: 360, w: WORLD.W - 640, h: WORLD.H - 720, risk: 1 }, // forest
  { x: 640, y: 1560, w: 1500, h: 1280, risk: 2 },   // mine west
  { x: WORLD.W - 2140, y: 1560, w: 1500, h: 1280, risk: 2 }, // mine east
  { x: 2380, y: 560, w: 1640, h: 1080, risk: 2 },   // swamp
  { x: 2380, y: WORLD.H - 1640, w: 1640, h: 1080, risk: 3 }, // ashlands
];
// matches client zoneAt: base first, then the smallest matching biome wins
function zoneInfoAt(x, y) {
  const inZ = (z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h;
  if (inZ(ZONES[0])) return ZONES[0];
  let pick = null;
  for (let i = 1; i < ZONES.length; i++) {
    const z = ZONES[i];
    if (inZ(z) && (!pick || z.w * z.h < pick.w * pick.h)) pick = z;
  }
  return pick || { x: 0, y: 0, w: WORLD.W, h: WORLD.H, risk: 0 };
}
const botName = () => BOT_NAMES_A[ri(0, BOT_NAMES_A.length - 1)] + BOT_NAMES_B[ri(0, BOT_NAMES_B.length - 1)];

// Bot crafting progression: after `t` seconds spent prepping at their base the
// bot "crafts" the next tier (visible to players: held weapon + worn armor in
// the snapshot, and better loot when the bot is killed).
const BOT_GEAR = [
  { t: 0,   w: "wooden_spear" },
  { t: 25,  w: "machete" },
  { t: 60,  w: "machete",    bd: "leather_armor" },
  { t: 100, w: "thai_sword", bd: "leather_armor", hd: "leather_helm" },
  { t: 150, w: "pistol",     bd: "leather_armor", hd: "iron_helm" },
  { t: 210, w: "rifle",      bd: "iron_armor",    hd: "iron_helm" },
];

export class GameRoom {
  constructor() {
    this.players = new Map(); // id -> {ws,name,x,y,dir,hp,carrying,last}
    this.bots = [];
    this.deadNodes = new Map(); // node index -> respawn-at ms (shared resource depletion)
    this.builds = new Map();    // id -> {id,t,x,y,hp} shared walls/doors (shared forts)
    this._bid = 1;
    this.mobs = [];             // shared authoritative monsters
    this._mid = 1;
    this._botSeq = 1;           // unique bot ids across respawns
    this._botRespawnAt = null;  // pending bot respawn after one is killed
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
        x: WORLD.W / 2, y: WORLD.H / 2, dir: 1, hp: 100, carrying: false, skin: 0,
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
      // Ignore one-off absurd jumps but accept normal movement. Legit teleports
      // (first sync after join, respawn at base) repeat the same far position on
      // the next update ~100ms later, so a jump confirmed twice is accepted.
      if (Math.abs(nx - p.x) < POS_MAX_JUMP && Math.abs(ny - p.y) < POS_MAX_JUMP) {
        p.x = nx; p.y = ny; p.pend = null;
      } else if (p.pend && Math.abs(nx - p.pend.x) < POS_MAX_JUMP && Math.abs(ny - p.pend.y) < POS_MAX_JUMP) {
        p.x = nx; p.y = ny; p.pend = null;
      } else {
        p.pend = { x: nx, y: ny };
      }
      p.dir = m.dir === -1 ? -1 : 1;
      p.hp = clamp(+m.hp || 0, 0, 999);
      p.carrying = !!m.carrying;
      p.skin = m.skin | 0;
      // death drops the beacon: a dead carrier can't keep it through respawn
      if (p.hp <= 0 && this.beacon.state === "carried" && this.beacon.owner === ws.id) {
        dropBeacon(this.beacon, p.x, p.y);
        this.broadcast({ t: "event", kind: "beaconDown", data: { x: this.beacon.x, y: this.beacon.y } });
      }
    } else if (m.t === "beacon") {
      const changed = handleBeaconAction(this.beacon, { id: ws.id, x: p.x, y: p.y }, m.action);
      if (changed) this.broadcastSnapshot();
    } else if (m.t === "beaconDmg") {
      // only non-owners standing next to a planted beacon can chip it, with a
      // sane per-hit cap (clients can't nuke it remotely / instantly)
      const amt = clamp(+m.amt || 0, 0, 60);
      if (amt > 0 && this.beacon.owner !== ws.id && this.beacon.state === "planted" &&
          dist2(this.beacon.x, this.beacon.y, p.x, p.y) < 90 * 90 &&
          damageBeacon(this.beacon, amt)) {
        this.broadcast({ t: "event", kind: "beaconDown", data: { x: this.beacon.x, y: this.beacon.y } });
      }
    } else if (m.t === "node") {
      // a player harvested node #i; deplete it for everyone until it respawns.
      // Rate-limited per player: a legit harvest takes several hits, so nodes
      // can't finish faster than this (blocks deplete-the-island spam).
      const nowT = Date.now();
      if (p.lastNodeAt && nowT - p.lastNodeAt < 250) return;
      const i = m.i | 0;
      const rt = clamp(+m.rt || 30, 1, 600);
      if (i >= 0 && i < 20000 && !this.deadNodes.has(i)) {
        p.lastNodeAt = nowT;
        this.deadNodes.set(i, Date.now() + rt * 1000);
        this.broadcast({ t: "event", kind: "node", data: { i, dead: true } });
      }
    } else if (m.t === "build") {
      this.handleBuild(m, p);
    } else if (m.t === "mobHit") {
      // player-reported damage on a shared monster; server is authoritative on
      // death. Cap per-hit damage near the strongest legit weapon and require
      // the reporter to be within max weapon range of the monster.
      const id = m.id | 0;
      const dmg = clamp(+m.dmg || 0, 0, 120);
      const i = this.mobs.findIndex((x) => x.id === id);
      if (i >= 0 && dist2(this.mobs[i].x, this.mobs[i].y, p.x, p.y) < 900 * 900) {
        this.mobs[i].hp -= dmg;
        this.mobs[i].aggroId = ws.id; // provoked: now it fights back and chases you
        this.mobs[i].aggroT = 8;
        if (this.mobs[i].hp <= 0) {
          const dead = this.mobs.splice(i, 1)[0];
          this.broadcast({
            t: "event", kind: "mob",
            data: { op: "del", id: dead.id, kind: dead.kind, x: Math.round(dead.x), y: Math.round(dead.y), killer: ws.id },
          });
        }
      }
    } else if (m.t === "botHit") {
      // players can fight bots (essential counterplay now that bots contest the
      // beacon). Same caps as mobHit; death drops the beacon + gear loot.
      const dmg = clamp(+m.dmg || 0, 0, 120);
      const i = this.bots.findIndex((b) => b.id === m.id);
      if (i >= 0 && dmg > 0 && dist2(this.bots[i].x, this.bots[i].y, p.x, p.y) < 900 * 900) {
        const bot = this.bots[i];
        bot.hp -= dmg;
        if (bot.hp <= 0) {
          if (this.beacon.owner === bot.id &&
              (this.beacon.state === "carried" || this.beacon.state === "planted")) {
            dropBeacon(this.beacon, bot.x, bot.y);
            this.broadcast({ t: "event", kind: "beaconDown", data: { x: this.beacon.x, y: this.beacon.y } });
          }
          const g = BOT_GEAR[bot.gear] || BOT_GEAR[0];
          const loot = [{ id: "rope", n: 2 }, { id: "cooked_meat", n: ri(1, 2) }];
          if (bot.gear >= 2) loot.push({ id: "animal_hide", n: 2 });
          if (bot.gear >= 4) loot.push({ id: "bullet", n: ri(4, 9) });
          if (g.w) loot.push({ id: g.w, n: 1 });
          this.broadcast({
            t: "event", kind: "bot",
            data: { op: "del", id: bot.id, name: bot.name, x: Math.round(bot.x), y: Math.round(bot.y), killer: ws.id, loot },
          });
          this.bots.splice(i, 1);
          this._botRespawnAt = Date.now() + 25000; // a fresh rival lands later
        }
      }
    } else if (m.t === "ping") {
      ws.send(encode({ t: "pong" }));
    }
  }

  // Shared walls/doors so forts are visible to everyone (and, later, so
  // server-side monsters can path around them).
  handleBuild(m, p) {
    if (m.op === "add") {
      const bt = m.bt === "door" ? "door" : m.bt === "wall" ? "wall" : null;
      if (!bt) return;
      const x = clamp(Math.round(+m.x || 0), 0, WORLD.W);
      const y = clamp(Math.round(+m.y || 0), 0, WORLD.H);
      // must be placed next to the builder (grid snap is ~1 tile ahead)
      if (!p || dist2(x, y, p.x, p.y) > 160 * 160) return;
      // no stacking on the same tile
      for (const b of this.builds.values()) {
        if (Math.abs(b.x - x) < 8 && Math.abs(b.y - y) < 8) return;
      }
      if (this.builds.size > 4000) return; // hard cap
      const b = { id: this._bid++, t: bt, x, y, hp: bt === "wall" ? 300 : 200, o: m.o ? 1 : 0 };
      this.builds.set(b.id, b);
      this.broadcast({ t: "event", kind: "build", data: { op: "add", b } });
    } else if (m.op === "del") {
      const id = m.id | 0;
      const b = this.builds.get(id);
      if (!b) return;
      // demolish/chop happen adjacent; a thrown bomb reaches ~280px — beyond
      // that the delete is not something an honest client can produce
      if (!p || dist2(b.x, b.y, p.x, p.y) > 350 * 350) return;
      this.builds.delete(id);
      this.broadcast({ t: "event", kind: "build", data: { op: "del", id } });
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

  // ---- server bots: full survivors that gather, build a base (table/furnace/
  // box), craft up a gear ladder, wall in, and contest the beacon like players ----
  mkBot() {
    const edge = ri(0, 3);
    let x, y;
    if (edge === 0) { x = rand(120, WORLD.W - 120); y = 120; }
    else if (edge === 1) { x = rand(120, WORLD.W - 120); y = WORLD.H - 120; }
    else if (edge === 2) { x = 120; y = rand(120, WORLD.H - 120); }
    else { x = WORLD.W - 120; y = rand(120, WORLD.H - 120); }
    // home base somewhere in the forest ring at a mid distance from the centre
    const a = Math.random() * Math.PI * 2, r = rand(700, 1400);
    const hx = clamp(WORLD.W / 2 + Math.cos(a) * r, 520, WORLD.W - 520);
    const hy = clamp(WORLD.H / 2 + Math.sin(a) * r, 520, WORLD.H - 520);
    return {
      id: "bot" + (this._botSeq++), name: botName(), x, y, dir: 1, hp: 120, maxhp: 120,
      col: BOT_COLS[this._botSeq % BOT_COLS.length], t: rand(1, 3), tx: x, ty: y,
      home: { x: Math.round(hx / 40) * 40, y: Math.round(hy / 40) * 40 },
      phase: "gather", work: 0, harvestT: 0, buildStep: 0, buildT: 0,
      prepT: 0, gear: 0, hitT: 0, contestDelay: rand(2, 6),
      fortStep: 0, fortT: 0, wob: rand(0, 6),
    };
  }

  spawnBots() {
    this.bots = [];
    for (let i = 0; i < FILL_BOTS_TO; i++) this.bots.push(this.mkBot());
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
    } else {
      while (this.bots.length < want) this.bots.push(this.mkBot());
      while (this.bots.length > want) {
        const rm = this.bots.pop();
        if (this.beacon.owner === rm.id) dropBeacon(this.beacon, rm.x, rm.y);
      }
    }
  }

  // Bots place real shared structures so every player sees their base grow.
  addBotBuild(t, x, y, o = 0) {
    x = clamp(Math.round(x / 40) * 40, 80, WORLD.W - 80);
    y = clamp(Math.round(y / 40) * 40, 80, WORLD.H - 80);
    for (const b of this.builds.values()) {
      if (Math.abs(b.x - x) < 8 && Math.abs(b.y - y) < 8) return;
    }
    if (this.builds.size > 4000) return;
    const b = { id: this._bid++, t, x, y, hp: t === "wall" ? 300 : 200, o };
    this.builds.set(b.id, b);
    this.broadcast({ t: "event", kind: "build", data: { op: "add", b } });
  }

  botGoal(bot, bcn, remain) {
    // ---- beacon behaviours override the life sim once the airdrop starts ----
    if (bcn.state === "carried" && bcn.owner === bot.id) {
      bcn.x = bot.x; bcn.y = bot.y;
      const h = bot.home;
      if (dist2(bot.x, bot.y, h.x, h.y) < 34 * 34) {
        bcn.state = "planted"; bcn.x = h.x; bcn.y = h.y;
        bcn.hp = 260; bcn.maxhp = 260;
        bot.fortStep = 0; bot.fortT = 0.4;
        return null;
      }
      return { x: h.x, y: h.y, sp: 78 };                 // haul it home
    }
    if (bcn.state === "planted" && bcn.owner === bot.id) {
      // wall the beacon in with a tight contiguous ring (south door), then patrol
      if (bot.fortStep < 8 && bot.fortT <= 0) {
        const R = 40, pts = [[-R, -R], [0, -R], [R, -R], [R, 0], [R, R], [-R, R], [-R, 0], [0, R]];
        const o = pts[bot.fortStep];
        const vert = o[1] === 0 ? 1 : 0; // side pieces stand vertical, top/bottom lie flat
        this.addBotBuild(bot.fortStep === 7 ? "door" : "wall", bcn.x + o[0], bcn.y + o[1], vert);
        // shove rival bots out of the ring so they can't get walled in with it
        for (const rb of this.bots) {
          if (rb === bot) continue;
          const dd = Math.hypot(rb.x - bcn.x, rb.y - bcn.y);
          if (dd < 64) {
            const a2 = Math.atan2(rb.y - bcn.y, rb.x - bcn.x) || rand(0, Math.PI * 2);
            rb.x = clamp(bcn.x + Math.cos(a2) * 110, 60, WORLD.W - 60);
            rb.y = clamp(bcn.y + Math.sin(a2) * 110, 60, WORLD.H - 60);
          }
        }
        bot.fortStep++; bot.fortT = 0.9;
      }
      const a = Date.now() / 700 + bot.wob;
      return { x: bcn.x + Math.cos(a) * 14, y: bcn.y + Math.sin(a) * 14, sp: 30 };
    }
    if (bcn.state === "planted" && bcn.owner !== bot.id) {
      const d2 = dist2(bot.x, bot.y, bcn.x, bcn.y);
      if (d2 < 30 * 30 && bot.hitT <= 0) {
        bot.hitT = 1.2;                                   // smash the rival's beacon
        if (damageBeacon(this.beacon, 5)) {
          this.broadcast({ t: "event", kind: "beaconDown", data: { x: bcn.x, y: bcn.y } });
        }
      } else if (d2 < 150 * 150 && bot.hitT <= 0) {
        // fort in the way: besiege the nearest wall/door piece to breach it
        let best = null, bd = 60 * 60;
        for (const b of this.builds.values()) {
          if (b.t !== "wall" && b.t !== "door") continue;
          const dd = dist2(b.x, b.y, bot.x, bot.y);
          if (dd < bd) { bd = dd; best = b; }
        }
        if (best) {
          bot.hitT = 0.9; best.hp -= 12;
          if (best.hp <= 0) {
            this.builds.delete(best.id);
            this.broadcast({ t: "event", kind: "build", data: { op: "del", id: best.id } });
          }
        }
      }
      return { x: bcn.x, y: bcn.y, sp: 100 };
    }
    if (bcn.state === "crate") {
      if (bot.contestDelay > 0) return null;              // give humans a head start
      if (dist2(bot.x, bot.y, bcn.x, bcn.y) < 26 * 26) {
        bcn.state = "carried"; bcn.owner = bot.id;
        return null;
      }
      return { x: bcn.x, y: bcn.y, sp: 100 };
    }
    if (bcn.state === "carried" && bcn.owner && bcn.owner !== bot.id) {
      const hu = this.players.get(bcn.owner);             // pressure the carrier
      const ob = hu ? null : this.bots.find((b2) => b2.id === bcn.owner);
      const cx = hu ? hu.x : ob ? ob.x : null;
      if (cx != null) return { x: cx, y: hu ? hu.y : ob.y, sp: 95 };
      return null;
    }
    if (bcn.state === "incoming") return { x: bcn.x, y: bcn.y, sp: 85 };

    // ---- life sim: gather resources -> build home stations -> craft gear ----
    if (bot.phase === "gather") {
      bot.work = bot.work || 0;
      if (bot.work > 28 || remain < 540) { bot.phase = "build"; return null; }
      if (bot.harvestT > 0) return { x: bot.x, y: bot.y, sp: 0 }; // busy "harvesting"
      if (bot.t <= 0 || dist2(bot.x, bot.y, bot.tx, bot.ty) < 20 * 20) {
        if (Math.random() < 0.55) bot.harvestT = rand(1.6, 3.2); // stop & "harvest"
        bot.t = rand(3, 6);
        bot.tx = clamp(bot.home.x + rand(-520, 520), 120, WORLD.W - 120);
        bot.ty = clamp(bot.home.y + rand(-520, 520), 120, WORLD.H - 120);
      }
      return { x: bot.tx, y: bot.ty, sp: 60 };
    }
    if (bot.phase === "build") {
      const h = bot.home;
      if (dist2(bot.x, bot.y, h.x, h.y) > 40 * 40) return { x: h.x, y: h.y, sp: 72 };
      if (bot.buildT <= 0) {
        const spots = [["table", -120, 0], ["furnace", 120, 0], ["box", 0, 120]]; // outside the future fort ring
        if (bot.buildStep < spots.length) {
          const sp2 = spots[bot.buildStep];
          this.addBotBuild(sp2[0], h.x + sp2[1], h.y + sp2[2]);
          bot.buildStep++; bot.buildT = 2.2;
        } else bot.phase = "prep";
      }
      return { x: h.x, y: h.y, sp: 0 };
    }
    // prep: hang around the crafting table levelling gear, patch up with herbs
    const h = bot.home, a = Date.now() / 900 + bot.wob;
    return { x: h.x + Math.cos(a) * 40, y: h.y + Math.sin(a) * 40, sp: 30 };
  }

  botTick(dt, s) {
    const bcn = this.beacon;
    const remain = s ? s.remain : slotInfo().remain;
    for (const bot of this.bots) {
      bot.hitT = Math.max(0, (bot.hitT || 0) - dt);
      bot.fortT = Math.max(0, (bot.fortT || 0) - dt);
      bot.contestDelay = Math.max(0, (bot.contestDelay || 0) - dt);
      bot.t -= dt;
      if (bot.harvestT > 0) { bot.harvestT -= dt; bot.work = (bot.work || 0) + dt; }
      if (bot.phase === "build") bot.buildT = Math.max(0, (bot.buildT || 0) - dt);
      if (bot.phase === "prep") {
        bot.prepT += dt;                                   // crafting montage
        while (bot.gear < BOT_GEAR.length - 1 && bot.prepT > BOT_GEAR[bot.gear + 1].t) bot.gear++;
        if (bot.hp < bot.maxhp) bot.hp = Math.min(bot.maxhp, bot.hp + dt * 2); // herbal medicine
      }
      const goal = this.botGoal(bot, bcn, remain);
      if (goal && goal.sp > 0) {
        const dx = goal.x - bot.x, dy = goal.y - bot.y, d = Math.hypot(dx, dy) || 1;
        // bots respect walls like monsters do (mobMove slides along them), so a
        // player's fort genuinely holds them off until they besiege it down;
        // slim pad lets them slip through a single broken wall tile
        if (d > 4) this.mobMove(bot, dx / d, dy / d, goal.sp, dt, 6);
      }
      // deadlock safety: a carrier pinned by walls (e.g. trapped inside a rival
      // fort it breached) gives up the crate after ~5s so the round keeps moving
      if (bcn.state === "carried" && bcn.owner === bot.id) {
        bot._ckT = (bot._ckT || 0) + dt;
        if (bot._ckT >= 5) {
          if (Math.hypot(bot.x - (bot._ckX ?? bot.x), bot.y - (bot._ckY ?? bot.y)) < 15 &&
              dist2(bot.x, bot.y, bot.home.x, bot.home.y) > 60 * 60) {
            dropBeacon(this.beacon, bot.x, bot.y);
            bot.contestDelay = 8; // let someone else take it this time
            this.broadcast({ t: "event", kind: "beaconDown", data: { x: this.beacon.x, y: this.beacon.y } });
          }
          bot._ckT = 0; bot._ckX = bot.x; bot._ckY = bot.y;
        }
      } else { bot._ckT = 0; bot._ckX = bot.x; bot._ckY = bot.y; }
    }
  }

  // ---- shared monsters ----
  // Walls and (closed) doors block monsters. Monsters can't open doors, so a
  // walled fort with doors genuinely keeps them out.
  // pad lets callers reserve space for a body radius so monsters can't clip into
  // a wall or squeeze through the diagonal gap between two wall tiles.
  mobBlocked(x, y, pad = 0) {
    const r = 22 + pad;
    for (const b of this.builds.values()) {
      if (Math.abs(x - b.x) < r && Math.abs(y - b.y) < r) return true;
    }
    return false;
  }

  mobMove(mob, sx, sy, sp, dt, pad) {
    if (pad == null) pad = (MOBS[mob.kind] || MOBS.deer).r; // collide using the body radius
    const nx = clamp(mob.x + sx * sp * dt, 40, WORLD.W - 40);
    const ny = clamp(mob.y + sy * sp * dt, 40, WORLD.H - 40);
    let mx = false, my = false;
    if (!this.mobBlocked(nx, mob.y, pad)) { mob.x = nx; mx = true; }
    if (!this.mobBlocked(mob.x, ny, pad)) { mob.y = ny; my = true; }
    if (!mx && !my) { // corner: try sliding perpendicular around the wall
      const px = -sy, py = sx;
      const ax = clamp(mob.x + px * sp * dt, 40, WORLD.W - 40);
      const ay = clamp(mob.y + py * sp * dt, 40, WORLD.H - 40);
      if (!this.mobBlocked(ax, ay, pad)) { mob.x = ax; mob.y = ay; }
    }
    if (sx > 0.2) mob.dir = 1; else if (sx < -0.2) mob.dir = -1;
  }

  mobTick(dt, s) {
    const esc = s.remain > 240 ? 0.3 : s.remain > 120 ? 0.6 : s.remain > 60 ? 0.85 : 1;
    const cap = Math.round(12 + esc * 14) + Math.min(12, this.players.size * 3);
    const anyone = this.players.size + this.bots.length > 0;

    // spawn in the right biome for the kind, away from players, in open ground
    if (anyone && this.mobs.length < cap && Math.random() < dt * (1.6 + esc * 2.2)) {
      for (let k = 0; k < 14; k++) {
        const x = rand(120, WORLD.W - 120), y = rand(120, WORLD.H - 120);
        if (this.mobBlocked(x, y, 60)) continue; // keep spawns clear of walls/forts
        const zi = zoneInfoAt(x, y);
        if (zi.risk < 1) continue;               // no monsters on beach / base / sea
        const kind = pickKindForRisk(zi.risk);
        if (!kind) continue;
        let near = false;
        for (const p of this.players.values()) { if (dist2(x, y, p.x, p.y) < 240 ** 2) { near = true; break; } }
        if (near) continue;
        this.mobs.push({
          id: this._mid++, kind, x, y, dir: 1, hp: MOBS[kind].hp, maxhp: MOBS[kind].hp,
          t: rand(1, 3), tx: x, ty: y,
          zr: { x: zi.x, y: zi.y, w: zi.w, h: zi.h, risk: zi.risk }, // home biome to roam within
          aggroId: null, aggroT: 0,
        });
        break;
      }
    }

    for (const mob of this.mobs) {
      const st = MOBS[mob.kind] || MOBS.deer;
      mob.aggroT = Math.max(0, (mob.aggroT || 0) - dt);
      // Passive by default: monsters roam their own biome and ignore players.
      // They only chase the player who provoked them (hit them), for a while.
      const prey = mob.aggroT > 0 && mob.aggroId ? this.players.get(mob.aggroId) : null;
      let tx, ty;
      if (prey) { tx = prey.x; ty = prey.y; }
      else { // wander within the home biome rect
        mob.t -= dt;
        if (mob.t <= 0) {
          mob.t = rand(2, 5);
          const zr = mob.zr || { x: 0, y: 0, w: WORLD.W, h: WORLD.H };
          mob.tx = clamp(mob.x + rand(-200, 200), zr.x + 30, zr.x + zr.w - 30);
          mob.ty = clamp(mob.y + rand(-200, 200), zr.y + 30, zr.y + zr.h - 30);
        }
        tx = mob.tx; ty = mob.ty;
      }
      const dx = tx - mob.x, dy = ty - mob.y, d = Math.hypot(dx, dy) || 1;
      const sp = prey ? st.sp : 36;
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
      // Bot wins only count when a human was around to be beaten — otherwise
      // an idle server would fill the board with bot names overnight.
      if (winner.isHuman || this.players.size > 0) this.board.push(winner.name, 200);
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
    if (ev) {
      this.broadcast({ t: "event", kind: ev, data: { x: this.beacon.x, y: this.beacon.y } });
      // bots hesitate a few seconds after the crate lands so humans get a shot
      if (ev === "landed") for (const b of this.bots) b.contestDelay = rand(3, 8);
    }

    // replace a killed bot after a delay (refreshBots respects human count)
    if (this._botRespawnAt && nowMs >= this._botRespawnAt) {
      this._botRespawnAt = null;
      this.refreshBots();
    }

    this.botTick(dt, s);
    this.mobTick(dt, s);
    this.broadcastSnapshot(s);
  }

  broadcastSnapshot(s = slotInfo()) {
    const players = [];
    for (const [id, p] of this.players) {
      players.push({ id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, hp: p.hp, carrying: p.carrying, skin: p.skin || 0 });
    }
    const bots = this.bots.map((b) => {
      const g = BOT_GEAR[b.gear] || BOT_GEAR[0];
      return {
        id: b.id, name: b.name, x: Math.round(b.x), y: Math.round(b.y), dir: b.dir,
        hp: Math.round(b.hp), maxhp: b.maxhp, col: b.col,
        carrying: this.beacon.owner === b.id && this.beacon.state === "carried",
        w: g.w, bd: g.bd, hd: g.hd, // crafted gear (visible weapon + armor)
      };
    });
    const mobs = this.mobs.map((m) => ({
      id: m.id, kind: m.kind, x: Math.round(m.x), y: Math.round(m.y), dir: m.dir, hp: Math.round(m.hp), maxhp: m.maxhp,
      ag: m.aggroT > 0 ? 1 : 0, // 1 = provoked (will attack); 0 = passive
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
