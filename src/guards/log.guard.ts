import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from 'src/services/database.service';
import { getIp } from '../etc/getIp';

@Injectable()
export class LogGuard implements CanActivate {
  private readonly logger = new Logger(LogGuard.name);
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    this.logger.log(
      [
        `Request from ${await getIp(request)}`,
        ...(request.headers['user-agent']
          ? [`[${request.headers['user-agent']}]`]
          : []),
        `${request.method} ${request.url}`,
      ].join(' '),
    );
    return true;
  }
}
