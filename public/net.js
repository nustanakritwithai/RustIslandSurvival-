/* ===========================================================================
   net.js — WebSocket client layer for Last Short Island multiplayer.

   Network goal: keep the original game running offline and only sync shared
   state when a WebSocket server is available.

   Visual patch note: this file also installs a late, graphics-only renderer
   patch after public/index.html finishes loading. The patch does not change
   gameplay, server messages, combat, inventory, crafting, or multiplayer state.
   =========================================================================== */
(function () {
  "use strict";

  var WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host + "/ws";

  var NET = {
    ws: null,
    id: null,
    name: "",
    connected: false,
    players: new Map(),   // id -> {x,y,tx,ty,dir,hp,maxhp,name,col,dmgT,carrying}
    botMap: new Map(),    // id -> same shape (server bots)
    mobById: new Map(),   // server mob id -> the G.wolves entry it drives
    serverBeacon: null,
    serverRound: null,
    board: null,
    _posTimer: null,
  };
  window.NET = NET;

  var HUMAN_COLS = ["#2f7fb0", "#b06a2f", "#4a9d4a", "#9d4a8f", "#b0a02f", "#3aa0a0"];
  function humanCol(id) {
    id = String(id || "player");
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return HUMAN_COLS[h % HUMAN_COLS.length];
  }

  function netSend(o) {
    if (NET.connected && NET.ws && NET.ws.readyState === 1) {
      try { NET.ws.send(JSON.stringify(o)); } catch (e) { /* ignore */ }
    }
  }
  window.netSend = netSend;

  function netConnect(name) {
    NET.name = name || NET.name || "player";
    try { NET.ws = new WebSocket(WS_URL); }
    catch (e) { NET.connected = false; return; }

    NET.ws.onopen = function () {
      NET.connected = true;
      netSend({ t: "join", name: NET.name });
      if (typeof toast === "function") toast("🌐 เชื่อมต่อเซิร์ฟเวอร์แล้ว");
    };
    NET.ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      netHandle(m);
    };
    NET.ws.onclose = function () {
      NET.connected = false;
      NET.players.clear();
      NET.botMap.clear();
      setTimeout(function () { netConnect(NET.name); }, 1500);
    };
    NET.ws.onerror = function () { /* onclose handles retry */ };
  }
  window.netConnect = netConnect;

  function netOnDeploy() {
    var name = (typeof G !== "undefined" && G.playerName) ? G.playerName : "player";
    NET.name = name;
    if (!NET.ws || NET.ws.readyState > 1) netConnect(name);
    else if (NET.connected) netSend({ t: "join", name: name });
    netStartPosLoop();
  }
  window.netOnDeploy = netOnDeploy;

  function netStartPosLoop() {
    if (NET._posTimer) return;
    NET._posTimer = setInterval(function () {
      if (!NET.connected || typeof G === "undefined" || !G.player) return;
      var p = G.player;
      netSend({
        t: "pos",
        x: Math.round(p.x), y: Math.round(p.y), dir: p.dir,
        hp: Math.round(p.hp),
        carrying: G.beacon && G.beacon.state === "carried" && G.beacon.owner === NET.id,
      });
    }, 100);
  }

  function netHandle(m) {
    if (!m || !m.t) return;
    if (m.t === "welcome") {
      NET.id = m.id;
      if (m.slot) applyWorldSeed(m.slot.seed);
      if (m.nodes) applyDeadNodes(m.nodes);
      if (m.builds) applyBuilds(m.builds);
      if (m.board) { NET.board = m.board; refreshBoardUI(); }
    } else if (m.t === "snapshot") {
      applySnapshot(m);
    } else if (m.t === "event") {
      handleEvent(m);
    } else if (m.t === "board") {
      NET.board = m.winners;
      refreshBoardUI();
    }
  }

  function applySnapshot(m) {
    NET.serverBeacon = m.beacon;
    NET.serverRound = m.slot;
    if (m.slot) applyWorldSeed(m.slot.seed);

    var seen = {};
    var players = Array.isArray(m.players) ? m.players : [];
    for (var i = 0; i < players.length; i++) {
      var pl = players[i];
      if (pl.id === NET.id) continue;
      seen[pl.id] = 1;
      var e = NET.players.get(pl.id);
      if (!e) { e = { x: pl.x, y: pl.y }; NET.players.set(pl.id, e); }
      e.id = pl.id; e.name = pl.name; e.tx = pl.x; e.ty = pl.y;
      e.dir = pl.dir; e.hp = pl.hp; e.maxhp = 100; e.dmgT = 0;
      e.carrying = pl.carrying; e.col = e.col || humanCol(pl.id);
    }
    NET.players.forEach(function (v, k) { if (!seen[k]) NET.players.delete(k); });

    var bseen = {};
    var bots = Array.isArray(m.bots) ? m.bots : [];
    for (var j = 0; j < bots.length; j++) {
      var bt = bots[j];
      bseen[bt.id] = 1;
      var b = NET.botMap.get(bt.id);
      if (!b) { b = { x: bt.x, y: bt.y }; NET.botMap.set(bt.id, b); }
      b.id = bt.id; b.name = bt.name; b.tx = bt.x; b.ty = bt.y;
      b.dir = bt.dir; b.hp = bt.hp; b.maxhp = bt.maxhp || 90;
      b.col = bt.col; b.dmgT = 0; b.carrying = bt.carrying;
    }
    NET.botMap.forEach(function (v, k) { if (!bseen[k]) NET.botMap.delete(k); });

    if (m.mobs) applyMobs(m.mobs);
  }

  function applyMobs(list) {
    if (typeof G === "undefined" || !G.wolves) return;
    list = Array.isArray(list) ? list : [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var sm = list[i];
      seen[sm.id] = 1;
      var w = NET.mobById.get(sm.id);
      if (!w) {
        w = { kind: sm.kind, x: sm.x, y: sm.y, vx: 0, vy: 0, hp: sm.hp, maxhp: sm.maxhp,
          state: "chase", t: 0, tx: sm.x, ty: sm.y, hitT: 0, dmgT: 0, spitT: 0, mode: null,
          modeT: 0, cd: 0, wob: Math.random() * 6, dvx: 0, dvy: 0, flank: 0, nid: sm.id };
        NET.mobById.set(sm.id, w);
        G.wolves.push(w);
      }
      w.kind = sm.kind; w.tx = sm.x; w.ty = sm.y; w.dir = sm.dir;
      w.maxhp = sm.maxhp; w.hp = sm.hp;
      w.aggro = !!sm.ag;
      w.state = sm.ag ? "chase" : "wander";
    }
    NET.mobById.forEach(function (w, id) {
      if (!seen[id]) { removeFrom(G.wolves, w); NET.mobById.delete(id); }
    });
  }
  function removeFrom(arr, item) { var i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); }

  function handleEvent(m) {
    var d = m.data || {};
    if (m.kind === "airdrop") {
      if (typeof toast === "function") toast("📡 AIRDROP กำลังมา! ตัวส่งสัญญาณจะตกกลางเกาะ");
    } else if (m.kind === "landed") {
      if (typeof toast === "function") toast("📦 Airdrop ตกแล้ว! ไปเก็บ 📡 ก่อนคนอื่น");
    } else if (m.kind === "win") {
      onServerWin(d);
    } else if (m.kind === "node") {
      setNodeDead(d.i, d.dead);
    } else if (m.kind === "build") {
      if (d.op === "add") addNetBuild(d.b);
      else if (d.op === "del") delNetBuild(d.id);
    } else if (m.kind === "mob") {
      if (d.op === "del") onMobDeath(d);
    } else if (m.kind === "reset") {
      NET.serverBeacon = { state: "none" };
      if (typeof G !== "undefined") {
        if (G.wolves) { G.wolves = G.wolves.filter(function (w) { return w.nid == null; }); NET.mobById.clear(); }
        if (G.buildings) G.buildings = G.buildings.filter(function (b) { return !b.net; });
        if (d.slot && d.slot.id) G.round.slot = d.slot.id;
        if (d.slot) applyWorldSeed(d.slot.seed);
        if (G.round && G.round.active) G.beacon = { state: "none" };
      }
    }
  }

  function onServerWin(d) {
    if (typeof G === "undefined") return;
    if (!G.round.active || G.dead) return;
    if (d.winnerId && d.winnerId === NET.id) {
      if (typeof winRound === "function") winRound();
    } else {
      netLose(d.winnerName);
    }
  }

  function netLose(winnerName) {
    var p = G.player;
    var bag = G.inv.map(function (s) { return { id: s.id, n: s.n }; });
    if (typeof dropEquipInto === "function") dropEquipInto(bag);
    var lostVal = (typeof bagValue === "function") ? bagValue(bag) : 0;
    G.inv.length = 0;
    if (bag.length) G.loot.push({ x: p.x, y: p.y, items: bag, t: 150, corpse: true });
    G.beacon = { state: "none" };
    if (typeof sfx === "function") sfx("lose");
    if (typeof recordRun === "function") recordRun(winnerName ? "botwin" : "timeout",
      { lost: bag, lostVal: lostVal, winner: winnerName || "" });
  }

  function setNodeDead(i, dead) {
    if (typeof G === "undefined" || !G.nodes || i == null) return;
    var n = G.nodes[i];
    if (!n) return;
    if (dead) n.dead = true;
    else { n.dead = false; n.hp = n.maxhp; }
  }
  function applyDeadNodes(list) { list = Array.isArray(list) ? list : []; for (var i = 0; i < list.length; i++) setNodeDead(list[i], true); }

  function addNetBuild(b) {
    if (typeof G === "undefined" || !G.buildings || !b) return;
    if (G.buildings.some(function (x) { return x.nid === b.id; })) return;
    var pend = G.buildings.find(function (x) {
      return x.net && x.pending && x.nid == null && Math.abs(x.x - b.x) < 8 && Math.abs(x.y - b.y) < 8;
    });
    if (pend) { pend.nid = b.id; pend.pending = false; return; }
    G.buildings.push({ type: b.t, x: b.x, y: b.y, hp: b.hp, maxhp: b.hp, open: false, net: true, nid: b.id });
  }
  function delNetBuild(id) {
    if (typeof G === "undefined" || !G.buildings) return;
    var i = G.buildings.findIndex(function (x) { return x.nid === id; });
    if (i >= 0) G.buildings.splice(i, 1);
  }
  function applyBuilds(list) { list = Array.isArray(list) ? list : []; for (var i = 0; i < list.length; i++) addNetBuild(list[i]); }

  function applyWorldSeed(seed) {
    if (seed == null || typeof G === "undefined" || typeof regenWorld !== "function") return;
    if (G.worldSeed === seed) return;
    regenWorld(seed);
  }

  function onMobDeath(d) {
    if (typeof G === "undefined") return;
    var w = NET.mobById.get(d.id);
    if (w) { removeFrom(G.wolves, w); NET.mobById.delete(d.id); }
    if (typeof spawnFx === "function") spawnFx(d.x, d.y, 6, "#c4452f", { spMin: 40, spMax: 120, grav: 140, lifeMin: 0.25, lifeMax: 0.5 });
    if (d.killer && d.killer === NET.id) {
      if (G.stats) G.stats.kills++;
      var m = (typeof MOB_TYPES !== "undefined") ? MOB_TYPES[d.kind] : null;
      var drop = [];
      if (m) {
        var mt = (typeof ri === "function") ? ri(m.meat[0], m.meat[1]) : 1;
        if (mt > 0) drop.push({ id: "raw_meat", n: mt });
        if (Math.random() < m.hide) drop.push({ id: "animal_hide", n: 1 });
        if (d.kind === "elephant" && Math.random() < 0.5) drop.push({ id: "iron_ore", n: 1 });
      } else drop.push({ id: "raw_meat", n: 1 });
      if (drop.length && G.loot) G.loot.push({ x: d.x, y: d.y, items: drop, t: 60, wolf: true });
    }
  }

  function refreshBoardUI() {
    var el = document.getElementById("board");
    if (el && typeof renderBoard === "function") renderBoard();
  }

  function netApplyBeacon() {
    var sb = NET.serverBeacon;
    if (!sb) return;
    if (sb.state === "carried" && sb.owner === NET.id && typeof G !== "undefined") {
      G.beacon = { state: "carried", owner: NET.id, x: G.player.x, y: G.player.y, hp: sb.hp, maxhp: sb.maxhp };
    } else {
      G.beacon = { state: sb.state, owner: sb.owner, x: sb.x, y: sb.y, hp: sb.hp, maxhp: sb.maxhp };
    }
  }
  window.netApplyBeacon = netApplyBeacon;

  function lerpEntities(map, dt) {
    var k = Math.min(1, dt * 10);
    map.forEach(function (e) {
      if (e.tx == null) return;
      e.x += (e.tx - e.x) * k;
      e.y += (e.ty - e.y) * k;
    });
  }
  function netTickInterp(dt) {
    if (!NET.connected) return;
    lerpEntities(NET.players, dt);
    lerpEntities(NET.botMap, dt);
  }
  window.netTickInterp = netTickInterp;

  function netDrawRemotes() {
    if (!NET.connected || typeof rbot !== "function") return;
    drawMap(NET.botMap);
    drawMap(NET.players);
  }
  function drawMap(map) {
    map.forEach(function (e) {
      var sx = e.x - cam.x, sy = e.y - cam.y;
      if (sx < -60 || sy < -60 || sx > VW + 60 || sy > VH + 60) return;
      rbot(e, sx, sy);
    });
  }
  window.netDrawRemotes = netDrawRemotes;
  window.netConnected = function () { return NET.connected; };
})();

