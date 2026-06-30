/* ===========================================================================
   net.js — WebSocket client layer for Last Short Island multiplayer.

   Network goal: keep the original game running offline and only sync shared
   state when a WebSocket server is available.

   Visual direction: Thai folk survival island. The renderer patch below is
   graphics-only: Thai rural clothing, Thai animals, bamboo/thatch buildings,
   lotus/canal/rice-field ground details, and warm tropical atmosphere.
   =========================================================================== */
(function () {
  "use strict";

  var WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

  var NET = {
    ws: null,
    id: null,
    name: "",
    connected: false,
    players: new Map(),
    botMap: new Map(),
    mobById: new Map(),
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
    try { NET.ws = new WebSocket(WS_URL); } catch (e) { NET.connected = false; return; }

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
      if (sx < -70 || sy < -80 || sx > VW + 70 || sy > VH + 80) return;
      rbot(e, sx, sy);
    });
  }
  window.netDrawRemotes = netDrawRemotes;
  window.netConnected = function () { return NET.connected; };
})();

/* ===========================================================================
   THAI IDENTITY GRAPHICS PATCH — ไทยขั้นสุด / graphics-only.
   =========================================================================== */
(function () {
  "use strict";

  function installThaiGraphicsPatch() {
    if (typeof ctx === "undefined" || typeof cam === "undefined" || typeof drawDeco !== "function" || typeof rnode !== "function") {
      setTimeout(installThaiGraphicsPatch, 60);
      return;
    }
    if (window.__THAI_SURVIVAL_GFX_V1__) return;
    window.__THAI_SURVIVAL_GFX_V1__ = true;

    window.GFX25D = { style: "thai-folk-survival", richGround: true, softShadow: true };

    function T() { return (typeof now === "function") ? now() : Date.now(); }
    function hash2(x, y) { var s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return s - Math.floor(s); }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function rr(x, y, w, h, r) {
      r = Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2);
      ctx.beginPath(); ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function fillRound(x, y, w, h, r, col) { if (col) ctx.fillStyle = col; rr(x, y, w, h, r); ctx.fill(); }
    function line(x1, y1, x2, y2, w, col) { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    function dot(x, y, r, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    function ovalShadow(x, y, rx, ry, a) {
      ctx.save();
      var g = ctx.createRadialGradient(x, y, 1, x, y, Math.max(rx, ry));
      g.addColorStop(0, "rgba(0,0,0," + (a == null ? 0.22 : a) + ")"); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    function ellipse(x, y, rx, ry, col, rot) { ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2); ctx.fill(); }

    function drawTuft(x, y, s, hue) {
      s = s || 1; hue = hue || 0; ctx.save(); ctx.translate(x, y); ctx.lineCap = "round";
      for (var i = 0; i < 7; i++) { var ox = (i - 3) * 1.6 * s, h = (8 + Math.abs(i - 3) * 2) * s; ctx.strokeStyle = "hsl(" + (94 + hue + i * 2) + " 40% " + (30 + i % 3 * 5) + "%)"; ctx.lineWidth = 1.5 * s; ctx.beginPath(); ctx.moveTo(ox, 2 * s); ctx.quadraticCurveTo(ox + (i - 3) * .9 * s, -h * .35, ox + (i - 3) * 1.4 * s, -h); ctx.stroke(); }
      ctx.restore();
    }
    function drawLateritePebble(x, y, s) {
      s = s || 1; ovalShadow(x, y + 4 * s, 6 * s, 3 * s, .10);
      var g = ctx.createRadialGradient(x - 2 * s, y - 3 * s, 1, x, y, 9 * s); g.addColorStop(0, "#b87b4e"); g.addColorStop(1, "#734326");
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, 8 * s, 6 * s, .15, 0, 7); ctx.fill();
    }
    function drawBambooClump(x, y, s) {
      s = s || 1; ovalShadow(x, y + 13 * s, 16 * s, 6 * s, .16);
      for (var i = -2; i <= 2; i++) { var bx = x + i * 4 * s; line(bx, y + 13 * s, bx + i * 1.4 * s, y - 22 * s, 3 * s, "#5e8b3e"); for (var n = -15; n <= 8; n += 9) line(bx - 2 * s, y + n * s, bx + 3 * s, y + (n + 2) * s, 1 * s, "rgba(255,240,170,.45)"); }
      ctx.fillStyle = "#6ba94c"; for (var j = 0; j < 7; j++) { var lx = x + (j - 3) * 7 * s, ly = y - (15 + Math.abs(j - 3) * 2) * s; ctx.beginPath(); ctx.ellipse(lx, ly, 8 * s, 3 * s, (j - 3) * .45, 0, 7); ctx.fill(); }
    }
    function drawBananaTree(x, y, s) {
      s = s || 1; ovalShadow(x, y + 12 * s, 18 * s, 7 * s, .16);
      ctx.fillStyle = "#725034"; fillRound(x - 5 * s, y - 2 * s, 10 * s, 27 * s, 4 * s);
      var cols = ["#74b84a", "#5fa23f", "#87c65b"];
      for (var i = 0; i < 7; i++) { var a = -Math.PI / 2 + (i - 3) * .36; ctx.fillStyle = cols[i % cols.length]; ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * 17 * s, y - 18 * s + Math.sin(a) * 9 * s, 18 * s, 5 * s, a, 0, 7); ctx.fill(); line(x, y - 17 * s, x + Math.cos(a) * 26 * s, y - 18 * s + Math.sin(a) * 13 * s, 1 * s, "rgba(255,255,200,.28)"); }
    }
    function drawLotusPatch(x, y, s) {
      s = s || 1; var g = ctx.createRadialGradient(x, y, 1, x, y, 18 * s); g.addColorStop(0, "rgba(76,151,132,.75)"); g.addColorStop(1, "rgba(28,91,98,.25)"); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, 18 * s, 11 * s, 0, 0, 7); ctx.fill();
      for (var i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? "#4f9d5d" : "#6dbb70"; ctx.beginPath(); ctx.ellipse(x + (i - 1.5) * 7 * s, y + Math.sin(i) * 3 * s, 5 * s, 3 * s, .3 * i, 0, 7); ctx.fill(); }
      ctx.fillStyle = "#f1b4c9"; ctx.beginPath(); ctx.ellipse(x + 3 * s, y - 6 * s, 3 * s, 5 * s, 0, 0, 7); ctx.fill(); ctx.fillStyle = "#ffe0ed"; ctx.beginPath(); ctx.ellipse(x, y - 5 * s, 2 * s, 4 * s, -.4, 0, 7); ctx.fill();
    }
    function drawPaddyPatch(x, y, s) {
      s = s || 1; ctx.save(); ctx.translate(x, y); ovalShadow(0, 18 * s, 32 * s, 8 * s, .09); ctx.fillStyle = "rgba(93,130,93,.42)"; rr(-34 * s, -18 * s, 68 * s, 38 * s, 5 * s); ctx.fill(); ctx.strokeStyle = "rgba(120,86,45,.7)"; ctx.lineWidth = 2 * s; ctx.stroke(); for (var r = -12; r <= 14; r += 8) for (var c = -27; c <= 27; c += 9) drawTuft(c * s, r * s, .55 * s, 6); ctx.restore();
    }
    function drawThaiGroundDetails() {
      var step = 58, sx0 = Math.floor(cam.x / step) - 1, sx1 = Math.floor((cam.x + VW) / step) + 1, sy0 = Math.floor(cam.y / step) - 1, sy1 = Math.floor((cam.y + VH) / step) + 1;
      for (var gx = sx0; gx <= sx1; gx++) for (var gy = sy0; gy <= sy1; gy++) { var r = hash2(gx, gy), x = gx * step - cam.x + hash2(gx + 7, gy + 3) * 26 - 13, y = gy * step - cam.y + hash2(gx + 2, gy + 13) * 26 - 13; if (x < -60 || y < -60 || x > VW + 60 || y > VH + 60) continue; if (r < .08) drawBambooClump(x, y, .62); else if (r < .15) drawBananaTree(x, y, .55); else if (r < .22) drawLotusPatch(x, y, .72); else if (r < .30) drawPaddyPatch(x, y, .55); else if (r < .43) drawTuft(x, y, .74, 8); else if (r < .50) drawLateritePebble(x, y, .48); }
    }

    function drawNgobHat(x, y, s) {
      s = s || 1; ctx.fillStyle = "#d8b56a"; ctx.beginPath(); ctx.ellipse(x, y, 14 * s, 5 * s, 0, 0, 7); ctx.fill(); ctx.fillStyle = "#b8873d"; ctx.beginPath(); ctx.moveTo(x - 8 * s, y); ctx.quadraticCurveTo(x, y - 12 * s, x + 8 * s, y); ctx.closePath(); ctx.fill(); ctx.strokeStyle = "rgba(80,55,28,.35)"; ctx.lineWidth = 1 * s; for (var i = -2; i <= 2; i++) line(x, y - 9 * s, x + i * 5 * s, y, 1 * s, "rgba(80,55,28,.35)");
    }
    function drawPhaKhaoMa(x, y, s) {
      s = s || 1; ctx.fillStyle = "#b33b35"; ctx.fillRect(x - 10 * s, y, 20 * s, 5 * s); ctx.strokeStyle = "#f2d8b8"; ctx.lineWidth = 1 * s; for (var i = -8; i <= 8; i += 4) line(x + i * s, y, x + i * s, y + 5 * s, 1 * s, "rgba(242,216,184,.75)"); line(x - 10 * s, y + 2.5 * s, x + 10 * s, y + 2.5 * s, 1 * s, "rgba(242,216,184,.75)");
    }
    function drawThaiTool(x, y, ang, id) {
      id = String(id || "").toLowerCase(); ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      if (id.indexOf("spear") >= 0 || id.indexOf("knife") >= 0 || id.indexOf("machete") >= 0 || id.indexOf("sword") >= 0) { line(-5, 0, 14, 0, 3, "#744d2b"); ctx.fillStyle = "#d8d8cf"; ctx.beginPath(); ctx.moveTo(13, -5); ctx.quadraticCurveTo(24, -1, 13, 6); ctx.closePath(); ctx.fill(); }
      else if (id.indexOf("axe") >= 0) { line(-3, 0, 15, 0, 3, "#6f4d2d"); ctx.fillStyle = "#c8d0d6"; ctx.beginPath(); ctx.moveTo(13, -6); ctx.lineTo(21, -2); ctx.lineTo(13, 5); ctx.closePath(); ctx.fill(); }
      else if (id.indexOf("pick") >= 0) { line(-3, 0, 15, 0, 3, "#6f4d2d"); line(11, -5, 18, 0, 3, "#c8d0d6"); line(11, 5, 18, 0, 3, "#c8d0d6"); }
      else { line(-4, 0, 15, 0, 3, "#6f4d2d"); }
      ctx.restore();
    }
    function drawThaiHuman(e, sx, sy, opt) {
      opt = opt || {}; var vx = e && e.vx != null ? e.vx : 0, vy = e && e.vy != null ? e.vy : 0; if (e && e.tx != null && e.x != null) { vx = (e.tx - e.x) * 10; vy = (e.ty - e.y) * 10; }
      var speed = Math.hypot(vx, vy), moving = speed > 5, ph = T() / (moving ? 95 : 380), amp = clamp(speed / 90, .15, 1), swing = moving ? Math.sin(ph) * .75 * amp : Math.sin(ph) * .05, bob = moving ? Math.abs(Math.sin(ph)) * 1.6 : Math.abs(Math.sin(ph * .75)) * .7, atk = clamp(((e && e.atkT) || 0) / .24, 0, 1), atkPose = atk ? Math.sin((1 - atk) * Math.PI) * 1.55 : 0;
      var y = sy - bob, skin = opt.skin || "#efc79d", shirt = opt.shirt || "#304f65", pant = opt.pant || "#2b2a28";
      ovalShadow(sx, sy + 12, 12, 5.5, .24);
      line(sx - 5, y + 8, sx - 7 + Math.sin(ph) * 3, y + 22, 5, pant); line(sx + 5, y + 8, sx + 7 - Math.sin(ph) * 3, y + 22, 5, pant);
      fillRound(sx - 10, y + 20, 8, 4, 2, "#221b15"); fillRound(sx + 2, y + 20, 8, 4, 2, "#221b15");
      var g = ctx.createLinearGradient(sx, y - 10, sx, y + 13); g.addColorStop(0, "#3f6475"); g.addColorStop(1, shirt); ctx.fillStyle = g; fillRound(sx - 11, y - 7, 22, 22, 8); drawPhaKhaoMa(sx, y + 5, 1);
      line(sx - 7, y - 1, sx - 15, y + 7 + swing * 2, 4, skin);
      line(sx + 7, y - 1, sx + 16, y + 8 + atkPose * 4, 4, skin);
      if (opt.weapon) drawThaiTool(sx + 17, y + 9 + atkPose * 3, atkPose * .75 + .15, opt.weapon);
      fillRound(sx - 3, y - 12, 6, 5, 2, skin); var gh = ctx.createRadialGradient(sx - 3, y - 16, 1, sx, y - 14, 10); gh.addColorStop(0, "#f8ddb8"); gh.addColorStop(1, skin); ctx.fillStyle = gh; ctx.beginPath(); ctx.arc(sx, y - 14, 9, 0, 7); ctx.fill();
      dot(sx - 2.4, y - 15, 1.2, "#241911"); dot(sx + 2.5, y - 15, 1.2, "#241911"); line(sx - 1, y - 10.5, sx + 3, y - 10.3, 1.1, "rgba(120,55,42,.7)"); drawNgobHat(sx, y - 23, opt.hatScale || 1);
    }

    function drawTiger(o, sx, sy) { var angry = !!(o && (o.aggro || o.state === "chase")); ovalShadow(sx, sy + 12, 20, 7, .23); line(sx - 18, sy - 3, sx - 28, sy - 17, 4.5, "#6a3a23"); var g = ctx.createLinearGradient(sx, sy - 14, sx, sy + 11); g.addColorStop(0, angry ? "#f4a14b" : "#e89b45"); g.addColorStop(1, "#b96325"); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(sx, sy, 19, 10, 0, 0, 7); ctx.fill(); ctx.beginPath(); ctx.ellipse(sx + 16, sy - 7, 9, 7, 0, 0, 7); ctx.fill(); line(sx - 11, sy + 4, sx - 12, sy + 18, 5, "#6e4021"); line(sx - 2, sy + 4, sx - 1, sy + 18, 5, "#6e4021"); line(sx + 8, sy + 4, sx + 9, sy + 18, 5, "#6e4021"); line(sx + 15, sy + 3, sx + 16, sy + 17, 5, "#6e4021"); for (var i = -10; i <= 10; i += 6) line(sx + i, sy - 7, sx + i - 3, sy + 6, 2, "rgba(35,22,14,.72)"); ctx.fillStyle = "#4a2718"; ctx.beginPath(); ctx.moveTo(sx + 12, sy - 12); ctx.lineTo(sx + 15, sy - 19); ctx.lineTo(sx + 18, sy - 12); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(sx + 20, sy - 12); ctx.lineTo(sx + 23, sy - 19); ctx.lineTo(sx + 26, sy - 12); ctx.closePath(); ctx.fill(); ellipse(sx + 21, sy - 3, 5, 4, "#f2eadf"); dot(sx + 21, sy - 9, 1.4, angry ? "#ff5038" : "#1b1512"); }
    function drawDeer(o, sx, sy) { ovalShadow(sx, sy + 12, 18, 6.5, .22); var g = ctx.createLinearGradient(sx, sy - 14, sx, sy + 12); g.addColorStop(0, "#c99a63"); g.addColorStop(1, "#83532e"); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(sx - 2, sy + 1, 17, 8.5, 0, 0, 7); ctx.fill(); fillRound(sx + 10, sy - 18, 8, 19, 4, "#a56d3d"); ctx.beginPath(); ctx.ellipse(sx + 22, sy - 16, 8, 5.5, -.15, 0, 7); ctx.fill(); line(sx + 19, sy - 21, sx + 15, sy - 32, 2, "#7d5b3e"); line(sx + 20, sy - 25, sx + 26, sy - 32, 2, "#7d5b3e"); line(sx + 25, sy - 21, sx + 31, sy - 30, 2, "#7d5b3e"); line(sx - 10, sy + 4, sx - 12, sy + 20, 3.8, "#744a29"); line(sx - 2, sy + 5, sx - 3, sy + 21, 3.8, "#744a29"); line(sx + 7, sy + 5, sx + 9, sy + 22, 3.8, "#744a29"); line(sx + 14, sy + 3, sx + 17, sy + 20, 3.8, "#744a29"); dot(sx - 15, sy - 2, 2.5, "#f5f0e7"); for (var i = -7; i <= 7; i += 5) dot(sx + i, sy - 2, 1.2, "rgba(250,235,210,.72)"); dot(sx + 23, sy - 16, 1.2, "#241b14"); }
    function drawBuffalo(o, sx, sy) { ovalShadow(sx, sy + 13, 23, 8, .25); var g = ctx.createLinearGradient(sx, sy - 16, sx, sy + 14); g.addColorStop(0, "#5d5850"); g.addColorStop(1, "#2d2a28"); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(sx, sy + 1, 23, 12, 0, 0, 7); ctx.fill(); ctx.beginPath(); ctx.ellipse(sx + 22, sy - 3, 10, 8, 0, 0, 7); ctx.fill(); ctx.strokeStyle = "#d8d0bc"; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(sx + 17, sy - 6); ctx.quadraticCurveTo(sx + 8, sy - 18, sx + 1, sy - 13); ctx.moveTo(sx + 27, sy - 7); ctx.quadraticCurveTo(sx + 37, sy - 18, sx + 44, sy - 13); ctx.stroke(); line(sx - 13, sy + 5, sx - 13, sy + 22, 6, "#292725"); line(sx - 3, sy + 5, sx - 3, sy + 22, 6, "#292725"); line(sx + 9, sy + 4, sx + 10, sy + 21, 6, "#292725"); line(sx + 20, sy + 4, sx + 21, sy + 20, 6, "#292725"); dot(sx + 26, sy - 5, 1.3, "#131110"); }
    function drawElephant(o, sx, sy) { ovalShadow(sx, sy + 15, 27, 10, .26); var g = ctx.createLinearGradient(sx, sy - 20, sx, sy + 18); g.addColorStop(0, "#90958f"); g.addColorStop(1, "#5b615e"); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(sx - 2, sy + 1, 25, 14, 0, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(sx + 20, sy - 4, 12, 0, 7); ctx.fill(); ellipse(sx + 13, sy - 3, 11, 12, "#7d8480", .3); line(sx + 29, sy + 1, sx + 25, sy + 22, 7, "#676d69"); line(sx + 27, sy + 2, sx + 30, sy + 15, 3, "#ece6d8"); line(sx + 22, sy + 2, sx + 24, sy + 14, 3, "#ece6d8"); fillRound(sx - 16, sy + 5, 8, 19, 3, "#5a605d"); fillRound(sx - 4, sy + 5, 8, 20, 3, "#5a605d"); fillRound(sx + 9, sy + 5, 8, 19, 3, "#5a605d"); fillRound(sx + 19, sy + 4, 8, 18, 3, "#5a605d"); dot(sx + 23, sy - 7, 1.4, "#1e1d1a"); }
    function drawAnimal(o, sx, sy) { var k = String((o && (o.kind || o.type || o.id)) || "").toLowerCase(); if (k.indexOf("tiger") >= 0 || k.indexOf("เสือ") >= 0) return drawTiger(o, sx, sy); if (k.indexOf("deer") >= 0 || k.indexOf("กวาง") >= 0 || k.indexOf("เก้ง") >= 0) return drawDeer(o, sx, sy); if (k.indexOf("buffalo") >= 0 || k.indexOf("ควาย") >= 0 || k.indexOf("bull") >= 0) return drawBuffalo(o, sx, sy); if (k.indexOf("elephant") >= 0 || k.indexOf("ช้าง") >= 0) return drawElephant(o, sx, sy); if (o && o.maxhp > 150) return drawElephant(o, sx, sy); if (o && o.maxhp > 105) return drawBuffalo(o, sx, sy); return (o && (o.aggro || o.state === "chase")) ? drawTiger(o, sx, sy) : drawDeer(o, sx, sy); }

    var baseDrawDeco = drawDeco;
    drawDeco = function () { baseDrawDeco(); drawThaiGroundDetails(); };
    rplayer = function (sx, sy) { var p = G.player || {}; var weapon = G.equip && G.equip.hand ? G.equip.hand.id : ""; drawThaiHuman(p, sx, sy, { shirt: "#294d61", pant: "#2b2a28", weapon: weapon, hatScale: 1 }); };
    rbot = function (o, sx, sy) { drawThaiHuman(o || {}, sx, sy, { shirt: "#3e5f43", pant: "#342a23", weapon: "", skin: "#e3b184", hatScale: .86 }); dot(sx, sy - 30, 2.1, "rgba(255,255,255,.72)"); };
    rwolf = function (o, sx, sy) { drawAnimal(o, sx, sy); };
    rhorse = function (sx, sy, dir) { drawBuffalo({ kind: "buffalo" }, sx, sy); };
    rnode = function (n, sx, sy) { var k = String((n && (n.type || n.kind || n.id || n.dropId)) || "").toLowerCase(); if (k.indexOf("water") >= 0) return drawLotusPatch(sx, sy, .92); if (k.indexOf("wood") >= 0 || k.indexOf("tree") >= 0) return drawBambooClump(sx, sy, .95); if (k.indexOf("berr") >= 0 || k.indexOf("plant") >= 0 || k.indexOf("fiber") >= 0) return drawBananaTree(sx, sy, .68); if (k.indexOf("iron") >= 0 || k.indexOf("stone") >= 0 || k.indexOf("copper") >= 0 || k.indexOf("sulfur") >= 0 || k.indexOf("ore") >= 0) { drawLateritePebble(sx - 7, sy, .9); drawLateritePebble(sx + 3, sy - 4, 1.1); drawLateritePebble(sx + 10, sy + 5, .7); return; } drawTuft(sx, sy, 1, 8); };
    rbuild = function (b, sx, sy) { var k = String((b && (b.kind || b.type || b.id || b.place)) || "").toLowerCase(); ovalShadow(sx, sy + 14, 22, 8, .18); if (k.indexOf("wall") >= 0) { ctx.strokeStyle = "#8c6235"; ctx.lineWidth = 5; for (var i = -18; i <= 18; i += 9) line(sx + i, sy - 15, sx + i, sy + 11, 5, "#8c6235"); line(sx - 24, sy - 8, sx + 24, sy - 8, 4, "#b68545"); line(sx - 24, sy + 5, sx + 24, sy + 5, 4, "#b68545"); return; } if (k.indexOf("door") >= 0) { fillRound(sx - 18, sy - 18, 36, 32, 4, "#6d4a2b"); line(sx - 13, sy - 18, sx - 13, sy + 14, 2, "rgba(0,0,0,.25)"); line(sx + 3, sy - 18, sx + 3, sy + 14, 2, "rgba(0,0,0,.25)"); dot(sx + 10, sy - 2, 2, "#d8b56a"); return; } if (k.indexOf("core") >= 0) { fillRound(sx - 10, sy - 18, 20, 30, 4, "#8b5d36"); ctx.fillStyle = "#d4af37"; ctx.beginPath(); ctx.moveTo(sx, sy - 28); ctx.lineTo(sx + 10, sy - 17); ctx.lineTo(sx - 10, sy - 17); ctx.closePath(); ctx.fill(); dot(sx, sy - 4, 5, "#ffdd77"); return; } if (k.indexOf("box") >= 0 || k.indexOf("storage") >= 0) { fillRound(sx - 16, sy - 9, 32, 22, 5, "#9b6b3f"); ctx.strokeStyle = "#d0a46c"; ctx.lineWidth = 2; ctx.strokeRect(sx - 13, sy - 6, 26, 16); return; } if (k.indexOf("furnace") >= 0) { fillRound(sx - 14, sy - 14, 28, 28, 8, "#7a3f24"); dot(sx, sy + 2, 6, "#241610"); dot(sx, sy + 2, 3, "#ff9d3a"); return; } if (k.indexOf("craft") >= 0 || k.indexOf("table") >= 0) { fillRound(sx - 20, sy - 14, 40, 10, 4, "#9a6a3a"); fillRound(sx - 15, sy - 4, 5, 18, 2, "#6b4b2e"); fillRound(sx + 10, sy - 4, 5, 18, 2, "#6b4b2e"); return; } fillRound(sx - 12, sy - 12, 24, 24, 8, "#8c6235"); };

    if (typeof toast === "function") setTimeout(function () { toast("🇹🇭 เปิดอาร์ตไทยขั้นสุด: งอบ ผ้าขาวม้า ไผ่ บัว นา ควาย ช้าง เสือไทย"); }, 900);
  }

  setTimeout(installThaiGraphicsPatch, 0);
})();
