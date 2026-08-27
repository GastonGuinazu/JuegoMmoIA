import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ExperienceCurveConfigFile {
  version: number;
  maxLevel: number;
  statPointsPerLevel?: number;
  xpFormula?: {
    base: number;
    exponent: number;
    levelScalar?: number;
  };
  /** % de la barra actual de EXP perdida al morir por PvE (Warden). */
  deathExperienceLossPercent?: number;
  /** @deprecated La curva vive en StatEngineService (100 × nivel^1.5). */
  baseExpToLevel2?: number;
  /** @deprecated */
  perLevelStep?: number;
}

function configDir(): string {
  return join(__dirname, '..', '..', '..', 'config');
}

let cache: ExperienceCurveConfigFile | null = null;

export function loadExperienceCurveConfig(): ExperienceCurveConfigFile {
  if (!cache) {
    const raw = readFileSync(
      join(configDir(), 'experience-curve.json'),
      'utf8',
    );
    cache = JSON.parse(raw) as ExperienceCurveConfigFile;
  }
  return cache;
}

export function resetExperienceConfigCache(): void {
  cache = null;
}
