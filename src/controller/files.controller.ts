import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ErrorDecorator } from 'src/decorator/error.decorator';
import { GlobalDecorator } from 'src/decorator/global.decorator';
import { getIp } from 'src/etc/getIp';
import { FileGuard } from 'src/guards/file.guard';
import { ConfigService } from 'src/services/config.service';
import { DatabaseService } from 'src/services/database.service';
import { S3Service } from 'src/services/s3.service';
import { FileCloseUploadRequest } from 'src/types/api/FileCloseUploadRequest';
import { FileListResponse } from 'src/types/api/FileListResponse';
import { FileUploadRequest } from 'src/types/api/FileUploadRequest';
import { FileUploadResponse } from 'src/types/api/FileUploadResponse';

function DefaultDecorator(notFound = true, upload = false) {
  return applyDecorators(
    GlobalDecorator(),
    ErrorDecorator(HttpStatus.FORBIDDEN, 'The file transfer is disabled'),
    UseGuards(FileGuard),
    ...(notFound
      ? [ErrorDecorator(HttpStatus.NOT_FOUND, 'The file was not found')]
      : []),
    ...(upload
      ? [
          ErrorDecorator(
            HttpStatus.CONFLICT,
            'The file is already uploaded, no more parts can be uploaded',
          ),
        ]
      : []),
  );
}

