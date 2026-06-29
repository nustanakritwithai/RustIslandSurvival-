import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import { GameRoom } from "./room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const room = new GameRoom();
wss.on("connection", (ws) => room.onConnect(ws));

// Heartbeat: drop sockets that stop responding so dead carriers release the beacon.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Last Short Island listening on " + PORT));
