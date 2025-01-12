import { Request } from 'express';

export function getIp(req: Request) {
  let ip = req.ip;
  if (process.env.BEHIND_PROXY === 'true') {
    if (req.headers['x-forwarded-for']) {
      ip = req.headers['x-forwarded-for'] as string;
    }
  }
  return ip;
}
