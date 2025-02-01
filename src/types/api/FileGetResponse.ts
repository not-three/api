import { ApiProperty } from '@nestjs/swagger';

export class FileGetResponse {
  @ApiProperty({
    example: 'https://s3.example.com/my-file.txt',
    description: 'An presigned URL to download the file',
  })
  url: string;

  @ApiProperty({
    example: 1024,
    description: 'The size of the file in bytes',
  })
  size: number;

  @ApiProperty({
    example: 'example.txt',
    description: 'The name of the file',
  })
  name: string;

  @ApiProperty({
    example: 1735686000,
    description: 'When the file will expire, in UNIX timestamp format',
  })
  expiresAt: number;
}
