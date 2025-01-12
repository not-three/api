import { ApiProperty } from '@nestjs/swagger';

export class FileListItem {
  @ApiProperty({
    example: 'example.txt',
    description: 'The name of the file',
  })
  name: string;

  @ApiProperty({
    example: 'dQw4w9WgXcQ',
    description:
      'The unique identifier for the file that was uploaded, used to download or delete it',
  })
  id: string;

  @ApiProperty({
    example: 1735686000,
    description: 'When the file expires, in UNIX timestamp format',
  })
  expiresAt: number;

  @ApiProperty({
    example: false,
    description: 'Whether the upload is complete',
  })
  uploaded: boolean;
}

export class FileListResponse {
  @ApiProperty({
    example: [
      {
        name: 'example.txt',
        id: 'dQw4w9WgXcQ',
        expiresAt: 1735686000,
        uploaded: false,
      },
    ],
    description: 'A list of files that have been uploaded from this IP address',
  })
  files: FileListItem[];
}
