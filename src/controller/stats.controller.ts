import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiExcludeEndpoint,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { version } from "../../package.json";
import { InfoResponse } from "src/types/api/InfoResponse";
import { StatsResponse } from "src/types/api/StatsResponse";
import { DatabaseService } from "src/services/database.service";
import { ErrorDecorator } from "src/decorator/error.decorator";
import { GlobalDecorator } from "src/decorator/global.decorator";
import { getIp } from "src/etc/getIp";
import { ConfigService } from "src/services/config.service";

@Controller()
@ApiTags("system")
export class StatsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
  ) {}

  @Get()
  @ApiExcludeEndpoint()
  getRoot(@Res() res: Response): void {
    res.redirect("/swagger");
  }

  @Get("info")
  @ApiResponse({ type: InfoResponse, status: HttpStatus.OK })
  @GlobalDecorator(true)
  async getInfo(@Req() req: Request): Promise<InfoResponse> {
    const used = await this.db.getTokens(await getIp(req));
    const { limits, fileTransfer, instancePassword } = this.cfg.get();
    return {
      version: version,
      availableTokens: limits.maxTokensPerIp - used,
      maxStorageTimeDays: limits.maxStorageTimeDays,
      fileTransferEnabled: fileTransfer.enabled,
      fileTransferMaxSize: fileTransfer.maxSizeInMB,
      privateMode: !!instancePassword,
    };
  }

  @Get("stats")
  @ApiQuery({ name: "password", required: false })
  @ApiResponse({ type: StatsResponse, status: HttpStatus.OK })
  @ErrorDecorator(HttpStatus.FORBIDDEN, "The provided password is incorrect")
  @GlobalDecorator()
  getStats(@Query("password") password: string): Promise<StatsResponse> {
    const { statsPassword } = this.cfg.get();
    if (statsPassword && password !== statsPassword)
      throw new HttpException(
        "The provided password is incorrect",
        HttpStatus.FORBIDDEN,
      );
    return this.db.getStats();
  }
}
