export type RequestOptimizationMode = "none" | "light" | "hard";

export interface OptimizationProfile {
  /** TTL of the generic read cache (notes, files) in milliseconds. */
  readCacheTtlMs: number;
  /** TTL of the /stats response cache in milliseconds. */
  statsCacheTtlMs: number;
  /** TTL of positive ban lookups in milliseconds. */
  banCacheTtlMs: number;
  /** Minimum time between cleanup cron executions (0 = every tick). */
  cleanupIntervalMs: number;
}

export const OPTIMIZATION_PROFILES: Record<
  RequestOptimizationMode,
  OptimizationProfile
> = {
  none: {
    readCacheTtlMs: 30_000,
    statsCacheTtlMs: 30_000,
    banCacheTtlMs: 60_000,
    cleanupIntervalMs: 0,
  },
  light: {
    readCacheTtlMs: 300_000,
    statsCacheTtlMs: 300_000,
    banCacheTtlMs: 300_000,
    cleanupIntervalMs: 900_000,
  },
  hard: {
    readCacheTtlMs: 300_000,
    statsCacheTtlMs: 900_000,
    banCacheTtlMs: 300_000,
    cleanupIntervalMs: 3_600_000,
  },
};

export function intervalElapsed(
  lastRunMs: number,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (intervalMs <= 0) return true;
  return nowMs - lastRunMs >= intervalMs;
}
