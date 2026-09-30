import { PerfHud, warnIfSoftwareRenderer } from './perf-hud';
import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { NpcShopUiService } from '../core/npc-shop-ui.service';
import { PlayerCharacterStateService } from '../core/player-character-state.service';
import { WorldSocketService } from '../core/world-socket.service';
import { CharacterSheetPanelComponent } from '../ui/progress/character-sheet-panel.component';
import { InventoryPanelComponent } from '../ui/progress/inventory-panel.component';
import { SystemLogPanelComponent } from '../ui/progress/system-log-panel.component';
import { PlayerHpBarComponent } from '../ui/progress/player-hp-bar.component';
import { NpcShopPanelComponent } from '../ui/progress/npc-shop-panel.component';
import { SynthesisComponent } from '../ui/progress/synthesis.component';
import {
  TargetFrameComponent,
  type TargetFrameViewModel,
  type TargetDropPreviewItemViewModel,
} from '../ui/progress/target-frame.component';
import { XpBarComponent } from '../ui/progress/xp-bar.component';
import {
  WorldEntitySyncService,
  type MobEntityState,
  type NpcEntityState,
  type OtherPlayerEntityState,
  type WorldDropEntityState,
} from './world-entity-sync.service';
import {
  WorldMapLoaderService,
  type MapBoxConfigRow,
  type MapPortalConfigRow,
} from './world-map-loader.service';
import {
  EntityVisualFactoryService,
  BOX,
  DROP_Y_LIFT,
  MOB_AGGRO_COLOR,
  MOB_COLOR,
  PLAYER_COLOR,
  Y_LIFT,
  type EntityVisual,
} from './entity-visual-factory.service';
import { MobVisualInterp } from './mob-visual-interp';
import { WorldCombatFloaters } from './world-combat-floaters';
import { environment } from '../../environments/environment';
import type {
  WsAttackMobRewardsPayload,
  WsMobDropPreviewItemPayload,
  WsPlayerDeathPayload,
} from '../../../../../libs/shared-types/src/world-socket';

const STORAGE_CHARACTER = 'aetheris.characterId';
const STORAGE_SERVER = 'aetheris.worldSocketUrl';

const KARMA_NAME_COLORS = {
  WHITE: '#f4f7ff',
  PURPLE: '#bf8cff',
  RED: '#ff5d5d',
} as const;

/** Si la tienda está abierta y el jugador se aleja más que esto (XZ), se cierra la UI. */
const SHOP_AUTO_CLOSE_DISTANCE_M = 5;

/** Diagnóstico movimiento: aislar cliente vs validación servidor (ver constantes abajo). */
const MOVE_EMIT_MS = 200;

/**
 * Si es true: no aplicar PLAYER_MOVED del servidor para el propio characterId y no
 * suavizar el cubo hacia authoritative cuando no hay click (evita tirones por eco/reconciliación).
 */
const DIAG_MOVEMENT_ISOLATE_CLIENT = true;
const ISO_OFFSET = new THREE.Vector3(13, 11, 13);

/** Reconciliación: por debajo de esto, confiamos en predicción local (plano XZ). */
const SERVER_SYNC_THRESHOLD_XZ = 1.5;
/** Duración del suavizado cuando el servidor corrige posición con error ≥ umbral. */
const CORRECTION_LERP_MS = 200;
/** Por debajo de esto (XZ) no acercamos el cubo al authoritative: evita micro-tirones con cada eco. */
const BLEND_AUTH_DEAD_ZONE_XZ = 1.5;
const MOB_MOVE_ANIM_ON_MPS = 0.55;
const MOB_MOVE_ANIM_OFF_MPS = 0.22;
const CAMERA_FOLLOW_SMOOTH = 0.065;
const CAMERA_POS_SMOOTH = 0.055;
const CLICK_DRAG_THRESHOLD_PX = 5;
const CAMERA_ROTATE_SENSITIVITY = 0.0075;
const CAMERA_POLAR_MIN = 0.28;
const CAMERA_POLAR_MAX = 1.5;
const CAMERA_ZOOM_MIN_RADIUS = 5;
const CAMERA_ZOOM_MAX_RADIUS = 40;
const CAMERA_ZOOM_WHEEL_STEP = 1.25;
const CAMERA_ZOOM_SMOOTH = 0.14;
const CAMERA_COLLISION_MARGIN = 0.2;
const CAMERA_COLLISION_MIN_RADIUS = 2.5;
const BASIC_ATTACK_RANGE_METERS = 1.5;
/** Reintento del golpe a jugadores mientras siga el objetivo (el servidor aplica el enfriamiento real). */
const PLAYER_AUTO_ATTACK_INTERVAL_MS = 250;
const PLAYER_ATTACK_MIN_GAP_MS = 750;
/** Holgura visual cliente vs attackRange autoritativo (interpolación). */
const MOB_MELEE_VISUAL_SLACK_METERS = 0.55;
const HEALTH_POTION_CATALOG_KEY = 'health_potion_small';
const MANA_POTION_CATALOG_KEY = 'mana_potion_small';
/**
 * Cooldown de consumibles: el servidor comparte UNO solo entre TODOS los consumibles
 * por personaje (`CONSUMABLE_USE_COOLDOWN_MS` en player-combat-runtime.service.ts) —
 * tomar una poción de vida también frena la de maná por este mismo tiempo. Se refleja
 * igual acá para que el overlay de cooldown de la barra no mienta.
 */
const POTION_COOLDOWN_MS = 1000;
const SKILL_LOCAL_RULES = {
  power_strike: { name: 'Power Strike', manaCost: 15, cooldownMs: 2000, rangeMeters: 2 },
  rageful_blow: { name: 'Rageful Blow', manaCost: 30, cooldownMs: 5000, rangeMeters: 2 },
} as const;
type SkillHotkeyId = keyof typeof SKILL_LOCAL_RULES;

type ActionBarSlot = {
  hotkey: '1' | '2' | '3' | '4' | '5';
  label: string;
  iconGlyph: string;
  skillId: SkillHotkeyId | null;
  isBasic: boolean;
  /** Si está presente, el slot usa este consumible del inventario en vez de una skill. */
  potionCatalogKey?: string;
  /** Nombre corto del consumible, para el mensaje de "no te quedan ...". */
  potionLabel?: string;
};

type ActiveSlashFx = {
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  startedAt: number;
  durationMs: number;
};

type BurstParticle = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
};

type ActiveBurstFx = {
  particles: BurstParticle[];
  startedAt: number;
  durationMs: number;
};

type PendingCombatAction =
  | {
      kind: 'basic';
      label: string;
      rangeMeters: number;
      targetId: string;
    }
  | {
      kind: 'skill';
      label: string;
      rangeMeters: number;
      targetId: string;
      skillId: SkillHotkeyId;
    };

function pickUserDataString(object: THREE.Object3D, key: string): string | undefined {
  let node: THREE.Object3D | null = object;
  while (node) {
    const value = node.userData[key];
    if (typeof value === 'string') {
      return value;
    }
    node = node.parent;
  }
  return undefined;
}

function normalizeZoneIdForUi(z: string | null | undefined): string {
  if (z === null || z === undefined || z === '' || z === 'default') {
    return 'Zone_0';
  }
  return z;
}

type ObstacleRectXZ = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

/** Primera entrada del rayo al AABB (t ≥ 0). `null` si el origen está dentro o no hay hit. */
function rayAabbEnterT(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: ObstacleRectXZ,
  maxDist: number,
): number | null {
  const invX = Math.abs(dx) > 1e-8 ? 1 / dx : dx >= 0 ? 1e15 : -1e15;
  const invY = Math.abs(dy) > 1e-8 ? 1 / dy : dy >= 0 ? 1e15 : -1e15;
  const invZ = Math.abs(dz) > 1e-8 ? 1 / dz : dz >= 0 ? 1e15 : -1e15;
  const tx1 = (box.minX - ox) * invX;
  const tx2 = (box.maxX - ox) * invX;
  const ty1 = (box.minY - oy) * invY;
  const ty2 = (box.maxY - oy) * invY;
  const tz1 = (box.minZ - oz) * invZ;
  const tz2 = (box.maxZ - oz) * invZ;
  const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
  const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
  if (tmax < tmin || tmax < 0 || tmin > maxDist) {
    return null;
  }
  if (tmin < 0) {
    return null;
  }
  return tmin;
}

const ACTION_BAR_SLOTS: readonly ActionBarSlot[] = [
  { hotkey: '1', label: 'Atk', iconGlyph: '⚔', skillId: null, isBasic: true },
  {
    hotkey: '2',
    label: 'Power Strike',
    iconGlyph: '✦',
    skillId: 'power_strike',
    isBasic: false,
  },
  {
    hotkey: '3',
    label: 'Rageful Blow',
    iconGlyph: '🌀',
    skillId: 'rageful_blow',
    isBasic: false,
  },
  {
    hotkey: '4',
    label: 'Poción HP',
    iconGlyph: '🧪',
    skillId: null,
    isBasic: false,
    potionCatalogKey: HEALTH_POTION_CATALOG_KEY,
    potionLabel: 'Pociones de Vida',
  },
  {
    hotkey: '5',
    label: 'Poción MP',
    iconGlyph: '🔮',
    skillId: null,
    isBasic: false,
    potionCatalogKey: MANA_POTION_CATALOG_KEY,
    potionLabel: 'Pociones de Maná',
  },
] as const;
const DEFAULT_CAMERA_RADIUS = ISO_OFFSET.length();
const DEFAULT_CAMERA_AZIMUTH = Math.atan2(ISO_OFFSET.x, ISO_OFFSET.z);
const DEFAULT_CAMERA_POLAR = Math.acos(ISO_OFFSET.y / DEFAULT_CAMERA_RADIUS);
const MOB_HIT_FLASH_MS = 100;
const SKILL_CAMERA_SHAKE_MS = 200;
const SKILL_CAMERA_SHAKE_STRENGTH = 0.12;
const POWER_STRIKE_SLASH_MS = 130;
const RAGEFUL_BLOW_BURST_MS = 420;
const RAGEFUL_BLOW_AOE_RADIUS = 3.5;
const RAGEFUL_BLOW_PARTICLES = 24;
const AUTO_ATTACK_RESUME_EMIT_MS = 250;
const WEAPON_SWING_MS = 180;

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

function isFiniteYaw(y: unknown): y is number {
  return typeof y === 'number' && Number.isFinite(y);
}

@Component({
  selector: 'app-game-viewport',
  standalone: true,
  imports: [
    FormsModule,
    CharacterSheetPanelComponent,
    InventoryPanelComponent,
    SystemLogPanelComponent,
    PlayerHpBarComponent,
    TargetFrameComponent,
    XpBarComponent,
    NpcShopPanelComponent,
    SynthesisComponent,
  ],
  templateUrl: './game-viewport.component.html',
  styleUrl: './game-viewport.component.scss',
})
export class GameViewportComponent implements AfterViewInit, OnDestroy {
  @ViewChild('viewport', { static: true }) viewportRef!: ElementRef<HTMLDivElement>;

  readonly worldSocket = inject(WorldSocketService);
  readonly playerState = inject(PlayerCharacterStateService);
  private readonly npcShopUi = inject(NpcShopUiService);
  private readonly entitySync = inject(WorldEntitySyncService);
  private readonly mapLoader = inject(WorldMapLoaderService);
  private readonly visuals = inject(EntityVisualFactoryService);
  private readonly destroyRef = inject(DestroyRef);

  serverUrlModel = localStorage.getItem(STORAGE_SERVER) ?? environment.worldSocketUrl;
  characterIdModel = localStorage.getItem(STORAGE_CHARACTER) ?? '';
  /** Línea tipo chat para comandos GM locales (personaje con `isAdmin` en DB). */
  gmCommandLine = '';
  /** Solo visible si `playerState.isSessionAdmin()` y el jugador pulsa `Y`. */
  readonly gmBarVisible = signal(false);

  lastDenied = signal<string | null>(null);
  readonly inventoryPanelOpen = signal(true);
  readonly characterSheetOpen = signal(true);
  readonly synthesisPanelOpen = signal(true);

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private css2d!: CSS2DRenderer;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly simTimer = new THREE.Timer();

  private groundMesh!: THREE.Mesh;
  private groundGrid: THREE.GridHelper | null = null;
  private playerMesh: EntityVisual | null = null;
  private readonly mobMeshes = new Map<string, EntityVisual>();
  /** Suavizado Weaver: posición visual hacia la autoritativa (mismo enfoque que el jugador). */
  private readonly mobSmoothedPos = new Map<string, THREE.Vector3>();
  private readonly mobSmoothedYaw = new Map<string, number>();
  private readonly mobInterp = new MobVisualInterp();
  private readonly mobVisualMoving = new Set<string>();
  private readonly mobHitFlashUntilMs = new Map<string, number>();
  /** Primer frame con datos válidos: set duro sin lerp (evita NaN desde estado vacío). */
  private readonly mobPendingHardSnap = new Set<string>();
  private readonly npcMeshes = new Map<string, THREE.Object3D>();
  /** NPC cuya caja está abierta (clic de tienda); se cierra al cerrar el panel. */
  private merchantBoxNpcId: string | null = null;
  private readonly dropMeshes = new Map<string, THREE.Mesh>();
  private readonly otherPlayerMeshes = new Map<string, EntityVisual>();
  private readonly otherPlayerLastPos = new Map<string, THREE.Vector3>();
  private readonly weaponSwingUntilByCharacterId = new Map<string, number>();
  private readonly damageFloatGroup = new THREE.Group();
  private combatFloaters: WorldCombatFloaters | null = null;
  private readonly skillFxRoot = new THREE.Group();
  private readonly activeSlashFxs: ActiveSlashFx[] = [];
  private readonly activeBurstFxs: ActiveBurstFx[] = [];
  private mobRoot!: THREE.Group;
  private npcRoot!: THREE.Group;
  private dropsRoot!: THREE.Group;
  private otherPlayersRoot!: THREE.Group;
  private obstacleRoot!: THREE.Group;
  private portalRoot!: THREE.Group;
  private readonly obstacleMeshes = new Map<string, THREE.Object3D>();
  private readonly portalMeshes = new Map<string, THREE.Object3D>();
  private readonly obstacleRects = new Map<string, ObstacleRectXZ>();
  private portalTravelFadeArmed = false;
  readonly zoneTransitionFadeOn = signal(false);

  /** Muerte propia: no nula = pantalla de muerte activa esperando `REQUEST_RESPAWN`. */
  readonly deathState = signal<WsPlayerDeathPayload | null>(null);
  readonly respawnPending = signal(false);

  private readonly visualPos = new THREE.Vector3();
  private readonly authoritativePos = new THREE.Vector3();
  private authoritativeYaw = 0;
  private visualYaw = 0;
  private moveTarget: THREE.Vector3 | null = null;
  private moveIntentDirty = false;
  private lastMoveEmitMs = 0;
  private readonly lastEmittedPos = new THREE.Vector3(Number.NaN, 0, 0);
  private lastEmittedYaw = Number.NaN;

