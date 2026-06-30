// Authoritative airdrop + signal-beacon logic. This is the part that MUST be
// shared across players: the drop location, its state, who owns it, and its HP.
// PvE (monsters, resources, walls) stays client-side for the MVP, so the server
// has no world collision — it picks an open-ish spot near the island centre and
// trusts client-reported plant positions.

export const WORLD = { W: 6400, H: 4400 };
export const CAPTURE_WINDOW = 360; // seconds before round end that the crate becomes grabbable (~6 min finale)
export const BEACON_MAXHP = 260;
export const GRAB_R2 = 100 * 100;  // how close you must be to grab the crate (forgiving)
export const PLANT_LIFT_R2 = 70 * 70;
export const WIN_R2 = 170 * 170;   // owner must be this close at round end to win

export function newBeacon() {
  return { state: "none", x: 0, y: 0, owner: null, hp: 0, maxhp: BEACON_MAXHP };
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// Pick a single drop point near the centre of the island, identical for everyone
// because the server decides it once and broadcasts it.
function randomDropSpot() {
  const cx = WORLD.W * 0.5, cy = WORLD.H * 0.5;
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * 260;
  return {
    x: Math.max(120, Math.min(WORLD.W - 120, cx + Math.cos(a) * r)),
    y: Math.max(120, Math.min(WORLD.H - 120, cy + Math.sin(a) * r)),
  };
}

// Drive none -> incoming -> crate based on remaining round time. Returns an
// event kind ("airdrop" | "landed") when a transition happens, else null.
export function advanceAirdrop(beacon, remain) {
  if (beacon.state === "none" && remain <= CAPTURE_WINDOW + 30) {
    const sp = randomDropSpot();
    beacon.state = "incoming";
    beacon.x = sp.x;
    beacon.y = sp.y;
    beacon.owner = null;
    return "airdrop";
  }
  if (beacon.state === "incoming" && remain <= CAPTURE_WINDOW) {
    beacon.state = "crate";
    return "landed";
  }
  return null;
}

// Handle a player's request to interact with the beacon. `actor` is {id,x,y}.
// Returns true if the beacon state changed (so the room can rebroadcast sooner).
export function handleBeaconAction(beacon, actor, action) {
  if (!actor) return false;
  if (action === "grab") {
    if (beacon.state === "crate" && dist2(beacon.x, beacon.y, actor.x, actor.y) < GRAB_R2) {
      beacon.state = "carried";
      beacon.owner = actor.id;
      return true;
    }
    // also allow lifting a planted beacon you don't own is NOT permitted; only owner lifts (below)
    return false;
  }
  if (action === "plant") {
    if (beacon.state === "carried" && beacon.owner === actor.id) {
      beacon.state = "planted";
      beacon.x = actor.x;
      beacon.y = actor.y;
      beacon.hp = BEACON_MAXHP;
      beacon.maxhp = BEACON_MAXHP;
      return true;
    }
    return false;
  }
  if (action === "lift") {
    if (beacon.state === "planted" && beacon.owner === actor.id &&
        dist2(beacon.x, beacon.y, actor.x, actor.y) < PLANT_LIFT_R2) {
      beacon.state = "carried";
      return true;
    }
    return false;
  }
  return false;
}

// Apply damage to a planted beacon (reported by contesting players / their
// monsters). Knocks it back to a crate when destroyed.
export function damageBeacon(beacon, amt) {
  if (beacon.state !== "planted") return false;
  beacon.hp = Math.max(0, beacon.hp - Math.max(0, +amt || 0));
  if (beacon.hp <= 0) {
    beacon.state = "crate";
    beacon.owner = null;
    return true;
  }
  return false;
}

// If a carrier drops out (disconnect / bot death), turn the beacon back into a
// grabbable crate wherever they were.
export function dropBeacon(beacon, x, y) {
  if (beacon.state === "carried" || beacon.state === "planted") {
    beacon.state = "crate";
    beacon.owner = null;
    if (typeof x === "number") beacon.x = x;
    if (typeof y === "number") beacon.y = y;
    return true;
  }
  return false;
}

export { dist2 };
