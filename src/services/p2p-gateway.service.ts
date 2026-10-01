import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { IncomingMessage, Server } from "http";
import { Socket } from "net";
import WebSocket, { WebSocketServer } from "ws";
import { getIp } from "src/etc/getIp";
import { ConfigService } from "./config.service";
import { DatabaseService } from "./database.service";
import { P2PPeerHandle, P2PSessionService } from "./p2p-session.service";

interface PeerState {
  ip: string;
  handle: P2PPeerHandle;
  sessionId?: string;
  peerId?: string;
  messageTimes: number[];
  alive: boolean;
  processing: Promise<void>;
}

@Injectable()
export class P2PGatewayService
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger(P2PGatewayService.name);
  private server?: Server;
  private wss?: WebSocketServer;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly states = new Map<WebSocket, PeerState>();
  private upgradeHandler = (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => {
    void this.upgrade(req, socket, head);
  };

  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly sessions: P2PSessionService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get().p2p.enabled) return;
    this.server = this.adapter.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", this.upgradeHandler);
    this.heartbeat = setInterval(() => {
      for (const [ws, state] of this.states) {
        if (!state.alive) {
          ws.terminate();
          continue;
        }
        state.alive = false;
        ws.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.server) this.server.off("upgrade", this.upgradeHandler);
    const peers = [...this.states.values()];
    try {
      if (this.sessions.relayEnabled()) {
        const results = await Promise.allSettled(
          peers.map((state) => this.sessions.relayLeaveFor(state.handle)),
        );
        for (const result of results)
          if (result.status === "rejected")
            this.logger.warn(
              `P2P relay cleanup failed: ${String(result.reason)}`,
            );
      } else {
        for (const state of peers) this.sessions.destroyAllFor(state.handle);
      }
    } finally {
      for (const ws of this.states.keys()) ws.terminate();
    }
  }

  onApplicationShutdown(): void {
    this.wss?.close();
  }

  private reject(socket: Socket, status: number): void {
    socket.write(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  private async upgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/p2p") {
      socket.destroy();
      return;
    }
    let ip: string;
    try {
      ip = await getIp({
        ip: req.socket.remoteAddress,
        headers: req.headers,
      } as any);
      const limits = this.config.get().limits;
      if (!limits.disabled) {
        if (await this.db.isBanned(ip)) {
          this.reject(socket, 418);
          return;
        }
        const count = await this.db.getRequests(ip);
        if (count.failed >= limits.banAfterFailedRequests) {
          await this.db.ban(ip);
          this.reject(socket, 429);
          return;
        }
        if (count.total >= limits.maxRequestsPerIpPerMinute) {
          this.reject(socket, 429);
          return;
        }
        await this.db.createRequest(ip, false);
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) =>
        this.connected(ws, ip),
      );
    } catch (err) {
      this.logger.warn(`P2P upgrade rejected: ${(err as Error).message}`);
      if (!socket.destroyed) this.reject(socket, 511);
    }
  }

  private connected(ws: WebSocket, ip: string): void {
    const handle: P2PPeerHandle = {
      send: (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      },
      kill: () => ws.close(1008),
    };
    const state: PeerState = {
      ip,
      handle,
      messageTimes: [],
      alive: true,
      processing: Promise.resolve(),
    };
    this.states.set(ws, state);
    ws.on("pong", () => {
      state.alive = true;
    });
    ws.on("message", (raw, binary) => {
      state.processing = state.processing
        .then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          await this.message(ws, state, raw, binary);
        })
        .catch(async (err) => {
          this.logger.warn(`P2P message failed: ${(err as Error).message}`);
          try {
            await this.fail(ws, state, "invalid-message");
          } catch (failure) {
            this.logger.warn(
              `P2P error delivery failed: ${(failure as Error).message}`,
            );
            ws.terminate();
          }
        });
    });
    ws.on("close", () => {
      this.states.delete(ws);
      if (this.sessions.relayEnabled())
        void this.sessions
          .relayLeaveFor(handle)
          .catch((err) => this.logger.warn((err as Error).message));
      else this.sessions.destroyAllFor(handle);
    });
  }

  private async fail(
    ws: WebSocket,
    state: PeerState,
    code: "invalid-message" | "rate-limited",
    close = true,
  ): Promise<void> {
    await this.recordFailure(state.ip);
    state.handle.send({ type: "error", code });
    if (close) ws.close(1008);
  }

  private async recordFailure(ip: string): Promise<void> {
    const limits = this.config.get().limits;
    if (limits.disabled) return;
    await this.db.createRequest(ip, true);
    const count = await this.db.getRequests(ip);
    if (
      count.failed >= limits.banAfterFailedRequests &&
      !(await this.db.isBanned(ip))
    )
      await this.db.ban(ip);
  }

  private async message(
    ws: WebSocket,
    state: PeerState,
    raw: WebSocket.RawData,
    binary: boolean,
  ): Promise<void> {
    const cfg = this.config.get().p2p;
    const now = Date.now();
    while (state.messageTimes.length && state.messageTimes[0] <= now - 60_000)
      state.messageTimes.shift();
    state.messageTimes.push(now);
    if (
      !this.config.get().limits.disabled &&
      state.messageTimes.length > cfg.maxMessagesPerMinute
    ) {
      await this.fail(ws, state, "rate-limited");
      return;
    }
    const bytes = Array.isArray(raw)
      ? raw.reduce((n, b) => n + b.length, 0)
      : raw instanceof ArrayBuffer
        ? raw.byteLength
        : raw.length;
    if (binary || bytes > cfg.maxMessageBytes) {
      await this.fail(ws, state, "invalid-message");
      return;
    }
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      await this.fail(ws, state, "invalid-message");
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      await this.fail(ws, state, "invalid-message");
      return;
    }

    if (frame.type === "create") {
      if (
        state.sessionId ||
        (frame.kind !== undefined &&
          frame.kind !== "room" &&
          frame.kind !== "transfer")
      ) {
        await this.fail(ws, state, "invalid-message");
        return;
      }
      const kind = frame.kind === "room" ? "room" : "transfer";
      if (kind === "room" && !cfg.roomsEnabled) {
        state.handle.send({ type: "error", code: "disabled" });
        return;
      }
      const result = this.sessions.relayEnabled()
        ? await this.sessions.relayCreate(state.ip, state.handle, kind)
        : this.sessions.create(state.ip, state.handle, kind);
      if (result === "too-many") {
        state.handle.send({ type: "error", code: "rate-limited" });
        return;
      }
      state.sessionId = result.session.id;
      state.peerId = result.peerId;
      state.handle.send({
        type: "created",
        sessionId: result.session.id,
        iceServers: cfg.iceServers(),
        kind,
        peerId: result.peerId,
      });
      return;
    }
    if (frame.type === "join") {
      if (
        state.sessionId ||
        typeof frame.sessionId !== "string" ||
        !frame.sessionId
      ) {
        await this.fail(ws, state, "invalid-message");
        return;
      }
      const result = this.sessions.relayEnabled()
        ? await this.sessions.relayJoin(frame.sessionId, state.handle)
        : this.sessions.join(frame.sessionId, state.handle);
      if (typeof result === "string") {
        await this.recordFailure(state.ip);
        state.handle.send({ type: "error", code: result });
        return;
      }
      state.sessionId = frame.sessionId;
      state.peerId = result.peerId;
      state.handle.send({
        type: "joined",
        sessionId: frame.sessionId,
        iceServers: cfg.iceServers(),
        kind: "session" in result ? result.session.kind : result.kind,
        peerId: result.peerId,
        peers: result.peers,
      });
      return;
    }
    if (frame.type === "leave") {
      if (!state.sessionId || !state.peerId) {
        await this.fail(ws, state, "invalid-message");
        return;
      }
      if (this.sessions.relayEnabled())
        await this.sessions.relayLeave(state.sessionId, state.peerId);
      else this.sessions.leave(state.sessionId, state.peerId);
      state.sessionId = undefined;
      state.peerId = undefined;
      return;
    }
    if (frame.type === "signal") {
      const session = state.sessionId
        ? this.sessions.relayEnabled()
          ? await this.sessions.relaySession(state.sessionId)
          : this.sessions.get(state.sessionId)
        : null;
      if (
        !session ||
        !state.peerId ||
        !Object.prototype.hasOwnProperty.call(frame, "payload") ||
        (session.kind === "room" &&
          (typeof frame.to !== "string" ||
            (Array.isArray(session.peers)
              ? !session.peers.includes(frame.to)
              : !session.peers.has(frame.to))))
      ) {
        await this.fail(ws, state, "invalid-message");
        return;
      }
      const delivered = this.sessions.relayEnabled()
        ? await this.sessions.relaySend(
            state.sessionId,
            state.peerId,
            frame.to,
            {
              type: "signal",
              from: state.peerId,
              payload: frame.payload,
            },
          )
        : this.sessions.send(state.sessionId, state.peerId, frame.to, {
            type: "signal",
            from: state.peerId,
            payload: frame.payload,
          });
      if (!delivered) {
        await this.fail(ws, state, "invalid-message");
      }
      return;
    }
    await this.fail(ws, state, "invalid-message");
  }
}
