/**
 * Convierte el subset Nature (OBJ+MTL, sin texturas) a .glb en public/models/props.
 * Fuente: _raw/quaternius/ultimate-nature-2019 (fuera de public).
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
const objDir = path.join(repoRoot, '_raw', 'quaternius', 'ultimate-nature-2019', 'OBJ');
const outDir = path.join(__dirname, '..', 'public', 'models', 'props');

const SUBSET = [
  { key: 'tree_oak', obj: 'CommonTree_1.obj', zoneHint: 'Zone_0' },
  { key: 'tree_oak_b', obj: 'CommonTree_3.obj', zoneHint: 'Zone_0' },
  { key: 'tree_birch', obj: 'BirchTree_1.obj', zoneHint: 'Zone_0' },
  { key: 'rock', obj: 'Rock_1.obj', zoneHint: 'Zone_0' },
  { key: 'rock_b', obj: 'Rock_3.obj', zoneHint: 'Zone_0' },
  { key: 'stump', obj: 'TreeStump.obj', zoneHint: 'Zone_0' },
  { key: 'log', obj: 'WoodLog.obj', zoneHint: 'Zone_0' },
  { key: 'bush', obj: 'Bush_1.obj', zoneHint: 'Zone_0' },
  { key: 'bush_b', obj: 'Bush_2.obj', zoneHint: 'Zone_0' },
  { key: 'plant', obj: 'Plant_1.obj', zoneHint: 'Zone_0' },
  { key: 'pine_snow', obj: 'PineTree_Snow_1.obj', zoneHint: 'Zone_1' },
  { key: 'pine_snow_b', obj: 'PineTree_Snow_3.obj', zoneHint: 'Zone_1' },
  { key: 'rock_snow', obj: 'Rock_Snow_1.obj', zoneHint: 'Zone_1' },
  { key: 'stump_snow', obj: 'TreeStump_Snow.obj', zoneHint: 'Zone_1' },
  { key: 'tree_dead_snow', obj: 'Willow_Dead_Snow_1.obj', zoneHint: 'Zone_1' },
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
        reject(new Error('GLTFExporter no devolvió ArrayBuffer (¿binary:true?)'));
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
  const outFile = path.join(outDir, `${entry.key}.glb`);
  fs.writeFileSync(outFile, glb);
  return { ...entry, file: `${entry.key}.glb`, bytes: glb.byteLength };
}

async function main() {
  if (!fs.existsSync(objDir)) {
    throw new Error(`No está el pack en ${objDir}. ¿Se movió a _raw?`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const converted = [];
  const onlyKeys = new Set(process.argv.slice(2).filter((a) => !a.startsWith('-')));
  const subset = onlyKeys.size > 0 ? SUBSET.filter((e) => onlyKeys.has(e.key)) : SUBSET;
  if (onlyKeys.size > 0 && subset.length === 0) {
    throw new Error(`Ninguna clave coincide: ${[...onlyKeys].join(',')}`);
  }
  for (const entry of subset) {
    const row = await convertOne(entry);
    converted.push(row);
    console.log(`ok ${row.key} (${row.bytes} bytes) <- ${row.obj}`);
  }
  const licenseSrc = path.join(objDir, '..', 'License.txt');
  const licenseDst = path.join(outDir, 'LICENSE-quaternius.txt');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, licenseDst);
  }
  const manifestPath = path.join(outDir, 'manifest.json');
  let manifest = {
    version: 1,
    source: 'Quaternius Ultimate Nature Pack (Jun 2019), CC0 1.0',
    sourceUrl: 'https://quaternius.com/packs/ultimatenature.html',
    rawVendorDir: '_raw/quaternius/ultimate-nature-2019',
    props: [],
  };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.props)) {
      manifest.props = [];
    }
  }
  const byKey = new Map(manifest.props.map((p) => [p.propTemplateKey, p]));
  for (const row of converted) {
    byKey.set(row.key, {
      propTemplateKey: row.key,
      file: `/models/props/${row.file}`,
      sourceObj: row.obj,
      zoneHint: row.zoneHint,
    });
  }
  manifest.props = [...byKey.values()];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
