import { $bool, $float, $int } from "./Helper";

export class LimitsConfig {
  /** @hidden */
  constructor() {}

  /**
   * Whether the limits are disabled.
   * @default false
   * @env LIMITS_DISABLED
   */
  disabled = $bool("LIMITS_DISABLED", false);

  /**
   * The time in minutes after which token records expire.
   * If you make a request, the app will remember your IP address + the used tokens for this time.
   * Tokens are practically the same as the byte count of the content from a note.
   * @default 60
   * @env LIMITS_TOKENS_EXPIRE_AFTER_MINUTES
   */
  tokensExpireAfterMinutes = $int("LIMITS_TOKENS_EXPIRE_AFTER_MINUTES", 60);

  /**
   * If the content of a note is smaller than this value, it will be treated as if it was this value.
   * @default 1000
   * @env LIMITS_MIN_TOKENS_PER_CREATE
   */
  minTokensPerCreate = $int("LIMITS_MIN_TOKENS_PER_CREATE", 1000);

  /**
   * The maximum amount of tokens an IP address can use.
   * @default 8000000
   * @env LIMITS_MAX_TOKENS_PER_IP
   */
  maxTokensPerIp = $int("LIMITS_MAX_TOKENS_PER_IP", 8_000_000);

  /**
   * The maximum amount of tokens a single request can use.
   * @default 8000000
   * @env LIMITS_MAX_TOKENS_PER_REQUEST
   */
  maxTokensPerRequest = $int("LIMITS_MAX_TOKENS_PER_REQUEST", 8_000_000);

  /**
   * The maximum amount of requests per IP address per minute.
   * @default 300
   * @env LIMITS_MAX_REQUESTS_PER_IP_PER_MINUTE
   */
  maxRequestsPerIpPerMinute = $int(
    "LIMITS_MAX_REQUESTS_PER_IP_PER_MINUTE",
    300,
  );

  /**
   * The multiplier for the amount of tokens a decryption request costs.
   * @default 0.05
   * @env LIMITS_DECRYPTION_REQUEST_MULTIPLIER
   */
  decryptionRequestMultiplier = $float(
    "LIMITS_DECRYPTION_REQUEST_MULTIPLIER",
    0.05,
  );

  /**
   * The amount of failed requests after which an IP address is banned.
   * @default 60
   * @env LIMITS_BAN_AFTER_FAILED_REQUESTS
   */
  banAfterFailedRequests = $int("LIMITS_BAN_AFTER_FAILED_REQUESTS", 60);

  /**
   * The duration in minutes for which an IP address is banned.
   * @default 60
   * @env LIMITS_BAN_DURATION_MINUTES
   */
  banDurationMinutes = $int("LIMITS_BAN_DURATION_MINUTES", 60);

  /**
   * The duration in minutes after which failed requests are forgotten.
   * @default 5
   * @env LIMITS_BAN_FAILED_REQUESTS_RESET_AFTER_MINUTES
   */
  banFailedRequestsResetAfterMinutes = $int(
    "LIMITS_BAN_FAILED_REQUESTS_RESET_AFTER_MINUTES",
    5,
  );

  /**
   * The maximum amount of days a note can be stored.
   * @default 30
   * @env LIMITS_MAX_STORAGE_TIME_DAYS
   */
  maxStorageTimeDays = $int("LIMITS_MAX_STORAGE_TIME_DAYS", 30);
}
