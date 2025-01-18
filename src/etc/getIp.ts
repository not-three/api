import { Request } from 'express';
import { HttpException, Logger } from '@nestjs/common';
import { ipRegex } from './esm-fix';
import { GetIpConfig } from 'src/config';
import * as ipaddr from 'ipaddr.js';

let cachedProxies: string[] = [];
let lastCacheUpdate = 0;
const logger = new Logger('getIp');

function parseCidrList(str: string): string[] {
  return str
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchRemoteProxies(urls: string): Promise<string[]> {
  const result: string[] = [];
  const list = urls
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const responses = await Promise.all(
    list.map(async (url): Promise<string> => {
      const r = await fetch(url);
      return r.ok ? r.text() : '';
    }),
  );
  for (const text of responses) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) result.push(trimmed);
    }
  }
  return result;
}

async function getTrustedProxies(cfg: GetIpConfig): Promise<string[]> {
  if (Date.now() - lastCacheUpdate < cfg.trustedProxiesCache * 1000)
    return cachedProxies;
  const local = parseCidrList(cfg.trustedProxies);
  let remote: string[] = [];
  if (cfg.trustedProxiesUrls)
    remote = await fetchRemoteProxies(cfg.trustedProxiesUrls);
  cachedProxies = remote.length ? remote : local;
  lastCacheUpdate = Date.now();
  logger.debug(`Trusted proxies: ${cachedProxies.join(', ')}`);
  return cachedProxies;
}

function isTrusted(ipStr: string, cidrList: string[]): boolean {
  for (const cidr of cidrList) {
    try {
      logger.verbose(`Checking ${ipStr} against ${cidr}`);
      const [rangeIp, rangeLength] = ipaddr.parseCIDR(cidr);
      if (ipaddr.parse(ipStr).match([rangeIp, rangeLength])) return true;
    } catch {
      if (ipStr === cidr) return true;
    }
  }
  logger.debug(`IP ${ipStr} is not trusted`);
  return false;
}

function validateIp(i: string, cfg: GetIpConfig, req: Request): string {
  logger.debug(`Validating IP: ${i}`);
  const [isV4, isV6] = [
    ipRegex.v4({ exact: true }),
    ipRegex.v6({ exact: true }),
  ].map((r) => r.test(i));
  logger.debug(`Is IPv4: ${isV4}, Is IPv6: ${isV6}`);
  if (!isV4 && !isV6) throw new HttpException('Invalid IP address', 511);
  if (cfg.stripIpv6Address > 0 && isV6) {
    const parsed = ipaddr.parse(i);
    const bytes = parsed.toByteArray();
    logger.debug(
      `Stripping ${cfg.stripIpv6Address} bytes from IPv6 ${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`,
    );
    const bytesToStrip = Math.min(cfg.stripIpv6Address, 16);
    for (let j = 16 - bytesToStrip; j < 16; j++) bytes[j] = 0;
    logger.debug(
      `Stripped IPv6: ${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`,
    );
    i = ipaddr.fromByteArray(bytes).toString();
  }
  (req as any).X_CACHED_IP = i;
  logger.debug(`IP validated: ${i}`);
  return i;
}

export async function getIp(req: Request): Promise<string> {
  if ((req as any).X_CACHED_IP) return (req as any).X_CACHED_IP;
  logger.debug('Getting IP address');

  const cfg = new GetIpConfig();
  let clientIp = req.ip;
  logger.debug(`Client IP: ${clientIp}`);

  const headers = Object.keys(req.headers).reduce(
    (acc, key) => {
      if (Array.isArray(req.headers[key]))
        acc[key.toLowerCase()] = req.headers[key][0];
      else acc[key.toLowerCase()] = req.headers[key] as string;
      return acc;
    },
    {} as Record<string, string>,
  );

  if (!cfg.behindProxy) return validateIp(clientIp, cfg, req);

  clientIp = cfg.proxyHeader
    ? headers[cfg.proxyHeader.toLowerCase()]
    : clientIp;
  logger.debug(`Proxy IP: ${clientIp}`);

  const trustList = await getTrustedProxies(cfg);
  if (!isTrusted(clientIp, trustList)) return validateIp(clientIp, cfg, req);
  logger.debug('Proxy IP is trusted');

  const forwarded = headers[cfg.ipHeader.toLowerCase()];
  if (!forwarded) return validateIp(clientIp, cfg, req);
  clientIp = forwarded.split(',')[0].trim();
  logger.debug(`Forwarded IP: ${clientIp}`);
  return validateIp(clientIp, cfg, req);
}
