import { Request } from 'express';
import { GetIpConfig } from 'src/config';
import { HttpException } from '@nestjs/common';
import { ip, ipRegex } from './esm-fix';

export function getIp(req: Request) {
  let i = req.ip;
  const cfg = new GetIpConfig();
  if (cfg.behindProxy && req.headers['x-forwarded-for']) {
    i = req.headers['x-forwarded-for'] as string;
  }

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

  return i;
}
