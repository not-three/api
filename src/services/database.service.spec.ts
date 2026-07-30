import { DatabaseService } from "./database.service";
import { MigrationService } from "./migration.service";
import { ConfigService } from "./config.service";
import { ValkeyService } from "./valkey.service";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RedisMock = require("ioredis-mock");

class TestValkeyService extends ValkeyService {
  protected createClient() {
    return new RedisMock();
  }
}

// Everything created through makeValkey/setupDb is registered here and torn
// down in afterEach. Cleaning up at the end of a test body instead would be
// skipped on a failing assertion, leaving the valkey client and the knex pool
// open — jest would then never exit.
const opened: { destroy: () => void | Promise<any> }[] = [];

const closeOpened = async () => {
  // Reverse order: the database service depends on valkey, so it has to shut
  // down (and flush) before the valkey client goes away.
  for (const resource of opened.splice(0).reverse()) {
    try {
      await resource.destroy();
    } catch {
      // teardown is best effort
    }
  }
};

const makeValkey = async () => {
  process.env.VALKEY_ENABLED = "true";
  const valkey = new TestValkeyService(new ConfigService());
  await valkey.onModuleInit();
  opened.push({ destroy: () => valkey.onApplicationShutdown() });
  return valkey;
};

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
  opened.push({ destroy: () => db.onModuleDestroy() });
  await new MigrationService(db, config).onApplicationBootstrap();
  db.onApplicationBootstrap();
  return { db, cache, config };
};

const cleanupEnv = async () => {
  await closeOpened();
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
  });

  it("caches stats for 5min in light mode", async () => {
    const { db, cache } = await setupDb("light");
    await db.getStats();
    const call = cache.setCalls.find((c) => c.key === "stats");
    expect(call.ttl).toBe(300_000);
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
  });
});

describe("DatabaseService hard mode rate limiting", () => {
  afterEach(async () => {
    await cleanupEnv();
    delete process.env.VALKEY_ENABLED;
  });

  it("tracks requests in valkey, not the database", async () => {
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    await db.createRequest("1.2.3.4", false);
    await db.createRequest("1.2.3.4", true);
    expect(await db.getRequests("1.2.3.4")).toEqual({ total: 2, failed: 1 });
    expect(await db.getKnex()("requests").select()).toHaveLength(0);
  });

  it("tracks tokens in valkey, not the database", async () => {
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    await db.createToken("1.2.3.4", 1000);
    await db.createToken("1.2.3.4", 234);
    expect(await db.getTokens("1.2.3.4")).toBe(1234);
    expect(await db.getKnex()("tokens").select()).toHaveLength(0);
  });

  it("tracks bans in valkey, not the database", async () => {
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    expect(await db.isBanned("1.2.3.4")).toBe(false);
    await db.ban("1.2.3.4");
    expect(await db.isBanned("1.2.3.4")).toBe(true);
    expect(await db.getKnex()("bans").select()).toHaveLength(0);
  });

  it("keeps rate limiting in the database in light mode", async () => {
    const { db } = await setupDb("light");
    await db.createRequest("1.2.3.4", false);
    expect(await db.getKnex()("requests").select()).toHaveLength(1);
  });
});

describe("DatabaseService hard mode note buffering", () => {
  afterEach(async () => {
    await cleanupEnv();
    delete process.env.VALKEY_ENABLED;
    delete process.env.VALKEY_FLUSH_MAX_QUEUE_SIZE;
  });

  const insertable = () => ({
    content: "hello world",
    ip: "1.2.3.4",
    expires_at: Date.now() + 3_600_000,
    self_destruct: false,
    delete_token: null,
    mime: null,
  });

  it("buffers creates and serves reads from the buffer", async () => {
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    const id = await db.createNote(insertable());
    expect(await db.getKnex()("notes").select()).toHaveLength(0);
    const note = await db.getNote(id);
    expect(note.content).toBe("hello world");
    expect(note.id).toBe(id);
  });

  it("flushNow writes buffered notes to the database", async () => {
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    const id = await db.createNote(insertable());
    await db.flushNow();
    const rows = await db.getKnex()("notes").select();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(await valkey.getPendingCount()).toBe(0);
  });

  it("delete before flush removes the note without touching the db", async () => {
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    const id = await db.createNote(insertable());
    await db.deleteNote(id);
    expect(await db.getNote(id)).toBeNull();
    await db.flushNow();
    expect(await db.getKnex()("notes").select()).toHaveLength(0);
  });

  it("delete after flush is queued and applied on next flush", async () => {
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    const id = await db.createNote(insertable());
    await db.flushNow();
    await db.deleteNote(id);
    expect(await db.getNote(id)).toBeNull(); // pending delete hides it
    await db.flushNow();
    expect(await db.getKnex()("notes").select()).toHaveLength(0);
  });

  it("flushNow skips notes that already expired in the buffer", async () => {
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    await db.createNote({ ...insertable(), expires_at: Date.now() - 1000 });
    await db.flushNow();
    expect(await db.getKnex()("notes").select()).toHaveLength(0);
  });

  it("cron flushes early when the queue size trigger is reached", async () => {
    process.env.VALKEY_FLUSH_MAX_QUEUE_SIZE = "2";
    const valkey = await makeValkey();
    const { db } = await setupDb("hard", valkey);
    await db.createNote(insertable());
    await db.flushPendingWrites(); // 1 < 2 and interval not elapsed -> no flush
    expect(await db.getKnex()("notes").select()).toHaveLength(0);
    await db.createNote(insertable());
    await db.flushPendingWrites(); // 2 >= 2 -> flush
    expect(await db.getKnex()("notes").select()).toHaveLength(2);
  });
});
