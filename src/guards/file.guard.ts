import {
  Injectable,
  CanActivate,
  HttpStatus,
  HttpException,
} from "@nestjs/common";
import { ConfigService } from "src/services/config.service";

@Injectable()
export class FileGuard implements CanActivate {
  constructor(private readonly cfg: ConfigService) {}
  async canActivate(): Promise<boolean> {
    if (this.cfg.get().fileTransfer.enabled) return true;
    throw new HttpException("", HttpStatus.FORBIDDEN);
  }
}
