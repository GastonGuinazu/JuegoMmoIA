import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, effect, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatChannel,
  type WsChatMessagePayload,
} from '../../../../../../libs/shared-types/src/world-socket';

@Component({
  selector: 'app-chat-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-panel.component.html',
  styleUrl: './chat-panel.component.scss',
})
export class ChatPanelComponent {
  readonly globalMessages = input<WsChatMessagePayload[]>([]);
  readonly partyMessages = input<WsChatMessagePayload[]>([]);
  readonly hasParty = input(false);
  readonly selfCharacterId = input.required<string>();
  /** El padre lo prende cuando llega un mensaje con el chat cerrado (ver `peekChat`). */
  readonly readOnlyPeek = input(false);

  readonly send = output<{ channel: ChatChannel; text: string }>();
  /** Esc dentro del input: el padre decide qué hacer (cerrar el panel). */
  readonly closeRequested = output<void>();
  /** Click en el panel mientras está en modo lectura: el padre lo pasa a abierto/interactivo. */
  readonly requestOpen = output<void>();

  activeChannel: ChatChannel = 'global';
  draft = '';
  readonly maxLength = CHAT_MESSAGE_MAX_LENGTH;

  @ViewChild('list') private listRef?: ElementRef<HTMLDivElement>;
  @ViewChild('chatInput') private inputRef?: ElementRef<HTMLInputElement>;

  constructor() {
    // Autoscroll: cualquier mensaje nuevo (del canal que se esté mirando o no, da igual,
    // es barato) empuja la lista al final.
    effect(() => {
      this.globalMessages();
      this.partyMessages();
      queueMicrotask(() => this.scrollToBottom());
    });
  }

  setChannel(channel: ChatChannel): void {
    if (channel === 'party' && !this.hasParty()) {
      return;
    }
    this.activeChannel = channel;
    queueMicrotask(() => this.scrollToBottom());
  }

  activeMessages(): WsChatMessagePayload[] {
    return this.activeChannel === 'party' ? this.partyMessages() : this.globalMessages();
  }

  submit(): void {
    const text = this.draft.trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);
    if (!text) {
      return;
    }
    this.send.emit({ channel: this.activeChannel, text });
    this.draft = '';
  }

  /** Llamado desde el padre justo después de abrir el panel (ver `openChat` en game-viewport). */
  focusInput(): void {
    this.inputRef?.nativeElement.focus();
  }

  /**
   * Tab sólo tiene sentido como atajo de canal mientras el chat está abierto y
   * enfocado — cuando está cerrado, Tab sigue abriendo/cerrando el inventario
   * (ver `handleSkillHotkeys`; ese binding global se salta solo porque el foco
   * ya está en este input, no por nada que haga este método).
   */
  onInputTabKeydown(event: Event): void {
    event.preventDefault();
    if (!this.hasParty()) {
      return;
    }
    this.setChannel(this.activeChannel === 'global' ? 'party' : 'global');
  }

  onInputEscapeKeydown(): void {
    this.closeRequested.emit();
  }

  isSelf(characterId: string): boolean {
    return characterId === this.selfCharacterId();
  }

  formatTime(atMs: number): string {
    const d = new Date(atMs);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }

  private scrollToBottom(): void {
    const el = this.listRef?.nativeElement;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }
}
