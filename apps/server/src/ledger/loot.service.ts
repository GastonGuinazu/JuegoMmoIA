import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ItemInstanceLocation, Prisma } from '@prisma/client';
import type { MobDropTable } from '../mob/mob-config.types';
import type { WsWorldDropSpawnPayload } from '@aetheris/shared-types';
import { parseItemGradeFromBaseStats } from '../items/item-grade.util';
import type { ItemGrade } from '../items/items-config.types';

export interface MobLootResult {
  adenaGranted: bigint;
  itemInstanceIds: string[];
  worldDropSpawns: WsWorldDropSpawnPayload[];
}

export interface PlayerPkDropContext {
  zoneId: string | null;
  basePos: { x: number; y: number; z: number };
}

export interface MobWorldDropContext {
  /** Misma convención que `MobInstance.zoneId` (null = default). */
  zoneId: string | null;
  basePos: { x: number; y: number; z: number };
  reservedForCharacterId: string;
  reserveDurationMs: number;
}

function rollInclusive(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function asDropTable(raw: unknown): MobDropTable {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return raw as MobDropTable;
}

export type ItemTemplateDropRoll = {
  id: string;
  catalogKey: string | null;
  name: string;
  icon: string;
  grade: ItemGrade;
};

export type MobDropPreviewRow = {
  catalogKey: string;
  itemDisplayName: string;
  icon: string;
  grade: ItemGrade;
  chance: number;
};

/** Fila ya sorteada + UUID reservado antes del INSERT en Prisma. */
export type PlannedWorldDropRow = {
  itemInstanceId: string;
  itemTemplateId: string;
  quantity: number;
  worldDropZoneId: string | null;
  worldDropPosX: number;
  worldDropPosY: number;
  worldDropPosZ: number;
  worldDropReservedForCharacterId: string;
  worldDropReservedUntil: Date;
  spawnPayload: WsWorldDropSpawnPayload;
};

export type RuntimeMobKillLootPlan = {
  adenaGranted: bigint;
  worldDrops: PlannedWorldDropRow[];
};

export function collectDropCatalogKeysFromMobTable(dropTable: unknown): string[] {
  const table = asDropTable(dropTable);
  const keys = new Set<string>();
  for (const it of table.items ?? []) {
    keys.add(it.catalogKey);
  }
  return [...keys];
}

export function buildMobDropPreviewRows(params: {
  dropTable: unknown;
  templatesByCatalog: ReadonlyMap<string, ItemTemplateDropRoll>;
  levelPenaltyActive: boolean;
}): MobDropPreviewRow[] {
  if (params.levelPenaltyActive) {
    return [];
  }
  const table = asDropTable(params.dropTable);
  const rows: MobDropPreviewRow[] = [];
  for (const entry of table.items ?? []) {
    const tpl = params.templatesByCatalog.get(entry.catalogKey);
    if (!tpl) {
      continue;
    }
    rows.push({
      catalogKey: entry.catalogKey,
      itemDisplayName: tpl.name,
      icon: tpl.icon,
      grade: tpl.grade,
      chance: entry.chance,
    });
  }
  return rows;
}

@Injectable()
export class LedgerLootService {
  /**
   * Entrega Adena (Wallet). Los ítems rolados van al inventario **o** al suelo (WORLD_DROP)
   * si se pasa `worldDrop`.
   */
  async applyMobDropTable(
    tx: Prisma.TransactionClient,
    params: {
      accountId: string;
      characterId: string;
      dropTable: unknown;
      rng?: () => number;
      worldDrop?: MobWorldDropContext;
      /** Cámara de mazmorra (Oro/Drop/Exp): 1 fuera de mazmorra. */
      adenaMultiplier?: number;
      dropChanceMultiplier?: number;
    },
  ): Promise<MobLootResult> {
    const rng = params.rng ?? Math.random;
    const table = asDropTable(params.dropTable);
    const adenaMultiplier = params.adenaMultiplier ?? 1;
    const dropChanceMultiplier = params.dropChanceMultiplier ?? 1;
    let adenaTotal = 0n;
    const itemInstanceIds: string[] = [];
    const worldDropSpawns: WsWorldDropSpawnPayload[] = [];

    for (const roll of table.adenaRolls ?? []) {
      if (rng() <= roll.chance) {
        adenaTotal += BigInt(rollInclusive(rng, roll.min, roll.max));
      }
    }
    if (adenaMultiplier !== 1) {
      adenaTotal = BigInt(Math.round(Number(adenaTotal) * adenaMultiplier));
    }

    if (adenaTotal > 0n) {
      await tx.wallet.upsert({
        where: { accountId: params.accountId },
        create: { accountId: params.accountId, adena: adenaTotal },
        update: { adena: { increment: adenaTotal } },
      });
    }

    const entries = table.items ?? [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const effectiveChance = Math.min(1, entry.chance * dropChanceMultiplier);
      if (rng() > effectiveChance) {
        continue;
      }
      const qty = rollInclusive(rng, entry.minQty, entry.maxQty);
      if (qty <= 0) {
        continue;
      }

      const tpl = await tx.itemTemplate.findUnique({
        where: { catalogKey: entry.catalogKey },
      });
      if (!tpl) {
        throw new NotFoundException(
          `Drop catalogKey not found (sync item stubs): ${entry.catalogKey}`,
        );
      }

      if (params.worldDrop) {
        const angle = i * 1.9 + rng() * 0.45;
        const rad = 0.26 + i * 0.11;
        const dx = Math.cos(angle) * rad;
        const dz = Math.sin(angle) * rad;
        const wx = params.worldDrop.basePos.x + dx;
        const wy = params.worldDrop.basePos.y;
        const wz = params.worldDrop.basePos.z + dz;
        const reservedUntil = new Date(Date.now() + params.worldDrop.reserveDurationMs);

        const created = await tx.itemInstance.create({
          data: {
            ownerId: params.worldDrop.reservedForCharacterId,
            itemTemplateId: tpl.id,
            quantity: qty,
            location: ItemInstanceLocation.WORLD_DROP,
            worldDropZoneId: params.worldDrop.zoneId,
            worldDropPosX: wx,
            worldDropPosY: wy,
            worldDropPosZ: wz,
            worldDropReservedForCharacterId: params.worldDrop.reservedForCharacterId,
            worldDropReservedUntil: reservedUntil,
          },
        });
        itemInstanceIds.push(created.id);
        worldDropSpawns.push({
          itemInstanceId: created.id,
          catalogKey: tpl.catalogKey,
          itemDisplayName: tpl.name,
          icon: tpl.icon,
          grade: parseItemGradeFromBaseStats(tpl.baseStats),
          quantity: qty,
          pos: { x: wx, y: wy, z: wz },
          reservedForCharacterId: params.worldDrop.reservedForCharacterId,
          reservedUntilEpochMs: reservedUntil.getTime(),
        });
        continue;
      }

      const stack = await tx.itemInstance.findFirst({
        where: {
          ownerId: params.characterId,
          itemTemplateId: tpl.id,
          location: ItemInstanceLocation.INVENTORY,
        },
      });

      if (stack) {
        const updated = await tx.itemInstance.update({
          where: { id: stack.id },
          data: {
            quantity: { increment: qty },
            rowVersion: { increment: 1 },
          },
        });
        itemInstanceIds.push(updated.id);
      } else {
        const created = await tx.itemInstance.create({
          data: {
            ownerId: params.characterId,
            itemTemplateId: tpl.id,
            quantity: qty,
            location: ItemInstanceLocation.INVENTORY,
          },
        });
        itemInstanceIds.push(created.id);
      }
    }

    return { adenaGranted: adenaTotal, itemInstanceIds, worldDropSpawns };
  }

  /**
   * Sorteo de loot solo en RAM (mismas fórmulas que `applyMobDropTable` con `worldDrop`).
   * Los UUID de instancia se reservan aquí y deben reutilizarse en la transacción Prisma.
   */
  buildRuntimeMobKillLootPlan(params: {
    dropTable: unknown;
    rng: () => number;
    worldDrop: MobWorldDropContext;
    templatesByCatalog: ReadonlyMap<string, ItemTemplateDropRoll>;
    /** Cámara de mazmorra (Oro/Drop/Exp): 1 fuera de mazmorra. */
    adenaMultiplier?: number;
    dropChanceMultiplier?: number;
  }): RuntimeMobKillLootPlan {
    const rng = params.rng;
    const table = asDropTable(params.dropTable);
    const adenaMultiplier = params.adenaMultiplier ?? 1;
    const dropChanceMultiplier = params.dropChanceMultiplier ?? 1;
    let adenaTotal = 0n;
    const worldDrops: PlannedWorldDropRow[] = [];

    for (const roll of table.adenaRolls ?? []) {
      if (rng() <= roll.chance) {
        adenaTotal += BigInt(rollInclusive(rng, roll.min, roll.max));
      }
    }
    if (adenaMultiplier !== 1) {
      adenaTotal = BigInt(Math.round(Number(adenaTotal) * adenaMultiplier));
    }

    const entries = table.items ?? [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const effectiveChance = Math.min(1, entry.chance * dropChanceMultiplier);
      if (rng() > effectiveChance) {
        continue;
      }
      const qty = rollInclusive(rng, entry.minQty, entry.maxQty);
      if (qty <= 0) {
        continue;
      }

      const tpl = params.templatesByCatalog.get(entry.catalogKey);
      if (!tpl) {
        throw new NotFoundException(
          `Drop catalogKey not found (sync item stubs): ${entry.catalogKey}`,
        );
      }

      const angle = i * 1.9 + rng() * 0.45;
      const rad = 0.26 + i * 0.11;
      const dx = Math.cos(angle) * rad;
      const dz = Math.sin(angle) * rad;
      const wx = params.worldDrop.basePos.x + dx;
      const wy = params.worldDrop.basePos.y;
      const wz = params.worldDrop.basePos.z + dz;
      const reservedUntil = new Date(Date.now() + params.worldDrop.reserveDurationMs);
      const itemInstanceId = randomUUID();

      worldDrops.push({
        itemInstanceId,
        itemTemplateId: tpl.id,
        quantity: qty,
        worldDropZoneId: params.worldDrop.zoneId,
        worldDropPosX: wx,
        worldDropPosY: wy,
        worldDropPosZ: wz,
        worldDropReservedForCharacterId: params.worldDrop.reservedForCharacterId,
        worldDropReservedUntil: reservedUntil,
        spawnPayload: {
          itemInstanceId,
          catalogKey: tpl.catalogKey,
          itemDisplayName: tpl.name,
          icon: tpl.icon,
          grade: tpl.grade,
          quantity: qty,
          pos: { x: wx, y: wy, z: wz },
          reservedForCharacterId: params.worldDrop.reservedForCharacterId,
          reservedUntilEpochMs: reservedUntil.getTime(),
        },
      });
    }

    return { adenaGranted: adenaTotal, worldDrops };
  }

  async applyRuntimeMobKillLootPlan(
    tx: Prisma.TransactionClient,
    params: {
      accountId: string;
      plan: RuntimeMobKillLootPlan;
    },
  ): Promise<MobLootResult> {
    const { plan } = params;
    if (plan.adenaGranted > 0n) {
      await tx.wallet.upsert({
        where: { accountId: params.accountId },
        create: { accountId: params.accountId, adena: plan.adenaGranted },
        update: { adena: { increment: plan.adenaGranted } },
      });
    }

    const itemInstanceIds: string[] = [];
    const worldDropSpawns: WsWorldDropSpawnPayload[] = [];

    for (const row of plan.worldDrops) {
      await tx.itemInstance.create({
        data: {
          id: row.itemInstanceId,
          ownerId: row.worldDropReservedForCharacterId,
          itemTemplateId: row.itemTemplateId,
          quantity: row.quantity,
          location: ItemInstanceLocation.WORLD_DROP,
          worldDropZoneId: row.worldDropZoneId,
          worldDropPosX: row.worldDropPosX,
          worldDropPosY: row.worldDropPosY,
          worldDropPosZ: row.worldDropPosZ,
          worldDropReservedForCharacterId: row.worldDropReservedForCharacterId,
          worldDropReservedUntil: row.worldDropReservedUntil,
        },
      });
      itemInstanceIds.push(row.itemInstanceId);
      worldDropSpawns.push(row.spawnPayload);
    }

    return { adenaGranted: plan.adenaGranted, itemInstanceIds, worldDropSpawns };
  }

  async dropEquippedItemForPkDeath(
    tx: Prisma.TransactionClient,
    params: {
      itemInstanceId: string;
      context: PlayerPkDropContext;
      rng?: () => number;
    },
  ): Promise<WsWorldDropSpawnPayload> {
    const rng = params.rng ?? Math.random;
    const item = await tx.itemInstance.findUnique({
      where: { id: params.itemInstanceId },
      include: { template: true },
    });
    if (!item || item.location !== ItemInstanceLocation.EQUIPPED) {
      throw new NotFoundException(
        `Equipped item not found for PK drop: ${params.itemInstanceId}`,
      );
    }
    const angle = rng() * Math.PI * 2;
    const radius = 0.45 + rng() * 0.3;
    const worldDropPosX = params.context.basePos.x + Math.cos(angle) * radius;
    const worldDropPosY = params.context.basePos.y;
    const worldDropPosZ = params.context.basePos.z + Math.sin(angle) * radius;

    await tx.itemInstance.update({
      where: { id: item.id },
      data: {
        location: ItemInstanceLocation.WORLD_DROP,
        gearSlot: null,
        parentItemInstanceId: null,
        parentSubSlotIndex: null,
        worldDropZoneId: params.context.zoneId,
        worldDropPosX,
        worldDropPosY,
        worldDropPosZ,
        worldDropReservedForCharacterId: null,
        worldDropReservedUntil: null,
        rowVersion: { increment: 1 },
      },
    });

    return {
      itemInstanceId: item.id,
      catalogKey: item.template.catalogKey,
      itemDisplayName: item.template.name,
      icon: item.template.icon,
      grade: parseItemGradeFromBaseStats(item.template.baseStats),
      quantity: item.quantity,
      pos: { x: worldDropPosX, y: worldDropPosY, z: worldDropPosZ },
      reservedForCharacterId: null,
      reservedUntilEpochMs: null,
    };
  }
}
