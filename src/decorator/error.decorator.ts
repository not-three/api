import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponse } from 'src/types/api/ErrorResponse';

export function ErrorDecorator(status: number, description: string) {
  return applyDecorators(
    ApiResponse({ status, description, type: ErrorResponse }),
  );
}
