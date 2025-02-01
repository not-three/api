import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from 'src/services/config.service';

@Injectable()
export class PasswordGuard implements CanActivate {
  private readonly logger = new Logger(PasswordGuard.name);
  constructor(private readonly cfg: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { instancePassword } = this.cfg.get();
    if (!instancePassword) return true;
    const request = context.switchToHttp().getRequest();
    let password =
      request.headers['authorization'] || request.headers['Authorization'];
    const e401 = (): boolean => {
      this.logger.warn('Unauthorized request, missing or invalid password');
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    };
    if (!password || typeof password !== 'string') return e401();
    if (password === instancePassword) return true;
    password = password.substring('Bearer '.length);
    if (password === instancePassword) return true;
    return e401();
  }
}
