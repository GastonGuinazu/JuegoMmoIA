import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Character } from '@prisma/client';
import type { AuthCharacterSummaryDto, AuthResponseDto } from '@aetheris/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CharacterService } from '../character/character.service';
import { hashPassword, verifyPassword } from './password.util';
import { LoginRequestDto } from './dto/login-request.dto';
import { RegisterRequestDto } from './dto/register-request.dto';

function toSummary(c: Character): AuthCharacterSummaryDto {
  return {
    id: c.id,
    name: c.name,
    level: c.level,
    characterClass: c.characterClass,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly characters: CharacterService,
  ) {}

  /** Crea cuenta + un primer personaje en el mismo flujo: sin esto, una cuenta recién
   * registrada no tendría con qué entrar al mundo todavía. */
  async register(dto: RegisterRequestDto): Promise<AuthResponseDto> {
    const existing = await this.prisma.account.findUnique({
      where: { username: dto.username },
    });
    if (existing) {
      throw new ConflictException('Ese nombre de usuario ya existe');
    }
    const passwordHash = await hashPassword(dto.password);
    const account = await this.prisma.account.create({
      data: { username: dto.username, passwordHash },
    });
    try {
      const character = await this.characters.createCharacter(
        account.id,
        dto.characterName,
        dto.characterClass,
      );
      return { accountId: account.id, characters: [toSummary(character)] };
    } catch (e) {
      // Sin esto quedaría una cuenta "fantasma" sin personaje y con el username ya tomado.
      await this.prisma.account.delete({ where: { id: account.id } });
      throw e;
    }
  }

  async login(dto: LoginRequestDto): Promise<AuthResponseDto> {
    const account = await this.prisma.account.findUnique({
      where: { username: dto.username },
      include: { characters: true },
    });
    if (!account?.passwordHash || !(await verifyPassword(dto.password, account.passwordHash))) {
      throw new UnauthorizedException('Usuario o contraseña incorrectos');
    }
    return {
      accountId: account.id,
      characters: account.characters.map(toSummary),
    };
  }
}
