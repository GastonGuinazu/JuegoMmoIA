import { CommonModule } from '@angular/common';
import { Component, ViewChild, ElementRef, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthApiService } from '../core/auth-api.service';
import { CHARACTER_ID_STORAGE_KEY } from '../core/session-storage-keys';
import { HeroPreviewComponent } from './hero-preview.component';
import type {
  AuthCharacterClass,
  AuthCharacterSummaryDto,
} from '../../../../../libs/shared-types/src/auth-api';

const CLASS_OPTIONS: { value: AuthCharacterClass; label: string }[] = [
  { value: 'DARK_KNIGHT', label: 'Dark Knight' },
  { value: 'DARK_WIZARD', label: 'Dark Wizard' },
  { value: 'FAIRY_ELF', label: 'Fairy Elf' },
];

interface HeroSlot {
  url: string;
  label: string;
  yaw?: number;
}

/** Prueba estética: witch_doctor no es una clase jugable todavía, solo está acá
 * porque pega mejor con el estilo del lizard que arachnida (ver charla previa). */
const HERO_SLOTS: { left: HeroSlot; center: HeroSlot; right: HeroSlot } = {
  left: { url: 'models/characters/lizard_man_warrior/scene.gltf', label: 'Dark Knight' },
  center: { url: 'models/characters/sorceress.glb', label: 'Dark Wizard', yaw: Math.PI },
  right: { url: 'models/characters/witch_doctor.glb', label: 'Witch Doctor' },
};

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, HeroPreviewComponent],
  templateUrl: './login-page.component.html',
})
export class LoginPageComponent {
  private readonly fb = inject(FormBuilder);
  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);

  @ViewChild('music') private readonly musicRef?: ElementRef<HTMLAudioElement>;

  readonly classOptions = CLASS_OPTIONS;
  readonly heroSlots = HERO_SLOTS;

  readonly mode = signal<'login' | 'register'>('login');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly soundOn = signal(false);
  /** Solo se llena si la cuenta tiene más de un personaje (hoy el registro crea uno solo). */
  readonly pendingCharacters = signal<AuthCharacterSummaryDto[] | null>(null);

  readonly form = this.fb.nonNullable.group({
    username: ['', [Validators.required, Validators.minLength(3)]],
    password: ['', [Validators.required, Validators.minLength(4)]],
    characterName: [''],
    characterClass: ['DARK_KNIGHT' as AuthCharacterClass],
  });

  setMode(mode: 'login' | 'register'): void {
    this.mode.set(mode);
    this.error.set(null);
    this.pendingCharacters.set(null);
  }

  toggleMusic(): void {
    const el = this.musicRef?.nativeElement;
    if (!el) {
      return;
    }
    if (this.soundOn()) {
      el.pause();
      this.soundOn.set(false);
      return;
    }
    el.play()
      .then(() => this.soundOn.set(true))
      .catch(() => this.soundOn.set(false));
  }

  submit(): void {
    this.error.set(null);
    const isRegister = this.mode() === 'register';
    if (isRegister) {
      this.form.controls.characterName.addValidators(Validators.required);
      this.form.controls.characterName.updateValueAndValidity();
    } else {
      this.form.controls.characterName.clearValidators();
      this.form.controls.characterName.updateValueAndValidity();
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Revisá los campos marcados');
      return;
    }
    const { username, password, characterName, characterClass } = this.form.getRawValue();
    this.busy.set(true);
    const request$ = isRegister
      ? this.authApi.register({
          username: username.trim(),
          password,
          characterName: characterName.trim(),
          characterClass,
        })
      : this.authApi.login({ username: username.trim(), password });
    request$.subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.characters.length === 1) {
          this.enterGame(res.characters[0]!.id);
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
    this.enterGame(id);
  }

  private enterGame(characterId: string): void {
    sessionStorage.setItem(CHARACTER_ID_STORAGE_KEY, characterId);
    void this.router.navigateByUrl('/');
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
