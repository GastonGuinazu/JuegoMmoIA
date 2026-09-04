import { DecimalPipe, PercentPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';

@Component({
  selector: 'app-character-sheet-panel',
  standalone: true,
  imports: [DecimalPipe, PercentPipe],
  templateUrl: './character-sheet-panel.component.html',
  styleUrl: './character-sheet-panel.component.scss',
})
export class CharacterSheetPanelComponent {
  readonly state = inject(PlayerCharacterStateService);

  distribute(statName: 'STR' | 'AGI' | 'VIT' | 'ENE'): void {
    const sheet = this.state.characterSheet();
    if (!sheet) {
      return;
    }
    this.state.requestDistributeStat(sheet.characterId, statName, 1);
  }
}
