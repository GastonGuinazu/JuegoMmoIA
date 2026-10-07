import { CharacterClass } from '@prisma/client';
import { IsEnum, IsString, Length, Matches } from 'class-validator';

export class RegisterRequestDto {
  @IsString()
  @Length(3, 24)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'username solo admite letras, números y guión bajo' })
  username!: string;

  @IsString()
  @Length(6, 72)
  password!: string;

  @IsString()
  @Length(2, 24)
  characterName!: string;

  @IsEnum(CharacterClass)
  characterClass!: CharacterClass;
}
