import { CommonModule } from '@angular/common';
import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthApiService } from '../../core/auth-api.service';
import type {
  AuthCharacterClass,
  AuthCharacterSummaryDto,
} from '../../../../../../libs/shared-types/src/auth-api';

const CLASS_OPTIONS: { value: AuthCharacterClass; label: string }[] = [
  { value: 'DARK_KNIGHT', label: 'Dark Knight' },
  { value: 'DARK_WIZARD', label: 'Dark Wizard' },
  { value: 'FAIRY_ELF', label: 'Fairy Elf' },
];

@Component({
  selector: 'app-login-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login-panel.component.html',
  styleUrl: './login-panel.component.scss',
})
export class LoginPanelComponent {
  private readonly authApi = inject(AuthApiService);

  readonly classOptions = CLASS_OPTIONS;

  /** Personaje elegido y listo para conectar: el padre hace `characterIdModel = id` + `connectWorld()`. */
  readonly characterChosen = output<string>();

  readonly mode = signal<'login' | 'register'>('login');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** Solo se llena si la cuenta tiene más de un personaje (hoy el registro crea uno solo). */
  readonly pendingCharacters = signal<AuthCharacterSummaryDto[] | null>(null);

  username = '';
  password = '';
  characterName = '';
  characterClass: AuthCharacterClass = 'DARK_KNIGHT';

  setMode(mode: 'login' | 'register'): void {
    this.mode.set(mode);
    this.error.set(null);
    this.pendingCharacters.set(null);
  }

  submit(): void {
    this.error.set(null);
    const username = this.username.trim();
    const password = this.password;
    if (!username || !password) {
      this.error.set('Completá usuario y contraseña');
      return;
    }
    if (this.mode() === 'register' && !this.characterName.trim()) {
      this.error.set('Ponele un nombre a tu personaje');
      return;
    }
    this.busy.set(true);
    const request$ =
      this.mode() === 'login'
        ? this.authApi.login({ username, password })
        : this.authApi.register({
            username,
            password,
            characterName: this.characterName.trim(),
            characterClass: this.characterClass,
          });
    request$.subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.characters.length === 1) {
          this.characterChosen.emit(res.characters[0]!.id);
          return;
        }
        this.pendingCharacters.set(res.characters);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(extractErrorMessage(err));
      },
    });
  }

  pickCharacter(id: string): void {
    this.characterChosen.emit(id);
  }
}

function extractErrorMessage(err: unknown): string {
  const body = (err as { error?: { message?: string | string[] } } | undefined)?.error;
  if (Array.isArray(body?.message)) {
    return body.message.join(', ');
  }
  if (typeof body?.message === 'string') {
    return body.message;
  }
  return 'No se pudo conectar con el servidor';
}
