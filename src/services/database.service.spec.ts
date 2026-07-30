import { DatabaseService } from "./database.service";
import { MigrationService } from "./migration.service";
import { ConfigService } from "./config.service";

export const makeCacheStub = () => {
  const map = new Map<string, any>();
  return {
    map,
    setCalls: [] as { key: string; ttl: number }[],
    async get(key: string) {
      return this.map.get(key);
    },
    async set(key: string, value: any, ttl: number) {
      this.map.set(key, value);
      this.setCalls.push({ key, ttl });
    },
    async del(key: string) {
      this.map.delete(key);
    },
  };
};

export const setupDb = async (
  mode: "none" | "light" | "hard",
  valkey: any = null,
) => {
  process.env.DATABASE_MODE = "sqlite3";
  process.env.DATABASE_FILE = ":memory:";
  process.env.DATABASE_REQUEST_OPTIMIZATION = mode;
  const config = new ConfigService();
  const cache = makeCacheStub();
  const db = new DatabaseService(cache as any, config, valkey);
  await db.onModuleInit();
  await new MigrationService(db, config).onApplicationBootstrap();
  db.onApplicationBootstrap();
  return { db, cache, config };
};

const cleanupEnv = () => {
  delete process.env.DATABASE_MODE;
  delete process.env.DATABASE_FILE;
  delete process.env.DATABASE_REQUEST_OPTIMIZATION;
};

describe("DatabaseService optimization profiles", () => {
  afterEach(cleanupEnv);

  it("caches note reads for 30s in none mode", async () => {
    const { db, cache } = await setupDb("none");
    const id = await db.createNote({
      content: "hello",
      ip: "1.2.3.4",
      expires_at: Date.now() + 60_000,
      self_destruct: false,
      delete_token: null,
      mime: null,
    });
    await db.getNote(id);
    const call = cache.setCalls.find((c) => c.key === `note-${id}`);
    expect(call.ttl).toBe(30_000);
    await db.onModuleDestroy();
  });

  it("caches note reads for 5min in light mode", async () => {
    const { db, cache } = await setupDb("light");
    const id = await db.createNote({
      content: "hello",
      ip: "1.2.3.4",
      expires_at: Date.now() + 60_000,
      self_destruct: false,
      delete_token: null,
      mime: null,
    });
    await db.getNote(id);
    const call = cache.setCalls.find((c) => c.key === `note-${id}`);
    expect(call.ttl).toBe(300_000);
    await db.onModuleDestroy();
  });

  it("caches stats for 5min in light mode", async () => {
    const { db, cache } = await setupDb("light");
    await db.getStats();
    const call = cache.setCalls.find((c) => c.key === "stats");
    expect(call.ttl).toBe(300_000);
    await db.onModuleDestroy();
  });

  it("runs cleanup every tick in none mode", async () => {
    const { db } = await setupDb("none");
    const knex = db.getKnex();
    await knex("notes").insert({
      id: "expired1",
      content: "x",
      ip: "1.2.3.4",
      created_at: 0,
      expires_at: 1,
      self_destruct: false,
    });
    await db.cleanUp();
    await knex("notes").insert({
      id: "expired2",
      content: "x",
      ip: "1.2.3.4",
      created_at: 0,
      expires_at: 1,
      self_destruct: false,
    });
    await db.cleanUp();
    expect(await knex("notes").select()).toHaveLength(0);
    await db.onModuleDestroy();
  });

  it("skips cleanup within the interval in light mode", async () => {
    const { db } = await setupDb("light");
    const knex = db.getKnex();
    await db.cleanUp(); // first run always executes, sets lastCleanup
    await knex("notes").insert({
      id: "expired1",
      content: "x",
      ip: "1.2.3.4",
      created_at: 0,
      expires_at: 1,
      self_destruct: false,
    });
    await db.cleanUp(); // within 15min window -> must skip
    expect(await knex("notes").select()).toHaveLength(1);
    await db.onModuleDestroy();
  });
});
