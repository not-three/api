// Deterministic replacements for the fix-esm loaded modules in
// src/etc/esm-fix.ts — fix-esm's runtime require hooks do not work under jest.
import { randomBytes } from "crypto";
import * as ipaddr from "ipaddr.js";

const alphabet =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

export const nanoId = (size = 21): string => {
  const bytes = randomBytes(size);
  let id = "";
  for (let i = 0; i < size; i++) id += alphabet[bytes[i] & 63];
  return id;
};

export const pRetry = async <T>(
  fn: () => Promise<T>,
  opts?: { retries?: number },
): Promise<T> => {
  const retries = opts?.retries ?? 3;
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
};

// getIp.ts calls ipRegex.v4({exact:true}).test(ip) / ipRegex.v6(...).test(ip),
// so the mock must be a callable with v4/v6 members. Validation is delegated
// to ipaddr.js (a regular CJS dependency of the app).
const matcher = (validate: (s: string) => boolean) => (): RegExp =>
  ({ test: validate }) as unknown as RegExp;

export const ipRegex = Object.assign(
  matcher((s) => ipaddr.isValid(s)),
  {
    v4: matcher((s) => ipaddr.IPv4.isValid(s)),
    v6: matcher((s) => ipaddr.IPv6.isValid(s)),
  },
);
