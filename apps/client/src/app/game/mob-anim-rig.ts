import * as THREE from 'three';
import type { MobClipKind, MobVisualDef } from './mob-visual-catalog';

const FADE_LOCOMOTION = 0.12;
const FADE_ONESHOT = 0.08;
const DEATH_FALLBACK_SEC = 0.85;
/** Evita relanzar Attack en el telegraph→hit (~280 ms); un swing nuevo (GCD ~700+) sí recorta. */
const ATTACK_RETRIGGER_GUARD_SEC = 0.45;

type LocomotionKind = Extract<MobClipKind, 'idle' | 'walk' | 'run'>;

/**
 * Mixer por instancia de mob. Clips del `.gltf` se agrupan por regex del catálogo;
 * si hay varios (p. ej. `die` / `die 2`) se intercalan en round-robin.
 */
export class MobAnimRig {
  private readonly mixer: THREE.AnimationMixer;
  private readonly root: THREE.Object3D;
  private readonly bindPos: THREE.Vector3;
  private readonly bindQuat: THREE.Quaternion;
  private readonly actions: Record<MobClipKind, THREE.AnimationAction[]> = {
    idle: [],
    walk: [],
    run: [],
    attack: [],
    hit: [],
    death: [],
  };
  private readonly cursor: Record<MobClipKind, number> = {
    idle: 0,
    walk: 0,
    run: 0,
    attack: 0,
    hit: 0,
    death: 0,
  };
  private current: MobClipKind = 'idle';
  private currentAction: THREE.AnimationAction | null = null;
  private moving = false;
  private chasing = false;
  private dead = false;
  private readonly idleHoldActions = new Set<THREE.AnimationAction>();
  private readonly onFinished = (event: { action: THREE.AnimationAction }): void => {
    if (this.dead) {
      return;
    }
    if (event.action !== this.currentAction) {
      return;
    }
    if (this.current !== 'attack' && this.current !== 'hit') {
      return;
    }
    this.fadeTo(this.resolveLocomotion(), FADE_LOCOMOTION);
  };

  constructor(root: THREE.Object3D, clips: readonly THREE.AnimationClip[], def: MobVisualDef) {
    this.root = root;
    this.bindPos = root.position.clone();
    this.bindQuat = root.quaternion.clone();
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', this.onFinished);

    const slicedFrom = new Set<string>();
    for (const slice of def.clipSlices ?? []) {
      const source = clips.find((clip) => slice.source.test(clip.name));
      if (!source) {
        continue;
      }
      slicedFrom.add(source.name);
      const sliced = THREE.AnimationUtils.subclip(
        source,
        `${source.name}__${slice.kind}`,
        slice.startSec,
        slice.endSec,
        1,
      );
      this.bindClip(sliced, slice.kind, def);
    }

    for (const clip of clips) {
      if (slicedFrom.has(clip.name)) {
        continue;
      }
      const kind = this.classify(clip.name, def);
      if (!kind) {
        continue;
      }
      this.bindClip(clip, kind, def);
    }

    this.bindIdleHold(clips, def);
    this.bindAttackFallbacks(clips, def);
    this.fadeTo('idle', 0);
  }

  private bindClip(clip: THREE.AnimationClip, kind: MobClipKind, def: MobVisualDef): void {
    const inPlace = prepareMobClip(clip, def.freezeRootY === true);
    const action = this.mixer.clipAction(inPlace);
    action.enabled = true;
    if (kind === 'idle' || kind === 'walk' || kind === 'run') {
      action.setLoop(THREE.LoopRepeat, Infinity);
    } else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    this.actions[kind].push(action);
  }

  private bindIdleHold(clips: readonly THREE.AnimationClip[], def: MobVisualDef): void {
    if (this.actions.idle.length > 0 || !def.idleHoldFromClip) {
      return;
    }
    const source = clips.find((clip) => def.idleHoldFromClip?.test(clip.name));
    if (!source) {
      return;
    }
    const holdEnd = Math.min(0.06, source.duration);
    const hold = THREE.AnimationUtils.subclip(source, `${source.name}__idleHold`, 0, holdEnd, 1);
    const inPlace = prepareMobClip(hold, def.freezeRootY === true);
    const action = this.mixer.clipAction(inPlace);
    action.enabled = true;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.timeScale = 0;
    this.idleHoldActions.add(action);
    this.actions.idle.push(action);
  }

