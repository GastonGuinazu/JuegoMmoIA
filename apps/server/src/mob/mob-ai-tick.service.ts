import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MobAiState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WS_WORLD_EVENTS, type WsMobMovedPayload } from '@aetheris/shared-types';
import { WorldSocketBridgeService } from '../world/world-socket-bridge.service';
import { WorldSpatialService } from '../world/world-spatial.service';
import { PlayerCombatRuntimeService } from '../combat/player-combat-runtime.service';
import { MobCombatRegenService } from './mob-combat-regen.service';
import {
  getSocialFamilyForTemplateKey,
  getSocialLinkRadiusForTemplateKey,
  resolveMobAiMoveSpeed,
} from './mob-config.loaders';
import { normalizeZoneId } from '../world/world-zone.util';
import { clampAxisToPlayable } from '../world/config/world-zones.loaders';

const TICK_MS = 50;
/** Tope de dt de movimiento si el tick de IA se atrasó (evita tunelizar obstáculos). */
const MAX_AI_MOVE_DT_SEC = 0.1;
/** Tras daño al mob: sin curación OOC completa durante esta ventana (separación IA / combate). */
const MOB_OOC_HEAL_POST_DAMAGE_MS = 15_000;
/** Tras reset por leash: paz total mínima antes de permitir curar al llegar a spawn. */
const MOB_POST_LEASH_RESET_PEACE_MS = 10_000;
/** Con daño reciente al mob: sin leash-reset / RETURNING_HOME (combate manda). */
const MOB_LEASH_RESET_DAMAGE_LOCK_MS = 20_000;
const PATROL_RADIUS_MIN = 2.5;
const PATROL_RADIUS_MAX = 7;
const ARRIVE_EPS_XZ = 0.38;
const IDLE_MS_MIN = 1600;
const IDLE_MS_MAX = 4200;
const CHASE_STUCK_RESET_MS = 3_000;
const MOVE_PROGRESS_EPS_XZ = 0.06;
const DAMAGE_SIGNAL_WINDOW_MS = 1_600;
const CHASE_PATH_REBUILD_MS = 350;
const CHASE_PATH_TARGET_DELTA_REBUILD_XZ = 1.25;
const CHASE_WAYPOINT_REACHED_XZ = 0.75;

type PatrolKind = 'wander' | 'home';
type ChasePathCacheEntry = {
  targetCharacterId: string;
  builtAtMs: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  waypoints: Array<{ x: number; y: number; z: number }>;
};

type ZoneMobGridIndex = Map<string, MobTickRow[]>;

type MobTickRow = {
  id: string;
  mobTemplateId: string;
  zoneId: string | null;
  posX: number;
  posY: number;
  posZ: number;
  spawnPosX: number;
  spawnPosY: number;
  spawnPosZ: number;
  worldFacingYaw: number;
  /** Solo existe en la fila Prisma; la IA no usa este campo para lógica (HP = RAM). */
  currentHp: number;
  aggroTargetCharacterId: string | null;
  aiState: MobAiState;
  template: {
    maxHp: number;
    aggroRange: number;
    moveSpeed: number;
    templateKey: string;
    pDef: number;
    mDef: number;
    attackRange: number;
    expReward: number;
    dropTable: unknown;
  };
};

/**
 * The Warden: tick de IA y movimiento de mobs (20 TPS). Posición y estados 100 % servidor.
 */
