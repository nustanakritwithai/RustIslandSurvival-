// Server-side shared winner board. Replaces the client `lsi:winners` storage so
// every player sees the same leaderboard. Persisted to a JSON file; on Render's
// free tier the filesystem is ephemeral (lost on redeploy) which is acceptable
// for the MVP. Point DATA_DIR at a persistent disk later to keep it.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "winners.json");
const MAX = 12;

export class Leaderboard {
  constructor() {
    this.winners = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(FILE, "utf8");
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(0, MAX) : [];
    } catch {
      return [];
    }
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.winners));
    } catch (e) {
      console.warn("leaderboard save failed:", e.message);
    }
  }

  push(name, val) {
    this.winners.unshift({
      name: String(name || "player").slice(0, 16),
      val: Math.max(0, Math.round(+val || 0)),
      ts: Date.now(),
    });
    this.winners = this.winners.slice(0, MAX);
    this._save();
    return this.winners;
  }

  list() {
    return this.winners;
  }
}
