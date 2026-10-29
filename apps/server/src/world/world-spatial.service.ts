import { Injectable } from '@nestjs/common';
import {
  type MapObstacleConfigRow,
  isMapBoxBlockingMovement,
  loadMapObjectsConfig,
  loadWorldSpatialConfig,
} from '../combat/combat-config.loaders';
import { normalizeZoneId } from './world-zone.util';

export interface WorldPosition {
  x: number;
  y: number;
  z: number;
}

interface XzRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface NavCell {
  gx: number;
  gz: number;
}

@Injectable()
export class WorldSpatialService {
  /**
   * El atacante está en el cono posterior del objetivo (facing del mob, blueprint 05).
   * Plano XZ; forward del mob = (sin(yaw), cos(yaw)).
   */
  isBackstabFromRearCone(params: {
    targetForwardYaw: number;
    targetPosition: WorldPosition;
    attackerPosition: WorldPosition;
  }): boolean {
    const spatial = loadWorldSpatialConfig();
    const coneDeg = spatial.rearConeTotalDegrees ?? 120;
    const halfAngleRad = (coneDeg / 2) * (Math.PI / 180);
    const threshold = Math.cos(halfAngleRad);

    const dx = params.attackerPosition.x - params.targetPosition.x;
    const dz = params.attackerPosition.z - params.targetPosition.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) {
      return false;
    }
    const nx = dx / len;
    const nz = dz / len;

    const fx = Math.sin(params.targetForwardYaw);
    const fz = Math.cos(params.targetForwardYaw);
    const bx = -fx;
    const bz = -fz;

