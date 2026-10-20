import { AfterViewInit, Component, ElementRef, Input, NgZone, OnDestroy, ViewChild, inject } from '@angular/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFMaterialsSpecularGlossinessCompatExtension } from '../game/gltf-spec-gloss-compat';
import { CharacterAnimRig } from '../game/character-anim-rig';

const TARGET_HEIGHT_M = 1.8;
/** Vaivén en vez de giro completo: nunca da la espalda a cámara. */
const SWAY_AMPLITUDE_RAD = 0.35;
const SWAY_SPEED_BASE = 0.28;

/**
 * Vista 3D mínima para la pantalla de login: un solo personaje en idle, sin combate,
 * sin sync de red. Vive y muere con esta ruta (ver `ngOnDestroy`), así que nunca compite
 * por GPU con el canvas del juego, que recién se crea después de navegar a `/`.
 */
@Component({
  selector: 'app-hero-preview',
  standalone: true,
  template: `<div #host class="h-full w-full"></div>`,
})
export class HeroPreviewComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) modelUrl!: string;
  /** Cada export trae su propio "frente"; ajustar acá si un modelo arranca de espaldas. */
  @Input() initialYaw = 0;
  @ViewChild('host', { static: true }) private readonly hostRef!: ElementRef<HTMLDivElement>;

  private readonly zone = inject(NgZone);

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private modelRoot: THREE.Object3D | null = null;
  private rig: CharacterAnimRig | null = null;
  /** Assets con clips separados y nombrados (sorceress, witch_doctor…), a diferencia del
   * clip único concatenado del lizard: acá no aplican las ventanas de `CharacterAnimRig`. */
  private rawMixer: THREE.AnimationMixer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastT = 0;
  private elapsed = 0;
  private disposed = false;
  /** Random por instancia: así los 3 héroes no se mueven en espejo exacto. */
  private readonly swayPhase = Math.random() * Math.PI * 2;
  private readonly swaySpeed = SWAY_SPEED_BASE * (0.85 + Math.random() * 0.3);

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => this.setup());
  }

  private setup(): void {
    const host = this.hostRef.nativeElement;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    camera.position.set(0, 1.45, 4.3);
    camera.lookAt(0, 1.05, 0);

    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x14121a, 1.2));
    const key = new THREE.DirectionalLight(0xfff0d8, 1.7);
    key.position.set(2.2, 3.4, 2.6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 0.6);
    rim.position.set(-2.4, 1.8, -2.2);
    scene.add(rim);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    host.appendChild(renderer.domElement);

    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.resize();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);

    const loader = new GLTFLoader();
    loader.register((parser) => new GLTFMaterialsSpecularGlossinessCompatExtension(parser));
    loader.load(
      this.modelUrl,
      (gltf) => {
        if (this.disposed) {
          return;
        }
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        const scale = TARGET_HEIGHT_M / (size.y || 1);
        root.scale.setScalar(scale);
        const center = new THREE.Vector3();
        box.getCenter(center);
        root.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
        root.rotation.y = this.initialYaw;
        scene.add(root);
        this.modelRoot = root;

        const animations = gltf.animations;
        const namedIdle = animations.find((a) => /idle|stand/i.test(a.name));
        if (namedIdle && animations.length > 1) {
          // Convención estándar (clips separados): reproducir el idle propio del asset.
          const mixer = new THREE.AnimationMixer(root);
          mixer.clipAction(namedIdle).play();
          this.rawMixer = mixer;
        } else if (animations[0]) {
          // Convención del lizard: un único clip concatenado, recortado por ventana en segundos.
          this.rig = new CharacterAnimRig(root, animations[0]);
        }
        this.lastT = performance.now();
        this.loop();
      },
      undefined,
      () => {
        /** Sin modelo no hay preview, pero el login sigue funcionando igual. */
      },
    );
  }

  private readonly loop = (): void => {
    if (this.disposed) {
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden || !this.renderer || !this.scene || !this.camera) {
      return;
    }
    const now = performance.now();
    const dt = Math.min((now - this.lastT) / 1000, 0.1);
    this.lastT = now;
    this.elapsed += dt;
    this.rig?.update(dt);
    this.rawMixer?.update(dt);
    if (this.modelRoot) {
      const sway = Math.sin(this.elapsed * this.swaySpeed + this.swayPhase) * SWAY_AMPLITUDE_RAD;
      this.modelRoot.rotation.y = this.initialYaw + sway;
    }
    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    if (!this.renderer || !this.camera) {
      return;
    }
    const { clientWidth: w, clientHeight: h } = this.hostRef.nativeElement;
    if (!w || !h) {
      return;
    }
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  ngOnDestroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.rig?.dispose();
    this.rawMixer?.stopAllAction();
    this.scene?.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) {
        return;
      }
      mesh.geometry?.dispose();
      const material = mesh.material;
      for (const mat of Array.isArray(material) ? material : [material]) {
        for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
          if (value instanceof THREE.Texture) {
            value.dispose();
          }
        }
        mat.dispose();
      }
    });
    this.renderer?.dispose();
  }
}
