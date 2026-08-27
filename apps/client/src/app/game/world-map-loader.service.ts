import { Injectable, NgZone, inject, signal } from '@angular/core';

export type MapBoxConfigRow = {
  id: string;
  zoneId?: string;
  kind?: 'box';
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  collisionPaddingMeters?: number;
  /** Weaver: clave de `.glb` en `prop-visual-catalog`. El Warden ignora el mesh. */
  propTemplateKey?: string;
  /** Yaw visual (radianes). No rota el AABB de colisión. */
  yaw?: number;
  /** `false` = deco caminable (senderos y micro-props). Default bloquea. */
  blocksMovement?: boolean;
};

export type MapPortalConfigRow = {
  id: string;
  zoneId?: string;
  kind: 'portal';
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  targetZoneId: string;
  portalTravelMessage?: string;
  interactionRadiusMeters?: number;
  propTemplateKey?: string;
  yaw?: number;
};

export type MapObstacleConfigRow = MapBoxConfigRow | MapPortalConfigRow;

type MapObjectsFile = {
  version?: number;
  objects?: unknown[];
};

type WorldZoneMeta = {
  zoneId: string;
  mapObjectsFile: string;
  groundAlbedo?: string;
  groundSizeMeters?: number;
};

type WorldZonesFile = {
  zones?: Array<WorldZoneMeta>;
};

function isFiniteVec3(p: { x: unknown; y: unknown; z: unknown }): boolean {
  return (
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    typeof p.z === 'number' &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.z)
  );
}

function normalizeZoneId(z: string | null | undefined): string {
  if (z === null || z === undefined || z === '' || z === 'default') {
    return 'Zone_0';
  }
  return z;
}

/**
 * Weaver / Cartographer: catálogo de zonas + map-objects **por zona**.
 * Zone_1 (nieve) no se pide hasta `ensureZoneLoaded('Zone_1')` (portal / snapshot).
 */
@Injectable({ providedIn: 'root' })
export class WorldMapLoaderService {
  private readonly zone = inject(NgZone);
  private catalogPromise: Promise<void> | null = null;
  private readonly zoneMetaById = new Map<string, WorldZoneMeta>();
  private readonly rowsByZoneId = new Map<string, MapObstacleConfigRow[]>();
  private readonly zoneLoadInFlight = new Map<string, Promise<void>>();

  /** Filas de zonas ya pedidas (cada fila lleva `zoneId`). */
  readonly staticMapRows = signal<MapObstacleConfigRow[]>([]);
  /** Albedo de suelo por zona (`groundAlbedo` de `world-zones.json`). */
  readonly groundAlbedoByZoneId = signal<Readonly<Record<string, string>>>({});
  /** Lado del plano jugable por zona (`groundSizeMeters`). */
  readonly groundSizeByZoneId = signal<Readonly<Record<string, number>>>({});
  /** Incrementa en cada carga exitosa o fallida (para efectos que dependan del ciclo de vida). */
  readonly loadGeneration = signal(0);
  readonly lastLoadError = signal<string | null>(null);

  /** Catálogo (`world-zones.json`). No baja map-objects ni texturas de nieve. */
  loadCatalog(): Promise<void> {
    if (!this.catalogPromise) {
      this.catalogPromise = this.loadCatalogOnce();
    }
    return this.catalogPromise;
  }

  /**
   * Compat: sólo el catálogo. Los map-objects se piden con `ensureZoneLoaded`.
   * @deprecated Preferir `loadCatalog` + `ensureZoneLoaded`.
   */
  loadAll(): Promise<void> {
    return this.loadCatalog();
  }

  isZoneLoaded(zoneId: string | null | undefined): boolean {
    return this.rowsByZoneId.has(normalizeZoneId(zoneId));
  }

  /** Idempotente. Cachea el JSON de esa zona; no descarga las demás. */
  ensureZoneLoaded(zoneId: string | null | undefined): Promise<void> {
    const id = normalizeZoneId(zoneId);
    if (this.rowsByZoneId.has(id)) {
      return Promise.resolve();
    }
    const pending = this.zoneLoadInFlight.get(id);
    if (pending) {
      return pending;
    }
    const job = this.loadZoneOnce(id).finally(() => {
      this.zoneLoadInFlight.delete(id);
    });
    this.zoneLoadInFlight.set(id, job);
    return job;
  }

  private bumpRows(err: string | null): void {
    const merged: MapObstacleConfigRow[] = [];
    for (const rows of this.rowsByZoneId.values()) {
      merged.push(...rows);
    }
    this.zone.run(() => {
      this.staticMapRows.set(merged);
      this.lastLoadError.set(err);
      this.loadGeneration.update((g) => g + 1);
    });
  }

  private parseJsonFile(text: string, label: string): unknown {
    const t = text.trim();
    if (t.startsWith('<') || (t.length > 0 && t[0] !== '{' && t[0] !== '[')) {
      throw new Error(`${label}: respuesta no es JSON (¿404 → index.html?)`);
    }
    return JSON.parse(text) as unknown;
  }

