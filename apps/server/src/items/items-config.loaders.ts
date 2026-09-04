import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemsConfigFile } from './items-config.types';

function configDir(): string {
  return join(__dirname, '..', '..', 'config');
}

let cache: ItemsConfigFile | null = null;

export function loadItemsConfig(): ItemsConfigFile {
  if (cache) {
    return cache;
  }
  const raw = readFileSync(join(configDir(), 'items.json'), 'utf8');
  cache = JSON.parse(raw) as ItemsConfigFile;
  return cache;
}
