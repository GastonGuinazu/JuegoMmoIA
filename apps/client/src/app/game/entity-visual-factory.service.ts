import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { MapBoxConfigRow, MapPortalConfigRow } from './world-map-loader.service';
import type { WorldDropEntityState } from './world-entity-sync.service';
import { GLTFMaterialsSpecularGlossinessCompatExtension } from './gltf-spec-gloss-compat';
import {
  CharacterAnimRig,
  type CharacterCombatAnim,
} from './character-anim-rig';
import { MobAnimRig, pruneMobAnimationTracks } from './mob-anim-rig';
import { resolveMobVisualDef, type MobVisualDef } from './mob-visual-catalog';
import { resolveNpcVisualDef, type NpcVisualDef } from './npc-visual-catalog';
import { resolvePropVisualDef, type PropVisualDef } from './prop-visual-catalog';

/**
 * Raíz visual de una entidad en el SceneGraph.
 *
 * Puede ser una primitiva simple (`THREE.Mesh`, para mob/npc/drop/obstacle/portal) o un
 * `THREE.Group` compuesto (jugador/otros jugadores, cilindro + esfera). Al migrar a
 * `.gltf`/`.glb` sigue siendo un `Object3D` y sólo cambia el interior de este servicio: el
 * `GameViewportComponent` nunca construye geometría ni materiales por su cuenta.
 */
export type EntityVisual = THREE.Object3D;

export type EntityVisualKind =
  | 'player'
  | 'otherPlayer'
  | 'mob'
  | 'npc'
  | 'drop'
  | 'obstacle'
  | 'portal';

export const PLAYER_COLOR = 0x5b8cff;
export const MOB_COLOR = 0xc0392b;
export const MOB_AGGRO_COLOR = 0xe06b2f;
export const OTHER_PLAYER_COLOR = 0x8899aa;
export const DROP_COLOR = 0xffcc33;
/** Mercader / NPC interactivo (clic izquierdo → tienda). */
export const NPC_MERCHANT_COLOR = 0x22c55e;

export const BOX = 0.8;
export const Y_LIFT = BOX / 2;
export const DROP_BOX = 0.38;

let mobAggroRingGeometry: THREE.RingGeometry | undefined;
let mobAggroRingMaterial: THREE.MeshBasicMaterial | undefined;

/** Geometría y material compartidos por todos los mobs (aro de aggro, sin luces). */
function getMobAggroRingGeometry(): THREE.RingGeometry {
  return (mobAggroRingGeometry ??= new THREE.RingGeometry(0.7, 0.95, 32));
}

