import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  InventoryEquipResponseDto,
  InventoryProgressResponseDto,
  InventoryUnequipResponseDto,
} from '../../../../../libs/shared-types/src/inventory-api';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class InventoryApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl.replace(/\/$/, '');

  fetchProgress(characterId: string) {
    return this.http.get<InventoryProgressResponseDto>(`${this.base}/inventory`, {
      headers: { 'x-character-id': characterId },
    });
  }

  equipItem(
    characterId: string,
    itemId: string,
    slot: string | number,
    parentItemId?: string,
  ) {
    return this.http.post<InventoryEquipResponseDto>(
      `${this.base}/inventory/equip`,
      {
        itemId,
        slot,
        parentItemId,
        idempotencyKey: crypto.randomUUID(),
      },
      { headers: { 'x-character-id': characterId } },
    );
  }

  unequipItem(characterId: string, itemId: string) {
    return this.http.post<InventoryUnequipResponseDto>(
      `${this.base}/inventory/unequip`,
      {
        itemId,
        idempotencyKey: crypto.randomUUID(),
      },
      { headers: { 'x-character-id': characterId } },
    );
  }
}
