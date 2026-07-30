import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cron } from "@nestjs/schedule";
import { Cache } from "cache-manager";
import { resolve, join } from "path";
import { mkdirSync, existsSync } from "fs";

import { ConfigService } from "./config.service";
import { Note, NoteInsert } from "src/types/db/Note";
import { FileInsert, File } from "src/types/db/File";
import { StatsResponse } from "src/types/api/StatsResponse";

import knex from "knex";
import { nanoId, pRetry } from "src/etc/esm-fix";
import {
  intervalElapsed,
  OPTIMIZATION_PROFILES,
  OptimizationProfile,
  RequestOptimizationMode,
} from "src/etc/optimization";
import { ValkeyService } from "./valkey.service";

@Injectable()
export class DatabaseService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DatabaseService.name);
  private knex: knex.Knex;
  private nanoId: (size: number) => string;
  private ready = false;
  private lastCleanup = 0;
  private lastFlush = Date.now();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly config: ConfigService,
    private readonly valkey: ValkeyService,
  ) {}

  onApplicationBootstrap() {
    this.ready = true;
  }

  async onModuleDestroy() {
    const cfg = this.config.get();
    if (
      cfg.database.requestOptimization === "hard" &&
      !cfg.childInstance &&
      this.valkey.isEnabled()
    )
      await this.flushNow().catch((e) => this.logger.error(e));
    await this.knex.destroy();
  }

  async onModuleInit() {
    try {
      const cfg = this.config.get().database;
      if (cfg.mode === "sqlite3") {
        const dir = resolve(join(process.cwd(), cfg.filename, ".."));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }

      const connection: any =
        cfg.mode === "sqlite3"
          ? { filename: cfg.filename }
          : {
              host: cfg.host,
              port: cfg.port,
              user: cfg.user,
              password: cfg.password,
              database: cfg.database,
            };

      if (cfg.mode !== "sqlite3" && cfg.ssl) {
        connection.ssl = cfg.sslRejectUnauthorized
          ? true
          : { rejectUnauthorized: false };
      }

      this.knex = knex({
        client: cfg.mode,
        connection,
        useNullAsDefault: true,
      });
      await this.knex.raw("SELECT 1;");
      this.logger.log("Connected to database");
    } catch (e) {
      this.logger.fatal("Failed to connect to database");
      this.logger.fatal((e as Error)?.stack ?? e);
      process.exit(1);
    }
  }

  getKnex() {
    return this.knex;
  }

  generateId(length?: number) {
    return nanoId(length || this.config.get().idLength);
  }

  private optimizationMode(): RequestOptimizationMode {
    return this.config.get().database
      .requestOptimization as RequestOptimizationMode;
  }

  private profile(): OptimizationProfile {
    return OPTIMIZATION_PROFILES[this.optimizationMode()];
  }

  private async getFromCache<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    const cached = await this.cache.get<T>(key);
    if (cached) return cached;
    const res = await fn();
    await this.cache.set(key, res, ttlMs ?? this.profile().readCacheTtlMs);
    return res;
  }

  private async insert(table: string, data: any): Promise<string> {
    return await pRetry(
      async () => {
        const id = this.generateId();
        await this.knex(table).insert({
          id: id,
          created_at: Date.now(),
          ...data,
        });
        return id;
      },
      { retries: 3 },
    );
  }

  async getNote(id: string): Promise<Note | null> {
    if (this.optimizationMode() === "hard") {
      if (await this.valkey.isNoteDeletePending(id)) return null;
      const buffered = await this.valkey.getBufferedNote(id);
      if (buffered) return buffered;
    }
    return this.getFromCache(`note-${id}`, async () => {
      const res = await this.knex("notes").where("id", id).first();
      return res
        ? {
            ...res,
            created_at: Number(res.created_at),
            expires_at: Number(res.expires_at),
          }
        : null;
    });
  }

  async createNote(note: NoteInsert): Promise<string> {
    if (this.optimizationMode() === "hard") {
      const id = this.generateId();
      const full: Note = { id, created_at: Date.now(), ...note };
      await this.valkey.bufferNote(full);
      this.logger.log(`Buffered note ${id}`);
      return id;
    }
    const res = await this.insert("notes", note);
    this.logger.log(`Created note ${res}`);
    return res;
  }

  async deleteNote(id: string) {
    if (this.optimizationMode() === "hard") {
      const wasBuffered = await this.valkey.removeBufferedNote(id);
      if (!wasBuffered) await this.valkey.bufferNoteDelete(id);
      await this.cache.del(`note-${id}`);
      this.logger.log(
        `Deleted note ${id}${wasBuffered ? " (from buffer)" : " (queued)"}`,
      );
      return;
    }
    await this.knex("notes").where("id", id).del();
    await this.cache.del(`note-${id}`);
    this.logger.log(`Deleted note ${id}`);
  }

  async getTokens(ip: string): Promise<number> {
    if (this.optimizationMode() === "hard") return this.valkey.getTokens(ip);
    const res = await this.knex("tokens").where("ip", ip).select("used");
    return res.reduce((acc, cur) => acc + cur.used, 0);
  }

  async createToken(ip: string, used: number): Promise<void> {
    if (this.optimizationMode() === "hard") {
      await this.valkey.createToken(
        ip,
        used,
        this.config.get().limits.tokensExpireAfterMinutes * 60_000,
      );
    } else {
      await this.insert("tokens", { ip, used });
    }
    this.logger.debug(`Created token for ${ip} with used=${used}`);
  }

  async getRequests(ip: string): Promise<{ total: number; failed: number }> {
    if (this.optimizationMode() === "hard") return this.valkey.getRequests(ip);
    const res = await Promise.all([
      this.knex("requests")
        .where("ip", ip)
        .where("failed", false)
        .count("id as count")
        .first(),
      this.knex("requests")
        .where("ip", ip)
        .where("failed", true)
        .count("id as count")
        .first(),
    ]).then((r) => r.map((r) => r.count as number));
    return {
      total: res[0] + res[1],
      failed: res[1],
    };
  }

  async createRequest(ip: string, failed: boolean): Promise<void> {
    if (this.optimizationMode() === "hard") {
      const limits = this.config.get().limits;
      await this.valkey.createRequest(
        ip,
        failed,
        60_000,
        limits.banFailedRequestsResetAfterMinutes * 60_000,
      );
    } else {
      await this.insert("requests", { ip, failed });
    }
    this.logger.debug(`Created request for ${ip} with failed=${failed}`);
  }

  async isBanned(ip: string): Promise<boolean> {
    if (this.optimizationMode() === "hard") return this.valkey.isBanned(ip);
    const cache = await this.cache.get(`ban-${ip}`);
    if (cache) return true;
    const res = !!(await this.knex("bans").where("ip", ip).first());
    if (res)
      await this.cache.set(`ban-${ip}`, true, this.profile().banCacheTtlMs);
    return res;
  }

  async ban(ip: string) {
    if (this.optimizationMode() === "hard") {
      await this.valkey.ban(
        ip,
        this.config.get().limits.banDurationMinutes * 60_000,
      );
    } else {
      await this.knex("bans").insert({ ip, created_at: Date.now() });
    }
    this.logger.warn(`Banned ${ip}`);
  }

  getFile(id: string): Promise<File | null> {
    return this.getFromCache(`file-${id}`, async () => {
      const res = await this.knex("files").where("id", id).first();
      if (!res) return null;
      return {
        ...res,
        created_at: Number(res.created_at),
        updated_at: Number(res.updated_at),
        expires_at: Number(res.expires_at),
      } as File;
    });
  }

  async createFile(file: FileInsert): Promise<string> {
    const res = await this.insert("files", {
      ...file,
      updated_at: Date.now(),
    } as File);
    this.logger.log(`Created file ${res}`);
    return res;
  }

  async getFiles(ip: string): Promise<File[]> {
    return await this.knex("files").where("ip", ip).select();
  }

  async getTotalFiles(): Promise<number> {
    return Number(
      (await this.knex("files").count("id as count").first()).count,
    );
  }

  async deleteFile(id: string): Promise<void> {
    await this.knex("files").where("id", id).del();
    await this.cache.del(`file-${id}`);
    this.logger.log(`Deleted file ${id}`);
  }

  async updateFile(id: string, data: Partial<File>): Promise<void> {
    await this.knex("files")
      .where("id", id)
      .update({ ...data, id: undefined, updated_at: Date.now() } as File);
    await this.cache.del(`file-${id}`);
    this.logger.debug(`Updated file ${id}`);
  }

  async getExpiredFiles(): Promise<File[]> {
    return await this.knex("files").where("expires_at", "<", Date.now());
  }

  async getUploadFilesLastUpdatedBefore(timestamp: number): Promise<File[]> {
    return await this.knex("files")
      .whereNotNull("upload_id")
      .andWhere("updated_at", "<", timestamp);
  }

  @Cron("* * * * *")
  async cleanUp() {
    if (!this.ready) return;
    const cfg = this.config.get();
    if (cfg.childInstance) return;
    const now = Date.now();
    if (
      !intervalElapsed(this.lastCleanup, now, this.profile().cleanupIntervalMs)
    )
      return;
    this.lastCleanup = now;
    this.logger.debug("Running cleanup cron job");
    const timestamp = now;
    const deletedNotes = await this.knex("notes")
      .where("expires_at", "<", timestamp)
      .del();
    if (deletedNotes) this.logger.log(`Deleted ${deletedNotes} expired notes`);

    const deletedTokens = await this.knex("tokens")
      .where(
        "created_at",
        "<",
        timestamp - 60_000 * cfg.limits.tokensExpireAfterMinutes,
      )
      .del();
    if (deletedTokens)
      this.logger.debug(`Deleted ${deletedTokens} expired tokens`);
    const deletedRequestsNonFailed = await this.knex("requests")
      .where("created_at", "<", timestamp - 60_000)
      .andWhere("failed", false)
      .del();
    if (deletedRequestsNonFailed)
      this.logger.debug(
        `Deleted ${deletedRequestsNonFailed} non-failed requests`,
      );

    const deletedRequestsFailed = await this.knex("requests")
      .where(
        "created_at",
        "<",
        timestamp - 60_000 * cfg.limits.banFailedRequestsResetAfterMinutes,
      )
      .andWhere("failed", true)
      .del();
    if (deletedRequestsFailed)
      this.logger.debug(`Deleted ${deletedRequestsFailed} failed requests`);

    const expiredBans = await this.knex("bans")
      .where(
        "created_at",
        "<",
        timestamp - 60_000 * cfg.limits.banDurationMinutes,
      )
      .del();
    if (expiredBans) this.logger.debug(`Deleted ${expiredBans} expired bans`);

    const total = [
      deletedNotes,
      deletedTokens,
      deletedRequestsNonFailed,
      deletedRequestsFailed,
      expiredBans,
    ].reduce((acc, cur) => acc + cur, 0);

    this.logger.debug(`Finished cleanup cron job, deleted ${total} rows`);
  }

  @Cron("*/10 * * * * *")
  async flushPendingWrites() {
    if (!this.ready) return;
    const cfg = this.config.get();
    if (cfg.childInstance) return;
    if (cfg.database.requestOptimization !== "hard") return;
    const pending = await this.valkey.getPendingCount();
    if (pending === 0) return;
    const intervalMs = cfg.valkey.flushIntervalSeconds * 1000;
    if (
      pending < cfg.valkey.flushMaxQueueSize &&
      !intervalElapsed(this.lastFlush, Date.now(), intervalMs)
    )
      return;
    await this.flushNow();
  }

  async flushNow() {
    this.lastFlush = Date.now();
    const { notes, deletes } = await this.valkey.drainPending();
    const now = Date.now();
    const toInsert = notes.filter((n) => n.expires_at > now);
    try {
      if (toInsert.length) await this.knex.batchInsert("notes", toInsert);
    } catch {
      // batch failed (e.g. a single conflicting row) -> insert row by row
      for (const note of toInsert) {
        try {
          await this.knex("notes").insert(note);
        } catch (e) {
          this.logger.error(`Failed to flush note ${note.id}`);
          this.logger.error((e as Error)?.stack ?? e);
        }
      }
    }
    if (deletes.length) await this.knex("notes").whereIn("id", deletes).del();
    if (toInsert.length || deletes.length)
      this.logger.log(
        `Flushed ${toInsert.length} notes and ${deletes.length} deletes to the database`,
      );
  }

  getStats(): Promise<StatsResponse> {
    return this.getFromCache(
      "stats",
      async () => {
        const [
          totalNotes,
          requestsInLastMinute,
          notExpiredFailedRequests,
          currentUploadingFiles,
          currentFiles,
          bannedIps,
        ] = await Promise.all(
          [
            this.knex("notes").count("id as count").first(),
            this.knex("requests")
              .where("failed", false)
              .count("id as count")
              .first(),
            this.knex("requests")
              .where("failed", true)
              .count("id as count")
              .first(),
            this.knex("files")
              .whereNot("upload_id", null)
              .count("id as count")
              .first(),
            this.knex("files")
              .where("upload_id", null)
              .count("id as count")
              .first(),
            this.knex("bans").count("ip as count").first(),
          ].map((p) => p.then((r) => Number(r.count))),
        );
        return {
          time: Math.round(Date.now() / 1000),
          totalNotes,
          requestsInLastMinute,
          notExpiredFailedRequests,
          currentUploadingFiles,
          currentFiles,
          bannedIps,
        };
      },
      this.profile().statsCacheTtlMs,
    );
  }
}
