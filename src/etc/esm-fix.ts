import type pRetryD from "p-retry";
import type ipRegexD from "ip-regex";
type nanoIdD = (size?: number) => string;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fixEsm = require("fix-esm");

export const ipRegex = fixEsm.require("ip-regex").default as typeof ipRegexD;
export const nanoId = fixEsm.require("nanoid").nanoid as nanoIdD;
export const pRetry = fixEsm.require("p-retry").default as typeof pRetryD;
