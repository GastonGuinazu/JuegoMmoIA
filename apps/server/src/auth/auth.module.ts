import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CharacterModule } from '../character/character.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [PrismaModule, CharacterModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
