import { $bool, $int, $oneOf } from './Helper';
import { DatabaseConfig } from './Database';
import { FileTransferConfig } from './FileTransfer';
import { LimitsConfig } from './Limits';
import { GetIpConfig } from './GetIp';
import { CorsConfig } from './Cors';

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
  idLength = $int('ID_LENGTH', 21);

  /**
   * Child instances do not run migrations or execute scheduled tasks.
   * If you have multiple instances running, all but one should be child instances.
   * @default false
   * @env CHILD_INSTANCE
   */
  childInstance = $bool('CHILD_INSTANCE', false);

  /**
   * The log level of the app.
   * @default 'info'
   * @values 'fatal', 'error', 'warn', 'info', 'debug', 'trace'
   * @env LOG_LEVEL
   */
  logLevel = $oneOf(
    'LOG_LEVEL',
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    'info',
  );

  /**
   * The port the app should listen on.
   * @default 4000
   * @env PORT
   */
  port = $int('PORT', 4000);

  /**
   * If swagger should be disabled.
   * @default false
   * @env DISABLE_SWAGGER
   */
  swaggerDisabled = $bool('DISABLE_SWAGGER', false);
}
