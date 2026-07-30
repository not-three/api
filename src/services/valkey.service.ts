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