  /**
   * Si el export no trae clip Attack, usa Jump / fall / hit como golpe secundario.
   */
  private bindAttackFallbacks(
    clips: readonly THREE.AnimationClip[],
    def: MobVisualDef,
  ): void {
    if (this.actions.attack.length > 0) {
      return;
    }
    const fallback = clips.filter((clip) => /^(Jump|fall)$/i.test(clip.name));
    const source = fallback.length > 0 ? fallback : [];
    for (const clip of source) {
      const already = this.actions.hit.some((a) => a.getClip().name === clip.name);
      if (already) {
        continue;
      }
      const inPlace = prepareMobClip(clip, def.freezeRootY === true);
      const action = this.mixer.clipAction(inPlace);
      action.enabled = true;
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.actions.attack.push(action);
    }
    if (this.actions.attack.length === 0 && this.actions.hit.length > 0) {
      this.actions.attack.push(...this.actions.hit);
    }
  }

  setLocomotion(moving: boolean, chasing: boolean, _inMeleeRange = false): void {
    if (this.dead) {
      return;
    }
    this.moving = moving;
    this.chasing = chasing;
    if (this.current === 'attack' || this.current === 'hit' || this.current === 'death') {
      return;
    }
    this.fadeTo(this.resolveLocomotion(), FADE_LOCOMOTION);
  }

  playAttack(_inMeleeRange = true): void {
    if (this.dead) {
      return;
    }
    if (this.current === 'attack' && this.currentAction?.isRunning()) {
      if (this.currentAction.time < ATTACK_RETRIGGER_GUARD_SEC) {
        return;
      }
    }
    if (this.actions.attack.length > 0) {
      this.playOneShot('attack');
      return;
    }
    this.playOneShot('hit');
  }

  /**
   * Respawn: corta Death, limpia el mixer y vuelve a Idle en la postura viva.
   */
  resetToIdle(): void {
    this.dead = false;
    this.moving = false;
    this.chasing = false;
    this.mixer.stopAllAction();
    for (const list of Object.values(this.actions)) {
      for (const action of list) {
        action.stop();
        action.reset();
        action.enabled = true;
        if (this.idleHoldActions.has(action)) {
          action.timeScale = 0;
          action.time = 0;
          action.paused = true;
        }
      }
    }
    this.currentAction = null;
    this.current = 'idle';
    this.fadeTo('idle', 0);
  }

  playHit(): void {
    this.playOneShot('hit');
  }

  /** Devuelve duración estimada del clip (o fallback) para diferir el hide. */
  playDeath(): number {
    this.dead = true;
    if (this.actions.death.length > 0) {
      return this.playOneShot('death');
    }
    this.mixer.stopAllAction();
    this.currentAction = null;
    return DEATH_FALLBACK_SEC;
  }

  update(deltaSeconds: number): void {
    if (this.dead && this.actions.death.length === 0) {
      this.root.position.copy(this.bindPos);
      this.root.quaternion.copy(this.bindQuat);
      return;
    }
    this.mixer.update(deltaSeconds);
    this.root.position.copy(this.bindPos);
    this.root.quaternion.copy(this.bindQuat);
  }

  dispose(): void {
    this.mixer.removeEventListener('finished', this.onFinished);
    this.mixer.stopAllAction();
  }

  private classify(clipName: string, def: MobVisualDef): MobClipKind | null {
    const order: MobClipKind[] = ['death', 'attack', 'hit', 'run', 'walk', 'idle'];
    for (const kind of order) {
      const re = def.clips[kind];
      if (re?.test(clipName)) {
        return kind;
      }
    }
    return null;
  }

  private resolveLocomotion(): LocomotionKind {
    if (!this.moving) {
      return 'idle';
    }
    if (this.chasing && this.actions.run.length > 0) {
      return 'run';
    }
    return this.actions.walk.length > 0 ? 'walk' : 'idle';
  }

  private playOneShot(kind: MobClipKind): number {
    if (this.dead && kind !== 'death') {
      return 0;
    }
    const list = this.actions[kind];
    if (!list.length) {
      return 0;
    }
    const index = this.cursor[kind] % list.length;
    this.cursor[kind] = index + 1;
    const next = list[index];
    this.crossFade(next, kind, FADE_ONESHOT);
    return next.getClip().duration;
  }

  private fadeTo(kind: MobClipKind, fadeSeconds: number): void {
    const list = this.actions[kind];
    if (!list.length) {
      return;
    }
    const next = list[0];
    if (this.current === kind && this.currentAction === next) {
      if (this.idleHoldActions.has(next) || next.isRunning()) {
        return;
      }
    }
    this.crossFade(next, kind, fadeSeconds);
  }

