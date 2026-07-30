import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "src/app.module";

export interface TestApp {
  app: NestExpressApplication;
  server: any;
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
): Promise<TestApp> {
  const applied = { ...DEFAULT_ENV, ...env };
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(applied)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

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
    async close() {
      await app.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
