import { CommonModule } from '@angular/common';
import { Component, input, output } from '@angular/core';

export type TargetFrameViewModel = {
  name: string;
  level: number;
  hpPercent: number;
  currentHp: number;
  maxHp: number;
  /** `player` = otro jugador (PvP): sin nivel, sin vista de drops y HP sólo conocido tras golpearlo. */
  kind?: 'mob' | 'player';
  /** Color del nombre (flag de karma del jugador objetivo). */
  nameColor?: string;
  /** `true` si el jugador targeteado ya es compañero de grupo (oculta "+ Grupo" y el ataque). */
  isPartyMember?: boolean;
  /** Línea de ayuda bajo la barra (p. ej. cómo atacar a un jugador). */
  hint?: string;
};

export type TargetDropPreviewItemViewModel = {
  catalogKey: string;
  itemDisplayName: string;
  icon: string;
  grade: 'None' | 'D' | 'C' | 'B' | 'A' | 'S';
  chance: number;
};

@Component({
  selector: 'app-target-frame',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './target-frame.component.html',
  styleUrl: './target-frame.component.scss',
})
export class TargetFrameComponent {
  readonly target = input.required<TargetFrameViewModel>();
  readonly previewOpen = input(false);
  readonly previewLoading = input(false);
  readonly previewError = input<string | null>(null);
  readonly levelPenaltyActive = input(false);
  readonly previewItems = input<TargetDropPreviewItemViewModel[]>([]);

  readonly togglePreview = output<void>();
  readonly inviteToParty = output<void>();

  chanceLabel(chance: number): string {
    const pct = chance * 100;
    if (pct >= 1) {
      return `${pct.toFixed(2)}%`;
    }
    if (pct >= 0.1) {
      return `${pct.toFixed(3)}%`;
    }
    return `${pct.toFixed(4)}%`;
  }
}
