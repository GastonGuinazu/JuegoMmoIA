import { Injectable } from '@nestjs/common';
import { ItemInstanceLocation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loadItemsConfig } from './items-config.loaders';

export type StarterKitGrantResult = {
  /** Nombres de lo que se acaba de crear en el inventario. */
  granted: string[];
  /** Nombres saltados porque el personaje ya los tenía (inventario o equipados). */
  alreadyOwned: string[];
};

const STARTER_PREFIX = 'starter_';

/**
 * Arma/armadura/escudo iniciales (catalogKey `starter_*` en `config/items.json`): sin esto
 * un personaje recién creado no tiene nada equipable y no puede pelear. Vive en `items/` (no
 * en `character/` ni `inventory/`) a propósito: así tanto `CharacterService.createCharacter`
 * como el comando `/kit` del chat (`WorldGateway`) lo pueden inyectar sin crear un import
 * circular entre `CharacterModule` e `InventoryModule`.
 */
@Injectable()
export class StarterKitService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotente: a cada `starter_*` que el personaje todavía no tenga, se lo agrega al inventario. */
  async grantIfMissing(characterId: string): Promise<StarterKitGrantResult> {
    const cfg = loadItemsConfig();
    const starterEntries = cfg.items.filter((i) => i.catalogKey.startsWith(STARTER_PREFIX));
    const granted: string[] = [];
    const alreadyOwned: string[] = [];
    for (const entry of starterEntries) {
      const tpl = await this.prisma.itemTemplate.findUnique({
        where: { catalogKey: entry.catalogKey },
      });
      if (!tpl) {
        continue;
      }
      const existing = await this.prisma.itemInstance.findFirst({
        where: {
          ownerId: characterId,
          itemTemplateId: tpl.id,
          location: { in: [ItemInstanceLocation.INVENTORY, ItemInstanceLocation.EQUIPPED] },
        },
      });
      if (existing) {
        alreadyOwned.push(entry.name);
        continue;
      }
      await this.prisma.itemInstance.create({
        data: {
          ownerId: characterId,
          itemTemplateId: tpl.id,
          quantity: 1,
          location: ItemInstanceLocation.INVENTORY,
        },
      });
      granted.push(entry.name);
    }
    return { granted, alreadyOwned };
  }
}
