import { ApiProperty } from '@nestjs/swagger';

export class FetchResponse {
  @ApiProperty({
    example: 'aGVsbG8gd29ybGQ=',
    description: 'The content of the note, encrypted by the client',
  })
  content: string;

  @ApiProperty({
    example: 1735686000,
    description: 'When the note will expire, in UNIX timestamp format',
  })
  expiresAt: number;

  @ApiProperty({
    example: 'text/plain',
    description: 'The MIME type of the content',
    required: false,
  })
  mime?: string;

  @ApiProperty({
    example: false,
    description: 'Whether the note was deleted after being fetched',
  })
  deleted: boolean;
}
