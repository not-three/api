import request from "supertest";
import { createTestApp, TestApp } from "./app";

const IP_A = "10.0.0.1";
const IP_B = "10.0.0.2";

describe("notes", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const createNote = (over: Record<string, any> = {}, ip = IP_A) =>
    request(t.server)
      .post("/note/json")
      .set("X-Forwarded-For", ip)
      .send({
        content: "hello world",
        mime: "text/plain",
        selfDestruct: false,
        expiresIn: 3600,
        ...over,
      });

  describe("POST /note/json", () => {
    it("creates a note and returns id, deleteToken and cost", async () => {
      const res = await createNote().expect(201);
      expect(res.body.id).toHaveLength(21);
      expect(res.body.deleteToken).toHaveLength(8);
      expect(res.body.cost).toBe(1000); // minTokensPerCreate floor
    });

    it("rejects a non-numeric expiresIn", async () => {
      await createNote({ expiresIn: "abc" }).expect(400);
    });

    it("rejects expiry under one minute", async () => {
      await createNote({ expiresIn: 30 }).expect(400);
    });

    it("rejects expiry above the storage limit", async () => {
      await createNote({ expiresIn: 31 * 86_400 }).expect(400);
    });
  });

  describe("POST /note/text", () => {
    it("creates a note from a raw text body", async () => {
      const res = await request(t.server)
        .post("/note/text")
        .set("X-Forwarded-For", IP_A)
        .type("text")
        .send("raw content")
        .expect(201);
      const id = res.text;
      const fetched = await request(t.server)
        .get(`/note/${id}/json`)
        .set("X-Forwarded-For", IP_A)
        .expect(200);
      expect(fetched.body.content).toBe("raw content");
      expect(fetched.body.mime).toBe("text/plain");
    });

    it("rejects content types longer than 16 characters", async () => {
      await request(t.server)
        .post("/note/text")
        .set("X-Forwarded-For", IP_A)
        .set("Content-Type", "text/plain; charset=utf-8")
        .send("raw content")
        .expect(400);
    });
  });

  describe("GET /note/:id", () => {
    it("returns the raw content", async () => {
      const { body } = await createNote({ content: "raw me" });
      const res = await request(t.server)
        .get(`/note/${body.id}/raw`)
        .set("X-Forwarded-For", IP_A)
        .expect(200);
      expect(res.text).toBe("raw me");
    });

    it("returns the json envelope with expiry", async () => {
      const { body } = await createNote();
      const res = await request(t.server)
        .get(`/note/${body.id}/json`)
        .set("X-Forwarded-For", IP_A)
        .expect(200);
      expect(res.body.deleted).toBe(false);
      expect(res.body.mime).toBe("text/plain");
      expect(res.body.expiresAt).toBeGreaterThan(Date.now() / 1000);
    });

    it("404s for an unknown id", async () => {
      await request(t.server)
        .get("/note/does-not-exist/json")
        .set("X-Forwarded-For", IP_A)
        .expect(404);
    });

    it("self-destruct notes are deleted on first read", async () => {
      const { body } = await createNote({ selfDestruct: true });
      const first = await request(t.server)
        .get(`/note/${body.id}/json`)
        .set("X-Forwarded-For", IP_A)
        .expect(200);
      expect(first.body.deleted).toBe(true);
      await request(t.server)
        .get(`/note/${body.id}/json`)
        .set("X-Forwarded-For", IP_A)
        .expect(404);
    });
  });

  describe("POST /note/text edge cases", () => {
    it("rejects a request without a body with 400", async () => {
      await request(t.server)
        .post("/note/text")
        .set("X-Forwarded-For", IP_A)
        .expect(400);
    });

    it("rejects an empty body with 400", async () => {
      await request(t.server)
        .post("/note/text")
        .set("X-Forwarded-For", IP_A)
        .type("text")
        .send("")
        .expect(400);
    });
  });

  describe("DELETE /note/:id", () => {
    it("allows deletion from the creator ip without a token", async () => {
      const { body } = await createNote();
      await request(t.server)
        .delete(`/note/${body.id}`)
        .set("X-Forwarded-For", IP_A)
        .send({})
        .expect(204);
    });

    it("allows deletion from the creator ip with no request body at all", async () => {
      const { body } = await createNote();
      await request(t.server)
        .delete(`/note/${body.id}`)
        .set("X-Forwarded-For", IP_A)
        .expect(204);
    });

    it("rejects deletion from another ip with no request body at all", async () => {
      const { body } = await createNote();
      await request(t.server)
        .delete(`/note/${body.id}`)
        .set("X-Forwarded-For", IP_B)
        .expect(401);
    });

    it("allows deletion from another ip with the delete token", async () => {
      const { body } = await createNote();
      await request(t.server)
        .delete(`/note/${body.id}`)
        .set("X-Forwarded-For", IP_B)
        .send({ token: body.deleteToken })
        .expect(204);
    });

    it("rejects deletion from another ip with a wrong token", async () => {
      const { body } = await createNote();
      await request(t.server)
        .delete(`/note/${body.id}`)
        .set("X-Forwarded-For", IP_B)
        .send({ token: "wrong-tok" })
        .expect(401);
    });

    it("404s for an unknown id", async () => {
      await request(t.server)
        .delete("/note/does-not-exist")
        .set("X-Forwarded-For", IP_A)
        .send({})
        .expect(404);
    });
  });
});

describe("notes token limits", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ LIMITS_MAX_TOKENS_PER_IP: "2500" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("rejects creation once the ip token budget is exhausted", async () => {
    const create = () =>
      request(t.server)
        .post("/note/json")
        .set("X-Forwarded-For", "10.0.9.9")
        .send({
          content: "x",
          mime: null,
          selfDestruct: false,
          expiresIn: 3600,
        });
    await create().expect(201); // used: 1000
    await create().expect(201); // used: 2000
    await create().expect(413); // 2000 + 1000 >= 2500

    // other ips are unaffected
    await request(t.server)
      .post("/note/json")
      .set("X-Forwarded-For", "10.0.9.10")
      .send({ content: "x", mime: null, selfDestruct: false, expiresIn: 3600 })
      .expect(201);
  });

  it("reports the remaining budget on /info", async () => {
    const res = await request(t.server)
      .get("/info")
      .set("X-Forwarded-For", "10.0.9.9")
      .expect(200);
    expect(res.body.availableTokens).toBe(500);
  });
});
