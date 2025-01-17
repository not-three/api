import { applyDecorators, UseFilters, UseGuards } from '@nestjs/common';
import { ErrorDecorator } from './error.decorator';
import { ExceptionsFilter } from '../etc/exception.filter';
import { BanGuard } from '../guards/ban.guard';
import { RequestGuard } from '../guards/request.guard';
import { LogGuard } from '../guards/log.guard';

export function GlobalDecorator() {
  return applyDecorators(
    ErrorDecorator(
      429,
      'Too many requests from your ip, try again in a few minutes',
    ),
    ErrorDecorator(418, 'Your ip is temporarily blocked, try again later'),
    ErrorDecorator(500, 'An internal server error occurred'),
    UseFilters(ExceptionsFilter),
    UseGuards(LogGuard, BanGuard, RequestGuard),
  );
}
