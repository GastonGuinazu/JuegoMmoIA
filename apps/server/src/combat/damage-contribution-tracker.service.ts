import { Injectable } from '@nestjs/common';

type DamageByCharacterEntry = {
  totalDamage: number;
  partyId: string | null;
};

type DamageByMobEntry = {
  byCharacter: Map<string, DamageByCharacterEntry>;
  byParty: Map<string, number>;
  lastUpdatedAtMs: number;
};

export type DropOwnerResolution =
  | { ownerId: string; ownerType: 'CHARACTER' }
  | { ownerId: string; ownerType: 'PARTY' };

const TRACKER_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class DamageContributionTrackerService {
  private readonly byMob = new Map<string, DamageByMobEntry>();

  recordDamage(params: {
    mobInstanceId: string;
    characterId: string;
    partyId: string | null;
    damage: number;
  }): void {
    const damage = Math.max(0, Math.floor(params.damage));
    if (damage <= 0) {
      return;
    }
    const row = this.getOrCreate(params.mobInstanceId);
    const current = row.byCharacter.get(params.characterId);
    if (!current) {
      row.byCharacter.set(params.characterId, {
        totalDamage: damage,
        partyId: params.partyId,
      });
    } else {
      current.totalDamage += damage;
      if (!current.partyId && params.partyId) {
        current.partyId = params.partyId;
      }
    }
    if (params.partyId) {
      row.byParty.set(params.partyId, (row.byParty.get(params.partyId) ?? 0) + damage);
    }
    row.lastUpdatedAtMs = Date.now();
  }

  resolveTopOwner(mobInstanceId: string): DropOwnerResolution | null {
    this.pruneExpired();
    const row = this.byMob.get(mobInstanceId);
    if (!row) {
      return null;
    }

    let bestCharacter: { id: string; damage: number } | null = null;
    for (const [characterId, entry] of row.byCharacter) {
      if (!bestCharacter || entry.totalDamage > bestCharacter.damage) {
        bestCharacter = { id: characterId, damage: entry.totalDamage };
      }
    }

    let bestParty: { id: string; damage: number } | null = null;
    for (const [partyId, damage] of row.byParty) {
      if (!bestParty || damage > bestParty.damage) {
        bestParty = { id: partyId, damage };
      }
    }

    if (bestParty && (!bestCharacter || bestParty.damage >= bestCharacter.damage)) {
      return { ownerId: bestParty.id, ownerType: 'PARTY' };
    }
    if (bestCharacter) {
      return { ownerId: bestCharacter.id, ownerType: 'CHARACTER' };
    }
    return null;
  }

  clearMob(mobInstanceId: string): void {
    this.byMob.delete(mobInstanceId);
  }

  private getOrCreate(mobInstanceId: string): DamageByMobEntry {
    const found = this.byMob.get(mobInstanceId);
    if (found) {
      return found;
    }
    const created: DamageByMobEntry = {
      byCharacter: new Map<string, DamageByCharacterEntry>(),
      byParty: new Map<string, number>(),
      lastUpdatedAtMs: Date.now(),
    };
    this.byMob.set(mobInstanceId, created);
    return created;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [mobId, row] of this.byMob) {
      if (now - row.lastUpdatedAtMs > TRACKER_TTL_MS) {
        this.byMob.delete(mobId);
      }
    }
  }
}