@Injectable()
export class MobAiTickService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MobAiTickService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Evita solapar ticks: a 20 Hz el tick anterior suele seguir en curso (N updates Prisma),
   * lo que agota el pool (P2024) y tumba el proceso — sin snapshot / mobs en cliente.
   */
  private tickInFlight = false;
  /** Reloj del último tick de IA ejecutado (para dt real si el intervalo se saltó). */
  private lastAiTickAtMs = 0;
  /** Pose viva: la DB no es el bus de movimiento (un UPDATE por mob/tick tumba el 20 TPS). */
  private readonly livePose = new Map<
    string,
    { posX: number; posY: number; posZ: number; yaw: number }
  >();
  private readonly poseDirty = new Set<string>();
  private poseFlushTimer: ReturnType<typeof setInterval> | undefined;
  /** Próximo instante (epoch ms) en que un mob en IDLE pasa a PATROL. */
  private readonly idlePatrolAfterMs = new Map<string, number>();
  /** Destino XZ de patrulla o retorno al spawn. */
  private readonly patrolDestXz = new Map<string, { x: number; z: number }>();
  private readonly patrolKind = new Map<string, PatrolKind>();
  /** Tras snap bajo hard lock: earliest ms para permitir IDLE en spawn sin curar. */
  private readonly mobSpawnCalmGateAtMs = new Map<string, number>();
  private readonly spawnAnchorWarned = new Set<string>();
  /** Reset por leash: bloquea curación OOC hasta spawn + paz extendida. */
  private readonly mobLeashResetHealBlocked = new Set<string>();
  /** Primer ms donde CHASE quedó sin avance efectivo por colisión de mundo. */
  private readonly chaseBlockedSinceMs = new Map<string, number>();
  private readonly spawnObstacleWarned = new Set<string>();
  /** Daño procesado más reciente por mob para no reemitir Social Link cada tick. */
  private readonly damageSignalProcessedAtMs = new Map<string, number>();
  /** Path CHASE cacheado por mob para evitar A* cada tick. */
  private readonly chasePathCache = new Map<string, ChasePathCacheEntry>();
  private readonly aiCollisionDebug =
    (process.env.AETHERIS_AI_COLLISION_DEBUG ?? '').toLowerCase() === 'true' ||
    process.env.AETHERIS_AI_COLLISION_DEBUG === '1';

  constructor(
    private readonly prisma: PrismaService,
    private readonly spatial: WorldSpatialService,
    private readonly bridge: WorldSocketBridgeService,
    private readonly playerCombatRuntime: PlayerCombatRuntimeService,
    private readonly mobCombatRegen: MobCombatRegenService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.poseFlushTimer = setInterval(() => {
      void this.flushDirtyLivePoses();
    }, 2000);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.poseFlushTimer) {
      clearInterval(this.poseFlushTimer);
    }
    void this.flushDirtyLivePoses();
  }

  private zoneKey(zoneId: string | null | undefined): string {
    return normalizeZoneId(zoneId);
  }

  private isSpawnAnchorDegenerate(m: MobTickRow): boolean {
    return Math.abs(m.spawnPosX) < 1e-3 && Math.abs(m.spawnPosZ) < 1e-3;
  }

  /** Ancla XZ para leash / wander: `MobInstance.spawnPos*` o posición viva si el spawn persistido es (0,0). */
  private spawnAnchorXZ(m: MobTickRow): { x: number; z: number } {
    if (this.isSpawnAnchorDegenerate(m)) {
      if (!this.spawnAnchorWarned.has(m.id)) {
        this.spawnAnchorWarned.add(m.id);
        this.logger.warn(
          `[AI] Mob ${m.id}: spawnPos XZ near (0,0); using live position as leash anchor until DB spawn is corrected.`,
        );
      }
      return { x: m.posX, z: m.posZ };
    }
    return { x: m.spawnPosX, z: m.spawnPosZ };
  }

  /** Posición de “casa” para snap vertical y destinos Y (corrige spawn Y nulo). */
  private spawnWorldPos(m: MobTickRow): { x: number; y: number; z: number } {
    if (this.isSpawnAnchorDegenerate(m)) {
      return { x: m.posX, y: m.posY, z: m.posZ };
    }
    return { x: m.spawnPosX, y: m.spawnPosY, z: m.spawnPosZ };
  }

  private resolveSpawnWorldPosAgainstObstacles(
    m: MobTickRow,
    zoneId: string,
  ): { x: number; y: number; z: number } {
    const rawSpawn = this.spawnWorldPos(m);
    const safeSpawn = this.spatial.resolvePointOutsideObstacles({
      point: rawSpawn,
      zoneId,
    });
    if (safeSpawn.blocked && this.aiCollisionDebug && !this.spawnObstacleWarned.has(m.id)) {
      this.spawnObstacleWarned.add(m.id);
      this.logger.debug(
        `[AI Collision] Mob ${m.id} hit obstacle at ${this.formatPos(rawSpawn)} (spawn anchor corrected).`,
      );
    }
    return safeSpawn.corrected;
  }

  private leashDistanceXZ(m: MobTickRow, posX: number, posZ: number): number {
    const a = this.spawnAnchorXZ(m);
    return Math.hypot(posX - a.x, posZ - a.z);
  }

  private scheduleIdlePatrol(mobId: string): void {
    const delay =
      IDLE_MS_MIN + Math.floor(Math.random() * (IDLE_MS_MAX - IDLE_MS_MIN));
    this.idlePatrolAfterMs.set(mobId, Date.now() + delay);
  }

  private pickWanderPatrolDest(m: MobTickRow): { x: number; z: number } {
    const angle = Math.random() * Math.PI * 2;
    const rad =
      PATROL_RADIUS_MIN +
      Math.random() * (PATROL_RADIUS_MAX - PATROL_RADIUS_MIN);
    const a = this.spawnAnchorXZ(m);
    return {
      x: a.x + Math.cos(angle) * rad,
      z: a.z + Math.sin(angle) * rad,
    };
  }

  private stepToward(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    speed: number,
    dt: number,
    fallbackYaw: number,
  ): { x: number; y: number; z: number; yaw: number } {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lenXZ = Math.hypot(dx, dz);
    if (lenXZ < 1e-5) {
      return { x: from.x, y: from.y, z: from.z, yaw: fallbackYaw };
    }
    const travel = Math.min(speed * dt, lenXZ);
    const nx = dx / lenXZ;
    const nz = dz / lenXZ;
    const yaw = Math.atan2(nx, nz);
    const dy = to.y - from.y;
    const yBlend = Math.min(1, travel / Math.max(lenXZ, 0.01));
    return {
      x: from.x + nx * travel,
      y: from.y + dy * yBlend * 0.35,
      z: from.z + nz * travel,
      yaw,
    };
  }

  private distXZ(
    a: { x: number; z: number },
    b: { x: number; z: number },
  ): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  private clearChaseBlocked(mobId: string): void {
    this.chaseBlockedSinceMs.delete(mobId);
  }

  private clearChaseNavigationCache(mobId: string): void {
    this.chasePathCache.delete(mobId);
  }

  private canProcessDamageSignal(mobId: string, atMs: number): boolean {
    const last = this.damageSignalProcessedAtMs.get(mobId) ?? 0;
    if (atMs <= last) {
      return false;
    }
    this.damageSignalProcessedAtMs.set(mobId, atMs);
    return true;
  }

  private getChaseWaypointFromNavGrid(params: {
    mob: MobTickRow;
    mobPos: { x: number; y: number; z: number };
    target: { id: string; x: number; y: number; z: number };
    nowMs: number;
    zoneId: string;
  }): { x: number; y: number; z: number } {
    const { mob, mobPos, target, nowMs, zoneId } = params;
    const cached = this.chasePathCache.get(mob.id);
    const targetDelta = cached
      ? this.distXZ(
          { x: cached.targetX, z: cached.targetZ },
          { x: target.x, z: target.z },
        )
      : Number.POSITIVE_INFINITY;
    const shouldRebuild =
      !cached ||
      cached.targetCharacterId !== target.id ||
      nowMs - cached.builtAtMs >= CHASE_PATH_REBUILD_MS ||
      targetDelta >= CHASE_PATH_TARGET_DELTA_REBUILD_XZ ||
      cached.waypoints.length === 0;
    if (shouldRebuild) {
      const waypoints = this.spatial.findPathOnNavGrid({
        zoneId,
        from: mobPos,
        to: { x: target.x, y: target.y, z: target.z },
      });
      this.chasePathCache.set(mob.id, {
        targetCharacterId: target.id,
        builtAtMs: nowMs,
        targetX: target.x,
        targetY: target.y,
        targetZ: target.z,
        waypoints,
      });
    }
    const entry = this.chasePathCache.get(mob.id);
    if (!entry || entry.waypoints.length === 0) {
      return { x: target.x, y: target.y, z: target.z };
    }
    while (entry.waypoints.length > 1) {
      const first = entry.waypoints[0]!;
      if (
        this.distXZ(
          { x: mobPos.x, z: mobPos.z },
          { x: first.x, z: first.z },
        ) > CHASE_WAYPOINT_REACHED_XZ
      ) {
        break;
      }
      entry.waypoints.shift();
    }
    return entry.waypoints[0] ?? { x: target.x, y: target.y, z: target.z };
  }

  private formatPos(pos: { x: number; y: number; z: number }): string {
    return `(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`;
  }

  private stableAngleFromId(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i += 1) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
  }

  /**
   * Punto de hold alrededor del jugador para que el pack no camine todos al mismo XZ.
   */
  private resolveChaseHoldPoint(
    mob: MobTickRow,
    target: { id: string; x: number; y: number; z: number },
    zoneMobs: MobTickRow[],
  ): { x: number; y: number; z: number } {
    const bodyR = this.spatial.getMobBodyRadiusMeters();
    const ringFactor = this.spatial.getMobChaseRingFactor();
    const pack = zoneMobs.filter(
      (other) => other.id === mob.id || other.aggroTargetCharacterId === target.id,
    );
    const ids = [...new Set(pack.map((other) => other.id))].sort();
    const n = Math.max(1, ids.length);
    const index = Math.max(0, ids.indexOf(mob.id));
    const minRing = Math.max(mob.template.attackRange * ringFactor, bodyR * 2.1);
    const packRing = n > 1 ? (n * 2 * bodyR) / (Math.PI * 2) : minRing;
    const ring = Math.max(minRing, packRing);
    const angle = (index / n) * Math.PI * 2;
    return {
      x: target.x + Math.sin(angle) * ring,
      y: target.y,
      z: target.z + Math.cos(angle) * ring,
    };
  }

  /** Empuje XZ para no ocupar el mismo cuerpo que otro mob vivo de la zona. */
  private separateFromNearbyMobs(
    mobId: string,
    pos: { x: number; y: number; z: number },
    zoneMobs: MobTickRow[],
  ): { x: number; y: number; z: number } {
    const minDist = this.spatial.getMobBodyRadiusMeters() * 2;
    let x = pos.x;
    let z = pos.z;
    for (const other of zoneMobs) {
      if (other.id === mobId) {
        continue;
      }
      const dx = x - other.posX;
      const dz = z - other.posZ;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-4) {
        const angle = this.stableAngleFromId(mobId);
        x += Math.sin(angle) * minDist * 0.4;
        z += Math.cos(angle) * minDist * 0.4;
        continue;
      }
      if (dist >= minDist) {
        continue;
      }
      const push = (minDist - dist) * 0.6;
      x += (dx / dist) * push;
      z += (dz / dist) * push;
    }
    return { x, y: pos.y, z };
  }

  private applySeparatedPose(params: {
    mobId: string;
    from: { x: number; y: number; z: number };
    desired: { x: number; y: number; z: number };
    zoneId: string;
    zoneMobs: MobTickRow[];
    fallbackYaw: number;
    allowSlide: boolean;
  }): { x: number; y: number; z: number; yaw: number; movedXZ: number; blocked: boolean } {
    const moved = this.resolveMobMoveAgainstWorld({
      mobId: params.mobId,
      from: params.from,
      desired: params.desired,
      zoneId: params.zoneId,
      fallbackYaw: params.fallbackYaw,
      allowSlide: params.allowSlide,
    });
    const separated = this.separateFromNearbyMobs(params.mobId, moved, params.zoneMobs);
    const peel = this.distXZ(
      { x: moved.x, z: moved.z },
      { x: separated.x, z: separated.z },
    );
    if (peel < 1e-4) {
      return moved;
    }
    const nudged = this.resolveMobMoveAgainstWorld({
      mobId: params.mobId,
      from: { x: moved.x, y: moved.y, z: moved.z },
      desired: separated,
      zoneId: params.zoneId,
      fallbackYaw: moved.yaw,
      allowSlide: true,
    });
    return {
      ...nudged,
      yaw: moved.yaw,
      movedXZ: moved.movedXZ,
      blocked: moved.blocked,
    };
  }

  private commitTickRowPose(
    mob: MobTickRow,
    next: { posX: number; posY: number; posZ: number; yaw: number },
  ): void {
    mob.posX = next.posX;
    mob.posY = next.posY;
    mob.posZ = next.posZ;
    mob.worldFacingYaw = next.yaw;
  }

  private setLivePose(
    mobId: string,
    next: { posX: number; posY: number; posZ: number; yaw: number },
    dirty: boolean,
  ): void {
    this.livePose.set(mobId, {
      posX: next.posX,
      posY: next.posY,
      posZ: next.posZ,
      yaw: next.yaw,
    });
    if (dirty) {
      this.poseDirty.add(mobId);
    } else {
      this.poseDirty.delete(mobId);
    }
  }

  /** Movimiento de tick: RAM + socket. Persistencia diferida (`flushDirtyLivePoses`). */
  private commitLiveMovement(
    mob: MobTickRow,
    next: { posX: number; posY: number; posZ: number; yaw: number },
  ): void {
    next.posX = clampAxisToPlayable(mob.zoneId, next.posX);
    next.posZ = clampAxisToPlayable(mob.zoneId, next.posZ);
    this.setLivePose(mob.id, next, true);
    this.refreshRamPoseAfterDbMove(mob, next);
    this.commitTickRowPose(mob, next);
  }

  private applyLivePoses(mobs: MobTickRow[]): void {
    const alive = new Set<string>();
    for (const mob of mobs) {
      alive.add(mob.id);
      const live = this.livePose.get(mob.id);
      if (!live) {
        continue;
      }
      mob.posX = live.posX;
      mob.posY = live.posY;
      mob.posZ = live.posZ;
      mob.worldFacingYaw = live.yaw;
    }
    for (const id of [...this.livePose.keys()]) {
      if (!alive.has(id)) {
        this.livePose.delete(id);
        this.poseDirty.delete(id);
      }
    }
  }

  private async flushDirtyLivePoses(): Promise<void> {
    const ids = [...this.poseDirty];
    if (ids.length === 0) {
      return;
    }
    this.poseDirty.clear();
    for (const id of ids) {
      const pose = this.livePose.get(id);
      if (!pose) {
        continue;
      }
      try {
        await this.prisma.mobInstance.update({
          where: { id },
          data: {
            posX: pose.posX,
            posY: pose.posY,
            posZ: pose.posZ,
            worldFacingYaw: pose.yaw,
          },
        });
      } catch {
        this.poseDirty.add(id);
      }
    }
  }

  private resolveMobMoveAgainstWorld(params: {
    mobId: string;
    from: { x: number; y: number; z: number };
    desired: { x: number; y: number; z: number };
    zoneId: string;
    fallbackYaw: number;
    allowSlide: boolean;
  }): {
    x: number;
    y: number;
    z: number;
    yaw: number;
    blocked: boolean;
    movedXZ: number;
  } {
    const { mobId, from, desired, zoneId, fallbackYaw, allowSlide } = params;
    const base = this.spatial.resolveMoveTargetAgainstObstacles({
      from,
      to: desired,
      zoneId,
    });
    let best = {
      x: base.corrected.x,
      y: base.corrected.y,
      z: base.corrected.z,
      blocked: base.blocked,
      obstacleId: base.obstacleId,
      movedXZ: this.distXZ(
        { x: from.x, z: from.z },
        { x: base.corrected.x, z: base.corrected.z },
      ),
    };

    if (base.blocked && allowSlide) {
      const xSlide = this.spatial.resolveMoveTargetAgainstObstacles({
        from,
        to: { x: desired.x, y: desired.y, z: from.z },
        zoneId,
      });
      const xMoved = this.distXZ(
        { x: from.x, z: from.z },
        { x: xSlide.corrected.x, z: xSlide.corrected.z },
      );
      if (xMoved > best.movedXZ) {
        best = {
          x: xSlide.corrected.x,
          y: xSlide.corrected.y,
          z: xSlide.corrected.z,
          blocked: xSlide.blocked,
          obstacleId: xSlide.obstacleId,
          movedXZ: xMoved,
        };
      }

      const zSlide = this.spatial.resolveMoveTargetAgainstObstacles({
        from,
        to: { x: from.x, y: desired.y, z: desired.z },
        zoneId,
      });
      const zMoved = this.distXZ(
        { x: from.x, z: from.z },
        { x: zSlide.corrected.x, z: zSlide.corrected.z },
      );
      if (zMoved > best.movedXZ) {
        best = {
          x: zSlide.corrected.x,
          y: zSlide.corrected.y,
          z: zSlide.corrected.z,
          blocked: zSlide.blocked,
          obstacleId: zSlide.obstacleId,
          movedXZ: zMoved,
        };
      }
    }

    let yaw = fallbackYaw;
    if (best.movedXZ > 1e-5) {
      yaw = Math.atan2(best.x - from.x, best.z - from.z);
    }
    if (base.blocked && this.aiCollisionDebug) {
      this.logger.debug(
        `[AI Collision] Mob ${mobId} hit obstacle at ${this.formatPos({
          x: best.x,
          y: best.y,
          z: best.z,
        })}${best.obstacleId ? ` (${best.obstacleId})` : ''}.`,
      );
    }
    return {
      x: best.x,
      y: best.y,
      z: best.z,
      yaw,
      blocked: base.blocked,
      movedXZ: best.movedXZ,
    };
  }

  private async resetChaseAggroToIdle(
    mob: MobTickRow,
    next: { posX: number; posY: number; posZ: number; yaw: number; hp: number },
    maxHp: number,
  ): Promise<void> {
    await this.prisma.mobInstance.update({
      where: { id: mob.id },
      data: {
        aggroTargetCharacterId: null,
        aiState: MobAiState.IDLE,
      },
    });
    this.refreshRamPoseAfterDbMove(mob, next);
    this.clearChaseBlocked(mob.id);
    this.clearChaseNavigationCache(mob.id);
    this.scheduleIdlePatrol(mob.id);
    this.emitMobMoved(mob.zoneId, {
      mobInstanceId: mob.id,
      pos: { x: next.posX, y: next.posY, z: next.posZ },
      worldFacingYaw: next.yaw,
      aiState: 'IDLE',
      currentHp: next.hp,
      maxHp,
    });
  }

  /** Zona XZ alrededor del spawn donde se permite curación OOC al máximo (sin depender de leash previo). */
  private isNearSpawnForOocRegen(
    m: MobTickRow,
    posX: number,
    posZ: number,
  ): boolean {
    const sp = this.spawnWorldPos(m);
    return (
      this.distXZ({ x: posX, z: posZ }, { x: sp.x, z: sp.z }) <=
      Math.max(ARRIVE_EPS_XZ * 3.5, 1.25)
    );
  }

  /**
   * Curación OOC al máximo: desactivada con odio (aggro), con daño reciente al mob,
   * o durante retorno forzado a spawn hasta ancla + paz total.
   */
  private canMobOocFullHeal(
    mobId: string,
    nextAggroId: string | null,
    dbAggroId: string | null,
    now: number,
    posX: number,
    posZ: number,
    mob: MobTickRow,
  ): boolean {
    if (nextAggroId || dbAggroId) {
      return false;
    }
    if (
      this.mobCombatRegen.wasDamageReceivedWithin(
        mobId,
        now,
        MOB_OOC_HEAL_POST_DAMAGE_MS,
      )
    ) {
      return false;
    }
    if (this.mobLeashResetHealBlocked.has(mobId)) {
      const atSpawn = this.isNearSpawnForOocRegen(mob, posX, posZ);
      if (
        !atSpawn ||
        !this.mobCombatRegen.hasPeaceForMobFullHeal(
          mobId,
          now,
          MOB_POST_LEASH_RESET_PEACE_MS,
        )
      ) {
        return false;
      }
      this.mobLeashResetHealBlocked.delete(mobId);
    }
    return (
      !this.mobCombatRegen.isHardCombatLocked(mobId, now) &&
      this.mobCombatRegen.hasPeaceForMobFullHeal(mobId, now)
    );
  }

  private async loadAliveMobs(): Promise<MobTickRow[]> {
    const rows = await this.prisma.mobInstance.findMany({
      where: { isAlive: true },
      include: {
        template: {
          select: {
            maxHp: true,
            aggroRange: true,
            moveSpeed: true,
            templateKey: true,
            pDef: true,
            mDef: true,
            attackRange: true,
            expReward: true,
            dropTable: true,
          },
        },
      },
    });
    return rows as MobTickRow[];
  }

  private async loadCharactersByZone(): Promise<
    Map<string, { id: string; x: number; y: number; z: number }[]>
  > {
    const rows = await this.prisma.character.findMany({
      where: { currentHp: { gt: 0 } },
      select: {
        id: true,
        worldPosX: true,
        worldPosY: true,
        worldPosZ: true,
        currentZoneId: true,
      },
    });
    const map = new Map<string, { id: string; x: number; y: number; z: number }[]>();
    for (const r of rows) {
      const z = this.zoneKey(r.currentZoneId);
      const list = map.get(z) ?? [];
      const ram = this.playerCombatRuntime.getCharacterWorldPose(r.id);
      list.push({
        id: r.id,
        x: ram?.x ?? r.worldPosX,
        y: ram?.y ?? r.worldPosY,
        z: ram?.z ?? r.worldPosZ,
      });
      map.set(z, list);
    }
    return map;
  }

  private nearestPlayerInAggroRange(
    m: MobTickRow,
    chars: { id: string; x: number; y: number; z: number }[] | undefined,
  ): string | null {
    if (!chars?.length) {
      return null;
    }
    const mobPos = { x: m.posX, y: m.posY, z: m.posZ };
    const range = m.template.aggroRange;
    let best: { id: string; d: number } | null = null;
    for (const c of chars) {
      const d = this.spatial.distance3d(mobPos, { x: c.x, y: c.y, z: c.z });
      if (d <= range && (!best || d < best.d)) {
        best = { id: c.id, d };
      }
    }
    return best?.id ?? null;
  }

  private async setMobChaseTarget(
    mob: MobTickRow,
    attackerCharacterId: string,
  ): Promise<boolean> {
    if (!mob.id || !attackerCharacterId) {
      return false;
    }
    if (
      mob.aggroTargetCharacterId === attackerCharacterId &&
      mob.aiState === MobAiState.CHASE
    ) {
      return false;
    }
    if (
      mob.aggroTargetCharacterId &&
      mob.aggroTargetCharacterId !== attackerCharacterId
    ) {
      return false;
    }
    await this.prisma.mobInstance.update({
      where: { id: mob.id },
      data: {
        aggroTargetCharacterId: attackerCharacterId,
        aiState: MobAiState.CHASE,
      },
    });
    mob.aggroTargetCharacterId = attackerCharacterId;
    mob.aiState = MobAiState.CHASE;
    this.clearChaseBlocked(mob.id);
    this.clearChaseNavigationCache(mob.id);
    this.idlePatrolAfterMs.delete(mob.id);
    this.patrolDestXz.delete(mob.id);
    this.patrolKind.delete(mob.id);
    return true;
  }

  private zoneGridCellSizeMeters(): number {
    return Math.max(1, this.spatial.getNavGridCellSizeMeters());
  }

  private zoneGridCellKey(
    pos: { x: number; z: number },
    cellSize: number,
  ): string {
    const gx = Math.floor(pos.x / cellSize);
    const gz = Math.floor(pos.z / cellSize);
    return `${gx},${gz}`;
  }

  private buildZoneMobGridIndex(zoneMobs: MobTickRow[]): ZoneMobGridIndex {
    const cellSize = this.zoneGridCellSizeMeters();
    const grid = new Map<string, MobTickRow[]>();
    for (const mob of zoneMobs) {
      const key = this.zoneGridCellKey({ x: mob.posX, z: mob.posZ }, cellSize);
      const list = grid.get(key) ?? [];
      list.push(mob);
      grid.set(key, list);
    }
    return grid;
  }

  private getNearbyMobsFromZoneGrid(params: {
    sourcePos: { x: number; z: number };
    radius: number;
    zoneGrid: ZoneMobGridIndex;
  }): MobTickRow[] {
    const { sourcePos, radius, zoneGrid } = params;
    const cellSize = this.zoneGridCellSizeMeters();
    const centerGx = Math.floor(sourcePos.x / cellSize);
    const centerGz = Math.floor(sourcePos.z / cellSize);
    const ring = Math.max(1, Math.ceil(radius / cellSize));
    const nearby: MobTickRow[] = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dz = -ring; dz <= ring; dz += 1) {
        const key = `${centerGx + dx},${centerGz + dz}`;
        const cellMobs = zoneGrid.get(key);
        if (!cellMobs?.length) {
          continue;
        }
        for (const mob of cellMobs) {
          if (
            this.distXZ(sourcePos, { x: mob.posX, z: mob.posZ }) <= radius
          ) {
            nearby.push(mob);
          }
        }
      }
    }
    return nearby;
  }

  private async emitSocialLinkToAllies(params: {
    sourceMob: MobTickRow;
    attackerCharacterId: string;
    zoneGrid: ZoneMobGridIndex;
  }): Promise<void> {
    const { sourceMob, attackerCharacterId, zoneGrid } = params;
    if (
      sourceMob.aggroTargetCharacterId &&
      sourceMob.aggroTargetCharacterId !== attackerCharacterId
    ) {
      return;
    }
    const radius = getSocialLinkRadiusForTemplateKey(sourceMob.template.templateKey);
    const sourceFamily = getSocialFamilyForTemplateKey(sourceMob.template.templateKey);
    const nearbyAllies = this.getNearbyMobsFromZoneGrid({
      sourcePos: { x: sourceMob.posX, z: sourceMob.posZ },
      radius,
      zoneGrid,
    });
    for (const ally of nearbyAllies) {
      if (ally.id === sourceMob.id || !ally.id) {
        continue;
      }
      if (ally.aiState !== MobAiState.IDLE && ally.aiState !== MobAiState.PATROL) {
        continue;
      }
      if (
        ally.aggroTargetCharacterId &&
        ally.aggroTargetCharacterId !== attackerCharacterId
      ) {
        continue;
      }
      const sameTemplate =
        ally.mobTemplateId === sourceMob.mobTemplateId ||
        ally.template.templateKey === sourceMob.template.templateKey;
      const allyFamily = getSocialFamilyForTemplateKey(ally.template.templateKey);
      const sameFamily = !!(
        sourceFamily &&
        allyFamily &&
        sourceFamily === allyFamily
      );
      if (!sameTemplate && !sameFamily) {
        continue;
      }
      const changed = await this.setMobChaseTarget(ally, attackerCharacterId);
      if (!changed) {
        continue;
      }
      const hp = this.playerCombatRuntime.getMobHpForAiTick(ally.id);
      this.emitMobMoved(ally.zoneId, {
        mobInstanceId: ally.id,
        pos: { x: ally.posX, y: ally.posY, z: ally.posZ },
        worldFacingYaw: ally.worldFacingYaw,
        aiState: 'CHASE',
        currentHp: hp,
        maxHp: ally.template.maxHp,
      });
    }
  }

  private emitMobMoved(
    zoneId: string | null | undefined,
    payload: WsMobMovedPayload,
  ): void {
    this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.MOB_MOVED, payload);
  }

  private refreshRamPoseAfterDbMove(
    mob: MobTickRow,
    next: { posX: number; posY: number; posZ: number; yaw: number },
  ): void {
    this.playerCombatRuntime.syncMobWorldPoseFromAi(mob.id, {
      posX: next.posX,
      posY: next.posY,
      posZ: next.posZ,
      yaw: next.yaw,
      zoneId: mob.zoneId,
    });
  }

  /**
   * Regla de oro: combate manda — curaciones pasivas / snaps a spawn no compiten con odio,
   * CHASE, HP sucio en RAM o daño reciente al mob.
   */
  private combatBlocksPassiveAi(
    mob: MobTickRow,
    next: { aggroId: string | null; aiState: MobAiState },
    now: number,
  ): boolean {
    return (
      !!next.aggroId ||
      !!mob.aggroTargetCharacterId ||
      next.aiState === MobAiState.CHASE ||
      this.playerCombatRuntime.isMobHpDirty(mob.id) ||
      this.mobCombatRegen.wasDamageReceivedWithin(
        mob.id,
        now,
        MOB_LEASH_RESET_DAMAGE_LOCK_MS,
      )
    );
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    const now = Date.now();
    const elapsedMs = this.lastAiTickAtMs > 0 ? now - this.lastAiTickAtMs : TICK_MS;
    this.lastAiTickAtMs = now;
    const dt = Math.min(
      MAX_AI_MOVE_DT_SEC,
      Math.max(0.016, elapsedMs / 1000),
    );
    try {
      let mobs: MobTickRow[];
      let charsByZone: Map<string, { id: string; x: number; y: number; z: number }[]>;
      try {
        [mobs, charsByZone] = await Promise.all([
          this.loadAliveMobs(),
          this.loadCharactersByZone(),
        ]);
      } catch {
        return;
      }

      this.applyLivePoses(mobs);
      this.playerCombatRuntime.hydrateMobsForAiTick(mobs);
      const mobsByZone = new Map<string, MobTickRow[]>();
      for (const row of mobs) {
        const zoneRows = mobsByZone.get(this.zoneKey(row.zoneId)) ?? [];
        zoneRows.push(row);
        mobsByZone.set(this.zoneKey(row.zoneId), zoneRows);
      }
      const zoneMobGridByZone = new Map<string, ZoneMobGridIndex>();
      for (const [zoneId, zoneRows] of mobsByZone) {
        zoneMobGridByZone.set(zoneId, this.buildZoneMobGridIndex(zoneRows));
      }

      for (const mob of mobs) {
        try {
          await this.tickOneMob(mob, charsByZone, mobsByZone, zoneMobGridByZone, dt, now);
        } catch {
          /* siguiente mob */
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async tickOneMob(
    mob: MobTickRow,
    charsByZone: Map<string, { id: string; x: number; y: number; z: number }[]>,
    mobsByZone: Map<string, MobTickRow[]>,
    zoneMobGridByZone: Map<string, ZoneMobGridIndex>,
    dt: number,
    now: number,
  ): Promise<void> {
    if (this.playerCombatRuntime.isMobPendingDeath(mob.id)) {
      return;
    }
    const z = this.zoneKey(mob.zoneId);
    const chars = charsByZone.get(z);
    if (!(chars?.length) && !mob.aggroTargetCharacterId) {
      return;
    }
    const zoneMobs = mobsByZone.get(z) ?? [];
    const zoneGrid = zoneMobGridByZone.get(z) ?? this.buildZoneMobGridIndex(zoneMobs);
    const patrolSpeed = resolveMobAiMoveSpeed(
      mob.template.templateKey,
      'patrol',
      mob.template.moveSpeed,
    );
    const chaseSpeed = resolveMobAiMoveSpeed(
      mob.template.templateKey,
      'chase',
      mob.template.moveSpeed,
    );
    const maxHp = mob.template.maxHp;
    const leashR = this.spatial.getMobAiLeashRadiusMeters();
    const zoneId = this.zoneKey(mob.zoneId);
    const safeSpawnPos = this.resolveSpawnWorldPosAgainstObstacles(mob, zoneId);

    let next = {
      posX: mob.posX,
      posY: mob.posY,
      posZ: mob.posZ,
      yaw: mob.worldFacingYaw,
      aiState: mob.aiState,
      aggroId: mob.aggroTargetCharacterId,
      hp: this.playerCombatRuntime.getMobHpForAiTick(mob.id),
    };

    /**
     * Social Link (The Warden):
     * si el mob recibió daño reciente, adquiere CHASE contra el atacante y
     * alerta aliados de la misma familia/template en radio configurado.
     */
    const damageSignal = this.mobCombatRegen.getLatestDamageSource(
      mob.id,
      now,
      DAMAGE_SIGNAL_WINDOW_MS,
    );
    if (
      damageSignal &&
      this.canProcessDamageSignal(mob.id, damageSignal.atMs) &&
      this.leashDistanceXZ(mob, next.posX, next.posZ) <= leashR
    ) {
      const attacker = chars?.find((c) => c.id === damageSignal.attackerCharacterId);
      if (attacker) {
        const changed = await this.setMobChaseTarget(mob, attacker.id);
        if (changed) {
          next.aggroId = attacker.id;
          next.aiState = MobAiState.CHASE;
          this.emitMobMoved(mob.zoneId, {
            mobInstanceId: mob.id,
            pos: { x: next.posX, y: next.posY, z: next.posZ },
            worldFacingYaw: next.yaw,
            aiState: 'CHASE',
            currentHp: next.hp,
            maxHp,
          });
        }
        await this.emitSocialLinkToAllies({
          sourceMob: mob,
          attackerCharacterId: attacker.id,
          zoneGrid,
        });
      }
    }

    /**
     * Leash / RETURNING_HOME: solo sin daño reciente (20s) y sin HP sucio en RAM.
     * Combate manda: no forzar reset de aggro/retorno con trade activo.
     */
    const leashDist = this.leashDistanceXZ(mob, mob.posX, mob.posZ);
    if (
      leashDist > leashR &&
      mob.aggroTargetCharacterId &&
      !this.mobCombatRegen.wasDamageReceivedWithin(
        mob.id,
        now,
        MOB_LEASH_RESET_DAMAGE_LOCK_MS,
      ) &&
      !this.playerCombatRuntime.isMobHpDirty(mob.id)
    ) {
      this.logger.log(
        `[AI] Mob ${mob.id} resetting due to distance: ${leashDist.toFixed(2)}m`,
      );
      await this.playerCombatRuntime.flushMobHpToDatabase(mob.id);
      const hpNow = this.playerCombatRuntime.getMobHpForAiTick(mob.id);
      this.mobLeashResetHealBlocked.add(mob.id);

      this.patrolKind.set(mob.id, 'home');
      {
        const sp = safeSpawnPos;
        this.patrolDestXz.set(mob.id, { x: sp.x, z: sp.z });
      }
      this.idlePatrolAfterMs.delete(mob.id);
      await this.prisma.mobInstance.update({
        where: { id: mob.id },
        data: {
          aggroTargetCharacterId: null,
          aiState: MobAiState.PATROL,
        },
      });
      this.refreshRamPoseAfterDbMove(mob, next);
      this.clearChaseBlocked(mob.id);
      this.clearChaseNavigationCache(mob.id);
      next = {
        ...next,
        aggroId: null,
        hp: hpNow,
        aiState: MobAiState.PATROL,
      };
      this.emitMobMoved(mob.zoneId, {
        mobInstanceId: mob.id,
        pos: { x: next.posX, y: next.posY, z: next.posZ },
        worldFacingYaw: next.yaw,
        aiState: 'PATROL',
        currentHp: hpNow,
        maxHp,
      });
      mob.aggroTargetCharacterId = null;
      mob.aiState = MobAiState.PATROL;
    }

    /** Adquisición de aggro (jugador quieto dentro de rango). No re-aggro fuera del radio de leash. */
    if (
      !next.aggroId &&
      (next.aiState === MobAiState.IDLE || next.aiState === MobAiState.PATROL) &&
      this.leashDistanceXZ(mob, next.posX, next.posZ) <= leashR
    ) {
      const acquire = this.nearestPlayerInAggroRange(
        { ...mob, posX: next.posX, posY: next.posY, posZ: next.posZ },
        chars,
      );
      if (acquire) {
        await this.setMobChaseTarget(mob, acquire);
        next.aggroId = acquire;
        next.aiState = MobAiState.CHASE;
        this.emitMobMoved(mob.zoneId, {
          mobInstanceId: mob.id,
          pos: { x: next.posX, y: next.posY, z: next.posZ },
          worldFacingYaw: next.yaw,
          aiState: 'CHASE',
          currentHp: next.hp,
          maxHp,
        });
      }
    }

    /** CHASE: perseguir posición autoritativa del jugador. */
    if (next.aggroId && next.aiState === MobAiState.CHASE) {
      const target = chars?.find((c) => c.id === next.aggroId);
      if (!target) {
        if (this.mobCombatRegen.isHardCombatLocked(mob.id, now)) {
          return;
        }
        next.aggroId = null;
        next.aiState = MobAiState.IDLE;
        await this.resetChaseAggroToIdle(mob, next, maxHp);
        return;
      }

      const chaseFrom = { x: next.posX, y: next.posY, z: next.posZ };
      const hold = this.resolveChaseHoldPoint(mob, target, zoneMobs);
      const chaseWaypoint = this.getChaseWaypointFromNavGrid({
        mob,
        mobPos: chaseFrom,
        target: { id: target.id, x: hold.x, y: hold.y, z: hold.z },
        nowMs: now,
        zoneId,
      });
      const stepped = this.stepToward(
        chaseFrom,
        chaseWaypoint,
        chaseSpeed,
        dt,
        next.yaw,
      );
      const chaseMove = this.applySeparatedPose({
        mobId: mob.id,
        from: chaseFrom,
        desired: { x: stepped.x, y: stepped.y, z: stepped.z },
        zoneId,
        zoneMobs,
        fallbackYaw: next.yaw,
        allowSlide: true,
      });
      next.posX = chaseMove.x;
      next.posY = chaseMove.y;
      next.posZ = chaseMove.z;
      const distToPlayer = this.distXZ(
        { x: next.posX, z: next.posZ },
        { x: target.x, z: target.z },
      );
      if (distToPlayer <= mob.template.attackRange * 1.35 || chaseMove.movedXZ < 0.08) {
        next.yaw = Math.atan2(target.x - next.posX, target.z - next.posZ);
      } else {
        next.yaw = chaseMove.yaw;
      }

      const inAttackRange = this.spatial.isWithinMobToPlayerMeleeRange(
        { x: next.posX, y: next.posY, z: next.posZ },
        { x: target.x, y: target.y, z: target.z },
        mob.template.attackRange,
      );
      if (chaseMove.movedXZ < MOVE_PROGRESS_EPS_XZ && !inAttackRange) {
        const blockedSince = this.chaseBlockedSinceMs.get(mob.id) ?? now;
        this.chaseBlockedSinceMs.set(mob.id, blockedSince);
        if (now - blockedSince >= CHASE_STUCK_RESET_MS) {
          next.aggroId = null;
          next.aiState = MobAiState.IDLE;
          mob.aggroTargetCharacterId = null;
          mob.aiState = MobAiState.IDLE;
          await this.resetChaseAggroToIdle(mob, next, maxHp);
          return;
        }
      } else {
        this.clearChaseBlocked(mob.id);
      }

      this.commitLiveMovement(mob, next);
      this.emitMobMoved(mob.zoneId, {
        mobInstanceId: mob.id,
        pos: { x: next.posX, y: next.posY, z: next.posZ },
        worldFacingYaw: next.yaw,
        aiState: 'CHASE',
        currentHp: next.hp,
        maxHp,
      });
      return;
    }

    /** Coherencia: CHASE sin aggro en DB. */
    if (next.aiState === MobAiState.CHASE && !next.aggroId) {
      if (this.mobCombatRegen.isHardCombatLocked(mob.id, now)) {
        return;
      }
      await this.prisma.mobInstance.update({
        where: { id: mob.id },
        data: { aiState: MobAiState.IDLE },
      });
      next.aiState = MobAiState.IDLE;
      this.clearChaseBlocked(mob.id);
      this.clearChaseNavigationCache(mob.id);
      this.scheduleIdlePatrol(mob.id);
    }

    /** IDLE → PATROL tras temporizador. */
    if (next.aiState === MobAiState.IDLE) {
      /**
       * Curación OOC al máximo: cualquier mob dañado en IDLE cerca del spawn, sin aggro,
       * sin hard lock y con ventana de paz (antes solo existía si `pendingSpawnFullHeal`).
       */
      if (
        !this.combatBlocksPassiveAi(mob, next, now) &&
        next.hp < maxHp &&
        this.canMobOocFullHeal(
          mob.id,
          next.aggroId,
          mob.aggroTargetCharacterId,
          now,
          next.posX,
          next.posZ,
          mob,
        ) &&
        this.isNearSpawnForOocRegen(mob, next.posX, next.posZ)
      ) {
        await this.playerCombatRuntime.flushMobHpToDatabase(mob.id);
        const hpAccIdle = this.playerCombatRuntime.getMobHpForAiTick(mob.id);
        next.hp = hpAccIdle;
        if (hpAccIdle < maxHp) {
          await this.prisma.mobInstance.update({
            where: { id: mob.id },
            data: { currentHp: maxHp },
          });
          next.hp = maxHp;
          this.playerCombatRuntime.setMobRuntimeHpClean(mob.id, maxHp, maxHp);
          this.emitMobMoved(mob.zoneId, {
            mobInstanceId: mob.id,
            pos: { x: next.posX, y: next.posY, z: next.posZ },
            worldFacingYaw: next.yaw,
            aiState: 'IDLE',
            currentHp: maxHp,
            maxHp,
          });
          return;
        }
      }

      let t = this.idlePatrolAfterMs.get(mob.id);
      if (t === undefined) {
        this.scheduleIdlePatrol(mob.id);
        t = this.idlePatrolAfterMs.get(mob.id)!;
      }
      if (now < t) {
        return;
      }
      this.idlePatrolAfterMs.delete(mob.id);
      this.patrolKind.set(mob.id, 'wander');
      const dest = this.pickWanderPatrolDest(mob);
      this.patrolDestXz.set(mob.id, dest);
      await this.prisma.mobInstance.update({
        where: { id: mob.id },
        data: { aiState: MobAiState.PATROL },
      });
      next.aiState = MobAiState.PATROL;
    }

    /** PATROL: wander cerca del spawn o retorno tras leash. */
    if (next.aiState === MobAiState.PATROL) {
      if (
        (this.patrolKind.get(mob.id) ?? 'wander') === 'home' &&
        this.mobCombatRegen.wasDamageReceivedWithin(
          mob.id,
          now,
          MOB_LEASH_RESET_DAMAGE_LOCK_MS,
        )
      ) {
        this.patrolKind.set(mob.id, 'wander');
        this.patrolDestXz.set(
          mob.id,
          this.pickWanderPatrolDest({
            ...mob,
            posX: next.posX,
            posY: next.posY,
            posZ: next.posZ,
          }),
        );
      }

      const spCalm = safeSpawnPos;
      const kindPre = this.patrolKind.get(mob.id) ?? 'wander';
      if (
        !this.combatBlocksPassiveAi(mob, next, now) &&
        kindPre === 'wander' &&
        next.hp < maxHp &&
        this.canMobOocFullHeal(
          mob.id,
          next.aggroId,
          mob.aggroTargetCharacterId,
          now,
          next.posX,
          next.posZ,
          mob,
        ) &&
        this.isNearSpawnForOocRegen(mob, next.posX, next.posZ)
      ) {
        await this.playerCombatRuntime.flushMobHpToDatabase(mob.id);
        const hpAccW = this.playerCombatRuntime.getMobHpForAiTick(mob.id);
        next.hp = hpAccW;
        if (hpAccW < maxHp) {
          await this.prisma.mobInstance.update({
            where: { id: mob.id },
            data: { currentHp: maxHp },
          });
          next.hp = maxHp;
          this.playerCombatRuntime.setMobRuntimeHpClean(mob.id, maxHp, maxHp);
          this.emitMobMoved(mob.zoneId, {
            mobInstanceId: mob.id,
            pos: { x: next.posX, y: next.posY, z: next.posZ },
            worldFacingYaw: next.yaw,
            aiState: 'PATROL',
            currentHp: maxHp,
            maxHp,
          });
          return;
        }
      }
      const nearSpawnCalm =
        this.distXZ({ x: next.posX, z: next.posZ }, { x: spCalm.x, z: spCalm.z }) < 1.2;
      if (
        !this.combatBlocksPassiveAi(mob, next, now) &&
        kindPre === 'wander' &&
        nearSpawnCalm &&
        !next.aggroId &&
        !this.mobCombatRegen.isHardCombatLocked(mob.id, now)
      ) {
        const gate = this.mobSpawnCalmGateAtMs.get(mob.id);
        if (gate !== undefined && now >= gate) {
          this.mobSpawnCalmGateAtMs.delete(mob.id);
          await this.prisma.mobInstance.update({
            where: { id: mob.id },
            data: {
              posX: spCalm.x,
              posY: spCalm.y,
              posZ: spCalm.z,
              aiState: MobAiState.IDLE,
            },
          });
          next.posX = spCalm.x;
          next.posY = spCalm.y;
          next.posZ = spCalm.z;
          next.aiState = MobAiState.IDLE;
          mob.posX = spCalm.x;
          mob.posY = spCalm.y;
          mob.posZ = spCalm.z;
          mob.aiState = MobAiState.IDLE;
          this.scheduleIdlePatrol(mob.id);
          this.refreshRamPoseAfterDbMove(mob, next);
          this.emitMobMoved(mob.zoneId, {
            mobInstanceId: mob.id,
            pos: { x: next.posX, y: next.posY, z: next.posZ },
            worldFacingYaw: next.yaw,
            aiState: 'IDLE',
            currentHp: next.hp,
            maxHp,
          });
          return;
        }
      } else if (next.aggroId) {
        this.mobSpawnCalmGateAtMs.delete(mob.id);
      }

      let dest = this.patrolDestXz.get(mob.id);
      const kind = this.patrolKind.get(mob.id) ?? 'wander';
      if (!dest) {
        this.patrolKind.set(mob.id, 'wander');
        dest = this.pickWanderPatrolDest(mob);
        this.patrolDestXz.set(mob.id, dest);
      }

      const homeY = safeSpawnPos.y;
      const patrolFrom = { x: next.posX, y: next.posY, z: next.posZ };
      const stepped = this.stepToward(
        patrolFrom,
        { x: dest.x, y: homeY, z: dest.z },
        patrolSpeed * (kind === 'home' ? 1.05 : 1),
        dt,
        next.yaw,
      );
      const patrolMove = this.applySeparatedPose({
        mobId: mob.id,
        from: patrolFrom,
        desired: { x: stepped.x, y: stepped.y, z: stepped.z },
        zoneId,
        zoneMobs,
        fallbackYaw: next.yaw,
        allowSlide: kind !== 'home',
      });
      next.posX = patrolMove.x;
      next.posY = patrolMove.y;
      next.posZ = patrolMove.z;
      next.yaw = patrolMove.yaw;
      if (patrolMove.blocked && patrolMove.movedXZ < MOVE_PROGRESS_EPS_XZ && kind === 'wander') {
        const reroute = this.pickWanderPatrolDest({
          ...mob,
          posX: next.posX,
          posY: next.posY,
          posZ: next.posZ,
        });
        this.patrolDestXz.set(mob.id, reroute);
      }

      this.commitLiveMovement(mob, next);

      const arrived = this.distXZ(
        { x: next.posX, z: next.posZ },
        { x: dest.x, z: dest.z },
      ) < ARRIVE_EPS_XZ;
      if (arrived) {
        if (kind === 'home') {
          if (this.combatBlocksPassiveAi(mob, next, now)) {
            this.patrolKind.set(mob.id, 'wander');
            const nd = this.pickWanderPatrolDest({
              ...mob,
              posX: next.posX,
              posY: next.posY,
              posZ: next.posZ,
            });
            this.patrolDestXz.set(mob.id, nd);
            this.emitMobMoved(mob.zoneId, {
              mobInstanceId: mob.id,
              pos: { x: next.posX, y: next.posY, z: next.posZ },
              worldFacingYaw: next.yaw,
              aiState: 'PATROL',
              currentHp: next.hp,
              maxHp,
            });
            return;
          }

          this.patrolDestXz.delete(mob.id);
          this.patrolKind.delete(mob.id);
          await this.playerCombatRuntime.flushMobHpToDatabase(mob.id);
          const hpAcc = this.playerCombatRuntime.getMobHpForAiTick(mob.id);
          next.hp = hpAcc;

          const sp = safeSpawnPos;
          const hard = this.mobCombatRegen.isHardCombatLocked(mob.id, now);
          const peace5 = this.mobCombatRegen.hasPeaceForMobFullHeal(mob.id, now);
          const peace10 = this.mobCombatRegen.hasPeaceForMobFullHeal(
            mob.id,
            now,
            MOB_POST_LEASH_RESET_PEACE_MS,
          );
          const resetHealPending = this.mobLeashResetHealBlocked.has(mob.id);
          const aggroBlocked = !!(next.aggroId || mob.aggroTargetCharacterId);
          const damageBlocked = this.mobCombatRegen.wasDamageReceivedWithin(
            mob.id,
            now,
            MOB_OOC_HEAL_POST_DAMAGE_MS,
          );
          const allowFullHeal =
            !this.combatBlocksPassiveAi(mob, next, now) &&
            !aggroBlocked &&
            !damageBlocked &&
            !hard &&
            hpAcc < maxHp &&
            (resetHealPending ? peace10 : peace5);

          if (hard) {
            this.mobSpawnCalmGateAtMs.set(mob.id, now + 450);
            await this.prisma.mobInstance.update({
              where: { id: mob.id },
              data: {
                posX: sp.x,
                posY: sp.y,
                posZ: sp.z,
                aiState: MobAiState.PATROL,
              },
            });
            this.patrolKind.set(mob.id, 'wander');
            const nd = this.pickWanderPatrolDest({
              ...mob,
              posX: sp.x,
              posY: sp.y,
              posZ: sp.z,
            });
            this.patrolDestXz.set(mob.id, nd);
            next.posX = sp.x;
            next.posY = sp.y;
            next.posZ = sp.z;
            mob.posX = sp.x;
            mob.posY = sp.y;
            mob.posZ = sp.z;
            next.aiState = MobAiState.PATROL;
            mob.aiState = MobAiState.PATROL;
            this.refreshRamPoseAfterDbMove(mob, next);
            this.setLivePose(mob.id, next, false);
            this.emitMobMoved(mob.zoneId, {
              mobInstanceId: mob.id,
              pos: { x: next.posX, y: next.posY, z: next.posZ },
              worldFacingYaw: next.yaw,
              aiState: 'PATROL',
              currentHp: hpAcc,
              maxHp,
            });
            return;
          }

          this.mobSpawnCalmGateAtMs.delete(mob.id);
          let hpEmit = hpAcc;
          if (allowFullHeal) {
            await this.prisma.mobInstance.update({
              where: { id: mob.id },
              data: {
                posX: sp.x,
                posY: sp.y,
                posZ: sp.z,
                aiState: MobAiState.IDLE,
                currentHp: maxHp,
              },
            });
            hpEmit = maxHp;
            next.hp = maxHp;
            this.playerCombatRuntime.setMobRuntimeHpClean(mob.id, maxHp, maxHp);
            if (resetHealPending) {
              this.mobLeashResetHealBlocked.delete(mob.id);
            }
          } else {
            await this.prisma.mobInstance.update({
              where: { id: mob.id },
              data: {
                posX: sp.x,
                posY: sp.y,
                posZ: sp.z,
                aiState: MobAiState.IDLE,
              },
            });
          }
          next.posX = sp.x;
          next.posY = sp.y;
          next.posZ = sp.z;
          next.aiState = MobAiState.IDLE;
          mob.posX = sp.x;
          mob.posY = sp.y;
          mob.posZ = sp.z;
          mob.aiState = MobAiState.IDLE;
          this.scheduleIdlePatrol(mob.id);
          this.refreshRamPoseAfterDbMove(mob, next);
          this.setLivePose(mob.id, next, false);
          this.emitMobMoved(mob.zoneId, {
            mobInstanceId: mob.id,
            pos: { x: next.posX, y: next.posY, z: next.posZ },
            worldFacingYaw: next.yaw,
            aiState: 'IDLE',
            currentHp: hpEmit,
            maxHp,
          });
          return;
        }
        const nd = this.pickWanderPatrolDest({
          ...mob,
          posX: next.posX,
          posY: next.posY,
          posZ: next.posZ,
        });
        this.patrolDestXz.set(mob.id, nd);
      }

      this.emitMobMoved(mob.zoneId, {
        mobInstanceId: mob.id,
        pos: { x: next.posX, y: next.posY, z: next.posZ },
        worldFacingYaw: next.yaw,
        aiState: 'PATROL',
        currentHp: next.hp,
        maxHp,
      });
    }
  }
}
