import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import { GameRoom } from "./room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Never let one bad message / edge case take the whole process down (which on a
// host like Render would show up as periodic "no-server" restarts). Log and live.
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

const app = express();
const PUBLIC = path.join(__dirname, "..", "public");
app.get("/healthz", (_req, res) => res.type("text").send("ok"));
app.use(express.static(PUBLIC));
// Belt-and-suspenders: always answer "/" with the game even if static index
// resolution is disabled for any reason.
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const room = new GameRoom();
wss.on("connection", (ws) => {
  try { room.onConnect(ws); }
  catch (e) { console.error("onConnect failed:", e); try { ws.terminate(); } catch { /* ignore */ } }
});
wss.on("error", (e) => console.error("wss error:", e));

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
