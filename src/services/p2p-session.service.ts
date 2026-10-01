import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import { nanoId } from "src/etc/esm-fix";
import { ConfigService } from "./config.service";

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
export class P2PSessionService implements OnApplicationShutdown {
  private readonly sessions = new Map<string, P2PSession>();
  private readonly byIp = new Map<string, Set<string>>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: ConfigService) {}

  create(
    ip: string,
    creator: P2PPeerHandle,
    kind: P2PKind = "transfer",
  ): P2PJoin | "too-many" {
    const cfg = this.config.get().p2p;
    if (this.sessionsForIp(ip) >= cfg.maxSessionsPerIp) return "too-many";
    let id: string;
    do {
      id = nanoId(21);
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
      this.sweepTimer = setInterval(() => this.sweepStale(), 60_000);
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
