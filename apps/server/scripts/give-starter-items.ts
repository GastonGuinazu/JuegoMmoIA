/**
 * Uso (desde apps/server):
 *   npx tsx scripts/give-starter-items.ts <characterId>
 *   o CHARACTER_ID=<uuid> npx tsx scripts/give-starter-items.ts
 *   (el UUID del personaje es el primer argumento después del script)
 *
 * Asegura plantillas desde `config/items.json` y crea una instancia en INVENTORY
 * por cada entrada starter_* si el personaje aún no tiene una en mochila.
 */
import { ItemInstanceLocation, PrismaClient } from '@prisma/client';
import { upsertItemTemplatesFromConfig } from '../src/items/item-catalog-upsert';
import { loadItemsConfig } from '../src/items/items-config.loaders';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const characterId = process.argv[2] ?? process.env.CHARACTER_ID;
  if (!characterId || characterId.trim().length === 0) {
    throw new Error('Missing characterId (argv[1]) or CHARACTER_ID env');
  }

  const ch = await prisma.character.findUnique({ where: { id: characterId } });
  if (!ch) {
    throw new Error(`Character not found: ${characterId}`);
  }

  const synced = await upsertItemTemplatesFromConfig(prisma);
  const cfg = loadItemsConfig();

  const created: string[] = [];
  const skipped: string[] = [];

  for (const entry of cfg.items) {
    const tpl = await prisma.itemTemplate.findUnique({
      where: { catalogKey: entry.catalogKey },
    });
    if (!tpl) {
      continue;
    }
    const existing = await prisma.itemInstance.findFirst({
      where: {
        ownerId: characterId,
        itemTemplateId: tpl.id,
        location: ItemInstanceLocation.INVENTORY,
        quantity: 1,
      },
    });
    if (existing) {
      skipped.push(entry.catalogKey);
      continue;
    }
    const row = await prisma.itemInstance.create({
      data: {
        ownerId: characterId,
        itemTemplateId: tpl.id,
        quantity: 1,
        location: ItemInstanceLocation.INVENTORY,
      },
    });
    created.push(`${entry.catalogKey} → ${row.id}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        characterId,
        templatesUpserted: synced,
        instancesCreated: created,
        skippedAlreadyInBag: skipped,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