/* ===========================================================================
   GRAPHICS PATCH v1 — 2.5D stylized polish only.
   Installs after the main game script has created ctx/G/cam/render functions.
   =========================================================================== */
(function () {
  "use strict";

  function installGraphicsPatch() {
    if (typeof ctx === "undefined" || typeof cam === "undefined" || typeof drawDeco !== "function" || typeof rnode !== "function") {
      setTimeout(installGraphicsPatch, 50);
      return;
    }
    if (window.__GFX_25D_PATCH_V1__) return;
    window.__GFX_25D_PATCH_V1__ = true;

    var GFX = { richGround: true, softShadow: true };
    window.GFX25D = GFX;

    function clamp01(v) { return Math.max(0, Math.min(1, v)); }
    function hash2(x, y) { var s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return s - Math.floor(s); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function rr(x, y, w, h, r) {
      r = Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    function fillRound(x, y, w, h, r) { rr(x, y, w, h, r); ctx.fill(); }
    function ovalShadow(x, y, rx, ry, a) {
      if (!GFX.softShadow) return;
      ctx.save();
      var g = ctx.createRadialGradient(x, y, 1, x, y, Math.max(rx, ry));
      g.addColorStop(0, "rgba(0,0,0," + (a == null ? 0.22 : a) + ")");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    function glossyDot(x, y, r, c1, c2) {
      var g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, 1, x, y, r);
      g.addColorStop(0, c1); g.addColorStop(0.7, c2); g.addColorStop(1, "rgba(0,0,0,.18)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    function drawPebble(x, y, s, col) {
      col = col || "#7f7a70"; s = s || 1;
      ctx.save(); ctx.translate(x, y); ovalShadow(0, 4 * s, 6 * s, 3 * s, .12);
      ctx.fillStyle = col; ctx.beginPath();
      ctx.moveTo(-7 * s, 2 * s); ctx.quadraticCurveTo(-9 * s, -3 * s, -2 * s, -7 * s);
      ctx.quadraticCurveTo(6 * s, -8 * s, 9 * s, -1 * s); ctx.quadraticCurveTo(8 * s, 6 * s, 1 * s, 7 * s);
      ctx.quadraticCurveTo(-6 * s, 7 * s, -7 * s, 2 * s); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.15)"; ctx.beginPath(); ctx.arc(-1 * s, -2 * s, 3 * s, 0, 7); ctx.fill();
      ctx.restore();
    }
    function drawCrystal(x, y, s, col) {
      ctx.save(); ctx.translate(x, y); ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(0, -10 * s); ctx.lineTo(7 * s, -1 * s); ctx.lineTo(3 * s, 10 * s);
      ctx.lineTo(-3 * s, 10 * s); ctx.lineTo(-7 * s, -1 * s); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.24)";
      ctx.beginPath(); ctx.moveTo(-1 * s, -8 * s); ctx.lineTo(2 * s, -1 * s); ctx.lineTo(0, 6 * s); ctx.lineTo(-3 * s, 1 * s); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    function drawTuft(x, y, s, hue) {
      s = s || 1; hue = hue || 0;
      ctx.save(); ctx.translate(x, y); ctx.lineCap = "round";
      for (var i = 0; i < 7; i++) {
        var ox = (i - 3) * 1.5 * s, h = (8 + Math.abs(i - 3) * 2) * s;
        ctx.strokeStyle = "hsl(" + (96 + hue + i * 2) + " 38% " + (33 + i % 3 * 5) + "%)";
        ctx.lineWidth = 1.5 * s; ctx.beginPath();
        ctx.moveTo(ox, 2 * s); ctx.quadraticCurveTo(ox + (i - 3) * .9 * s, -h * .35, ox + (i - 3) * 1.5 * s, -h); ctx.stroke();
      }
      ctx.restore();
    }
    function drawBroadleaf(x, y, s) {
      s = s || 1; ctx.save(); ctx.translate(x, y); ovalShadow(0, 8 * s, 14 * s, 7 * s, .16);
      for (var i = 0; i < 6; i++) {
        var a = i / 6 * Math.PI * 2, lx = Math.cos(a) * 8 * s, ly = Math.sin(a) * 6 * s;
        var g = ctx.createRadialGradient(lx - 2 * s, ly - 3 * s, 1, lx, ly, 10 * s);
        g.addColorStop(0, "#8cc760"); g.addColorStop(1, "#457a34");
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(lx, ly, 8 * s, 6 * s, a * .3, 0, 7); ctx.fill();
      }
      ctx.fillStyle = "#5a3b24"; ctx.fillRect(-2 * s, -2 * s, 4 * s, 12 * s); ctx.restore();
    }
    function drawRockCluster(x, y, s, base, top) {
      s = s || 1; base = base || "#6d6b67"; top = top || "#9c9a94";
      ctx.save(); ctx.translate(x, y); ovalShadow(0, 9 * s, 18 * s, 7 * s, .18);
      [[-11, 2, 10], [-1, -3, 12], [10, 3, 9], [2, 8, 8]].forEach(function (l) {
        var ox = l[0], oy = l[1], r = l[2];
        var g = ctx.createRadialGradient(ox * s - r * .35 * s, oy * s - r * .45 * s, 1, ox * s, oy * s, r * s);
        g.addColorStop(0, top); g.addColorStop(.78, base); g.addColorStop(1, "#4c4a46");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox * s, oy * s, r * s, 0, 7); ctx.fill();
      });
      ctx.restore();
    }
    function drawOreNode(x, y, s, oreColor) {
      drawRockCluster(x, y, s, "#666862", "#9fa39b");
      drawCrystal(x - 8 * s, y - 4 * s, .55 * s, oreColor);
      drawCrystal(x + 3 * s, y - 10 * s, .75 * s, oreColor);
      drawCrystal(x + 12 * s, y - 2 * s, .45 * s, oreColor);
    }
    function drawPond(x, y, rx, ry) {
      rx = rx || 18; ry = ry || 12; ctx.save(); ovalShadow(x, y + ry * .9, rx * .95, ry * .5, .12);
      var g = ctx.createRadialGradient(x - rx * .2, y - ry * .4, 2, x, y, rx);
      g.addColorStop(0, "rgba(135,220,235,.95)"); g.addColorStop(.55, "rgba(62,152,182,.95)"); g.addColorStop(1, "rgba(31,93,128,.98)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(185,245,255,.35)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(x - 2, y - 2, rx * .7, ry * .5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.18)"; ctx.beginPath(); ctx.ellipse(x - rx * .22, y - ry * .25, rx * .26, ry * .14, -.3, 0, 7); ctx.fill();
      ctx.restore();
    }
    function actorShadow(sx, sy, scale) { ovalShadow(sx, sy + 10 * (scale || 1), 11 * (scale || 1), 5 * (scale || 1), .22); }
    function drawGroundDetails() {
      if (!GFX.richGround) return;
      var step = 46, startX = Math.floor(cam.x / step) - 1, endX = Math.floor((cam.x + VW) / step) + 1;
      var startY = Math.floor(cam.y / step) - 1, endY = Math.floor((cam.y + VH) / step) + 1;
      for (var gx = startX; gx <= endX; gx++) for (var gy = startY; gy <= endY; gy++) {
        var r = hash2(gx, gy), sx = gx * step - cam.x + hash2(gx + 11, gy + 9) * 18 - 9, sy = gy * step - cam.y + hash2(gx + 17, gy + 3) * 18 - 9;
        if (sx < -24 || sy < -24 || sx > VW + 24 || sy > VH + 24) continue;
        if (r < .18) { ctx.fillStyle = "rgba(40,65,34,.22)"; ctx.beginPath(); ctx.arc(sx, sy, 1.2 + hash2(gx + 1, gy + 1) * 1.8, 0, 7); ctx.fill(); }
        else if (r < .28) drawTuft(sx, sy, .6 + hash2(gx + 2, gy + 2) * .45, hash2(gx + 4, gy + 4) * 8);
        else if (r < .31) drawPebble(sx, sy, .35 + hash2(gx + 3, gy + 1) * .4, "#817b6c");
        else if (r < .34) { ctx.fillStyle = "rgba(255,245,210,.7)"; ctx.beginPath(); ctx.arc(sx, sy, 1.4, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(sx + 3, sy - 2, 1.2, 0, 7); ctx.fill(); }
      }
    }
    function drawFaceDot(x, y, r) { ctx.fillStyle = "#2b2219"; ctx.beginPath(); ctx.arc(x, y, r || 1.7, 0, 7); ctx.fill(); }
    function drawHat(x, y, s) { s = s || 1; ctx.fillStyle = "#caa25a"; ctx.beginPath(); ctx.ellipse(x, y + 2 * s, 12 * s, 5 * s, 0, 0, 7); ctx.fill(); ctx.fillStyle = "#b18442"; ctx.beginPath(); ctx.ellipse(x, y - 5 * s, 8 * s, 5 * s, 0, 0, 7); ctx.fill(); ctx.fillStyle = "rgba(255,255,255,.14)"; ctx.beginPath(); ctx.ellipse(x - 2 * s, y - 7 * s, 3.5 * s, 1.8 * s, 0, 0, 7); ctx.fill(); }
    function drawHumanoid(sx, sy, shirt, accent, skin, hat) {
      shirt = shirt || "#5b9161"; accent = accent || "#2f465f"; skin = skin || "#f0c99f"; actorShadow(sx, sy, 1);
      ctx.fillStyle = "#26354a"; fillRound(sx - 7, sy + 2, 6, 15, 3); fillRound(sx + 1, sy + 2, 6, 15, 3);
      var gb = ctx.createLinearGradient(sx, sy - 2, sx, sy + 18); gb.addColorStop(0, shirt); gb.addColorStop(1, accent); ctx.fillStyle = gb; fillRound(sx - 10, sy - 6, 20, 20, 8);
      ctx.strokeStyle = skin; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(sx - 8, sy + 1); ctx.lineTo(sx - 13, sy + 6); ctx.moveTo(sx + 8, sy + 1); ctx.lineTo(sx + 13, sy + 6); ctx.stroke();
      var gh = ctx.createRadialGradient(sx - 3, sy - 14, 1, sx, sy - 10, 11); gh.addColorStop(0, "#f6d9b2"); gh.addColorStop(1, skin); ctx.fillStyle = gh; ctx.beginPath(); ctx.arc(sx, sy - 10, 9, 0, 7); ctx.fill();
      drawFaceDot(sx + 2, sy - 11, 1.5); if (hat) drawHat(sx, sy - 18, 1);
    }

    var baseDrawDeco = drawDeco;
    drawDeco = function () { baseDrawDeco(); drawGroundDetails(); };

    rnode = function (n, sx, sy) {
      var key = String((n && (n.type || n.kind || n.id || n.dropId)) || "").toLowerCase();
      if (key.indexOf("water") >= 0) { drawPond(sx, sy, 16, 10); return; }
      if (key.indexOf("berr") >= 0 || key.indexOf("bush") >= 0 || key.indexOf("fiber") >= 0 || key.indexOf("plant") >= 0) {
        ovalShadow(sx, sy + 10, 14, 7, .16); drawBroadleaf(sx, sy, .95);
        if (key.indexOf("berr") >= 0) { glossyDot(sx - 7, sy + 1, 2.2, "#ffb7a9", "#d14c56"); glossyDot(sx + 5, sy - 3, 2.4, "#ffb7a9", "#d14c56"); glossyDot(sx + 1, sy + 5, 2, "#ffb7a9", "#d14c56"); }
        return;
      }
      if (key.indexOf("wood") >= 0 || key.indexOf("tree") >= 0) {
        ctx.save(); ctx.translate(sx, sy); ovalShadow(0, 18, 18, 8, .18); ctx.fillStyle = "#6b4428"; fillRound(-5, -2, 10, 26, 4);
        [[0, -16, 12], [-10, -10, 12], [10, -9, 12], [-5, -21, 13], [6, -20, 13]].forEach(function (p) {
          var g = ctx.createRadialGradient(p[0] - 2, p[1] - 5, 1, p[0], p[1], p[2]); g.addColorStop(0, "#8fcb62"); g.addColorStop(1, "#3f7933"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p[0], p[1], p[2], 0, 7); ctx.fill();
        }); ctx.restore(); return;
      }
      if (key.indexOf("iron") >= 0) { drawOreNode(sx, sy, 1, "#b8d7ff"); return; }
      if (key.indexOf("copper") >= 0) { drawOreNode(sx, sy, 1, "#f0a14b"); return; }
      if (key.indexOf("sulfur") >= 0) { drawOreNode(sx, sy, 1, "#f1db58"); return; }
      if (key.indexOf("stone") >= 0 || key.indexOf("rock") >= 0 || key.indexOf("ore") >= 0) { drawRockCluster(sx, sy, 1, "#6a6964", "#a1a09a"); return; }
      drawPebble(sx, sy, .9, "#7d776b");
    };

    rplayer = function (sx, sy) {
      var p = (typeof G !== "undefined" && G.player) ? G.player : { aim: 0, dir: 0 };
      drawHumanoid(sx, sy, "#5b8f63", "#30455f", "#f0c99f", true);
      if (typeof G !== "undefined" && G.equip && G.equip.hand) {
        var id = String(G.equip.hand.id || ""); ctx.save(); ctx.translate(sx + 10, sy - 1); ctx.rotate((p.aim || p.dir || 0) * .25);
        if (id.indexOf("axe") >= 0) { ctx.strokeStyle = "#6d4c2e"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(14, 0); ctx.stroke(); ctx.fillStyle = "#bfc6cc"; ctx.beginPath(); ctx.moveTo(12, -5); ctx.lineTo(18, -2); ctx.lineTo(12, 4); ctx.closePath(); ctx.fill(); }
        else if (id.indexOf("pick") >= 0) { ctx.strokeStyle = "#6d4c2e"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(14, 0); ctx.stroke(); ctx.strokeStyle = "#bfc6cc"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(10, -4); ctx.lineTo(16, 0); ctx.lineTo(10, 4); ctx.stroke(); }
        else if (id.indexOf("spear") >= 0) { ctx.strokeStyle = "#8d6a3f"; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(-2, 0); ctx.lineTo(18, 0); ctx.stroke(); ctx.fillStyle = "#d9d9d2"; ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(14, -3); ctx.lineTo(14, 3); ctx.closePath(); ctx.fill(); }
        ctx.restore();
      }
    };

    rbot = function (o, sx, sy) {
      var t = hash2(((o && o.x) || 0) * .01, ((o && o.y) || 0) * .01);
      drawHumanoid(sx, sy, "hsl(" + Math.floor(lerp(15, 220, t)) + " 38% 48%)", "hsl(" + Math.floor(lerp(10, 230, t)) + " 28% 26%)", t > .55 ? "#d6a57e" : "#f0c59f", false);
      ctx.fillStyle = "rgba(255,255,255,.65)"; ctx.beginPath(); ctx.arc(sx, sy - 24, 2, 0, 7); ctx.fill();
    };

    rwolf = function (o, sx, sy) {
      actorShadow(sx, sy, 1); ctx.save(); ctx.translate(sx, sy);
      var angry = o && (o.aggro || o.state === "chase");
      var g = ctx.createLinearGradient(0, -10, 0, 10); g.addColorStop(0, angry ? "#6a4242" : "#5b5f63"); g.addColorStop(1, angry ? "#37252a" : "#2d3237"); ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, 17, 10, 0, 0, 7); ctx.fill(); ctx.beginPath(); ctx.moveTo(-10, -2); ctx.lineTo(-2, -11); ctx.lineTo(8, -8); ctx.lineTo(11, 2); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.ellipse(15, -4, 8, 7, 0, 0, 7); ctx.fill();
      ctx.fillStyle = angry ? "#4a3030" : "#3a3f44"; ctx.beginPath(); ctx.moveTo(11, -9); ctx.lineTo(13, -16); ctx.lineTo(16, -9); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(17, -9); ctx.lineTo(20, -15); ctx.lineTo(21, -8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#2a2d31"; [-10, -2, 6, 14].forEach(function (lx) { fillRound(lx, -1, 4, 13, 2); });
      ctx.strokeStyle = angry ? "#5b3737" : "#4b5054"; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(-15, -3); ctx.quadraticCurveTo(-23, -9, -24, -16); ctx.stroke();
      ctx.fillStyle = "#d9d8d3"; ctx.beginPath(); ctx.ellipse(21, -1, 4, 3, 0, 0, 7); ctx.fill(); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(18, -6, 1.3, 0, 7); ctx.fill(); ctx.fillStyle = "#1e1a18"; ctx.beginPath(); ctx.arc(18.2, -6, .8, 0, 7); ctx.fill(); ctx.restore();
    };

    rhorse = function (sx, sy, dir) {
      actorShadow(sx, sy, 1.1); ctx.save(); ctx.translate(sx, sy);
      var g = ctx.createLinearGradient(0, -18, 0, 16); g.addColorStop(0, "#b98a54"); g.addColorStop(1, "#7b5330"); ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, 21, 12, 0, 0, 7); ctx.fill(); ctx.beginPath(); ctx.moveTo(9, -8); ctx.lineTo(16, -20); ctx.lineTo(24, -18); ctx.lineTo(19, -4); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.ellipse(27, -18, 8, 6, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#674326"; [-12, -4, 7, 15].forEach(function (lx) { fillRound(lx, 6, 4, 18, 2); }); ctx.strokeStyle = "#4f2f1b"; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(14, -18); ctx.lineTo(8, -8); ctx.moveTo(17, -17); ctx.lineTo(12, -7); ctx.moveTo(20, -16); ctx.lineTo(14, -7); ctx.stroke(); ctx.strokeStyle = "#58331d"; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-20, -3); ctx.quadraticCurveTo(-27, 5, -24, 17); ctx.stroke(); ctx.restore();
    };

    rbuild = function (b, sx, sy) {
      var k = String((b && (b.kind || b.type || b.id || b.place)) || "").toLowerCase();
      if (k.indexOf("wall") >= 0) { ovalShadow(sx, sy + 14, 22, 8, .18); ctx.fillStyle = "#6c5843"; ctx.fillRect(sx - 22, sy - 8, 44, 18); ctx.fillStyle = "#8c7354"; ctx.fillRect(sx - 22, sy - 14, 44, 8); ctx.strokeStyle = "rgba(0,0,0,.25)"; for (var i = -18; i <= 18; i += 9) { ctx.beginPath(); ctx.moveTo(sx + i, sy - 14); ctx.lineTo(sx + i, sy + 10); ctx.stroke(); } return; }
      if (k.indexOf("door") >= 0) { ovalShadow(sx, sy + 14, 22, 8, .18); ctx.fillStyle = "#4e3b2a"; ctx.fillRect(sx - 18, sy - 16, 36, 30); ctx.fillStyle = "#73543b"; ctx.fillRect(sx - 18, sy - 20, 36, 6); ctx.fillStyle = "#caa25a"; ctx.beginPath(); ctx.arc(sx + 10, sy - 1, 2, 0, 7); ctx.fill(); return; }
      if (k.indexOf("core") >= 0) { ovalShadow(sx, sy + 11, 18, 8, .22); ctx.fillStyle = "#4d5c67"; ctx.beginPath(); ctx.moveTo(sx, sy - 20); ctx.lineTo(sx + 14, sy - 6); ctx.lineTo(sx + 6, sy + 12); ctx.lineTo(sx - 6, sy + 12); ctx.lineTo(sx - 14, sy - 6); ctx.closePath(); ctx.fill(); ctx.fillStyle = "#59d3ff"; ctx.beginPath(); ctx.arc(sx, sy - 2, 5, 0, 7); ctx.fill(); ctx.fillStyle = "rgba(89,211,255,.22)"; ctx.beginPath(); ctx.arc(sx, sy - 2, 12, 0, 7); ctx.fill(); return; }
      if (k.indexOf("box") >= 0 || k.indexOf("stash") >= 0 || k.indexOf("storage") >= 0) { ovalShadow(sx, sy + 12, 18, 7, .18); ctx.fillStyle = "#6f4a26"; ctx.fillRect(sx - 16, sy - 6, 32, 20); ctx.fillStyle = "#9a6a3a"; ctx.fillRect(sx - 16, sy - 12, 32, 8); ctx.fillStyle = "#cdbfa3"; ctx.fillRect(sx - 2, sy - 9, 4, 10); return; }
      if (k.indexOf("furnace") >= 0) { ovalShadow(sx, sy + 14, 18, 8, .18); drawRockCluster(sx, sy + 4, .95, "#595853", "#8c8a84"); ctx.fillStyle = "#2a2521"; ctx.beginPath(); ctx.arc(sx, sy + 4, 5, 0, 7); ctx.fill(); ctx.fillStyle = "#ffae42"; ctx.beginPath(); ctx.arc(sx, sy + 4, 2.5, 0, 7); ctx.fill(); return; }
      if (k.indexOf("craft") >= 0 || k.indexOf("table") >= 0) { ovalShadow(sx, sy + 12, 20, 8, .16); ctx.fillStyle = "#6b4b2e"; ctx.fillRect(sx - 18, sy - 10, 36, 8); ctx.fillStyle = "#8b633a"; ctx.fillRect(sx - 18, sy - 16, 36, 6); ctx.fillRect(sx - 14, sy - 2, 4, 16); ctx.fillRect(sx + 10, sy - 2, 4, 16); return; }
      if (k.indexOf("turret") >= 0) { ovalShadow(sx, sy + 12, 20, 8, .18); ctx.fillStyle = "#666e75"; ctx.beginPath(); ctx.arc(sx, sy, 12, 0, 7); ctx.fill(); ctx.fillStyle = "#4d545a"; ctx.fillRect(sx - 4, sy - 18, 8, 16); ctx.fillStyle = "#b8c0c6"; ctx.fillRect(sx + 2, sy - 15, 16, 4); return; }
      drawPebble(sx, sy, 1, "#7d776b");
    };

    if (typeof toast === "function") setTimeout(function () { toast("🎨 เปิดโหมดภาพ 2.5D แล้ว"); }, 700);
  }

  setTimeout(installGraphicsPatch, 0);
})();
