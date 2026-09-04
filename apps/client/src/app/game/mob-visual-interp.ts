/**
 * Interpolación de mobs (The Weaver / NetPredictor): el visual se dibuja ~1–2 ticks
 * en el pasado, entre muestras `mob-moved`, en vez de perseguir el último snapshot.
 * Perseguir el auth hace: llegar → frenar → nuevo paquete → salto. Eso se veía
 * como walk a trompicones aunque la animación ya estuviera atada a la velocidad.
 */

export type MobInterpPose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
};

type MobInterpSample = MobInterpPose & { t: number };

/** Atraso de presentación: cubre un tick de 50 ms y jitter de red/IA. */
const DELAY_MS = 70;
/** Si el siguiente snapshot no llega, seguir a velocidad del último tramo. */
const MAX_EXTRAPOLATE_MS = 180;
const SNAP_XZ = 8;
const MAX_SAMPLES = 12;

export class MobVisualInterp {
  private readonly buffers = new Map<string, MobInterpSample[]>();

  clear(): void {
    this.buffers.clear();
  }

  delete(id: string): void {
    this.buffers.delete(id);
  }

  has(id: string): boolean {
    const buf = this.buffers.get(id);
    return !!buf && buf.length > 0;
  }

  hardSnap(id: string, t: number, pose: MobInterpPose): void {
    if (!poseIsFinite(pose) || !Number.isFinite(t)) {
      return;
    }
    this.buffers.set(id, [{ t, ...pose }]);
  }

  /** Sólo en recepción de snapshot de red, nunca cada frame con el auth actual. */
  push(id: string, t: number, pose: MobInterpPose): void {
    if (!poseIsFinite(pose) || !Number.isFinite(t)) {
      return;
    }
    const buf = this.buffers.get(id);
    if (!buf || buf.length === 0) {
      this.buffers.set(id, [{ t, ...pose }]);
      return;
    }
    const last = buf[buf.length - 1]!;
    const jump = Math.hypot(pose.x - last.x, pose.z - last.z);
    if (jump >= SNAP_XZ) {
      this.hardSnap(id, t, pose);
      return;
    }
    if (t < last.t - 0.5) {
      return;
    }
    if (t <= last.t) {
      last.x = pose.x;
      last.y = pose.y;
      last.z = pose.z;
      last.yaw = pose.yaw;
      last.t = t;
      return;
    }
    buf.push({ t, ...pose });
    if (buf.length > MAX_SAMPLES) {
      buf.splice(0, buf.length - MAX_SAMPLES);
    }
  }

  sample(id: string, nowMs: number): MobInterpPose | null {
    const buf = this.buffers.get(id);
    if (!buf || buf.length === 0) {
      return null;
    }
    const renderAt = nowMs - DELAY_MS;
    while (buf.length > 2 && buf[1]!.t <= renderAt) {
      buf.shift();
    }
    const first = buf[0]!;
    if (renderAt <= first.t) {
      return copyPose(first);
    }
    for (let i = 0; i < buf.length - 1; i += 1) {
      const a = buf[i]!;
      const b = buf[i + 1]!;
      if (renderAt > b.t) {
        continue;
      }
      const span = Math.max(1, b.t - a.t);
      return lerpPose(a, b, (renderAt - a.t) / span);
    }
    const last = buf[buf.length - 1]!;
    if (buf.length < 2) {
      return copyPose(last);
    }
    const prev = buf[buf.length - 2]!;
    const extra = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, renderAt - last.t));
    if (extra <= 0) {
      return copyPose(last);
    }
    const span = Math.max(1, last.t - prev.t);
    const u = extra / span;
    return {
      x: last.x + (last.x - prev.x) * u,
      y: last.y + (last.y - prev.y) * u,
      z: last.z + (last.z - prev.z) * u,
      yaw: last.yaw + yawDelta(prev.yaw, last.yaw) * u,
    };
  }
}

function poseIsFinite(pose: MobInterpPose): boolean {
  return (
    Number.isFinite(pose.x) &&
    Number.isFinite(pose.y) &&
    Number.isFinite(pose.z) &&
    Number.isFinite(pose.yaw)
  );
}

function copyPose(s: MobInterpSample): MobInterpPose {
  return { x: s.x, y: s.y, z: s.z, yaw: s.yaw };
}

function yawDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) {
    d -= Math.PI * 2;
  }
  while (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return d;
}

function lerpPose(a: MobInterpSample, b: MobInterpSample, u: number): MobInterpPose {
  const t = Math.min(1, Math.max(0, u));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    yaw: a.yaw + yawDelta(a.yaw, b.yaw) * t,
  };
}