  private readonly cameraLookAt = new THREE.Vector3();
  private readonly tmpFollow = new THREE.Vector3();
  private readonly floaterPos = new THREE.Vector3();
  private readonly desiredCamPos = new THREE.Vector3();
  private readonly desiredCamPosCollisionResolved = new THREE.Vector3();
  private readonly cameraOrbitOffset = new THREE.Vector3();
  private readonly cameraCollisionDir = new THREE.Vector3();
  private cameraShake: { startedAt: number; endsAt: number; strength: number } | null = null;
  private cameraRadius = DEFAULT_CAMERA_RADIUS;
  private cameraRadiusTarget = DEFAULT_CAMERA_RADIUS;
  private cameraAzimuthAngle = DEFAULT_CAMERA_AZIMUTH;
  private cameraPolarAngle = DEFAULT_CAMERA_POLAR;
  private leftPointerDown = false;
  private leftPointerIsDrag = false;
  private readonly leftPointerDownClient = new THREE.Vector2();
  private readonly leftPointerLastClient = new THREE.Vector2();

  private readonly glReady = signal(false);
  private resizeObserver?: ResizeObserver;
  private raf = 0;
  private perfHud: PerfHud | null = null;

  /** Feedback visual: golpe propio conectó (daño > 0). */
  private meleeHitFlashUntilMs = 0;
  /** Feedback visual: curación por consumible (flash verde). */
  private healFlashUntilMs = 0;

  /** Lerp rápido tras PLAYER_POSITION_CORRECTED (error ≥ umbral). */
  private correctionLerp: {
    startTime: number;
    durationMs: number;
    startVisual: THREE.Vector3;
    startYaw: number;
    target: THREE.Vector3;
    targetYaw: number;
  } | null = null;
  private activeTargetId: string | null = null;
  private activePlayerTargetId: string | null = null;
  /** Último HP conocido de jugadores golpeados (el servidor no publica su HP máximo). */
  private readonly playerTargetHp = new Map<string, number>();
  private playerAutoAttackTimer: ReturnType<typeof setInterval> | null = null;
  /** Instante del último golpe a jugador sin respuesta; evita acumular cola si el servidor tarda. */
  private playerAttackAwaitingSinceMs: number | null = null;
  localCurrentMp = 0;
  localMaxMp = 0;
  private readonly localSkillCooldownUntil = new Map<string, number>();
  /** Último uso de CUALQUIER consumible; el cooldown real del servidor es compartido. */
  private lastPotionUseAtMs = 0;
  readonly actionBarSlots = ACTION_BAR_SLOTS;
  readonly cooldownNowMs = signal(0);
  readonly chaseFeedback = signal<string | null>(null);
  private pendingCombatAction: PendingCombatAction | null = null;
  private autoAttackIntentTargetId: string | null = null;
  private autoAttackServerTargetId: string | null = null;
  private lastAutoAttackIntentEmitMs = 0;
  readonly targetDropPreviewOpen = signal(false);
  readonly targetDropPreviewLoading = signal(false);
  readonly targetDropPreviewError = signal<string | null>(null);
  readonly targetDropPreviewLevelPenalty = signal(false);
  readonly targetDropPreviewItems = signal<TargetDropPreviewItemViewModel[]>([]);
  private targetDropPreviewMobId: string | null = null;
  private cooldownTickerId: number | null = null;
  private readonly onWindowKeyDown = (ev: KeyboardEvent) => this.handleSkillHotkeys(ev);
  private readonly onCanvasPointerDownBound = (ev: PointerEvent) => this.onCanvasPointerDown(ev);
  private readonly onCanvasPointerMoveBound = (ev: PointerEvent) => this.onCanvasPointerMove(ev);
  private readonly onCanvasPointerUpBound = (ev: PointerEvent) => this.onCanvasPointerUp(ev);
  private readonly onCanvasPointerCancelBound = (ev: PointerEvent) => this.onCanvasPointerCancel(ev);
  private readonly onCanvasWheelBound = (ev: WheelEvent) => this.onCanvasWheel(ev);

  constructor() {
    effect(() => {
      const shop = this.npcShopUi.shop();
      if (shop) {
        this.merchantBoxNpcId = shop.npcInstanceId;
        return;
      }
      if (!this.merchantBoxNpcId) {
        return;
      }
      this.visuals.playNpcShopClose(this.npcMeshes.get(this.merchantBoxNpcId));
      this.merchantBoxNpcId = null;
    });
    this.worldSocket.zoneSnapshot$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => {
      this.mobSmoothedPos.clear();
      this.mobSmoothedYaw.clear();
      this.mobVisualMoving.clear();
      this.mobInterp.clear();
      this.mobPendingHardSnap.clear();
      this.mobHitFlashUntilMs.clear();
      this.clearSkillFx();
      this.cameraShake = null;
      this.entitySync.applyZoneSnapshot(s);
      const wp = s.self.worldPos;
      const useSnap = isFiniteVec3(wp);
      if (!useSnap) {
        console.warn(
          '[GameViewport] Snapshot self.worldPos inválido; usando última autoritativa u origen',
        );
      }
      const sx = useSnap
        ? wp.x
        : Number.isFinite(this.authoritativePos.x)
          ? this.authoritativePos.x
          : 0;
      const sy = useSnap
        ? wp.y
        : Number.isFinite(this.authoritativePos.y)
          ? this.authoritativePos.y
          : 0;
      const sz = useSnap
        ? wp.z
        : Number.isFinite(this.authoritativePos.z)
          ? this.authoritativePos.z
          : 0;
      this.authoritativePos.set(sx, sy, sz);
      this.authoritativeYaw = isFiniteYaw(s.self.worldFacingYaw) ? s.self.worldFacingYaw : 0;
      /* Siempre alinear vista con el servidor al entrar en zona: si no, el primer
       * maybeEmitMoveSample (firstSample) envía una posición vieja y el Warden rechaza. */
      this.visualPos.copy(this.authoritativePos);
      this.visualYaw = this.authoritativeYaw;
      this.moveTarget = null;
      this.correctionLerp = null;
      this.lastEmittedPos.copy(this.visualPos);
      this.lastEmittedYaw = this.visualYaw;
      this.lastMoveEmitMs = performance.now();
      this.localCurrentMp =
        typeof s.self.currentMp === 'number' && Number.isFinite(s.self.currentMp)
          ? s.self.currentMp
          : this.localCurrentMp;
      this.localMaxMp =
        typeof s.self.maxMp === 'number' && Number.isFinite(s.self.maxMp)
          ? s.self.maxMp
          : this.localMaxMp;
      if (this.portalTravelFadeArmed) {
        this.portalTravelFadeArmed = false;
        setTimeout(() => this.zoneTransitionFadeOn.set(false), 140);
      }
      this.activeTargetId = null;
      this.activePlayerTargetId = null;
      this.resetDropPreviewState();
      this.cancelCombatChase();
      this.localSkillCooldownUntil.clear();
      this.cameraLookAt.set(sx, sy + Y_LIFT, sz);
      this.updateDesiredCameraPosition();
      if (this.camera) {
        this.camera.position.copy(this.desiredCamPos);
      }
    });

