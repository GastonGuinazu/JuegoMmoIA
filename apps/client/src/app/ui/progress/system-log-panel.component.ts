import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';

@Component({
  selector: 'app-system-log-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './system-log-panel.component.html',
  styleUrl: './system-log-panel.component.scss',
})
export class SystemLogPanelComponent {
  readonly state = inject(PlayerCharacterStateService);
}
