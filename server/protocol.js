// Tiny helpers for the JSON-over-WebSocket protocol. Centralised so the message
// shapes are documented in one place and easy to evolve (bump VERSION if the
// snapshot shape changes incompatibly).
export const PROTO_VERSION = 1;

export function encode(obj) {
  return JSON.stringify(obj);
}

export function decode(buf) {
  try {
    return JSON.parse(typeof buf === "string" ? buf : buf.toString());
  } catch {
    return null;
  }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/*
Client -> Server
  { t:"join", name }
  { t:"pos", x, y, dir, hp, carrying, skin }
  { t:"beacon", action:"grab"|"plant"|"lift", x, y }
  { t:"beaconDmg", amt }
  { t:"node", i, rt }
  { t:"build", op:"add"|"del", bt?, x?, y?, id? }
  { t:"mobHit", id, dmg }
  { t:"botHit", id, dmg }
  { t:"ping" }

Server -> Client
  { t:"welcome", v, id, slot:{remain,id,seed}, board, nodes, builds }
  { t:"snapshot", now, slot:{remain,id,seed}, players:[...], bots:[...], beacon, mobs }
    bots[] carry w/bd/hd (crafted weapon + armor ids) for rendering
  { t:"event", kind:"airdrop"|"landed"|"beaconDown"|"win"|"reset"|"node"|"build"|"mob"|"bot", data }
  { t:"board", winners:[...] }
  { t:"pong" }
*/
