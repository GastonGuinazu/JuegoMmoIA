import { CommonModule } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import type { WsPartyMemberSnapshot } from '../../../../../../libs/shared-types/src/world-socket';

@Component({
  selector: 'app-party-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './party-panel.component.html',
  styleUrl: './party-panel.component.scss',
})
export class PartyPanelComponent {
  readonly members = input<WsPartyMemberSnapshot[]>([]);
  readonly selfCharacterId = input.required<string>();

  readonly leaveParty = output<void>();
  readonly kickMember = output<string>();

  readonly isSelfLeader = computed(() =>
    this.members().some((m) => m.characterId === this.selfCharacterId() && m.isLeader),
  );

  isSelf(characterId: string): boolean {
    return characterId === this.selfCharacterId();
  }

  hpPercent(m: WsPartyMemberSnapshot): number {
    return m.maxHp > 0 ? Math.max(0, Math.min(100, (100 * m.currentHp) / m.maxHp)) : 0;
  }

  mpPercent(m: WsPartyMemberSnapshot): number {
    return m.maxMp > 0 ? Math.max(0, Math.min(100, (100 * m.currentMp) / m.maxMp)) : 0;
  }
}
