import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ConfigService } from 'src/services/config.service';

@Injectable()
export class CorsInterceptor implements NestInterceptor {
  constructor(private readonly cfg: ConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const response = context.switchToHttp().getResponse();
    const cfg = this.cfg.get().cors;

    if (!cfg.enabled) return next.handle();
    response.header('Access-Control-Allow-Origin', cfg.origin);
    response.header('Access-Control-Allow-Headers', cfg.headers);
    response.header('Access-Control-Allow-Methods', cfg.methods);
    return next.handle();
  }
}
