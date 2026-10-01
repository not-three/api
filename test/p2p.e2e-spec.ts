import WebSocket from "ws";
import { createTestApp, TestApp } from "./app";
import { DatabaseService } from "src/services/database.service";
import request from "supertest";

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
