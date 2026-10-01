import { P2PSessionService, P2PPeerHandle } from "./p2p-session.service";

const handle = (): P2PPeerHandle => ({ send: jest.fn(), kill: jest.fn() });
const config = {
  get: () => ({
    idLength: 8,
    p2p: {
      sessionTtlMinutes: 30,
      maxSessionsPerIp: 2,
      roomMaxPeers: 3,
      roomGraceSeconds: 0.02,
    },
  }),
} as any;

describe("P2PSessionService", () => {
  let svc: P2PSessionService;
  beforeEach(() => {
    svc = new P2PSessionService(config);
  });
  afterEach(() => svc.onApplicationShutdown());

  it("allocates unique peer IDs and limits sessions per creator IP", () => {
    const first = svc.create("10.0.0.1", handle());
    expect(first).not.toBe("too-many");
    if (first === "too-many") return;
    expect(first.session.id).toMatch(/^.{8}$/);
    expect(first.peerId).toMatch(/^.{8,16}$/);
    expect((svc as any).sweepTimer.hasRef()).toBe(false);
    svc.create("10.0.0.1", handle());
    expect(svc.create("10.0.0.1", handle())).toBe("too-many");
    expect(svc.sessionsForIp("10.0.0.1")).toBe(2);
  });

  it("keeps transfer sender, caps receiver, and allows receiver rejoin", () => {
    const sender = handle(),
      receiver = handle();
    const created = svc.create("a", sender);
    if (created === "too-many") throw Error();
    const id = created.session.id;
    const joined = svc.join(id, receiver);
    expect(joined).toMatchObject({ peers: [] });
    expect(svc.join(id, handle())).toBe("session-full");
    expect(svc.join("missing", handle())).toBe("not-found");
    svc.leave(id, (joined as { peerId: string }).peerId);
    expect(sender.send).toHaveBeenCalledWith({
      type: "peer-left",
      peerId: (joined as { peerId: string }).peerId,
    });
    expect(svc.join(id, handle())).not.toBe("session-full");
  });

  it("routes room members and expires after empty grace", async () => {
    const a = handle(),
      b = handle(),
      c = handle();
    const created = svc.create("a", a, "room");
    if (created === "too-many") throw Error();
    const id = created.session.id;
    const bJoin = svc.join(id, b);
    if (typeof bJoin === "string") throw Error();
    expect(bJoin.peers).toEqual([created.peerId]);
    const cJoin = svc.join(id, c);
    if (typeof cJoin === "string") throw Error();
    expect(cJoin.peers).toEqual([created.peerId, bJoin.peerId]);
    expect(svc.join(id, handle())).toBe("session-full");
    svc.send(id, bJoin.peerId, cJoin.peerId, {
      type: "signal",
      from: bJoin.peerId,
      payload: { x: 1 },
    });
    expect(c.send).toHaveBeenCalledWith({
      type: "signal",
      from: bJoin.peerId,
      payload: { x: 1 },
    });
    expect(a.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "signal" }),
    );
    for (const peer of [created.peerId, bJoin.peerId, cJoin.peerId])
      svc.leave(id, peer);
    expect(svc.get(id)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(svc.get(id)).toBeNull();
  });

  it("keeps a room alive while another peer remains connected", async () => {
    const created = svc.create("a", handle(), "room");
    if (created === "too-many") throw Error();
    const joined = svc.join(created.session.id, handle());
    if (typeof joined === "string") throw Error();
    svc.leave(created.session.id, created.peerId);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(svc.get(created.session.id)).not.toBeNull();
    svc.leave(created.session.id, joined.peerId);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(svc.get(created.session.id)).toBeNull();
  });

  it("cancels room expiry on rejoin and reaps idle sessions", async () => {
    const first = svc.create("a", handle(), "room");
    if (first === "too-many") throw Error();
    svc.leave(first.session.id, first.peerId);
    expect(svc.join(first.session.id, handle())).not.toBe("not-found");
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(svc.get(first.session.id)).not.toBeNull();
    first.session.lastActivity = Date.now() - 31 * 60_000;
    expect(svc.sweepStale()).toBe(1);
    expect(svc.get(first.session.id)).toBeNull();
  });

  it("refreshes activity so an active session survives the idle sweep", () => {
    const created = svc.create("a", handle());
    if (created === "too-many") throw Error();
    created.session.lastActivity = Date.now() - 31 * 60_000;
    svc.touch(created.session.id);
    expect(svc.sweepStale()).toBe(0);
    expect(svc.get(created.session.id)).not.toBeNull();
  });

  it("notifies both transfer peers when a session is destroyed", () => {
    const sender = handle();
    const receiver = handle();
    const created = svc.create("a", sender);
    if (created === "too-many") throw Error();
    const joined = svc.join(created.session.id, receiver);
    if (typeof joined === "string") throw Error();
    svc.destroy(created.session.id);
    expect(sender.send).toHaveBeenCalledWith({
      type: "peer-left",
      peerId: joined.peerId,
    });
    expect(receiver.send).toHaveBeenCalledWith({
      type: "peer-left",
      peerId: created.peerId,
    });
    expect(sender.kill).toHaveBeenCalled();
    expect(receiver.kill).toHaveBeenCalled();
    expect(svc.get(created.session.id)).toBeNull();
  });

  it("continues cleanup when a peer callback throws", () => {
    const broken: P2PPeerHandle = {
      send: () => {
        throw new Error("socket closed");
      },
      kill: () => {
        throw new Error("socket closed");
      },
    };
    const created = svc.create("a", broken, "room");
    if (created === "too-many") throw Error();
    const joined = svc.join(created.session.id, handle());
    if (typeof joined === "string") throw Error();
    expect(() => svc.destroy(created.session.id)).not.toThrow();
    expect(svc.get(created.session.id)).toBeNull();
  });

  it("preserves the full room grace after the final peer leaves near idle TTL", async () => {
    const created = svc.create("a", handle(), "room");
    if (created === "too-many") throw Error();
    created.session.lastActivity = Date.now() - 31 * 60_000;
    svc.leave(created.session.id, created.peerId);
    expect(svc.sweepStale()).toBe(0);
    const joined = svc.join(created.session.id, handle());
    expect(joined).not.toBe("not-found");
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(svc.get(created.session.id)).not.toBeNull();
    if (typeof joined === "string") throw Error();
    svc.leave(created.session.id, joined.peerId);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(svc.get(created.session.id)).toBeNull();
  });

  it("destroys transfer when sender dies and frees receiver when it dies", () => {
    const a = handle(),
      b = handle();
    const first = svc.create("a", a);
    if (first === "too-many") throw Error();
    svc.join(first.session.id, b);
    svc.destroyAllFor(b);
    expect(svc.get(first.session.id)).not.toBeNull();
    svc.destroyAllFor(a);
    expect(svc.get(first.session.id)).toBeNull();
  });
});
