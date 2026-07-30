import request from "supertest";
import { createTestApp, TestApp } from "./app";

describe("request rate limiting", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ LIMITS_MAX_REQUESTS_PER_IP_PER_MINUTE: "3" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("returns 429 once the per-minute budget is used", async () => {
    const ip = "10.1.0.1";
    for (let i = 0; i < 3; i++)
      await request(t.server)
        .get("/info")
        .set("X-Forwarded-For", ip)
        .expect(200);
    await request(t.server).get("/info").set("X-Forwarded-For", ip).expect(429);
  });

  it("does not affect other ips", async () => {
    await request(t.server)
      .get("/info")
      .set("X-Forwarded-For", "10.1.0.2")
      .expect(200);
  });
});

describe("ban after failed requests", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ LIMITS_BAN_AFTER_FAILED_REQUESTS: "2" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("bans an ip after too many failed requests, then blocks with 418", async () => {
    const ip = "10.1.1.1";
    const fail = () =>
      request(t.server)
        .get("/note/does-not-exist/json")
        .set("X-Forwarded-For", ip);
    await fail().expect(404); // failed: 1
    await fail().expect(404); // failed: 2
    await fail().expect(429); // threshold reached -> banned + 429
    await fail().expect(418); // ban guard blocks before anything else
    // other ips unaffected
    await request(t.server)
      .get("/info")
      .set("X-Forwarded-For", "10.1.1.2")
      .expect(200);
  });
});

describe("limits disabled", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      LIMITS_DISABLED: "true",
      LIMITS_MAX_REQUESTS_PER_IP_PER_MINUTE: "1",
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it("never rate limits", async () => {
    const ip = "10.1.2.1";
    for (let i = 0; i < 5; i++)
      await request(t.server)
        .get("/info")
        .set("X-Forwarded-For", ip)
        .expect(200);
  });
});
