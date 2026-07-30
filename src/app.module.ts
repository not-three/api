import { Logger, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { CacheModule, CacheOptions } from "@nestjs/cache-manager";
import Keyv from "keyv";
import KeyvValkey from "@keyv/valkey";
import Valkey from "iovalkey";
import { BaseConfig } from "./config/Base";
import { CreateController } from "./controller/create.controller";
import { FetchController } from "./controller/fetch.controller";
import { DeleteController } from "./controller/delete.controller";
import { StatsController } from "./controller/stats.controller";
import { FilesController } from "./controller/files.controller";
import { ConfigService } from "./services/config.service";
import { DatabaseService } from "./services/database.service";
import { CryptoService } from "./services/crypto.service";
import { MigrationService } from "./services/migration.service";
import { S3Service } from "./services/s3.service";
import { ValkeyService } from "./services/valkey.service";

function cacheFactory(): CacheOptions {
  const cfg = new BaseConfig().valkey;
  if (!cfg.enabled) return {};
  const client = new Valkey({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    db: cfg.db,
    tls: cfg.tls ? {} : undefined,
  });
  const keyv = new Keyv({
    store: new KeyvValkey(client),
    namespace: `${cfg.keyPrefix}:cache`,
  });
  keyv.on("error", (err) => new Logger("CacheModule").error(err?.stack ?? err));
  return { stores: [keyv] };
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    CacheModule.registerAsync({ useFactory: cacheFactory }),
  ],
  controllers: [
    CreateController,
    FetchController,
    DeleteController,
    StatsController,
    FilesController,
  ],
  providers: [
    ConfigService,
    ValkeyService,
    DatabaseService,
    CryptoService,
    MigrationService,
    S3Service,
  ],
})
export class AppModule {}
