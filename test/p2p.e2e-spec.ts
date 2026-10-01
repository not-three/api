import WebSocket from "ws";
import { createTestApp, TestApp } from "./app";
import { DatabaseService } from "src/services/database.service";
import { ValkeyService } from "src/services/valkey.service";
import { P2PSessionService } from "src/services/p2p-session.service";
import { P2PGatewayService } from "src/services/p2p-gateway.service";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gateFirstCall(target: any, method: string, stage: "before" | "after") {
  const entered = deferred();
  const release = deferred();
  const original = target[method].bind(target);
  let first = true;
  let args: any[] = [];
  jest.spyOn(target, method).mockImplementation(async (...current: any[]) => {
    if (!first) return original(...current);
    first = false;
    args = current;
    if (stage === "before") {
      entered.resolve();
      await release.promise;
      return original(...current);
    }
    const result = await original(...current);
    entered.resolve();
    await release.promise;
    return result;
  });
  return {
    entered: entered.promise,
    release: release.resolve,
    get args() {
      return args;
    },
  };
}

async function waitUntil(
  check: () => Promise<boolean> | boolean,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

it("rejects room creation when only transfer signaling is enabled", async () => {
  const t = await createTestApp({
    P2P_ENABLED: "true",
    P2P_ROOMS_ENABLED: "false",
  });
  let ws: WebSocket | undefined;
  try {
    const port = await t.listen();
    ws = await connect(port, "10.9.8.2");
    send(ws, { type: "create", kind: "room" });
    expect(await frame(ws)).toEqual({ type: "error", code: "disabled" });
    const info = await request(t.server)
      .get("/info")
      .set("X-Forwarded-For", "10.9.8.2")
      .expect(200);
    expect(info.body).toMatchObject({ p2pEnabled: true, p2pRooms: false });
  } finally {
    ws?.terminate();
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

  it("counts messages over a rolling minute across a window boundary", async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      const peer = await open("10.10.1.2");
      clock.mockReturnValue(now + 59_000);
      for (let n = 0; n < 5; n++) {
        send(peer, { type: "join", sessionId: `rolling-${n}` });
        expect(await frame(peer)).toEqual({ type: "error", code: "not-found" });
      }
      clock.mockReturnValue(now + 61_000);
      send(peer, { type: "join", sessionId: "rolling-six" });
      expect(await frame(peer)).toEqual({
        type: "error",
        code: "rate-limited",
      });
    } finally {
      clock.mockRestore();
    }
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
    await a.app.get(P2PSessionService).sweepRelayed();
    expect(await frame(creator)).toEqual({ type: "error", code: "not-found" });
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

it("reaps an expired room peer on a join-only replica", async () => {
  const base = new RedisMock();
  const env = {
    P2P_ENABLED: "true",
    DATABASE_REQUEST_OPTIMIZATION: "hard",
    VALKEY_ENABLED: "false",
  };
  const overrides = { valkeyClientFactory: () => base.duplicate() };
  const creatorApp = await createTestApp(env, overrides);
  const joinerApp = await createTestApp(env, overrides);
  let creator: WebSocket | undefined;
  let joiner: WebSocket | undefined;
  try {
    const creatorPort = await creatorApp.listen();
    const joinerPort = await joinerApp.listen();
    creator = await connect(creatorPort, "10.18.1.1");
    send(creator, { type: "create", kind: "room" });
    const created = await frame(creator);

    const nativeSetInterval = global.setInterval.bind(global);
    jest
      .spyOn(global, "setInterval")
      .mockImplementation(((handler: any, timeout?: number, ...args: any[]) =>
        nativeSetInterval(
          handler,
          timeout === 60_000 ? 10 : timeout,
          ...args,
        )) as typeof setInterval);
    joiner = await connect(joinerPort, "10.18.1.2");
    send(joiner, { type: "join", sessionId: created.sessionId });
    expect((await frame(joiner)).type).toBe("joined");
    await frame(creator);
    jest.restoreAllMocks();

    send(creator, { type: "leave" });
    expect(await frame(joiner)).toEqual({
      type: "peer-left",
      peerId: created.peerId,
    });
    const valkey = creatorApp.app.get(ValkeyService).getClient();
    await valkey.pexpire(`not3:p2p:session:${created.sessionId}`, 1);
    await valkey.pexpire(`not3:p2p:peers:${created.sessionId}`, 1);
    await waitUntil(
      async () =>
        !(await creatorApp.app
          .get(ValkeyService)
          .p2pSessionExists(created.sessionId)),
    );
    expect(
      await Promise.race([
        frame(joiner),
        new Promise((resolve) => setTimeout(() => resolve("not-reaped"), 300)),
      ]),
    ).toEqual({ type: "error", code: "not-found" });
    await waitUntil(() => joiner!.readyState === WebSocket.CLOSED);
  } finally {
    jest.restoreAllMocks();
    creator?.terminate();
    joiner?.terminate();
    await Promise.all([creatorApp.close(), joinerApp.close()]);
    await base.quit();
  }
});

describe("P2P rapid frames across replicas", () => {
  const base = new RedisMock();
  let first: TestApp, second: TestApp;
  let ports: number[];
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    const env = {
      P2P_ENABLED: "true",
      P2P_MAX_SESSIONS_PER_IP: "10",
      DATABASE_REQUEST_OPTIMIZATION: "hard",
      VALKEY_ENABLED: "false",
    };
    const overrides = { valkeyClientFactory: () => base.duplicate() };
    first = await createTestApp(env, overrides);
    second = await createTestApp(env, overrides);
    ports = [await first.listen(), await second.listen()];
  });
  afterEach(() => sockets.splice(0).forEach((ws) => ws.terminate()));
  afterAll(async () => {
    await Promise.all([first.close(), second.close()]);
    await base.quit();
  });
  const open = async (index: number, ip: string) => {
    const ws = await connect(ports[index], ip);
    sockets.push(ws);
    return ws;
  };

  it("rejects a second create queued before the first Valkey write completes", async () => {
    const peer = await open(0, "10.14.1.1");
    send(peer, { type: "create" });
    send(peer, { type: "create" });
    expect((await frame(peer)).type).toBe("created");
    expect(await frame(peer)).toEqual({
      type: "error",
      code: "invalid-message",
    });
  });

  it("rejects a second join queued before the first Valkey write completes", async () => {
    const owners = [await open(0, "10.14.2.1"), await open(0, "10.14.2.2")];
    const sessions: string[] = [];
    for (const owner of owners) {
      send(owner, { type: "create", kind: "room" });
      sessions.push((await frame(owner)).sessionId);
    }
    const peer = await open(1, "10.14.2.3");
    send(peer, { type: "join", sessionId: sessions[0] });
    send(peer, { type: "join", sessionId: sessions[1] });
    expect((await frame(peer)).type).toBe("joined");
    expect(await frame(peer)).toEqual({
      type: "error",
      code: "invalid-message",
    });
  });
});

describe("P2P disconnect during Valkey admission", () => {
  const base = new RedisMock();
  let host: TestApp, guest: TestApp;
  let ports: number[];
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    const env = {
      P2P_ENABLED: "true",
      P2P_ROOM_MAX_PEERS: "2",
      P2P_MAX_SESSIONS_PER_IP: "1",
      DATABASE_REQUEST_OPTIMIZATION: "hard",
      VALKEY_ENABLED: "false",
    };
    const overrides = { valkeyClientFactory: () => base.duplicate() };
    host = await createTestApp(env, overrides);
    guest = await createTestApp(env, overrides);
    ports = [await host.listen(), await guest.listen()];
  });
  afterEach(() => {
    sockets.splice(0).forEach((ws) => ws.terminate());
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await Promise.all([host.close(), guest.close()]);
    await base.quit();
  });
  const open = async (index: number, ip: string) => {
    const ws = await connect(ports[index], ip);
    sockets.push(ws);
    return ws;
  };

  const createCases = [
    ["before quota reserve", "p2pReserveIpSession", "before"],
    ["after quota reserve", "p2pReserveIpSession", "after"],
    ["before session registration", "p2pRegisterSession", "before"],
    ["after session registration", "p2pRegisterSession", "after"],
  ] as const;
  it.each(createCases)(
    "releases creator state on close %s",
    async (_name, method, stage) => {
      const ip = `10.16.1.${createCases.findIndex((item) => item[1] === method && item[2] === stage) + 1}`;
      const sessions = host.app.get(P2PSessionService);
      const valkey = host.app.get(ValkeyService);
      const finished = deferred();
      const original = sessions.relayCreate.bind(sessions);
      jest
        .spyOn(sessions, "relayCreate")
        .mockImplementation(async (...args) => {
          try {
            return await original(...args);
          } finally {
            finished.resolve();
          }
        });
      const gate = gateFirstCall(valkey, method, stage);
      const peer = await open(0, ip);
      try {
        send(peer, { type: "create", kind: "transfer" });
        await gate.entered;
        const serverPeers = [
          ...(host.app.get(P2PGatewayService) as any).states.keys(),
        ] as WebSocket[];
        const serverPeer = serverPeers[serverPeers.length - 1];
        const closed = new Promise<void>((resolve) =>
          serverPeer.once("close", resolve),
        );
        peer.terminate();
        await closed;
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        gate.release();
      }
      await finished.promise;
      const id = method === "p2pReserveIpSession" ? gate.args[1] : gate.args[0];
      await waitUntil(
        async () =>
          sessions.sessionsForIp(ip) === 0 &&
          !(await valkey.p2pSessionExists(id)) &&
          (await base.zscore(`not3:p2p:ip:${ip}`, id)) === null,
      );
    },
  );

  const joinCases = [
    ["before session lookup", "p2pGetSession", "before"],
    ["before slot admission", "p2pJoinSession", "before"],
    ["after slot admission", "p2pJoinSession", "after"],
    ["before slot touch", "p2pTouchSession", "before"],
    ["after slot touch", "p2pTouchSession", "after"],
  ] as const;
  it.each(joinCases)(
    "releases room slot on close %s",
    async (_name, method, stage) => {
      const index =
        joinCases.findIndex((item) => item[1] === method && item[2] === stage) +
        1;
      const owner = await open(0, `10.16.2.${index}`);
      send(owner, { type: "create", kind: "room" });
      const created = await frame(owner);
      const sessions = guest.app.get(P2PSessionService);
      const valkey = guest.app.get(ValkeyService);
      const finished = deferred();
      const original = sessions.relayJoin.bind(sessions);
      jest.spyOn(sessions, "relayJoin").mockImplementation(async (...args) => {
        try {
          return await original(...args);
        } finally {
          finished.resolve();
        }
      });
      const gate = gateFirstCall(valkey, method, stage);
      const peer = await open(1, `10.16.3.${index}`);
      try {
        send(peer, { type: "join", sessionId: created.sessionId });
        await gate.entered;
        const serverPeers = [
          ...(guest.app.get(P2PGatewayService) as any).states.keys(),
        ] as WebSocket[];
        const serverPeer = serverPeers[serverPeers.length - 1];
        const closed = new Promise<void>((resolve) =>
          serverPeer.once("close", resolve),
        );
        peer.terminate();
        await closed;
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        gate.release();
      }
      await finished.promise;
      await waitUntil(
        async () =>
          JSON.stringify(
            (await valkey.p2pGetSession(created.sessionId))?.peers,
          ) === JSON.stringify([created.peerId]),
      );
    },
  );

  it.each(["p2pReserveIpSession", "p2pRegisterSession"])(
    "rolls back a creator when %s reports failure after writing",
    async (method) => {
      const ip = method === "p2pReserveIpSession" ? "10.16.4.1" : "10.16.4.2";
      const sessions = host.app.get(P2PSessionService);
      const valkey = host.app.get(ValkeyService);
      const original = valkey[method].bind(valkey);
      const existingSessions = (await base.keys("not3:p2p:session:*")).sort();
      jest
        .spyOn(valkey as any, method)
        .mockImplementationOnce(async (...args: any[]) => {
          await original(...(args as Parameters<typeof original>));
          throw new Error("write acknowledgement lost");
        });
      const handle = { send: jest.fn(), kill: jest.fn() };
      await expect(
        sessions.relayCreate(ip, handle, "transfer"),
      ).rejects.toThrow("write acknowledgement lost");
      expect(sessions.sessionsForIp(ip)).toBe(0);
      expect(await base.zcard(`not3:p2p:ip:${ip}`)).toBe(0);
      expect((await base.keys("not3:p2p:session:*")).sort()).toEqual(
        existingSessions,
      );
    },
  );

  it.each(["p2pJoinSession", "p2pPublish"])(
    "rolls back an admitted member when %s reports failure",
    async (method) => {
      const owner = await open(
        0,
        method === "p2pJoinSession" ? "10.16.5.1" : "10.16.5.2",
      );
      send(owner, { type: "create", kind: "room" });
      const created = await frame(owner);
      const sessions = guest.app.get(P2PSessionService);
      const valkey = guest.app.get(ValkeyService);
      if (method === "p2pJoinSession") {
        const original = valkey.p2pJoinSession.bind(valkey);
        jest
          .spyOn(valkey as any, method)
          .mockImplementationOnce(async (...args: any[]) => {
            await original(...(args as Parameters<typeof original>));
            throw new Error("write acknowledgement lost");
          });
      } else {
        jest
          .spyOn(valkey, "p2pPublish")
          .mockRejectedValueOnce(new Error("publish failed"));
      }
      await expect(
        sessions.relayJoin(created.sessionId, {
          send: jest.fn(),
          kill: jest.fn(),
        }),
      ).rejects.toThrow();
      expect((await valkey.p2pGetSession(created.sessionId))?.peers).toEqual([
        created.peerId,
      ]);
    },
  );

  it("releases creator quota in the same write as transfer membership", async () => {
    const ip = "10.16.6.1";
    const sessions = host.app.get(P2PSessionService);
    const valkey = host.app.get(ValkeyService);
    const created = await sessions.relayCreate(
      ip,
      { send: jest.fn(), kill: jest.fn() },
      "transfer",
    );
    if (created === "too-many") throw new Error("creator rejected");
    jest
      .spyOn(valkey, "p2pReleaseIpSession")
      .mockRejectedValueOnce(new Error("separate quota write failed"));
    await sessions.relayLeave(created.session.id, created.peerId);
    expect(await valkey.p2pSessionExists(created.session.id)).toBe(false);
    expect(
      await base.zscore(`not3:p2p:ip:${ip}`, created.session.id),
    ).toBeNull();
  });
});

