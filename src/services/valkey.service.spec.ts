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

  const note = (id: string) => ({
    id,
    content: "content-" + id,
    ip: "1.2.3.4",
    created_at: 1000,
    expires_at: 2000,
    self_destruct: false,
    delete_token: null,
    mime: null,
  });

  it("buffers and retrieves notes", async () => {
    await svc.bufferNote(note("a"));
    expect(await svc.getBufferedNote("a")).toEqual(note("a"));
    expect(await svc.getBufferedNote("missing")).toBeNull();
  });

  it("removes buffered notes and reports whether they existed", async () => {
    await svc.bufferNote(note("a"));
    expect(await svc.removeBufferedNote("a")).toBe(true);
    expect(await svc.removeBufferedNote("a")).toBe(false);
    expect(await svc.getBufferedNote("a")).toBeNull();
  });

  it("tracks pending deletes", async () => {
    expect(await svc.isNoteDeletePending("x")).toBe(false);
    await svc.bufferNoteDelete("x");
    expect(await svc.isNoteDeletePending("x")).toBe(true);
  });

  it("counts and drains pending entries", async () => {
    await svc.bufferNote(note("a"));
    await svc.bufferNote(note("b"));
    await svc.bufferNoteDelete("x");
    expect(await svc.getPendingCount()).toBe(3);
    const drained = await svc.drainPending();
    expect(drained.notes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(drained.deletes).toEqual(["x"]);
    expect(await svc.getPendingCount()).toBe(0);
    expect(await svc.isNoteDeletePending("x")).toBe(false);
  });

  it("drains empty state without errors", async () => {
    expect(await svc.drainPending()).toEqual({ notes: [], deletes: [] });
  });
});
