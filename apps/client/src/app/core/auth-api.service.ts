import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  AuthResponseDto,
  LoginRequestDto,
  RegisterRequestDto,
} from '../../../../../libs/shared-types/src/auth-api';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class AuthApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl.replace(/\/$/, '');

  login(dto: LoginRequestDto) {
    return this.http.post<AuthResponseDto>(`${this.base}/auth/login`, dto);
  }

  register(dto: RegisterRequestDto) {
    return this.http.post<AuthResponseDto>(`${this.base}/auth/register`, dto);
  }
}
