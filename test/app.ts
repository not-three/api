import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "src/app.module";
import { ValkeyService } from "src/services/valkey.service";
import { ConfigService } from "src/services/config.service";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { createCache } from "cache-manager";
import Valkey from "iovalkey";

export interface TestApp {
  app: NestExpressApplication;
  server: any;
  listen(): Promise<number>;
  close(): Promise<void>;
}

// BEHIND_PROXY + trust-all lets each test pick its client IP via the
// X-Forwarded-For header. TRUSTED_PROXIES_CACHE=0 disables the module-global
// trust-list cache in getIp.ts, which would otherwise leak between suites
// running in the same jest worker.
const DEFAULT_ENV: Record<string, string> = {
  DATABASE_MODE: "sqlite3",
  DATABASE_FILE: ":memory:",
  BEHIND_PROXY: "true",
  TRUSTED_PROXIES_CACHE: "0",
};

export async function createTestApp(
  env: Record<string, string> = {},
  overrides: { valkeyClientFactory?: () => Valkey } = {},
): Promise<TestApp> {
  const applied = { ...DEFAULT_ENV, ...env };
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(applied)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const builder = Test.createTestingModule({
    imports: [AppModule],
  });
  if (overrides.valkeyClientFactory) {
    const factory = overrides.valkeyClientFactory;
    class AppValkeyService extends ValkeyService {
      private readonly appClient = factory();
      async onModuleInit(): Promise<void> {
        await this.appClient.ping();
      }
      isEnabled(): boolean {
        return true;
      }
      getClient(): Valkey {
        return this.appClient;
      }
      protected createClient(): Valkey {
        return factory();
      }
      async onApplicationShutdown(): Promise<void> {
        await super.onApplicationShutdown();
        await this.appClient.quit();
      }
    }
    builder.overrideProvider(ValkeyService).useFactory({
      factory: (config: ConfigService) => new AppValkeyService(config),
      inject: [ConfigService],
    });
    builder.overrideProvider(CACHE_MANAGER).useValue(createCache());
  }
  const moduleRef = await builder.compile();

  // Mirrors main.ts: rawBody for the text endpoints, same parser limits.
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  app.useBodyParser("json", { limit: "10mb" });
  app.useBodyParser("text", { limit: "10mb" });
  await app.init();

  return {
    app,
    server: app.getHttpServer(),
    async listen() {
      await app.listen(0);
      return (app.getHttpServer().address() as { port: number }).port;
    },
    async close() {
      await app.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