  private async loadCatalogOnce(): Promise<void> {
    this.zone.run(() => this.lastLoadError.set(null));
    try {
      const wzRes = await fetch('/config/world-zones.json', { cache: 'no-cache' });
      if (!wzRes.ok) {
        const msg = `world-zones.json HTTP ${wzRes.status}`;
        console.warn(`[WorldMapLoader] ${msg}`);
        this.zone.run(() => {
          this.lastLoadError.set(msg);
          this.loadGeneration.update((g) => g + 1);
        });
        return;
      }
      const wzText = await wzRes.text();
      const wzParsed = this.parseJsonFile(wzText, 'world-zones.json') as WorldZonesFile;
      if (!Array.isArray(wzParsed.zones)) {
        this.zone.run(() => {
          this.lastLoadError.set('world-zones.json: falta zones[]');
          this.loadGeneration.update((g) => g + 1);
        });
        return;
      }
      const groundAlbedoByZoneId: Record<string, string> = {};
      const groundSizeByZoneId: Record<string, number> = {};
      this.zoneMetaById.clear();
      for (const z of wzParsed.zones) {
        if (!z?.mapObjectsFile || !z.zoneId) {
          continue;
        }
        this.zoneMetaById.set(z.zoneId, z);
        if (typeof z.groundAlbedo === 'string' && z.groundAlbedo.trim()) {
          groundAlbedoByZoneId[z.zoneId] = z.groundAlbedo.trim();
        }
        if (typeof z.groundSizeMeters === 'number' && Number.isFinite(z.groundSizeMeters)) {
          groundSizeByZoneId[z.zoneId] = z.groundSizeMeters;
        }
      }
      this.zone.run(() => {
        this.groundAlbedoByZoneId.set(groundAlbedoByZoneId);
        this.groundSizeByZoneId.set(groundSizeByZoneId);
        this.lastLoadError.set(null);
        this.loadGeneration.update((g) => g + 1);
      });
    } catch (e) {
      console.warn('[WorldMapLoader] Error cargando catálogo de zonas', e);
      this.zone.run(() => {
        this.lastLoadError.set(e instanceof Error ? e.message : String(e));
        this.loadGeneration.update((g) => g + 1);
      });
    }
  }

  private async loadZoneOnce(zoneId: string): Promise<void> {
    await this.loadCatalog();
    if (this.rowsByZoneId.has(zoneId)) {
      return;
    }
    const meta = this.zoneMetaById.get(zoneId);
    if (!meta) {
      console.warn(`[WorldMapLoader] Zona desconocida: ${zoneId}`);
      this.bumpRows(`zona desconocida: ${zoneId}`);
      return;
    }
    try {
      const mr = await fetch(`/config/${meta.mapObjectsFile}`, { cache: 'no-cache' });
      if (!mr.ok) {
        console.warn(`[WorldMapLoader] ${meta.mapObjectsFile} HTTP ${mr.status}`);
        this.bumpRows(`${meta.mapObjectsFile} HTTP ${mr.status}`);
        return;
      }
      const rawText = await mr.text();
      const rawParsed = this.parseJsonFile(rawText, meta.mapObjectsFile) as MapObjectsFile;
      const rows = Array.isArray(rawParsed.objects) ? rawParsed.objects : [];
      const parsed: MapObstacleConfigRow[] = [];
      for (const o of rows) {
        const row = this.parseObjectRow(o, zoneId);
        if (row) {
          parsed.push(row);
        }
      }
      this.rowsByZoneId.set(zoneId, parsed);
      this.bumpRows(null);
    } catch (e) {
      console.warn(`[WorldMapLoader] Error cargando ${meta.mapObjectsFile}`, e);
      this.bumpRows(e instanceof Error ? e.message : String(e));
    }
  }

  private parseObjectRow(o: unknown, fallbackZoneId: string): MapObstacleConfigRow | null {
    if (!o || typeof o !== 'object' || typeof (o as { id?: unknown }).id !== 'string') {
      return null;
    }
    const kind = (o as { kind?: string }).kind === 'portal' ? 'portal' : 'box';
    const pos = (o as { position?: unknown }).position as { x: number; y: number; z: number };
    const scale = (o as { scale?: unknown }).scale as { x: number; y: number; z: number };
    if (!isFiniteVec3(pos) || !isFiniteVec3(scale)) {
      return null;
    }
    const base = o as MapBoxConfigRow;
    const zoneIdRow = base.zoneId ?? fallbackZoneId;
    if (kind === 'portal') {
      const p = o as MapPortalConfigRow;
      return {
        ...p,
        kind: 'portal',
        zoneId: zoneIdRow,
        position: pos,
        scale,
        targetZoneId: String(p.targetZoneId ?? ''),
      };
    }
    return {
      ...base,
      kind: 'box',
      zoneId: zoneIdRow,
      position: pos,
      scale,
    };
  }
}
