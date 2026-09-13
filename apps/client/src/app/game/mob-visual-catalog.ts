/**
 * Mapping data-driven `mobTemplateKey` → asset `.gltf` (The Weaver).
 * Alturas relativas al dummy `BOX = 0.8` (jugador visual 3× = 2.4).
 */
export type MobClipKind = 'idle' | 'walk' | 'run' | 'attack' | 'hit' | 'death';

export interface MobVisualDef {
  url: string;
  /** Altura visual objetivo (pies en `-Y_LIFT`). Cosmético; el hitbox lógico sigue siendo `BOX`. */
  targetHeight: number;
  /**
   * Multiplicador extra sobre `targetHeight` (p. ej. araña 0.5). Se aplica en spawn y respawn
   * porque el mismo Group se reutiliza.
   */
  scaleMultiplier?: number;
  yawOffset: number;
  /**
   * Congela también Y en tracks `.position` (walks con bounce/hop de root motion).
   * El default sólo congela X/Z.
   */
  freezeRootY?: boolean;
  /**
   * Si el asset no trae idle, usa el primer frame del clip que matchee (p. ej. un
   * Take único que es el ataque) como pose quieta. El clip de attack se clona aparte.
   */
  idleHoldFromClip?: RegExp;
  /**
   * Recortes de un clip concatenado (Sketchfab/Rigify con un solo Take).
   * Si hay slices, el clip fuente no se clasifica entero: cada ventana es un kind.
   */
  clipSlices?: readonly MobClipSlice[];
  /** Ocultar mallas extra del export (widgets Rigify, esferas) antes del fit. */
  hideMeshName?: RegExp;
  /** Regex por clip del export. Varios matches se intercalan (ataques/muertes). */
  clips: Partial<Record<MobClipKind, RegExp>>;
}

export interface MobClipSlice {
  kind: MobClipKind;
  source: RegExp;
  startSec: number;
  endSec: number;
}

export const MOB_VISUAL_BY_TEMPLATE: Readonly<Record<string, MobVisualDef>> = {
  skeleton: {
    url: '/models/mobs/skeleton/scene.gltf',
    targetHeight: 2.4,
    yawOffset: 0,
    clips: {
      idle: /idle/i,
      walk: /walk/i,
      attack: /attack/i,
      hit: /hitted/i,
    },
  },
  spider: {
    url: '/models/mobs/spider/scene.gltf',
    targetHeight: 1.76,
    scaleMultiplier: 0.5,
    yawOffset: Math.PI,
    clips: {
      idle: /warte_pose/i,
      walk: /walk_ani_vor/i,
      run: /run_ani_vor/i,
      attack: /^Attack$/i,
      death: /^die/i,
    },
  },
  spider2: {
    url: '/models/mobs/spider/scene.gltf',
    targetHeight: 1.76,
    scaleMultiplier: 0.5,
    yawOffset: Math.PI,
    clips: {
      idle: /warte_pose/i,
      walk: /walk_ani_vor/i,
      run: /run_ani_vor/i,
      attack: /^Attack$/i,
      death: /^die/i,
    },
  },
  goblin: {
    url: '/models/mobs/goblin/scene.gltf',
    targetHeight: 1.55,
    yawOffset: 0,
    clips: {
      idle: /^G_Idle/i,
      walk: /^G_Walk$/i,
      attack: /^G_Attack$/i,
    },
  },
  goblin2: {
    url: '/models/mobs/goblin2/scene.gltf',
    targetHeight: 1.85,
    yawOffset: 0,
    clips: {
      idle: /^SmHuma_Goblin_Idle$/,
      walk: /WalkForward_1H$/,
      run: /RunForward_1H$/,
      attack: /AttackPower01_/,
      hit: /IdleRecoil|StaggerBack/,
      death: /Death/,
    },
  },
  scorpion: {
    url: '/models/mobs/scorpion/scene.gltf',
    targetHeight: 1.35,
    scaleMultiplier: 0.7,
    yawOffset: 0,
    clips: {
      idle: /^Idle$/,
      walk: /^Walk$/,
      attack: /Area Attack/,
      death: /^Death$/,
    },
  },
  zombie: {
    url: '/models/mobs/zombie/scene.gltf',
    targetHeight: 2.05,
    yawOffset: 0,
    clips: {
      idle: /^idle$/i,
      walk: /^walk$/i,
      attack: /^attack$/i,
      death: /^death$/i,
    },
  },
  zombie2: {
    url: '/models/mobs/zombie2/scene.gltf',
    targetHeight: 2.1,
    yawOffset: 0,
    idleHoldFromClip: /Take 001/i,
    clips: {
      attack: /Take 001/i,
    },
  },
  ogre: {
    url: '/models/mobs/ogre/scene.gltf',
    targetHeight: 3.35,
    yawOffset: 0,
    freezeRootY: true,
    clips: {
      idle: /^idle_/i,
      walk: /^walk_/i,
      attack: /^attack/i,
      hit: /^hit_/i,
      death: /^death_/i,
    },
  },
  bull_fighter: {
    url: '/models/mobs/bullfighter/scene.gltf',
    targetHeight: 3.1,
    scaleMultiplier: 0.85,
    yawOffset: 0,
    clips: {
      idle: /bstd_01/i,
      walk: /run_turn/i,
      attack: /_atk_0[1-8]$/i,
      death: /die_/i,
    },
  },
  silver_dragonkin: {
    url: '/models/mobs/silverdragonkin/scene.gltf',
    targetHeight: 4.2,
    yawOffset: 0,
    freezeRootY: true,
    clips: {
      idle: /Btl_Std01/,
      walk: /Btl_Walk01/,
      run: /Btl_Run01/,
      attack: /Btl_Atk0[1-3]/,
      hit: /Dmg_Hit01/,
      death: /Dmg_Die01/,
    },
  },
};

export function resolveMobVisualDef(templateKey: string | null | undefined): MobVisualDef | null {
  if (!templateKey) {
    return null;
  }
  return MOB_VISUAL_BY_TEMPLATE[templateKey] ?? null;
}