    const dot = bx * nx + bz * nz;
    return dot >= threshold;
  }

  getBackstabDamageMultiplier(): number {
    const spatial = loadWorldSpatialConfig();
    return spatial.backstabDamageMultiplier ?? 1.15;
  }

  /**
   * Cartographer: distancia euclídea 3D y alcance melee combinado (jugador + hitbox mob + slack).
   */
  distance3d(a: WorldPosition, b: WorldPosition): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Distancia en plano XZ para querys de área de combate. */
  distanceXZ(a: WorldPosition, b: WorldPosition): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.hypot(dx, dz);
  }

  isWithinRadiusXZ(center: WorldPosition, point: WorldPosition, radiusMeters: number): boolean {
    if (!(radiusMeters > 0) || !Number.isFinite(radiusMeters)) {
      return false;
    }
    return this.distanceXZ(center, point) <= radiusMeters;
  }

  /** Alcance para recoger botín del suelo (`world-spatial.json`). */
  isWithinWorldDropPickupRange(character: WorldPosition, drop: WorldPosition): boolean {
    const spatial = loadWorldSpatialConfig();
    const r = spatial.worldDropPickupRadiusMeters ?? 4;
    return this.distance3d(character, drop) <= r;
  }

  isWithinNpcInteractionRange(character: WorldPosition, npc: WorldPosition): boolean {
    const spatial = loadWorldSpatialConfig();
    const r = spatial.npcInteractionRadiusMeters ?? spatial.worldDropPickupRadiusMeters ?? 4;
    return this.distance3d(character, npc) <= r;
  }

  getPlayerAutoAttackRangeMeters(): number {
    return loadWorldSpatialConfig().playerAutoAttackRangeMeters ?? 1.5;
  }

  getPlayerAutoAttackRangeBufferMeters(): number {
    return loadWorldSpatialConfig().playerAutoAttackRangeBufferMeters ?? 0.7;
  }

  getPlayerAutoAttackMaxDistanceMeters(): number {
    return this.getPlayerAutoAttackRangeMeters() + this.getPlayerAutoAttackRangeBufferMeters();
  }

  isWithinPlayerAutoAttackRange(attacker: WorldPosition, target: WorldPosition): boolean {
    return this.distance3d(attacker, target) <= this.getPlayerAutoAttackMaxDistanceMeters();
  }

  isWithinMeleeAttackRange(
    attacker: WorldPosition,
    target: WorldPosition,
    mobAttackRange: number,
  ): boolean {
    const spatial = loadWorldSpatialConfig();
    const predSlack = spatial.attackReachPredictionSlackMeters ?? 2;
    const maxReach =
      spatial.characterBaseMeleeReach +
      spatial.extraInteractionSlack +
      mobAttackRange +
      predSlack;
    return this.distance3d(attacker, target) <= maxReach;
  }

  /**
   * Skills `targetingMode: 'ranged'` (ej. fireball): distancia real contra `rangeMeters`,
   * sin el slack de contacto cuerpo a cuerpo que suma `isWithinMeleeAttackRange`.
   */
  isWithinSkillCastRange(attacker: WorldPosition, target: WorldPosition, rangeMeters: number): boolean {
    const spatial = loadWorldSpatialConfig();
    const predSlack = spatial.attackReachPredictionSlackMeters ?? 2;
    return this.distance3d(attacker, target) <= rangeMeters + predSlack;
  }

  /**
   * Melee mob → jugador: sólo `attackRange` del template + buffer de latencia.
   * `isWithinMeleeAttackRange` suma el alcance del jugador (~+5 m) y no aplica aquí.
   */
  isWithinMobToPlayerMeleeRange(
    mob: WorldPosition,
    player: WorldPosition,
    mobAttackRange: number,
  ): boolean {
    const spatial = loadWorldSpatialConfig();
    const raw = spatial.mobMeleeRangeBufferMeters ?? 0.45;
    const buffer = Number.isFinite(raw) ? Math.max(0, Math.min(1.2, raw)) : 0.45;
    const range = (Number.isFinite(mobAttackRange) ? Math.max(0.4, mobAttackRange) : 2.5) + buffer;
    return this.distance3d(mob, player) <= range;
  }

  /**
   * Unidades/s efectivas en el plano XZ a partir del stat derivado (data-driven en world-spatial.json).
   */
  getEffectiveWorldMoveSpeed(derivedAtkSpeed: number, characterClass?: string): number {
    const spatial = loadWorldSpatialConfig();
    const base = spatial.baseWorldMoveSpeed ?? 3;
    const factor = spatial.worldMoveSpeedAtkSpeedFactor ?? 1;
    const minS = spatial.worldMoveSpeedMin ?? 2;
    const maxS = spatial.worldMoveSpeedMax ?? 11;
    const atk = Number.isFinite(derivedAtkSpeed) ? derivedAtkSpeed : 1;
    const classMultiplier =
      characterClass !== undefined
        ? spatial.classWorldMoveSpeedMultiplier?.[characterClass] ?? 1
        : 1;
    const raw = base * atk * factor * classMultiplier;
    return Math.max(minS, Math.min(maxS, raw));
  }

  getMovementMinDtSeconds(): number {
    return loadWorldSpatialConfig().movementMinDtSeconds ?? 0.016;
  }

  getMovementMaxDtSeconds(): number {
    return loadWorldSpatialConfig().movementMaxDtSeconds ?? 0.45;
  }

  /**
   * Warden: recorta el destino contra obstáculos estáticos data-driven (`map-objects.json`).
   * Si el segmento entra en un muro, devuelve el punto seguro más cercano al borde.
   */
  resolveMoveTargetAgainstObstacles(params: {
    from: WorldPosition;
    to: WorldPosition;
    zoneId: string;
  }): {
    blocked: boolean;
    corrected: WorldPosition;
    obstacleId?: string;
  } {
    const { from, to, zoneId } = params;
    const obstacles = this.getMapObstaclesForZone(zoneId);
    if (obstacles.length === 0) {
      return { blocked: false, corrected: to };
    }

    let firstHitT: number | null = null;
    let firstHitObstacle: MapObstacleConfigRow | null = null;

    for (const obstacle of obstacles) {
      const rect = this.toObstacleRectXZ(obstacle);
      const fromInside = this.isPointInsideRectXZ(from, rect);
      const toInside = this.isPointInsideRectXZ(to, rect);

      if (fromInside && toInside) {
        return { blocked: true, corrected: from, obstacleId: obstacle.id };
      }

      if (fromInside && !toInside) {
        continue;
      }

      const entryT = this.getSegmentEntryTIntoRectXZ(from, to, rect);
      if (entryT === null) {
        continue;
      }

      if (firstHitT === null || entryT < firstHitT) {
        firstHitT = entryT;
        firstHitObstacle = obstacle;
      }

      if (toInside && entryT <= 0) {
        return { blocked: true, corrected: from, obstacleId: obstacle.id };
      }
    }

    if (firstHitT === null || firstHitObstacle === null) {
      return { blocked: false, corrected: to };
    }

    const segmentLen = this.distanceXZ(from, to);
    if (segmentLen < 1e-5) {
      return { blocked: true, corrected: from, obstacleId: firstHitObstacle.id };
    }

    const epsilonT = Math.min(0.08, 0.02 / segmentLen);
    const safeT = Math.max(0, firstHitT - epsilonT);
    const corrected: WorldPosition = {
      x: from.x + (to.x - from.x) * safeT,
      y: from.y + (to.y - from.y) * safeT,
      z: from.z + (to.z - from.z) * safeT,
    };
    return { blocked: true, corrected, obstacleId: firstHitObstacle.id };
  }

  /**
   * Corrige un punto dentro de un obstáculo estático empujándolo al borde más cercano.
   * Útil para respawns / bootstrap cuando un spawn queda embebido en `map-objects.json`.
   */
  resolvePointOutsideObstacles(params: {
    point: WorldPosition;
    zoneId: string;
    edgeInsetMeters?: number;
  }): {
    blocked: boolean;
    corrected: WorldPosition;
    obstacleId?: string;
  } {
    const { point, zoneId } = params;
    const edgeInsetMeters = Math.max(0.02, params.edgeInsetMeters ?? 0.05);
    const obstacles = this.getMapObstaclesForZone(zoneId);
    if (obstacles.length === 0) {
      return { blocked: false, corrected: point };
    }

    let corrected: WorldPosition = { ...point };
    let lastObstacleId: string | undefined;
    let blocked = false;

    for (let i = 0; i < 8; i += 1) {
      let containingObstacle: MapObstacleConfigRow | null = null;
      let containingRect: XzRect | null = null;
      for (const obstacle of obstacles) {
        const rect = this.toObstacleRectXZ(obstacle);
        if (this.isPointInsideRectXZ(corrected, rect)) {
          containingObstacle = obstacle;
          containingRect = rect;
          break;
        }
      }

      if (!containingObstacle || !containingRect) {
        break;
      }
      blocked = true;
      lastObstacleId = containingObstacle.id;

      const toLeft = Math.abs(corrected.x - containingRect.minX);
      const toRight = Math.abs(containingRect.maxX - corrected.x);
      const toBottom = Math.abs(corrected.z - containingRect.minZ);
      const toTop = Math.abs(containingRect.maxZ - corrected.z);
      const minDist = Math.min(toLeft, toRight, toBottom, toTop);

      if (minDist === toLeft) {
        corrected = { ...corrected, x: containingRect.minX - edgeInsetMeters };
      } else if (minDist === toRight) {
        corrected = { ...corrected, x: containingRect.maxX + edgeInsetMeters };
      } else if (minDist === toBottom) {
        corrected = { ...corrected, z: containingRect.minZ - edgeInsetMeters };
      } else {
        corrected = { ...corrected, z: containingRect.maxZ + edgeInsetMeters };
      }
    }

    return { blocked, corrected, obstacleId: lastObstacleId };
  }

  /** Leash Cartographer / Warden: radio XZ desde `MobInstance.spawnPos` (data-driven). */
  getMobAiLeashRadiusMeters(): number {
    const spatial = loadWorldSpatialConfig();
    return spatial.mobAiLeashRadiusMeters ?? 40;
  }

  getMobSocialLinkRadiusMeters(): number {
    const spatial = loadWorldSpatialConfig();
    const raw = spatial.mobSocialLinkRadiusMeters ?? 8;
    if (!Number.isFinite(raw)) {
      return 8;
    }
    return Math.max(5, Math.min(10, raw));
  }

  /** Radio de cuerpo XZ para packing / body-block entre mobs. */
  getMobBodyRadiusMeters(): number {
    const spatial = loadWorldSpatialConfig();
    const raw = spatial.mobBodyRadiusMeters ?? 0.95;
    if (!Number.isFinite(raw)) {
      return 0.95;
    }
    return Math.max(0.4, Math.min(2.5, raw));
  }

  /** Fracción de attackRange para el anillo de hold en CHASE. */
  getMobChaseRingFactor(): number {
    const spatial = loadWorldSpatialConfig();
    const raw = spatial.mobChaseRingFactor ?? 0.78;
    if (!Number.isFinite(raw)) {
      return 0.78;
    }
    return Math.max(0.45, Math.min(0.95, raw));
  }

  getNavGridCellSizeMeters(): number {
    const spatial = loadWorldSpatialConfig();
    const raw = spatial.navGridCellSizeMeters ?? 1;
    if (!Number.isFinite(raw)) {
      return 1;
    }
    return Math.max(0.5, Math.min(3, raw));
  }

  /**
   * Cartographer: pathfinding A* en grilla simple para CHASE.
   * Devuelve waypoints world-space (sin incluir el punto inicial).
   */
  findPathOnNavGrid(params: {
    zoneId: string;
    from: WorldPosition;
    to: WorldPosition;
  }): WorldPosition[] {
    const cellSize = this.getNavGridCellSizeMeters();
    const spatial = loadWorldSpatialConfig();
    const paddingCells = Math.max(2, Math.floor(spatial.navGridPaddingCells ?? 6));
    const maxExpandedNodes = Math.max(
      250,
      Math.floor(spatial.navGridMaxExpandedNodes ?? 1400),
    );
    const obstacles = this.getMapObstaclesForZone(params.zoneId);
    if (obstacles.length === 0) {
      return [{ x: params.to.x, y: params.to.y, z: params.to.z }];
    }
    const obstacleRects = obstacles.map((o) => this.toObstacleRectXZ(o));
    const minX = Math.min(params.from.x, params.to.x) - paddingCells * cellSize;
    const maxX = Math.max(params.from.x, params.to.x) + paddingCells * cellSize;
    const minZ = Math.min(params.from.z, params.to.z) - paddingCells * cellSize;
    const maxZ = Math.max(params.from.z, params.to.z) + paddingCells * cellSize;
    const toCell = (x: number, z: number): NavCell => ({
      gx: Math.round((x - minX) / cellSize),
      gz: Math.round((z - minZ) / cellSize),
    });
    const toWorld = (cell: NavCell): WorldPosition => ({
      x: minX + cell.gx * cellSize,
      y: params.to.y,
      z: minZ + cell.gz * cellSize,
    });
    const isBlockedCell = (cell: NavCell): boolean => {
      const world = toWorld(cell);
      if (
        world.x < minX ||
        world.x > maxX ||
        world.z < minZ ||
        world.z > maxZ
      ) {
        return true;
      }
      for (const rect of obstacleRects) {
        if (this.isPointInsideRectXZ(world, rect)) {
          return true;
        }
      }
      return false;
    };
    const nearestFree = (seed: NavCell): NavCell | null => {
      if (!isBlockedCell(seed)) {
        return seed;
      }
      const queue: NavCell[] = [seed];
      const visited = new Set<string>([`${seed.gx},${seed.gz}`]);
      while (queue.length > 0 && visited.size < maxExpandedNodes) {
        const cur = queue.shift()!;
        const n4: NavCell[] = [
          { gx: cur.gx + 1, gz: cur.gz },
          { gx: cur.gx - 1, gz: cur.gz },
          { gx: cur.gx, gz: cur.gz + 1 },
          { gx: cur.gx, gz: cur.gz - 1 },
        ];
        for (const n of n4) {
          const key = `${n.gx},${n.gz}`;
          if (visited.has(key)) {
            continue;
          }
          visited.add(key);
          if (!isBlockedCell(n)) {
            return n;
          }
          queue.push(n);
        }
      }
      return null;
    };
    const start = nearestFree(toCell(params.from.x, params.from.z));
    const goal = nearestFree(toCell(params.to.x, params.to.z));
    if (!start || !goal) {
      return [{ x: params.to.x, y: params.to.y, z: params.to.z }];
    }
    if (start.gx === goal.gx && start.gz === goal.gz) {
      return [{ x: params.to.x, y: params.to.y, z: params.to.z }];
    }
    const keyOf = (cell: NavCell): string => `${cell.gx},${cell.gz}`;
    const parseKey = (key: string): NavCell => {
      const [gxRaw, gzRaw] = key.split(',');
      return { gx: Number(gxRaw), gz: Number(gzRaw) };
    };
    const heuristic = (a: NavCell, b: NavCell): number =>
      Math.hypot(a.gx - b.gx, a.gz - b.gz);
    const costBetween = (a: NavCell, b: NavCell): number =>
      a.gx !== b.gx && a.gz !== b.gz ? Math.SQRT2 : 1;
    const open = new Set<string>([keyOf(start)]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[keyOf(start), 0]]);
    const fScore = new Map<string, number>([[keyOf(start), heuristic(start, goal)]]);
    let expanded = 0;
    const dirs: NavCell[] = [
      { gx: 1, gz: 0 },
      { gx: -1, gz: 0 },
      { gx: 0, gz: 1 },
      { gx: 0, gz: -1 },
      { gx: 1, gz: 1 },
      { gx: 1, gz: -1 },
      { gx: -1, gz: 1 },
      { gx: -1, gz: -1 },
    ];
    while (open.size > 0 && expanded < maxExpandedNodes) {
      expanded += 1;
      let currentKey: string | null = null;
      let currentScore = Number.POSITIVE_INFINITY;
      for (const key of open) {
        const score = fScore.get(key) ?? Number.POSITIVE_INFINITY;
        if (score < currentScore) {
          currentScore = score;
          currentKey = key;
        }
      }
      if (!currentKey) {
        break;
      }
      if (currentKey === keyOf(goal)) {
        const fullPath: WorldPosition[] = [];
        let pathKey: string | undefined = currentKey;
        while (pathKey) {
          fullPath.push(toWorld(parseKey(pathKey)));
          pathKey = cameFrom.get(pathKey);
        }
        fullPath.reverse();
        if (fullPath.length <= 1) {
          return [{ x: params.to.x, y: params.to.y, z: params.to.z }];
        }
        const waypoints = fullPath.slice(1);
        const last = waypoints[waypoints.length - 1];
        if (
          this.distanceXZ(last, { x: params.to.x, y: params.to.y, z: params.to.z }) >
          cellSize * 0.75
        ) {
          waypoints.push({ x: params.to.x, y: params.to.y, z: params.to.z });
        } else {
          waypoints[waypoints.length - 1] = {
            x: params.to.x,
            y: params.to.y,
            z: params.to.z,
          };
        }
        return waypoints;
      }
      open.delete(currentKey);
      const current = parseKey(currentKey);
      for (const d of dirs) {
        const neighbor = { gx: current.gx + d.gx, gz: current.gz + d.gz };
        if (isBlockedCell(neighbor)) {
          continue;
        }
        if (d.gx !== 0 && d.gz !== 0) {
          const sideA = { gx: current.gx + d.gx, gz: current.gz };
          const sideB = { gx: current.gx, gz: current.gz + d.gz };
          if (isBlockedCell(sideA) || isBlockedCell(sideB)) {
            continue;
          }
        }
        const neighborKey = keyOf(neighbor);
        const tentativeG =
          (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) +
          costBetween(current, neighbor);
        if (tentativeG >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
          continue;
        }
        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentativeG);
        fScore.set(neighborKey, tentativeG + heuristic(neighbor, goal));
        open.add(neighborKey);
      }
    }
    return [{ x: params.to.x, y: params.to.y, z: params.to.z }];
  }

  /**
   * Valida un segmento A→B en `dtSeconds` contra velocidad máxima (plano XZ + tope vertical por tick).
   */
  validateMovementIntent(params: {
    from: WorldPosition;
    to: WorldPosition;
    dtSeconds: number;
    maxSpeedUnitsPerSecond: number;
    /** Paquetes muy seguidos: solo tope vertical; sin tope horizontal (lag / bursts). */
    skipHorizontalSpeedCheck?: boolean;
  }): {
    accepted: boolean;
    reason?: string;
    horizontalDistance?: number;
    maxAllowedHorizontal?: number;
  } {
    const spatial = loadWorldSpatialConfig();
    const slack = spatial.movementValidationSlackRatio ?? 0.2;
    const maxDy = spatial.movementMaxVerticalStep ?? 1.4;

    const { from, to, dtSeconds, maxSpeedUnitsPerSecond, skipHorizontalSpeedCheck } =
      params;

    const dy = Math.abs(to.y - from.y);
    if (dy > maxDy) {
      return { accepted: false, reason: 'VERTICAL_TELEPORT' };
    }

    if (skipHorizontalSpeedCheck) {
      return { accepted: true };
    }

    if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds)) {
      return { accepted: false, reason: 'INVALID_DT' };
    }

    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const horizontal = Math.hypot(dx, dz);
    const maxHoriz = maxSpeedUnitsPerSecond * dtSeconds * (1 + slack);

    if (horizontal > maxHoriz) {
      return {
        accepted: false,
        reason: 'SPEED_OR_TELEPORT',
        horizontalDistance: horizontal,
        maxAllowedHorizontal: maxHoriz,
      };
    }

    return { accepted: true };
  }

  private getMapObstaclesForZone(zoneId: string): MapObstacleConfigRow[] {
    const rows = loadMapObjectsConfig().objects ?? [];
    const z = normalizeZoneId(zoneId);
    return rows.filter((row): row is MapObstacleConfigRow => {
      if (!isMapBoxBlockingMovement(row)) {
        return false;
      }
      if (!row.zoneId) {
        return true;
      }
      return normalizeZoneId(row.zoneId) === z;
    });
  }

  private toObstacleRectXZ(obstacle: MapObstacleConfigRow): XzRect {
    const padding = Math.max(0, obstacle.collisionPaddingMeters ?? 0);
    const halfX = Math.max(0, obstacle.scale.x / 2) + padding;
    const halfZ = Math.max(0, obstacle.scale.z / 2) + padding;
    return {
      minX: obstacle.position.x - halfX,
      maxX: obstacle.position.x + halfX,
      minZ: obstacle.position.z - halfZ,
      maxZ: obstacle.position.z + halfZ,
    };
  }

  private isPointInsideRectXZ(point: WorldPosition, rect: XzRect): boolean {
    return (
      point.x >= rect.minX &&
      point.x <= rect.maxX &&
      point.z >= rect.minZ &&
      point.z <= rect.maxZ
    );
  }

  /**
   * Slab test 2D (XZ): devuelve el primer t [0..1] donde el segmento entra al rectángulo.
   */
  private getSegmentEntryTIntoRectXZ(
    from: WorldPosition,
    to: WorldPosition,
    rect: XzRect,
  ): number | null {
    let tMin = 0;
    let tMax = 1;
    const dx = to.x - from.x;
    const dz = to.z - from.z;

    if (Math.abs(dx) < 1e-7) {
      if (from.x < rect.minX || from.x > rect.maxX) {
        return null;
      }
    } else {
      const tx1 = (rect.minX - from.x) / dx;
      const tx2 = (rect.maxX - from.x) / dx;
      const txMin = Math.min(tx1, tx2);
      const txMax = Math.max(tx1, tx2);
      tMin = Math.max(tMin, txMin);
      tMax = Math.min(tMax, txMax);
      if (tMin > tMax) {
        return null;
      }
    }

    if (Math.abs(dz) < 1e-7) {
      if (from.z < rect.minZ || from.z > rect.maxZ) {
        return null;
      }
    } else {
      const tz1 = (rect.minZ - from.z) / dz;
      const tz2 = (rect.maxZ - from.z) / dz;
      const tzMin = Math.min(tz1, tz2);
      const tzMax = Math.max(tz1, tz2);
      tMin = Math.max(tMin, tzMin);
      tMax = Math.min(tMax, tzMax);
      if (tMin > tMax) {
        return null;
      }
    }

    if (tMax < 0 || tMin > 1) {
      return null;
    }
    return Math.max(0, Math.min(1, tMin));
  }
}
