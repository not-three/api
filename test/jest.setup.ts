import { Logger } from "@nestjs/common";

// The e2e apps are created with `logger: false`, but module-global loggers
// (getIp.ts) fall back to the default console logger. Silence everything so
// test output stays readable.
Logger.overrideLogger(false);
