/**
 * dot(.)music Phone Remote relay.
 *
 * Each Mac owns one room (a Durable Object named by a random 128-bit id). The Mac connects
 * as the host with a secret token; phones connect as clients with a random peer id. The
 * relay only routes frames: everything a Mac and a phone say to each other is sealed with
 * AES-GCM keys the relay never sees (the pairing secret travels in the QR link's #fragment).
 *
 * Frames (JSON text):
 *   phone → relay  {m}            | {pair}                  sealed payloads
 *   relay → Mac    {from, m}      | {from, pair}            | {peer, event: "join" | "leave"} | {peers: [...]}
 *   Mac → relay    {to, m}        | {kick}
 *   relay → phone  {m}            | {host: "online" | "offline"}
 */
import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

const ROOM_ID = /^[a-f0-9]{32}$/;
const PEER_ID = /^[a-f0-9]{16,64}$/;
const MAX_FRAME = 64 * 1024;
const MAX_PHONES = 8;
/** Per phone, per second. */
const MAX_RATE = 20;
/** Phones from one network address at once; the rest of the slots stay free for others. */
const MAX_PHONES_PER_ADDRESS = 4;
/** Phone connection attempts per network address per minute. */
const MAX_JOINS_PER_MINUTE = 20;
/** A room whose Mac hasn't connected for this long is deleted; the Mac recreates it. */
const IDLE_ROOM_MS = 60 * 24 * 60 * 60 * 1000;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two hex digests. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Room extends DurableObject<Env> {
  /** Message counts per phone in the current second (reset when the room hibernates). */
  private rate = new Map<string, { second: number; count: number }>();
  /** Phone connection attempts per address in the current minute (in memory only). */
  private joins = new Map<string, { minute: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private host(): WebSocket | undefined {
    return this.ctx.getWebSockets("host")[0];
  }

  private phone(peer: string): WebSocket | undefined {
    return this.ctx.getWebSockets(`peer:${peer}`)[0];
  }

  private peers(): string[] {
    return this.ctx
      .getWebSockets("client")
      .map((ws) => (ws.deserializeAttachment() as { peer?: string } | null)?.peer)
      .filter((p): p is string => Boolean(p));
  }

  private static send(ws: WebSocket | undefined, frame: unknown) {
    try {
      ws?.send(JSON.stringify(frame));
    } catch {
      // Closing socket: nothing to deliver.
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (role === "host") {
      const token = url.searchParams.get("token") ?? "";
      if (token.length < 32) return new Response("Bad token", { status: 400 });
      const digest = await sha256(token);
      const stored = await this.ctx.storage.get<string>("hostHash");
      if (!stored) await this.ctx.storage.put("hostHash", digest);
      else if (!sameDigest(stored, digest)) return new Response("Not your room", { status: 403 });

      for (const old of this.ctx.getWebSockets("host")) old.close(4000, "Replaced by a newer connection");
      this.ctx.acceptWebSocket(server, ["host"]);
      // Each Mac visit pushes the clean-up back.
      await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_MS);
      Room.send(server, { peers: this.peers() });
      for (const phone of this.ctx.getWebSockets("client")) Room.send(phone, { host: "online" });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === "client") {
      const peer = url.searchParams.get("peer") ?? "";
      if (!PEER_ID.test(peer)) return new Response("Bad peer id", { status: 400 });
      const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!this.allowJoin(address)) return new Response("Too many attempts", { status: 429 });
      // The same phone reconnecting replaces its old connection.
      for (const old of this.ctx.getWebSockets(`peer:${peer}`)) old.close(4000, "Replaced by a newer connection");
      if (this.ctx.getWebSockets("client").length >= MAX_PHONES) {
        return new Response("Too many phones", { status: 429 });
      }
      const fromAddress = this.ctx
        .getWebSockets("client")
        .filter((ws) => (ws.deserializeAttachment() as { address?: string } | null)?.address === address).length;
      if (fromAddress >= MAX_PHONES_PER_ADDRESS) {
        return new Response("Too many phones from this network", { status: 429 });
      }
      this.ctx.acceptWebSocket(server, ["client", `peer:${peer}`]);
      server.serializeAttachment({ peer, address });
      Room.send(server, { host: this.host() ? "online" : "offline" });
      Room.send(this.host(), { peer, event: "join" });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Unknown role", { status: 400 });
  }

  private allowJoin(address: string): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    const used = this.joins.get(address);
    if (used && used.minute === minute) return ++used.count <= MAX_JOINS_PER_MINUTE;
    if (this.joins.size > 1000) this.joins.clear();
    this.joins.set(address, { minute, count: 1 });
    return true;
  }

  /** Deletes a room its Mac hasn't visited in IDLE_ROOM_MS, unless someone is still connected. */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_FRAME) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }

    if (this.ctx.getTags(ws).includes("host")) {
      if (typeof frame.kick === "string") {
        this.phone(frame.kick)?.close(4001, "Disconnected by the Mac");
        return;
      }
      if (typeof frame.to === "string" && typeof frame.m === "string") {
        Room.send(this.phone(frame.to), { m: frame.m });
      }
      return;
    }

    const peer = (ws.deserializeAttachment() as { peer?: string } | null)?.peer;
    if (!peer) return;
    const second = Math.floor(Date.now() / 1000);
    const used = this.rate.get(peer);
    if (used && used.second === second) {
      if (++used.count > MAX_RATE) return;
    } else {
      this.rate.set(peer, { second, count: 1 });
    }
    if (typeof frame.m === "string") Room.send(this.host(), { from: peer, m: frame.m });
    else if (typeof frame.pair === "string") Room.send(this.host(), { from: peer, pair: frame.pair });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.ctx.getTags(ws).includes("host")) {
      // A replaced host leaves a newer one behind; only an empty room is offline.
      if (this.ctx.getWebSockets("host").every((h) => h === ws)) {
        for (const phone of this.ctx.getWebSockets("client")) Room.send(phone, { host: "offline" });
      }
      return;
    }
    const peer = (ws.deserializeAttachment() as { peer?: string } | null)?.peer;
    if (peer && !this.ctx.getWebSockets(`peer:${peer}`).some((other) => other !== ws)) {
      this.rate.delete(peer);
      Room.send(this.host(), { peer, event: "leave" });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (match) {
      if (!ROOM_ID.test(match[1])) return new Response("Bad room id", { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(match[1])).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
