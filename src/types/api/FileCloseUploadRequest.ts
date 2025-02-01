import { ApiProperty } from "@nestjs/swagger";

export class FileCloseUploadRequest {
  @ApiProperty({
    type: "array",
    example: ["etag1", "etag2"],
    description: "List of ETags of the uploaded parts, in order",
  })
  etags: string[];
}
