import type * as THREE from 'three';

const STORAGE_PERF_HUD = 'aetheris.perfHud';
const REFRESH_MS = 500;
const SOFTWARE_RENDERER = /swiftshader|warp|llvmpipe|software|basic render/i;

/** Nombre del renderer WebGL real (GPU o emulador por CPU); null si el navegador no lo expone. */
export function readGlRenderer(renderer: THREE.WebGLRenderer): string | null {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
  } catch {
    return null;
  }
}

/**
 * Si WebGL corre por software (aceleración por hardware desactivada), avisa en pantalla:
 * en ese modo el 3D usa todos los núcleos de CPU y el juego va a ~10 fps sin importar el código.
 */
export function warnIfSoftwareRenderer(renderer: THREE.WebGLRenderer, host: HTMLElement): void {
  const name = readGlRenderer(renderer);
  if (!name || !SOFTWARE_RENDERER.test(name)) {
    return;
  }
  console.warn(`[Aetheris] WebGL por software (${name}). Activá la aceleración por hardware del navegador.`);
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;left:50%;top:8px;transform:translateX(-50%);z-index:70;max-width:80%;' +
    'padding:6px 12px;border-radius:6px;background:#7a2b12;color:#fff;font:12px/1.35 system-ui,sans-serif;' +
    'text-align:center;cursor:pointer';
  el.textContent =
    `El navegador está renderizando por software (${name}). ` +
    'Activá "Usar aceleración gráfica cuando esté disponible" en la configuración del navegador (Sistema) y reinicialo. Clic para cerrar.';
  el.addEventListener('click', () => el.remove());
  host.appendChild(el);
}

/**
 * Panel de diagnóstico de rendimiento (F3). Escribe directo al DOM: no toca signals
 * ni change detection, así que medirlo no distorsiona lo que mide.
 */
export class PerfHud {
  private el: HTMLDivElement | null = null;
  private visible = false;
  private frames = 0;
  private sumSim = 0;
  private sumGl = 0;
  private sumCss = 0;
  private maxFrame = 0;
  private lastFrameTs = 0;
  private lastRefresh = 0;

  constructor(private readonly host: HTMLElement) {
    try {
      this.visible = localStorage.getItem(STORAGE_PERF_HUD) === '1';
    } catch {
      /* sin storage */
    }
  }

  toggle(): void {
    this.visible = !this.visible;
    try {
      localStorage.setItem(STORAGE_PERF_HUD, this.visible ? '1' : '0');
    } catch {
      /* sin storage */
    }
    if (!this.visible && this.el) {
      this.el.remove();
      this.el = null;
    }
  }

  /** Llamar una vez por frame, después de renderizar. Tiempos en ms. */
  sample(
    timestamp: number,
    simMs: number,
    glMs: number,
    cssMs: number,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    counts: { mobs: number; drops: number },
  ): void {
    if (!this.visible) {
      return;
    }
    if (this.lastFrameTs > 0) {
      this.maxFrame = Math.max(this.maxFrame, timestamp - this.lastFrameTs);
    }
    this.lastFrameTs = timestamp;
    this.frames++;
    this.sumSim += simMs;
    this.sumGl += glMs;
    this.sumCss += cssMs;
    if (timestamp - this.lastRefresh < REFRESH_MS) {
      return;
    }
    const secs = (timestamp - this.lastRefresh) / 1000;
    if (this.lastRefresh > 0) {
      this.paint(secs, renderer, scene, counts);
    }
    this.lastRefresh = timestamp;
    this.frames = 0;
    this.sumSim = this.sumGl = this.sumCss = this.maxFrame = 0;
  }

  private paint(
    secs: number,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    counts: { mobs: number; drops: number },
  ): void {
    if (!this.el) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute;left:8px;bottom:64px;z-index:60;padding:6px 8px;border-radius:6px;' +
        'background:rgba(0,0,0,.78);color:#9fe870;font:11px/1.35 Consolas,monospace;' +
        'white-space:pre;pointer-events:none';
      this.host.appendChild(el);
      this.el = el;
    }
    let lights = 0;
    let meshes = 0;
    let skinned = 0;
    scene.traverse((o) => {
      const n = o as THREE.Object3D & { isLight?: boolean; isMesh?: boolean; isSkinnedMesh?: boolean };
      if (n.isLight) lights++;
      if (n.isMesh && n.visible) meshes++;
      if (n.isSkinnedMesh && n.visible) skinned++;
    });
    const f = Math.max(1, this.frames);
    const info = renderer.info;
    const dpr = renderer.getPixelRatio();
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this.el.textContent =
      `F3 · rendimiento\n` +
      `fps ${(this.frames / secs).toFixed(0)}   frame máx ${this.maxFrame.toFixed(0)} ms\n` +
      `sim ${(this.sumSim / f).toFixed(1)} ms · gl ${(this.sumGl / f).toFixed(1)} ms · css2d ${(this.sumCss / f).toFixed(1)} ms\n` +
      `draw calls ${info.render.calls} · tris ${(info.render.triangles / 1000).toFixed(0)}k\n` +
      `geom ${info.memory.geometries} · tex ${info.memory.textures} · progs ${info.programs?.length ?? 0}\n` +
      `luces ${lights} · mallas ${meshes} · skinned ${skinned}\n` +
      `mobs ${counts.mobs} · drops ${counts.drops}\n` +
      `gpu ${readGlRenderer(renderer) ?? '?'}
` +
      `canvas ${renderer.domElement.width}x${renderer.domElement.height} · dpr ${dpr} (${window.devicePixelRatio})` +
      (mem ? `\nheap JS ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : '');
  }

  dispose(): void {
    this.el?.remove();
    this.el = null;
  }
}
