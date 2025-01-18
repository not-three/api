import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from 'src/services/config.service';
import { DatabaseService } from 'src/services/database.service';
import { getIp } from '../etc/getIp';

@Injectable()
export class RequestGuard implements CanActivate {
  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const limits = this.cfg.get().limits;
    if (limits.disabled) return true;
    const request = context.switchToHttp().getRequest();
    const ip = await getIp(request);
    const count = await this.db.getRequests(ip);
    const ban = count.failed >= limits.banAfterFailedRequests;
    if (ban) await this.db.ban(ip);
    if (count.total >= limits.maxRequestsPerIpPerMinute || ban)
      throw new HttpException(
        'Too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    await this.db.createRequest(ip, false);
    return true;
  }
}
