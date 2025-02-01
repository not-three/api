import { ApiProperty } from "@nestjs/swagger";

export class ErrorResponse {
  @ApiProperty({ example: 0, description: "The HTTP status code" })
  statusCode: number;

  @ApiProperty({
    example: "Something went wrong",
    description: "The error message",
  })
  message: string;
}
