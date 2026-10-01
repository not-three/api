import request from "supertest";
import { createTestApp, TestApp } from "./app";

const IP = "10.0.2.1";

describe("system endpoints", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("redirects / to /swagger", async () => {
    const res = await request(t.server).get("/").expect(302);
    expect(res.headers.location).toBe("/swagger");
  });

  it("serves instance info", async () => {
    const res = await request(t.server)
      .get("/info")
      .set("X-Forwarded-For", IP)
      .expect(200);
    expect(res.body).toMatchObject({
      maxStorageTimeDays: 30,
      fileTransferEnabled: false,
      p2pEnabled: false,
      p2pRooms: false,
      p2pRoomMaxPeers: 8,
      privateMode: false,
    });
    expect(typeof res.body.version).toBe("string");
    expect(res.body.availableTokens).toBeGreaterThan(0);
  });

  it("exposes enabled P2P and room settings in info", async () => {
    const enabled = await createTestApp({
      P2P_ENABLED: "true",
      P2P_ROOM_MAX_PEERS: "3",
    });
    try {
      const res = await request(enabled.server)
        .get("/info")
        .set("X-Forwarded-For", "10.0.2.9")
        .expect(200);
      expect(res.body).toMatchObject({
        p2pEnabled: true,
        p2pRooms: true,
        p2pRoomMaxPeers: 3,
      });
    } finally {
      await enabled.close();
    }
  });

  it("documents P2P info fields in /swagger-json", async () => {
    const withSwagger = await createTestApp({}, { swagger: true });
    try {
      const response = await request(withSwagger.server)
        .get("/swagger-json")
        .expect(200);
      const fields = response.body.components?.schemas?.InfoResponse;
      expect(fields).toMatchObject({
        properties: {
          p2pEnabled: expect.any(Object),
          p2pRooms: expect.any(Object),
          p2pRoomMaxPeers: expect.any(Object),
        },
      });
    } finally {
      await withSwagger.close();
    }
  });

  it("serves stats reflecting created notes", async () => {
    await request(t.server)
      .post("/note/json")
      .set("X-Forwarded-For", IP)
      .send({ content: "x", mime: null, selfDestruct: false, expiresIn: 3600 })
      .expect(201);
    const res = await request(t.server)
      .get("/stats")
      .set("X-Forwarded-For", IP)
      .expect(200);
    expect(res.body.totalNotes).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.time).toBe("number");
    expect(typeof res.body.bannedIps).toBe("number");
  });
});

describe("stats password", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ STATS_PASSWORD: "statspw" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("rejects a missing or wrong password", async () => {
    await request(t.server)
      .get("/stats")
      .set("X-Forwarded-For", IP)
      .expect(403);
    await request(t.server)
      .get("/stats")
      .query({ password: "nope" })
      .set("X-Forwarded-For", IP)
      .expect(403);
  });

  it("accepts the correct password", async () => {
    await request(t.server)
      .get("/stats")
      .query({ password: "statspw" })
      .set("X-Forwarded-For", IP)
      .expect(200);
  });
});

describe("instance password", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ INSTANCE_PASSWORD: "s3cret" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("keeps /info public and reports private mode", async () => {
    const res = await request(t.server)
      .get("/info")
      .set("X-Forwarded-For", IP)
      .expect(200);
    expect(res.body.privateMode).toBe(true);
  });

  it("rejects protected endpoints without the password", async () => {
    await request(t.server)
      .post("/note/json")
      .set("X-Forwarded-For", IP)
      .send({ content: "x", mime: null, selfDestruct: false, expiresIn: 3600 })
      .expect(401);
  });

  it("accepts the password raw and as bearer token", async () => {
    for (const header of ["s3cret", "Bearer s3cret"]) {
      await request(t.server)
        .post("/note/json")
        .set("X-Forwarded-For", IP)
        .set("Authorization", header)
        .send({
          content: "x",
          mime: null,
          selfDestruct: false,
          expiresIn: 3600,
        })
        .expect(201);
    }
  });
});