  private crossFade(next: THREE.AnimationAction, kind: MobClipKind, fadeSeconds: number): void {
    const prev = this.currentAction;
    next.reset();
    next.setEffectiveWeight(1);
    if (this.idleHoldActions.has(next)) {
      next.timeScale = 0;
      next.time = 0;
      next.paused = true;
    }
    if (prev && prev !== next) {
      prev.fadeOut(fadeSeconds);
    }
    if (fadeSeconds > 0 && !this.idleHoldActions.has(next)) {
      next.fadeIn(fadeSeconds);
    }
    next.play();
    this.currentAction = next;
    this.current = kind;
  }
}

function prepareMobClip(clip: THREE.AnimationClip, freezeY: boolean): THREE.AnimationClip {
  return freezeRootMotion(normalizePackedClipTimeline(clip), freezeY);
}

/**
 * Sketchfab/Lineage empaquetan clips en una sola línea de tiempo (Walk en t=63–65
 * con duration 65). Reproducir desde 0 congela la primera pose casi un minuto.
 * Recorta la ventana real de keys y la desplaza a t=0.
 */
function normalizePackedClipTimeline(clip: THREE.AnimationClip): THREE.AnimationClip {
  let minT = Infinity;
  let maxT = -Infinity;
  for (const track of clip.tracks) {
    if (track.times.length === 0) {
      continue;
    }
    minT = Math.min(minT, track.times[0]!);
    maxT = Math.max(maxT, track.times[track.times.length - 1]!);
  }
  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT - minT < 0.08) {
    return clip;
  }
  if (minT < 0.04) {
    return clip;
  }
  return THREE.AnimationUtils.subclip(clip, clip.name, minT, maxT + 0.05, 1);
}

function freezeRootMotion(clip: THREE.AnimationClip, freezeY: boolean): THREE.AnimationClip {
  const tracks = clip.tracks.map((track) => {
    if (!isRootMotionPositionTrack(track.name)) {
      return track;
    }
    const clone = track.clone();
    const firstX = clone.values[0] ?? 0;
    const firstY = clone.values[1] ?? 0;
    const firstZ = clone.values[2] ?? 0;
    for (let i = 0; i < clone.values.length; i += 3) {
      clone.values[i] = firstX;
      if (freezeY) {
        clone.values[i + 1] = firstY;
      }
      clone.values[i + 2] = firstZ;
    }
    return clone;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Sólo cadera / root. Congelar .position de pies/IK convierte el walk en saltitos.
 */
function isRootMotionPositionTrack(trackName: string): boolean {
  const n = trackName.toLowerCase();
  if (!n.endsWith('.position')) {
    return false;
  }
  if (/spine|neck|head|clavicle|shoulder|arm|hand|leg|foot|toe|calf|thigh/.test(n)) {
    return false;
  }
  return /hips|pelvis|pelv|ogrepelvis|control_01|npc root|\[root\]/.test(n);
}

const TRACK_PROP_SUFFIXES = ['.position', '.quaternion', '.scale', '.rotation'] as const;

function trackNodeName(trackName: string): string {
  for (const suffix of TRACK_PROP_SUFFIXES) {
    if (trackName.endsWith(suffix)) {
      return trackName.slice(0, -suffix.length);
    }
  }
  const i = trackName.lastIndexOf('.');
  return i > 0 ? trackName.slice(0, i) : trackName;
}

function isConstantIdentityScale(track: THREE.KeyframeTrack): boolean {
  if (!track.name.endsWith('.scale')) {
    return false;
  }
  const values = track.values;
  for (let i = 0; i < values.length; i++) {
    if (Math.abs((values[i] ?? 1) - 1) > 0.001) {
      return false;
    }
  }
  return values.length > 0;
}

/**
 * Recorta widgets Rigify (VIS_, huesos `_end_`) y scales constantes.
 * Mutar los clips de la plantilla una vez: cada instancia hereda menos interpolants.
 */
export function pruneMobAnimationTracks(clips: readonly THREE.AnimationClip[]): void {
  for (const clip of clips) {
    clip.tracks = clip.tracks.filter((track) => {
      const nodeName = trackNodeName(track.name);
      if (/^VIS_/i.test(nodeName) || /_end_\d+$/i.test(nodeName)) {
        return false;
      }
      if (isConstantIdentityScale(track)) {
        return false;
      }
      return true;
    });
    clip.resetDuration();
  }
}
