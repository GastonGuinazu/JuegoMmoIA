import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { AuthResponseDto } from '@aetheris/shared-types';
import { AuthService } from './auth.service';
import { LoginRequestDto } from './dto/login-request.dto';
import { RegisterRequestDto } from './dto/register-request.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterRequestDto): Promise<AuthResponseDto> {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginRequestDto): Promise<AuthResponseDto> {
    return this.auth.login(dto);
  }
}
