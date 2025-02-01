import { ApiProperty } from "@nestjs/swagger";

export class CreateRequest {
  @ApiProperty({
    example: "aGVsbG8gd29ybGQ=",
    description: "The content of the note, encrypted by the client",
  })
  content: string;

  @ApiProperty({
    example: 86400,
    description: [
      "When the note should expire, in seconds from the current time.",
    ].join(" "),
  })
  expiresIn: number;

  @ApiProperty({
    example: "text/plain",
    description: "The MIME type of the content",
    required: false,
  })
  mime?: string;

  @ApiProperty({
    example: false,
    description: "Whether the note should be deleted after being fetched once",
  })
  selfDestruct: boolean;
}
