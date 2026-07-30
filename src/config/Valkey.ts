import { $bool, $int, $str } from "./Helper";

export class ValkeyConfig {
  /** @hidden */
  constructor() {}

  /**
   * Enable the valkey (or redis compatible) integration.
   * When enabled, the internal cache is stored in valkey instead of in memory,
   * so it is shared between all instances and survives restarts.
   * Required for DATABASE_REQUEST_OPTIMIZATION 'hard'.
   * When using 'hard' mode, it is strongly recommended to enable
   * persistence (AOF) on the valkey server, as buffered notes that
   * have not been flushed yet only exist in valkey.
   * @default false
   * @env VALKEY_ENABLED
   */
  enabled = $bool("VALKEY_ENABLED", false);

  /**
   * The host of the valkey server.
   * @default 'localhost'
   * @env VALKEY_HOST
   */
  host = $str("VALKEY_HOST", "localhost");

  /**
   * The port of the valkey server.
   * @default 6379
   * @env VALKEY_PORT
   */
  port = $int("VALKEY_PORT", 6379);

  /**
   * The username for the valkey server. Leave empty for no authentication.
   * @default ''
   * @env VALKEY_USERNAME
   */
  username = $str("VALKEY_USERNAME", "");

  /**
   * The password for the valkey server. Leave empty for no authentication.
   * @default ''
   * @env VALKEY_PASSWORD
   */
  password = $str("VALKEY_PASSWORD", "");

  /**
   * The valkey database number to use.
   * @default 0
   * @env VALKEY_DB
   */
  db = $int("VALKEY_DB", 0);

  /**
   * Use TLS for the valkey connection.
   * @default false
   * @env VALKEY_TLS
   */
  tls = $bool("VALKEY_TLS", false);

  /**
   * Prefix for all keys stored in valkey.
   * Change this if multiple !3 instances share one valkey database.
   * @default 'not3'
   * @env VALKEY_KEY_PREFIX
   */
  keyPrefix = $str("VALKEY_KEY_PREFIX", "not3");

  /**
   * In 'hard' request optimization mode, buffered writes are flushed to the
   * database after this many seconds at the latest.
   * @default 60
   * @env VALKEY_FLUSH_INTERVAL_SECONDS
   */
  flushIntervalSeconds = $int("VALKEY_FLUSH_INTERVAL_SECONDS", 60);

  /**
   * In 'hard' request optimization mode, buffered writes are flushed to the
   * database as soon as this many entries are pending, even if the flush
   * interval has not elapsed yet.
   * @default 50
   * @env VALKEY_FLUSH_MAX_QUEUE_SIZE
   */
  flushMaxQueueSize = $int("VALKEY_FLUSH_MAX_QUEUE_SIZE", 50);
}
