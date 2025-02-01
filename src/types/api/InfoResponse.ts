import { ApiProperty } from "@nestjs/swagger";

export class InfoResponse {
  @ApiProperty({
    description: [
      "The current version of the API, in semver format",
      'or the string "IN-DEV" to indicate a dev build.',
    ].join(" "),
    example: "1.0.0",
  })
  version: string;

  @ApiProperty({
    description:
      "The number of tokens the requesting ip has currently remaining",
    example: 100_000,
  })
  availableTokens: number;

  @ApiProperty({
    description:
      "The maximum number of days that data will be stored before being purged",
    example: 30,
  })
  maxStorageTimeDays: number;

  @ApiProperty({
    description: "If the file transfer feature is enabled",
    example: true,
  })
  fileTransferEnabled: boolean;

  @ApiProperty({
    description: "File transfer maximum size in MB",
    example: 10_000,
  })
  fileTransferMaxSize: number;

  @ApiProperty({
    description:
      "If this instance is running in private mode and requires a password",
    example: false,
  })
  privateMode: boolean;
}
