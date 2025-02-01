import {
  applyDecorators,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  RawBody,
  RawBodyRequest,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConsumes,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request } from "express";
import { ErrorDecorator } from "src/decorator/error.decorator";
import { getIp } from "src/etc/getIp";
import { GlobalDecorator } from "src/decorator/global.decorator";
import { ConfigService } from "src/services/config.service";
import { CryptoService } from "src/services/crypto.service";
import { DatabaseService } from "src/services/database.service";
import { FetchResponse } from "src/types/api/FetchResponse";

function DefaultDecorator(json: boolean, description?: string) {
  return applyDecorators(
    ApiParam({ name: "id", description: "The unique identifier for the note" }),
    ...(!json ? [ApiProduces("text/plain")] : []),
    ApiResponse({
      type: json ? FetchResponse : String,
      description,
      status: HttpStatus.OK,
    }),
    ErrorDecorator(HttpStatus.NOT_FOUND, "The note was not found"),
    GlobalDecorator(true),
  );
}

function DecryptDecorator() {
  return applyDecorators(
    ErrorDecorator(HttpStatus.BAD_REQUEST, "The key is too long"),
    ErrorDecorator(HttpStatus.UNAUTHORIZED, "The decryption key is invalid"),
    DefaultDecorator(false, "The decrypted content of the note"),
  );
}

@Controller("note/:id")
@ApiTags("note")
export class FetchController {
  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  private async getNote(id: string): Promise<FetchResponse> {
    const note = await this.db.getNote(id);
    if (!note)
      throw new HttpException("The note was not found", HttpStatus.NOT_FOUND);
    if (note.self_destruct) await this.db.deleteNote(id);
    return {
      content: note.content,
      deleted: !!note.self_destruct,
      expiresAt: Math.round(
        (note.self_destruct ? Date.now() : note.expires_at) / 1000,
      ),
      mime: note.mime,
    };
  }

  @Get("raw")
  @DefaultDecorator(false, "The content of the note, encrypted")
  async getRaw(@Param("id") id: string): Promise<string> {
    return (await this.getNote(id)).content;
  }

  @Get("json")
  @DefaultDecorator(true)
  async getJson(@Param("id") id: string): Promise<FetchResponse> {
    return await this.getNote(id);
  }

  private async getDecrypted(
    id: string,
    key: string,
    req: Request,
  ): Promise<string> {
    if (key.length > 32)
      throw new HttpException("The key is too long", HttpStatus.BAD_REQUEST);
    const note = await this.db.getNote(id);
    await this.db.createToken(
      await getIp(req),
      Buffer.byteLength(note.content, "utf8"),
    );
    return this.crypto.decrypt(note.content, key);
  }

  @Get("decrypt")
  @ApiQuery({ name: "key", description: "The decryption key for the note" })
  @DecryptDecorator()
  getDecryptedQuery(
    @Param("id") id: string,
    @Query("key") key: string,
    @Req() req: Request,
  ): Promise<string> {
    return this.getDecrypted(id, key, req);
  }

  @Post("decrypt")
  @ApiBody({ type: String, description: "The decryption key for the note" })
  @ApiConsumes("text/plain")
  @DecryptDecorator()
  getDecryptedBody(
    @Param("id") id: string,
    @RawBody() key: Buffer,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<string> {
    return this.getDecrypted(id, key.toString(), req);
  }
}
