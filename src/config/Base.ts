import { $bool, $int, $oneOf, $str } from "./Helper";
import { DatabaseConfig } from "./Database";
import { FileTransferConfig } from "./FileTransfer";
import { LimitsConfig } from "./Limits";
import { GetIpConfig } from "./GetIp";
import { CorsConfig } from "./Cors";

/** @hidden */
export const LOG_LEVEL = [
  "fatal",
  "error",
  "warn",
  "log",
  "debug",
  "verbose",
  "trace",
];

export class BaseConfig {
  /** @hidden */
  constructor() {}

  /** @hidden */
  database = new DatabaseConfig();

  /** @hidden */
  limits = new LimitsConfig();

  /** @hidden */
  fileTransfer = new FileTransferConfig();

  /** @hidden */
  getIp = new GetIpConfig();

  /** @hidden */
  cors = new CorsConfig();

  /**
   * The length of the IDs. Cannot be higher than 32, and should not be lower than 8.
   * As we use nanoId, 21 is equal to the 32 characters of a UUID v4.
   * @default 21
   * @env ID_LENGTH
   * @see [https://zelark.github.io/nano-id-cc/](https://zelark.github.io/nano-id-cc/)
   * @see [https://npmjs.com/package/nanoid](https://npmjs.com/package/nanoid)
   */
  idLength = $int("ID_LENGTH", 21);

  /**
   * Child instances do not run migrations or execute scheduled tasks.
   * If you have multiple instances running, all but one should be child instances.
   * @default false
   * @env CHILD_INSTANCE
   */
  childInstance = $bool("CHILD_INSTANCE", false);

  /**
   * The log level of the app.
   * @default 'info'
   * @values 'fatal', 'error', 'warn', 'log', 'debug', 'verbose', 'trace'
   * @env LOG_LEVEL
   */
  logLevel = $oneOf("LOG_LEVEL", LOG_LEVEL, "log");

  /**
   * The port the app should listen on.
   * @default 4000
   * @env PORT
   */
  port = $int("PORT", 4000);

  /**
   * If swagger should be disabled.
   * @default false
   * @env DISABLE_SWAGGER
   */
  swaggerDisabled = $bool("DISABLE_SWAGGER", false);

  /**
   * DNS server override. Rarely needed.
   * @default ''
   * @env DNS_SERVER
   */
  dnsServer = $str("DNS_SERVER", "");

  /**
   * The password to access the stats api.
   * If empty, the stats api is publicly accessible
   * (except the {@link instancePassword} is set).
   * @default ''
   * @env STATS_PASSWORD
   */
  statsPassword = $str("STATS_PASSWORD", "");

  /**
   * The password to access the instance.
   * If empty, the instance is publicly accessible.
   * If set, this will load and enable a global middleware to check for the password inside the Authorization header.
   * The only exception is the /info endpoint, which is always publicly accessible.
   * @default ''
   * @env INSTANCE_PASSWORD
   */
  instancePassword = $str("INSTANCE_PASSWORD", "");

  /**
   * Disable the loading of a .env file.
   * @default false
   */
  disableEnv = $bool("DISABLE_DOTENV", false);
}
