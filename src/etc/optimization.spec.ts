import { OPTIMIZATION_PROFILES, intervalElapsed } from "./optimization";

describe("optimization profiles", () => {
  it("keeps 'none' identical to current behavior", () => {
    expect(OPTIMIZATION_PROFILES.none).toEqual({
      readCacheTtlMs: 30_000,
      statsCacheTtlMs: 30_000,
      banCacheTtlMs: 60_000,
      cleanupIntervalMs: 0,
    });
  });

  it("defines light and hard profiles", () => {
    expect(OPTIMIZATION_PROFILES.light.cleanupIntervalMs).toBe(900_000);
    expect(OPTIMIZATION_PROFILES.light.readCacheTtlMs).toBe(300_000);
    expect(OPTIMIZATION_PROFILES.hard.cleanupIntervalMs).toBe(3_600_000);
    expect(OPTIMIZATION_PROFILES.hard.statsCacheTtlMs).toBe(900_000);
  });

  it("intervalElapsed always fires for interval 0", () => {
    expect(intervalElapsed(1000, 1000, 0)).toBe(true);
  });

  it("intervalElapsed respects the interval", () => {
    expect(intervalElapsed(0, 899_999, 900_000)).toBe(false);
    expect(intervalElapsed(0, 900_000, 900_000)).toBe(true);
  });
});
