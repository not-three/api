import { ValkeyConfig } from "./Valkey";

describe("ValkeyConfig", () => {
  const vars = [
    "VALKEY_ENABLED",
    "VALKEY_HOST",
    "VALKEY_PORT",
    "VALKEY_FLUSH_INTERVAL_SECONDS",
    "VALKEY_FLUSH_MAX_QUEUE_SIZE",
  ];
  afterEach(() => vars.forEach((v) => delete process.env[v]));

  it("has safe defaults", () => {
    const cfg = new ValkeyConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.host).toBe("localhost");
    expect(cfg.port).toBe(6379);
    expect(cfg.keyPrefix).toBe("not3");
    expect(cfg.flushIntervalSeconds).toBe(60);
    expect(cfg.flushMaxQueueSize).toBe(50);
  });

  it("reads values from the environment", () => {
    process.env.VALKEY_ENABLED = "true";
    process.env.VALKEY_HOST = "valkey.internal";
    process.env.VALKEY_PORT = "6380";
    const cfg = new ValkeyConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.host).toBe("valkey.internal");
    expect(cfg.port).toBe(6380);
  });
});
