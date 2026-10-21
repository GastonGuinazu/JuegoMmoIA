import * as THREE from 'three';

/**
 * Estados de animación de personaje que el Weaver sabe pedir. Pocos a propósito:
 * locomoción (idle/walk) + dos one-shots de combate. Si un asset no trae clips
 * separados, se recortan ventanas del clip concatenado (ver `PLAYER_ANIM_WINDOWS`).
 */
export type CharacterAnimState = 'idle' | 'walk' | 'attack' | 'skill';

export type CharacterCombatAnim = Extract<CharacterAnimState, 'attack' | 'skill'>;

/**
 * Forma común entre `CharacterAnimRig` (clip único concatenado, lizard) y
 * `NamedClipCharacterAnimRig` (clips separados y nombrados, sorceress/futuras clases) — el
 * resto de `EntityVisualFactoryService` pide `setMoving`/`playCombat` sin saber cuál de las
 * dos está detrás.
 */
export interface PlayerAnimRig {
  setMoving(moving: boolean): void;
  playCombat(kind: CharacterCombatAnim): void;
  update(deltaSeconds: number): void;
  dispose(): void;
}

export interface CharacterAnimWindow {
  state: CharacterAnimState;
  /** Segundos dentro del clip fuente (inclusive). */
  startSec: number;
  /** Segundos dentro del clip fuente (exclusive para `subclip`). */
  endSec: number;
  loop: boolean;
}

/**
 * Ventanas del clip único `"Motion"` de `lizard_man_warrior` (duración 28.55 s).
 * Recortadas a mano mirando velocidad de muslo (locomoción) vs brazo derecho (golpes)
 * y altura de cadera (salto de skill / caída). Ajustar aquí si un recorte se ve mal;
 * no hace falta reexportar el `.gltf`.
 */
export const PLAYER_ANIM_WINDOWS: readonly CharacterAnimWindow[] = [
  { state: 'idle', startSec: 14.6, endSec: 16.6, loop: true },
  { state: 'walk', startSec: 5.7, endSec: 6.9, loop: true },
  { state: 'attack', startSec: 0.5, endSec: 1.1, loop: false },
  { state: 'skill', startSec: 7.7, endSec: 8.95, loop: false },
];

const ROOT_POSITION_TRACK = 'Bip001_03.position';
const FADE_LOCOMOTION = 0.14;
const FADE_COMBAT = 0.08;

/**
 * Un mixer + 4 acciones por personaje visible. El viewport no habla con Three.Animation*
 * directo: pide `setMoving` / `playCombat` y este rig decide el crossfade.
 *
 * El clip fuente anima también la traslación de cadera (root motion). Eso haría que el
 * modelo se deslice respecto del `host` que ya mueve el NetPredictor.
 * Espacio del hueso tras el export Sketchfab (Y-up): se congelan X/Z (plano horizontal)
 * al primer keyframe; se deja Y para el bob de idle y el salto de la skill.
 * Congelar X/Y y dejar Z (como si Z fuera up) desplazaba el mesh hacia adelante y el
 * hit/origen quedaban detrás de la piel.
 */
export class CharacterAnimRig implements PlayerAnimRig {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: Record<CharacterAnimState, THREE.AnimationAction>;
  private current: CharacterAnimState = 'idle';
  private moving = false;
  private readonly onFinished = (event: { action: THREE.AnimationAction }): void => {
    if (event.action !== this.actions.attack && event.action !== this.actions.skill) {
      return;
    }
    this.fadeTo(this.moving ? 'walk' : 'idle', FADE_LOCOMOTION);
  };

  constructor(root: THREE.Object3D, sourceClip: THREE.AnimationClip) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', this.onFinished);

    const actions = {} as Record<CharacterAnimState, THREE.AnimationAction>;
    for (const window of PLAYER_ANIM_WINDOWS) {
      const sliced = THREE.AnimationUtils.subclip(
        sourceClip,
        window.state,
        window.startSec,
        window.endSec,
        1,
      );
      const inPlace = freezeRootHorizontalMotion(sliced);
      const action = this.mixer.clipAction(inPlace);
      action.enabled = true;
      if (window.loop) {
        action.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      actions[window.state] = action;
    }
    this.actions = actions;
    this.actions.idle.play();
  }

  get mixerInstance(): THREE.AnimationMixer {
    return this.mixer;
  }

  setMoving(moving: boolean): void {
    this.moving = moving;
    if (this.current === 'attack' || this.current === 'skill') {
      return;
    }
    this.fadeTo(moving ? 'walk' : 'idle', FADE_LOCOMOTION);
  }

