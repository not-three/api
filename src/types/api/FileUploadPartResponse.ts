import { ApiProperty } from '@nestjs/swagger';

export class FileUploadPartResponse {
  @ApiProperty({
    example: 's3.example.com/my-file.txt',
    description:
      'The multipart upload URL for the file that was uploaded, used to upload the file parts',
  })
  url: string;
}
