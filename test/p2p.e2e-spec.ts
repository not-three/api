import WebSocket from "ws";
import { createTestApp, TestApp } from "./app";
import { DatabaseService } from "src/services/database.service";
import { ValkeyService } from "src/services/valkey.service";
import request from "supertest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RedisMock = require("ioredis-mock");

type Frame = Record<string, any>;
const inbox = new WeakMap<
  WebSocket,
  { queue: Frame[]; waiters: ((frame: Frame) => void)[] }
>();
function frame(ws: WebSocket): Promise<Frame> {
  const state = inbox.get(ws)!;
  if (state.queue.length) return Promise.resolve(state.queue.shift()!);
  return new Promise((resolve) => state.waiters.push(resolve));
}
async function connect(port: number, ip: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/p2p`, {
    headers: { "X-Forwarded-For": ip },
  });
  const state = {
    queue: [] as Frame[],
    waiters: [] as ((frame: Frame) => void)[],
  };
  inbox.set(ws, state);
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Frame;
    const waiter = state.waiters.shift();
    if (waiter) waiter(message);
    else state.queue.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}
function send(ws: WebSocket, data: object) {
  ws.send(JSON.stringify(data));
}

describe("P2P gateway", () => {
  let t: TestApp;
  let port: number;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    t = await createTestApp({
      P2P_ENABLED: "true",
      P2P_ROOM_MAX_PEERS: "3",
      P2P_ROOM_GRACE_SECONDS: "0",
    });
    port = await t.listen();
  });
  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.terminate();
  });
  afterAll(async () => t.close());
  const open = async (ip = "10.9.0.1") => {
    const ws = await connect(port, ip);
    sockets.push(ws);
    return ws;
  };

  it("creates transfer, joins, relays opaque signals, and permits receiver rejoin", async () => {
    const a = await open(),
      b = await open("10.9.0.2");
    send(a, { type: "create" });
    const created = await frame(a);
    expect(created).toMatchObject({
      type: "created",
      kind: "transfer",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    expect(created.sessionId).toMatch(/^.{21}$/);
    expect(created.peerId).toMatch(/^.{8,16}$/);
    send(b, { type: "join", sessionId: created.sessionId });
    const joined = await frame(b);
    expect(joined).toMatchObject({
      type: "joined",
      kind: "transfer",
      sessionId: created.sessionId,
      peers: [],
    });
    expect(await frame(a)).toMatchObject({
      type: "peer-joined",
      peerId: joined.peerId,
    });
    const payload = { nested: [1, { sdp: "opaque" }] };
    send(a, { type: "signal", payload });
    expect(await frame(b)).toEqual({
      type: "signal",
      from: created.peerId,
      payload,
    });
    send(b, { type: "signal", payload: { answer: true } });
    expect(await frame(a)).toEqual({
      type: "signal",
      from: joined.peerId,
      payload: { answer: true },
    });
    send(b, { type: "leave" });
    expect(await frame(a)).toEqual({
      type: "peer-left",
      peerId: joined.peerId,
    });
    const c = await open("10.9.0.3");
    send(c, { type: "join", sessionId: created.sessionId });
    expect(await frame(c)).toMatchObject({
      type: "joined",
      sessionId: created.sessionId,
    });
  });

  it("caps transfer and rejects unknown sessions", async () => {
    const a = await open(),
      b = await open(),
      c = await open();
    send(a, { type: "create" });
    const created = await frame(a);
    send(b, { type: "join", sessionId: created.sessionId });
    await frame(b);
    await frame(a);
    send(c, { type: "join", sessionId: created.sessionId });
    expect(await frame(c)).toEqual({ type: "error", code: "session-full" });
    const d = await open();
    send(d, { type: "join", sessionId: "missing" });
    expect(await frame(d)).toEqual({ type: "error", code: "not-found" });
  });

  it("routes room signals only to the addressed peer and expires empty rooms", async () => {
    const a = await open(),
      b = await open(),
      c = await open(),
      d = await open();
    send(a, { type: "create", kind: "room" });
    const created = await frame(a);
    send(b, { type: "join", sessionId: created.sessionId });
    const bj = await frame(b);
    await frame(a);
    expect(bj.peers).toEqual([created.peerId]);
    send(c, { type: "join", sessionId: created.sessionId });
    const cj = await frame(c);
    await frame(a);
    await frame(b);
    expect(cj.peers).toEqual([created.peerId, bj.peerId]);
    send(d, { type: "join", sessionId: created.sessionId });
    expect(await frame(d)).toEqual({ type: "error", code: "session-full" });
    send(b, { type: "signal", to: cj.peerId, payload: { target: "c" } });
    expect(await frame(c)).toEqual({
      type: "signal",
      from: bj.peerId,
      payload: { target: "c" },
    });
    send(a, { type: "leave" });
    await frame(b);
    await frame(c);
    send(b, { type: "leave" });
    await frame(c);
    send(c, { type: "leave" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const e = await open();
    send(e, { type: "join", sessionId: created.sessionId });
    expect(await frame(e)).toEqual({ type: "error", code: "not-found" });
  });

  it("rejects room signals without a valid destination", async () => {
    const a = await open();
    send(a, { type: "create", kind: "room" });
    await frame(a);
    send(a, { type: "signal", payload: {} });
    expect(await frame(a)).toEqual({ type: "error", code: "invalid-message" });
  });

  it("removes a transfer when its creator disconnects", async () => {
    const a = await open(),
      b = await open();
    send(a, { type: "create" });
    const created = await frame(a);
    send(b, { type: "join", sessionId: created.sessionId });
    const joined = await frame(b);
    await frame(a);
    a.terminate();
    expect(await frame(b)).toEqual({
      type: "peer-left",
      peerId: created.peerId,
    });
    const c = await open();
    send(c, { type: "join", sessionId: created.sessionId });
    expect(await frame(c)).toEqual({ type: "error", code: "not-found" });
    expect(joined.peerId).toBeDefined();
  });

  it("rejects oversized and malformed frames", async () => {
    const a = await open();
    a.send("x".repeat(100_000));
    expect(await frame(a)).toEqual({ type: "error", code: "invalid-message" });
    const b = await open();
    send(b, { type: "nope" });
    expect(await frame(b)).toEqual({ type: "error", code: "invalid-message" });
  });

  it("rejects banned IPs during upgrade", async () => {
    await t.app.get(DatabaseService).ban("10.9.9.9");
    await expect(connect(port, "10.9.9.9")).rejects.toThrow("418");
  });
});

it("does not accept WebSocket upgrades while P2P is disabled", async () => {
  const t = await createTestApp();
  try {
    const port = await t.listen();
    await expect(connect(port, "10.9.8.1")).rejects.toThrow();
  } finally {
    await t.close();
  }
});

describe("P2P abuse accounting", () => {
  let t: TestApp, port: number;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    t = await createTestApp({
      P2P_ENABLED: "true",
      P2P_MAX_MESSAGES_PER_MINUTE: "5",
      LIMITS_BAN_AFTER_FAILED_REQUESTS: "3",
      LIMITS_MAX_REQUESTS_PER_IP_PER_MINUTE: "10",
    });
    port = await t.listen();
  });
  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.terminate();
  });
  afterAll(async () => t.close());
  const open = async (ip: string) => {
    const ws = await connect(port, ip);
    sockets.push(ws);
    return ws;
  };

  it("closes a socket after its sixth message in one minute", async () => {
    const a = await open("10.10.1.1");
    for (let n = 0; n < 5; n++) {
      send(a, { type: "join", sessionId: `absent-${n}` });
      expect(await frame(a)).toEqual({ type: "error", code: "not-found" });
    }
    send(a, { type: "join", sessionId: "absent-6" });
    expect(await frame(a)).toEqual({ type: "error", code: "rate-limited" });
  });

  it("bans failed joins through the shared HTTP ban store", async () => {
    const ip = "10.10.2.1";
    const a = await open(ip);
    for (let n = 0; n < 3; n++) {
      send(a, { type: "join", sessionId: `missing-${n}` });
      expect(await frame(a)).toEqual({ type: "error", code: "not-found" });
    }
    await request(t.server).get("/info").set("X-Forwarded-For", ip).expect(418);
  });

  it("counts WebSocket upgrades against the HTTP request budget", async () => {
    const ip = "10.10.3.1";
    for (let n = 0; n < 10; n++) await open(ip);
    await expect(connect(port, ip)).rejects.toThrow("429");
  });
});

it("bypasses P2P abuse limits when limits are disabled", async () => {
  const t = await createTestApp({
    P2P_ENABLED: "true",
    LIMITS_DISABLED: "true",
    P2P_MAX_MESSAGES_PER_MINUTE: "1",
    LIMITS_MAX_REQUESTS_PER_IP_PER_MINUTE: "1",
    LIMITS_BAN_AFTER_FAILED_REQUESTS: "1",
  });
  const sockets: WebSocket[] = [];
  try {
    const port = await t.listen();
    const a = await connect(port, "10.11.1.1");
    sockets.push(a);
    const b = await connect(port, "10.11.1.1");
    sockets.push(b);
    for (let n = 0; n < 3; n++) {
      send(a, { type: "join", sessionId: `missing-${n}` });
      expect(await frame(a)).toEqual({ type: "error", code: "not-found" });
    }
    await request(t.server)
      .get("/info")
      .set("X-Forwarded-For", "10.11.1.1")
      .expect(200);
  } finally {
    sockets.forEach((ws) => ws.terminate());
    await t.close();
  }
});

describe("P2P Valkey relay", () => {
  let a: TestApp, b: TestApp, c: TestApp;
  let ports: number[];
  const sockets: WebSocket[] = [];
  const base = new RedisMock();
  beforeAll(async () => {
    const env = {
      P2P_ENABLED: "true",
      P2P_ROOM_MAX_PEERS: "3",
      P2P_MAX_SESSIONS_PER_IP: "1",
      P2P_ROOM_GRACE_SECONDS: "1",
      DATABASE_REQUEST_OPTIMIZATION: "hard",
      VALKEY_ENABLED: "false",
      LIMITS_BAN_AFTER_FAILED_REQUESTS: "2",
    };
    const overrides = { valkeyClientFactory: () => base.duplicate() };
    a = await createTestApp(env, overrides);
    b = await createTestApp(env, overrides);
    c = await createTestApp(env, overrides);
    ports = [await a.listen(), await b.listen(), await c.listen()];
  });
  afterEach(() => sockets.splice(0).forEach((ws) => ws.terminate()));
  afterAll(async () => {
    await Promise.all([a.close(), b.close(), c.close()]);
    await base.quit();
  });
  const open = async (index: number, ip: string) => {
    const ws = await connect(ports[index], ip);
    sockets.push(ws);
    return ws;
  };

  it("relays transfer signaling between two replicas", async () => {
    const sender = await open(0, "10.12.1.1"),
      receiver = await open(1, "10.12.1.2");
    send(sender, { type: "create" });
    const created = await frame(sender);
    send(receiver, { type: "join", sessionId: created.sessionId });
    const joined = await frame(receiver);
    expect(joined).toMatchObject({
      type: "joined",
      kind: "transfer",
      peers: [],
    });
    expect(await frame(sender)).toEqual({
      type: "peer-joined",
      peerId: joined.peerId,
    });
    send(sender, { type: "signal", payload: { offer: "x" } });
    expect(await frame(receiver)).toEqual({
      type: "signal",
      from: created.peerId,
      payload: { offer: "x" },
    });
    send(receiver, { type: "signal", payload: { answer: "y" } });
    expect(await frame(sender)).toEqual({
      type: "signal",
      from: joined.peerId,
      payload: { answer: "y" },
    });
    send(receiver, { type: "leave" });
    expect(await frame(sender)).toEqual({
      type: "peer-left",
      peerId: joined.peerId,
    });
  });

  it("routes room signals by peer ID across three replicas", async () => {
    const first = await open(0, "10.12.2.1"),
      second = await open(1, "10.12.2.2"),
      third = await open(2, "10.12.2.3");
    send(first, { type: "create", kind: "room" });
    const created = await frame(first);
    send(second, { type: "join", sessionId: created.sessionId });
    const joinedB = await frame(second);
    expect(joinedB.peers).toEqual([created.peerId]);
    expect(await frame(first)).toEqual({
      type: "peer-joined",
      peerId: joinedB.peerId,
    });
    send(third, { type: "join", sessionId: created.sessionId });
    const joinedC = await frame(third);
    expect(joinedC.peers).toEqual([created.peerId, joinedB.peerId]);
    expect(await frame(first)).toEqual({
      type: "peer-joined",
      peerId: joinedC.peerId,
    });
    expect(await frame(second)).toEqual({
      type: "peer-joined",
      peerId: joinedC.peerId,
    });
    const overflow = await open(2, "10.12.2.4");
    send(overflow, { type: "join", sessionId: created.sessionId });
    expect(await frame(overflow)).toEqual({
      type: "error",
      code: "session-full",
    });
    send(second, { type: "signal", to: joinedC.peerId, payload: { for: "c" } });
    expect(await frame(third)).toEqual({
      type: "signal",
      from: joinedB.peerId,
      payload: { for: "c" },
    });
    send(third, { type: "signal", to: created.peerId, payload: { for: "a" } });
    expect(await frame(first)).toEqual({
      type: "signal",
      from: joinedC.peerId,
      payload: { for: "a" },
    });
    send(second, { type: "leave" });
    expect(await frame(first)).toEqual({
      type: "peer-left",
      peerId: joinedB.peerId,
    });
    expect(await frame(third)).toEqual({
      type: "peer-left",
      peerId: joinedB.peerId,
    });
  });

  it("applies the creator IP session cap across replicas", async () => {
    const first = await open(0, "10.12.3.1");
    const second = await open(1, "10.12.3.1");
    send(first, { type: "create", kind: "room" });
    expect((await frame(first)).type).toBe("created");
    send(second, { type: "create" });
    expect(await frame(second)).toEqual({
      type: "error",
      code: "rate-limited",
    });
    send(first, { type: "leave" });
  });

  it("allows a room to rejoin during grace and frees its IP quota after expiry", async () => {
    const creator = await open(0, "10.12.4.1");
    send(creator, { type: "create", kind: "room" });
    const created = await frame(creator);
    send(creator, { type: "leave" });
    const rejoin = await open(1, "10.12.4.2");
    send(rejoin, { type: "join", sessionId: created.sessionId });
    expect(await frame(rejoin)).toMatchObject({
      type: "joined",
      sessionId: created.sessionId,
      peers: [],
    });
    send(rejoin, { type: "leave" });
    await new Promise((resolve) => setTimeout(resolve, 1150));
    const late = await open(2, "10.12.4.3");
    send(late, { type: "join", sessionId: created.sessionId });
    expect(await frame(late)).toEqual({ type: "error", code: "not-found" });
    const next = await open(0, "10.12.4.1");
    send(next, { type: "create", kind: "room" });
    expect((await frame(next)).type).toBe("created");
  });

  it("frees a local creator slot after Valkey expires its session", async () => {
    const creator = await open(0, "10.12.5.1");
    send(creator, { type: "create" });
    const created = await frame(creator);
    await a.app.get(ValkeyService).p2pDeleteSession(created.sessionId);
    const next = await open(0, "10.12.5.1");
    send(next, { type: "create" });
    expect((await frame(next)).type).toBe("created");
  });

  it("shares failed-join bans with HTTP on another replica", async () => {
    const ip = "10.12.6.1";
    const peer = await open(1, ip);
    for (let n = 0; n < 2; n++) {
      send(peer, { type: "join", sessionId: `missing-${n}` });
      expect(await frame(peer)).toEqual({ type: "error", code: "not-found" });
    }
    await request(a.server).get("/info").set("X-Forwarded-For", ip).expect(418);
  });
});