it.each(["create", "join"] as const)(
  "waits for pending %s admission before app shutdown",
  async (operation) => {
    const base = new RedisMock();
    const env = {
      P2P_ENABLED: "true",
      DATABASE_REQUEST_OPTIMIZATION: "hard",
      VALKEY_ENABLED: "false",
    };
    const overrides = { valkeyClientFactory: () => base.duplicate() };
    const ownerApp = await createTestApp(env, overrides);
    const workerApp = await createTestApp(env, overrides);
    let owner: WebSocket | undefined;
    let worker: WebSocket | undefined;
    let workerClosed = false;
    let gate: ReturnType<typeof gateFirstCall> | undefined;
    try {
      const ownerPort = await ownerApp.listen();
      const workerPort = await workerApp.listen();
      let sessionId: string | undefined;
      if (operation === "join") {
        owner = await connect(ownerPort, "10.17.1.1");
        send(owner, { type: "create", kind: "room" });
        sessionId = (await frame(owner)).sessionId;
      }
      const valkey = workerApp.app.get(ValkeyService);
      gate = gateFirstCall(
        valkey,
        operation === "create" ? "p2pRegisterSession" : "p2pJoinSession",
        "after",
      );
      worker = await connect(workerPort, "10.17.1.2");
      send(
        worker,
        operation === "create"
          ? { type: "create" }
          : { type: "join", sessionId },
      );
      await gate.entered;
      if (operation === "create") sessionId = gate.args[0];
      const close = workerApp.close().then(() => {
        workerClosed = true;
      });
      const premature = await Promise.race([
        close.then(() => "closed"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("pending"), 30),
        ),
      ]);
      expect(premature).toBe("pending");
      gate.release();
      await close;
      const current = await ownerApp.app
        .get(ValkeyService)
        .p2pGetSession(sessionId!);
      if (operation === "create") expect(current).toBeNull();
      else expect(current?.peers).toHaveLength(1);
    } finally {
      gate?.release();
      owner?.terminate();
      worker?.terminate();
      if (!workerClosed) await workerApp.close();
      await ownerApp.close();
      await base.quit();
      jest.restoreAllMocks();
    }
  },
);

