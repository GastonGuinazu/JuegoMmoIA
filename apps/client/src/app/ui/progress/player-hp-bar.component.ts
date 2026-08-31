import { DecimalPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';

@Component({
  selector: 'app-player-hp-bar',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './player-hp-bar.component.html',
  styleUrl: './player-hp-bar.component.scss',
})
export class PlayerHpBarComponent {
  readonly state = inject(PlayerCharacterStateService);

  /** Porcentaje 0–100 derivado de vitals (servidor); expuesto para el template con signals. */
  readonly hpPercent = this.state.hpPercent;
}
