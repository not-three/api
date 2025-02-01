import { ApiProperty } from "@nestjs/swagger";

export class CreateResponse {
  @ApiProperty({
    example: "dQw4w9WgXcQ",
    description: "The unique identifier for the note that was created",
  })
  id: string;

  @ApiProperty({
    example: 1024,
    description: "The token cost of creating the note",
  })
  cost: number;

  @ApiProperty({
    example: "password1",
    description:
      "The deletion token for the note, required to delete the note before it expires",
  })
  deleteToken: string;
}