it("closes active room sockets and removes Valkey membership before app shutdown", async () => {
  const base = new RedisMock();
  const env = {
    P2P_ENABLED: "true",
    DATABASE_REQUEST_OPTIMIZATION: "hard",
    VALKEY_ENABLED: "false",
  };
  const overrides = { valkeyClientFactory: () => base.duplicate() };
  const host = await createTestApp(env, overrides);
  const guest = await createTestApp(env, overrides);
  let creator: WebSocket | undefined;
  let member: WebSocket | undefined;
  let hostClosed = false;
  try {
    const hostPort = await host.listen();
    const guestPort = await guest.listen();
    creator = await connect(hostPort, "10.13.1.1");
    member = await connect(guestPort, "10.13.1.2");
    send(creator, { type: "create", kind: "room" });
    const created = await frame(creator);
    send(member, { type: "join", sessionId: created.sessionId });
    const joined = await frame(member);
    await frame(creator);

    const close = host.close().then(() => {
      hostClosed = true;
      return "closed";
    });
    const result = await Promise.race([
      close,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 300),
      ),
    ]);
    expect(result).toBe("closed");
    expect(await frame(member)).toEqual({
      type: "peer-left",
      peerId: created.peerId,
    });
    expect(
      (await guest.app.get(ValkeyService).p2pGetSession(created.sessionId))
        ?.peers,
    ).toEqual([joined.peerId]);
  } finally {
    creator?.terminate();
    member?.terminate();
    if (!hostClosed) await host.close();
    await guest.close();
    await base.quit();
  }
});

