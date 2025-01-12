import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DatabaseService } from 'src/services/database.service';

@Catch()
export class ExceptionsFilter implements ExceptionFilter {
  private logger = new Logger(ExceptionsFilter.name);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly db: DatabaseService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const isHttpException = exception instanceof HttpException;

    if (!isHttpException) this.logger.error(exception);
    if (!isHttpException || exception.getStatus() !== HttpStatus.I_AM_A_TEAPOT)
      this.db
        .createRequest(ctx.getRequest().ip, true)
        .catch((e) => this.logger.error(e));

    const responseBody = isHttpException
      ? {
          statusCode: exception.getStatus(),
          message: exception.message,
        }
      : {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Internal server error',
        };

    httpAdapter.reply(ctx.getResponse(), responseBody, responseBody.statusCode);
  }
}
