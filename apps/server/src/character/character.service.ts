import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Character } from '@prisma/client';
import { CharacterClass, ItemInstanceLocation, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  loadWorldSpawnConfig,
  resolveRespawnTarget,
  type ResolvedRespawnTarget,
} from '../world/config/world-spawn.loaders';
import { normalizeZoneId } from '../world/world-zone.util';
import { loadCharacterClassesConfig, loadCharacterVitalsConfig } from './config/config-loaders';
import { loadExperienceCurveConfig } from './config/experience.loaders';
import type { EquippedRow } from './stat-engine.service';
import { StatEngineService } from './stat-engine.service';

/**
 * Un personaje está muerto cuando su HP autoritativo llegó a 0. Es el único predicado de
 * muerte del Warden: no existe flag paralelo que pueda desincronizarse del HP.
 */
export function isDeadHp(currentHp: number): boolean {
  return currentHp <= 0;
}

/**
 * Resultado del golpe mortal. El personaje **no se mueve**: queda en HP 0 en el punto de caída
 * hasta que el cliente envíe `REQUEST_RESPAWN`. `respawn` es solo el destino previsto.
 */
export interface PvEDeathResolution {
  experienceLost: number;
  newExperience: number;
  /** Punto de caída (el personaje sigue ahí mientras está muerto). */
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  /** Zona donde murió; sigue siendo su `currentZoneId`. */
  zoneId: string;
  /** Siempre 0. */
  currentHp: number;
  maxHp: number;
  /** Destino que se aplicará al resucitar (no aplicado todavía). */
  respawn: ResolvedRespawnTarget;
}

/** Resultado de la resurrección: ya aplicado en DB (zona incluida). */
export interface CharacterRespawnResolution {
  zoneId: string;
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  currentHp: number;
  maxHp: number;
  /** `true` si `currentZoneId` cambió respecto de la zona de muerte. */
  zoneChanged: boolean;
}

