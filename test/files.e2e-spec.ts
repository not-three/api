import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createTestApp, TestApp } from "./app";

const s3Mock = mockClient(S3Client);

const FILE_ENV = {
  FILE_TRANSFER_ENABLED: "true",
  FILE_TRANSFER_MAX_SIZE_MB: "10",
  FILE_TRANSFER_SIMULTANEOUS_FILES_PER_IP: "1",
  FILE_TRANSFER_GLOBAL_MAXIMUM_SIMULTANEOUS_FILES: "25",
};

// The behavior registered first for a command wins (sinon `withArgs`), so a
// later `on(SameCommand)` cannot override it — re-arm the whole mock instead.
const resetS3 = ({ completionFails = false } = {}) => {
  s3Mock.reset();
  s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upl-1" });
  if (completionFails)
    s3Mock.on(CompleteMultipartUploadCommand).rejects(new Error("bad etags"));
  else s3Mock.on(CompleteMultipartUploadCommand).resolves({});
  s3Mock.on(AbortMultipartUploadCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});
  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 123 });
};

describe("file transfer disabled", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("rejects all file routes with 403", async () => {
    await request(t.server)
      .get("/file")
      .set("X-Forwarded-For", "10.2.0.1")
      .expect(403);
    await request(t.server)
      .post("/file/upload")
      .set("X-Forwarded-For", "10.2.0.1")
      .send({ name: "a.txt" })
      .expect(403);
  });
});

describe("file transfer lifecycle", () => {
  let t: TestApp;

  beforeAll(async () => {
    resetS3();
    t = await createTestApp(FILE_ENV);
  });
  afterAll(async () => {
    await t.close();
  });

  const start = (ip: string, name = "test.txt") =>
    request(t.server)
      .post("/file/upload")
      .set("X-Forwarded-For", ip)
      .send({ name });

  it("uploads, closes, downloads, lists and deletes a file", async () => {
    const ip = "10.2.1.1";
    const { body } = await start(ip).expect(201);
    const id = body.id;

    // two 5MB parts fit into the 10MB limit
    for (let part = 1; part <= 2; part++) {
      const res = await request(t.server)
        .get(`/file/upload/${id}`)
        .query({ length: 1000 })
        .set("X-Forwarded-For", ip)
        .expect(200);
      expect(typeof res.body.url).toBe("string");
      expect(res.body.url).toContain("http");
    }

    await request(t.server)
      .put(`/file/upload/${id}`)
      .set("X-Forwarded-For", ip)
      .send({ etags: ["etag-1", "etag-2"] })
      .expect(204);

    const json = await request(t.server)
      .get(`/file/${id}`)
      .query({ json: "true" })
      .set("X-Forwarded-For", ip)
      .expect(200);
    expect(json.body.name).toBe("test.txt");
    expect(json.body.size).toBe(123);

    const redirect = await request(t.server)
      .get(`/file/${id}`)
      .set("X-Forwarded-For", ip)
      .expect(302);
    expect(redirect.headers.location).toContain("http");

    const list = await request(t.server)
      .get("/file")
      .set("X-Forwarded-For", ip)
      .expect(200);
    expect(list.body.files).toHaveLength(1);
    expect(list.body.files[0]).toMatchObject({ id, uploaded: true });

    await request(t.server)
      .delete(`/file/${id}`)
      .set("X-Forwarded-For", ip)
      .expect(204);
    expect(s3Mock.commandCalls(DeleteObjectCommand).length).toBeGreaterThan(0);
  });

  // A repeated query parameter arrives as an array, which used to blow up on
  // the .toLowerCase() call. It must fall back to the redirect instead.
  it("redirects when the json query parameter is repeated", async () => {
    const ip = "10.2.1.9";
    const { body } = await start(ip).expect(201);
    await request(t.server)
      .get(`/file/upload/${body.id}`)
      .query({ length: 1000 })
      .set("X-Forwarded-For", ip)
      .expect(200);
    await request(t.server)
      .put(`/file/upload/${body.id}`)
      .set("X-Forwarded-For", ip)
      .send({ etags: ["etag-1"] })
      .expect(204);

    const res = await request(t.server)
      .get(`/file/${body.id}?json=true&json=true`)
      .set("X-Forwarded-For", ip)
      .expect(302);
    expect(res.headers.location).toContain("http");
  });

  it("rejects invalid file names", async () => {
    await start("10.2.1.2", "bad name!.txt").expect(400);
  });

  it("enforces the per-ip simultaneous upload limit", async () => {
    const ip = "10.2.1.3";
    await start(ip).expect(201);
    await start(ip).expect(409);
  });

  it("validates the part length parameter", async () => {
    const ip = "10.2.1.4";
    const { body } = await start(ip).expect(201);
    await request(t.server)
      .get(`/file/upload/${body.id}`)
      .set("X-Forwarded-For", ip)
      .expect(400); // length missing
    await request(t.server)
      .get(`/file/upload/${body.id}`)
      .query({ length: 6 * 1024 * 1024 })
      .set("X-Forwarded-For", ip)
      .expect(400); // part above 5MB
  });

  it("rejects part requests from a foreign ip and unknown ids", async () => {
    const ip = "10.2.1.5";
    const { body } = await start(ip).expect(201);
    await request(t.server)
      .get(`/file/upload/${body.id}`)
      .query({ length: 1000 })
      .set("X-Forwarded-For", "10.2.1.99")
      .expect(401);
    await request(t.server)
      .get("/file/upload/does-not-exist")
      .query({ length: 1000 })
      .set("X-Forwarded-For", ip)
      .expect(404);
  });

  it("aborts the upload when the size limit would be exceeded", async () => {
    const ip = "10.2.1.6";
    const { body } = await start(ip).expect(201);
    const part = () =>
      request(t.server)
        .get(`/file/upload/${body.id}`)
        .query({ length: 1000 })
        .set("X-Forwarded-For", ip);
    await part().expect(200); // part 1 -> 5MB
    await part().expect(200); // part 2 -> 10MB
    await part().expect(413); // part 3 would exceed 10MB -> aborted
    expect(
      s3Mock.commandCalls(AbortMultipartUploadCommand).length,
    ).toBeGreaterThan(0);
    await part().expect(404); // the file record was deleted
  });

  it("returns 417 when S3 rejects the completion", async () => {
    const ip = "10.2.1.7";
    const { body } = await start(ip).expect(201);
    resetS3({ completionFails: true });
    await request(t.server)
      .put(`/file/upload/${body.id}`)
      .set("X-Forwarded-For", ip)
      .send({ etags: ["bad"] })
      .expect(417);
  });
});
