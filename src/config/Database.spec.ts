import { DatabaseConfig } from "./Database";

describe("DatabaseConfig.requestOptimization", () => {
  afterEach(() => delete process.env.DATABASE_REQUEST_OPTIMIZATION);

  it("defaults to none", () => {
    expect(new DatabaseConfig().requestOptimization).toBe("none");
  });

  it("accepts light and hard", () => {
    process.env.DATABASE_REQUEST_OPTIMIZATION = "hard";
    expect(new DatabaseConfig().requestOptimization).toBe("hard");
  });

  it("rejects unknown values", () => {
    process.env.DATABASE_REQUEST_OPTIMIZATION = "extreme";
    expect(() => new DatabaseConfig()).toThrow();
  });
});