    this.worldSocket.playerMoved$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const self = this.entitySync.selfCharacterId();
      if (DIAG_MOVEMENT_ISOLATE_CLIENT && p.characterId === self) {
        return;
      }
      this.entitySync.applyPlayerMoved(p);
      if (p.characterId === self) {
        /* Eco propio: authoritative = servidor; el cubo visual no se mueve desde este evento. */
        if (!isFiniteVec3(p.worldPos)) {
          return;
        }
        this.authoritativePos.set(p.worldPos.x, p.worldPos.y, p.worldPos.z);
        this.authoritativeYaw = isFiniteYaw(p.worldFacingYaw) ? p.worldFacingYaw : this.authoritativeYaw;
        return;
      }
    });

    this.worldSocket.playerPositionCorrected$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((c) => {
        if (!isFiniteVec3(c.worldPos)) {
          return;
        }
        const dx = this.visualPos.x - c.worldPos.x;
        const dz = this.visualPos.z - c.worldPos.z;
        const distXZ = Math.hypot(dx, dz);
        this.entitySync.applyPositionCorrected(c);
        this.authoritativePos.set(c.worldPos.x, c.worldPos.y, c.worldPos.z);
        this.authoritativeYaw = isFiniteYaw(c.worldFacingYaw) ? c.worldFacingYaw : this.authoritativeYaw;
        this.moveTarget = null;
        if (distXZ < SERVER_SYNC_THRESHOLD_XZ) {
          this.correctionLerp = null;
          this.lastEmittedPos.copy(this.visualPos);
          this.lastEmittedYaw = this.visualYaw;
          this.lastMoveEmitMs = performance.now();
          return;
        }
        const now = performance.now();
        this.correctionLerp = {
          startTime: now,
          durationMs: CORRECTION_LERP_MS,
          startVisual: this.visualPos.clone(),
          startYaw: this.visualYaw,
          target: new THREE.Vector3(c.worldPos.x, c.worldPos.y, c.worldPos.z),
          targetYaw: c.worldFacingYaw,
        };
        this.lastDenied.set(`Posición corregida: ${c.reason}`);
      });

    this.worldSocket.playerVitals$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      if (typeof p.currentMp === 'number' && Number.isFinite(p.currentMp)) {
        this.localCurrentMp = p.currentMp;
      }
      if (typeof p.maxMp === 'number' && Number.isFinite(p.maxMp)) {
        this.localMaxMp = p.maxMp;
      }
    });

    this.worldSocket.combatTargetResult$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => {
        if (!r.ok) {
          return;
        }
        this.autoAttackServerTargetId = r.mobInstanceId;
      });

    this.worldSocket.attackMobResult$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      this.triggerWeaponSwing(p.attackerCharacterId);
      this.visuals.playCharacterCombatAnim(
        this.resolveCharacterVisual(p.attackerCharacterId),
        'attack',
      );
      if (p.attackerCharacterId === this.entitySync.selfCharacterId()) {
        if (p.damage > 0) {
          this.meleeHitFlashUntilMs = performance.now() + 220;
        }
        if (p.mobKilled) {
          this.moveTarget = null;
        }
      }
      if (this.glReady()) {
        const v = new THREE.Vector3();
        const mesh = this.mobMeshes.get(p.mobInstanceId);
        const m = this.entitySync.mobs().get(p.mobInstanceId);
        if (mesh) {
          mesh.getWorldPosition(v);
          this.spawnDamageFloater(v, p.damage, p.critical, p.backstab);
        } else if (m) {
          v.set(m.pos.x, m.pos.y + Y_LIFT, m.pos.z);
          this.spawnDamageFloater(v, p.damage, p.critical, p.backstab);
        }
      }
      if (p.damage > 0) {
        this.triggerMobHitFlash(p.mobInstanceId);
        this.visuals.playMobHit(this.mobMeshes.get(p.mobInstanceId));
      }
      if (p.mobKilled && this.activeTargetId === p.mobInstanceId) {
        this.clearSelectedTarget({ alsoStopAutoAttack: true });
        this.cancelCombatChase();
      }
      this.entitySync.applyAttackResult(p);
    });

    this.worldSocket.skillHitResult$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      this.triggerWeaponSwing(p.attackerCharacterId);
      this.visuals.playCharacterCombatAnim(
        this.resolveCharacterVisual(p.attackerCharacterId),
        'skill',
      );
      const ownHit = p.attackerCharacterId === this.entitySync.selfCharacterId();
      if (ownHit) {
        this.localCurrentMp = p.mpAfter;
        this.playerState.pushSystemLogLine(
          `[Skill] Has usado ${p.skillName} (-${p.manaCost} MP).`,
        );
      }
      if (this.glReady()) {
        const v = new THREE.Vector3();
        const mesh = this.mobMeshes.get(p.targetId);
        const m = this.entitySync.mobs().get(p.targetId);
        if (mesh) {
          mesh.getWorldPosition(v);
          this.spawnDamageFloater(v, p.damage, p.critical, p.backstab, true);
        } else if (m) {
          v.set(m.pos.x, m.pos.y + Y_LIFT, m.pos.z);
          this.spawnDamageFloater(v, p.damage, p.critical, p.backstab, true);
        }
      }
      if (p.damage > 0) {
        this.triggerMobHitFlash(p.targetId);
        this.visuals.playMobHit(this.mobMeshes.get(p.targetId));
      }
      this.spawnSkillImpactVfx(p.skillId, p.attackerCharacterId, p.targetId);
      if (
        ownHit &&
        p.damage > 0 &&
        (p.skillId === 'power_strike' || p.skillId === 'rageful_blow')
      ) {
        this.startCameraShake(SKILL_CAMERA_SHAKE_MS, SKILL_CAMERA_SHAKE_STRENGTH);
      }
      this.entitySync.applyAttackResult({
        attackerCharacterId: p.attackerCharacterId,
        mobInstanceId: p.targetId,
        damage: p.damage,
        critical: p.critical,
        backstab: p.backstab,
        mobKilled: p.targetKilled,
        mobHpAfter: p.targetHpAfter,
      });
      if (p.targetKilled && this.activeTargetId === p.targetId) {
        this.clearSelectedTarget({ alsoStopAutoAttack: true });
        this.cancelCombatChase();
      }
    });

    this.worldSocket.mobDeath$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      if (this.activeTargetId === p.mobInstanceId) {
        this.clearSelectedTarget({ alsoStopAutoAttack: true });
        this.cancelCombatChase();
      }
      const mesh = this.mobMeshes.get(p.mobInstanceId);
      if (mesh) {
        const durationSec = this.visuals.playMobDeath(mesh);
        mesh.userData['mobDeathUntilMs'] = performance.now() + durationSec * 1000;
      }
      this.entitySync.applyMobDeath(p);
    });

    this.worldSocket.mobRespawn$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      this.entitySync.applyMobRespawn(p);
      const mesh = this.mobMeshes.get(p.mobInstanceId);
      if (mesh) {
        this.visuals.resetMobVisualAfterRespawn(mesh);
        this.mobInterp.hardSnap(p.mobInstanceId, performance.now(), {
          x: p.pos.x,
          y: p.pos.y,
          z: p.pos.z,
          yaw: p.worldFacingYaw,
        });
        this.mobPendingHardSnap.add(p.mobInstanceId);
      }
    });

    this.worldSocket.mobMoved$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      this.entitySync.applyMobMoved(p);
      if (isFiniteVec3(p.pos) && isFiniteYaw(p.worldFacingYaw)) {
        this.mobInterp.push(p.mobInstanceId, performance.now(), {
          x: p.pos.x,
          y: p.pos.y,
          z: p.pos.z,
          yaw: p.worldFacingYaw,
        });
      }
    });

    this.worldSocket.mobMeleeResult$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const mesh = this.mobMeshes.get(p.mobInstanceId);
      if (mesh) {
        this.visuals.playMobAttack(mesh, true);
      }
      if (p.targetCharacterId === this.entitySync.selfCharacterId() && p.damage > 0) {
        this.meleeHitFlashUntilMs = performance.now() + 220;
        if (this.glReady() && this.playerMesh) {
          const v = new THREE.Vector3();
          this.playerMesh.getWorldPosition(v);
          this.spawnDamageFloater(v, p.damage, false, false);
        }
      }
    });

    this.worldSocket.worldDropSpawn$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      this.entitySync.applyWorldDropSpawn(p);
    });

    this.worldSocket.worldDropRemoved$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      this.entitySync.applyWorldDropRemoved(p.itemInstanceId);
    });

    this.worldSocket.playerConsumableHeal$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        if (!this.glReady()) {
          return;
        }
        this.spawnHealingFloaterForCharacter(p.characterId, p.hpRestored);
        if (p.characterId === this.entitySync.selfCharacterId()) {
          this.healFlashUntilMs = performance.now() + 380;
        }
      });

    this.worldSocket.attackDenied$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((d) => {
      if (
        d.code === 'TARGET_ALREADY_DEAD' ||
        d.code === 'ZONE_MISMATCH' ||
        d.code === 'INVALID_TARGET' ||
        d.code === 'CHARACTER_DEAD'
      ) {
        this.stopPlayerAutoAttack();
      }
      if (d.code === 'ATTACK_ON_COOLDOWN') {
        return;
      }
      this.lastDenied.set(`${d.code}: ${d.message}`);
      if (d.code === 'OUT_OF_RANGE' && this.activeTargetId) {
        this.pushCombatFeedback('Caminando hacia el objetivo...');
      } else if (d.code === 'TARGET_OUT_OF_RANGE') {
        this.autoAttackServerTargetId = null;
        this.cancelCombatChase();
      } else {
        this.cancelCombatChase();
      }
    });

    this.worldSocket.portalTravelDenied$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        this.portalTravelFadeArmed = false;
        this.zoneTransitionFadeOn.set(false);
        this.playerState.pushSystemLogLine(p.message);
      });

    this.worldSocket.playerLeftZone$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        this.entitySync.removeOtherPlayer(p.characterId);
      });

    this.worldSocket.playerDeath$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        if (p.characterId !== this.entitySync.selfCharacterId()) {
          this.entitySync.removeOtherPlayer(p.characterId);
          return;
        }
        this.cancelCombatChase();
        this.autoAttackServerTargetId = null;
        this.respawnPending.set(false);
        this.deathState.set(p);
        this.playerState.pushSystemLogLine(
          p.experienceLost > 0
            ? `Has caído. Perdiste ${p.experienceLost} de experiencia.`
            : 'Has caído.',
        );
      });

    this.worldSocket.playerRespawn$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        if (p.characterId !== this.entitySync.selfCharacterId()) {
          return;
        }
        this.deathState.set(null);
        this.respawnPending.set(false);
        this.snapPredictionToServer(p.worldPos, p.worldFacingYaw);
        this.playerState.pushSystemLogLine(`Reapareciste en ${p.zoneId}.`);
      });

    this.worldSocket.playerVisualState$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        this.entitySync.applyPlayerVisualState(p);
      });

    this.worldSocket.attackPlayerResult$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        this.playerTargetHp.set(p.targetCharacterId, p.targetHpAfter);
        this.triggerWeaponSwing(p.attackerCharacterId);
        this.visuals.playCharacterCombatAnim(
          this.resolveCharacterVisual(p.attackerCharacterId),
          'attack',
        );
        if (this.glReady() && p.damage > 0) {
          const targetVisual = this.resolveCharacterVisual(p.targetCharacterId);
          if (targetVisual) {
            const v = new THREE.Vector3();
            targetVisual.getWorldPosition(v);
            v.y += Y_LIFT;
            this.spawnDamageFloater(v, p.damage, p.critical, false);
          }
        }
        if (p.targetKilled && this.activePlayerTargetId === p.targetCharacterId) {
          this.activePlayerTargetId = null;
          this.stopPlayerAutoAttack();
        }
      });

    this.worldSocket.attackMobRewards$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((r: WsAttackMobRewardsPayload) => {
        if (r.experienceGained <= 0) {
          return;
        }
        if (!this.glReady()) {
          return;
        }
        this.spawnXpFloater(r.experienceGained);
      });

    effect(() => {
      /* Independiente de mobs/HP. Pide el JSON de *esta* zona; Zone_1 no baja hasta el portal. */
      const zoneId = normalizeZoneIdForUi(this.entitySync.zoneId());
      if (!this.glReady()) {
        return;
      }
      void this.mapLoader.ensureZoneLoaded(zoneId).then(() => {
        if (!this.glReady()) {
          return;
        }
        if (normalizeZoneIdForUi(this.entitySync.zoneId()) !== zoneId) {
          return;
        }
        this.reconcileMapObstacles(zoneId);
      });
    });

    effect(() => {
      this.glReady();
      if (!this.glReady()) {
        return;
      }
      const player = this.entitySync.player();
      this.ensurePlayerMesh(player !== null);
      this.reconcileMobs(this.entitySync.mobs());
      this.reconcileNpcs(this.entitySync.npcs());
      this.reconcileWorldDrops(this.entitySync.worldDrops());
      this.reconcileOtherPlayers(this.entitySync.otherPlayers());
    });

    effect(() => {
      this.npcShopUi.lootFloaterTick();
      const t = this.npcShopUi.peekLootFloater();
      if (!t || !this.glReady()) {
        return;
      }
      this.spawnLootFloater(t);
      this.npcShopUi.clearLootFloater();
    });

    effect(() => {
      if (!this.playerState.isSessionAdmin()) {
        this.gmBarVisible.set(false);
      }
    });
  }

  ngAfterViewInit(): void {
    this.initThree();
    this.glReady.set(true);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.viewportRef.nativeElement);
    this.perfHud = new PerfHud(this.viewportRef.nativeElement);
    warnIfSoftwareRenderer(this.renderer, this.viewportRef.nativeElement);
    this.startLoop();
    this.onResize();

    const host = this.viewportRef.nativeElement;
    host.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onWindowKeyDown);
    this.cooldownNowMs.set(performance.now());
    this.cooldownTickerId = window.setInterval(() => {
      this.cooldownNowMs.set(performance.now());
    }, 100);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    this.stopPlayerAutoAttack();
    this.perfHud?.dispose();
    this.combatFloaters?.dispose();
    this.combatFloaters = null;
    this.clearSkillFx();
    this.resizeObserver?.disconnect();
    this.simTimer.dispose();
    this.renderer?.dispose();
    window.removeEventListener('keydown', this.onWindowKeyDown);
    if (this.cooldownTickerId !== null) {
      window.clearInterval(this.cooldownTickerId);
      this.cooldownTickerId = null;
    }
    if (this.renderer) {
      const canvas = this.renderer.domElement;
      canvas.removeEventListener('pointerdown', this.onCanvasPointerDownBound);
      canvas.removeEventListener('pointermove', this.onCanvasPointerMoveBound);
      canvas.removeEventListener('pointerup', this.onCanvasPointerUpBound);
      canvas.removeEventListener('pointercancel', this.onCanvasPointerCancelBound);
      canvas.removeEventListener('wheel', this.onCanvasWheelBound);
    }
  }

  connectWorld(): void {
    this.gmBarVisible.set(false);
    this.npcShopUi.close();
    this.lastMoveEmitMs = 0;
    const url = this.serverUrlModel.trim();
    const cid = this.characterIdModel.trim();
    if (!cid) {
      this.lastDenied.set('Ingresá un characterId (UUID) válido.');
      return;
    }
    localStorage.setItem(STORAGE_SERVER, url);
    localStorage.setItem(STORAGE_CHARACTER, cid);
    this.lastDenied.set(null);
    this.playerState.setSessionCharacter(cid);
    this.playerState.refreshFromServer(cid);
    this.entitySync.reset();
    this.clearEntityMeshes();
    if (this.glReady()) {
      this.reconcileMapObstacles(normalizeZoneIdForUi(this.entitySync.zoneId()));
    }
    this.moveTarget = null;
    this.activeTargetId = null;
    this.activePlayerTargetId = null;
    this.autoAttackIntentTargetId = null;
    this.autoAttackServerTargetId = null;
    this.lastAutoAttackIntentEmitMs = 0;
    this.cancelCombatChase();
    this.localSkillCooldownUntil.clear();
    this.resetDropPreviewState();
    this.correctionLerp = null;
    this.worldSocket.disconnect();
    this.worldSocket.connect(url, cid);
  }

  /**
   * Ejecuta un comando GM vía Socket.IO (`execute-gm-command`). El servidor exige `Character.isAdmin`.
   */
  runGmCommandLine(): void {
    const line = this.gmCommandLine.trim();
    if (!line || !this.worldSocket.socketConnected()) {
      return;
    }
    const raw = line.startsWith('/') ? line.slice(1) : line;
    const parts = raw.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) {
      return;
    }
    const command = parts[0]!;
    const args = parts.slice(1);
    this.worldSocket.emitExecuteGmCommandWithAck({ command, args }, (ack) => {
      if (!ack.ok) {
        this.playerState.pushSystemLogLine(`[GM] ${ack.message}`);
        return;
      }
      this.playerState.pushSystemLogLine('[GM] Comando ejecutado con éxito');
      const cid = this.characterIdModel.trim();
      if (cid) {
        void this.playerState.refreshFromServer(cid);
      }
    });
    this.gmCommandLine = '';
  }

  disconnectWorld(): void {
    this.gmBarVisible.set(false);
    if (this.worldSocket.socketConnected() && this.npcShopUi.shop()) {
      this.worldSocket.emitNpcCloseInteract();
    }
    this.npcShopUi.close();
    this.playerState.setSessionCharacter(null);
    this.worldSocket.disconnect();
    this.entitySync.reset();
    this.clearEntityMeshes();
    if (this.glReady()) {
      this.reconcileMapObstacles(normalizeZoneIdForUi(this.entitySync.zoneId()));
    }
    this.moveTarget = null;
    this.activeTargetId = null;
    this.activePlayerTargetId = null;
    this.autoAttackIntentTargetId = null;
    this.autoAttackServerTargetId = null;
    this.lastAutoAttackIntentEmitMs = 0;
    this.cancelCombatChase();
    this.localSkillCooldownUntil.clear();
    this.resetDropPreviewState();
    this.correctionLerp = null;
  }

  private onCanvasPointerDown(ev: PointerEvent): void {
    if (!this.glReady() || !this.worldSocket.socketConnected()) {
      return;
    }

    if (ev.button === 2) {
      this.tryNpcInteractOrMoveFromEvent(ev);
      ev.preventDefault();
      return;
    }

    if (ev.button === 0) {
      this.leftPointerDown = true;
      this.leftPointerIsDrag = false;
      this.leftPointerDownClient.set(ev.clientX, ev.clientY);
      this.leftPointerLastClient.set(ev.clientX, ev.clientY);
      (ev.currentTarget as Element | null)?.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
    }
  }

  private onCanvasPointerMove(ev: PointerEvent): void {
    if (!this.leftPointerDown) {
      return;
    }
    const totalDx = ev.clientX - this.leftPointerDownClient.x;
    const totalDy = ev.clientY - this.leftPointerDownClient.y;
    const dragDistance = Math.hypot(totalDx, totalDy);
    if (!this.leftPointerIsDrag && dragDistance > CLICK_DRAG_THRESHOLD_PX) {
      this.leftPointerIsDrag = true;
    }
    if (!this.leftPointerIsDrag) {
      return;
    }
    const dx = ev.clientX - this.leftPointerLastClient.x;
    const dy = ev.clientY - this.leftPointerLastClient.y;
    this.leftPointerLastClient.set(ev.clientX, ev.clientY);
    /* Modo "arrastrar escenario": invertir ejes para cámara intuitiva. */
    this.cameraAzimuthAngle += dx * CAMERA_ROTATE_SENSITIVITY;
    this.cameraPolarAngle = THREE.MathUtils.clamp(
      this.cameraPolarAngle - dy * CAMERA_ROTATE_SENSITIVITY,
      CAMERA_POLAR_MIN,
      CAMERA_POLAR_MAX,
    );
    ev.preventDefault();
  }

  private onCanvasPointerUp(ev: PointerEvent): void {
    if (ev.button !== 0) {
      return;
    }
    const wasDown = this.leftPointerDown;
    const wasDrag = this.leftPointerIsDrag;
    this.leftPointerDown = false;
    this.leftPointerIsDrag = false;
    (ev.currentTarget as Element | null)?.releasePointerCapture?.(ev.pointerId);
    if (!wasDown || wasDrag) {
      return;
    }
    this.handleLeftPointerCombat(ev);
  }

  private onCanvasPointerCancel(ev: PointerEvent): void {
    this.leftPointerDown = false;
    this.leftPointerIsDrag = false;
    (ev.currentTarget as Element | null)?.releasePointerCapture?.(ev.pointerId);
  }

  private onCanvasWheel(ev: WheelEvent): void {
    if (!this.glReady() || !this.worldSocket.socketConnected()) {
      return;
    }
    const dir = Math.sign(ev.deltaY);
    if (!Number.isFinite(dir) || dir === 0) {
      return;
    }
    const nextTarget = this.cameraRadiusTarget + dir * CAMERA_ZOOM_WHEEL_STEP;
    this.cameraRadiusTarget = THREE.MathUtils.clamp(
      nextTarget,
      CAMERA_ZOOM_MIN_RADIUS,
      CAMERA_ZOOM_MAX_RADIUS,
    );
    ev.preventDefault();
  }

  private beginPortalTravelIntent(portalId: string, logMessage: string): void {
    const portal = this.portalMeshes.get(portalId);
    const radius = this.getPortalInteractRadius(portal);
    const dx = (portal?.position.x ?? 0) - this.visualPos.x;
    const dy = (portal?.position.y ?? 0) - this.visualPos.y;
    const dz = (portal?.position.z ?? 0) - this.visualPos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (!portal || dist > radius) {
      this.playerState.pushSystemLogLine('Demasiado lejos del portal');
      if (portal) {
        if (!this.moveTarget) {
          this.moveTarget = new THREE.Vector3();
        }
        this.moveTarget.set(portal.position.x, portal.position.y, portal.position.z);
        this.moveIntentDirty = true;
        this.cancelCombatChase();
      }
      return;
    }
    this.playerState.pushSystemLogLine(logMessage);
    this.portalTravelFadeArmed = true;
    this.zoneTransitionFadeOn.set(true);
    const targetZoneId = portal.userData['targetZoneId'];
    if (typeof targetZoneId === 'string' && targetZoneId.trim()) {
      void this.mapLoader.ensureZoneLoaded(targetZoneId);
    }
    window.setTimeout(() => {
      this.worldSocket.emitPortalTravel({ portalId });
    }, 320);
  }

  private getPortalInteractRadius(portal: THREE.Object3D | undefined): number {
    const r = portal?.userData['portalInteractionRadiusMeters'];
    if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
      return r;
    }
    return 4;
  }

  private findPortalIdOnObject(start: THREE.Object3D): string | null {
    let node: THREE.Object3D | null = start;
    while (node) {
      const id = node.userData['portalId'];
      if (typeof id === 'string' && id.length > 0) {
        return id;
      }
      node = node.parent;
    }
    return null;
  }

  private findPortalMessageOnObject(start: THREE.Object3D): string {
    let node: THREE.Object3D | null = start;
    while (node) {
      const msg = node.userData['portalTravelMessage'];
      if (typeof msg === 'string' && msg.length > 0) {
        return msg;
      }
      node = node.parent;
    }
    return 'Viajando a través del portal...';
  }

  /**
   * Clic derecho: portal (pick) o movimiento hacia el suelo.
   */
  private tryNpcInteractOrMoveFromEvent(ev: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const portalHits = this.raycaster.intersectObjects(this.portalRoot.children, true);
    portalHits.sort((a, b) => a.distance - b.distance);
    const portalPick = portalHits.find((h) => this.findPortalIdOnObject(h.object) !== null);
    if (portalPick) {
      const portalId = this.findPortalIdOnObject(portalPick.object)!;
      const msg = this.findPortalMessageOnObject(portalPick.object);
      this.beginPortalTravelIntent(portalId, msg);
      ev.preventDefault();
      return;
    }
    const pickables: THREE.Object3D[] = [this.groundMesh];
    const hits = this.raycaster.intersectObjects(pickables, false);
    hits.sort((a, b) => a.distance - b.distance);
    const groundHit = hits.find((h) => h.object === this.groundMesh);
    if (!groundHit) {
      return;
    }
    if (!this.moveTarget) {
      this.moveTarget = new THREE.Vector3();
    }
    this.moveTarget.set(groundHit.point.x, groundHit.point.y, groundHit.point.z);
    this.moveIntentDirty = true;
    /** Regla L2: click derecho es solo movimiento manual; no altera la selección. */
    this.cancelCombatChase();
  }

  /**
   * L2-style: clic izquierdo selecciona/interactúa (sin mover ni atacar).
   */
  private handleLeftPointerCombat(ev: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const pickables: THREE.Object3D[] = [
      ...this.dropsRoot.children,
      ...this.npcRoot.children,
      ...this.mobRoot.children,
      ...this.otherPlayersRoot.children,
      this.groundMesh,
    ];
    const hits = this.raycaster.intersectObjects(pickables, true);
    hits.sort((a, b) => a.distance - b.distance);

    const dropHit = hits.find((h) => {
      const id = (h.object as THREE.Mesh).userData['worldDropItemInstanceId'];
      return typeof id === 'string';
    });
    if (dropHit) {
      this.cancelCombatChase();
      const itemInstanceId = (dropHit.object as THREE.Mesh).userData[
        'worldDropItemInstanceId'
      ] as string;
        this.worldSocket.emitPickItemWithAck({ itemInstanceId }, (r) => {
        if (!r.ok) {
          this.lastDenied.set(`${r.code}: ${r.message}`);
          return;
        }
        this.playerState.mergeFromPickAck(r);
        if (this.glReady()) {
          this.spawnLootFloater(`+${r.pickedItemDisplayName}`);
        }
      });
      return;
    }

    const mobPick = hits.find((h) => typeof pickUserDataString(h.object, 'mobInstanceId') === 'string');
    if (mobPick) {
      const mobInstanceId = pickUserDataString(mobPick.object, 'mobInstanceId') as string;
      const mob = this.entitySync.mobs().get(mobInstanceId);
      if (!mob?.visible) {
        return;
      }
      this.activeTargetId = mobInstanceId;
      this.activePlayerTargetId = null;
      if (this.targetDropPreviewMobId !== mobInstanceId) {
        this.resetDropPreviewState();
      }
      if (this.autoAttackIntentTargetId) {
        this.autoAttackIntentTargetId = mobInstanceId;
        this.autoAttackServerTargetId = null;
      }
      this.cancelCombatChase();
      this.lastDenied.set(null);
      return;
    }

    const otherPlayerPick = hits.find(
      (h) => typeof pickUserDataString(h.object, 'otherCharacterId') === 'string',
    );
    if (otherPlayerPick) {
      const otherCharacterId = pickUserDataString(otherPlayerPick.object, 'otherCharacterId') as string;
      this.activePlayerTargetId = otherCharacterId;
      this.activeTargetId = null;
      this.resetDropPreviewState();
      this.cancelCombatChase();
      this.lastDenied.set(null);
      return;
    }

    const npcPick = hits.find((h) => typeof pickUserDataString(h.object, 'npcInstanceId') === 'string');
    if (npcPick) {
      this.cancelCombatChase();
      this.clearSelectedTarget({ alsoStopAutoAttack: true });
      const npcInstanceId = pickUserDataString(npcPick.object, 'npcInstanceId') as string;
      const npc = this.entitySync.npcs().get(npcInstanceId);
      if (npc?.npcRole === 'MERCHANT') {
        this.merchantBoxNpcId = npcInstanceId;
        this.visuals.playNpcShopOpen(this.npcMeshes.get(npcInstanceId));
        this.openMerchantStore(npcInstanceId, npc.displayName);
      }
      return;
    }
    const groundHits = hits.filter((h) => h.object === this.groundMesh);
    if (groundHits[0]) {
      this.cancelCombatChase();
      this.clearSelectedTarget({ alsoStopAutoAttack: true });
      this.activePlayerTargetId = null;
    }
  }

  private handleSkillHotkeys(ev: KeyboardEvent): void {
    if (this.isEditableTarget(ev.target)) {
      return;
    }
    if (ev.key === 'F3') {
      ev.preventDefault();
      this.perfHud?.toggle();
      return;
    }
    if (ev.key === 'Tab' || ev.key.toLowerCase() === 'i') {
      ev.preventDefault();
      this.inventoryPanelOpen.update((open) => !open);
      return;
    }
    if (ev.key.toLowerCase() === 'p') {
      ev.preventDefault();
      this.characterSheetOpen.update((open) => !open);
      return;
    }
    if (ev.key.toLowerCase() === 'o') {
      ev.preventDefault();
      this.synthesisPanelOpen.update((open) => !open);
      return;
    }
    if (ev.key.toLowerCase() === 'y') {
      if (!this.worldSocket.socketConnected() || !this.playerState.isSessionAdmin()) {
        return;
      }
      ev.preventDefault();
      this.gmBarVisible.update((v) => !v);
      return;
    }
    if (!this.worldSocket.socketConnected()) {
      return;
    }
    if (ev.repeat) {
      return;
    }
    if (ev.key === '1') {
      ev.preventDefault();
      this.requestBasicAttack();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.cancelCombatChase();
      this.clearSelectedTarget({ alsoStopAutoAttack: true });
      return;
    }
    if (ev.key === '2') {
      ev.preventDefault();
      this.requestSkillCast('power_strike');
      return;
    }
    if (ev.key === '3') {
      ev.preventDefault();
      this.requestSkillCast('rageful_blow');
      return;
    }
    if (ev.key === '4') {
      ev.preventDefault();
      this.usePotion(HEALTH_POTION_CATALOG_KEY, 'Pociones de Vida');
      return;
    }
    if (ev.key === '5') {
      ev.preventDefault();
      this.usePotion(MANA_POTION_CATALOG_KEY, 'Pociones de Maná');
      return;
    }
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  private requestBasicAttack(): void {
    if (this.activePlayerTargetId) {
      this.sendPlayerAttack(this.activePlayerTargetId);
      this.startPlayerAutoAttack();
      return;
    }
    if (!this.activeTargetId) {
      this.pushCombatFeedback('Debes seleccionar un objetivo primero');
      return;
    }
    this.autoAttackIntentTargetId = this.activeTargetId;
    this.autoAttackServerTargetId = null;
    this.lastAutoAttackIntentEmitMs = 0;
    this.requestCombatAction({
      kind: 'basic',
      label: 'Ataque básico',
      rangeMeters: BASIC_ATTACK_RANGE_METERS,
    });
  }

  /** Repite el golpe a un jugador mientras siga seleccionado; Esc, muerte o cambio de objetivo lo cortan. */
  private startPlayerAutoAttack(): void {
    if (this.playerAutoAttackTimer !== null) {
      return;
    }
    this.playerAutoAttackTimer = setInterval(() => {
      const targetId = this.activePlayerTargetId;
      if (!targetId || !this.worldSocket.socketConnected()) {
        this.stopPlayerAutoAttack();
        return;
      }
      this.sendPlayerAttack(targetId);
    }, PLAYER_AUTO_ATTACK_INTERVAL_MS);
  }

  /**
   * Ritmo de golpes a jugadores: no más de uno cada ~750 ms (≈ enfriamiento del servidor). La respuesta
   * tarda ~1 s por la base remota, así que esperar cada respuesta bajaría el DPS y enviar cada tick
   * dejaría cola de golpes pendientes al soltar el objetivo.
   */
  private sendPlayerAttack(targetId: string): void {
    const now = performance.now();
    if (this.playerAttackAwaitingSinceMs !== null && now - this.playerAttackAwaitingSinceMs < PLAYER_ATTACK_MIN_GAP_MS) {
      return;
    }
    this.playerAttackAwaitingSinceMs = now;
    this.worldSocket.attackPlayer({ targetCharacterId: targetId });
  }

  private stopPlayerAutoAttack(): void {
    if (this.playerAutoAttackTimer !== null) {
      clearInterval(this.playerAutoAttackTimer);
      this.playerAutoAttackTimer = null;
    }
    this.playerAttackAwaitingSinceMs = null;
  }

  private requestSkillCast(skillId: SkillHotkeyId): void {
    if (!this.activeTargetId && this.activePlayerTargetId) {
      this.pushCombatFeedback('Las habilidades sólo funcionan contra mobs; usá 1 para atacar jugadores');
      return;
    }
    if (!this.activeTargetId) {
      this.pushCombatFeedback('Debes seleccionar un objetivo primero');
      return;
    }
    const def = SKILL_LOCAL_RULES[skillId];
    const now = performance.now();
    const cdUntil = this.localSkillCooldownUntil.get(skillId) ?? 0;
    if (now < cdUntil) {
      this.pushCombatFeedback('En Cooldown');
      return;
    }
    if (this.localCurrentMp < def.manaCost) {
      this.pushCombatFeedback('Sin Mana');
      return;
    }
    this.requestCombatAction({
      kind: 'skill',
      skillId,
      label: def.name,
      rangeMeters: def.rangeMeters,
    });
  }

  onActionSlotPressed(slot: ActionBarSlot): void {
    if (slot.potionCatalogKey) {
      this.usePotion(slot.potionCatalogKey, slot.potionLabel ?? 'Pociones');
      return;
    }
    if (slot.isBasic) {
      this.requestBasicAttack();
      return;
    }
    if (!slot.skillId) {
      return;
    }
    this.requestSkillCast(slot.skillId);
  }

  /** Busca el consumible pedido en la mochila y pide usarlo (el servidor valida stock/cura). */
  private usePotion(catalogKey: string, label: string): void {
    if (!this.worldSocket.socketConnected()) {
      this.pushCombatFeedback('Conectate al mundo para usar ítems');
      return;
    }
    const now = performance.now();
    if (now - this.lastPotionUseAtMs < POTION_COOLDOWN_MS) {
      return;
    }
    const items = this.playerState.inventoryItems();
    const potion = items.find(
      (item) => item.location === 'INVENTORY' && item.catalogKey === catalogKey,
    );
    if (!potion) {
      this.pushCombatFeedback(`No te quedan ${label}`);
      return;
    }
    this.lastPotionUseAtMs = now;
    this.playerState.requestUseConsumable(this.characterIdModel.trim(), potion.id);
  }

  manaPercent(): number {
    if (this.localMaxMp <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, (100 * this.localCurrentMp) / this.localMaxMp));
  }

  activeTargetFrame(): TargetFrameViewModel | null {
    if (!this.activeTargetId && this.activePlayerTargetId) {
      const other = this.entitySync.otherPlayers().get(this.activePlayerTargetId);
      if (!other) {
        return null;
      }
      return {
        name: other.name,
        level: 0,
        hpPercent: 0,
        currentHp: this.playerTargetHp.get(other.characterId) ?? 0,
        maxHp: 0,
        kind: 'player',
        nameColor: KARMA_NAME_COLORS[other.karmaFlag],
        hint: 'Jugador: pulsá 1 para atacar (Esc cancela)',
      };
    }
    if (!this.activeTargetId) {
      return null;
    }
    const target = this.entitySync.mobs().get(this.activeTargetId);
    if (!target || !target.visible) {
      return null;
    }
    return {
      name: target.displayName || target.mobTemplateKey,
      level:
        typeof target.mobLevel === 'number' && target.mobLevel > 0
          ? target.mobLevel
          : this.inferMobLevel(target.mobTemplateKey),
      hpPercent:
        target.maxHp > 0 ? Math.max(0, Math.min(100, (100 * target.currentHp) / target.maxHp)) : 0,
      currentHp: target.currentHp,
      maxHp: target.maxHp,
    };
  }

  onToggleTargetDropPreview(): void {
    if (!this.activeTargetId) {
      return;
    }
    const nextOpen = !this.targetDropPreviewOpen();
    this.targetDropPreviewOpen.set(nextOpen);
    if (!nextOpen) {
      return;
    }
    this.requestDropPreviewForMob(this.activeTargetId);
  }

  private inferMobLevel(mobTemplateKey: string): number {
    const key = mobTemplateKey.toLowerCase();
    const explicit = key.match(/(?:^|[_-])(lv|lvl|level)[_-]?(\d{1,3})(?:$|[_-])/i);
    if (explicit?.[2]) {
      return Number(explicit[2]);
    }
    const trailing = key.match(/(\d{1,3})$/);
    if (trailing?.[1]) {
      return Number(trailing[1]);
    }
    return 1;
  }

  slotCooldownRatio(slot: ActionBarSlot): number {
    const remaining = this.slotCooldownRemainingMs(slot);
    if (remaining <= 0) {
      return 0;
    }
    const totalMs = slot.skillId ? SKILL_LOCAL_RULES[slot.skillId].cooldownMs : POTION_COOLDOWN_MS;
    return Math.max(0, Math.min(1, remaining / totalMs));
  }

  slotCooldownRemainingMs(slot: ActionBarSlot): number {
    const now = this.cooldownNowMs();
    if (slot.potionCatalogKey) {
      // Un solo reloj compartido: usar cualquier consumible frena a los dos slots por igual.
      return Math.max(0, Math.ceil(this.lastPotionUseAtMs + POTION_COOLDOWN_MS - now));
    }
    if (!slot.skillId) {
      return 0;
    }
    const until = this.localSkillCooldownUntil.get(slot.skillId) ?? 0;
    return Math.max(0, Math.ceil(until - now));
  }

  combatChaseActive(): boolean {
    return this.pendingCombatAction !== null;
  }

  combatChaseText(): string {
    const txt = this.chaseFeedback();
    return txt ?? 'Caminando hacia el objetivo...';
  }

  private pushCombatFeedback(message: string): void {
    this.lastDenied.set(message);
    this.playerState.pushSystemLogLine(`[Combat] ${message}`);
  }

  private requestCombatAction(action: {
    kind: 'basic' | 'skill';
    label: string;
    rangeMeters: number;
    skillId?: SkillHotkeyId;
  }): void {
    if (!this.activeTargetId) {
      this.pushCombatFeedback('Debes seleccionar un objetivo primero');
      return;
    }
    const mob = this.entitySync.mobs().get(this.activeTargetId);
    if (!mob?.visible) {
      this.pushCombatFeedback('El objetivo ya no está disponible');
      return;
    }
    const queued: PendingCombatAction =
      action.kind === 'basic'
        ? {
            kind: 'basic',
            label: action.label,
            rangeMeters: action.rangeMeters,
            targetId: this.activeTargetId,
          }
        : {
            kind: 'skill',
            label: action.label,
            rangeMeters: action.rangeMeters,
            targetId: this.activeTargetId,
            skillId: action.skillId as SkillHotkeyId,
          };
    if (this.isTargetInRange(queued.targetId, queued.rangeMeters)) {
      this.cancelCombatChase();
      this.executeCombatAction(queued);
      return;
    }
    this.pendingCombatAction = queued;
    this.chaseFeedback.set('Caminando hacia el objetivo...');
    this.playerState.pushSystemLogLine(`[Combat] Caminando hacia el objetivo para ${queued.label}...`);
    this.syncMoveTargetToMob(queued.targetId);
  }

  private executeCombatAction(action: PendingCombatAction): void {
    if (action.kind === 'basic') {
      this.emitAutoAttackIntent(action.targetId);
      this.lastDenied.set(null);
      return;
    }
    const def = SKILL_LOCAL_RULES[action.skillId];
    const now = performance.now();
    this.localSkillCooldownUntil.set(action.skillId, now + def.cooldownMs);
    this.lastDenied.set(null);
    this.worldSocket.castSkill({
      skillId: action.skillId,
      targetId: action.targetId,
    });
  }

  private tickCombatActionChase(): void {
    const pending = this.pendingCombatAction;
    if (!pending || !this.worldSocket.socketConnected()) {
      return;
    }
    const mob = this.entitySync.mobs().get(pending.targetId);
    if (!mob?.visible) {
      this.cancelCombatChase();
      return;
    }
    if (this.isTargetInRange(pending.targetId, pending.rangeMeters)) {
      this.moveTarget = null;
      this.pendingCombatAction = null;
      this.chaseFeedback.set(null);
      this.executeCombatAction(pending);
      return;
    }
    this.syncMoveTargetToMob(pending.targetId);
  }

  private tickAutoAttackIntent(nowMs: number): void {
    const targetId = this.autoAttackIntentTargetId;
    if (!targetId || !this.worldSocket.socketConnected()) {
      return;
    }
    if (this.activeTargetId !== targetId) {
      this.autoAttackIntentTargetId = null;
      this.autoAttackServerTargetId = null;
      return;
    }
    const mob = this.entitySync.mobs().get(targetId);
    if (!mob?.visible) {
      this.autoAttackIntentTargetId = null;
      this.autoAttackServerTargetId = null;
      return;
    }
    if (!this.isTargetInRange(targetId, BASIC_ATTACK_RANGE_METERS)) {
      return;
    }
    if (this.autoAttackServerTargetId === targetId) {
      return;
    }
    if (nowMs - this.lastAutoAttackIntentEmitMs < AUTO_ATTACK_RESUME_EMIT_MS) {
      return;
    }
    this.emitAutoAttackIntent(targetId);
  }

  private syncMoveTargetToMob(mobId: string): void {
    const mob = this.entitySync.mobs().get(mobId);
    if (!mob?.visible) {
      return;
    }
    if (!this.moveTarget) {
      this.moveTarget = new THREE.Vector3();
    }
    this.moveTarget.set(mob.pos.x, mob.pos.y, mob.pos.z);
    this.moveIntentDirty = true;
  }

  private isTargetInRange(targetId: string, rangeMeters: number): boolean {
    const mob = this.entitySync.mobs().get(targetId);
    if (!mob?.visible) {
      return false;
    }
    const dx = mob.pos.x - this.visualPos.x;
    const dz = mob.pos.z - this.visualPos.z;
    return Math.hypot(dx, dz) <= rangeMeters;
  }

  private cancelCombatChase(): void {
    this.pendingCombatAction = null;
    this.chaseFeedback.set(null);
  }

  private emitAutoAttackIntent(targetId: string): void {
    this.lastAutoAttackIntentEmitMs = performance.now();
    this.worldSocket.emitCombatTarget({ mobInstanceId: targetId });
  }

  private clearSelectedTarget(options?: { alsoStopAutoAttack?: boolean }): void {
    this.activeTargetId = null;
    this.activePlayerTargetId = null;
    this.resetDropPreviewState();
    if (!options?.alsoStopAutoAttack) {
      return;
    }
    this.autoAttackIntentTargetId = null;
    this.autoAttackServerTargetId = null;
    this.lastAutoAttackIntentEmitMs = 0;
    this.worldSocket.emitCombatTarget({ mobInstanceId: null });
  }

  private initThree(): void {
    const host = this.viewportRef.nativeElement;
    const w = host.clientWidth || 640;
    const h = host.clientHeight || 480;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1e24);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500);
    this.camera.position.copy(ISO_OFFSET);
    this.cameraRadius = DEFAULT_CAMERA_RADIUS;
    this.cameraRadiusTarget = DEFAULT_CAMERA_RADIUS;
    this.cameraAzimuthAngle = DEFAULT_CAMERA_AZIMUTH;
    this.cameraPolarAngle = DEFAULT_CAMERA_POLAR;
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(24, 42, 16);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xc5d4f0, 0x3d3a36, 0.5));

    this.groundMesh = this.visuals.createGroundVisual();
    this.scene.add(this.groundMesh);
    this.groundGrid = this.visuals.createGroundGrid();
    this.scene.add(this.groundGrid);

    this.simTimer.connect(document);

    this.mobRoot = new THREE.Group();
    this.npcRoot = new THREE.Group();
    this.dropsRoot = new THREE.Group();
    this.otherPlayersRoot = new THREE.Group();
    this.obstacleRoot = new THREE.Group();
    this.portalRoot = new THREE.Group();
    this.scene.add(this.mobRoot);
    this.scene.add(this.npcRoot);
    this.scene.add(this.dropsRoot);
    this.scene.add(this.otherPlayersRoot);
    this.scene.add(this.obstacleRoot);
    this.scene.add(this.portalRoot);
    this.scene.add(this.damageFloatGroup);
    this.combatFloaters = new WorldCombatFloaters(this.damageFloatGroup);
    this.scene.add(this.skillFxRoot);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tope 1.5: en pantallas HiDPI, 2x renderiza 4x píxeles con poca ganancia visible.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(w, h);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.cursor = 'crosshair';
    this.renderer.domElement.addEventListener('pointerdown', this.onCanvasPointerDownBound);
    this.renderer.domElement.addEventListener('pointermove', this.onCanvasPointerMoveBound);
    this.renderer.domElement.addEventListener('pointerup', this.onCanvasPointerUpBound);
    this.renderer.domElement.addEventListener('pointercancel', this.onCanvasPointerCancelBound);
    this.renderer.domElement.addEventListener('wheel', this.onCanvasWheelBound, {
      passive: false,
    });
    host.appendChild(this.renderer.domElement);

    this.css2d = new CSS2DRenderer();
    this.css2d.setSize(w, h);
    const css2dEl = this.css2d.domElement;
    css2dEl.style.position = 'absolute';
    css2dEl.style.inset = '0';
    css2dEl.style.width = '100%';
    css2dEl.style.height = '100%';
    css2dEl.style.pointerEvents = 'none';
    css2dEl.style.overflow = 'hidden';
    /* Por encima de .game-overlay (z-index 5); si no, los popups CSS2D quedan tapados. */
    css2dEl.style.zIndex = '20';
    const stack = host.parentElement;
    (stack ?? host).appendChild(css2dEl);
  }

  private reconcileMapObstacles(zoneId: string): void {
    const zn = normalizeZoneIdForUi(zoneId);
    this.visuals.applyGroundAlbedoForZone(
      this.groundMesh,
      this.mapLoader.groundAlbedoByZoneId()[zn],
    );
    const groundSize = this.mapLoader.groundSizeByZoneId()[zn] ?? 128;
    this.groundGrid = this.visuals.setPlayableGroundSize(
      this.groundMesh,
      this.groundGrid,
      groundSize,
    );
    const mapRows = this.mapLoader.staticMapRows();
    const activeAll = mapRows.filter((row) => {
      if (!row.zoneId) {
        return true;
      }
      return normalizeZoneIdForUi(row.zoneId) === zn;
    });
    const activeBoxes = activeAll.filter((row): row is MapBoxConfigRow => row.kind !== 'portal');
    const activeIds = new Set(activeBoxes.map((row) => row.id));
    for (const id of this.obstacleMeshes.keys()) {
      if (!activeIds.has(id)) {
        const mesh = this.obstacleMeshes.get(id)!;
        this.obstacleRoot.remove(mesh);
        this.visuals.disposeVisual(mesh);
        this.obstacleMeshes.delete(id);
        this.obstacleRects.delete(id);
      }
    }
    for (const row of activeBoxes) {
      let mesh = this.obstacleMeshes.get(row.id);
      if (mesh && this.mapPropLayoutChanged(mesh, row)) {
        this.obstacleRoot.remove(mesh);
        this.visuals.disposeVisual(mesh);
        this.obstacleMeshes.delete(row.id);
        mesh = undefined;
      }
      if (!mesh) {
        mesh = this.visuals.createObstacleVisual(row);
        this.obstacleMeshes.set(row.id, mesh);
        this.obstacleRoot.add(mesh);
      } else {
        this.visuals.ensureObstacleMaterial(mesh);
      }
      mesh.position.set(row.position.x, row.position.y, row.position.z);
      mesh.visible = true;
      if (row.blocksMovement !== false) {
        this.obstacleRects.set(row.id, this.toObstacleRectXZ(row));
      } else {
        this.obstacleRects.delete(row.id);
      }
    }

    const activePortals = activeAll.filter((row): row is MapPortalConfigRow => row.kind === 'portal');
    const portalIds = new Set(activePortals.map((p) => p.id));
    for (const id of this.portalMeshes.keys()) {
      if (!portalIds.has(id)) {
        const mesh = this.portalMeshes.get(id)!;
        this.portalRoot.remove(mesh);
        this.visuals.disposeVisual(mesh);
        this.portalMeshes.delete(id);
      }
    }
    for (const row of activePortals) {
      let mesh = this.portalMeshes.get(row.id);
      if (mesh && this.mapPropLayoutChanged(mesh, row)) {
        this.portalRoot.remove(mesh);
        this.visuals.disposeVisual(mesh);
        this.portalMeshes.delete(row.id);
        mesh = undefined;
      }
      if (!mesh) {
        mesh = this.visuals.createPortalVisual(row);
        this.portalMeshes.set(row.id, mesh);
        this.portalRoot.add(mesh);
      } else {
        this.visuals.ensurePortalMaterial(mesh);
      }
      mesh.position.set(row.position.x, row.position.y, row.position.z);
      mesh.visible = true;
    }

    this.obstacleRoot.visible = true;
    this.portalRoot.visible = true;
  }

  private mapPropLayoutChanged(
    visual: THREE.Object3D,
    row: MapBoxConfigRow | MapPortalConfigRow,
  ): boolean {
    const key = row.propTemplateKey ?? null;
    if ((visual.userData['propTemplateKey'] ?? null) !== key) {
      return true;
    }
    const yaw = typeof row.yaw === 'number' && Number.isFinite(row.yaw) ? row.yaw : 0;
    const prevYaw =
      typeof visual.userData['propYaw'] === 'number' ? (visual.userData['propYaw'] as number) : 0;
    if (Math.abs(yaw - prevYaw) > 1e-4) {
      return true;
    }
    const prevBlocks = visual.userData['blocksMovement'] !== false;
    const nextBlocks =
      row.kind === 'portal' ? true : (row as MapBoxConfigRow).blocksMovement !== false;
    if (prevBlocks !== nextBlocks) {
      return true;
    }
    const prevScale = visual.userData['propScale'] as { x: number; y: number; z: number } | undefined;
    if (!prevScale) {
      return true;
    }
    return (
      Math.abs(prevScale.x - row.scale.x) > 1e-4 ||
      Math.abs(prevScale.y - row.scale.y) > 1e-4 ||
      Math.abs(prevScale.z - row.scale.z) > 1e-4
    );
  }

  private toObstacleRectXZ(row: MapBoxConfigRow): ObstacleRectXZ {
    const padding = Math.max(0, row.collisionPaddingMeters ?? 0);
    const halfX = Math.max(0, row.scale.x / 2) + padding;
    const halfY = Math.max(0, row.scale.y / 2);
    const halfZ = Math.max(0, row.scale.z / 2) + padding;
    return {
      minX: row.position.x - halfX,
      maxX: row.position.x + halfX,
      minY: row.position.y - halfY,
      maxY: row.position.y + halfY,
      minZ: row.position.z - halfZ,
      maxZ: row.position.z + halfZ,
    };
  }

  private isPointInsideObstacleRectXZ(point: THREE.Vector3, rect: ObstacleRectXZ): boolean {
    return (
      point.x >= rect.minX &&
      point.x <= rect.maxX &&
      point.z >= rect.minZ &&
      point.z <= rect.maxZ
    );
  }

  private getSegmentEntryTIntoRectXZ(
    from: THREE.Vector3,
    to: THREE.Vector3,
    rect: ObstacleRectXZ,
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

  private resolveClientMoveAgainstObstacles(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
    if (this.obstacleRects.size === 0) {
      return to;
    }
    let firstHitT: number | null = null;
    for (const rect of this.obstacleRects.values()) {
      const fromInside = this.isPointInsideObstacleRectXZ(from, rect);
      const toInside = this.isPointInsideObstacleRectXZ(to, rect);
      if (fromInside && toInside) {
        return from.clone();
      }
      if (fromInside && !toInside) {
        continue;
      }
      const t = this.getSegmentEntryTIntoRectXZ(from, to, rect);
      if (t === null) {
        continue;
      }
      if (firstHitT === null || t < firstHitT) {
        firstHitT = t;
      }
    }
    if (firstHitT === null) {
      return to;
    }
    const segmentLen = Math.hypot(to.x - from.x, to.z - from.z);
    if (segmentLen < 1e-5) {
      return from.clone();
    }
    const epsilonT = Math.min(0.08, 0.02 / segmentLen);
    const safeT = Math.max(0, firstHitT - epsilonT);
    return new THREE.Vector3(
      from.x + (to.x - from.x) * safeT,
      to.y,
      from.z + (to.z - from.z) * safeT,
    );
  }

  private resolveCameraCollision(targetCamPos: THREE.Vector3): THREE.Vector3 {
    if (this.obstacleRects.size === 0) {
      return targetCamPos;
    }
    this.cameraCollisionDir.subVectors(targetCamPos, this.cameraLookAt);
    const desiredDistance = this.cameraCollisionDir.length();
    if (desiredDistance < 1e-4) {
      return targetCamPos;
    }
    this.cameraCollisionDir.normalize();
    const ox = this.cameraLookAt.x;
    const oy = this.cameraLookAt.y;
    const oz = this.cameraLookAt.z;
    const dx = this.cameraCollisionDir.x;
    const dy = this.cameraCollisionDir.y;
    const dz = this.cameraCollisionDir.z;
    const m = CAMERA_COLLISION_MARGIN;
    let nearestT: number | null = null;
    for (const rect of this.obstacleRects.values()) {
      const t = rayAabbEnterT(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        {
          minX: rect.minX - m,
          maxX: rect.maxX + m,
          minY: rect.minY - m,
          maxY: rect.maxY + m,
          minZ: rect.minZ - m,
          maxZ: rect.maxZ + m,
        },
        desiredDistance,
      );
      if (t === null) {
        continue;
      }
      if (nearestT === null || t < nearestT) {
        nearestT = t;
      }
    }
    if (nearestT === null) {
      return targetCamPos;
    }
    const safeDistance = Math.max(
      CAMERA_COLLISION_MIN_RADIUS,
      nearestT - CAMERA_COLLISION_MARGIN,
    );
    this.desiredCamPosCollisionResolved.copy(this.cameraLookAt).addScaledVector(
      this.cameraCollisionDir,
      safeDistance,
    );
    return this.desiredCamPosCollisionResolved;
  }

  private startLoop(): void {
    const loop = (timestamp: number): void => {
      this.raf = requestAnimationFrame(loop);
      try {
        this.simTimer.update(timestamp);
        const rawDt = this.simTimer.getDelta();
        const dt = Number.isFinite(rawDt)
          ? Math.min(0.05, Math.max(0, rawDt))
          : 1 / 60;
        if (this.renderer && this.scene && this.camera) {
          const tSim0 = performance.now();
          this.tickMovement(dt);
          this.tickCharacterLocomotionAnim();
          this.visuals.tickAnimations(dt);
          this.tickCombatActionChase();
          this.tickAutoAttackIntent(performance.now());
          this.tickMobMeshSmoothing(dt);
          this.tickSkillVfx(timestamp, dt);
          this.combatFloaters?.tick(timestamp);
          this.tickCorrectionLerp();
          this.blendVisualTowardAuthoritative(dt);
          this.tickCamera();
          this.recoverCameraIfBroken();
          this.updatePlayerMeshFromVisual();
          this.tickOtherPlayerWeaponSwing();
          if (this.worldSocket.socketConnected() && this.entitySync.player()) {
            this.maybeEmitMoveSample();
          }
          this.tickShopDistanceAutoClose();
          const tGl0 = performance.now();
          this.renderer.render(this.scene, this.camera);
          const tCss0 = performance.now();
          this.css2d.render(this.scene, this.camera);
          const tEnd = performance.now();
          this.perfHud?.sample(
            timestamp,
            tGl0 - tSim0,
            tCss0 - tGl0,
            tEnd - tCss0,
            this.renderer,
            this.scene,
            { mobs: this.mobRoot.children.length, drops: this.dropsRoot.children.length },
          );
        }
      } catch (e) {
        console.error('[GameViewport] Error en requestAnimationFrame / tick', e);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Si NaN/Inf llegó a la cámara o al follow, rearmar look-at desde posiciones finitas. */
  /**
   * Pide resucitar. El destino lo decide el Warden: el cliente sólo manda la intención y
   * espera el `player-respawn` autoritativo.
   */
  requestRespawn(): void {
    if (this.respawnPending() || !this.deathState()) {
      return;
    }
    this.respawnPending.set(true);
    this.worldSocket.emitRequestRespawn((res) => {
      if (res.ok) {
        // `player-respawn` cierra la pantalla; el ack sólo cubre el caso sin broadcast.
        this.deathState.set(null);
        this.respawnPending.set(false);
        this.snapPredictionToServer(res.worldPos, res.worldFacingYaw);
        return;
      }
      this.respawnPending.set(false);
      this.playerState.pushSystemLogLine(`No se pudo resucitar: ${res.message}`);
    });
  }

  /** Alinea predicción y autoritativa tras un teleport del servidor (respawn / portal). */
  private snapPredictionToServer(
    worldPos: { x: number; y: number; z: number },
    worldFacingYaw: number,
  ): void {
    if (!isFiniteVec3(worldPos)) {
      return;
    }
    this.authoritativePos.set(worldPos.x, worldPos.y, worldPos.z);
    this.authoritativeYaw = isFiniteYaw(worldFacingYaw) ? worldFacingYaw : this.authoritativeYaw;
    this.visualPos.copy(this.authoritativePos);
    this.visualYaw = this.authoritativeYaw;
    this.moveTarget = null;
    this.correctionLerp = null;
    this.lastEmittedPos.copy(this.visualPos);
    this.lastEmittedYaw = this.visualYaw;
    this.lastMoveEmitMs = performance.now();
  }

  private recoverCameraIfBroken(): void {
    if (!this.camera) {
      return;
    }
    const visOk = isFiniteVec3({ x: this.visualPos.x, y: this.visualPos.y, z: this.visualPos.z });
    const authOk = isFiniteVec3({
      x: this.authoritativePos.x,
      y: this.authoritativePos.y,
      z: this.authoritativePos.z,
    });
    const camOk =
      Number.isFinite(this.camera.position.x) &&
      Number.isFinite(this.camera.position.y) &&
      Number.isFinite(this.camera.position.z);
    const lookOk =
      Number.isFinite(this.cameraLookAt.x) &&
      Number.isFinite(this.cameraLookAt.y) &&
      Number.isFinite(this.cameraLookAt.z);
    if (visOk && authOk && camOk && lookOk) {
      return;
    }
    console.warn('[GameViewport] NaN en cámara/visual; recuperación desde autoritativa u origen');
    if (!visOk && authOk) {
      this.visualPos.copy(this.authoritativePos);
    } else if (!visOk) {
      this.visualPos.set(0, 0, 0);
    }
    if (!authOk) {
      this.authoritativePos.set(0, 0, 0);
    }
    this.cameraLookAt.set(this.visualPos.x, this.visualPos.y + Y_LIFT, this.visualPos.z);
    this.updateDesiredCameraPosition();
    this.camera.position.copy(this.desiredCamPos);
    this.camera.lookAt(this.cameraLookAt);
  }

  /** Suaviza la malla hacia el authoritative; zona muerta en XZ para no pelear con ecos de sync. */
  private blendVisualTowardAuthoritative(dt: number): void {
    if (DIAG_MOVEMENT_ISOLATE_CLIENT) {
      return;
    }
    if (!this.worldSocket.socketConnected() || !this.entitySync.player()) {
      return;
    }
    if (this.correctionLerp) {
      return;
    }
    if (this.moveTarget) {
      return;
    }
    if (
      !isFiniteVec3({
        x: this.authoritativePos.x,
        y: this.authoritativePos.y,
        z: this.authoritativePos.z,
      })
    ) {
      return;
    }
    const dx = this.visualPos.x - this.authoritativePos.x;
    const dz = this.visualPos.z - this.authoritativePos.z;
    const dXZ = Math.hypot(dx, dz);
    const yT = Math.min(1, 8 * dt);
    this.visualPos.y = THREE.MathUtils.lerp(this.visualPos.y, this.authoritativePos.y, yT);
    if (dXZ < BLEND_AUTH_DEAD_ZONE_XZ) {
      if (dXZ < 0.06) {
        this.visualPos.x = this.authoritativePos.x;
        this.visualPos.z = this.authoritativePos.z;
      }
      return;
    }
    const posRate = Math.min(9, 3.5 + dXZ * 0.45);
    const t = 1 - Math.exp(-posRate * dt);
    this.visualPos.x = THREE.MathUtils.lerp(this.visualPos.x, this.authoritativePos.x, t);
    this.visualPos.z = THREE.MathUtils.lerp(this.visualPos.z, this.authoritativePos.z, t);
    const yawRate = dXZ > 0.55 ? 10 : 5;
    this.visualYaw = THREE.MathUtils.lerp(this.visualYaw, this.authoritativeYaw, Math.min(1, yawRate * dt));
  }

  private tickMovement(dt: number): void {
    if (!this.moveTarget || !this.worldSocket.socketConnected()) {
      return;
    }
    if (!isFiniteVec3(this.moveTarget) || !isFiniteVec3(this.visualPos)) {
      return;
    }
    const speed = this.entitySync.playerMoveSpeed();
    const tx = this.moveTarget.x - this.visualPos.x;
    const tz = this.moveTarget.z - this.visualPos.z;
    const len = Math.hypot(tx, tz);
    if (len < 0.08) {
      this.moveTarget = null;
      return;
    }
    const nx = tx / len;
    const nz = tz / len;
    const step = speed * dt;
    const travel = Math.min(step, len);
    const candidate = new THREE.Vector3(
      this.visualPos.x + nx * travel,
      this.visualPos.y,
      this.visualPos.z + nz * travel,
    );
    const resolved = this.resolveClientMoveAgainstObstacles(this.visualPos, candidate);
    this.visualPos.x = resolved.x;
    this.visualPos.z = resolved.z;
    if (resolved.distanceToSquared(candidate) > 1e-6) {
      this.moveTarget = null;
    }
    this.visualYaw = Math.atan2(nx, nz);
    const yBlend = Math.min(1, 12 * dt);
    this.visualPos.y = THREE.MathUtils.lerp(this.visualPos.y, this.authoritativePos.y, yBlend);
  }

  /** Interpolación hacia posición/yaw autoritativos del mob (MOB_MOVED / snapshot). */
  private tickMobMeshSmoothing(dt: number): void {
    if (!this.glReady()) {
      return;
    }
    if (!Number.isFinite(dt) || dt < 0) {
      return;
    }
    const mobs = this.entitySync.mobs();
    const now = performance.now();
    for (const [id, m] of mobs) {
      const mesh = this.mobMeshes.get(id);
      if (!mesh) {
        continue;
      }
      if (!m.visible && !this.isMobDeathPlaying(mesh)) {
        continue;
      }
      if (!isFiniteVec3(m.pos) || !isFiniteYaw(m.yaw)) {
        continue;
      }
      let v = this.mobSmoothedPos.get(id);
      if (!v) {
        v = new THREE.Vector3(m.pos.x, m.pos.y, m.pos.z);
        this.mobSmoothedPos.set(id, v);
        this.mobSmoothedYaw.set(id, m.yaw);
        this.mobInterp.hardSnap(id, now, {
          x: m.pos.x,
          y: m.pos.y,
          z: m.pos.z,
          yaw: m.yaw,
        });
        mesh.position.set(v.x, v.y + Y_LIFT, v.z);
        mesh.rotation.y = m.yaw;
        continue;
      }
      if (this.mobPendingHardSnap.has(id)) {
        v.set(m.pos.x, m.pos.y, m.pos.z);
        this.mobSmoothedYaw.set(id, m.yaw);
        this.mobInterp.hardSnap(id, now, {
          x: m.pos.x,
          y: m.pos.y,
          z: m.pos.z,
          yaw: m.yaw,
        });
        mesh.position.set(v.x, v.y + Y_LIFT, v.z);
        mesh.rotation.y = m.yaw;
        this.mobPendingHardSnap.delete(id);
        continue;
      }
      if (!this.mobInterp.has(id)) {
        this.mobInterp.hardSnap(id, now, {
          x: m.pos.x,
          y: m.pos.y,
          z: m.pos.z,
          yaw: m.yaw,
        });
      }
      const pose = this.mobInterp.sample(id, now);
      if (!pose) {
        continue;
      }
      const prevX = v.x;
      const prevZ = v.z;
      v.set(pose.x, pose.y, pose.z);
      const yaw = pose.yaw;
      this.mobSmoothedYaw.set(id, yaw);
      if (
        !Number.isFinite(v.x) ||
        !Number.isFinite(v.y) ||
        !Number.isFinite(v.z) ||
        !Number.isFinite(yaw)
      ) {
        continue;
      }
      mesh.position.set(v.x, v.y + Y_LIFT, v.z);
      mesh.rotation.y = yaw;
      const visualSpeed =
        dt > 1e-4 ? Math.hypot(v.x - prevX, v.z - prevZ) / dt : 0;
      const wasMoving = this.mobVisualMoving.has(id);
      const moving =
        visualSpeed >= (wasMoving ? MOB_MOVE_ANIM_OFF_MPS : MOB_MOVE_ANIM_ON_MPS);
      if (moving) {
        this.mobVisualMoving.add(id);
      } else {
        this.mobVisualMoving.delete(id);
      }
      const inMelee = this.isMobInMeleeRange(mesh, m);
      const chasing = m.aiState === 'CHASE';
      this.visuals.setMobLocomotion(mesh, moving, chasing, inMelee);
      this.applyMobHitFlash(mesh, id, now, m.aiState);
    }
    for (const id of [...this.mobSmoothedPos.keys()]) {
      if (!mobs.has(id)) {
        this.mobSmoothedPos.delete(id);
        this.mobSmoothedYaw.delete(id);
        this.mobVisualMoving.delete(id);
        this.mobInterp.delete(id);
        this.mobPendingHardSnap.delete(id);
        this.mobHitFlashUntilMs.delete(id);
      }
    }
  }

  private tickCorrectionLerp(): void {
    const r = this.correctionLerp;
    if (!r) {
      return;
    }
    if (
      !isFiniteVec3(r.startVisual) ||
      !isFiniteVec3(r.target) ||
      !isFiniteYaw(r.startYaw) ||
      !isFiniteYaw(r.targetYaw)
    ) {
      this.correctionLerp = null;
      return;
    }
    const now = performance.now();
    const u = Math.min(1, (now - r.startTime) / r.durationMs);
    const t = u * u * (3 - 2 * u);
    this.visualPos.lerpVectors(r.startVisual, r.target, t);
    this.visualYaw = THREE.MathUtils.lerp(r.startYaw, r.targetYaw, t);
    if (u >= 1) {
      this.visualPos.copy(r.target);
      this.visualYaw = r.targetYaw;
      this.lastEmittedPos.copy(this.visualPos);
      this.lastEmittedYaw = this.visualYaw;
      this.lastMoveEmitMs = performance.now();
      this.correctionLerp = null;
    }
  }

  private tickCamera(): void {
    if (!this.entitySync.player()) {
      return;
    }
    if (!isFiniteVec3(this.visualPos)) {
      return;
    }
    this.cameraRadius = THREE.MathUtils.lerp(
      this.cameraRadius,
      this.cameraRadiusTarget,
      CAMERA_ZOOM_SMOOTH,
    );
    this.tmpFollow.set(this.visualPos.x, this.visualPos.y + Y_LIFT, this.visualPos.z);
    this.cameraLookAt.lerp(this.tmpFollow, CAMERA_FOLLOW_SMOOTH);
    this.updateDesiredCameraPosition();
    const resolvedCamTarget = this.resolveCameraCollision(this.desiredCamPos);
    this.camera.position.lerp(resolvedCamTarget, CAMERA_POS_SMOOTH);
    this.applyCameraShake();
    this.camera.lookAt(this.cameraLookAt);
  }

  private applyCameraShake(): void {
    if (!this.cameraShake) {
      return;
    }
    const now = performance.now();
    if (now >= this.cameraShake.endsAt) {
      this.cameraShake = null;
      return;
    }
    const total = Math.max(1, this.cameraShake.endsAt - this.cameraShake.startedAt);
    const remaining = this.cameraShake.endsAt - now;
    const strength = this.cameraShake.strength * (remaining / total);
    this.camera.position.x += (Math.random() * 2 - 1) * strength;
    this.camera.position.y += (Math.random() * 2 - 1) * strength * 0.7;
    this.camera.position.z += (Math.random() * 2 - 1) * strength;
  }

  private startCameraShake(durationMs: number, strength: number): void {
    const now = performance.now();
    this.cameraShake = {
      startedAt: now,
      endsAt: now + durationMs,
      strength,
    };
  }

  private updateDesiredCameraPosition(): void {
    this.cameraOrbitOffset.setFromSphericalCoords(
      this.cameraRadius,
      this.cameraPolarAngle,
      this.cameraAzimuthAngle,
    );
    this.desiredCamPos.copy(this.cameraLookAt).add(this.cameraOrbitOffset);
  }

  private updatePlayerMeshFromVisual(): void {
    if (!this.playerMesh) {
      return;
    }
    if (!isFiniteVec3(this.visualPos) || !isFiniteYaw(this.visualYaw)) {
      return;
    }
    this.playerMesh.position.set(
      this.visualPos.x,
      this.visualPos.y + Y_LIFT,
      this.visualPos.z,
    );
    this.playerMesh.rotation.y = this.visualYaw;
    this.applyWeaponVisual(
      this.playerMesh,
      this.getSelfWeaponPlusLevel(),
      Boolean(this.getSelfEquippedWeapon()),
    );
    const selfId = this.entitySync.selfCharacterId();
    if (selfId) {
      this.applyWeaponSwing(this.playerMesh, selfId);
    }
    const now = performance.now();
    if (now < this.healFlashUntilMs) {
      const w = (this.healFlashUntilMs - now) / 380;
      this.visuals.applyTint(this.playerMesh, {
        color: 0x4ade80,
        emissive: 0x166534,
        emissiveIntensity: 0.52 * w,
      });
    } else if (now < this.meleeHitFlashUntilMs) {
      const w = (this.meleeHitFlashUntilMs - now) / 220;
      this.visuals.applyTint(this.playerMesh, {
        color: PLAYER_COLOR,
        emissive: 0xaaccff,
        emissiveIntensity: 0.45 * w,
      });
    } else {
      this.visuals.applyTint(this.playerMesh, {
        color: PLAYER_COLOR,
        emissive: 0x000000,
        emissiveIntensity: 0,
      });
    }
  }

  private getSelfWeaponPlusLevel(): number {
    const equipped = this.getSelfEquippedWeapon();
    return typeof equipped?.plusLevel === 'number' && Number.isFinite(equipped.plusLevel)
      ? equipped.plusLevel
      : 0;
  }

  private getSelfEquippedWeapon() {
    return this.playerState.inventoryItems().find((item) => {
      if (item.location !== 'EQUIPPED') {
        return false;
      }
      const slot = (item.gearSlot ?? item.baseSlot ?? '').toUpperCase();
      return slot === 'WEAPON';
    });
  }

  private tickOtherPlayerWeaponSwing(): void {
    for (const [id, mesh] of this.otherPlayerMeshes) {
      this.applyWeaponSwing(mesh, id);
    }
  }

  /**
   * Pide walk/idle al rig según destino local (click-to-move) y desplazamiento visible de
   * otros jugadores. El one-shot de combate no se cancela: el rig vuelve solo al terminar.
   */
  private tickCharacterLocomotionAnim(): void {
    this.visuals.setCharacterMoving(
      this.playerMesh,
      !!this.moveTarget && !this.deathState(),
    );
    for (const [id, mesh] of this.otherPlayerMeshes) {
      let last = this.otherPlayerLastPos.get(id);
      if (!last) {
        last = mesh.position.clone();
        this.otherPlayerLastPos.set(id, last);
        this.visuals.setCharacterMoving(mesh, false);
        continue;
      }
      const moved =
        Math.hypot(mesh.position.x - last.x, mesh.position.z - last.z) > 0.012;
      this.visuals.setCharacterMoving(mesh, moved);
      last.copy(mesh.position);
    }
  }

  private resolveCharacterVisual(characterId: string): EntityVisual | null {
    if (characterId === this.entitySync.selfCharacterId()) {
      return this.playerMesh;
    }
    return this.otherPlayerMeshes.get(characterId) ?? null;
  }

  private maybeEmitMoveSample(): void {
    if (!isFiniteVec3(this.visualPos) || !isFiniteYaw(this.visualYaw)) {
      return;
    }
    const now = performance.now();
    const elapsed = now - this.lastMoveEmitMs;
    const firstSample = !Number.isFinite(this.lastEmittedPos.x);
    const posChanged =
      firstSample ||
      this.visualPos.distanceToSquared(this.lastEmittedPos) > 0.0004;
    const yawChanged =
      !Number.isFinite(this.lastEmittedYaw) ||
      Math.abs(this.visualYaw - this.lastEmittedYaw) > 0.02;

    if (this.moveIntentDirty) {
      /* cambio de destino: envío inmediato */
    } else if (!firstSample && elapsed < MOVE_EMIT_MS) {
      return;
    } else if (!this.moveTarget && !posChanged && !yawChanged) {
      return;
    }

    this.lastMoveEmitMs = now;
    this.moveIntentDirty = false;
    this.lastEmittedPos.copy(this.visualPos);
    this.lastEmittedYaw = this.visualYaw;
    this.worldSocket.emitPlayerMove({
      worldPos: {
        x: this.visualPos.x,
        y: this.visualPos.y,
        z: this.visualPos.z,
      },
      worldFacingYaw: this.visualYaw,
    });
  }

  private onResize(): void {
    const host = this.viewportRef.nativeElement;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 2 || h < 2) {
      return;
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.css2d.setSize(w, h);
  }

  private ensurePlayerMesh(exists: boolean): void {
    if (!exists) {
      if (this.playerMesh) {
        this.scene.remove(this.playerMesh);
        this.visuals.disposeVisual(this.playerMesh);
        this.playerMesh = null;
      }
      return;
    }
    if (!this.playerMesh) {
      this.playerMesh = this.visuals.createPlayerVisual();
      this.scene.add(this.playerMesh);
    }
  }

  private stripMeshCss2dChildren(mesh: EntityVisual): void {
    const labels = mesh.children.filter((ch): ch is CSS2DObject => ch instanceof CSS2DObject);
    for (const label of labels) {
      mesh.remove(label);
      label.element.remove();
    }
    delete mesh.userData['mobHpBarReady'];
    delete mesh.userData['mobHpBarFill'];
    delete mesh.userData['mobAggroIndicatorReady'];
    delete mesh.userData['mobAggroIndicatorNode'];
  }

  private reconcileWorldDrops(dropMap: Map<string, WorldDropEntityState>): void {
    for (const id of this.dropMeshes.keys()) {
      if (!dropMap.has(id)) {
        const mesh = this.dropMeshes.get(id)!;
        this.dropsRoot.remove(mesh);
        this.visuals.disposeVisual(mesh);
        this.dropMeshes.delete(id);
      }
    }
    for (const [id, d] of dropMap) {
      let mesh = this.dropMeshes.get(id);
      if (!mesh) {
        mesh = this.visuals.createDropVisual(id);
        this.dropMeshes.set(id, mesh);
        this.dropsRoot.add(mesh);
      }
      this.visuals.applyTint(mesh, this.visuals.resolveDropTint(d.grade));
      mesh.position.set(d.pos.x, d.pos.y + DROP_Y_LIFT, d.pos.z);
    }
  }

  private reconcileNpcs(npcMap: Map<string, NpcEntityState>): void {
    for (const id of this.npcMeshes.keys()) {
      if (!npcMap.has(id)) {
        const mesh = this.npcMeshes.get(id)!;
        this.npcRoot.remove(mesh);
        this.visuals.disposeVisual(mesh);
        this.npcMeshes.delete(id);
      }
    }
    for (const [id, n] of npcMap) {
      let mesh = this.npcMeshes.get(id);
      if (!mesh) {
        mesh = this.visuals.createNpcVisual(id, n.npcTemplateKey);
        this.npcMeshes.set(id, mesh);
        this.npcRoot.add(mesh);
      }
      mesh.position.set(n.pos.x, n.pos.y + Y_LIFT, n.pos.z);
    }
  }

  private reconcileMobs(mobMap: Map<string, MobEntityState>): void {
    for (const id of this.mobMeshes.keys()) {
      if (!mobMap.has(id)) {
        const mesh = this.mobMeshes.get(id)!;
        this.stripMeshCss2dChildren(mesh);
        this.mobRoot.remove(mesh);
        this.visuals.disposeVisual(mesh);
        this.mobMeshes.delete(id);
        this.mobPendingHardSnap.delete(id);
        this.mobVisualMoving.delete(id);
        this.mobInterp.delete(id);
        this.mobHitFlashUntilMs.delete(id);
      }
    }
    for (const [id, m] of mobMap) {
      let mesh = this.mobMeshes.get(id);
      if (!mesh) {
        mesh = this.visuals.createMobVisual(id, m.mobTemplateKey);
        this.mobMeshes.set(id, mesh);
        this.mobRoot.add(mesh);
        const px = isFiniteVec3(m.pos) ? m.pos.x : 0;
        const py = isFiniteVec3(m.pos) ? m.pos.y : 0;
        const pz = isFiniteVec3(m.pos) ? m.pos.z : 0;
        const p = new THREE.Vector3(px, py, pz);
        this.mobSmoothedPos.set(id, p);
        const yaw0 = isFiniteYaw(m.yaw) ? m.yaw : 0;
        this.mobSmoothedYaw.set(id, yaw0);
        mesh.position.set(p.x, p.y + Y_LIFT, p.z);
        mesh.rotation.y = yaw0;
        this.mobInterp.hardSnap(id, performance.now(), {
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: yaw0,
        });
        this.mobPendingHardSnap.add(id);
      }
      mesh.visible = m.visible || this.isMobDeathPlaying(mesh);
      this.ensureMobHpBar(mesh);
      this.updateMobHpBar(mesh, m);
      this.ensureMobAggroIndicator(mesh);
      this.updateMobAggroIndicator(mesh, m);
    }
  }

  private isMobDeathPlaying(mesh: EntityVisual): boolean {
    const until = mesh.userData['mobDeathUntilMs'];
    return typeof until === 'number' && performance.now() < until;
  }

  private ensureMobHpBar(mesh: EntityVisual): void {
    if (mesh.userData['mobHpBarReady']) {
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'aetheris-mob-hpbar';
    const fill = document.createElement('div');
    fill.className = 'aetheris-mob-hpbar__fill';
    wrap.appendChild(fill);
    const label = new CSS2DObject(wrap);
    label.position.set(0, this.resolveMobChromeY(mesh, 0.5), 0);
    mesh.add(label);
    mesh.userData['mobHpBarReady'] = true;
    mesh.userData['mobHpBarFill'] = fill;
    mesh.userData['mobHpBarLabel'] = label;
  }

  private resolveMobChromeY(mesh: EntityVisual, extra: number): number {
    const top = mesh.userData['visualTopY'];
    if (typeof top === 'number' && Number.isFinite(top)) {
      return top + extra;
    }
    return BOX * 0.5 + 0.5 + extra;
  }

  private updateMobHpBar(mesh: EntityVisual, m: MobEntityState): void {
    const fill = mesh.userData['mobHpBarFill'] as HTMLDivElement | undefined;
    const label = mesh.userData['mobHpBarLabel'] as CSS2DObject | undefined;
    if (label) {
      label.position.y = this.resolveMobChromeY(mesh, 0);
    }
    if (!fill) {
      return;
    }
    const pct = m.maxHp > 0 ? Math.max(0, Math.min(100, (100 * m.currentHp) / m.maxHp)) : 0;
    fill.style.width = `${pct}%`;
    fill.classList.toggle('aetheris-mob-hpbar__fill--low', pct > 0 && pct < 35);
  }

  private ensureMobAggroIndicator(mesh: EntityVisual): void {
    if (mesh.userData['mobAggroIndicatorReady']) {
      return;
    }
    const marker = document.createElement('div');
    marker.className = 'aetheris-mob-aggro-indicator';
    marker.textContent = '!';
    const label = new CSS2DObject(marker);
    label.position.set(0, this.resolveMobChromeY(mesh, 0.45), 0);
    mesh.add(label);
    mesh.userData['mobAggroIndicatorReady'] = true;
    mesh.userData['mobAggroIndicatorNode'] = marker;
    mesh.userData['mobAggroIndicatorLabel'] = label;
  }

  private updateMobAggroIndicator(mesh: EntityVisual, m: MobEntityState): void {
    const marker = mesh.userData['mobAggroIndicatorNode'] as HTMLDivElement | undefined;
    const label = mesh.userData['mobAggroIndicatorLabel'] as CSS2DObject | undefined;
    if (label) {
      label.position.y = this.resolveMobChromeY(mesh, 0.45);
    }
    if (!marker) {
      return;
    }
    const active = m.visible && m.aiState === 'CHASE';
    marker.classList.toggle('is-active', active);
  }

  private triggerMobHitFlash(mobId: string): void {
    this.mobHitFlashUntilMs.set(mobId, performance.now() + MOB_HIT_FLASH_MS);
  }

  private isMobInMeleeRange(
    mesh: EntityVisual,
    m: MobEntityState,
    characterId?: string,
  ): boolean {
    const range = (m.attackRange > 0 ? m.attackRange : 2.5) + MOB_MELEE_VISUAL_SLACK_METERS;
    const mx = mesh.position.x;
    const mz = mesh.position.z;
    if (characterId) {
      const target = this.resolveCharacterVisualXz(characterId);
      if (!target) {
        return false;
      }
      return Math.hypot(mx - target.x, mz - target.z) <= range;
    }
    if (Math.hypot(mx - this.visualPos.x, mz - this.visualPos.z) <= range) {
      return true;
    }
    for (const other of this.otherPlayerMeshes.values()) {
      if (Math.hypot(mx - other.position.x, mz - other.position.z) <= range) {
        return true;
      }
    }
    return false;
  }

  private resolveCharacterVisualXz(characterId: string): { x: number; z: number } | null {
    if (characterId === this.entitySync.selfCharacterId()) {
      return { x: this.visualPos.x, z: this.visualPos.z };
    }
    const mesh = this.otherPlayerMeshes.get(characterId);
    if (mesh) {
      return { x: mesh.position.x, z: mesh.position.z };
    }
    const other = this.entitySync.otherPlayers().get(characterId);
    if (!other) {
      return null;
    }
    return { x: other.pos.x, z: other.pos.z };
  }

  private applyMobHitFlash(
    mesh: EntityVisual,
    mobId: string,
    now: number,
    aiState: MobEntityState['aiState'],
  ): void {
    const isAggro = aiState === 'CHASE';
    this.visuals.setMobAggroAura(mesh, isAggro);
    const gltfReady = Boolean(mesh.userData['gltfModel']);
    const until = this.mobHitFlashUntilMs.get(mobId) ?? 0;
    if (now < until) {
      const ratio = Math.max(0, Math.min(1, (until - now) / MOB_HIT_FLASH_MS));
      this.visuals.applyTint(mesh, {
        color: MOB_COLOR,
        emissive: 0xffffff,
        emissiveIntensity: 0.95 + ratio * 0.65,
      });
      return;
    }
    if (gltfReady) {
      this.visuals.applyTint(mesh, {
        color: MOB_COLOR,
        emissive: 0x000000,
        emissiveIntensity: 0,
      });
      return;
    }
    if (isAggro) {
      this.visuals.applyTint(mesh, {
        color: MOB_AGGRO_COLOR,
        emissive: 0x8a3200,
        emissiveIntensity: 0.32,
      });
      return;
    }
    this.visuals.applyTint(mesh, {
      color: MOB_COLOR,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
  }

  private spawnSkillImpactVfx(skillId: string, attackerId: string, targetId: string): void {
    const targetPos = this.resolveMobWorldPosition(targetId);
    if (!targetPos) {
      return;
    }
    if (skillId === 'power_strike') {
      const attackerPos = this.resolveAttackerWorldPosition(attackerId);
      if (attackerPos) {
        this.spawnPowerStrikeSlash(attackerPos, targetPos);
      }
      return;
    }
    if (skillId === 'rageful_blow') {
      this.spawnRagefulBlowBurst(targetPos, RAGEFUL_BLOW_AOE_RADIUS);
    }
  }

  private resolveMobWorldPosition(mobId: string): THREE.Vector3 | null {
    const mesh = this.mobMeshes.get(mobId);
    if (mesh) {
      const out = new THREE.Vector3();
      mesh.getWorldPosition(out);
      return out;
    }
    const mob = this.entitySync.mobs().get(mobId);
    if (!mob) {
      return null;
    }
    return new THREE.Vector3(mob.pos.x, mob.pos.y + Y_LIFT, mob.pos.z);
  }

  private resolveAttackerWorldPosition(characterId: string): THREE.Vector3 | null {
    if (characterId === this.entitySync.selfCharacterId()) {
      return new THREE.Vector3(this.visualPos.x, this.visualPos.y + Y_LIFT, this.visualPos.z);
    }
    const otherMesh = this.otherPlayerMeshes.get(characterId);
    if (otherMesh) {
      const out = new THREE.Vector3();
      otherMesh.getWorldPosition(out);
      return out;
    }
    const other = this.entitySync.otherPlayers().get(characterId);
    if (!other) {
      return null;
    }
    return new THREE.Vector3(other.pos.x, other.pos.y + Y_LIFT, other.pos.z);
  }

  private spawnPowerStrikeSlash(from: THREE.Vector3, to: THREE.Vector3): void {
    const start = from.clone();
    const end = to.clone();
    start.y += 0.2;
    end.y += 0.2;
    const geom = new THREE.BufferGeometry().setFromPoints([start, end]);
    const mat = new THREE.LineBasicMaterial({
      color: 0xf4fbff,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(geom, mat);
    this.skillFxRoot.add(line);
    this.activeSlashFxs.push({
      line,
      material: mat,
      startedAt: performance.now(),
      durationMs: POWER_STRIKE_SLASH_MS,
    });
  }

  private spawnRagefulBlowBurst(center: THREE.Vector3, radius: number): void {
    const particles: BurstParticle[] = [];
    for (let i = 0; i < RAGEFUL_BLOW_PARTICLES; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const ring = Math.sqrt(Math.random()) * radius;
      const x = center.x + Math.cos(angle) * ring;
      const z = center.z + Math.sin(angle) * ring;
      const particleSize = THREE.MathUtils.randFloat(0.05, 0.12);
      const geom = new THREE.SphereGeometry(particleSize, 6, 6);
      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xe3a04f : 0xc8c8c8,
        transparent: true,
        opacity: 0.95,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(x, center.y + 0.05, z);
      this.skillFxRoot.add(mesh);
      particles.push({
        mesh,
        velocity: new THREE.Vector3(
          Math.cos(angle) * THREE.MathUtils.randFloat(1.8, 3.6),
          THREE.MathUtils.randFloat(1.4, 3.1),
          Math.sin(angle) * THREE.MathUtils.randFloat(1.8, 3.6),
        ),
      });
    }
    this.activeBurstFxs.push({
      particles,
      startedAt: performance.now(),
      durationMs: RAGEFUL_BLOW_BURST_MS,
    });
  }

  private tickSkillVfx(now: number, dt: number): void {
    for (let i = this.activeSlashFxs.length - 1; i >= 0; i -= 1) {
      const fx = this.activeSlashFxs[i]!;
      const t = (now - fx.startedAt) / fx.durationMs;
      if (t >= 1) {
        this.skillFxRoot.remove(fx.line);
        fx.line.geometry.dispose();
        fx.material.dispose();
        this.activeSlashFxs.splice(i, 1);
        continue;
      }
      fx.material.opacity = Math.max(0, 1 - t);
    }

    const gravity = 9.2;
    for (let i = this.activeBurstFxs.length - 1; i >= 0; i -= 1) {
      const fx = this.activeBurstFxs[i]!;
      const t = (now - fx.startedAt) / fx.durationMs;
      if (t >= 1) {
        for (const p of fx.particles) {
          this.skillFxRoot.remove(p.mesh);
          p.mesh.geometry.dispose();
          (p.mesh.material as THREE.Material).dispose();
        }
        this.activeBurstFxs.splice(i, 1);
        continue;
      }
      const opacity = Math.max(0, 1 - t);
      for (const p of fx.particles) {
        p.velocity.y -= gravity * dt;
        p.mesh.position.addScaledVector(p.velocity, dt);
        const mat = p.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = opacity;
      }
    }
  }

  private reconcileOtherPlayers(map: Map<string, OtherPlayerEntityState>): void {
    for (const id of this.otherPlayerMeshes.keys()) {
      if (!map.has(id)) {
        const mesh = this.otherPlayerMeshes.get(id)!;
        this.stripMeshCss2dChildren(mesh);
        this.otherPlayersRoot.remove(mesh);
        this.visuals.disposeVisual(mesh);
        this.otherPlayerMeshes.delete(id);
        this.otherPlayerLastPos.delete(id);
      }
    }
    for (const [id, o] of map) {
      let mesh = this.otherPlayerMeshes.get(id);
      if (!mesh) {
        mesh = this.visuals.createOtherPlayerVisual(id);
        this.otherPlayerMeshes.set(id, mesh);
        this.otherPlayersRoot.add(mesh);
      }
      mesh.position.set(o.pos.x, o.pos.y + Y_LIFT, o.pos.z);
      mesh.rotation.y = o.yaw;
      this.ensureOtherPlayerNameLabel(mesh);
      this.updateOtherPlayerNameLabel(mesh, o);
      this.applyWeaponVisual(mesh, o.weaponPlusLevel, o.weaponEquipped);
      this.applyWeaponSwing(mesh, id);
    }
  }

  private ensureOtherPlayerNameLabel(mesh: EntityVisual): void {
    if (mesh.userData['otherPlayerNameLabelReady']) {
      return;
    }
    const node = document.createElement('div');
    node.className = 'aetheris-player-name';
    const label = new CSS2DObject(node);
    label.position.set(0, BOX * 0.5 + 0.68, 0);
    mesh.add(label);
    mesh.userData['otherPlayerNameLabelReady'] = true;
    mesh.userData['otherPlayerNameLabelNode'] = node;
  }

  private updateOtherPlayerNameLabel(mesh: EntityVisual, state: OtherPlayerEntityState): void {
    const node = mesh.userData['otherPlayerNameLabelNode'] as HTMLDivElement | undefined;
    if (!node) {
      return;
    }
    node.textContent = state.name;
    node.style.color = KARMA_NAME_COLORS[state.karmaFlag];
  }

  private applyWeaponVisual(mesh: EntityVisual, plusLevel: number, equipped: boolean): void {
    this.visuals.applyPaperdollWeapon(mesh, { equipped, plusLevel });
  }

  private triggerWeaponSwing(characterId: string): void {
    this.weaponSwingUntilByCharacterId.set(characterId, performance.now() + WEAPON_SWING_MS);
  }

  private applyWeaponSwing(mesh: EntityVisual, characterId: string): void {
    if (mesh.userData['gltfModel']) {
      return;
    }
    const anchor = this.visuals.getWeaponAnchor(mesh);
    if (!anchor) {
      return;
    }
    const until = this.weaponSwingUntilByCharacterId.get(characterId) ?? 0;
    if (performance.now() > until) {
      anchor.rotation.z = THREE.MathUtils.lerp(anchor.rotation.z, 0, 0.26);
      return;
    }
    const ratio = Math.max(0, Math.min(1, (until - performance.now()) / WEAPON_SWING_MS));
    anchor.rotation.z = Math.sin((1 - ratio) * Math.PI) * 0.95;
  }

  private clearEntityMeshes(): void {
    if (!this.scene) {
      return;
    }
    this.mobSmoothedPos.clear();
    this.mobSmoothedYaw.clear();
    this.mobVisualMoving.clear();
    this.mobInterp.clear();
    this.mobPendingHardSnap.clear();
    this.mobHitFlashUntilMs.clear();
    this.weaponSwingUntilByCharacterId.clear();
    this.otherPlayerLastPos.clear();
    this.clearSkillFx();
    this.cameraShake = null;
    for (const mesh of this.mobMeshes.values()) {
      this.stripMeshCss2dChildren(mesh);
      this.mobRoot.remove(mesh);
      this.visuals.disposeVisual(mesh);
    }
    this.mobMeshes.clear();
    for (const mesh of this.npcMeshes.values()) {
      this.npcRoot.remove(mesh);
      this.visuals.disposeVisual(mesh);
    }
    this.npcMeshes.clear();
    for (const mesh of this.dropMeshes.values()) {
      this.dropsRoot.remove(mesh);
      this.visuals.disposeVisual(mesh);
    }
    this.dropMeshes.clear();
    for (const mesh of this.otherPlayerMeshes.values()) {
      this.stripMeshCss2dChildren(mesh);
      this.otherPlayersRoot.remove(mesh);
      this.visuals.disposeVisual(mesh);
    }
    this.otherPlayerMeshes.clear();
    for (const mesh of this.obstacleMeshes.values()) {
      this.obstacleRoot.remove(mesh);
      this.visuals.disposeVisual(mesh);
    }
    this.obstacleMeshes.clear();
    this.obstacleRects.clear();
    for (const mesh of this.portalMeshes.values()) {
      this.portalRoot.remove(mesh);
      this.visuals.disposeVisual(mesh);
    }
    this.portalMeshes.clear();
    if (this.playerMesh) {
      this.scene.remove(this.playerMesh);
      this.visuals.disposeVisual(this.playerMesh);
      this.playerMesh = null;
    }
    this.combatFloaters?.clear();
  }

  private clearSkillFx(): void {
    for (const fx of this.activeSlashFxs) {
      this.skillFxRoot.remove(fx.line);
      fx.line.geometry.dispose();
      fx.material.dispose();
    }
    this.activeSlashFxs.length = 0;
    for (const fx of this.activeBurstFxs) {
      for (const p of fx.particles) {
        this.skillFxRoot.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
      }
    }
    this.activeBurstFxs.length = 0;
    this.combatFloaters?.clear();
  }

  private spawnDamageFloater(
    worldPos: THREE.Vector3,
    damage: number,
    critical: boolean,
    backstab: boolean,
    skillHit = false,
  ): void {
    this.floaterPos.copy(worldPos);
    this.floaterPos.y += Y_LIFT + 0.35;
    this.combatFloaters?.spawnDamage(this.floaterPos, damage, critical, backstab, skillHit);
  }

  private tickShopDistanceAutoClose(): void {
    if (!this.worldSocket.socketConnected()) {
      return;
    }
    const shop = this.npcShopUi.shop();
    if (!shop) {
      return;
    }
    const npc = this.entitySync.npcs().get(shop.npcInstanceId);
    if (!npc) {
      this.closeNpcShopForDistance('El mercader ya no está en la zona.');
      return;
    }
    const dx = this.visualPos.x - npc.pos.x;
    const dz = this.visualPos.z - npc.pos.z;
    if (Math.hypot(dx, dz) > SHOP_AUTO_CLOSE_DISTANCE_M) {
      this.closeNpcShopForDistance('Te alejaste del mercader.');
    }
  }

  private closeNpcShopForDistance(message: string): void {
    this.playerState.pushSystemLogLine(`[Tienda] ${message}`);
    this.worldSocket.emitNpcCloseInteract();
    this.npcShopUi.close();
  }

  private openMerchantStore(npcInstanceId: string, npcName: string): void {
    this.worldSocket.emitOpenMerchantStoreWithAck({ npcInstanceId }, (ack) => {
      if (!ack.ok) {
        this.lastDenied.set(`${ack.code}: ${ack.message}`);
        this.playerState.pushSystemLogLine(`[Tienda] ${ack.message}`);
        this.visuals.playNpcShopClose(this.npcMeshes.get(npcInstanceId));
        if (this.merchantBoxNpcId === npcInstanceId) {
          this.merchantBoxNpcId = null;
        }
        this.npcShopUi.close();
        return;
      }
      this.lastDenied.set(null);
      this.npcShopUi.open(ack);
      this.playerState.pushSystemLogLine(`[Tienda] ${npcName}: tienda abierta.`);
    });
  }

  /** +N XP sobre el cubo del jugador (payload autoritativo del Warden). */
  private spawnXpFloater(amount: number): void {
    this.floaterPos.set(
      this.visualPos.x,
      this.visualPos.y + Y_LIFT + 0.55,
      this.visualPos.z,
    );
    this.combatFloaters?.spawnXp(this.floaterPos, amount);
  }

  /** Texto flotante sobre el jugador al recoger botín (feedback inmediato). */
  private spawnHealingFloaterForCharacter(characterId: string, hpRestored: number): void {
    if (hpRestored <= 0) {
      return;
    }
    const v = new THREE.Vector3();
    if (characterId === this.entitySync.selfCharacterId()) {
      v.set(this.visualPos.x, this.visualPos.y + Y_LIFT, this.visualPos.z);
    } else {
      const mesh = this.otherPlayerMeshes.get(characterId);
      if (!mesh) {
        return;
      }
      mesh.getWorldPosition(v);
    }
    this.spawnHealingFloaterAt(v, hpRestored);
  }

  private spawnHealingFloaterAt(worldBase: THREE.Vector3, hp: number): void {
    this.floaterPos.set(worldBase.x, worldBase.y + 0.35, worldBase.z);
    this.combatFloaters?.spawnHeal(this.floaterPos, hp);
  }

  private spawnLootFloater(labelText: string): void {
    this.floaterPos.set(
      this.visualPos.x,
      this.visualPos.y + Y_LIFT + 0.85,
      this.visualPos.z,
    );
    this.combatFloaters?.spawnLoot(this.floaterPos, labelText);
  }

  private requestDropPreviewForMob(mobInstanceId: string): void {
    this.targetDropPreviewLoading.set(true);
    this.targetDropPreviewError.set(null);
    this.worldSocket.emitGetMobDropPreviewWithAck({ mobInstanceId }, (ack) => {
      if (mobInstanceId !== this.activeTargetId) {
        return;
      }
      this.targetDropPreviewLoading.set(false);
      this.targetDropPreviewMobId = mobInstanceId;
      if (!ack.ok) {
        this.targetDropPreviewError.set(ack.message);
        this.targetDropPreviewItems.set([]);
        this.targetDropPreviewLevelPenalty.set(false);
        return;
      }
      this.targetDropPreviewLevelPenalty.set(ack.levelPenaltyActive);
      this.targetDropPreviewItems.set(
        ack.items.map((item: WsMobDropPreviewItemPayload) => ({
          catalogKey: item.catalogKey,
          itemDisplayName: item.itemDisplayName,
          icon: item.icon,
          grade: item.grade,
          chance: item.chance,
        })),
      );
    });
  }

  private resetDropPreviewState(): void {
    this.targetDropPreviewOpen.set(false);
    this.targetDropPreviewLoading.set(false);
    this.targetDropPreviewError.set(null);
    this.targetDropPreviewLevelPenalty.set(false);
    this.targetDropPreviewItems.set([]);
    this.targetDropPreviewMobId = null;
  }

}
