import "./sentry.js";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { AuthError, verifySupabaseToken } from "./auth.js";
import { allowedOrigins, config } from "./config.js";
import { Db, type RoomRow } from "./db.js";
import { logger } from "./logger.js";
import { ScriptureService } from "./pipeline/scripture.js";
import { createProviders } from "./providers/index.js";
import { Peer } from "./rooms/peer.js";
import { RoomManager, SESSION_FRESH_MS } from "./rooms/roomManager.js";
import { flushSentry, reportError } from "./sentry.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const CODE_RE = /^[A-Za-z0-9-]{3,32}$/;
const PING_INTERVAL_MS = 25_000;
const MAX_AUDIO_FRAME = 512 * 1024;

const db = new Db();
const providers = createProviders();
const scripture = new ScriptureService(db);
const rooms = new RoomManager({ db, providers, scripture });
const peers = new WeakMap<WebSocket, Peer>();
const startedAt = Date.now();
let shuttingDown = false;

// ------------------------------------------------------------------ HTTP

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    const status = shuttingDown ? 503 : 200;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        ok: !shuttingDown,
        version: config.APP_VERSION,
        machine: config.FLY_MACHINE_ID ?? null,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        providers: { stt: providers.stt.name, translator: providers.translator.name, tts: providers.tts.name },
        ...rooms.stats(),
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// ------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_FRAME, perMessageDeflate: false });

function reject(socket: Duplex, status: number, message: string, headers: Record<string, string> = {}): void {
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`,
  );
}

/**
 * If the room's live session is owned by another Fly machine, ask Fly's proxy
 * to replay this request there so broadcaster and listeners share one process.
 * Returns true if the request was replayed.
 */
async function maybeReplay(req: http.IncomingMessage, socket: Duplex, roomId: string): Promise<boolean> {
  if (config.DISABLE_FLY_REPLAY || !config.FLY_MACHINE_ID) return false;
  if (req.headers["fly-replay-src"]) return false; // already replayed once; never loop
  const live = await db.getFreshLiveSession(roomId, SESSION_FRESH_MS);
  if (!live?.machine_id || live.machine_id === config.FLY_MACHINE_ID) return false;
  reject(socket, 307, "replay", { "fly-replay": `instance=${live.machine_id}` });
  return true;
}

function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<WebSocket> {
  return new Promise((resolve) => wss.handleUpgrade(req, socket, head, resolve));
}

function clientIp(req: http.IncomingMessage): string | undefined {
  return (req.headers["fly-client-ip"] as string | undefined) ?? req.socket.remoteAddress;
}

function attachPeer(ws: WebSocket, req: http.IncomingMessage): Peer {
  const peer = new Peer(ws, randomUUID(), clientIp(req));
  peers.set(ws, peer);
  ws.on("error", (err) => logger.debug({ err: err.message, peer: peer.id }, "client socket error"));
  return peer;
}

async function handleBroadcast(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
  const roomId = url.searchParams.get("room") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!UUID_RE.test(roomId) || !token) return reject(socket, 400, "room and token are required");

  let userId: string;
  try {
    ({ userId } = await verifySupabaseToken(token));
  } catch (err) {
    logger.info({ roomId, reason: err instanceof AuthError ? err.message : "error" }, "broadcast auth failed");
    return reject(socket, 401, "invalid_token");
  }

  const row = await db.getRoomById(roomId);
  if (!row) return reject(socket, 404, "room_not_found");
  if (!(await db.isOrgMember(row.org_id, userId))) {
    logger.info({ roomId, userId }, "broadcast denied: not an org member");
    return reject(socket, 403, "forbidden");
  }
  if (await maybeReplay(req, socket, roomId)) return;

  const encodingParam = url.searchParams.get("encoding");
  const encoding = encodingParam === "linear16" || encodingParam === "opus" ? encodingParam : undefined;
  const sampleRate = Number(url.searchParams.get("sample_rate")) || undefined;

  const room = await rooms.get(row);
  const ws = await upgrade(req, socket, head);
  const peer = attachPeer(ws, req);
  logger.info({ roomId, userId, peer: peer.id, encoding: encoding ?? "container" }, "broadcaster connected");
  await room.attachBroadcaster(peer, { userId, encoding, sampleRate });
}

async function handleListen(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
  const code = url.searchParams.get("code") ?? "";
  const lang = url.searchParams.get("lang") ?? "";
  const audio = ["1", "true"].includes(url.searchParams.get("audio") ?? "");
  if (!CODE_RE.test(code) || !LANG_RE.test(lang)) return reject(socket, 400, "code and lang are required");

  const row: RoomRow | null = await db.getRoomByCode(code);
  if (!row) return reject(socket, 404, "room_not_found");
  const room = await rooms.get(row);
  if (!room.acceptsLanguage(lang)) return reject(socket, 422, "language_not_available");
  if (!room.isLive && (await maybeReplay(req, socket, row.id))) return;

  const ws = await upgrade(req, socket, head);
  const peer = attachPeer(ws, req);
  logger.debug({ roomId: row.id, lang, audio, peer: peer.id }, "listener connected");
  room.addListener(peer, lang, audio);
}

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => undefined);
  if (shuttingDown) return reject(socket, 503, "shutting_down");

  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin;
  if (allowedOrigins && origin && !allowedOrigins.includes(origin)) return reject(socket, 403, "origin_not_allowed");

  const handler =
    url.pathname === "/broadcast" ? handleBroadcast : url.pathname === "/listen" ? handleListen : null;
  if (!handler) return reject(socket, 404, "not_found");

  handler(req, socket, head, url).catch((err) => {
    reportError(err, { component: "upgrade", path: url.pathname });
    if (socket.writable) reject(socket, 500, "internal_error");
  });
});

// Liveness: ping every client; drop those that did not answer the previous ping
// (mobile networks often leave half-open sockets behind).
const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    const peer = peers.get(ws);
    if (!peer) continue;
    if (!peer.isAlive) {
      ws.terminate();
      continue;
    }
    peer.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS);

// ------------------------------------------------------------- lifecycle

server.listen(config.PORT, "0.0.0.0", () => {
  logger.info({ port: config.PORT }, "unisona realtime worker listening");
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  clearInterval(pingTimer);
  server.close();
  const hardStop = setTimeout(() => process.exit(1), 25_000);
  try {
    await rooms.shutdown();
  } catch (err) {
    reportError(err, { component: "shutdown" });
  }
  for (const ws of wss.clients) ws.terminate();
  await flushSentry();
  clearTimeout(hardStop);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => reportError(err, { component: "unhandledRejection" }));
process.on("uncaughtException", (err) => {
  reportError(err, { component: "uncaughtException" });
  void flushSentry().finally(() => process.exit(1));
});
