import { Request } from 'express';
import { HttpException } from '@nestjs/common';
import { ip, ipRegex } from './esm-fix';
import { Netmask } from 'netmask';
import { GetIpConfig } from 'src/config';

type Config = {
  trustedProxies: string;
  trustedProxiesUrls: string;
  trustedProxiesCache: number;
  behindProxy: boolean;
  proxyHeader: string;
  ipHeader: string;
  stripIpv6Address: number;
};

let cachedProxies: string[] = [];
let lastCacheUpdate = 0;

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
    list.map(async (url) => {
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

async function getTrustedProxies(cfg: Config): Promise<string[]> {
  if (Date.now() - lastCacheUpdate < cfg.trustedProxiesCache * 1000)
    return cachedProxies;
  const local = parseCidrList(cfg.trustedProxies);
  let remote: string[] = [];
  if (cfg.trustedProxiesUrls)
    remote = await fetchRemoteProxies(cfg.trustedProxiesUrls);
  cachedProxies = [...local, ...remote];
  lastCacheUpdate = Date.now();
  return cachedProxies;
}

function isTrusted(ipStr: string, cidrList: string[]): boolean {
  for (const cidr of cidrList) {
    try {
      const block = new Netmask(cidr);
      if (block.contains(ipStr)) return true;
    } catch {}
  }
  return false;
}

function validateIp(i: string, cfg: Config, req: Request): string {
  const [isV4, isV6] = [
    ipRegex({ exact: true }),
    ipRegex.v6({ exact: true }),
  ].map((r) => r.test(i));
  if (!isV4 && !isV6) throw new HttpException('Invalid IP address', 511);
  if (cfg.stripIpv6Address > 0 && isV6) {
    const buf = ip.toBuffer(i);
    const bytesToStrip = Math.min(cfg.stripIpv6Address, 16);
    for (let j = 16 - bytesToStrip; j < 16; j++) buf[j] = 0;
    i = ip.toString(buf);
  }
  (req as any).CACHED_IP = i;
  return i;
}

export async function getIp(req: Request): Promise<string> {
  if ((req as any).CACHED_IP) return (req as any).CACHED_IP;
  const cfg = new GetIpConfig() as Config;
  let clientIp = req.ip;
  if (!cfg.behindProxy) return validateIp(clientIp, cfg, req);
  const trustList = await getTrustedProxies(cfg);
  const proxyIpH = cfg.proxyHeader ? req.headers[cfg.proxyHeader] : clientIp;
  const proxyIP = Array.isArray(proxyIpH) ? proxyIpH[0] : proxyIpH;
  if (!isTrusted(proxyIP, trustList)) return validateIp(clientIp, cfg, req);
  const headerKey = cfg.proxyHeader || cfg.ipHeader;
  const forwarded = req.headers[headerKey.toLowerCase()] as string | undefined;
  if (!forwarded) return validateIp(clientIp, cfg, req);
  clientIp = forwarded.split(',')[0].trim();
  return validateIp(clientIp, cfg, req);
}
