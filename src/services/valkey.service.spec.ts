import { ValkeyService } from "./valkey.service";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RedisMock = require("ioredis-mock");

const makeConfig = (over: Record<string, any> = {}) =>
  ({
    get: () => ({
      valkey: {
        enabled: true,
        host: "localhost",
        port: 6379,
        username: "",
        password: "",
        db: 0,
        tls: false,
        keyPrefix: "not3",
        flushIntervalSeconds: 60,
        flushMaxQueueSize: 50,
        ...over,
      },
      database: { requestOptimization: "none" },
    }),
  }) as any;

class TestValkeyService extends ValkeyService {
  protected createClient() {
    return new RedisMock();
  }
}

describe("ValkeyService", () => {
  let svc: TestValkeyService;

  beforeEach(async () => {
    svc = new TestValkeyService(makeConfig());
    await svc.onModuleInit();
  });

  afterEach(async () => {
    await svc.onModuleDestroy();
  });

  it("reports enabled state", () => {
    expect(svc.isEnabled()).toBe(true);
  });

  it("getClient throws when disabled", () => {
    const disabled = new TestValkeyService(makeConfig({ enabled: false }));
    expect(() => disabled.getClient()).toThrow("Valkey is not enabled");
  });

  it("counts requests split by failed flag", async () => {
    await svc.createRequest("1.2.3.4", false, 60_000, 300_000);
    await svc.createRequest("1.2.3.4", false, 60_000, 300_000);
    await svc.createRequest("1.2.3.4", true, 60_000, 300_000);
    expect(await svc.getRequests("1.2.3.4")).toEqual({ total: 3, failed: 1 });
    expect(await svc.getRequests("5.6.7.8")).toEqual({ total: 0, failed: 0 });
  });

  it("accumulates tokens per ip", async () => {
    await svc.createToken("1.2.3.4", 1000, 3_600_000);
    await svc.createToken("1.2.3.4", 500, 3_600_000);
    expect(await svc.getTokens("1.2.3.4")).toBe(1500);
    expect(await svc.getTokens("5.6.7.8")).toBe(0);
  });

  it("bans and unbans by ttl key", async () => {
    expect(await svc.isBanned("1.2.3.4")).toBe(false);
    await svc.ban("1.2.3.4", 60_000);
    expect(await svc.isBanned("1.2.3.4")).toBe(true);
  });
});
