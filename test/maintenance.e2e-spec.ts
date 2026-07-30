import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createTestApp, TestApp } from "./app";
import { DatabaseService } from "src/services/database.service";
import { S3Service } from "src/services/s3.service";
import { MigrationService } from "src/services/migration.service";

const s3Mock = mockClient(S3Client);

describe("database cleanup cron", () => {
  let t: TestApp;
  let db: DatabaseService;

  beforeAll(async () => {
    t = await createTestApp();
    db = t.app.get(DatabaseService);
  });
  afterAll(async () => {
    await t.close();
  });

  it("removes expired rows and keeps valid ones", async () => {
    const knex = db.getKnex();
    const now = Date.now();
    await knex("notes").insert([
      {
        id: "expired",
        content: "x",
        ip: "10.3.0.1",
        created_at: now - 10_000,
        expires_at: now - 1000,
        self_destruct: false,
      },
      {
        id: "valid",
        content: "x",
        ip: "10.3.0.1",
        created_at: now,
        expires_at: now + 60_000,
        self_destruct: false,
      },
    ]);
    await knex("tokens").insert([
      {
        id: "tok-old",
        ip: "10.3.0.1",
        used: 100,
        created_at: now - 61 * 60_000,
      },
      { id: "tok-new", ip: "10.3.0.1", used: 100, created_at: now },
    ]);
    await knex("requests").insert([
      {
        id: "req-old",
        ip: "10.3.0.1",
        failed: false,
        created_at: now - 120_000,
      },
      {
        id: "req-failed-old",
        ip: "10.3.0.1",
        failed: true,
        created_at: now - 6 * 60_000,
      },
      { id: "req-new", ip: "10.3.0.1", failed: false, created_at: now },
    ]);
    await knex("bans").insert([
      { ip: "10.3.0.2", created_at: now - 61 * 60_000 },
      { ip: "10.3.0.3", created_at: now },
    ]);

    await db.cleanUp();

    expect((await knex("notes").select()).map((r: any) => r.id)).toEqual([
      "valid",
    ]);
    expect((await knex("tokens").select()).map((r: any) => r.id)).toEqual([
      "tok-new",
    ]);
    expect((await knex("requests").select()).map((r: any) => r.id)).toEqual([
      "req-new",
    ]);
    expect((await knex("bans").select()).map((r: any) => r.ip)).toEqual([
      "10.3.0.3",
    ]);
  });
});

describe("s3 cleanup cron", () => {
  let t: TestApp;

  beforeAll(async () => {
    s3Mock.reset();
    s3Mock.on(AbortMultipartUploadCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    t = await createTestApp({ FILE_TRANSFER_ENABLED: "true" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("aborts stale uploads and deletes expired files", async () => {
    const db = t.app.get(DatabaseService);
    const s3 = t.app.get(S3Service);
    const knex = db.getKnex();
    const now = Date.now();
    await knex("files").insert([
      // stale upload: last part too long ago -> abort + delete row
      {
        id: "stale",
        name: "a.txt",
        ip: "10.3.1.1",
        part: 1,
        upload_id: "u1",
        created_at: now,
        updated_at: now - 11 * 60_000,
        expires_at: now + 60_000,
      },
      // expired finished file -> delete object + row
      {
        id: "gone",
        name: "b.txt",
        ip: "10.3.1.1",
        part: 1,
        upload_id: null,
        created_at: now,
        updated_at: now,
        expires_at: now - 1000,
      },
      // healthy file -> untouched
      {
        id: "ok",
        name: "c.txt",
        ip: "10.3.1.1",
        part: 1,
        upload_id: null,
        created_at: now,
        updated_at: now,
        expires_at: now + 60_000,
      },
    ]);

    await s3.cleanUp();

    expect((await knex("files").select()).map((r: any) => r.id)).toEqual([
      "ok",
    ]);
    expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });
});

describe("migrations", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ ALLOW_REVERTING_MIGRATIONS: "true" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("created all tables on bootstrap", async () => {
    const knex = t.app.get(DatabaseService).getKnex();
    for (const table of [
      "notes",
      "tokens",
      "requests",
      "bans",
      "files",
      "migrations",
    ])
      expect(await knex.schema.hasTable(table)).toBe(true);
  });

  it("is idempotent when already at the latest level", async () => {
    const migrations = t.app.get(MigrationService);
    await expect(migrations.onApplicationBootstrap()).resolves.not.toThrow();
  });

  it("reverts migrations newer than the application", async () => {
    const db = t.app.get(DatabaseService);
    const knex = db.getKnex();
    await knex("migrations").insert({
      id: 3,
      revert: "CREATE TABLE dummy_revert (id integer)",
    });
    await t.app.get(MigrationService).onApplicationBootstrap();
    expect(await knex.schema.hasTable("dummy_revert")).toBe(true);
    expect(await knex("migrations").where("id", 3).first()).toBeUndefined();
  });
});