  playCombat(kind: CharacterCombatAnim): void {
    this.fadeTo(kind, FADE_COMBAT);
  }

  update(deltaSeconds: number): void {
    this.mixer.update(deltaSeconds);
  }

  dispose(): void {
    this.mixer.removeEventListener('finished', this.onFinished);
    this.mixer.stopAllAction();
  }

  private fadeTo(state: CharacterAnimState, fadeSeconds: number): void {
    if (this.current === state && this.actions[state].isRunning()) {
      if (state === 'attack' || state === 'skill') {
        this.actions[state].reset().play();
      }
      return;
    }
    const next = this.actions[state];
    const prev = this.actions[this.current];
    next.reset();
    next.setEffectiveWeight(1);
    if (prev && prev !== next) {
      prev.fadeOut(fadeSeconds);
    }
    next.fadeIn(fadeSeconds);
    next.play();
    this.current = state;
  }
}

function freezeRootHorizontalMotion(clip: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = clip.tracks.map((track) => {
    if (track.name !== ROOT_POSITION_TRACK) {
      return track;
    }
    const clone = track.clone();
    const firstX = clone.values[0] ?? 0;
    const firstZ = clone.values[2] ?? 0;
    for (let i = 0; i < clone.values.length; i += 3) {
      clone.values[i] = firstX;
      clone.values[i + 2] = firstZ;
    }
    return clone;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** Regex por nombre de clip para mapear los 4 estados del Weaver en un asset con clips separados. */
export interface NamedClipMap {
  idle: RegExp;
  walk: RegExp;
  attack: RegExp;
  /** Si no matchea ningún clip, `skill` reusa la misma acción que `attack`. */
  skill: RegExp;
}

/**
 * Mismo contrato que `CharacterAnimRig` (ver `PlayerAnimRig`) pero para assets que ya traen
 * los 4 estados como clips separados y nombrados (p. ej. sorceress.glb: "Armature|Idle",
 * "Armature|Run", "Armature|Attack 1", "Armature|Attack 2") en vez de un único clip
 * concatenado — no hace falta recortar ventanas ni congelar root motion por `subclip`.
 */
export class NamedClipCharacterAnimRig implements PlayerAnimRig {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: Partial<Record<CharacterAnimState, THREE.AnimationAction>> = {};
  private current: CharacterAnimState = 'idle';
  private moving = false;
  private readonly onFinished = (event: { action: THREE.AnimationAction }): void => {
    if (event.action !== this.actions.attack && event.action !== this.actions.skill) {
      return;
    }
    this.fadeTo(this.moving ? 'walk' : 'idle', FADE_LOCOMOTION);
  };

  constructor(
    root: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
    clipMap: NamedClipMap,
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', this.onFinished);

    const find = (re: RegExp) => clips.find((c) => re.test(c.name));
    const bind = (state: CharacterAnimState, clip: THREE.AnimationClip | undefined, loop: boolean) => {
      if (!clip) {
        return;
      }
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      if (loop) {
        action.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions[state] = action;
    };

    bind('idle', find(clipMap.idle), true);
    bind('walk', find(clipMap.walk), true);
    const attackClip = find(clipMap.attack);
    bind('attack', attackClip, false);
    bind('skill', find(clipMap.skill) ?? attackClip, false);

    this.actions.idle?.play();
  }

  get mixerInstance(): THREE.AnimationMixer {
    return this.mixer;
  }

  setMoving(moving: boolean): void {
    this.moving = moving;
    if (this.current === 'attack' || this.current === 'skill') {
      return;
    }
    this.fadeTo(moving ? 'walk' : 'idle', FADE_LOCOMOTION);
  }

  playCombat(kind: CharacterCombatAnim): void {
    this.fadeTo(kind, FADE_COMBAT);
  }

  update(deltaSeconds: number): void {
    this.mixer.update(deltaSeconds);
  }

  dispose(): void {
    this.mixer.removeEventListener('finished', this.onFinished);
    this.mixer.stopAllAction();
  }

  private fadeTo(state: CharacterAnimState, fadeSeconds: number): void {
    const next = this.actions[state] ?? this.actions.idle;
    if (!next) {
      return;
    }
    if (this.current === state && next.isRunning()) {
      if (state === 'attack' || state === 'skill') {
        next.reset().play();
      }
      return;
    }
    const prev = this.actions[this.current];
    next.reset();
    next.setEffectiveWeight(1);
    if (prev && prev !== next) {
      prev.fadeOut(fadeSeconds);
    }
    next.fadeIn(fadeSeconds);
    next.play();
    this.current = state;
  }
}
