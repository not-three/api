import { $bool, $int, $str } from './Helper';

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
   * Tell the api to use a custom header for the IP address. Only used if `behindProxy` is true.
   * If you for example are behind a Cloudflare proxy, you can set this to `CF-Connecting-IP`.
   * Remember that this header can be spoofed, so its recommended to tell your proxy
   * or firewall to only allow (for example) Cloudflare IP addresses.
   * If this is not possible, you can use the `trustedProxies` and `trustedProxiesUrls` options.
   * @default 'X-Forwarded-For'
   * @env IP_HEADER
   */
  ipHeader = $str('IP_HEADER', 'X-Forwarded-For');

  /**
   * Trust only the IP header if the request originates from one of the following ip addresses.
   * @example `192.168.178.1/24,fdf7:7d5b:4f3b:5e3c::/64,10.10.10.1`
   * @default '0.0.0.0/0,::/0'
   * @env TRUSTED_PROXIES
   */
  trustedProxies = $str('TRUSTED_PROXIES', '0.0.0.0/0,::/0');

  /**
   * Trust only the IP header if the request originates from one of the following urls.
   * @example 'https://www.cloudflare.com/ips-v6,https://www.cloudflare.com/ips-v4'
   * @default ''
   * @env TRUSTED_PROXIES_URLS
   */
  trustedProxiesUrls = $str('TRUSTED_PROXIES_URLS', '');

  /**
   * Cache downloaded proxy IP addresses for this amount of seconds.
   * @default 3600
   * @env TRUSTED_PROXIES_CACHE
   */
  trustedProxiesCache = $int('TRUSTED_PROXIES_CACHE', 3600);

  /**
   * Get the proxy IP address from an arbitrary header.
   * Useful if you have setups like `User -> Cloudflare -> Proxy -> Server`.
   * If left empty, the request IP will be used.
   * @example `X-Forwarded-For`
   * @default ''
   * @env PROXY_IP_HEADER
   */
  proxyHeader = $str('PROXY_IP_HEADER', '');

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
