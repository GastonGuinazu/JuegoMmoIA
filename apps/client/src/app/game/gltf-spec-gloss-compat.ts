import * as THREE from 'three';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Compatibilidad mínima para `KHR_materials_pbrSpecularGlossiness`.
 *
 * Three.js quitó el soporte nativo de este extension (deprecado por Khronos en favor del
 * workflow metallic-roughness) hace varias versiones. Varios assets de stock (Sketchfab,
 * exports viejos de Substance/Marmoset) siguen usándolo, así que en vez de reconvertir el
 * `.gltf` offline (requiere `@gltf-transform/cli` + reescritura de texturas) aproximamos los
 * valores spec/gloss a un `MeshStandardMaterial` estándar:
 *  - `diffuseFactor`/`diffuseTexture` → `color`/`map` (color base, sin cambios).
 *  - `glossinessFactor` → `roughness = 1 - glossiness` (sin soporte de textura de glossiness:
 *    el mapa combinado specular+glossiness no es válido como `roughnessMap` sin invertirlo por
 *    píxel, y ese post-proceso no vale la pena para un modelo intermedio).
 *  - `metalness` fijo en un valor bajo: el workflow spec/gloss casi siempre modela dieléctricos.
 *
 * No se implementa `getMaterialType` a propósito: dejamos que el parser caiga en su default
 * (`MeshStandardMaterial`) en vez de sub-clasear y parchear shaders a mano, que es fresco a
 * romperse en cada bump de three.js (el helper GLSL `sRGBToLinear` y los campos del struct
 * `PhysicalMaterial` que usaba la extensión original ya no existen en three 0.183).
 */
export class GLTFMaterialsSpecularGlossinessCompatExtension implements GLTFLoaderPlugin {
  readonly name = 'KHR_materials_pbrSpecularGlossiness';

  constructor(private readonly parser: GLTFParser) {}

  extendMaterialParams(
    materialIndex: number,
    materialParams: Record<string, unknown>,
  ): Promise<unknown> | null {
    const materialDef = this.parser.json.materials?.[materialIndex];
    const extension = materialDef?.extensions?.[this.name];
    if (!extension) {
      return null;
    }

    const pending: Promise<unknown>[] = [];

    const color = new THREE.Color(1, 1, 1);
    let opacity = 1;
    if (Array.isArray(extension.diffuseFactor)) {
      const [r, g, b, a] = extension.diffuseFactor;
      color.setRGB(r, g, b, THREE.SRGBColorSpace);
      if (typeof a === 'number') {
        opacity = a;
      }
    }
    materialParams['color'] = color;
    materialParams['opacity'] = opacity;

    if (extension.diffuseTexture !== undefined) {
      pending.push(
        this.parser.assignTexture(
          materialParams,
          'map',
          extension.diffuseTexture,
          THREE.SRGBColorSpace,
        ),
      );
    }

    const glossiness =
      typeof extension.glossinessFactor === 'number' ? extension.glossinessFactor : 1;
    materialParams['roughness'] = THREE.MathUtils.clamp(1 - glossiness, 0.05, 1);
    materialParams['metalness'] = 0.05;

    return Promise.all(pending);
  }
}
