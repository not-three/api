import { $bool, $str } from "./Helper";

export class CorsConfig {
  /** @hidden */
  constructor() {}

  /**
   * Enable the cors middleware.
   * @default false
   * @env CORS_ENABLED
   */
  enabled = $bool("CORS_ENABLED", false);

  /**
   * The origin(s) to allow.
   * @default '*'
   * @env CORS_ORIGIN
   */
  origin = $str("CORS_ORIGIN", "*");

  /**
   * The methods to allow.
   * @default 'GET,HEAD,PUT,PATCH,POST,DELETE'
   * @env CORS_METHODS
   */
  methods = $str("CORS_METHODS", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");

  /**
   * The headers to allow.
   * @default 'Origin,X-Requested-With,Content-Type,Accept,Authorization'
   * @env CORS_HEADERS
   */
  headers = $str(
    "CORS_HEADERS",
    "Origin,X-Requested-With,Content-Type,Accept,Authorization",
  );
}
