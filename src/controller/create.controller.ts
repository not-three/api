import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  RawBody,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { ErrorDecorator } from 'src/decorator/error.decorator';
import { getIp } from 'src/etc/getIp';
import { GlobalDecorator } from 'src/decorator/global.decorator';
import { ConfigService } from 'src/services/config.service';
import { DatabaseService } from 'src/services/database.service';
import { CreateRequest } from 'src/types/api/CreateRequest';
import { CreateResponse } from 'src/types/api/CreateResponse';

@Controller('note')
@ApiTags('note')
export class CreateController {
  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
  ) {}

  @Post('json')
  @ApiResponse({ type: CreateResponse, status: HttpStatus.CREATED })
  @ApiBody({ type: CreateRequest })
  @ErrorDecorator(
    HttpStatus.BAD_REQUEST,
    'Validation failed, see message for details',
  )
  @ErrorDecorator(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'You do not have enough tokens to create this note',
  )
  @GlobalDecorator()
  async createFromJson(
    @Body() body: CreateRequest,
    @Req() req: Request,
  ): Promise<CreateResponse> {
    const ip = await getIp(req);
    const limits = this.cfg.get().limits;

    if (isNaN(+body.expiresIn))
      throw new HttpException(
        'The expiresIn field must be a number',
        HttpStatus.BAD_REQUEST,
      );
    if (body.expiresIn < 60)
      throw new HttpException(
        'The note must expire in at least 1 minute',
        HttpStatus.BAD_REQUEST,
      );
    if (body.expiresIn > limits.maxStorageTimeDays * 86_400)
      throw new HttpException(
        `The note must expire in at most ${limits.maxStorageTimeDays} days`,
        HttpStatus.BAD_REQUEST,
      );

    let cost = Buffer.byteLength(body.content, 'utf8');
    if (cost < limits.minTokensPerCreate) cost = limits.minTokensPerCreate;
    if (cost === 0)
      throw new HttpException(
        'The note must not be empty',
        HttpStatus.BAD_REQUEST,
      );

    const usedTokens = await this.db.getTokens(ip);
    if (usedTokens + cost >= limits.maxTokensPerIp)
      throw new HttpException(
        'You do not have enough tokens to create this note',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );

    const deleteToken = this.db.generateId(8);
    const [id] = await Promise.all([
      this.db.createNote({
        content: body.content,
        mime: body.mime,
        self_destruct: body.selfDestruct,
        expires_at: Date.now() + body.expiresIn * 1000,
        delete_token: deleteToken,
        ip: ip,
      }),
      this.db.createToken(ip, cost),
    ]);

    return { id, deleteToken, cost };
  }

  @Post('text')
  @ApiResponse({
    type: String,
    status: HttpStatus.CREATED,
    description: 'The ID of the note',
  })
  @ApiBody({ type: String, description: 'The content of the note' })
  @ApiConsumes('text/plain')
  @ApiProduces('text/plain')
  @GlobalDecorator()
  async createFromText(
    @RawBody() body: Buffer,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<string> {
    const ip = await getIp(req);
    const limits = this.cfg.get().limits;

    let cost = Buffer.byteLength(body, 'utf8');
    if (cost < limits.minTokensPerCreate) cost = limits.minTokensPerCreate;
    if (cost === 0)
      throw new HttpException(
        'The note must not be empty',
        HttpStatus.BAD_REQUEST,
      );

    const usedTokens = await this.db.getTokens(ip);
    if (usedTokens + cost >= limits.maxTokensPerIp)
      throw new HttpException(
        'You do not have enough tokens to create this note',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );

    if ((req.headers['content-type'] || '').length > 16)
      throw new HttpException(
        'The Content-Type header must be at most 16 characters',
        HttpStatus.BAD_REQUEST,
      );

    const res = await Promise.all([
      this.db.createNote({
        content: body.toString('utf8'),
        ip,
        self_destruct: false,
        expires_at: Date.now() + limits.maxStorageTimeDays * 24 * 60 * 60_000,
        delete_token: null,
        mime: req.headers['content-type'] || null,
      }),
      this.db.createToken(ip, cost),
    ]);

    return res[0];
  }
}
