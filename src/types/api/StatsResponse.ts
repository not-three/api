import { ApiProperty } from "@nestjs/swagger";

export class StatsResponse {
  @ApiProperty({
    example: 0,
    description: "The UNIX timestamp of the last time the stats were updated",
  })
  time: number;

  @ApiProperty({
    example: 0,
    description:
      "The total number of notes that have been created and are currently stored in the database",
  })
  totalNotes: number;

  @ApiProperty({
    example: 0,
    description:
      "The amount of request that have been made in the last ~60 seconds",
  })
  requestsInLastMinute: number;

  @ApiProperty({
    example: 0,
    description: "The amount of not expired failed requests",
  })
  notExpiredFailedRequests: number;

  @ApiProperty({
    example: 0,
    description: "The amount of currently uploaded files",
  })
  currentFiles: number;

  @ApiProperty({
    example: 0,
    description: "The amount of files that are not currently being uploaded",
  })
  currentUploadingFiles: number;

  @ApiProperty({
    example: 0,
    description: "The amount how many ip addresses are currently banned",
  })
  bannedIps: number;
}
