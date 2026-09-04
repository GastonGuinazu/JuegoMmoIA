import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NpcShopOffersList, NpcShopsConfigFile } from './npc-shops.types';

function configDir(): string {
  return join(__dirname, '..', '..', 'config');
}

let cache: NpcShopsConfigFile | null = null;

export function loadNpcShopsConfig(): NpcShopsConfigFile {
  if (cache) {
    return cache;
  }
  const raw = readFileSync(join(configDir(), 'npc-shops.json'), 'utf8');
  cache = JSON.parse(raw) as NpcShopsConfigFile;
  return cache;
}

export function getShopOffersForNpcTemplateKey(npcTemplateKey: string): NpcShopOffersList {
  const cfg = loadNpcShopsConfig();
  const shop = cfg.shops.find((s) => s.npcTemplateKey === npcTemplateKey);
  return shop?.offers ?? [];
}
