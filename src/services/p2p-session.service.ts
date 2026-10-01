import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { nanoId } from "src/etc/esm-fix";
import { ConfigService } from "./config.service";
import { ValkeyService } from "./valkey.service";

export type P2PKind = "transfer" | "room";
export interface P2PPeerHandle {
  send(frame: object): void;
  kill(): void;
}
export interface P2PSession {
  id: string;
  ip: string;
  kind: P2PKind;
  creatorId: string;
  peers: Map<string, P2PPeerHandle>;
  maxPeers: number;
  createdAt: number;
  lastActivity: number;
  graceTimer?: ReturnType<typeof setTimeout>;
}
export interface P2PJoin {
  session: P2PSession;
  peerId: string;
  peers: string[];
}

@Injectable()
export class P2PSessionService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly sessions = new Map<string, P2PSession>();
  private readonly logger = new Logger(P2PSessionService.name);
  private readonly byIp = new Map<string, Set<string>>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly origin = randomUUID();
  private readonly relayPeers = new Map<string, Map<string, P2PPeerHandle>>();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly valkey?: ValkeyService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get().p2p.enabled || !this.valkey?.isEnabled()) return;
    await this.valkey.p2pSubscribe((message) => {
      if (
        message.origin === this.origin ||
        typeof message.sessionId !== "string" ||
        typeof message.targetPeerId !== "string"
      )
        return;
      const target = this.relayPeers
        .get(message.sessionId)
        ?.get(message.targetPeerId);
      if (target && message.frame && typeof message.frame === "object")
        this.safeSend(target, message.frame);
    });
  }

  relayEnabled(): boolean {
    return !!this.valkey?.isEnabled();
  }

  async relayCreate(
    ip: string,
    handle: P2PPeerHandle,
    kind: P2PKind,
  ): Promise<P2PJoin | "too-many"> {
    for (const id of [...(this.byIp.get(ip) ?? [])]) {
      if (!(await this.valkey!.p2pSessionExists(id))) {
        this.destroy(id, false);
        this.relayPeers.delete(id);
      }
    }
    const result = this.create(ip, handle, kind);
    if (result === "too-many") return result;
    try {
      const reserved = await this.valkey!.p2pReserveIpSession(
        ip,
        result.session.id,
        this.config.get().p2p.maxSessionsPerIp,
        this.ttlMs(),
      );
      if (!reserved) {
        this.destroy(result.session.id, false);
        return "too-many";
      }
      await this.valkey!.p2pRegisterSession(
        result.session.id,
        kind,
        result.peerId,
        result.session.maxPeers,
        this.ttlMs(),
        ip,
      );
      this.attachRelay(result.session.id, result.peerId, handle);
      return result;
    } catch (err) {
      this.destroy(result.session.id, false);
      try {
        await this.valkey!.p2pDeleteSession(result.session.id, ip);
      } catch (cleanupErr) {
        this.logger.warn(`P2P create rollback failed: ${String(cleanupErr)}`);
      }
      throw err;
    }
  }

  async relayJoin(
    id: string,
    handle: P2PPeerHandle,
  ): Promise<
    | { kind: P2PKind; peerId: string; peers: string[] }
    | "not-found"
    | "session-full"
  > {
    for (let attempt = 0; attempt < 5; attempt++) {
      const peerId = nanoId(12);
      try {
        const joined = await this.valkey!.p2pJoinSession(
          id,
          peerId,
          this.ttlMs(),
        );
        if (joined === "duplicate-peer") continue;
        if (typeof joined === "string") return joined;
        this.attachRelay(id, peerId, handle);
        for (const targetPeerId of joined.peers)
          await this.publishRelay(id, targetPeerId, {
            type: "peer-joined",
            peerId,
          });
        this.touch(id);
        return {
          kind: joined.kind,
          peerId,
          peers: joined.kind === "room" ? joined.peers : [],
        };
      } catch (err) {
        try {
          await this.valkey!.p2pLeaveSession(
            id,
            peerId,
            this.config.get().p2p.roomGraceSeconds * 1000,
          );
        } catch (cleanupErr) {
          this.logger.warn(`P2P join rollback failed: ${String(cleanupErr)}`);
        }
        const local = this.relayPeers.get(id);
        local?.delete(peerId);
        if (local && !local.size) this.relayPeers.delete(id);
        throw err;
      }
    }
    throw new Error("Could not allocate a unique P2P peer ID");
  }

  async relaySend(
    id: string,
    from: string,
    to: string | undefined,
    frame: object,
  ): Promise<boolean> {
    const session = await this.valkey!.p2pGetSession(id);
    if (!session || !session.peers.includes(from)) return false;
    const target =
      session.kind === "transfer" ? session.peers.find((p) => p !== from) : to;
    if (!target || target === from || !session.peers.includes(target))
      return false;
    await this.publishRelay(id, target, frame);
    await this.valkey!.p2pTouchSession(id, this.ttlMs());
    this.touch(id);
    return true;
  }

  async relaySession(id: string) {
    return this.valkey!.p2pGetSession(id);
  }

  async relayLeave(id: string, peerId: string): Promise<void> {
    const local = this.relayPeers.get(id);
    if (!local?.has(peerId)) return;
    const updated = await this.valkey!.p2pLeaveSession(
      id,
      peerId,
      this.config.get().p2p.roomGraceSeconds * 1000,
    );
    local.delete(peerId);
    if (!local.size) this.relayPeers.delete(id);
    if (updated)
      for (const targetPeerId of updated.peers)
        await this.publishRelay(id, targetPeerId, {
          type: "peer-left",
          peerId,
        });
    if (this.sessions.get(id)?.creatorId === peerId) this.destroy(id, false);
  }

  async relayLeaveFor(handle: P2PPeerHandle): Promise<void> {
    for (const [id, peers] of [...this.relayPeers])
      for (const [peerId, current] of [...peers])
        if (current === handle) await this.relayLeave(id, peerId);
  }

  async sweepRelayed(): Promise<number> {
    if (!this.relayEnabled()) return 0;
    let count = 0;
    for (const [id, peers] of [...this.relayPeers]) {
      if (await this.valkey!.p2pSessionExists(id)) continue;
      this.relayPeers.delete(id);
      this.destroy(id, false);
      for (const handle of peers.values()) {
        this.safeSend(handle, { type: "error", code: "not-found" });
        this.safeKill(handle);
      }
      count++;
    }
    return count;
  }

  private attachRelay(id: string, peerId: string, handle: P2PPeerHandle): void {
    const peers = this.relayPeers.get(id) ?? new Map<string, P2PPeerHandle>();
    peers.set(peerId, handle);
    this.relayPeers.set(id, peers);
  }

  private async publishRelay(
    id: string,
    targetPeerId: string,
    frame: object,
  ): Promise<void> {
    const local = this.relayPeers.get(id)?.get(targetPeerId);
    if (local) {
      this.safeSend(local, frame);
      return;
    }
    await this.valkey!.p2pPublish({
      origin: this.origin,
      sessionId: id,
      targetPeerId,
      frame,
    });
  }

  private ttlMs(): number {
    return this.config.get().p2p.sessionTtlMinutes * 60_000;
  }

  create(
    ip: string,
    creator: P2PPeerHandle,
    kind: P2PKind = "transfer",
  ): P2PJoin | "too-many" {
    const cfg = this.config.get().p2p;
    if (this.sessionsForIp(ip) >= cfg.maxSessionsPerIp) return "too-many";
    let id: string;
    do {
      id = nanoId(this.config.get().idLength);
    } while (this.sessions.has(id));
    const peerId = nanoId(12);
    const now = Date.now();
    const session: P2PSession = {
      id,
      ip,
      kind,
      creatorId: peerId,
      peers: new Map([[peerId, creator]]),
      maxPeers: kind === "transfer" ? 2 : cfg.roomMaxPeers,
      createdAt: now,
      lastActivity: now,
    };
    this.sessions.set(id, session);
    const ids = this.byIp.get(ip) ?? new Set<string>();
    ids.add(id);
    this.byIp.set(ip, ids);
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        if (this.relayEnabled())
          void this.sweepRelayed().catch((err) =>
            this.logger.warn(`P2P sweep failed: ${(err as Error).message}`),
          );
        else this.sweepStale();
      }, 60_000);
      this.sweepTimer.unref();
    }
    return { session, peerId, peers: [] };
  }

  join(
    id: string,
    peer: P2PPeerHandle,
  ): P2PJoin | "not-found" | "session-full" {
    const session = this.sessions.get(id);
    if (!session) return "not-found";
    if (session.peers.size >= session.maxPeers) return "session-full";
    const peers = session.kind === "room" ? [...session.peers.keys()] : [];
    let peerId: string;
    do {
      peerId = nanoId(12);
    } while (session.peers.has(peerId));
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = undefined;
    for (const existing of session.peers.values())
      this.safeSend(existing, { type: "peer-joined", peerId });
    session.peers.set(peerId, peer);
    session.lastActivity = Date.now();
    return { session, peerId, peers };
  }

  get(id: string): P2PSession | null {
    return this.sessions.get(id) ?? null;
  }
  sessionsForIp(ip: string): number {
    return this.byIp.get(ip)?.size ?? 0;
  }
  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastActivity = Date.now();
  }

  send(
    id: string,
    from: string,
    to: string | undefined,
    frame: object,
  ): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.peers.has(from)) return false;
    const target =
      session.kind === "transfer"
        ? [...session.peers.keys()].find((peerId) => peerId !== from)
        : to;
    if (!target || target === from) return false;
    const peer = session.peers.get(target);
    if (!peer) return false;
    this.safeSend(peer, frame);
    this.touch(id);
    return true;
  }

  leave(id: string, peerId: string): void {
    const session = this.sessions.get(id);
    if (!session || !session.peers.delete(peerId)) return;
    for (const peer of session.peers.values())
      this.safeSend(peer, { type: "peer-left", peerId });
    if (session.kind === "transfer" && peerId === session.creatorId) {
      this.destroy(id, false);
    } else if (session.kind === "room" && session.peers.size === 0) {
      session.graceTimer = setTimeout(
        () => this.destroy(id, false),
        Math.max(0, this.config.get().p2p.roomGraceSeconds) * 1000,
      );
      session.graceTimer.unref();
    }
  }

  destroy(id: string, notify = true): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.graceTimer) clearTimeout(session.graceTimer);
    if (notify)
      for (const [peerId, peer] of session.peers) {
        for (const [otherId, other] of session.peers)
          if (otherId !== peerId)
            this.safeSend(other, { type: "peer-left", peerId });
        this.safeKill(peer);
      }
    this.sessions.delete(id);
    const ids = this.byIp.get(session.ip);
    ids?.delete(id);
    if (!ids?.size) this.byIp.delete(session.ip);
  }

  destroyAllFor(handle: P2PPeerHandle): void {
    for (const session of [...this.sessions.values()]) {
      for (const [peerId, peer] of session.peers)
        if (peer === handle) this.leave(session.id, peerId);
    }
  }

  sweepStale(): number {
    if (this.relayEnabled()) return 0;
    let count = 0;
    const cutoff =
      Date.now() - this.config.get().p2p.sessionTtlMinutes * 60_000;
    for (const session of [...this.sessions.values()])
      if (session.lastActivity < cutoff) {
        this.destroy(session.id);
        count++;
      }
    return count;
  }

  onApplicationShutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const id of [...this.sessions.keys()]) this.destroy(id, false);
  }

  private safeSend(peer: P2PPeerHandle, frame: object): void {
    try {
      peer.send(frame);
    } catch {
      /* disconnected */
    }
  }
  private safeKill(peer: P2PPeerHandle): void {
    try {
      peer.kill();
    } catch {
      /* disconnected */
    }
  }
}
