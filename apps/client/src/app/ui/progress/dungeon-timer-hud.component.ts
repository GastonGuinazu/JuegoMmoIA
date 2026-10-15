import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { DungeonUiService } from '../../core/dungeon-ui.service';

@Component({
  selector: 'app-dungeon-timer-hud',
  standalone: true,
  templateUrl: './dungeon-timer-hud.component.html',
  styleUrl: './dungeon-timer-hud.component.scss',
})
export class DungeonTimerHudComponent implements OnInit {
  readonly dungeonUi = inject(DungeonUiService);
  private readonly destroyRef = inject(DestroyRef);

  /** El cronómetro real vive en el servidor (`expiresAtEpochMs`); esto solo re-pinta cada segundo. */
  readonly secondsRemaining = signal(0);

  ngOnInit(): void {
    const timer = setInterval(() => this.tick(), 250);
    this.destroyRef.onDestroy(() => clearInterval(timer));
    this.tick();
  }

  private tick(): void {
    const chamber = this.dungeonUi.activeChamber();
    if (!chamber) {
      this.secondsRemaining.set(0);
      return;
    }
    const remainingMs = chamber.expiresAtEpochMs - Date.now();
    this.secondsRemaining.set(Math.max(0, Math.ceil(remainingMs / 1000)));
  }

  formatMmSs(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
