import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { DatabaseService } from 'src/services/database.service';
import { getIp } from '../etc/getIp';
import { ConfigService } from 'src/services/config.service';

@Injectable()
export class BanGuard implements CanActivate {
  private readonly logger = new Logger(BanGuard.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.cfg.get().limits.disabled) return true;
    const request = context.switchToHttp().getRequest();
    const ip = getIp(request);
    const banned = await this.db.isBanned(ip);
    if (banned) {
      this.logger.warn(`Blocked request from ${ip} due to ban`);
      throw new HttpException(
        'You are banned, try again later',
        HttpStatus.I_AM_A_TEAPOT,
      );
    }
    return !banned;
  }
}
