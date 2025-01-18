import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { version } from '../../package.json';
import { InfoResponse } from 'src/types/api/InfoResponse';
import { StatsResponse } from 'src/types/api/StatsResponse';
import { DatabaseService } from 'src/services/database.service';
import { ErrorDecorator } from 'src/decorator/error.decorator';
import { GlobalDecorator } from 'src/decorator/global.decorator';
import { getIp } from 'src/etc/getIp';
import { ConfigService } from 'src/services/config.service';

@Controller()
@ApiTags('system')
export class StatsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
  ) {}

  @Get()
  @ApiExcludeEndpoint()
  getRoot(@Res() res: Response): void {
    res.redirect('/swagger');
  }

  @Get('info')
  @ApiResponse({ type: InfoResponse, status: HttpStatus.OK })
  @GlobalDecorator()
  async getInfo(@Req() req: Request): Promise<InfoResponse> {
    const used = await this.db.getTokens(await getIp(req));
    const { limits, fileTransfer } = this.cfg.get();
    return {
      version: version,
      availableTokens: limits.maxTokensPerIp - used,
      maxStorageTimeDays: limits.maxStorageTimeDays,
      fileTransferEnabled: fileTransfer.enabled,
      fileTransferMaxSize: fileTransfer.maxSizeInMB,
    };
  }

  @Get('stats')
  @ApiResponse({ type: StatsResponse, status: HttpStatus.OK })
  @ErrorDecorator(HttpStatus.FORBIDDEN, 'The stats are disabled')
  @GlobalDecorator()
  getStats(): Promise<StatsResponse> {
    return this.db.getStats();
  }
}
