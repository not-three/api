import request from "supertest";
import CryptoJS from "crypto-js";
import { createTestApp, TestApp } from "./app";

const IP = "10.0.1.1";

describe("note decryption", () => {
  let t: TestApp;
  let id: string;

  beforeAll(async () => {
    t = await createTestApp();
    const res = await request(t.server)
      .post("/note/json")
      .set("X-Forwarded-For", IP)
      .send({
        content: CryptoJS.AES.encrypt("top secret", "pw123").toString(),
        mime: null,
        selfDestruct: false,
        expiresIn: 3600,
      });
    id = res.body.id;
  });
  afterAll(async () => {
    await t.close();
  });

  it("decrypts via query parameter", async () => {
    const res = await request(t.server)
      .get(`/note/${id}/decrypt`)
      .query({ key: "pw123" })
      .set("X-Forwarded-For", IP)
      .expect(200);
    expect(res.text).toBe("top secret");
  });

  it("decrypts via raw body", async () => {
    // The handler has no @HttpCode, so Nest returns its POST default of 201
    // even though swagger documents 200. 201 is the current actual behavior.
    const res = await request(t.server)
      .post(`/note/${id}/decrypt`)
      .set("X-Forwarded-For", IP)
      .type("text")
      .send("pw123")
      .expect(201);
    expect(res.text).toBe("top secret");
  });

  it("rejects a wrong key with 401", async () => {
    await request(t.server)
      .get(`/note/${id}/decrypt`)
      .query({ key: "wrong" })
      .set("X-Forwarded-For", IP)
      .expect(401);
  });

  it("rejects keys longer than 32 characters with 400", async () => {
    await request(t.server)
      .get(`/note/${id}/decrypt`)
      .query({ key: "x".repeat(33) })
      .set("X-Forwarded-For", IP)
      .expect(400);
  });

  it("404s for an unknown note id", async () => {
    await request(t.server)
      .get("/note/does-not-exist/decrypt")
      .query({ key: "pw123" })
      .set("X-Forwarded-For", IP)
      .expect(404);
  });
});
