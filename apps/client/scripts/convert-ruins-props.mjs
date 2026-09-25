/**
 * Convierte el subset Ruins (OBJ+MTL) a .glb y lo fusiona en public/models/props/manifest.json.
 * Fuente: _raw/quaternius/ultimate-ruins-2021
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
const objDir = path.join(repoRoot, '_raw', 'quaternius', 'ultimate-ruins-2021', 'OBJ');
const outDir = path.join(__dirname, '..', 'public', 'models', 'props');

const SUBSET = [
  { key: 'column_round', obj: 'Column_Round.obj', zoneHint: 'plaza' },
  { key: 'column_square', obj: 'Column_Square.obj', zoneHint: 'plaza' },
  { key: 'column_short', obj: 'Column_Round_Short.obj', zoneHint: 'plaza' },
  { key: 'wall_broken', obj: 'Wall_Broken.obj', zoneHint: 'plaza' },
  { key: 'wall_half', obj: 'Wall_Half.obj', zoneHint: 'plaza' },
  { key: 'wall_overgrown', obj: 'Wall_Overgrown.obj', zoneHint: 'Zone_0' },
  { key: 'arch_round', obj: 'Arch_Round_RoundColumn.obj', zoneHint: 'portal' },
  { key: 'crate', obj: 'Crate.obj', zoneHint: 'plaza' },
  { key: 'cart', obj: 'Cart.obj', zoneHint: 'merchant' },
  { key: 'barrel', obj: 'Barrel.obj', zoneHint: 'merchant' },
  { key: 'chest', obj: 'Chest.obj', zoneHint: 'merchant' },
  { key: 'torch', obj: 'Torch.obj', zoneHint: 'merchant' },
  { key: 'pot', obj: 'Pot2.obj', zoneHint: 'merchant' },
  { key: 'floor_path', obj: 'Floor_Standard.obj', zoneHint: 'hunt-path' },
];

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
        name: m.name || 'Prop',
        color: m.color ? m.color.clone() : new THREE.Color(0x888888),
        roughness: 0.86,
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

async function convertOne(entry) {
  const objPath = path.join(objDir, entry.obj);
  const mtlPath = objPath.replace(/\.obj$/i, '.mtl');
  if (!fs.existsSync(objPath)) {
    throw new Error(`Falta OBJ: ${objPath}`);
  }
  const objText = fs.readFileSync(objPath, 'utf8');
  const objLoader = new OBJLoader();
  if (fs.existsSync(mtlPath)) {
    const mtlLoader = new MTLLoader();
    mtlLoader.setMaterialOptions({ ignoreZeroRGBs: true });
    const materials = mtlLoader.parse(fs.readFileSync(mtlPath, 'utf8'), '');
    materials.preload();
    objLoader.setMaterials(materials);
  }
  const group = objLoader.parse(objText);
  group.name = entry.key;
  toStandardMaterials(group);
  const glb = await exportGlb(group);
  fs.writeFileSync(path.join(outDir, `${entry.key}.glb`), glb);
  return { ...entry, file: `${entry.key}.glb`, bytes: glb.byteLength };
}

async function main() {
  if (!fs.existsSync(objDir)) {
    throw new Error(`No está el pack en ${objDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const converted = [];
  for (const entry of SUBSET) {
    const row = await convertOne(entry);
    converted.push(row);
    console.log(`ok ${row.key} (${row.bytes} bytes) <- ${row.obj}`);
  }
  const licenseSrc = path.join(objDir, '..', 'License.txt');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(outDir, 'LICENSE-quaternius-ruins.txt'));
  }
  const manifestPath = path.join(outDir, 'manifest.json');
  const prev = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { version: 1, props: [] };
  const byKey = new Map();
  for (const p of prev.props ?? []) {
    byKey.set(p.propTemplateKey, p);
  }
  for (const row of converted) {
    byKey.set(row.key, {
      propTemplateKey: row.key,
      file: `/models/props/${row.file}`,
      sourceObj: row.obj,
      zoneHint: row.zoneHint,
      pack: 'ruins',
    });
  }
  const next = {
    ...prev,
    version: 1,
    ruinsSource: 'Quaternius Ultimate Modular Ruins Pack (Aug 2021), CC0 1.0',
    ruinsSourceUrl: 'https://quaternius.com/packs/ultimatemodularruins.html',
    ruinsRawVendorDir: '_raw/quaternius/ultimate-ruins-2021',
    props: [...byKey.values()],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
