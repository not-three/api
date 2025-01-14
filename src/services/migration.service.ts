import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { ConfigService } from './config.service';
import knex from 'knex';

@Injectable()
export class MigrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MigrationService.name);
  private readonly breakString = ';;BREAK;;';

  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
  ) {}

  private readonly migrations: ((knex: knex.Knex) => Promise<void>)[] = [
    async (knex) => {
      await knex.schema.createTable('notes', (table) => {
        table.string('id', 32).primary().notNullable();
        table.text('content').notNullable();
        table.string('ip', 39).notNullable();
        table.bigint('created_at').notNullable();
        table.bigint('expires_at').notNullable();
        table.boolean('self_destruct').notNullable();
        table.string('delete_token', 8).nullable();
        table.string('mime', 16).nullable();
      });
      await knex.schema.createTable('tokens', (table) => {
        table.string('id', 32).primary().notNullable();
        table.string('ip', 39).notNullable();
        table.integer('used', 32).notNullable();
        table.bigint('created_at').notNullable();
      });
      await knex.schema.createTable('requests', (table) => {
        table.string('id', 32).primary().notNullable();
        table.string('ip', 39).notNullable();
        table.boolean('failed').notNullable();
        table.bigint('created_at').notNullable();
      });
      await knex.schema.createTable('bans', (table) => {
        table.string('ip', 39).primary().notNullable();
        table.bigint('created_at').notNullable();
      });
      await knex.schema.createTable('files', (table) => {
        table.string('id', 32).primary().notNullable();
        table.string('name', 64).notNullable();
        table.string('ip', 39).notNullable();
        table.integer('part', 16).notNullable();
        table.string('upload_id', 128).nullable();
        table.bigint('created_at').notNullable();
        table.bigint('updated_at').notNullable();
        table.bigint('expires_at').notNullable();
      });
      await knex('migrations').insert({
        id: 1,
        revert: [
          knex.schema.dropTable('notes').toString(),
          knex.schema.dropTable('tokens').toString(),
          knex.schema.dropTable('requests').toString(),
          knex.schema.dropTable('bans').toString(),
          knex.schema.dropTable('files').toString(),
        ].join(this.breakString),
      });
    },
  ];

  async onApplicationBootstrap() {
    const cfg = this.cfg.get();
    if (cfg.childInstance)
      return this.logger.warn('Skipping migrations on child instance');
    const knex = this.db.getKnex();
    const hasTable = await knex.schema.hasTable('migrations');
    if (!hasTable) {
      this.logger.log('Creating migrations table');
      await knex.schema.createTable('migrations', (table) => {
        table.integer('id', 4).primary().notNullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.text('revert').notNullable();
      });
    }
    let level = Number(
      (await knex('migrations').count('id as count').first()).count,
    );
    this.logger.log(`Migrations level: ${level} / ${this.migrations.length}`);

    if (level > this.migrations.length) {
      if (!cfg.allowRevertingMigrations) {
        this.logger.fatal(
          'The database seems to be of a newer version than the application and reverting migrations is disabled',
        );
        process.exit(1);
      }
      this.logger.log(
        'Database is newer than the application, reverting migrations...',
      );
      while (level > this.migrations.length) {
        const revertEntry = await knex('migrations')
          .where('id', level)
          .select('revert')
          .first();
        if (!revertEntry) break;
        const statements = revertEntry.revert.split(this.breakString);
        for (const statement of statements) await knex.raw(statement);
        await knex('migrations').where('id', level).del();
        level--;
        this.logger.log(
          `Migrations level: ${level} / ${this.migrations.length}`,
        );
      }
      return;
    }

    while (level < this.migrations.length) {
      this.logger.log(`Running migration ${level + 1}`);
      await knex.transaction(this.migrations[level]);
      level++;
      this.logger.log(`Migrations level: ${level} / ${this.migrations.length}`);
    }
  }
}
