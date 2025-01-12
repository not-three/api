import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cron } from '@nestjs/schedule';
import { Cache } from 'cache-manager';
import { resolve, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

import { ConfigService } from './config.service';
import { Note, NoteInsert } from 'src/types/db/Note';
import { FileInsert, File } from 'src/types/db/File';
import { StatsResponse } from 'src/types/api/StatsResponse';

import type pRetry from 'p-retry';
import knex from 'knex';

@Injectable()
export class DatabaseService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DatabaseService.name);
  private knex: knex.Knex;
  private nanoId: (size: number) => string;
  private pRetry: typeof pRetry;
  private ready = false;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    this.ready = true;
  }

  onModuleDestroy() {
    this.knex.destroy();
  }

  async onModuleInit() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.nanoId = require('fix-esm').require('nanoid').nanoid;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.pRetry = require('fix-esm').require('p-retry').default;
    try {
      const cfg = this.config.get().database;
      if (cfg.mode === 'sqlite3') {
        const dir = resolve(join(process.cwd(), cfg.filename, '..'));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }
      this.knex = knex({
        client: cfg.mode,
        connection: cfg,
        useNullAsDefault: true,
      });
      await this.knex.raw('SELECT 1;');
      this.logger.log('Connected to database');
    } catch (e) {
      this.logger.fatal('Failed to connect to database');
      this.logger.fatal(e?.stack ?? e);
      process.exit(1);
    }
  }

  getKnex() {
    return this.knex;
  }

  generateId(length?: number) {
    return this.nanoId(length || this.config.get().idLength);
  }

  private async getFromCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const cached = await this.cache.get<T>(key);
    if (cached) return cached;
    const res = await fn();
    await this.cache.set(key, res, 30_000);
    return res;
  }

  private async insert(table: string, data: any): Promise<string> {
    return await this.pRetry(
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

  getNote(id: string): Promise<Note | null> {
    return this.getFromCache(`note-${id}`, async () => {
      const res = await this.knex('notes').where('id', id).first();
      return res || null;
    });
  }

  async createNote(note: NoteInsert): Promise<string> {
    const res = await this.insert('notes', note);
    this.logger.log(`Created note ${res}`);
    return res;
  }

  async deleteNote(id: string) {
    await this.knex('notes').where('id', id).del();
    await this.cache.del(`note-${id}`);
    this.logger.log(`Deleted note ${id}`);
  }

  async getTokens(ip: string): Promise<number> {
    const res = await this.knex('tokens').where('ip', ip).select('used');
    return res.reduce((acc, cur) => acc + cur.used, 0);
  }

  async createToken(ip: string, used: number): Promise<void> {
    await this.insert('tokens', { ip, used });
    this.logger.debug(`Created token for ${ip} with used=${used}`);
  }

  async getRequests(ip: string): Promise<{ total: number; failed: number }> {
    const res = await this.knex('requests').where('ip', ip).select('failed');
    return {
      total: res.length,
      failed: res.filter((r) => r.failed).length,
    };
  }

  async createRequest(ip: string, failed: boolean): Promise<void> {
    await this.insert('requests', { ip, failed });
    this.logger.debug(`Created request for ${ip} with failed=${failed}`);
  }

  async isBanned(ip: string): Promise<boolean> {
    const cache = await this.cache.get(`ban-${ip}`);
    if (cache) return true;
    const res = !!(await this.knex('bans').where('ip', ip).first());
    if (res) await this.cache.set(`ban-${ip}`, true, 60_000);
    return res;
  }

  async ban(ip: string) {
    await this.knex('bans').insert({ ip, created_at: Date.now() });
    this.logger.warn(`Banned ${ip}`);
  }

  getFile(id: string): Promise<File | null> {
    return this.getFromCache(`file-${id}`, async () => {
      const res = await this.knex('files').where('id', id).first();
      if (res) return res as File;
      return null;
    });
  }

  async createFile(file: FileInsert): Promise<string> {
    const res = await this.insert('files', {
      ...file,
      updated_at: Date.now(),
    } as File);
    this.logger.log(`Created file ${res}`);
    return res;
  }

  async getFiles(ip: string): Promise<File[]> {
    return await this.knex('files').where('ip', ip).select();
  }

  async getTotalFiles(): Promise<number> {
    return (await this.knex('files').count('id as count').first())
      .count as number;
  }

  async deleteFile(id: string): Promise<void> {
    await this.knex('files').where('id', id).del();
    this.logger.log(`Deleted file ${id}`);
  }

  async updateFile(id: string, data: Partial<File>): Promise<void> {
    await this.knex('files')
      .where('id', id)
      .update({ ...data, id: undefined, updated_at: Date.now() } as File);
    await this.cache.del(`file-${id}`);
    this.logger.debug(`Updated file ${id}`);
  }

  async getExpiredFiles(): Promise<File[]> {
    return await this.knex('files').where('expires_at', '<', Date.now());
  }

  async getUploadFilesLastUpdatedBefore(timestamp: number): Promise<File[]> {
    return await this.knex('files')
      .where('upload_id', '!=', null)
      .andWhere('updated_at', '<', timestamp);
  }

  @Cron('* * * * *')
  async cleanUp() {
    if (!this.ready) return;
    this.logger.debug('Running cleanup cron job');
    const timestamp = Date.now();
    const cfg = this.config.get();
    const deletedNotes = await this.knex('notes')
      .where('expires_at', '<', timestamp)
      .del();
    if (deletedNotes) this.logger.log(`Deleted ${deletedNotes} expired notes`);

    const deletedTokens = await this.knex('tokens')
      .where(
        'created_at',
        '<',
        timestamp - 60_000 * cfg.limits.tokensExpireAfterMinutes,
      )
      .del();
    if (deletedTokens)
      this.logger.debug(`Deleted ${deletedTokens} expired tokens`);
    const deletedRequestsNonFailed = await this.knex('requests')
      .where('created_at', '<', timestamp - 60_000)
      .andWhere('failed', false)
      .del();
    if (deletedRequestsNonFailed)
      this.logger.debug(
        `Deleted ${deletedRequestsNonFailed} non-failed requests`,
      );

    const deletedRequestsFailed = await this.knex('requests')
      .where(
        'created_at',
        '<',
        timestamp - 60_000 * cfg.limits.banFailedRequestsResetAfterMinutes,
      )
      .andWhere('failed', true)
      .del();
    if (deletedRequestsFailed)
      this.logger.debug(`Deleted ${deletedRequestsFailed} failed requests`);

    const expiredBans = await this.knex('bans')
      .where(
        'created_at',
        '<',
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

  getStats(): Promise<StatsResponse> {
    return this.getFromCache('stats', async () => {
      const [
        totalNotes,
        requestsInLastMinute,
        notExpiredFailedRequests,
        currentUploadingFiles,
        currentFiles,
      ] = await Promise.all(
        [
          this.knex('notes').count('id as count').first(),
          this.knex('requests')
            .where('failed', false)
            .count('id as count')
            .first(),
          this.knex('requests')
            .where('failed', true)
            .count('id as count')
            .first(),
          this.knex('files')
            .whereNot('upload_id', null)
            .count('id as count')
            .first(),
          this.knex('files')
            .where('upload_id', null)
            .count('id as count')
            .first(),
        ].map((p) => p.then((r) => r.count as number)),
      );
      return {
        time: Math.round(Date.now() / 1000),
        totalNotes,
        requestsInLastMinute,
        notExpiredFailedRequests,
        currentUploadingFiles,
        currentFiles,
      };
    });
  }
}
