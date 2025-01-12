import { ApiProperty } from '@nestjs/swagger';

export class DeleteRequest {
  @ApiProperty({
    example: 'password1',
    description: [
      'The delete token for the note, generated while creating the note.',
      'Not required if you send the request from the same IP address that created the note.',
    ].join(' '),
    required: false,
  })
  token: string;
}
