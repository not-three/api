import { ApiProperty } from "@nestjs/swagger";

export class FileUploadResponse {
  @ApiProperty({
    example: "dQw4w9WgXcQ",
    description:
      "The unique identifier for the file that was uploaded, used to download or delete it",
  })
  id: string;
}
