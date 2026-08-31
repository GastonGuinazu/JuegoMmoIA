import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { MobAiState } from '@prisma/client';
import { Subject } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { MobCombatRegenService } from './mob-combat-regen.service';
import { WorldSpatialService } from '../world/world-spatial.service';
import { prismaMobZoneFilter } from '../world/world-zone.util';
import {
  assertSpawnSpotsSocialCoherence,
  loadMobsConfig,
  resolvePersistedMobMoveSpeed,
} from './mob-config.loaders';
import type { MobTemplateDefinition } from './mob-config.types';

export interface MobDeathEventPayload {
  mobInstanceId: string;
  mobTemplateKey: string;
  killerCharacterId: string;
  zoneId: string | null;
  occurredAt: Date;
}

@Injectable()
export class MobService implements OnModuleInit {
  private readonly logger = new Logger(MobService.name);
  private readonly mobDeathSubject = new Subject<MobDeathEventPayload>();

  readonly mobDeathEvents = this.mobDeathSubject.asObservable();

  constructor(
    private readonly prisma: PrismaService,
    private readonly spatial: WorldSpatialService,
    private readonly mobCombatRegen: MobCombatRegenService,
  ) {}

  async onModuleInit(): Promise<void> {
    assertSpawnSpotsSocialCoherence(loadMobsConfig());
    await this.syncMobTemplatesFromConfig();
  }

  private collectCatalogKeys(defs: MobTemplateDefinition[]): Set<string> {
    const keys = new Set<string>();
    for (const m of defs) {
      for (const it of m.dropTable.items ?? []) {
        keys.add(it.catalogKey);
      }
    }
    return keys;
  }

  private titleFromCatalogKey(key: string): string {
    return key
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  async ensureItemStubsForDrops(): Promise<void> {
    const cfg = loadMobsConfig();
    const keys = this.collectCatalogKeys(cfg.mobs);
    for (const key of keys) {
      await this.prisma.itemTemplate.upsert({
        where: { catalogKey: key },
        create: {
          name: this.titleFromCatalogKey(key),
          catalogKey: key,
          icon: '/icons/stub.png',
          baseStats: {},
        },
        update: {},
      });
    }
  }

  async syncMobTemplatesFromConfig(): Promise<void> {
    const cfg = loadMobsConfig();
    await this.ensureItemStubsForDrops();
    for (const m of cfg.mobs) {
      const expReward = m.baseExperience ?? m.expReward;
      const aggroRadius = m.aggroRadius ?? m.aggroRange ?? 10;
      if (typeof expReward !== 'number' || !Number.isFinite(expReward) || expReward < 0) {
        throw new Error(
          `Mob template "${m.templateKey}": baseExperience (or legacy expReward) must be a non-negative number`,
        );
      }
      if (
        typeof aggroRadius !== 'number' ||
        !Number.isFinite(aggroRadius) ||
        aggroRadius <= 0
      ) {
        throw new Error(
          `Mob template "${m.templateKey}": aggroRadius (or legacy aggroRange) must be a positive number`,
        );
      }
      await this.prisma.mobTemplate.upsert({
        where: { templateKey: m.templateKey },
        create: {
          templateKey: m.templateKey,
          displayName: m.displayName,
          maxHp: m.maxHp,
          pAtk: m.pAtk,
          pDef: m.pDef,
          mDef: m.mDef ?? 0,
          expReward: Math.floor(expReward),
          aggroRange: aggroRadius,
          moveSpeed: resolvePersistedMobMoveSpeed(m),
          attackRange: m.attackRange ?? 2.5,
          dropTable: m.dropTable as object,
        },
        update: {
          displayName: m.displayName,
          maxHp: m.maxHp,
          pAtk: m.pAtk,
          pDef: m.pDef,
          mDef: m.mDef ?? 0,
          expReward: Math.floor(expReward),
          aggroRange: aggroRadius,
          moveSpeed: resolvePersistedMobMoveSpeed(m),
          attackRange: m.attackRange ?? 2.5,
          dropTable: m.dropTable as object,
        },
      });
    }
    this.logger.log(
      `Mob templates synced (${cfg.mobs.length}) from config/mobs.json`,
    );
  }

  async spawnMob(
    templateKey: string,
    zoneId: string | null,
    pos: { x: number; y: number; z: number },
  ) {
    const t = await this.prisma.mobTemplate.findUnique({
      where: { templateKey },
    });
    if (!t) {
      throw new NotFoundException(`MobTemplate not found: ${templateKey}`);
    }
    const created = await this.prisma.mobInstance.create({
      data: {
        mobTemplateId: t.id,
        currentHp: t.maxHp,
        posX: pos.x,
        posY: pos.y,
        posZ: pos.z,
        spawnPosX: pos.x,
        spawnPosY: pos.y,
        spawnPosZ: pos.z,
        zoneId,
        isAlive: true,
      },
    });
    this.logger.log(
      `[Spawn] Mob ${created.id} at (${created.posX}, ${created.posY}, ${created.posZ}) spawn (${created.spawnPosX}, ${created.spawnPosY}, ${created.spawnPosZ}).`,
    );
    return created;
  }

  emitMobDeath(payload: MobDeathEventPayload): void {
    this.mobDeathSubject.next(payload);
  }

  /**
   * Percepción PvE: si el jugador entra en `aggroRange`, el mob pasa a CHASE con ese objetivo.
   * Suelta aggro si el jugador se aleja (histéresis 1.5×). El leash por spawn lo resuelve `MobAiTickService`.
   */
  async updateAggroForPlayerPosition(
    zoneId: string,
    characterId: string,
    playerPos: { x: number; y: number; z: number },
  ): Promise<void> {
    const where: Prisma.MobInstanceWhereInput = {
      isAlive: true,
      AND: [prismaMobZoneFilter(zoneId)],
    };

    const mobs = await this.prisma.mobInstance.findMany({
      where,
      include: { template: true },
    });

    const dropAggroMult = 1.5;

    for (const mob of mobs) {
      const mobPos = { x: mob.posX, y: mob.posY, z: mob.posZ };
      const dist = this.spatial.distance3d(mobPos, playerPos);
      const range = mob.template.aggroRange;

      if (mob.aggroTargetCharacterId === characterId) {
        if (dist > range * dropAggroMult) {
          if (this.mobCombatRegen.isHardCombatLocked(mob.id)) {
            continue;
          }
          await this.prisma.mobInstance.update({
            where: { id: mob.id },
            data: {
              aggroTargetCharacterId: null,
              aiState: MobAiState.IDLE,
            },
          });
        }
        continue;
      }

      if (dist <= range) {
        await this.prisma.mobInstance.update({
          where: { id: mob.id },
          data: {
            aggroTargetCharacterId: characterId,
            aiState: MobAiState.CHASE,
          },
        });
      }
    }
  }

  async clearAggroTargetingCharacter(characterId: string): Promise<void> {
    await this.prisma.mobInstance.updateMany({
      where: { aggroTargetCharacterId: characterId },
      data: { aggroTargetCharacterId: null, aiState: MobAiState.IDLE },
    });
  }
}
