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
    await svc.onApplicationShutdown();
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

  it("shares P2P room membership and enforces capacity", async () => {
    await svc.p2pRegisterSession("room", "room", "creator", 3, 60_000);
    expect(await svc.p2pSessionExists("room")).toBe(true);
    expect(await svc.p2pJoinSession("room", "peer-b", 60_000)).toMatchObject({
      peers: ["creator"],
      kind: "room",
    });
    expect(await svc.p2pJoinSession("room", "peer-c", 60_000)).toMatchObject({
      peers: ["creator", "peer-b"],
    });
    expect(await svc.p2pJoinSession("room", "peer-d", 60_000)).toBe(
      "session-full",
    );
    expect(await svc.p2pLeaveSession("room", "peer-b", 1000)).toMatchObject({
      peers: ["creator", "peer-c"],
    });
    await svc.p2pDeleteSession("room");
    expect(await svc.p2pSessionExists("room")).toBe(false);
  });

  it("publishes targeted P2P frames to another subscriber", async () => {
    const got: object[] = [];
    const receiver = new TestValkeyService(makeConfig());
    await receiver.onModuleInit();
    try {
      await receiver.p2pSubscribe((msg) => got.push(msg));
      await svc.p2pPublish({
        sessionId: "s",
        targetPeerId: "b",
        frame: { type: "signal" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(got).toEqual([
        { sessionId: "s", targetPeerId: "b", frame: { type: "signal" } },
      ]);
    } finally {
      await receiver.onApplicationShutdown();
    }
  });

  it("removes its P2P subscription on shutdown", async () => {
    const base = new RedisMock();
    class SharedValkeyService extends ValkeyService {
      protected createClient() {
        return base.duplicate();
      }
    }
    const subscriber = new SharedValkeyService(makeConfig());
    await subscriber.onModuleInit();
    try {
      await subscriber.p2pSubscribe(() => undefined);
      expect(base.channels.listenerCount("not3:p2p:bus")).toBe(1);
    } finally {
      await subscriber.onApplicationShutdown();
      expect(base.channels.listenerCount("not3:p2p:bus")).toBe(0);
      await base.quit();
    }
  });

  it("admits only one of two concurrent peers into the last room slot", async () => {
    await svc.p2pRegisterSession("race", "room", "creator", 2, 60_000);
    const results = await Promise.all([
      svc.p2pJoinSession("race", "peer-a", 60_000),
      svc.p2pJoinSession("race", "peer-b", 60_000),
    ]);
    expect(results.filter((result) => result === "session-full")).toHaveLength(
      1,
    );
    expect((await svc.p2pGetSession("race"))?.peers).toHaveLength(2);
  });

  it("rejects a duplicate peer ID within a session", async () => {
    await svc.p2pRegisterSession("peer-id", "room", "creator", 3, 60_000);
    expect(await svc.p2pJoinSession("peer-id", "creator", 60_000)).toBe(
      "duplicate-peer",
    );
    expect((await svc.p2pGetSession("peer-id"))?.peers).toEqual(["creator"]);
  });

  it("starts room grace when the final peers leave concurrently", async () => {
    await svc.p2pRegisterSession("empty-race", "room", "creator", 3, 60_000);
    await svc.p2pJoinSession("empty-race", "other", 60_000);
    await Promise.all([
      svc.p2pLeaveSession("empty-race", "creator", 10),
      svc.p2pLeaveSession("empty-race", "other", 10),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await svc.p2pSessionExists("empty-race")).toBe(false);
  });

  it("does not extend an empty room beyond its grace through a late touch", async () => {
    await svc.p2pRegisterSession("late-touch", "room", "creator", 3, 60_000);
    await svc.p2pLeaveSession("late-touch", "creator", 10);
    await svc.p2pTouchSession("late-touch", 60_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await svc.p2pSessionExists("late-touch")).toBe(false);
  });
});
