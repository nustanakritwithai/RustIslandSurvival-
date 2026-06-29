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
  { t:"pos", x, y, dir, hp, carrying }
  { t:"beacon", action:"grab"|"plant"|"lift", x, y }
  { t:"beaconDmg", amt }
  { t:"ping" }

Server -> Client
  { t:"welcome", v, id, slot:{remain,id}, board }
  { t:"snapshot", now, slot:{remain,id}, players:[...], bots:[...], beacon }
  { t:"event", kind:"airdrop"|"landed"|"win"|"reset", data }
  { t:"board", winners:[...] }
  { t:"pong" }
*/
