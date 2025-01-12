import {
  Body,
  Controller,
  Delete,
  HttpException,
  HttpStatus,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ErrorDecorator } from 'src/decorator/error.decorator';
import { getIp } from 'src/etc/getIp';
import { GlobalDecorator } from 'src/decorator/global.decorator';
import { DatabaseService } from 'src/services/database.service';
import { DeleteRequest } from 'src/types/api/DeleteRequest';

@Controller('note/:id')
@ApiTags('note')
export class DeleteController {
  constructor(private readonly db: DatabaseService) {}

  @Delete()
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'The note was deleted',
  })
  @ErrorDecorator(HttpStatus.NOT_FOUND, 'The note was not found')
  @ErrorDecorator(
    HttpStatus.UNAUTHORIZED,
    'You are not sending from the correct IP nor have the correct token',
  )
  @ApiBody({ type: DeleteRequest })
  @GlobalDecorator()
  async delete(
    @Body() body: DeleteRequest,
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
  ): Promise<Response> {
    const ip = getIp(req);
    const note = await this.db.getNote(id);
    if (!note)
      throw new HttpException('The note was not found', HttpStatus.NOT_FOUND);
    let allowed = false;
    if (note.ip === ip) allowed = true;
    if (note.delete_token === body.token && body.token !== null) allowed = true;
    if (!allowed)
      throw new HttpException(
        'You are not sending from the correct IP nor have the correct token',
        HttpStatus.UNAUTHORIZED,
      );
    await this.db.deleteNote(id);
    return res.status(HttpStatus.NO_CONTENT).send();
  }
}
