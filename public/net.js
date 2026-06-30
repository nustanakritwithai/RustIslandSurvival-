/* ===========================================================================
   net.js — WebSocket client layer for Last Short Island multiplayer.

   Design goal: touch the original game as little as possible. Everything here
   is global and guarded so that when there is NO connection (offline, file://,
   Claude artifact, Render cold-start) the game keeps running exactly as the
   single-player/bots version. The inline game script calls a handful of
   net* hooks; all the messy networking lives in this file.

   What the server is authoritative over (overrides the local game):
     - player roster + positions of OTHER players  -> NET.players
     - server-side filler bots                      -> NET.botMap
     - airdrop / beacon state, owner, position, HP  -> G.beacon (via netApplyBeacon)
     - round winner + shared leaderboard            -> event "win" / "board"
   Local & per-player (still client-side for the MVP):
     - your movement, monsters, resources, crafting, inventory, base building.
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
    serverBeacon: null,
    serverRound: null,    // {remain,id}
    board: null,
    _posTimer: null,
  };
  window.NET = NET;

  var HUMAN_COLS = ["#2f7fb0", "#b06a2f", "#4a9d4a", "#9d4a8f", "#b0a02f", "#3aa0a0"];
  function humanCol(id) {
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
      setTimeout(function () { netConnect(NET.name); }, 1500); // auto-reconnect
    };
    NET.ws.onerror = function () { /* onclose will handle retry */ };
  }
  window.netConnect = netConnect;

  // Called from deploy(): connect (once) and start streaming our position.
  function netOnDeploy() {
    var name = (typeof G !== "undefined" && G.playerName) ? G.playerName : "player";
    NET.name = name;
    if (!NET.ws || NET.ws.readyState > 1) netConnect(name);  // CLOSING/CLOSED -> reconnect
    else if (NET.connected) netSend({ t: "join", name: name }); // re-deploy: reset our server slot
    netStartPosLoop();
  }
  window.netOnDeploy = netOnDeploy;

  function netStartPosLoop() {
    if (NET._posTimer) return;
    NET._posTimer = setInterval(function () {
      if (!NET.connected || typeof G === "undefined") return;
      var p = G.player;
      netSend({
        t: "pos",
        x: Math.round(p.x), y: Math.round(p.y), dir: p.dir,
        hp: Math.round(p.hp),
        carrying: G.beacon.state === "carried" && G.beacon.owner === NET.id,
      });
    }, 100); // ~10 Hz
  }

  // -- message dispatch --------------------------------------------------------
  function netHandle(m) {
    if (!m || !m.t) return;
    if (m.t === "welcome") {
      NET.id = m.id;
      if (m.slot) applyWorldSeed(m.slot.seed);
      if (m.nodes) applyDeadNodes(m.nodes); // depleted nodes already harvested this round
      if (m.builds) applyBuilds(m.builds);  // shared walls/doors already standing
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

    // other players
    var seen = {};
    for (var i = 0; i < m.players.length; i++) {
      var pl = m.players[i];
      if (pl.id === NET.id) continue;
      seen[pl.id] = 1;
      var e = NET.players.get(pl.id);
      if (!e) { e = { x: pl.x, y: pl.y }; NET.players.set(pl.id, e); }
      e.id = pl.id; e.name = pl.name; e.tx = pl.x; e.ty = pl.y;
      e.dir = pl.dir; e.hp = pl.hp; e.maxhp = 100; e.dmgT = 0;
      e.carrying = pl.carrying; e.col = e.col || humanCol(pl.id);
    }
    NET.players.forEach(function (v, k) { if (!seen[k]) NET.players.delete(k); });

    // server bots
    var bseen = {};
    for (var j = 0; j < m.bots.length; j++) {
      var bt = m.bots[j];
      bseen[bt.id] = 1;
      var b = NET.botMap.get(bt.id);
      if (!b) { b = { x: bt.x, y: bt.y }; NET.botMap.set(bt.id, b); }
      b.id = bt.id; b.name = bt.name; b.tx = bt.x; b.ty = bt.y;
      b.dir = bt.dir; b.hp = bt.hp; b.maxhp = bt.maxhp || 90;
      b.col = bt.col; b.dmgT = 0; b.carrying = bt.carrying;
    }
    NET.botMap.forEach(function (v, k) { if (!bseen[k]) NET.botMap.delete(k); });
  }

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
    } else if (m.kind === "reset") {
      NET.serverBeacon = { state: "none" };
      if (typeof G !== "undefined") {
        if (G.buildings) G.buildings = G.buildings.filter(function (b) { return !b.net; }); // forts cleared each round
        if (d.slot && d.slot.id) G.round.slot = d.slot.id;
        if (d.slot) applyWorldSeed(d.slot.seed); // new round -> regenerate the shared island
        if (G.round.active) G.beacon = { state: "none" };
      }
    }
  }

  // Round ended on the server. Drive the same summary screens the offline game
  // uses, but the win/lose decision is the server's.
  function onServerWin(d) {
    if (typeof G === "undefined") return;
    if (!G.round.active || G.dead) return; // already extracted / dead -> ignore
    if (d.winnerId && d.winnerId === NET.id) {
      if (typeof winRound === "function") winRound(); // banks loot + summary (pushWinner is a no-op when connected)
    } else {
      netLose(d.winnerName);
    }
  }

  // Multiplayer loss (someone else won, or nobody captured = timeout).
  function netLose(winnerName) {
    var p = G.player;
    var bag = G.inv.map(function (s) { return { id: s.id, n: s.n }; });
    if (typeof dropEquipInto === "function") dropEquipInto(bag);
    var lostVal = (typeof bagValue === "function") ? bagValue(bag) : 0;
    G.inv.length = 0;
    if (bag.length) G.loot.push({ x: p.x, y: p.y, items: bag, t: 150, corpse: true });
    G.beacon = { state: "none" };
    if (typeof sfx === "function") sfx("lose");
    if (typeof recordRun === "function") {
      recordRun(winnerName ? "botwin" : "timeout",
        { lost: bag, lostVal: lostVal, winner: winnerName || "" });
    }
  }

  // Apply shared node depletion from the server.
  function setNodeDead(i, dead) {
    if (typeof G === "undefined" || !G.nodes || i == null) return;
    var n = G.nodes[i];
    if (!n) return;
    if (dead) { n.dead = true; }
    else { n.dead = false; n.hp = n.maxhp; }
  }
  function applyDeadNodes(list) {
    for (var i = 0; i < list.length; i++) setNodeDead(list[i], true);
  }

  // Shared walls/doors (forts). Represented in G.buildings with net:true + nid.
  function addNetBuild(b) {
    if (typeof G === "undefined" || !G.buildings || !b) return;
    if (G.buildings.some(function (x) { return x.nid === b.id; })) return; // already have it
    // reconcile a locally-placed optimistic build at the same spot
    var pend = G.buildings.find(function (x) {
      return x.net && x.pending && x.nid == null &&
        Math.abs(x.x - b.x) < 8 && Math.abs(x.y - b.y) < 8;
    });
    if (pend) { pend.nid = b.id; pend.pending = false; return; }
    G.buildings.push({ type: b.t, x: b.x, y: b.y, hp: b.hp, maxhp: b.hp, open: false, net: true, nid: b.id });
  }
  function delNetBuild(id) {
    if (typeof G === "undefined" || !G.buildings) return;
    var i = G.buildings.findIndex(function (x) { return x.nid === id; });
    if (i >= 0) G.buildings.splice(i, 1);
  }
  function applyBuilds(list) { for (var i = 0; i < list.length; i++) addNetBuild(list[i]); }

  // Regenerate the local island when the server's shared seed changes.
  function applyWorldSeed(seed) {
    if (seed == null || typeof G === "undefined" || typeof regenWorld !== "function") return;
    if (G.worldSeed === seed) return;
    regenWorld(seed);
  }

  function refreshBoardUI() {
    var el = document.getElementById("board");
    if (el && typeof renderBoard === "function") renderBoard();
  }

  // -- per-frame helpers (called from the game loop) ---------------------------

  // Override the local beacon with the server's authoritative one. When WE carry
  // it, keep it glued to our own position so it doesn't lag behind us.
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

  // Smoothly move remote entities toward their last reported position.
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

  // Draw remote players + server bots using the game's own rbot() renderer.
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