it("still closes active sockets when Valkey leave fails during shutdown", async () => {
  const base = new RedisMock();
  const app = await createTestApp(
    {
      P2P_ENABLED: "true",
      DATABASE_REQUEST_OPTIMIZATION: "hard",
      VALKEY_ENABLED: "false",
    },
    { valkeyClientFactory: () => base.duplicate() },
  );
  let peer: WebSocket | undefined;
  let closed = false;
  try {
    const port = await app.listen();
    peer = await connect(port, "10.15.1.1");
    send(peer, { type: "create", kind: "room" });
    expect((await frame(peer)).type).toBe("created");
    const socketClosed = new Promise<string>((resolve) =>
      peer!.once("close", () => resolve("closed")),
    );
    jest
      .spyOn(app.app.get(ValkeyService), "p2pLeaveSession")
      .mockRejectedValueOnce(new Error("Valkey unavailable"));
    const close = app.close().then(
      () => {
        closed = true;
        return "closed";
      },
      () => "rejected",
    );
    const outcome = await Promise.race([
      close,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 300),
      ),
    ]);
    expect(outcome).toBe("closed");
    expect(
      await Promise.race([
        socketClosed,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("timed-out"), 300),
        ),
      ]),
    ).toBe("closed");
  } finally {
    peer?.terminate();
    if (!closed) await app.close();
    await base.quit();
  }
});
