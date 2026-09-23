/**
 * Convierte Character_Animated.obj (Ruins, CC0) a public/models/npcs/merchant.glb.
 * Pose estática: el FBX animado no se sirve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    result = null;
    onloadend = null;
    onload = null;
    onerror = null;
    readAsArrayBuffer(blob) {
      Promise.resolve(blob.arrayBuffer())
        .then((buf) => {
          this.result = buf;
          const ev = { target: this };
          this.onload?.(ev);
          this.onloadend?.(ev);
        })
        .catch((err) => {
          this.onerror?.(err);
          this.onloadend?.({ target: this });
        });
    }
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const objPath = path.join(
  repoRoot,
  '_raw',
  'quaternius',
  'ultimate-ruins-2021',
  'OBJ',
  'Character_Animated.obj',
);
const outDir = path.join(__dirname, '..', 'public', 'models', 'npcs');

function exportGlb(root) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(Buffer.from(result));
          return;
        }
        reject(new Error('GLTFExporter no devolvió ArrayBuffer'));
      },
      (err) => reject(err),
      { binary: true, onlyVisible: true },
    );
  });
}

function toStandardMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) {
      return;
    }
    child.castShadow = true;
    child.receiveShadow = true;
    const src = child.material;
    if (!src) {
      return;
    }
    const mats = Array.isArray(src) ? src : [src];
    const next = mats.map((m) => {
      const std = new THREE.MeshStandardMaterial({
        name: m.name || 'Npc',
        color: m.color ? m.color.clone() : new THREE.Color(0x888888),
        roughness: 0.78,
        metalness: 0.04,
        transparent: m.transparent === true,
        opacity: typeof m.opacity === 'number' ? m.opacity : 1,
        side: THREE.FrontSide,
      });
      m.dispose?.();
      return std;
    });
    child.material = Array.isArray(src) ? next : next[0];
  });
}

async function main() {
  if (!fs.existsSync(objPath)) {
    throw new Error(`Falta OBJ: ${objPath}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const mtlPath = objPath.replace(/\.obj$/i, '.mtl');
  const objLoader = new OBJLoader();
  if (fs.existsSync(mtlPath)) {
    const mtlLoader = new MTLLoader();
    mtlLoader.setMaterialOptions({ ignoreZeroRGBs: true });
    const materials = mtlLoader.parse(fs.readFileSync(mtlPath, 'utf8'), '');
    materials.preload();
    objLoader.setMaterials(materials);
  }
  const group = objLoader.parse(fs.readFileSync(objPath, 'utf8'));
  group.name = 'merchant';
  toStandardMaterials(group);
  const glb = await exportGlb(group);
  fs.writeFileSync(path.join(outDir, 'merchant.glb'), glb);
  const licenseSrc = path.join(path.dirname(objPath), '..', 'License.txt');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(outDir, 'LICENSE-quaternius-ruins.txt'));
  }
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(
      {
        version: 1,
        source: 'Quaternius Ultimate Modular Ruins Pack (Aug 2021), CC0 1.0',
        sourceUrl: 'https://quaternius.com/packs/ultimatemodularruins.html',
        rawVendorDir: '_raw/quaternius/ultimate-ruins-2021',
        npcs: [
          {
            npcTemplateKey: 'merchant_aetheris',
            file: '/models/npcs/merchant.glb',
            sourceObj: 'Character_Animated.obj',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  console.log(`ok merchant.glb (${glb.byteLength} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