@Injectable()
export class CharacterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly statEngine: StatEngineService,
  ) {}

  /**
   * Creación autoritativa: DK / DW / Fairy Elf con puntos iniciales desde `config/character-classes.json`.
   */
  async createCharacter(
    accountId: string,
    name: string,
    characterClass: CharacterClass,
  ): Promise<Character> {
    const cfg = loadCharacterClassesConfig();
    const classKey = characterClass as string;
    const def = cfg.classes[classKey];
    if (!def) {
      throw new BadRequestException(`Invalid character class: ${characterClass}`);
    }

    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      throw new BadRequestException('Character name must be 2–24 characters');
    }

    try {
      const created = await this.prisma.character.create({
        data: {
          accountId,
          name: trimmed,
          characterClass,
          level: def.initialLevel,
          statStr: def.initialStats.str,
          statAgi: def.initialStats.agi,
          statVit: def.initialStats.vit,
          statEne: def.initialStats.ene,
        },
      });
      await this.statEngine.recalculateAndPersistCharacter(created.id);
      await this.initializeCurrentHpIfUnset(created.id);
      const ready = await this.prisma.character.findUnique({
        where: { id: created.id },
      });
      if (!ready) {
        throw new NotFoundException('Character missing after create');
      }
      return ready;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'A character with this name already exists on the account',
        );
      }
      throw e;
    }
  }

  /** Tras subir de nivel (puntos de stat sin asignar pueden añadirse en el Ledger después). */
  async applyLevelChange(characterId: string, newLevel: number): Promise<Character> {
    if (newLevel < 1 || newLevel > 400) {
      throw new BadRequestException('Level out of allowed range');
    }
    await this.prisma.character.update({
      where: { id: characterId },
      data: { level: newLevel },
    });
    return this.statEngine.recalculateAndPersistCharacter(characterId);
  }

  /**
   * GM local: fija nivel, reinicia EXP de la barra actual y ajusta `availableStatPoints`
   * con la misma regla que `addExperience` (`statPointsPerLevel` en experience-curve.json).
   */
  async gmSetLevelWithCoreGrants(
    characterId: string,
    targetLevel: number,
  ): Promise<{ character: Character; previousLevel: number }> {
    const cfg = loadExperienceCurveConfig();
    if (targetLevel < 1 || targetLevel > cfg.maxLevel) {
      throw new BadRequestException('Level out of allowed range');
    }
    const row = await this.prisma.character.findUnique({
      where: { id: characterId },
    });
    if (!row) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }
    const delta = targetLevel - row.level;
    const statPointsPerLevel = Math.max(0, cfg.statPointsPerLevel ?? 5);
    const pointsDelta = delta * statPointsPerLevel;
    let nextAvailable = row.availableStatPoints + pointsDelta;
    if (nextAvailable < 0) {
      nextAvailable = 0;
    }
    await this.prisma.character.update({
      where: { id: characterId },
      data: {
        level: targetLevel,
        experience: 0,
        availableStatPoints: nextAvailable,
      },
    });
    const character = await this.statEngine.recalculateAndPersistCharacter(characterId);
    return { character, previousLevel: row.level };
  }

  /**
   * Invalidación de caché de stats: equipar, desequipar, síntesis sobre pieza equipada, affix roll.
   * El Ledger debe llamar esto al cerrar la transacción de inventario.
   */
  async onEquipmentOrItemInstanceChanged(characterId: string): Promise<Character> {
    return this.statEngine.recalculateAndPersistCharacter(characterId);
  }

  async recalculateDerivedStats(
    characterId: string,
    db?: Pick<PrismaService, 'character'>,
  ): Promise<Character> {
    return this.statEngine.recalculateAndPersistCharacter(characterId, db);
  }

  /**
   * Experiencia PvE / quests; opcionalmente dentro de `tx` (misma transacción que muerte de mob + loot).
   */
  /**
   * Proyección pura de EXP/nivel (misma curva que `addExperience`) sin tocar DB.
   * Usada por el Warden para empaquetar kill optimista antes de emitir sockets.
   */
  projectExperienceGain(
    row: Pick<Character, 'level' | 'experience'>,
    amount: number,
  ): { level: number; experience: number; levelsGained: number } {
    if (amount < 0) {
      throw new BadRequestException('Experience amount cannot be negative');
    }
    const cfg = loadExperienceCurveConfig();
    if (amount === 0) {
      return { level: row.level, experience: row.experience, levelsGained: 0 };
    }
    let exp = row.experience + amount;
    let level = row.level;
    let levelsGained = 0;
    while (level < cfg.maxLevel) {
      const need = this.statEngine.experienceRequiredToAdvanceFromLevel(level);
      if (exp < need) {
        break;
      }
      exp -= need;
      level += 1;
      levelsGained += 1;
    }
    return { level, experience: exp, levelsGained };
  }

  async addExperience(
    characterId: string,
    amount: number,
    tx?: Prisma.TransactionClient,
  ): Promise<{ character: Character; levelsGained: number }> {
    if (amount < 0) {
      throw new BadRequestException('Experience amount cannot be negative');
    }

    const cfg = loadExperienceCurveConfig();
    const client = tx ?? this.prisma;

    const row = await client.character.findUnique({
      where: { id: characterId },
    });
    if (!row) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }

    if (amount === 0) {
      return { character: row, levelsGained: 0 };
    }

    let exp = row.experience + amount;
    let level = row.level;
    let levelsGained = 0;

    while (level < cfg.maxLevel) {
      const need = this.statEngine.experienceRequiredToAdvanceFromLevel(level);
      if (exp < need) {
        break;
      }
      exp -= need;
      level += 1;
      levelsGained += 1;
    }

    const statPointsPerLevel = Math.max(0, cfg.statPointsPerLevel ?? 5);
    await client.character.update({
      where: { id: characterId },
      data: {
        experience: exp,
        level,
        ...(levelsGained > 0
          ? {
              availableStatPoints: {
                increment: levelsGained * statPointsPerLevel,
              },
            }
          : {}),
      },
    });

    let character: Character;
    if (levelsGained > 0) {
      character = await this.statEngine.recalculateAndPersistCharacter(
        characterId,
        client as Pick<PrismaService, 'character'>,
        { fullHeal: true },
      );
    } else {
      const updated = await client.character.findUnique({
        where: { id: characterId },
      });
      character = updated as Character;
    }

    return { character, levelsGained };
  }

  async distributeStatPoints(
    characterId: string,
    statName: 'STR' | 'AGI' | 'VIT' | 'ENE',
    amount: number,
  ): Promise<Character> {
    const normalizedAmount = Math.floor(amount);
    if (normalizedAmount <= 0) {
      throw new BadRequestException('Amount must be a positive integer');
    }
    if (normalizedAmount > 500) {
      throw new BadRequestException('Amount is too large');
    }

    const statFieldByName = {
      STR: 'statStr',
      AGI: 'statAgi',
      VIT: 'statVit',
      ENE: 'statEne',
    } as const;
    const statField = statFieldByName[statName];

    return this.prisma.$transaction(
      async (tx) => {
        const updated = await tx.character.updateMany({
          where: {
            id: characterId,
            availableStatPoints: { gte: normalizedAmount },
          },
          data: {
            [statField]: { increment: normalizedAmount },
            availableStatPoints: { decrement: normalizedAmount },
          },
        });

        if (updated.count === 0) {
          const row = await tx.character.findUnique({
            where: { id: characterId },
            select: { id: true, availableStatPoints: true },
          });
          if (!row) {
            throw new NotFoundException(`Character not found: ${characterId}`);
          }
          throw new BadRequestException('Not enough available stat points');
        }

        return this.statEngine.recalculateAndPersistCharacter(characterId, tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Hidrata HP sólo en personajes que nunca entraron al mundo (`currentHp` 0 sin combate previo).
   * Un personaje **muerto** tiene `lastCombatAt` seteado por la transacción de muerte, así que
   * conserva su HP 0 y debe pasar por `REQUEST_RESPAWN`: conectarse no resucita.
   */
  async initializeCurrentHpIfUnset(characterId: string): Promise<{ dead: boolean }> {
    const row = await this.loadCharacterWithEquipped(characterId, this.prisma);
    if (!row) {
      return { dead: false };
    }
    if (!isDeadHp(row.currentHp)) {
      return { dead: false };
    }
    if (row.lastCombatAt) {
      return { dead: true };
    }
    const maxHp = this.statEngine.computeMaxHpForLoadedCharacter(
      row as Character & { items: EquippedRow[] },
    );
    await this.prisma.character.update({
      where: { id: characterId },
      data: { currentHp: maxHp },
    });
    return { dead: false };
  }

  /**
   * Regen pasiva fuera de combate (tick periódico del Warden).
   */
  async applyOutOfCombatRegenTick(
    characterId: string,
  ): Promise<{ currentHp: number; maxHp: number } | null> {
    const row = await this.loadCharacterWithEquipped(characterId, this.prisma);
    if (!row) {
      return null;
    }
    const typed = row as Character & { items: EquippedRow[] };
    const maxHp = this.statEngine.computeMaxHpForLoadedCharacter(typed);
    let cur = row.currentHp;
    // Un cadáver no regenera: sólo `REQUEST_RESPAWN` puede sacarlo de HP 0.
    if (isDeadHp(cur) || cur >= maxHp) {
      return null;
    }
    const vitCfg = loadCharacterVitalsConfig();
    const outMs = (vitCfg.outOfCombatSeconds ?? 8) * 1000;
    if (row.lastCombatAt) {
      if (Date.now() - row.lastCombatAt.getTime() < outMs) {
        return null;
      }
    }
    const evit = this.statEngine.getEffectiveVitality(typed);
    const basePct = vitCfg.regenBasePercentOfMaxHp ?? 0.35;
    const perVitPct = vitCfg.regenPerEffectiveVitPercentOfMaxHp ?? 0.12;
    const pctTotal = Math.min(28, basePct + perVitPct * evit);
    const heal = Math.max(1, Math.floor((maxHp * pctTotal) / 100));
    const next = Math.min(maxHp, cur + heal);
    if (next === cur) {
      return null;
    }
    await this.prisma.character.update({
      where: { id: characterId },
      data: { currentHp: next },
    });
    return { currentHp: next, maxHp };
  }

  /**
   * Golpe mortal (PvE o PvP): penalización de EXP y HP a 0 **sin mover al personaje**.
   * Debe ejecutarse dentro de la misma transacción que el golpe. La reposición ocurre
   * después, sólo cuando el cliente pide `REQUEST_RESPAWN` (ver `respawnCharacterInTx`).
   */
  async applyPvEDeathInTx(
    tx: Prisma.TransactionClient,
    characterId: string,
  ): Promise<PvEDeathResolution> {
    const row = await this.loadCharacterWithEquipped(characterId, tx);
    if (!row) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }
    const typed = row as Character & { items: EquippedRow[] };
    const maxHp = this.statEngine.computeMaxHpForLoadedCharacter(typed);

    const expCfg = loadExperienceCurveConfig();
    const lossPct = expCfg.deathExperienceLossPercent ?? 8;
    const expLost = Math.floor(row.experience * (lossPct / 100));
    const newExp = Math.max(0, row.experience - expLost);

    await tx.mobInstance.updateMany({
      where: { aggroTargetCharacterId: characterId },
      data: { aggroTargetCharacterId: null },
    });

    await tx.character.update({
      where: { id: characterId },
      data: {
        experience: newExp,
        currentHp: 0,
        lastCombatAt: new Date(),
      },
    });

    return {
      experienceLost: expLost,
      newExperience: newExp,
      worldPos: { x: row.worldPosX, y: row.worldPosY, z: row.worldPosZ },
      worldFacingYaw: row.worldFacingYaw,
      zoneId: normalizeZoneId(row.currentZoneId),
      currentHp: 0,
      maxHp,
      respawn: resolveRespawnTarget(row.currentZoneId),
    };
  }

  /**
   * Resurrección autoritativa. Migra `currentZoneId` **y** posición al `entrySpawn` de la zona
   * destino en la misma escritura: es la garantía de que zona y coordenadas nunca divergen.
   */
  async respawnCharacterInTx(
    tx: Prisma.TransactionClient,
    characterId: string,
  ): Promise<CharacterRespawnResolution> {
    const row = await this.loadCharacterWithEquipped(characterId, tx);
    if (!row) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }
    if (!isDeadHp(row.currentHp)) {
      throw new BadRequestException({
        code: 'CHARACTER_NOT_DEAD',
        message: 'Character is alive; respawn is not allowed',
      });
    }

    const typed = row as Character & { items: EquippedRow[] };
    const maxHp = this.statEngine.computeMaxHpForLoadedCharacter(typed);
    const policy = loadWorldSpawnConfig().deathRespawn;
    const respawnHp = Math.min(
      maxHp,
      Math.max(1, Math.floor(maxHp * policy.hpPercentOfMax)),
    );

    const deathZoneId = normalizeZoneId(row.currentZoneId);
    const target = resolveRespawnTarget(row.currentZoneId);

    await tx.character.update({
      where: { id: characterId },
      data: {
        currentZoneId: target.zoneId,
        currentHp: respawnHp,
        worldPosX: target.worldPos.x,
        worldPosY: target.worldPos.y,
        worldPosZ: target.worldPos.z,
        worldFacingYaw: target.worldFacingYaw,
      },
    });

    return {
      zoneId: target.zoneId,
      worldPos: { ...target.worldPos },
      worldFacingYaw: target.worldFacingYaw,
      currentHp: respawnHp,
      maxHp,
      zoneChanged: target.zoneId !== deathZoneId,
    };
  }

  private loadCharacterWithEquipped(
    characterId: string,
    client: Pick<PrismaService, 'character'> | Prisma.TransactionClient,
  ) {
    return client.character.findUnique({
      where: { id: characterId },
      include: {
        items: {
          where: { location: ItemInstanceLocation.EQUIPPED },
          include: { template: true },
        },
      },
    });
  }
}
