import { $bool, $int } from './Helper';

export class GetIpConfig {
  /** @hidden */
  constructor() {}

  /**
   * If the api is running behind a proxy, set this to true.
   * This will make the app trust the X-Forwarded-For header.
   * @default false
   * @env BEHIND_PROXY
   */
  behindProxy = $bool('BEHIND_PROXY', false);

  /**
   * IPv6 address length to be stripped from the end in bytes.
   * This has implications on logging and rate limiting.
   * As many providers do handout IPv6 addresses with a /64 prefix,
   * we recommend setting this to 8, which will remove the last 16 characters.
   *
   * Example: `abcd:abcd:abcd:abcd:abcd:abcd:abcd:abcd` -> `abcd:abcd:abcd:abcd:0000:0000:0000:0000`
   *
   * If you set this to 0, the full IPv6 address will be logged, and rate limited.
   * Can not be higher than 16. (Which would strip the whole address, why would you do that?)
   * @default 8
   * @env STRIP_IPV6_ADDRESS
   */
  stripIpv6Address = $int('STRIP_IPV6_ADDRESS', 64);
}
