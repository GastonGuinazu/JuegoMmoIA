import * as THREE from 'three';

/**
 * Números de combate en sprites Three.js (canvas), no CSS2D.
 * Evita layout HTML + rAF extra por golpe. Pool fijo para no alocar cada hit.
 */
const POOL = 20;
const CANVAS_W = 256;
const CANVAS_H = 64;

type FloaterStyle = {
  fill: string;
  stroke: string;
  fontPx: number;
  scaleX: number;
  scaleY: number;
  durationMs: number;
  rise: number;
};

type PooledFloater = {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  startedAt: number;
  durationMs: number;
  baseY: number;
  rise: number;
  inUse: boolean;
};

function styleForDamage(critical: boolean, backstab: boolean, skillHit: boolean): FloaterStyle {
  if (backstab && critical) {
    return {
      fill: '#fff176',
      stroke: '#000000',
      fontPx: 44,
      scaleX: 2.35,
      scaleY: 0.62,
      durationMs: 950,
      rise: 1.8,
    };
  }
  if (backstab) {
    return {
      fill: '#ffeb3b',
      stroke: '#000000',
      fontPx: 34,
      scaleX: 1.85,
      scaleY: 0.48,
      durationMs: 950,
      rise: 1.8,
    };
  }
  if (critical) {
    return {
      fill: '#ff5252',
      stroke: '#000000',
      fontPx: 42,
      scaleX: 2.2,
      scaleY: 0.58,
      durationMs: 950,
      rise: 1.8,
    };
  }
  if (skillHit) {
    return {
      fill: '#ff9100',
      stroke: '#000000',
      fontPx: 34,
      scaleX: 1.9,
      scaleY: 0.48,
      durationMs: 950,
      rise: 1.8,
    };
  }
  return {
    fill: '#eceff1',
    stroke: '#000000',
    fontPx: 32,
    scaleX: 1.7,
    scaleY: 0.44,
    durationMs: 950,
    rise: 1.8,
  };
}

export class WorldCombatFloaters {
  private readonly pool: PooledFloater[] = [];
  private readonly scratch = new THREE.Vector3();

  constructor(private readonly root: THREE.Group) {
    for (let i = 0; i < POOL; i += 1) {
      this.pool.push(this.makeSlot());
    }
  }

  spawnDamage(
    worldPos: THREE.Vector3,
    damage: number,
    critical: boolean,
    backstab: boolean,
    skillHit: boolean,
  ): void {
    this.scratch.copy(worldPos);
    this.arm(String(Math.round(damage)), styleForDamage(critical, backstab, skillHit));
  }

  spawnXp(worldPos: THREE.Vector3, amount: number): void {
    this.scratch.copy(worldPos);
    this.arm(`+${amount} XP`, {
      fill: '#ce93d8',
      stroke: '#1a0a24',
      fontPx: 28,
      scaleX: 1.85,
      scaleY: 0.46,
      durationMs: 1000,
      rise: 1.35,
    });
  }

  spawnHeal(worldPos: THREE.Vector3, hp: number): void {
    this.scratch.copy(worldPos);
    this.arm(`+${hp} HP`, {
      fill: '#69f0ae',
      stroke: '#1b5e20',
      fontPx: 30,
      scaleX: 1.8,
      scaleY: 0.46,
      durationMs: 1000,
      rise: 1.6,
    });
  }

  spawnLoot(worldPos: THREE.Vector3, labelText: string): void {
    this.scratch.copy(worldPos);
    this.arm(labelText, {
      fill: '#fff9c4',
      stroke: '#f57f17',
      fontPx: 26,
      scaleX: 2.1,
      scaleY: 0.48,
      durationMs: 1100,
      rise: 1.15,
    });
  }

  tick(now: number): void {
    for (const slot of this.pool) {
      if (!slot.inUse) {
        continue;
      }
      const t = (now - slot.startedAt) / slot.durationMs;
      if (t >= 1) {
        this.release(slot);
        continue;
      }
      slot.sprite.position.y = slot.baseY + t * slot.rise;
      slot.material.opacity = Math.max(0, 1 - t);
    }
  }

  clear(): void {
    for (const slot of this.pool) {
      if (slot.inUse) {
        this.release(slot);
      }
    }
  }

  dispose(): void {
    this.clear();
    for (const slot of this.pool) {
      this.root.remove(slot.sprite);
      slot.texture.dispose();
      slot.material.dispose();
    }
    this.pool.length = 0;
  }

  private arm(text: string, style: FloaterStyle): void {
    const slot = this.acquire();
    this.paint(slot, text, style);
    slot.sprite.position.copy(this.scratch);
    slot.sprite.scale.set(style.scaleX, style.scaleY, 1);
    slot.sprite.visible = true;
    slot.material.opacity = 1;
    slot.startedAt = performance.now();
    slot.durationMs = style.durationMs;
    slot.baseY = this.scratch.y;
    slot.rise = style.rise;
    slot.inUse = true;
  }

  private acquire(): PooledFloater {
    const free = this.pool.find((s) => !s.inUse);
    if (free) {
      return free;
    }
    let oldest = this.pool[0]!;
    for (const slot of this.pool) {
      if (slot.startedAt < oldest.startedAt) {
        oldest = slot;
      }
    }
    return oldest;
  }

  private release(slot: PooledFloater): void {
    slot.inUse = false;
    slot.sprite.visible = false;
    slot.material.opacity = 0;
  }

  private paint(slot: PooledFloater, text: string, style: FloaterStyle): void {
    const { ctx, canvas } = slot;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `700 ${style.fontPx}px Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 8;
    ctx.strokeStyle = style.stroke;
    ctx.fillStyle = style.fill;
    const x = canvas.width / 2;
    const y = canvas.height / 2;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    slot.texture.needsUpdate = true;
  }

  private makeSlot(): PooledFloater {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('WorldCombatFloaters: no 2d context');
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 8;
    sprite.raycast = () => {};
    this.root.add(sprite);
    return {
      sprite,
      material,
      texture,
      canvas,
      ctx,
      startedAt: 0,
      durationMs: 1,
      baseY: 0,
      rise: 0,
      inUse: false,
    };
  }
}
