import { Component, inject } from '@angular/core';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';

@Component({
  selector: 'app-xp-bar',
  standalone: true,
  templateUrl: './xp-bar.component.html',
  styleUrl: './xp-bar.component.scss',
})
export class XpBarComponent {
  readonly state = inject(PlayerCharacterStateService);
  readonly xpBarPercent = this.state.xpBarPercent;
  readonly xpProgress = this.state.xpProgress;
}
