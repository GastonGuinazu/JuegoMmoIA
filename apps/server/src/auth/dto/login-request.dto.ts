import { IsString, Length } from 'class-validator';

export class LoginRequestDto {
  @IsString()
  @Length(3, 24)
  username!: string;

  @IsString()
  @Length(1, 72)
  password!: string;
}
