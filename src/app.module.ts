import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { CreateController } from './controller/create.controller';
import { FetchController } from './controller/fetch.controller';
import { DeleteController } from './controller/delete.controller';
import { StatsController } from './controller/stats.controller';
import { FilesController } from './controller/files.controller';
import { ConfigService } from './services/config.service';
import { DatabaseService } from './services/database.service';
import { CryptoService } from './services/crypto.service';
import { MigrationService } from './services/migration.service';
import { S3Service } from './services/s3.service';

@Module({
  imports: [ScheduleModule.forRoot(), CacheModule.register()],
  controllers: [
    CreateController,
    FetchController,
    DeleteController,
    StatsController,
    FilesController,
  ],
  providers: [
    ConfigService,
    DatabaseService,
    CryptoService,
    MigrationService,
    S3Service,
  ],
})
export class AppModule {}
