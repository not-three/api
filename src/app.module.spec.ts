import { CACHE_MANAGER, CacheModule } from "@nestjs/cache-manager";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createServer } from "net";
import type { Cache } from "cache-manager";
import { cacheFactory } from "./app.module";

/** Reserves a free localhost port and releases it, so nothing listens on it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe("cacheFactory with Valkey enabled", () => {
  const env = { ...process.env };
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  let listeners: NodeJS.UncaughtExceptionListener[];

  beforeAll(() => {
    // Jest installs its own handlers; replace them so a crash is observable.
    listeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", onUncaught);
  });

  afterAll(() => {
    process.removeListener("uncaughtException", onUncaught);
    listeners.forEach((l) => process.on("uncaughtException", l));
    process.env = env;
  });

  it("survives an unreachable Valkey: no uncaught error, get returns undefined", async () => {
    process.env.VALKEY_ENABLED = "true";
    process.env.VALKEY_HOST = "127.0.0.1";
    process.env.VALKEY_PORT = String(await closedPort());

    // The factory logs every connection error; keep the test output clean.
    const logError = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.registerAsync({ useFactory: cacheFactory })],
    }).compile();

    try {
      const cache = moduleRef.get<Cache>(CACHE_MANAGER);
      const value = await cache.get("missing-key");
      // Give any asynchronous connection error time to surface.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(value).toBeUndefined();
      expect(uncaught).toEqual([]);
    } finally {
      // Stop the Valkey client from reconnecting so Jest can exit.
      await moduleRef.get<Cache>(CACHE_MANAGER).disconnect();
      await moduleRef.close();
      logError.mockRestore();
    }
    // iovalkey retries a queued command ~20 times (about 12s) before it
    // rejects, which is close to the global 15s timeout.
  }, 30000);
});
