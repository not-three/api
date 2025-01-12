import { ApiProperty } from '@nestjs/swagger';

export class FileUploadRequest {
  @ApiProperty({
    example: 'my-file.txt',
    description: 'The name of the file being uploaded',
  })
  name: string;
}
