import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import Valkey from "iovalkey";
import { ConfigService } from "./config.service";
import { Note } from "src/types/db/Note";

@Injectable()
export class ValkeyService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ValkeyService.name);
  private client: Valkey | null = null;
  private subscriber: Valkey | null = null;

  constructor(private readonly config: ConfigService) {}

  protected createClient(): Valkey {
    const cfg = this.config.get().valkey;
    return new Valkey({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      db: cfg.db,
      tls: cfg.tls ? {} : undefined,
    });
  }

  async onModuleInit() {
    const cfg = this.config.get();
    if (cfg.database.requestOptimization === "hard" && !cfg.valkey.enabled) {
      this.logger.fatal(
        "DATABASE_REQUEST_OPTIMIZATION 'hard' requires VALKEY_ENABLED=true",
      );
      process.exit(1);
    }
    if (!cfg.valkey.enabled) return;
    try {
      this.client = this.createClient();
      await this.client.ping();
      this.logger.log("Connected to valkey");
    } catch (e) {
      this.logger.fatal("Failed to connect to valkey");
      this.logger.fatal((e as Error)?.stack ?? e);
      process.exit(1);
    }
  }

  // Disconnecting happens on application shutdown rather than in
  // onModuleDestroy: nest runs every onModuleDestroy hook first, and
  // DatabaseService flushes its valkey-backed write buffer in one of them.
  // Closing the client earlier would make that flush fail.
  async onApplicationShutdown() {
    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
      this.subscriber = null;
    }
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  isEnabled(): boolean {
    return !!this.client;
  }

  getClient(): Valkey {
    if (!this.client) throw new Error("Valkey is not enabled");
    return this.client;
  }

  private key(...parts: string[]): string {
    return [this.config.get().valkey.keyPrefix, ...parts].join(":");
  }

  async p2pRegisterSession(
    id: string,
    kind: "transfer" | "room",
    creatorId: string,
    maxPeers: number,
    ttlMs: number,
    ip?: string,
  ): Promise<void> {
    const metadata = this.key("p2p", "session", id);
    const members = this.key("p2p", "peers", id);
    await this.getClient().set(
      metadata,
      JSON.stringify({ kind, creatorId, maxPeers, ip }),
      "PX",
      ttlMs,
    );
    await this.getClient().rpush(members, creatorId);
    await this.getClient().pexpire(members, ttlMs);
  }

  async p2pReserveIpSession(
    ip: string,
    id: string,
    maxSessions: number,
    ttlMs: number,
  ): Promise<boolean> {
    const script = `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
      local hadQuota = redis.call('EXISTS', KEYS[1])
      redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[4])
      local quotaTtl = redis.call('PTTL', KEYS[1])
      if hadQuota == 0 or (quotaTtl >= 0 and quotaTtl < tonumber(ARGV[2])) then
        redis.call('PEXPIRE', KEYS[1], ARGV[2])
      end
      return 1
    `;
    const result = await this.getClient().eval(
      script,
      1,
      this.key("p2p", "ip", ip),
      Date.now(),
      ttlMs,
      maxSessions,
      id,
    );
    return Number(result) === 1;
  }

  async p2pReleaseIpSession(ip: string, id: string): Promise<void> {
    await this.getClient().zrem(this.key("p2p", "ip", ip), id);
  }

  async p2pSessionExists(id: string): Promise<boolean> {
    return (
      (await this.getClient().exists(this.key("p2p", "session", id))) === 1
    );
  }

  async p2pGetSession(id: string): Promise<{
    kind: "transfer" | "room";
    creatorId: string;
    maxPeers: number;
    ip?: string;
    peers: string[];
  } | null> {
    const raw = await this.getClient().get(this.key("p2p", "session", id));
    if (!raw) return null;
    return {
      ...JSON.parse(raw),
      peers: await this.getClient().lrange(this.key("p2p", "peers", id), 0, -1),
    };
  }

  async p2pJoinSession(
    id: string,
    peerId: string,
    ttlMs: number,
  ): Promise<
    | {
        kind: "transfer" | "room";
        creatorId: string;
        maxPeers: number;
        ip?: string;
        peers: string[];
      }
    | "not-found"
    | "session-full"
    | "duplicate-peer"
  > {
    const session = await this.p2pGetSession(id);
    if (!session) return "not-found";
    const script = `
      if redis.call('EXISTS', KEYS[1]) == 0 then return {'__not_found__'} end
      local peers = redis.call('LRANGE', KEYS[2], 0, -1)
      for _, peer in ipairs(peers) do if peer == ARGV[1] then return {'__duplicate_peer__'} end end
      if #peers >= tonumber(ARGV[2]) then return {'__session_full__'} end
      redis.call('RPUSH', KEYS[2], ARGV[1])
      redis.call('PEXPIRE', KEYS[1], ARGV[3])
      redis.call('PEXPIRE', KEYS[2], ARGV[3])
      return peers
    `;
    const peers = (await this.getClient().eval(
      script,
      2,
      this.key("p2p", "session", id),
      this.key("p2p", "peers", id),
      peerId,
      session.maxPeers,
      ttlMs,
    )) as string[];
    if (peers[0] === "__not_found__") return "not-found";
    if (peers[0] === "__duplicate_peer__") return "duplicate-peer";
    if (peers[0] === "__session_full__") return "session-full";
    await this.p2pTouchSession(id, ttlMs);
    return { ...session, peers };
  }

  async p2pLeaveSession(
    id: string,
    peerId: string,
    graceMs: number,
  ): Promise<{
    kind: "transfer" | "room";
    creatorId: string;
    maxPeers: number;
    ip?: string;
    peers: string[];
  } | null> {
    const session = await this.p2pGetSession(id);
    if (!session) return null;
    const script = `
      if redis.call('EXISTS', KEYS[1]) == 0 then return {'__not_found__'} end
      local peers = redis.call('LRANGE', KEYS[2], 0, -1)
      local found = false
      for _, peer in ipairs(peers) do if peer == ARGV[1] then found = true end end
      if not found then return {'__not_found__'} end
      redis.call('LREM', KEYS[2], 0, ARGV[1])
      local remaining = redis.call('LRANGE', KEYS[2], 0, -1)
      if ARGV[2] == 'transfer' and ARGV[1] == ARGV[3] then
        redis.call('DEL', KEYS[1], KEYS[2])
        if ARGV[7] == '1' then redis.call('ZREM', KEYS[3], ARGV[5]) end
      elseif ARGV[2] == 'room' and #remaining == 0 then
        redis.call('PEXPIRE', KEYS[1], ARGV[4])
        redis.call('PEXPIRE', KEYS[2], ARGV[4])
        if ARGV[7] == '1' then
          local hadQuota = redis.call('EXISTS', KEYS[3])
          redis.call('ZADD', KEYS[3], tonumber(ARGV[6]) + tonumber(ARGV[4]), ARGV[5])
          local quotaTtl = redis.call('PTTL', KEYS[3])
          if hadQuota == 0 or (quotaTtl >= 0 and quotaTtl < tonumber(ARGV[4])) then
            redis.call('PEXPIRE', KEYS[3], ARGV[4])
          end
        end
      end
      return remaining
    `;
    const peers = (await this.getClient().eval(
      script,
      3,
      this.key("p2p", "session", id),
      this.key("p2p", "peers", id),
      this.key("p2p", "ip", session.ip ?? "none"),
      peerId,
      session.kind,
      session.creatorId,
      Math.max(1, graceMs),
      id,
      Date.now(),
      session.ip ? "1" : "0",
    )) as string[];
    if (peers[0] === "__not_found__") return null;
    session.peers = peers;
    return session;
  }

  async p2pTouchSession(id: string, ttlMs: number): Promise<void> {
    const session = await this.p2pGetSession(id);
    if (!session) return;
    const script = `
      if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('LLEN', KEYS[2]) == 0 then return 0 end
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
      redis.call('PEXPIRE', KEYS[2], ARGV[1])
      if ARGV[4] == '1' then
        local hadQuota = redis.call('EXISTS', KEYS[3])
        redis.call('ZADD', KEYS[3], tonumber(ARGV[2]) + tonumber(ARGV[1]), ARGV[3])
        local quotaTtl = redis.call('PTTL', KEYS[3])
        if hadQuota == 0 or (quotaTtl >= 0 and quotaTtl < tonumber(ARGV[1])) then
          redis.call('PEXPIRE', KEYS[3], ARGV[1])
        end
      end
      return 1
    `;
    await this.getClient().eval(
      script,
      3,
      this.key("p2p", "session", id),
      this.key("p2p", "peers", id),
      this.key("p2p", "ip", session.ip ?? "none"),
      ttlMs,
      Date.now(),
      id,
      session.ip ? "1" : "0",
    );
  }

  async p2pDeleteSession(id: string, knownIp?: string): Promise<void> {
    const ip = knownIp ?? (await this.p2pGetSession(id))?.ip;
    if (ip) await this.p2pReleaseIpSession(ip, id);
    await this.getClient().del(
      this.key("p2p", "session", id),
      this.key("p2p", "peers", id),
    );
  }

  async p2pPublish(msg: object): Promise<void> {
    await this.getClient().publish(this.key("p2p", "bus"), JSON.stringify(msg));
  }

  async p2pSubscribe(callback: (msg: any) => void): Promise<void> {
    if (this.subscriber) return;
    this.subscriber = this.createClient();
    const channel = this.key("p2p", "bus");
    this.subscriber.on("message", (received, raw) => {
      if (received !== channel) return;
      try {
        callback(JSON.parse(raw));
      } catch (err) {
        this.logger.warn(`Invalid P2P bus message: ${(err as Error).message}`);
      }
    });
    await this.subscriber.subscribe(channel);
  }

  async createRequest(
    ip: string,
    failed: boolean,
    totalWindowMs: number,
    failedWindowMs: number,
  ): Promise<void> {
    const client = this.getClient();
    const k = this.key("req", failed ? "failed" : "ok", ip);
    const count = await client.incr(k);
    if (count === 1)
      await client.pexpire(k, failed ? failedWindowMs : totalWindowMs);
  }

  async getRequests(ip: string): Promise<{ total: number; failed: number }> {
    const client = this.getClient();
    const [ok, failed] = await client.mget(
      this.key("req", "ok", ip),
      this.key("req", "failed", ip),
    );
    return {
      total: Number(ok ?? 0) + Number(failed ?? 0),
      failed: Number(failed ?? 0),
    };
  }

  async createToken(ip: string, used: number, windowMs: number): Promise<void> {
    const client = this.getClient();
    const k = this.key("tokens", ip);
    const count = await client.incrby(k, used);
    if (count === used) await client.pexpire(k, windowMs);
  }

  async getTokens(ip: string): Promise<number> {
    return Number((await this.getClient().get(this.key("tokens", ip))) ?? 0);
  }

  async ban(ip: string, durationMs: number): Promise<void> {
    await this.getClient().set(this.key("ban", ip), "1", "PX", durationMs);
  }

  async isBanned(ip: string): Promise<boolean> {
    return (await this.getClient().exists(this.key("ban", ip))) === 1;
  }

  async bufferNote(note: Note): Promise<void> {
    await this.getClient().hset(
      this.key("pending", "notes"),
      note.id,
      JSON.stringify(note),
    );
  }

  async getBufferedNote(id: string): Promise<Note | null> {
    const raw = await this.getClient().hget(this.key("pending", "notes"), id);
    return raw ? (JSON.parse(raw) as Note) : null;
  }

  async removeBufferedNote(id: string): Promise<boolean> {
    return (await this.getClient().hdel(this.key("pending", "notes"), id)) > 0;
  }

  async bufferNoteDelete(id: string): Promise<void> {
    await this.getClient().sadd(this.key("pending", "note-deletes"), id);
  }

  async isNoteDeletePending(id: string): Promise<boolean> {
    return (
      (await this.getClient().sismember(
        this.key("pending", "note-deletes"),
        id,
      )) === 1
    );
  }

  async getPendingCount(): Promise<number> {
    const client = this.getClient();
    const [notes, deletes] = await Promise.all([
      client.hlen(this.key("pending", "notes")),
      client.scard(this.key("pending", "note-deletes")),
    ]);
    return notes + deletes;
  }

  async drainPending(): Promise<{ notes: Note[]; deletes: string[] }> {
    const client = this.getClient();
    const [rawNotes, deletes] = await Promise.all([
      client.hgetall(this.key("pending", "notes")),
      client.smembers(this.key("pending", "note-deletes")),
    ]);
    const ids = Object.keys(rawNotes);
    if (ids.length) await client.hdel(this.key("pending", "notes"), ...ids);
    if (deletes.length)
      await client.srem(this.key("pending", "note-deletes"), ...deletes);
    return {
      notes: ids.map((id) => JSON.parse(rawNotes[id]) as Note),
      deletes,
    };
  }
}
