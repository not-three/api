import WebSocket from "ws";
import { createTestApp, TestApp } from "./app";
import { DatabaseService } from "src/services/database.service";
import { ValkeyService } from "src/services/valkey.service";
import { P2PSessionService } from "src/services/p2p-session.service";
import { P2PGatewayService } from "src/services/p2p-gateway.service";
import request from "supertest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RedisMock = require("ioredis-mock");

/**
 * API P2P conformance checklist (OMO job 2 and its archived API plan).
 * Each entry names the proving Jest test; paths are relative to this repo.
 *
 * Config and public metadata
 * [x] Disabled default, default STUN only, room defaults, TTL and limits:
 *     src/config/P2P.spec.ts "defaults to disabled transfer and rooms with STUN only".
 * [x] P2P_* env overrides, external TURN credentials, independently disabled rooms:
 *     src/config/P2P.spec.ts "uses env overrides for ICE and room policy" and
 *     "can disable rooms independently". Config fields carry @default/@env;
 *     `pnpm build` generates TypeDoc without warnings.
 * [x] /info defaults and enabled room fields, plus OpenAPI schema:
 *     test/system.e2e-spec.ts "serves instance info", "exposes enabled P2P
 *     and room settings in info", "documents P2P info fields in /swagger-json".
 * [x] No bundled TURN service: P2PConfig default ICE test offers STUN only;
 *     configured external TURN appears only as client ICE configuration.
 *
 * Reliability and wire protocol
 * [x] /p2p only, JSON text only, invalid forwarded IP returns 511, disabled
 *     upgrade stays unavailable: "rejects invalid forwarded IPs and upgrades
 *     outside /p2p", "rejects non-JSON and binary signaling frames", "does
 *     not accept WebSocket upgrades while P2P is disabled".
 * [x] Transfer create/join replies (sessionId, kind, unique 8-16 character
 *     peerIds, STUN ICE), one receiver, opaque bidirectional signals with
 *     `from` and ignored transfer `to`, leave/rejoin and peer notifications:
 *     "creates transfer, joins, relays opaque signals, and permits receiver
 *     rejoin", "caps transfer and rejects unknown sessions".
 * [x] Room create/join, other-member `peers`, three members, configured cap,
 *     addressed-only signals, `from`, missing/invalid `to`, and leave:
 *     "routes room signals only to the addressed peer and expires empty rooms",
 *     "rejects room signals without a valid destination".
 * [x] All gateway error codes: disabled ("rejects room creation when only
 *     transfer signaling is enabled"), not-found/session-full ("caps transfer
 *     and rejects unknown sessions"), rate-limited ("closes a socket after
 *     its sixth message in one minute"), invalid-message ("rejects oversized
 *     and malformed frames").
 * [x] Non-JSON, binary, unknown type, premature signal, duplicate create/join,
 *     own-session join, oversized frame, malformed unmasked wire frame, and
 *     parser memory bound: "rejects non-JSON and binary signaling frames",
 *     "rejects a signal before joining and a creator joining its own session",
 *     "rejects oversized and malformed frames", "rejects a second create
 *     queued before the first Valkey write completes", "rejects a second join
 *     queued before the first Valkey write completes", "closes a peer after an
 *     unmasked wire frame and continues serving", "limits parser buffering
 *     near the configured frame size".
 * [x] Parser cap is 2x configured size (minimum 1 KiB): moderately oversized
 *     frames still get the application invalid-message reply; larger frames
 *     close at the bounded transport parser with 1009. "applies the configured
 *     message cap before the bounded parser cap" tests 1024/1500/3000 bytes.
 * [x] 30-second unref'd ping/pong heartbeat and terminate+cleanup on missed pong:
 *     "terminates a peer that misses heartbeat pongs and keeps responsive peers".
 * [x] The archived plan's manual create/join/signal/leave smoke is exercised
 *     against a bound HTTP server with real WS clients by "creates transfer,
 *     joins, relays opaque signals, and permits receiver rejoin".
 *
 * Abuse controls
 * [x] Banned IP -> 418, invalid IP -> 511, upgrade accounting -> 429:
 *     "rejects banned IPs during upgrade", "rejects invalid forwarded IPs
 *     and upgrades outside /p2p", "counts WebSocket upgrades against the HTTP
 *     request budget".
 * [x] Per-socket rolling message rate, failed joins feeding shared HTTP ban,
 *     and LIMITS_DISABLED bypass: "closes a socket after its sixth message in
 *     one minute", "counts messages over a rolling minute across a window
 *     boundary", "bans failed joins through the shared HTTP ban store",
 *     "bypasses P2P abuse limits when limits are disabled".
 *
 * Capacity caps
 * [x] Local transfer/room peer caps and per-IP creator cap:
 *     src/services/p2p-session.service.spec.ts "keeps transfer sender, caps
 *     receiver, and allows receiver rejoin", "routes room members and expires
 *     after empty grace", "allocates unique peer IDs and limits sessions per
 *     creator IP" (also checks unref'd sweep); "applies the creator IP session
 *     cap across replicas".
 *
 * Grace and TTL
 * [x] Local room grace, cancel on rejoin, eventual expiry, idle TTL and touch:
 *     src/services/p2p-session.service.spec.ts "routes room members and expires
 *     after empty grace", "cancels room expiry on rejoin and reaps idle
 *     sessions", "refreshes activity so an active session survives the idle
 *     sweep", "preserves the full room grace after the final peer leaves near
 *     idle TTL", "keeps a room alive while another peer remains connected";
 *     "routes room signals only to the addressed peer and expires empty rooms".
 * [x] Valkey room grace, concurrent leave/join slot safety, duplicate peer ID,
 *     touch and expiry: src/services/valkey.service.spec.ts "shares P2P room
 *     membership and enforces capacity", "admits only one of two concurrent
 *     peers into the last room slot", "rejects a duplicate peer ID within a
 *     session", "starts room grace when the final peers leave concurrently",
 *     "does not extend an empty room beyond its grace through a late touch".
 *
 * Split-replica routing
 * [x] Split-replica transfer and addressed three-replica room signaling,
 *     pub/sub, creator IP quota, join-only expiry cleanup and grace rejoin:
 *     "relays transfer signaling between two replicas", "routes room signals
 *     by peer ID across three replicas", "applies the creator IP session cap
 *     across replicas", "allows a room to rejoin during grace and frees its
 *     IP quota after expiry", "reaps an expired room peer on a join-only
 *     replica"; src/services/valkey.service.spec.ts "publishes targeted P2P
 *     frames to another subscriber". test/app.ts injects a Valkey client per
 *     app, so concurrent replicas do not share process-global test hooks.
 *
 * Disconnect cleanup
 * [x] Creator death, receiver slot release, destroy notifications and local
 *     quota cleanup: "removes a transfer when its creator disconnects";
 *     src/services/p2p-session.service.spec.ts "destroys transfer when sender
 *     dies and frees receiver when it dies", "notifies both transfer peers
 *     when a session is destroyed", "continues cleanup when a peer callback
 *     throws"; "releases the local creator slot when a leave notification
 *     fails".
 * [x] Close during Valkey reserve/register/lookup/join/touch, post-write
 *     rollback, atomic quota release, pending create/join shutdown:
 *     "P2P disconnect during Valkey admission" parameterized tests,
 *     "releases creator quota in the same write as transfer membership",
 *     "waits for pending create admission before app shutdown", "waits for
 *     pending join admission before app shutdown".
 *
 * Shutdown
 * [x] App shutdown removes Valkey membership, closes sockets even on leave
 *     failure, and unsubscribes pub/sub: "closes active room sockets and
 *     removes Valkey membership before app shutdown", "still closes active
 *     sockets when Valkey leave fails during shutdown";
 *     src/services/valkey.service.spec.ts "removes its P2P subscription on
 *     shutdown".
 *
 * SDK data-channel encryption/chunks, CLI/UI file flows, and npm release are
 * separate jobs in the parent spec; this API only exchanges signaling frames.
 */

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
async function connect(
  port: number,
  ip: string,
  autoPong = true,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/p2p`, {
    headers: { "X-Forwarded-For": ip },
    autoPong,
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
    expect(joined.peerId).toMatch(/^.{8,16}$/);
    expect(joined.peerId).not.toBe(created.peerId);
    expect(await frame(a)).toMatchObject({
      type: "peer-joined",
      peerId: joined.peerId,
    });
    const payload = { nested: [1, { sdp: "opaque" }] };
    send(a, { type: "signal", to: "ignored-in-transfer", payload });
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
    expect(bj.peerId).not.toBe(created.peerId);
    send(c, { type: "join", sessionId: created.sessionId });
    const cj = await frame(c);
    await frame(a);
    await frame(b);
    expect(cj.peers).toEqual([created.peerId, bj.peerId]);
    expect(cj.peerId).not.toBe(bj.peerId);
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

  it("rejects non-JSON and binary signaling frames", async () => {
    const invalidJson = await open("10.9.7.3");
    invalidJson.send("{");
    expect(await frame(invalidJson)).toEqual({
      type: "error",
      code: "invalid-message",
    });
    const binary = await open("10.9.7.4");
    binary.send(Buffer.from("{}"));
    expect(await frame(binary)).toEqual({
      type: "error",
      code: "invalid-message",
    });
  });

  it("rejects a signal before joining and a creator joining its own session", async () => {
    const unjoined = await open("10.9.7.5");
    send(unjoined, { type: "signal", payload: { offer: true } });
    expect(await frame(unjoined)).toEqual({
      type: "error",
      code: "invalid-message",
    });
    const creator = await open("10.9.7.6");
    send(creator, { type: "create" });
    const created = await frame(creator);
    send(creator, { type: "join", sessionId: created.sessionId });
    expect(await frame(creator)).toEqual({
      type: "error",
      code: "invalid-message",
    });
    await waitUntil(
      () => t.app.get(P2PSessionService).sessionsForIp("10.9.7.6") === 0,
    );
    const later = await open("10.9.7.9");
    send(later, { type: "join", sessionId: created.sessionId });
    expect(await frame(later)).toEqual({ type: "error", code: "not-found" });
  });

  it("closes a peer after an unmasked wire frame and continues serving", async () => {
    const ip = "10.9.7.1";
    const peer = await open(ip);
    send(peer, { type: "create" });
    expect((await frame(peer)).type).toBe("created");
    const closed = new Promise<void>((resolve) =>
      peer.once("close", () => resolve()),
    );
    peer.on("error", () => undefined);
    (peer as any)._socket.write(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
    await closed;
    await waitUntil(() => t.app.get(P2PSessionService).sessionsForIp(ip) === 0);
    const next = await open(ip);
    send(next, { type: "create" });
    expect((await frame(next)).type).toBe("created");
  });

  it("limits parser buffering near the configured frame size", async () => {
    const peer = await open("10.9.7.2");
    const closed = new Promise<number>((resolve) =>
      peer.once("close", (code) => resolve(code)),
    );
    peer.send("x".repeat(200_000));
    expect(await closed).toBe(1009);
  });

  it("applies the configured message cap before the bounded parser cap", async () => {
    const app = await createTestApp({
      P2P_ENABLED: "true",
      P2P_MAX_MESSAGE_BYTES: "1024",
    });
    let moderate: WebSocket | undefined;
    let huge: WebSocket | undefined;
    try {
      const appPort = await app.listen();
      moderate = await connect(appPort, "10.9.7.7");
      moderate.send("x".repeat(1500));
      expect(await frame(moderate)).toEqual({
        type: "error",
        code: "invalid-message",
      });
      huge = await connect(appPort, "10.9.7.8");
      const closed = new Promise<number>((resolve) =>
        huge!.once("close", (code) => resolve(code)),
      );
      huge.send("x".repeat(3000));
      expect(await closed).toBe(1009);
    } finally {
      moderate?.terminate();
      huge?.terminate();
      await app.close();
    }
  });

  it("rejects banned IPs during upgrade", async () => {
    await t.app.get(DatabaseService).ban("10.9.9.9");
    await expect(connect(port, "10.9.9.9")).rejects.toThrow("418");
  });

  it("rejects invalid forwarded IPs and upgrades outside /p2p", async () => {
    await expect(connect(port, "invalid-ip")).rejects.toThrow("511");
    const wrongPath = new WebSocket(`ws://127.0.0.1:${port}/else`);
    await expect(
      new Promise<void>((resolve, reject) => {
        wrongPath.once("open", resolve);
        wrongPath.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("closes malformed upgrade targets without rejecting the handler", async () => {
    const socket = { destroy: jest.fn() };
    const gateway = t.app.get(P2PGatewayService);
    await expect(
      (gateway as any).upgrade({ url: "http://[" }, socket, Buffer.alloc(0)),
    ).resolves.toBeUndefined();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});

it("terminates a peer that misses heartbeat pongs and keeps responsive peers", async () => {
  const nativeSetInterval = global.setInterval.bind(global);
  jest
    .spyOn(global, "setInterval")
    .mockImplementation(((handler: any, timeout?: number, ...args: any[]) =>
      nativeSetInterval(
        handler,
        timeout === 30_000 ? 100 : timeout,
        ...args,
      )) as typeof setInterval);
  let app!: TestApp;
  try {
    app = await createTestApp({ P2P_ENABLED: "true" });
  } finally {
    jest.restoreAllMocks();
  }
  let silent: WebSocket | undefined;
  let responsive: WebSocket | undefined;
  try {
    const port = await app.listen();
    expect(
      (
        (app.app.get(P2PGatewayService) as any).heartbeat as NodeJS.Timeout
      ).hasRef(),
    ).toBe(false);
    silent = await connect(port, "10.9.6.1", false);
    responsive = await connect(port, "10.9.6.2");
    send(silent, { type: "create" });
    expect((await frame(silent)).type).toBe("created");
    const closed = new Promise<void>((resolve) =>
      silent!.once("close", () => resolve()),
    );
    expect(
      await Promise.race([
        closed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 1000)),
      ]),
    ).toBe("closed");
    expect(responsive.readyState).toBe(WebSocket.OPEN);
    await waitUntil(
      () => app.app.get(P2PSessionService).sessionsForIp("10.9.6.1") === 0,
    );
  } finally {
    silent?.terminate();
    responsive?.terminate();
    await app.close();
  }
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
    await waitUntil(
      () => !(joinerApp.app.get(P2PSessionService) as any).sweepTimer,
    );
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

  it("releases the local creator slot when a leave notification fails", async () => {
    const ip = "10.16.7.1";
    const creatorSessions = host.app.get(P2PSessionService);
    const joinedSessions = guest.app.get(P2PSessionService);
    const created = await creatorSessions.relayCreate(
      ip,
      { send: jest.fn(), kill: jest.fn() },
      "room",
    );
    if (created === "too-many") throw new Error("creator rejected");
    await joinedSessions.relayJoin(created.session.id, {
      send: jest.fn(),
      kill: jest.fn(),
    });
    jest
      .spyOn(host.app.get(ValkeyService), "p2pPublish")
      .mockRejectedValueOnce(new Error("publish failed"));
    await expect(
      creatorSessions.relayLeave(created.session.id, created.peerId),
    ).rejects.toThrow("publish failed");
    expect(creatorSessions.sessionsForIp(ip)).toBe(0);
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
