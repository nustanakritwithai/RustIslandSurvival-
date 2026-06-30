// Authoritative round clock. A "round" is a fixed real-time 10-minute slot
// derived from wall-clock time, so every server and client computes the same
// slot id / remaining time for a given moment. This mirrors slotInfo() in the
// original game and is the foundation that keeps all players in sync.
export const SLOT_MS = 1800000; // 30 minutes

export function slotInfo(nowMs = Date.now()) {
  const start = Math.floor(nowMs / SLOT_MS) * SLOT_MS;
  return {
    start,
    end: start + SLOT_MS,
    remain: (start + SLOT_MS - nowMs) / 1000, // seconds left in this round
    id: start,                                  // unique id for this round
    seed: slotSeed(start),                       // shared world seed for this round
  };
}

// Deterministic per-round seed so every client generates the SAME island layout
// for a given round. Derived from the slot id, so it is stable within a round
// and changes each round.
export function slotSeed(id) {
  return (Math.floor(id / SLOT_MS) * 2654435761) % 2147483647 >>> 0 || 1;
}