@Controller('file')
@ApiTags('file')
export class FilesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
    private readonly s3: S3Service,
  ) {}

  @Post('upload')
  @ApiBody({ type: FileUploadRequest })
  @ApiResponse({ status: HttpStatus.CREATED, type: FileUploadResponse })
  @ErrorDecorator(
    HttpStatus.CONFLICT,
    'The limit of simultaneous uploads from this IP or the global limit has been reached',
  )
  @DefaultDecorator(false)
  async uploadFile(
    @Req() req: Request,
    @Body() body: FileUploadRequest,
  ): Promise<FileUploadResponse> {
    if (/[^a-zA-Z0-9._-]/.test(body.name))
      throw new HttpException(
        'The file name contains invalid characters',
        HttpStatus.BAD_REQUEST,
      );

    const ip = getIp(req);
    const { fileTransfer } = this.cfg.get();
    const [total, files] = await Promise.all([
      this.db.getTotalFiles(),
      this.db.getFiles(ip),
    ]);

    if (total >= fileTransfer.globalMaximumSimultaneousFiles)
      throw new HttpException(
        'The global limit of simultaneous uploads has been reached',
        HttpStatus.CONFLICT,
      );
    if (files.length >= fileTransfer.simultaneousFilesPerIp)
      throw new HttpException(
        'The limit of simultaneous uploads from this IP has been reached',
        HttpStatus.CONFLICT,
      );

    const expires = Date.now() + fileTransfer.uploadTimeInMinutes * 60_000;

    const id = await this.db.createFile({
      ip,
      name: body.name,
      expires_at: expires,
      upload_id: null,
      part: 0,
    });

    const key = `${id}/${body.name}`;
    const uploadId = await this.s3.startMultipartUpload(key, new Date(expires));
    await this.db.updateFile(id, { upload_id: uploadId });
    return { id };
  }

  @Get('upload/:id')
  @ApiQuery({ name: 'length', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The next pre-signed multipart upload URL',
    type: String,
  })
  @ErrorDecorator(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'Requesting another part would exceed the maximum file size, the upload was aborted',
  )
  @DefaultDecorator(true, true)
  async getUploadUrl(
    @Param('id') id: string,
    @Query('length') length: string,
    @Req() req: Request,
  ): Promise<string> {
    if (!length)
      throw new HttpException(
        'The length query parameter is required',
        HttpStatus.BAD_REQUEST,
      );
    const lengthN = Number(length);
    if (isNaN(lengthN))
      throw new HttpException(
        'The length query parameter must be a number',
        HttpStatus.BAD_REQUEST,
      );
    if (lengthN > 5 * 1024 * 1024)
      throw new HttpException(
        'The part length must be at most 5MB',
        HttpStatus.BAD_REQUEST,
      );
    const file = await this.db.getFile(id);
    if (!file)
      throw new HttpException(
        'No active upload found, please create one first',
        HttpStatus.NOT_FOUND,
      );
    if (file.upload_id === null)
      throw new HttpException(
        'The file is already uploaded, no more parts can be uploaded',
        HttpStatus.CONFLICT,
      );
    const ip = getIp(req);
    if (file.ip !== ip)
      throw new HttpException(
        'You are not authorized to upload this file, only the ip that started the upload can',
        HttpStatus.UNAUTHORIZED,
      );
    const part = file.part + 1;
    if (part * 5 > this.cfg.get().fileTransfer.maxSizeInMB) {
      await this.s3.abortMultipartUpload(
        `${file.id}/${file.name}`,
        file.upload_id,
      );
      await this.db.deleteFile(id);
      throw new HttpException(
        'The file is too large, the upload was aborted',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    this.db.updateFile(id, { part });
    const key = `${file.id}/${file.name}`;
    return await this.s3.createUploadPartUrl(
      key,
      file.upload_id,
      part,
      lengthN,
    );
  }

  @Put('upload/:id')
  @ApiBody({ type: FileCloseUploadRequest })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Successfully closed the upload, the file is now available',
  })
  @ErrorDecorator(
    HttpStatus.EXPECTATION_FAILED,
    'Failed to complete the upload, please check the etags and try again',
  )
  @DefaultDecorator(true, true)
  async closeUpload(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: FileCloseUploadRequest,
  ): Promise<void> {
    const file = await this.db.getFile(id);
    if (!file)
      throw new HttpException(
        'No active upload found, please create one first',
        HttpStatus.NOT_FOUND,
      );
    if (file.upload_id === null)
      throw new HttpException(
        'The file is already uploaded, no more parts can be uploaded',
        HttpStatus.CONFLICT,
      );
    const ip = getIp(req);
    if (file.ip !== ip)
      throw new HttpException(
        'You are not authorized to upload this file, only the ip that started the upload can',
        HttpStatus.UNAUTHORIZED,
      );
    try {
      await this.s3.completeMultipartUpload(
        `${file.id}/${file.name}`,
        file.upload_id,
        body.etags,
      );
    } catch {
      throw new HttpException(
        'Failed to complete the upload, please check the etags and try again',
        HttpStatus.EXPECTATION_FAILED,
      );
    }
    await this.db.updateFile(id, {
      upload_id: null,
      expires_at:
        Date.now() + this.cfg.get().fileTransfer.storageTimeInMinutes * 60_000,
    });
  }

  @Get(':id')
  @ApiResponse({
    status: HttpStatus.FOUND,
    description: 'The file was found, redirecting to download',
  })
  @DefaultDecorator()
  async downloadFile(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.db.getFile(id);
    if (!file)
      throw new HttpException('The file was not found', HttpStatus.NOT_FOUND);
    res.redirect(302, await this.s3.createDownloadUrl(`${id}/${file.name}`));
  }

  @Delete(':id')
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'The file was deleted or the upload was aborted',
  })
  @ErrorDecorator(
    HttpStatus.UNAUTHORIZED,
    'You are not authorized to delete this file, only the ip that uploaded it can',
  )
  @DefaultDecorator()
  async deleteFile(
    @Param('id') id: string,
    @Res() res: Response,
    @Req() req: Request,
  ): Promise<void> {
    const file = await this.db.getFile(id);
    if (!file)
      throw new HttpException('The file was not found', HttpStatus.NOT_FOUND);
    const ip = getIp(req);
    if (file.ip !== ip)
      throw new HttpException(
        'You are not authorized to delete this file, only the ip that uploaded it can',
        HttpStatus.UNAUTHORIZED,
      );
    if (file.upload_id !== null)
      await this.s3.abortMultipartUpload(`${id}/${file.name}`, file.upload_id);
    await this.s3.delete(`${id}/${file.name}`).catch(() => {});
    await this.db.deleteFile(id);
    res.status(HttpStatus.NO_CONTENT).send();
  }

  @Get()
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'A list of files that have been uploaded from this IP address',
    type: FileListResponse,
  })
  @DefaultDecorator(false)
  async listFiles(@Req() req: Request): Promise<FileListResponse> {
    return {
      files: (await this.db.getFiles(getIp(req))).map((file) => ({
        name: file.name,
        id: file.id,
        expiresAt: file.expires_at,
        uploaded: file.upload_id === null,
      })),
    };
  }
}