function getMobAggroRingMaterial(): THREE.MeshBasicMaterial {
  return (mobAggroRingMaterial ??= new THREE.MeshBasicMaterial({
    color: 0xff6a28,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
}

export const DROP_Y_LIFT = DROP_BOX / 2 + 0.06;

/** Gema del drop (reemplaza el cubo plano original) + anillo de piso que bloom hace brillar. */
const DROP_GEM_RADIUS = 0.22;
const DROP_RING_INNER = 0.3;
const DROP_RING_OUTER = 0.42;

let dropGemGeometry: THREE.OctahedronGeometry | undefined;
function getDropGemGeometry(): THREE.OctahedronGeometry {
  return (dropGemGeometry ??= new THREE.OctahedronGeometry(DROP_GEM_RADIUS, 0));
}

let dropRingGeometry: THREE.RingGeometry | undefined;
function getDropRingGeometry(): THREE.RingGeometry {
  return (dropRingGeometry ??= new THREE.RingGeometry(DROP_RING_INNER, DROP_RING_OUTER, 24));
}

const OBSTACLE_COLOR = 0x9aa3ad;
const OBSTACLE_EMISSIVE = 0x2a2e35;
const OBSTACLE_EMISSIVE_INTENSITY = 0.35;
const PORTAL_COLOR = 0x00c8e8;
const PORTAL_EMISSIVE = 0x004455;
const PORTAL_EMISSIVE_INTENSITY = 0.55;
const PORTAL_FX_COLOR = new THREE.Color(0x5ce8ff);
const PORTAL_LIGHT_INTENSITY = 1.35;
const PORTAL_LIGHT_DECAY = 2;
/** Plano de zona (XZ). 128 cubre hunting ±32 y boss x=48; el 256 era vacío inútil. */
const GROUND_SIZE_DEFAULT = 128;
const GROUND_SIZE_MIN = 48;
const GROUND_SIZE_MAX = 256;
/** Fallback si el albedo no carga. Con textura el material usa `0xffffff` para no teñirla. */
const GROUND_COLOR = 0x1c241e;
const GROUND_ROUGHNESS = 0.92;
const GROUND_METALNESS = 0.04;
/**
 * Normal map procedural (no es foto, es ruido generado) para romper el tiling visible del
 * albedo: repite cada ~1.4m en vez de los 4m del albedo, una frecuencia no múltiplo de la del
 * albedo a propósito, para que el micro-relieve no quede alineado con el patrón grande y lo
 * "tape" en vez de reforzarlo.
 */
const GROUND_DETAIL_NORMAL_METERS_PER_TILE = 1.4;
const GROUND_DETAIL_NORMAL_TEX_SIZE = 256;
const GROUND_NORMAL_STRENGTH = 0.4;
/** ~2 u por celda del GridHelper. */
const GROUND_GRID_CELL_METERS = 2;
const GROUND_GRID_CENTER_COLOR = 0x6d8a74;
const GROUND_GRID_LINE_COLOR = 0x3a4c40;
const GROUND_GRID_OPACITY = 0.3;
/** Un pelo sobre Y=0 para no pelear z-buffer con el plano. */
const GROUND_GRID_Y = 0.02;
/** Pasto / nieve de zona. Angular sirve `public/` en la raíz. */
const GROUND_ALBEDO_DIR = '/models/textures/';
const GROUND_ALBEDO_DEFAULT = 'ground_grass_0.jpg';
/** Metros de mundo por repeat de albedo (antes 256/64 = 4). */
const GROUND_ALBEDO_METERS_PER_TILE = 4;

function resolveGroundSizeMeters(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return GROUND_SIZE_DEFAULT;
  }
  return Math.max(GROUND_SIZE_MIN, Math.min(GROUND_SIZE_MAX, raw));
}

function albedoRepeatForSize(sizeMeters: number): number {
  return Math.max(8, Math.round(sizeMeters / GROUND_ALBEDO_METERS_PER_TILE));
}

function normalRepeatForSize(sizeMeters: number): number {
  return Math.max(8, Math.round(sizeMeters / GROUND_DETAIL_NORMAL_METERS_PER_TILE));
}

let groundDetailNormalMap: THREE.DataTexture | undefined;

/**
 * Normal map tileable generado por código (suma de senos con período = tamaño de textura, así
 * da exactamente igual en el borde izquierdo/derecho y arriba/abajo: cero costuras al repetir).
 * Cacheado a nivel de módulo: una sola textura compartida por todos los materiales de piso.
 */
function getGroundDetailNormalMap(): THREE.DataTexture {
  if (groundDetailNormalMap) {
    return groundDetailNormalMap;
  }
  const size = GROUND_DETAIL_NORMAL_TEX_SIZE;
  const twoPi = Math.PI * 2;
  const octaves = [
    { fx: 3, fy: 2, amp: 1, phaseX: 0.6, phaseY: 2.1 },
    { fx: 5, fy: 7, amp: 0.5, phaseX: 3.4, phaseY: 1.2 },
    { fx: 11, fy: 9, amp: 0.28, phaseX: 5.1, phaseY: 0.4 },
    { fx: 17, fy: 13, amp: 0.16, phaseX: 1.9, phaseY: 4.6 },
  ];
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      for (const o of octaves) {
        h +=
          o.amp *
          Math.sin((x / size) * twoPi * o.fx + o.phaseX) *
          Math.sin((y / size) * twoPi * o.fy + o.phaseY);
      }
      height[y * size + x] = h;
    }
  }
  const data = new Uint8ClampedArray(size * size * 4);
  const strength = 2.2;
  const normal = new THREE.Vector3();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = height[y * size + ((x - 1 + size) % size)]!;
      const hR = height[y * size + ((x + 1) % size)]!;
      const hD = height[((y - 1 + size) % size) * size + x]!;
      const hU = height[((y + 1) % size) * size + x]!;
      normal.set(-(hR - hL) * strength, -(hU - hD) * strength, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = Math.round((normal.x * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  groundDetailNormalMap = texture;
  return texture;
}

/**
 * Modelo `.gltf` del jugador (Lizard Man Warrior, CC-BY-4.0 — ver
 * `apps/client/public/models/characters/lizard_man_warrior/license.txt`).
 * Reemplaza el dummy compuesto una vez que termina de cargar; ver `attachGltfCharacterModel`.
 */
const PLAYER_MODEL_URL = '/models/characters/lizard_man_warrior/scene.gltf';
/**
 * Escala visual del personaje relativa al footprint del dummy (`BOX`). Confirmado en cliente
 * que 1x quedaba chico contra el resto del mundo (mobs, obstáculos); 3x se ve bien. Sólo afecta
 * el modelo `.gltf` renderizado, no el hitbox/lógica de colisión (sigue siendo autoritativa del
 * servidor, ajena a esta escala puramente cosmética).
 */
const PLAYER_VISUAL_SCALE = 3;
/** Altura objetivo tras normalizar: pies en `-Y_LIFT`, igual que el dummy, pero 3x más alto. */
const PLAYER_MODEL_TARGET_HEIGHT = BOX * PLAYER_VISUAL_SCALE;
/**
 * Corrección de yaw si el modelo no queda mirando hacia +Z (mismo eje que el "visor" del
 * dummy y el anclaje de arma). Confirmado en cliente que con `0` ya mira para el lado correcto.
 */
const PLAYER_MODEL_YAW_OFFSET = 0;
/** Clip concatenado del asset; se recorta en idle/walk/attack/skill (ver `character-anim-rig.ts`). */
const PLAYER_MODEL_PREFERRED_CLIP = /motion/i;

/**
 * Espadón paperdoll (CC-BY-4.0 — `espadon_warrior/license.txt`). Se parenta al hueso de la
 * mano derecha cuando NO hay ítem WEAPON; no se reproducen sus clips (luces/cámara de
 * Sketchfab). Con ítem se muestra la espada horneada del lizard.
 */
const EQUIPPED_WEAPON_URL = '/models/characters/espadon_warrior/scene.gltf';
const EQUIPPED_WEAPON_TARGET_LENGTH = 1.65;
const RIGHT_HAND_BONE_NAME = 'Bip001_R_Hand_029';
const PELVIS_BONE_NAME = 'Bip001_Pelvis_04';
/**
 * Ajuste de empuñadura en espacio local de la mano (idle del lizard).
 * El filo del espadón queda en +Y del wrap; en idle el +X de `Bip001_R_Hand_029` apunta
 * al cielo. Esta rotación alinea el filo con world +Y (el trazo vertical pedido).
 */
const EQUIPPED_WEAPON_ROTATION = {
  x: 0.5240242992395524,
  y: -0.5971379641007244,
  z: -1.7080645629806488,
};

/** Propiedades de textura conocidas de `MeshStandardMaterial` a liberar junto con el material. */
const TEXTURE_MAP_PROPERTIES = [
  'map',
  'normalMap',
  'aoMap',
  'emissiveMap',
  'roughnessMap',
  'metalnessMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'envMap',
] as const;

/** Tinte + brillo resueltos para un frame. `null` en `emissive` = apagado. */
export interface VisualTint {
  color: number;
  emissive: number;
  emissiveIntensity: number;
}

export interface WeaponGlow {
  weaponColor: number;
  auraColor: number;
  auraOpacity: number;
  scale: number;
}

/** Superficie mínima común entre `MeshLambertMaterial` (dummies) y `MeshStandardMaterial` (.gltf). */
type TintableMaterial = THREE.Material & {
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
};

interface TickableAnimRig {
  update(deltaSeconds: number): void;
  dispose(): void;
}

class MixerLoopRig implements TickableAnimRig {
  constructor(private readonly mixer: THREE.AnimationMixer) {}

  update(deltaSeconds: number): void {
    this.mixer.update(deltaSeconds);
  }

  dispose(): void {
    this.mixer.stopAllAction();
  }
}

class OneShotClipRig implements TickableAnimRig {
  private readonly mixer: THREE.AnimationMixer;
  private readonly action: THREE.AnimationAction;

  constructor(root: THREE.Object3D, clip: THREE.AnimationClip) {
    this.mixer = new THREE.AnimationMixer(root);
    this.action = this.mixer.clipAction(clip);
    this.action.enabled = true;
    this.action.setLoop(THREE.LoopOnce, 1);
    this.action.clampWhenFinished = true;
  }

  play(): void {
    this.action.timeScale = 1;
    this.action.enabled = true;
    this.action.paused = false;
    this.action.reset();
    this.action.play();
  }

  /** Reproduce el clip al revés (cierra la tapa). */
  playClose(): void {
    this.action.enabled = true;
    this.action.paused = false;
    this.action.setLoop(THREE.LoopOnce, 1);
    this.action.clampWhenFinished = true;
    this.action.timeScale = -1;
    if (this.action.time <= 1e-3 && !this.action.isRunning()) {
      return;
    }
    this.action.play();
  }

  update(deltaSeconds: number): void {
    this.mixer.update(deltaSeconds);
  }

  dispose(): void {
    this.mixer.stopAllAction();
  }
}

interface PlayerGltfTemplate {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

/**
 * Fábrica única de visuales de entidad (The Weaver).
 *
 * Concentra geometría, materiales, tintes y liberación de recursos para que el reemplazo de
 * primitivas por mallas `.gltf` sea un cambio local a este archivo.
 */
@Injectable({ providedIn: 'root' })
export class EntityVisualFactoryService {
  private readonly gltfLoader = new GLTFLoader();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly groundAlbedoByUrl = new Map<string, THREE.Texture>();
  private playerGltfTemplatePromise: Promise<PlayerGltfTemplate> | null = null;
  private equippedWeaponTemplatePromise: Promise<THREE.Group> | null = null;
  /** Un rig de animación por personaje/mob con modelo `.gltf` ya cargado; ver `tickAnimations`. */
  private readonly activeAnimRigs = new Set<TickableAnimRig>();
  private readonly mobGltfTemplateByUrl = new Map<string, Promise<PlayerGltfTemplate>>();
  private readonly propGltfTemplateByUrl = new Map<string, Promise<THREE.Group>>();
  private readonly portalFxTimeUniforms = new Set<{ value: number }>();

  constructor() {
    this.gltfLoader.register(
      (parser) => new GLTFMaterialsSpecularGlossinessCompatExtension(parser),
    );
  }

  createPlayerVisual(): EntityVisual {
    const group = this.createHumanoidDummy(PLAYER_COLOR);
    group.userData['kind'] = 'player';
    this.attachGltfCharacterModel(group);
    return group;
  }

  createOtherPlayerVisual(characterId: string): EntityVisual {
    const group = this.createHumanoidDummy(OTHER_PLAYER_COLOR);
    group.userData['kind'] = 'otherPlayer';
    group.userData['otherCharacterId'] = characterId;
    this.attachGltfCharacterModel(group);
    return group;
  }

  /**
   * Cubo rojo síncrono (fallback + collider). Si hay def en el catálogo, se cuelga el `.gltf`
   * en async; si falla o tarda, el cubo permanece visible.
   */
  createMobVisual(mobInstanceId: string, mobTemplateKey?: string | null): EntityVisual {
    const group = new THREE.Group();
    const cube = this.createUnitBox(MOB_COLOR);
    cube.userData['kind'] = 'mob';
    cube.userData['mobInstanceId'] = mobInstanceId;
    group.add(cube);
    group.userData['kind'] = 'mob';
    group.userData['mobInstanceId'] = mobInstanceId;
    group.userData['bodyMesh'] = cube;
    group.userData['mobPickCollider'] = cube;
    // Aro plano sin iluminación: una PointLight por mob (19+ por zona) encarece el fragment
    // shader de TODOS los materiales y prender/apagar luces fuerza recompilar shaders.
    const aggroRing = new THREE.Mesh(getMobAggroRingGeometry(), getMobAggroRingMaterial());
    aggroRing.rotation.x = -Math.PI / 2;
    aggroRing.position.set(0, -Y_LIFT + 0.05, 0);
    aggroRing.visible = false;
    aggroRing.raycast = () => undefined;
    aggroRing.userData['sharedGltfAsset'] = true;
    group.add(aggroRing);
    group.userData['mobAggroRing'] = aggroRing;
    if (mobTemplateKey) {
      group.userData['mobTemplateKey'] = mobTemplateKey;
    }
    const def = resolveMobVisualDef(mobTemplateKey);
    if (def) {
      this.attachGltfMobModel(group, def);
    }
    return group;
  }

  /**
   * Cubo verde síncrono (fallback + picking). Si hay def en el catálogo, se cuelgan trader + cofre.
   * en async; si falla, el cubo permanece visible.
   */
  createNpcVisual(npcInstanceId: string, npcTemplateKey?: string | null): THREE.Group {
    const group = new THREE.Group();
    group.userData['kind'] = 'npc';
    group.userData['npcInstanceId'] = npcInstanceId;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(BOX, BOX, BOX),
      new THREE.MeshLambertMaterial({
        color: NPC_MERCHANT_COLOR,
        emissive: 0x0d3d22,
        emissiveIntensity: 0.12,
      }),
    );
    mesh.userData['kind'] = 'npc';
    mesh.userData['npcInstanceId'] = npcInstanceId;
    if (npcTemplateKey) {
      group.userData['npcTemplateKey'] = npcTemplateKey;
      mesh.userData['npcTemplateKey'] = npcTemplateKey;
    }
    group.add(mesh);
    group.userData['npcPickCollider'] = mesh;
    if (npcTemplateKey === 'merchant_aetheris') {
      const lantern = new THREE.PointLight(0xffb066, 1.15, 8, 2);
      lantern.name = 'merchantLantern';
      lantern.position.set(0, 1.55, 0);
      lantern.castShadow = false;
      group.add(lantern);
    }
    if (npcTemplateKey === 'dungeon_nexus_guide' || npcTemplateKey === 'dungeon_room_guide') {
      this.attachTorchRing(group);
    }
    const def = resolveNpcVisualDef(npcTemplateKey);
    if (def) {
      this.attachGltfNpcModel(group, def);
    }
    return group;
  }

  /**
   * 3 antorchas en círculo (sin modelo propio: poste + llama emisiva + luz puntual), para que
   * el NPC guía de mazmorra se note a distancia en salas vacías sin arte todavía.
   */
  private attachTorchRing(host: THREE.Group): void {
    const torchCount = 3;
    const radius = 1.3;
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x3e2723, roughness: 0.9 });
    const flameMaterial = new THREE.MeshStandardMaterial({
      color: 0xffb020,
      emissive: 0xff7a00,
      emissiveIntensity: 2.2,
      roughness: 0.4,
    });
    for (let i = 0; i < torchCount; i++) {
      const angle = (i / torchCount) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      const torch = new THREE.Group();
      torch.name = 'dungeonTorch';
      torch.position.set(x, 0, z);

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.9, 6), poleMaterial);
      pole.position.y = 0.45;
      torch.add(pole);

      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.26, 8), flameMaterial);
      flame.name = 'dungeonTorchFlame';
      flame.position.y = 1.03;
      torch.add(flame);

      const flameLight = new THREE.PointLight(0xff8c2a, 1.4, 6, 2);
      flameLight.position.y = 1.05;
      flameLight.castShadow = false;
      torch.add(flameLight);

      host.add(torch);
    }
  }

  /**
   * Gema + anillo de piso (reemplaza el cubo amarillo plano) con tooltip CSS2D del nombre del
   * ítem, oculto por default y mostrado al pasar el mouse por encima (`GameViewportComponent`
   * controla el raycast de hover; acá sólo se arma el DOM que ese hover prende/apaga).
   */
  createDropVisual(d: WorldDropEntityState): THREE.Group {
    const tint = this.resolveDropTint(d.grade);
    const group = new THREE.Group();
    group.name = 'worldDrop';
    group.userData['kind'] = 'drop';
    group.userData['worldDropItemInstanceId'] = d.itemInstanceId;

    const gem = new THREE.Mesh(
      getDropGemGeometry(),
      new THREE.MeshStandardMaterial({
        color: tint.color,
        emissive: tint.emissive,
        emissiveIntensity: tint.emissiveIntensity,
        roughness: 0.2,
        metalness: 0.25,
      }),
    );
    gem.name = 'dropGem';
    gem.castShadow = true;
    gem.userData['kind'] = 'drop';
    gem.userData['worldDropItemInstanceId'] = d.itemInstanceId;
    group.add(gem);
    group.userData['bodyMesh'] = gem;
    group.userData['dropGemMesh'] = gem;
    /** Fase random para que no todas las gemas floten/giren en sincro perfecto. */
    group.userData['dropBobPhase'] = Math.random() * Math.PI * 2;

    const ring = new THREE.Mesh(
      getDropRingGeometry(),
      new THREE.MeshBasicMaterial({
        color: tint.color,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.name = 'dropRing';
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -DROP_Y_LIFT + 0.015;
    ring.raycast = () => {};
    group.add(ring);
    group.userData['dropRingMesh'] = ring;

    const labelNode = document.createElement('div');
    labelNode.className = 'aetheris-drop-tooltip';
    labelNode.textContent = d.quantity > 1 ? `${d.itemName} x${d.quantity}` : d.itemName;
    labelNode.style.display = 'none';
    labelNode.style.color = `#${tint.color.toString(16).padStart(6, '0')}`;
    const label = new CSS2DObject(labelNode);
    label.position.set(0, DROP_GEM_RADIUS + 0.34, 0);
    group.add(label);
    group.userData['dropLabelNode'] = labelNode;

    return group;
  }

  createObstacleVisual(row: MapBoxConfigRow): THREE.Group {
    return this.createMapPropVisual(row, 'obstacle');
  }

  createPortalVisual(row: MapPortalConfigRow): THREE.Group {
    const group = this.createMapPropVisual(row, 'portal');
    group.userData['portalId'] = row.id;
    group.userData['portalTravelMessage'] =
      row.portalTravelMessage ?? 'Viajando a través del portal...';
    const interactR =
      typeof row.interactionRadiusMeters === 'number' &&
      Number.isFinite(row.interactionRadiusMeters) &&
      row.interactionRadiusMeters > 0
        ? row.interactionRadiusMeters
        : 4;
    group.userData['portalInteractionRadiusMeters'] = interactR;
    group.userData['targetZoneId'] = row.targetZoneId;
    const collider = group.userData['mapCollider'] as THREE.Mesh | undefined;
    if (collider) {
      collider.userData['portalId'] = row.id;
      collider.userData['portalTravelMessage'] = group.userData['portalTravelMessage'];
      collider.userData['targetZoneId'] = row.targetZoneId;
    }
    this.attachPortalInteriorFx(group, row);
    return group;
  }

  /**
   * Host en el centro del AABB (igual que el cubo viejo). Collider = fallback semitransparente;
   * si hay `propTemplateKey` se clona el `.glb` cacheado y el collider pasa a invisible.
   */
  private createMapPropVisual(
    row: MapBoxConfigRow | MapPortalConfigRow,
    kind: 'obstacle' | 'portal',
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = `mapProp:${row.id}`;
    group.userData['kind'] = kind;
    group.userData['obstacleId'] = row.id;
    group.userData['propTemplateKey'] = row.propTemplateKey ?? null;
    group.userData['propScale'] = { x: row.scale.x, y: row.scale.y, z: row.scale.z };
    const walkableDeco =
      kind === 'obstacle' && (row as MapBoxConfigRow).blocksMovement === false;
    group.userData['blocksMovement'] = walkableDeco ? false : true;
    if (typeof row.yaw === 'number' && Number.isFinite(row.yaw)) {
      group.userData['propYaw'] = row.yaw;
    }
    const collider = new THREE.Mesh(
      new THREE.BoxGeometry(row.scale.x, row.scale.y, row.scale.z),
      kind === 'portal' ? this.createPortalFallbackMaterial() : this.createObstacleFallbackMaterial(),
    );
    collider.name = 'mapCollider';
    collider.userData['kind'] = kind;
    collider.userData['obstacleId'] = row.id;
    collider.userData['mapCollider'] = true;
    collider.userData['blocksMovement'] = group.userData['blocksMovement'];
    if (walkableDeco) {
      collider.visible = false;
      collider.raycast = () => {};
    }
    group.add(collider);
    group.userData['mapCollider'] = collider;
    if (row.propTemplateKey === 'torch') {
      const flame = new THREE.PointLight(0xff9a4a, 1.35, 7.5, 2);
      flame.name = 'torchFlame';
      flame.position.set(0, row.scale.y * 0.38, 0);
      flame.castShadow = false;
      group.add(flame);
    }
    const def = resolvePropVisualDef(row.propTemplateKey);
    if (def) {
      this.attachPropGltf(group, def, row);
    }
    return group;
  }

  private createObstacleFallbackMaterial(): THREE.MeshLambertMaterial {
    return new THREE.MeshLambertMaterial({
      color: OBSTACLE_COLOR,
      emissive: OBSTACLE_EMISSIVE,
      emissiveIntensity: OBSTACLE_EMISSIVE_INTENSITY,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
  }

  private createPortalFallbackMaterial(): THREE.MeshLambertMaterial {
    return new THREE.MeshLambertMaterial({
      color: PORTAL_COLOR,
      emissive: PORTAL_EMISSIVE,
      emissiveIntensity: PORTAL_EMISSIVE_INTENSITY,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
  }

  /**
   * Velo + luz dentro del arco. El collider AABB no rota; el hueco mira por el eje
   * horizontal más fino del `scale` (Zone_0: +X, cajas casi cuadradas: +X).
   */
  private attachPortalInteriorFx(host: THREE.Group, row: MapPortalConfigRow): void {
    const throughX = row.scale.x <= row.scale.z;
    const openingW = (throughX ? row.scale.z : row.scale.x) * 0.62;
    const openingH = row.scale.y * 0.72;
    const timeUniform = { value: 0 };
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: timeUniform,
        uColor: { value: PORTAL_FX_COLOR.clone() },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          p.y *= 0.92;
          float r = length(p);
          float oval = 1.0 - smoothstep(0.42, 1.02, r);
          float core = 1.0 - smoothstep(0.0, 0.38, r);
          float wave = 0.62 + 0.38 * sin(uTime * 1.55 + p.y * 5.0);
          float scan = 0.78 + 0.22 * sin(p.y * 9.0 - uTime * 2.4);
          float alpha = oval * wave * 0.52 + core * 0.22;
          vec3 col = uColor * (0.55 + 0.7 * core) * scan;
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const veil = new THREE.Mesh(new THREE.PlaneGeometry(openingW, openingH), material);
    veil.name = 'portalVeil';
    veil.renderOrder = 2;
    if (throughX) {
      veil.rotation.y = Math.PI / 2;
    }
    veil.userData['kind'] = 'portal';
    veil.userData['portalId'] = row.id;
    veil.userData['portalTravelMessage'] =
      row.portalTravelMessage ?? 'Viajando a través del portal...';
    host.add(veil);

    const reach = Math.max(row.scale.x, row.scale.y, row.scale.z) * 1.7;
    const light = new THREE.PointLight(PORTAL_FX_COLOR, PORTAL_LIGHT_INTENSITY, reach, PORTAL_LIGHT_DECAY);
    light.name = 'portalLight';
    light.castShadow = false;
    host.add(light);

    host.userData['portalFxTime'] = timeUniform;
    this.portalFxTimeUniforms.add(timeUniform);
  }

  /**
   * Suelo de zona: plano XZ en Y=0 (pies del personaje en `visualPos.y`, dummy/gltf a `-Y_LIFT`).
   * El albedo por zona (`world-zones.json` → `groundAlbedo`) se aplica después en el viewport.
   */
  createGroundVisual(sizeMeters = GROUND_SIZE_DEFAULT): THREE.Mesh {
    const size = resolveGroundSizeMeters(sizeMeters);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.createGroundMaterial());
    mesh.name = 'zoneGround';
    mesh.userData['kind'] = 'ground';
    mesh.userData['groundSizeMeters'] = size;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    mesh.receiveShadow = true;
    this.applyGroundAlbedoForZone(mesh, GROUND_ALBEDO_DEFAULT);
    this.syncGroundAlbedoRepeat(mesh, size);
    return mesh;
  }

  /**
   * Grid de testeo superpuesto al plano. Sin él un color sólido no da sensación de velocidad.
   * No participa del picking (el click-to-move sigue usando sólo el plano).
   *
   * Atenuada (`opacity`): ahora que el piso tiene textura + sombras, líneas 100% opacas se leían
   * como overlay de debug ("nivel de test") en vez de parte del terreno. `depthWrite = false`
   * evita artefactos de blending al quedar semitransparente sobre el suelo.
   */
  createGroundGrid(sizeMeters = GROUND_SIZE_DEFAULT): THREE.GridHelper {
    const size = resolveGroundSizeMeters(sizeMeters);
    const divisions = Math.max(16, Math.round(size / GROUND_GRID_CELL_METERS));
    const grid = new THREE.GridHelper(
      size,
      divisions,
      GROUND_GRID_CENTER_COLOR,
      GROUND_GRID_LINE_COLOR,
    );
    grid.name = 'zoneGroundGrid';
    grid.userData['groundSizeMeters'] = size;
    grid.position.y = GROUND_GRID_Y;
    grid.raycast = () => {};
    const material = grid.material as THREE.LineBasicMaterial;
    material.transparent = true;
    material.opacity = GROUND_GRID_OPACITY;
    material.depthWrite = false;
    return grid;
  }

  /**
   * Recorta o agranda el piso jugable al cambiar de zona (`groundSizeMeters` en world-zones).
   * Devuelve el GridHelper a usar (puede ser uno nuevo).
   */
  setPlayableGroundSize(
    ground: THREE.Mesh,
    grid: THREE.GridHelper | null,
    sizeMeters: number,
  ): THREE.GridHelper {
    const size = resolveGroundSizeMeters(sizeMeters);
    const prev = ground.userData['groundSizeMeters'];
    if (prev !== size) {
      ground.geometry.dispose();
      ground.geometry = new THREE.PlaneGeometry(size, size);
      ground.userData['groundSizeMeters'] = size;
    }
    this.syncGroundAlbedoRepeat(ground, size);
    if (grid && grid.userData['groundSizeMeters'] === size) {
      return grid;
    }
    const next = this.createGroundGrid(size);
    if (grid?.parent) {
      grid.parent.add(next);
      grid.removeFromParent();
      grid.geometry.dispose();
      const mat = grid.material;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          m.dispose();
        }
      } else {
        mat.dispose();
      }
    }
    return next;
  }

  /**
   * Material del suelo. Con albedo el color es blanco; sin mapa queda el verde de fallback.
   */
  createGroundMaterial(albedoMap: THREE.Texture | null = null): THREE.MeshStandardMaterial {
    const normalMap = getGroundDetailNormalMap();
    normalMap.repeat.set(
      normalRepeatForSize(GROUND_SIZE_DEFAULT),
      normalRepeatForSize(GROUND_SIZE_DEFAULT),
    );
    return new THREE.MeshStandardMaterial({
      color: albedoMap ? 0xffffff : GROUND_COLOR,
      map: albedoMap,
      roughness: GROUND_ROUGHNESS,
      metalness: GROUND_METALNESS,
      normalMap,
      normalScale: new THREE.Vector2(GROUND_NORMAL_STRENGTH, GROUND_NORMAL_STRENGTH),
    });
  }

  /** Carga un albedo de mapa con tiling `RepeatWrapping`. Cacheado por URL a nivel de servicio. */
  loadGroundAlbedo(url: string): THREE.Texture {
    const cached = this.groundAlbedoByUrl.get(url);
    if (cached) {
      return cached;
    }
    const texture = this.textureLoader.load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(
      albedoRepeatForSize(GROUND_SIZE_DEFAULT),
      albedoRepeatForSize(GROUND_SIZE_DEFAULT),
    );
    texture.anisotropy = 8;
    this.groundAlbedoByUrl.set(url, texture);
    return texture;
  }

  /**
   * Cambia el albedo del plano según `groundAlbedo` de la zona. Idempotente si la URL no cambió.
   * Acepta filename (`ground_snow_1.jpg`), stem (`ground_snow_1`) o path absoluto.
   */
  applyGroundAlbedoForZone(mesh: THREE.Mesh, albedoFile: string | null | undefined): void {
    const url = this.resolveGroundAlbedoUrl(albedoFile);
    if (mesh.userData['groundAlbedoUrl'] === url) {
      return;
    }
    this.applyGroundAlbedoMap(mesh, this.loadGroundAlbedo(url));
    mesh.userData['groundAlbedoUrl'] = url;
    const size = resolveGroundSizeMeters(mesh.userData['groundSizeMeters']);
    this.syncGroundAlbedoRepeat(mesh, size);
  }

  private syncGroundAlbedoRepeat(mesh: THREE.Mesh, sizeMeters: number): void {
    const material = mesh.material;
    if (!material || Array.isArray(material) || !('isMeshStandardMaterial' in material)) {
      return;
    }
    const standard = material as THREE.MeshStandardMaterial;
    if (standard.map) {
      const rep = albedoRepeatForSize(sizeMeters);
      standard.map.repeat.set(rep, rep);
    }
    if (standard.normalMap) {
      const normalRep = normalRepeatForSize(sizeMeters);
      standard.normalMap.repeat.set(normalRep, normalRep);
    }
  }

  applyGroundAlbedoMap(mesh: THREE.Mesh, texture: THREE.Texture | null): void {
    const material = mesh.material;
    if (!material || Array.isArray(material) || !('isMeshStandardMaterial' in material)) {
      return;
    }
    const standard = material as THREE.MeshStandardMaterial;
    standard.map = texture;
    standard.color.setHex(texture ? 0xffffff : GROUND_COLOR);
    standard.needsUpdate = true;
  }

  private resolveGroundAlbedoUrl(albedoFile: string | null | undefined): string {
    const raw = albedoFile?.trim() || GROUND_ALBEDO_DEFAULT;
    if (raw.startsWith('/')) {
      return raw;
    }
    const filename = raw.includes('.') ? raw : `${raw}.jpg`;
    return `${GROUND_ALBEDO_DIR}${filename}`;
  }

  /** Repara el collider de un prop reusado tras un cambio de zona. */
  ensureObstacleMaterial(visual: THREE.Object3D): void {
    const collider = this.findMapCollider(visual);
    if (!collider || visual.userData['propGltfReady']) {
      return;
    }
    this.ensureLambert(collider, () => this.createObstacleFallbackMaterial());
  }

  ensurePortalMaterial(visual: THREE.Object3D): void {
    const collider = this.findMapCollider(visual);
    if (!collider || visual.userData['propGltfReady']) {
      return;
    }
    this.ensureLambert(collider, () => this.createPortalFallbackMaterial());
  }

  private findMapCollider(visual: THREE.Object3D): THREE.Mesh | null {
    const tagged = visual.userData['mapCollider'] as THREE.Mesh | undefined;
    if (tagged?.isMesh) {
      return tagged;
    }
    if ((visual as THREE.Mesh).isMesh) {
      return visual as THREE.Mesh;
    }
    return null;
  }

  /**
   * Resuelve el/los material(es) tintable(s) de un visual. Para el dummy compuesto (jugador/
   * otros jugadores) las tres mallas (cuerpo, cabeza, visor) comparten una única instancia de
   * material guardada en `userData['bodyMesh']`. Para un modelo `.gltf` cargado (varias mallas,
   * varios materiales) se usa `userData['tintMeshes']`, poblado por `attachGltfCharacterModel`.
   * En ambos casos el flash de daño/status afecta a todo el visual con una sola llamada.
   */
  applyTint(mesh: EntityVisual, tint: VisualTint): void {
    const gltfReady = Boolean(mesh.userData['gltfModel']);
    for (const mat of this.resolveTintableMaterials(mesh)) {
      // El albedo del `.gltf` es la textura del asset. Pintarlo cada frame con PLAYER_COLOR
      // deja al lizard azul sólido (se vio en cliente). En modelos cargados sólo se usa
      // emissive para flash de hit/heal.
      if (!gltfReady) {
        mat.color.setHex(tint.color);
      }
      mat.emissive.setHex(tint.emissive);
      mat.emissiveIntensity = tint.emissiveIntensity;
    }
    const dropRing = mesh.userData['dropRingMesh'] as THREE.Mesh | undefined;
    if (dropRing) {
      (dropRing.material as THREE.MeshBasicMaterial).color.setHex(tint.color);
    }
  }

  private resolveTintableMaterials(visual: EntityVisual): TintableMaterial[] {
    const tintMeshes = visual.userData['tintMeshes'] as THREE.Mesh[] | undefined;
    if (tintMeshes?.length) {
      const seen = new Set<THREE.Material>();
      const materials: TintableMaterial[] = [];
      for (const tintMesh of tintMeshes) {
        if (tintMesh.userData['lizardBakedWeapon']) {
          continue;
        }
        const mat = this.asTintableMaterial(tintMesh.material);
        if (mat && !seen.has(mat)) {
          seen.add(mat);
          materials.push(mat);
        }
      }
      return materials;
    }
    const bodyMesh = visual.userData['bodyMesh'] as THREE.Mesh | undefined;
    const target = bodyMesh ?? (visual as unknown as THREE.Mesh);
    if (!target?.isMesh) {
      return [];
    }
    const mat = this.asTintableMaterial(target.material);
    return mat ? [mat] : [];
  }

  /** Duck-typing en vez de `isMeshLambertMaterial`: las mallas `.gltf` usan `MeshStandardMaterial`. */
  private asTintableMaterial(
    material: THREE.Material | THREE.Material[] | undefined,
  ): TintableMaterial | undefined {
    const single = Array.isArray(material) ? material[0] : material;
    const candidate = single as unknown as TintableMaterial | undefined;
    return candidate?.color && candidate?.emissive ? candidate : undefined;
  }

  /**
   * Libera un visual de drop sin tocar `disposeVisual`: la gema y el anillo comparten
   * geometría cacheada a nivel de módulo (`getDropGemGeometry`/`getDropRingGeometry`) entre
   * TODOS los drops, así que `disposeVisual` la destruiría para todos. Sólo el material es
   * propio de cada instancia (se tiñe por grado), así que sólo eso hay que liberar acá.
   */
  disposeDropVisual(mesh: THREE.Object3D): void {
    const gem = mesh.userData['dropGemMesh'] as THREE.Mesh | undefined;
    (gem?.material as THREE.Material | undefined)?.dispose();
    const ring = mesh.userData['dropRingMesh'] as THREE.Mesh | undefined;
    (ring?.material as THREE.Material | undefined)?.dispose();
  }

  resolveDropTint(grade: WorldDropEntityState['grade']): VisualTint {
    if (grade === 'S') {
      return { color: 0xff7f27, emissive: 0xff5400, emissiveIntensity: 0.5 };
    }
    if (grade === 'A') {
      return { color: 0x56d17d, emissive: 0x1f7a3d, emissiveIntensity: 0.42 };
    }
    if (grade === 'B') {
      return { color: 0x3f9cff, emissive: 0x174b99, emissiveIntensity: 0.36 };
    }
    if (grade === 'C') {
      return { color: 0xd8dee9, emissive: 0x7d8696, emissiveIntensity: 0.3 };
    }
    if (grade === 'D') {
      return { color: 0xe7c66b, emissive: 0x81610f, emissiveIntensity: 0.28 };
    }
    return { color: DROP_COLOR, emissive: 0x443300, emissiveIntensity: 0.15 };
  }

  /**
   * Paperdoll de arma (pedido de producto):
   * - **Con ítem WEAPON:** espada horneada del lizard (skineada a la mano).
   * - **Sin ítem:** espadón `.gltf` colgado en el hueso de la mano.
   * El cubo de `ensureWeaponRig` es fallback del dummy pre-GLTF y se oculta al cargar el lizard.
   */
  applyPaperdollWeapon(
    host: EntityVisual,
    opts: { equipped: boolean; plusLevel: number },
  ): void {
    host.userData['weaponEquipped'] = opts.equipped;
    host.userData['weaponPlusLevel'] = opts.plusLevel;
    if (opts.equipped) {
      this.detachEquippedWeapon(host);
    } else {
      this.ensureEquippedWeaponOnHand(host);
    }
    this.syncBakedWeaponVisibility(host);
    this.applyWeaponGlow(host, opts.plusLevel);
  }

  /**
   * Anclaje de arma del dummy (pre-GLTF). Con el lizard cargado el cubo se oculta y el
   * paperdoll usa la malla horneada o el espadón en la mano.
   */
  ensureWeaponRig(host: EntityVisual): THREE.Group {
    const existing = host.userData['weaponAnchor'] as THREE.Group | undefined;
    if (existing) {
      return existing;
    }
    const anchor = new THREE.Group();
    anchor.position.set(BOX * 0.32, 0.05, BOX * 0.2).multiplyScalar(PLAYER_VISUAL_SCALE);
    anchor.scale.setScalar(PLAYER_VISUAL_SCALE);
    const weapon = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.52, 0.1),
      new THREE.MeshBasicMaterial({
        color: 0xb6bec8,
        transparent: true,
        opacity: 0.96,
      }),
    );
    weapon.position.set(0, 0.24, 0);
    anchor.add(weapon);
    host.add(anchor);
    host.userData['weaponAnchor'] = anchor;
    host.userData['weaponMesh'] = weapon;
    return anchor;
  }

  /** Glow por `plusLevel` según Blueprint 10. En `.gltf` no se usa la esfera additive (se
   * veía como una bola naranja en la hoja); el brillo va por emissive del material del arma. */
  applyWeaponGlow(host: EntityVisual, plusLevel: number): void {
    const glow = this.resolveWeaponGlow(plusLevel);
    const gltfReady = Boolean(host.userData['gltfModel']);
    if (!gltfReady) {
      const anchor = this.ensureWeaponRig(host);
      const weapon = host.userData['weaponMesh'] as THREE.Mesh | undefined;
      if (weapon?.material && (weapon.material as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
        (weapon.material as THREE.MeshBasicMaterial).color.setHex(glow.weaponColor);
      }
      this.syncWeaponAura(host, anchor, glow, plusLevel, new THREE.Vector3(0, 0.24, 0));
      return;
    }

    const cubeAnchor = host.userData['weaponAnchor'] as THREE.Object3D | undefined;
    if (cubeAnchor) {
      cubeAnchor.visible = false;
    }
    const aura = host.userData['weaponAura'] as THREE.Mesh | undefined;
    if (aura) {
      aura.visible = false;
      aura.parent?.remove(aura);
    }
    this.applyWeaponMeshEmissive(host, glow, plusLevel);
  }

  /** Brillo de plus en el material del arma visible. No instancia esferas additive. */
  private applyWeaponMeshEmissive(
    host: EntityVisual,
    glow: WeaponGlow,
    plusLevel: number,
  ): void {
    const intensity =
      plusLevel >= 7 ? 0.42 : plusLevel >= 4 ? 0.28 : plusLevel >= 1 ? 0.15 : 0;
    const emissiveHex = plusLevel > 0 ? glow.auraColor : 0x000000;
    const wrap = host.userData['equippedWeaponRoot'] as THREE.Object3D | undefined;
    const showEspadon = Boolean(!host.userData['weaponEquipped'] && wrap && wrap.parent);
    const live: THREE.Mesh[] = [];
    const hidden: THREE.Mesh[] = [];
    if (showEspadon && wrap) {
      wrap.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh) {
          live.push(mesh);
        }
      });
      hidden.push(...((host.userData['bakedWeaponMeshes'] as THREE.Mesh[] | undefined) ?? []));
    } else {
      live.push(...((host.userData['bakedWeaponMeshes'] as THREE.Mesh[] | undefined) ?? []));
      if (wrap) {
        wrap.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.isMesh) {
            hidden.push(mesh);
          }
        });
      }
    }
    for (const mesh of live) {
      this.setMeshEmissive(mesh, emissiveHex, intensity);
    }
    for (const mesh of hidden) {
      this.setMeshEmissive(mesh, 0x000000, 0);
    }
  }

  private setMeshEmissive(mesh: THREE.Mesh, hex: number, intensity: number): void {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const mat = material as THREE.MeshStandardMaterial | undefined;
      if (!mat || !('emissive' in mat) || !mat.emissive) {
        continue;
      }
      mat.emissive.setHex(hex);
      if ('emissiveIntensity' in mat) {
        mat.emissiveIntensity = intensity;
      }
    }
  }

  resolveWeaponGlow(plusLevel: number): WeaponGlow {
    if (plusLevel >= 7) {
      return { weaponColor: 0xffd07f, auraColor: 0xff7f24, auraOpacity: 0.56, scale: 1.18 };
    }
    if (plusLevel >= 4) {
      return { weaponColor: 0x9ec3ff, auraColor: 0x4f8dff, auraOpacity: 0.44, scale: 1.08 };
    }
    if (plusLevel >= 1) {
      return { weaponColor: 0xf2f6ff, auraColor: 0xcfdfff, auraOpacity: 0.36, scale: 1 };
    }
    return { weaponColor: 0xb6bec8, auraColor: 0x000000, auraOpacity: 0, scale: 1 };
  }

  getWeaponAnchor(host: EntityVisual): THREE.Group | undefined {
    return host.userData['weaponAnchor'] as THREE.Group | undefined;
  }

  private syncWeaponAura(
    host: EntityVisual,
    parent: THREE.Object3D,
    glow: WeaponGlow,
    plusLevel: number,
    localPos: THREE.Vector3,
  ): void {
    let aura = host.userData['weaponAura'] as THREE.Mesh | undefined;
    if (!aura) {
      aura = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 12, 12),
        new THREE.MeshBasicMaterial({
          color: glow.auraColor,
          transparent: true,
          opacity: glow.auraOpacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      host.userData['weaponAura'] = aura;
    }
    if (aura.parent !== parent) {
      parent.add(aura);
    }
    aura.position.copy(localPos);
    const auraMat = aura.material as THREE.MeshBasicMaterial;
    aura.visible = plusLevel > 0;
    auraMat.color.setHex(glow.auraColor);
    auraMat.opacity = glow.auraOpacity;
    aura.scale.setScalar(glow.scale);
  }

  private syncBakedWeaponVisibility(host: EntityVisual): void {
    const baked = host.userData['bakedWeaponMeshes'] as THREE.Mesh[] | undefined;
    if (!baked?.length) {
      return;
    }
    const wrap = host.userData['equippedWeaponRoot'] as THREE.Object3D | undefined;
    const showEspadon = Boolean(!host.userData['weaponEquipped'] && wrap && wrap.parent);
    for (const mesh of baked) {
      mesh.visible = !showEspadon;
      mesh.frustumCulled = false;
    }
  }

  private findRightHandBone(host: EntityVisual): THREE.Object3D | undefined {
    let exact: THREE.Object3D | undefined;
    let namedBone: THREE.Object3D | undefined;
    host.traverse((node) => {
      const name = node.name ?? '';
      if (/scaleCompensation|Finger/i.test(name)) {
        return;
      }
      if (name === RIGHT_HAND_BONE_NAME || name === 'Bip001_R_Hand') {
        exact = node;
        return;
      }
      const asBone = node as THREE.Bone;
      if (asBone.isBone && /R_Hand/.test(name)) {
        namedBone ??= node;
      }
    });
    return exact ?? namedBone;
  }

  /**
   * El AABB del lizard incluye cola y alas: el centro geométrico no es el torso.
   * Tras el idle pose, desplazamos el clon en XZ para que la pelvis coincida con el
   * origen del host (hitbox / floaters / cámara).
   */
  private snapPlayerVisualToPelvis(host: EntityVisual, clone: THREE.Object3D): void {
    clone.updateMatrixWorld(true);
    host.updateMatrixWorld(true);
    let pelvis: THREE.Object3D | undefined;
    clone.traverse((node) => {
      if (node.name === PELVIS_BONE_NAME || node.name === 'Bip001_Pelvis') {
        pelvis = node;
      }
    });
    if (!pelvis) {
      return;
    }
    const pelvisWorld = new THREE.Vector3();
    pelvis.getWorldPosition(pelvisWorld);
    const local = host.worldToLocal(pelvisWorld.clone());
    clone.position.x -= local.x;
    clone.position.z -= local.z;
  }

  private loadEquippedWeaponTemplate(): Promise<THREE.Group> {
    if (!this.equippedWeaponTemplatePromise) {
      this.equippedWeaponTemplatePromise = new Promise<THREE.Group>((resolve, reject) => {
        this.gltfLoader.load(
          EQUIPPED_WEAPON_URL,
          (gltf: GLTF) => resolve(gltf.scene),
          undefined,
          (error) => reject(error),
        );
      });
    }
    return this.equippedWeaponTemplatePromise;
  }

  private ensureEquippedWeaponOnHand(host: EntityVisual): void {
    if (host.userData['equippedWeaponRoot']) {
      this.applyEquippedWeaponGrip(host.userData['equippedWeaponRoot'] as THREE.Object3D);
      this.syncBakedWeaponVisibility(host);
      return;
    }
    if (!host.userData['gltfModel']) {
      return;
    }
    const hand = this.findRightHandBone(host);
    if (!hand) {
      return;
    }
    if (host.userData['equippedWeaponLoading']) {
      return;
    }
    host.userData['equippedWeaponLoading'] = true;
    this.loadEquippedWeaponTemplate()
      .then((template) => {
        host.userData['equippedWeaponLoading'] = false;
        if (host.userData['weaponEquipped']) {
          return;
        }
        if (host.userData['equippedWeaponRoot']) {
          return;
        }
        const liveHand = this.findRightHandBone(host);
        if (!liveHand) {
          return;
        }
        const wrap = this.buildEquippedWeaponWrap(template);
        wrap.userData['isEquippedWeaponWrap'] = true;
        liveHand.add(wrap);
        this.compensateHandWorldScale(wrap, liveHand);
        this.applyEquippedWeaponGrip(wrap);
        host.userData['equippedWeaponRoot'] = wrap;
        this.syncBakedWeaponVisibility(host);
        const plus =
          typeof host.userData['weaponPlusLevel'] === 'number'
            ? host.userData['weaponPlusLevel']
            : 0;
        this.applyWeaponGlow(host, plus);
      })
      .catch((error) => {
        host.userData['equippedWeaponLoading'] = false;
        console.error(
          '[EntityVisualFactory] No se pudo cargar el espadón paperdoll; se mantiene la espada del modelo.',
          error,
        );
      });
  }

  private detachEquippedWeapon(host: EntityVisual): void {
    host.userData['equippedWeaponLoading'] = false;
    const wrap = host.userData['equippedWeaponRoot'] as THREE.Object3D | undefined;
    const aura = host.userData['weaponAura'] as THREE.Object3D | undefined;
    if (wrap) {
      if (aura && aura.parent === wrap) {
        wrap.remove(aura);
      }
      wrap.parent?.remove(wrap);
    }
    host.userData['equippedWeaponRoot'] = undefined;
  }

  /**
   * El esqueleto del lizard vive bajo `clone.scale` (~0.002–2). Un mesh de 1.65 u en espacio
   * local de la mano se vuelve invisible. Compensamos para que la longitud objetivo sea en
   * unidades de mundo (la misma que el personaje de altura `BOX * 3`).
   */
  private compensateHandWorldScale(wrap: THREE.Object3D, hand: THREE.Object3D): void {
    const worldScale = new THREE.Vector3();
    hand.getWorldScale(worldScale);
    const s = Math.max(worldScale.x, worldScale.y, worldScale.z, 1e-6);
    wrap.scale.setScalar(1 / s);
  }

  private applyEquippedWeaponGrip(wrap: THREE.Object3D): void {
    wrap.rotation.set(
      EQUIPPED_WEAPON_ROTATION.x,
      EQUIPPED_WEAPON_ROTATION.y,
      EQUIPPED_WEAPON_ROTATION.z,
    );
  }

  /**
   * Clona el espadón, tira luces/cámaras del export Sketchfab y lo normaliza para que el
   * mango quede en el origen de la mano (sin reproducir animaciones propias).
   */
  private buildEquippedWeaponWrap(template: THREE.Group): THREE.Group {
    const clone = template.clone(true);
    const drop: THREE.Object3D[] = [];
    clone.traverse((node) => {
      const asLight = node as THREE.Light;
      const asCam = node as THREE.Camera;
      if (asLight.isLight || asCam.isCamera || /^Area/.test(node.name) || node.name === 'Camera') {
        drop.push(node);
        return;
      }
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.userData['sharedGltfAsset'] = true;
      }
    });
    for (const node of drop) {
      node.parent?.remove(node);
    }

    const wrap = new THREE.Group();
    wrap.rotation.set(
      EQUIPPED_WEAPON_ROTATION.x,
      EQUIPPED_WEAPON_ROTATION.y,
      EQUIPPED_WEAPON_ROTATION.z,
    );

    clone.updateMatrixWorld(true);
    const rawBox = new THREE.Box3().setFromObject(clone);
    const rawSize = new THREE.Vector3();
    rawBox.getSize(rawSize);
    const longest = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
    clone.scale.multiplyScalar(EQUIPPED_WEAPON_TARGET_LENGTH / longest);
    clone.updateMatrixWorld(true);

    const fitted = new THREE.Box3().setFromObject(clone);
    clone.position.sub(this.gripOffsetFromBox(fitted));
    wrap.add(clone);
    return wrap;
  }

  /** Origen de la empuñadura: extremo mínimo del eje más largo de la bbox. */
  private gripOffsetFromBox(box: THREE.Box3): THREE.Vector3 {
    const size = new THREE.Vector3();
    box.getSize(size);
    const c = new THREE.Vector3();
    box.getCenter(c);
    if (size.y >= size.x && size.y >= size.z) {
      return new THREE.Vector3(c.x, box.min.y, c.z);
    }
    if (size.z >= size.x) {
      return new THREE.Vector3(c.x, c.y, box.min.z);
    }
    return new THREE.Vector3(box.min.x, c.y, c.z);
  }

  /**
   * Libera geometría, materiales y texturas de un visual, incluidos los hijos generados por la
   * fábrica (arma, aura). Único punto de disposal para no filtrar GPU.
   *
   * Las mallas clonadas de `attachGltfCharacterModel` (vía `SkeletonUtils.clone`) comparten
   * `geometry`/`material`/texturas con la plantilla cacheada a nivel de servicio y con el resto
   * de personajes visibles del mismo modelo: se marcan con `userData['sharedGltfAsset']` y NO
   * se liberan aquí (viven mientras viva la app). Sólo se destruyen recursos de propiedad única
   * (dummies primitivos y modelos `.gltf` propios de esta malla).
   */
  disposeVisual(visual: THREE.Object3D | null | undefined): void {
    if (!visual) {
      return;
    }
    const rigKeys = ['animRig', 'mobAnimRig', 'npcIdleAnimRig', 'npcBoxAnimRig'] as const;
    const seen = new Set<TickableAnimRig>();
    for (const key of rigKeys) {
      const rig = visual.userData[key] as TickableAnimRig | undefined;
      if (!rig || seen.has(rig)) {
        continue;
      }
      seen.add(rig);
      rig.dispose();
      this.activeAnimRigs.delete(rig);
      visual.userData[key] = undefined;
    }
    const portalTime = visual.userData['portalFxTime'] as { value: number } | undefined;
    if (portalTime) {
      this.portalFxTimeUniforms.delete(portalTime);
      visual.userData['portalFxTime'] = undefined;
    }
    visual.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) {
        return;
      }
      // El esqueleto SÍ es propio de cada clon (`SkeletonUtils.clone` lo clona por instancia,
      // a diferencia de geometry/material), así que se libera siempre, sea o no compartido.
      const skinned = mesh as unknown as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) {
        skinned.skeleton?.dispose();
      }
      if (mesh.userData['sharedGltfAsset']) {
        return;
      }
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        for (const mapName of TEXTURE_MAP_PROPERTIES) {
          (mat as unknown as Record<string, THREE.Texture | null>)[mapName]?.dispose();
        }
        mat.dispose();
      }
    });
  }

  private createUnitBox(color: number): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.BoxGeometry(BOX, BOX, BOX),
      new THREE.MeshLambertMaterial({
        color,
        emissive: 0x000000,
        emissiveIntensity: 0,
      }),
    );
  }

  /**
   * Dummy visual intermedio para personajes: cilindro (torso) + esfera (cabeza) + un pequeño
   * "visor" al frente de la cabeza que rompe la simetría rotacional para distinguir el facing
   * antes de tener mallas `.gltf` animadas. Las tres mallas comparten un único
   * `MeshLambertMaterial` (guardado en `userData['bodyMesh']`) para que tintar/flashear el
   * personaje completo sea una sola operación.
   *
   * Mantiene el mismo footprint vertical que `createUnitBox` (pies en `-BOX/2`, tope en
   * `+BOX/2` aprox.) para no romper offsets calibrados sobre la caja (anclaje de arma, cámara).
   */
  private createHumanoidDummy(color: number): THREE.Group {
    const group = new THREE.Group();
    const material = new THREE.MeshLambertMaterial({
      color,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });

    const footY = -BOX / 2;
    const bodyHeight = BOX * 0.62;
    const bodyRadiusTop = BOX * 0.16;
    const bodyRadiusBottom = BOX * 0.2;
    const bodyCenterY = footY + bodyHeight / 2;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(bodyRadiusTop, bodyRadiusBottom, bodyHeight, 10),
      material,
    );
    body.position.y = bodyCenterY;
    body.castShadow = true;
    group.add(body);

    const headRadius = BOX * 0.22;
    const headCenterY = footY + bodyHeight + headRadius * 0.75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(headRadius, 12, 10), material);
    head.position.y = headCenterY;
    group.add(head);

    // "Visor": marca de orientación sobre +Z (mismo eje que el anclaje del arma) para poder
    // reconocer a qué lado mira la entidad hasta que existan mallas animadas.
    const noseSize = BOX * 0.1;
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(noseSize, noseSize * 0.8, noseSize * 1.5),
      material,
    );
    nose.position.set(0, headCenterY, headRadius * 0.85);
    group.add(nose);

    group.userData['bodyMesh'] = body;
    group.userData['headMesh'] = head;
    group.userData['noseMesh'] = nose;
    return group;
  }

  private ensureLambert(
    mesh: THREE.Mesh,
    build: () => THREE.MeshLambertMaterial,
  ): void {
    const current = mesh.material as THREE.MeshLambertMaterial | undefined;
    if (current?.isMeshLambertMaterial) {
      return;
    }
    if (mesh.material) {
      (mesh.material as THREE.Material).dispose();
    }
    mesh.material = build();
  }

  /**
   * Carga (una única vez por sesión de cliente, cacheada) la plantilla `.gltf` del jugador y
   * sus animaciones. La plantilla nunca se agrega al SceneGraph directamente: cada personaje
   * visible clona la plantilla vía `SkeletonUtils.clone` para tener su propio esqueleto/
   * transform/mixer independiente mientras comparte geometría/materiales/texturas (memoria de
   * GPU compartida entre N jugadores visibles a la vez). Los `AnimationClip` sí se pueden
   * reusar tal cual entre clones: three.js los bindea por nombre de nodo/hueso, que
   * `SkeletonUtils.clone` preserva.
   */
  private loadPlayerGltfTemplate(): Promise<PlayerGltfTemplate> {
    if (!this.playerGltfTemplatePromise) {
      this.playerGltfTemplatePromise = new Promise<PlayerGltfTemplate>((resolve, reject) => {
        this.gltfLoader.load(
          PLAYER_MODEL_URL,
          (gltf: GLTF) => resolve({ scene: gltf.scene, animations: gltf.animations }),
          undefined,
          (error) => reject(error),
        );
      });
    }
    return this.playerGltfTemplatePromise;
  }

  /**
   * Avanza los mixers de personaje y mob. Se llama una vez por frame desde el loop de
   * `GameViewportComponent`; el componente no conoce mixers individuales.
   */
  tickAnimations(deltaSeconds: number): void {
    for (const rig of this.activeAnimRigs) {
      rig.update(deltaSeconds);
    }
    if (this.portalFxTimeUniforms.size > 0) {
      const dt = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
      for (const u of this.portalFxTimeUniforms) {
        u.value += dt;
      }
    }
  }

  setMobLocomotion(
    visual: EntityVisual | null | undefined,
    moving: boolean,
    chasing: boolean,
    inMeleeRange = false,
  ): void {
    if (!visual) {
      return;
    }
    visual.userData['mobWantMoving'] = moving;
    visual.userData['mobWantChase'] = chasing;
    visual.userData['mobWantInMelee'] = inMeleeRange;
    const rig = visual.userData['mobAnimRig'] as MobAnimRig | undefined;
    rig?.setLocomotion(moving, chasing, inMeleeRange);
  }

  setMobAggroAura(visual: EntityVisual | null | undefined, chasing: boolean): void {
    if (!visual) {
      return;
    }
    const ring = visual.userData['mobAggroRing'] as THREE.Mesh | undefined;
    if (ring) {
      ring.visible = chasing;
    }
  }

  playMobAttack(visual: EntityVisual | null | undefined, _inMeleeRange = true): void {
    if (!visual) {
      return;
    }
    visual.userData['mobPendingAttack'] = true;
    const rig = visual.userData['mobAnimRig'] as MobAnimRig | undefined;
    if (!rig) {
      return;
    }
    rig.playAttack(true);
    visual.userData['mobPendingAttack'] = undefined;
  }

  /** One-shot del cofre del mercader (clic en NPC o en la caja). */
  playNpcShopOpen(visual: EntityVisual | null | undefined): void {
    if (!visual) {
      return;
    }
    const rig = visual.userData['npcBoxAnimRig'] as OneShotClipRig | undefined;
    if (!rig) {
      visual.userData['npcBoxOpenPending'] = true;
      return;
    }
    rig.play();
  }

  playNpcShopClose(visual: EntityVisual | null | undefined): void {
    if (!visual) {
      return;
    }
    visual.userData['npcBoxOpenPending'] = false;
    const rig = visual.userData['npcBoxAnimRig'] as OneShotClipRig | undefined;
    if (!rig) {
      visual.userData['npcBoxClosePending'] = true;
      return;
    }
    rig.playClose();
  }

  /**
   * `mob-respawn`: corta Death, Idle inmediato y limpia flags de hide diferido.
   */
  resetMobVisualAfterRespawn(visual: EntityVisual | null | undefined): void {
    if (!visual) {
      return;
    }
    visual.visible = true;
    visual.userData['mobDeathPlaying'] = false;
    visual.userData['mobDeathUntilMs'] = undefined;
    visual.userData['mobPendingAttack'] = undefined;
    const ring = visual.userData['mobAggroRing'] as THREE.Mesh | undefined;
    if (ring) {
      ring.visible = false;
    }
    const rig = visual.userData['mobAnimRig'] as MobAnimRig | undefined;
    rig?.resetToIdle();
  }

  playMobHit(visual: EntityVisual | null | undefined): void {
    if (!visual) {
      return;
    }
    const rig = visual.userData['mobAnimRig'] as MobAnimRig | undefined;
    rig?.playHit();
  }

  /** Reproduce death y devuelve segundos a esperar antes de ocultar el visual. */
  playMobDeath(visual: EntityVisual | null | undefined): number {
    if (!visual) {
      return 0;
    }
    visual.userData['mobDeathPlaying'] = true;
    const rig = visual.userData['mobAnimRig'] as MobAnimRig | undefined;
    if (!rig) {
      return 0.4;
    }
    return rig.playDeath();
  }

  /**
   * Locomoción: `true` mientras hay destino de click-to-move (o el otro jugador se está
   * desplazando). No interrumpe un golpe/skill en curso; al terminar el one-shot el rig
   * vuelve solo a walk o idle según este flag.
   */
  setCharacterMoving(visual: EntityVisual | null | undefined, moving: boolean): void {
    if (!visual) {
      return;
    }
    visual.userData['animWantMoving'] = moving;
    const rig = visual.userData['animRig'] as CharacterAnimRig | undefined;
    rig?.setMoving(moving);
  }

  /**
   * One-shot de combate. `attack` = autoataque; `skill` = Power Strike / Rageful Blow
   * (mismo clip de skill si el asset no trae uno por habilidad). Si el `.gltf` todavía
   * no cargó, queda pendiente en `userData` y se dispara al terminar `attachGltfCharacterModel`.
   */
  playCharacterCombatAnim(
    visual: EntityVisual | null | undefined,
    kind: CharacterCombatAnim,
  ): void {
    if (!visual) {
      return;
    }
    visual.userData['animPendingCombat'] = kind;
    const rig = visual.userData['animRig'] as CharacterAnimRig | undefined;
    if (!rig) {
      return;
    }
    rig.playCombat(kind);
    visual.userData['animPendingCombat'] = undefined;
  }

  /**
   * Reemplaza (de forma asíncrona, best-effort) el dummy primitivo de `host` por un clon del
   * modelo `.gltf` del jugador. Si la carga falla se deja el dummy visible: nunca se rompe el
   * render por un asset faltante.
   *
   * El asset trae dos variantes fusionadas en la misma jerarquía ("01" alta calidad con normal
   * map, "03" un LOD/duplicado sin tangentes) más un arma soldada a la malla. Se identifican por
   * el nombre del material. La variante "03" se oculta. El arma horneada queda visible con ítem
   * WEAPON; sin ítem se oculta y se parenta el espadón al hueso de la mano. No entra en el bbox
   * de escala del cuerpo para no achicar al personaje.
   */
  private attachGltfCharacterModel(host: THREE.Group): void {
    this.loadPlayerGltfTemplate()
      .then((template) => {
        const clone = cloneSkinned(template.scene) as THREE.Group;
        clone.updateMatrixWorld(true);

        const box = new THREE.Box3();
        let hasVisibleGeometry = false;
        const tintMeshes: THREE.Mesh[] = [];
        const bakedWeaponMeshes: THREE.Mesh[] = [];

        clone.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) {
            return;
          }
          const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          const label = `${mesh.name} ${material?.name ?? ''} ${mesh.parent?.name ?? ''}`;
          const isLowDetailDuplicate = /Warrior03|_003_/.test(label);
          const isWeldedWeapon = /weapon/i.test(label);
          if (isLowDetailDuplicate) {
            mesh.visible = false;
            return;
          }
          mesh.userData['sharedGltfAsset'] = true;
          mesh.castShadow = true;
          if (isWeldedWeapon) {
            mesh.userData['lizardBakedWeapon'] = true;
            mesh.visible = true;
            mesh.frustumCulled = false;
            bakedWeaponMeshes.push(mesh);
            return;
          }
          tintMeshes.push(mesh);
          mesh.geometry?.computeBoundingBox?.();
          const geoBox = mesh.geometry?.boundingBox;
          if (geoBox) {
            box.union(geoBox.clone().applyMatrix4(mesh.matrixWorld));
            hasVisibleGeometry = true;
          }
        });

        if (!hasVisibleGeometry) {
          box.setFromObject(clone);
        }

        const size = new THREE.Vector3();
        box.getSize(size);
        const rawHeight = size.y || 1;
        const scale = PLAYER_MODEL_TARGET_HEIGHT / rawHeight;
        clone.scale.setScalar(scale);

        const center = new THREE.Vector3();
        box.getCenter(center);
        clone.position.set(-center.x * scale, -Y_LIFT - box.min.y * scale, -center.z * scale);
        clone.rotation.y = PLAYER_MODEL_YAW_OFFSET;

        // Sólo se retiran las 3 mallas primitivas del dummy (`createHumanoidDummy`). NO se
        // vacía `host.children` a ciegas: para cuando el .gltf termina de cargar puede que ya
        // existan otros hijos (anclaje de arma vía `ensureWeaponRig`, etiqueta CSS2D de nombre
        // vía `ensureOtherPlayerNameLabel`) que hay que preservar.
        const dummyChildren = [
          host.userData['bodyMesh'],
          host.userData['headMesh'],
          host.userData['noseMesh'],
        ].filter((child): child is THREE.Object3D => child instanceof THREE.Object3D);
        for (const child of dummyChildren) {
          host.remove(child);
          this.disposeVisual(child);
        }
        host.add(clone);
        host.userData['bodyMesh'] = undefined;
        host.userData['headMesh'] = undefined;
        host.userData['noseMesh'] = undefined;
        host.userData['tintMeshes'] = tintMeshes;
        host.userData['bakedWeaponMeshes'] = bakedWeaponMeshes;
        host.userData['gltfModel'] = clone;

        const cubeAnchor = host.userData['weaponAnchor'] as THREE.Object3D | undefined;
        if (cubeAnchor) {
          cubeAnchor.visible = false;
        }

        if (template.animations.length > 0) {
          const clip =
            template.animations.find((c) => PLAYER_MODEL_PREFERRED_CLIP.test(c.name)) ??
            template.animations[0];
          const rig = new CharacterAnimRig(clone, clip);
          host.userData['animRig'] = rig;
          this.activeAnimRigs.add(rig);
          rig.update(0);
          this.snapPlayerVisualToPelvis(host, clone);
          if (host.userData['animWantMoving']) {
            rig.setMoving(true);
          }
          const pending = host.userData['animPendingCombat'] as CharacterCombatAnim | undefined;
          if (pending) {
            rig.playCombat(pending);
            host.userData['animPendingCombat'] = undefined;
          }
        }

        this.syncBakedWeaponVisibility(host);
        if (!host.userData['weaponEquipped']) {
          this.ensureEquippedWeaponOnHand(host);
        }
        const pendingPlus = host.userData['weaponPlusLevel'];
        if (typeof pendingPlus === 'number') {
          this.applyWeaponGlow(host, pendingPlus);
        }
      })
      .catch((error) => {
        console.error(
          '[EntityVisualFactory] No se pudo cargar el modelo .gltf del jugador; se mantiene el dummy.',
          error,
        );
      });
  }

  /** Una plantilla por URL; `clone(true)` comparte geometry/material en GPU. */
  private loadPropGltfTemplate(url: string): Promise<THREE.Group> {
    const cached = this.propGltfTemplateByUrl.get(url);
    if (cached) {
      return cached;
    }
    const pending = new Promise<THREE.Group>((resolve, reject) => {
      this.gltfLoader.load(
        url,
        (gltf: GLTF) => resolve(gltf.scene),
        undefined,
        (error) => reject(error),
      );
    });
    this.propGltfTemplateByUrl.set(url, pending);
    return pending;
  }

  private attachPropGltf(
    host: THREE.Group,
    def: PropVisualDef,
    row: MapBoxConfigRow | MapPortalConfigRow,
  ): void {
    const generation = (host.userData['propAttachGen'] as number | undefined) ?? 0;
    host.userData['propAttachGen'] = generation;
    this.loadPropGltfTemplate(def.url)
      .then((template) => {
        if (host.userData['propAttachGen'] !== generation) {
          return;
        }
        if (host.userData['kind'] !== 'obstacle' && host.userData['kind'] !== 'portal') {
          return;
        }
        const clone = template.clone(true);
        clone.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) {
            return;
          }
          mesh.userData['sharedGltfAsset'] = true;
          mesh.userData['kind'] = host.userData['kind'];
          mesh.userData['obstacleId'] = host.userData['obstacleId'];
          mesh.userData['blocksMovement'] = host.userData['blocksMovement'];
          if (typeof host.userData['portalId'] === 'string') {
            mesh.userData['portalId'] = host.userData['portalId'];
            mesh.userData['portalTravelMessage'] = host.userData['portalTravelMessage'];
          }
          mesh.castShadow = host.userData['propTemplateKey'] !== 'floor_path';
          mesh.receiveShadow = true;
          /**
           * Click-to-move pica sólo el suelo. El GLB de obstáculo no entra al raycast
           * (la cámara usa el AABB `mapCollider`). Portales sí se pickean.
           */
          if (host.userData['kind'] === 'obstacle') {
            mesh.raycast = () => {};
          }
        });
        const prev = host.userData['gltfModel'] as THREE.Object3D | undefined;
        if (prev) {
          prev.removeFromParent();
        }
        const holder = this.fitPropGltfHolder(clone, def, row);
        host.add(holder);
        host.userData['gltfModel'] = holder;
        host.userData['propGltfReady'] = true;
        this.hideMapCollider(host);
      })
      .catch((error) => {
        console.warn(
          `[EntityVisualFactory] Prop '${row.propTemplateKey}' sin .glb; se mantiene el AABB.`,
          error,
        );
      });
  }

  /**
   * Encaja el clone en el AABB del JSON. `height`: uniforme + base en el piso del box
   * (local y = -scale.y/2). `aabb`: estira a scale. El yaw de fila ya está en el host.
   */
  private fitPropGltfHolder(
    clone: THREE.Object3D,
    def: PropVisualDef,
    row: MapBoxConfigRow | MapPortalConfigRow,
  ): THREE.Group {
    const holder = new THREE.Group();
    holder.add(clone);
    holder.rotation.y =
      def.yawOffset + (typeof row.yaw === 'number' && Number.isFinite(row.yaw) ? row.yaw : 0);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const sx = Math.max(size.x, 0.001);
    const sy = Math.max(size.y, 0.001);
    const sz = Math.max(size.z, 0.001);
    if (def.fit === 'height' && def.targetHeight && def.targetHeight > 0) {
      const visualMul = heightFitVisualMultiplier(row.scale);
      const scale = (def.targetHeight * visualMul) / sy;
      holder.scale.setScalar(scale);
      holder.updateMatrixWorld(true);
      box.setFromObject(holder);
      box.getCenter(center);
      holder.position.x -= center.x;
      holder.position.z -= center.z;
      holder.position.y += -row.scale.y / 2 - box.min.y;
    } else {
      holder.scale.set(row.scale.x / sx, row.scale.y / sy, row.scale.z / sz);
      holder.updateMatrixWorld(true);
      box.setFromObject(holder);
      box.getCenter(center);
      holder.position.sub(center);
    }
    return holder;
  }

  private attachGltfNpcModel(host: THREE.Group, def: NpcVisualDef): void {
    const traderPromise = this.loadMobGltfTemplate(def.url);
    const boxPromise = def.companion
      ? this.loadMobGltfTemplate(def.companion.url)
      : Promise.resolve(null);
    Promise.all([traderPromise, boxPromise])
      .then(([traderTemplate, boxTemplate]) => {
        if (host.userData['kind'] !== 'npc') {
          return;
        }
        const traderClone = cloneSkinned(traderTemplate.scene) as THREE.Group;
        this.stampNpcGltfClone(traderClone, host);
        this.stripGltfLightsAndCameras(traderClone);
        if (def.idleClip) {
          const idleClip = traderTemplate.animations.find((c) => def.idleClip?.test(c.name));
          if (idleClip) {
            const mixer = new THREE.AnimationMixer(traderClone);
            const action = mixer.clipAction(idleClip);
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.play();
            mixer.update(1 / 30);
            this.updateSkinnedPose(traderClone);
            const idleRig = new MixerLoopRig(mixer);
            host.userData['npcIdleAnimRig'] = idleRig;
            this.activeAnimRigs.add(idleRig);
          }
        }
        const prev = host.userData['gltfModel'] as THREE.Object3D | undefined;
        if (prev) {
          prev.removeFromParent();
        }
        const traderHolder = this.fitGltfToTargetHeight(traderClone, def.targetHeight, def.yawOffset);
        host.add(traderHolder);
        host.userData['gltfModel'] = traderHolder;
        host.userData['npcGltfReady'] = true;

        if (boxTemplate && def.companion) {
          const boxClone = cloneSkinned(boxTemplate.scene) as THREE.Group;
          this.stampNpcGltfClone(boxClone, host);
          this.stripGltfLightsAndCameras(boxClone);
          const boxHolder = this.fitGltfToTargetHeight(
            boxClone,
            def.companion.targetHeight,
            def.companion.yawOffset,
          );
          boxHolder.position.x += def.companion.offset.x;
          boxHolder.position.y += def.companion.offset.y;
          boxHolder.position.z += def.companion.offset.z;
          host.add(boxHolder);
          host.userData['npcBoxModel'] = boxHolder;
          const openClip =
            boxTemplate.animations.find((c) => def.companion?.openClip.test(c.name)) ??
            boxTemplate.animations[0];
          if (openClip) {
            const boxRig = new OneShotClipRig(boxClone, openClip);
            host.userData['npcBoxAnimRig'] = boxRig;
            this.activeAnimRigs.add(boxRig);
            if (host.userData['npcBoxClosePending']) {
              boxRig.playClose();
              host.userData['npcBoxClosePending'] = false;
              host.userData['npcBoxOpenPending'] = false;
            } else if (host.userData['npcBoxOpenPending']) {
              boxRig.play();
              host.userData['npcBoxOpenPending'] = false;
            }
          }
        }

        const collider = host.userData['npcPickCollider'] as THREE.Mesh | undefined;
        if (collider?.material && (collider.material as THREE.MeshLambertMaterial).isMeshLambertMaterial) {
          const mat = collider.material as THREE.MeshLambertMaterial;
          mat.transparent = true;
          mat.opacity = 0;
          mat.depthWrite = false;
          mat.colorWrite = false;
        }
      })
      .catch((error) => {
        console.warn(
          `[EntityVisualFactory] NPC '${String(host.userData['npcTemplateKey'])}' sin .gltf; se mantiene el cubo.`,
          error,
        );
      });
  }

  private stampNpcGltfClone(clone: THREE.Object3D, host: THREE.Group): void {
    clone.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) {
        return;
      }
      mesh.userData['sharedGltfAsset'] = true;
      mesh.userData['kind'] = 'npc';
      mesh.userData['npcInstanceId'] = host.userData['npcInstanceId'];
      mesh.userData['npcTemplateKey'] = host.userData['npcTemplateKey'];
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    });
  }

  private stripGltfLightsAndCameras(root: THREE.Object3D): void {
    const drop: THREE.Object3D[] = [];
    root.traverse((node) => {
      const asLight = node as THREE.Light;
      const asCam = node as THREE.Camera;
      if (asLight.isLight || asCam.isCamera) {
        drop.push(node);
      }
    });
    for (const node of drop) {
      node.parent?.remove(node);
    }
  }

  private updateSkinnedPose(root: THREE.Object3D): void {
    root.traverse((node) => {
      const skinned = node as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh && skinned.skeleton) {
        skinned.skeleton.update();
      }
    });
    root.updateMatrixWorld(true);
  }

  /** Escala uniforme a `targetHeight` y apoya pies en `-Y_LIFT` (mismo convenio que mobs). */
  private fitGltfToTargetHeight(
    clone: THREE.Object3D,
    targetHeight: number,
    yawOffset: number,
  ): THREE.Group {
    const holder = new THREE.Group();
    holder.add(clone);
    holder.rotation.y = yawOffset;
    holder.updateMatrixWorld(true);
    const box = this.computeMobFitBox(holder);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const rawHeight = size.y > 0.001 ? size.y : 1;
    const scale = targetHeight / rawHeight;
    holder.scale.setScalar(scale);
    holder.position.set(-center.x * scale, -Y_LIFT - box.min.y * scale, -center.z * scale);
    return holder;
  }

  private hideMapCollider(host: THREE.Object3D): void {
    const collider = this.findMapCollider(host);
    if (!collider?.material) {
      return;
    }
    const mat = collider.material as THREE.MeshLambertMaterial;
    if (!mat.isMeshLambertMaterial) {
      return;
    }
    mat.transparent = true;
    mat.opacity = 0;
    mat.depthWrite = false;
    mat.colorWrite = false;
  }

  private loadMobGltfTemplate(url: string): Promise<PlayerGltfTemplate> {
    const cached = this.mobGltfTemplateByUrl.get(url);
    if (cached) {
      return cached;
    }
    const pending = new Promise<PlayerGltfTemplate>((resolve, reject) => {
      this.gltfLoader.load(
        url,
        (gltf: GLTF) => {
          pruneMobAnimationTracks(gltf.animations);
          resolve({ scene: gltf.scene, animations: gltf.animations });
        },
        undefined,
        (error) => reject(error),
      );
    });
    this.mobGltfTemplateByUrl.set(url, pending);
    return pending;
  }

  private attachGltfMobModel(host: THREE.Group, def: MobVisualDef): void {
    this.loadMobGltfTemplate(def.url)
      .then((template) => {
        if (host.userData['kind'] !== 'mob') {
          return;
        }
        const clone = cloneSkinned(template.scene) as THREE.Group;
        const drop: THREE.Object3D[] = [];
        clone.traverse((node) => {
          const asLight = node as THREE.Light;
          const asCam = node as THREE.Camera;
          if (asLight.isLight || asCam.isCamera) {
            drop.push(node);
          }
        });
        for (const node of drop) {
          node.parent?.remove(node);
        }

        const tintMeshes: THREE.Mesh[] = [];
        clone.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) {
            return;
          }
          if (def.hideMeshName?.test(mesh.name)) {
            mesh.visible = false;
            return;
          }
          mesh.userData['sharedGltfAsset'] = true;
          mesh.userData['kind'] = 'mob';
          mesh.userData['mobInstanceId'] = host.userData['mobInstanceId'];
          mesh.frustumCulled = false;
          mesh.castShadow = true;
          tintMeshes.push(mesh);
        });

        clone.updateMatrixWorld(true);
        const fitMixer = this.poseMobCloneIdleForFit(clone, template.animations, def);
        const holder = this.fitMobGltfHolder(clone, def);
        fitMixer?.stopAllAction();
        fitMixer?.uncacheRoot(clone);

        const collider = host.userData['mobPickCollider'] as THREE.Mesh | undefined;
        if (collider?.material && (collider.material as THREE.MeshLambertMaterial).isMeshLambertMaterial) {
          const mat = collider.material as THREE.MeshLambertMaterial;
          mat.transparent = true;
          mat.opacity = 0;
          mat.depthWrite = false;
          mat.colorWrite = false;
        }

        host.add(holder);
        host.userData['bodyMesh'] = undefined;
        host.userData['tintMeshes'] = tintMeshes;
        host.userData['gltfModel'] = holder;
        const multiplier =
          typeof def.scaleMultiplier === 'number' &&
          Number.isFinite(def.scaleMultiplier) &&
          def.scaleMultiplier > 0
            ? def.scaleMultiplier
            : 1;
        host.userData['visualTopY'] = -Y_LIFT + def.targetHeight * multiplier + 0.22;

        if (template.animations.length > 0) {
          const rig = new MobAnimRig(clone, template.animations, def);
          host.userData['mobAnimRig'] = rig;
          this.activeAnimRigs.add(rig);
          const wantMelee = Boolean(host.userData['mobWantInMelee']);
          rig.setLocomotion(
            Boolean(host.userData['mobWantMoving']),
            Boolean(host.userData['mobWantChase']),
            wantMelee,
          );
          if (host.userData['mobPendingAttack']) {
            rig.playAttack(true);
            host.userData['mobPendingAttack'] = undefined;
          }
          if (host.userData['mobDeathPlaying']) {
            rig.playDeath();
          }
        }
      })
      .catch((error) => {
        console.error(
          '[EntityVisualFactory] No se pudo cargar el .gltf del mob; se mantiene el cubo.',
          error,
        );
      });
  }

  /**
   * Aplica el primer frame de idle (o el clip de hold) antes de medir bbox.
   * Mixamo deja la cadera a decenas de unidades en el clip; medir bind pose
   * subestima la altura y el goblin escala a tamaño titán.
   */
  private poseMobCloneIdleForFit(
    clone: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
    def: MobVisualDef,
  ): THREE.AnimationMixer | null {
    const idleRe = def.clips.idle ?? def.idleHoldFromClip;
    const clip = idleRe
      ? clips.find((c) => idleRe.test(c.name))
      : clips[0];
    if (!clip) {
      clone.updateMatrixWorld(true);
      return null;
    }
    const mixer = new THREE.AnimationMixer(clone);
    const action = mixer.clipAction(clip);
    action.play();
    mixer.update(1 / 30);
    clone.traverse((node) => {
      const skinned = node as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh && skinned.skeleton) {
        skinned.skeleton.update();
      }
    });
    clone.updateMatrixWorld(true);
    return mixer;
  }

  /**
   * Escala un holder (no pisa scale/rotation del root Sketchfab) para
   * `targetHeight`. Ignora decals planos (sombra del goblin).
   */
  private fitMobGltfHolder(clone: THREE.Object3D, def: MobVisualDef): THREE.Group {
    const holder = new THREE.Group();
    holder.add(clone);
    holder.rotation.y = def.yawOffset;
    holder.updateMatrixWorld(true);
    const box = this.computeMobFitBox(holder);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const rawHeight = size.y > 0.001 ? size.y : 1;
    const multiplier =
      typeof def.scaleMultiplier === 'number' &&
      Number.isFinite(def.scaleMultiplier) &&
      def.scaleMultiplier > 0
        ? def.scaleMultiplier
        : 1;
    const scale = (def.targetHeight / rawHeight) * multiplier;
    holder.scale.setScalar(scale);
    holder.position.set(-center.x * scale, -Y_LIFT - box.min.y * scale, -center.z * scale);
    return holder;
  }

  private computeMobFitBox(root: THREE.Object3D): THREE.Box3 {
    const box = new THREE.Box3();
    let any = false;
    root.updateMatrixWorld(true);
    root.traverse((node) => {
      const skinned = node as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) {
        if (!skinned.visible) {
          return;
        }
        skinned.computeBoundingBox();
        const skinnedBox = skinned.boundingBox;
        if (!skinnedBox || skinnedBox.isEmpty()) {
          return;
        }
        const world = skinnedBox.clone().applyMatrix4(skinned.matrixWorld);
        if (this.isFlatDecalBox(world)) {
          return;
        }
        box.union(world);
        any = true;
        return;
      }
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || !mesh.visible) {
        return;
      }
      mesh.geometry.computeBoundingBox?.();
      const geo = mesh.geometry.boundingBox;
      if (!geo || geo.isEmpty()) {
        return;
      }
      const world = geo.clone().applyMatrix4(mesh.matrixWorld);
      if (this.isFlatDecalBox(world)) {
        return;
      }
      box.union(world);
      any = true;
    });
    if (!any) {
      box.setFromObject(root);
    }
    return box;
  }

  private isFlatDecalBox(world: THREE.Box3): boolean {
    const size = world.getSize(new THREE.Vector3());
    const maxXZ = Math.max(size.x, size.z);
    return maxXZ > 0.4 && size.y < maxXZ * 0.08;
  }
}

/**
 * Si el AABB es casi uniforme (árboles/rocas/arbustos), `scale` del JSON (0.6–1.2) escala el mesh.
 * Antorchas/barriles tienen Y ≠ XZ (metros de hitbox) y no se multiplican.
 */
function heightFitVisualMultiplier(scale: { x: number; y: number; z: number }): number {
  const avg = (scale.x + scale.y + scale.z) / 3;
  if (!(avg > 0.01)) {
    return 1;
  }
  const maxDev = Math.max(
    Math.abs(scale.x - avg),
    Math.abs(scale.y - avg),
    Math.abs(scale.z - avg),
  );
  if (maxDev / avg >= 0.22) {
    return 1;
  }
  return Math.min(1.35, Math.max(0.6, avg));
}
