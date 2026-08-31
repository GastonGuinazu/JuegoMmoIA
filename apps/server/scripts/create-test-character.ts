/**
 * Uso: desde apps/server → `npx tsx scripts/create-test-character.ts`
 * Crea cuenta + personaje de prueba (no usar en producción).
 */
import { PrismaClient, CharacterClass } from '@prisma/client';
import { StatEngineService } from '../src/character/stat-engine.service';

const prisma = new PrismaClient();
const statEngine = new StatEngineService(prisma as never);

async function main(): Promise<void> {
  const acc = await prisma.account.create({ data: {} });

  const created = await prisma.character.create({
    data: {
      accountId: acc.id,
      name: 'ilovethecoco',
      level: 1,
      characterClass: CharacterClass.DARK_KNIGHT,
      statStr: 28,
      statAgi: 20,
      statVit: 25,
      statEne: 10,
      experience: 0,
      worldPosX: 0,
      worldPosY: 0,
      worldPosZ: 0,
      worldFacingYaw: 0,
      currentZoneId: 'default',
      currentHp: 100,
    },
  });

  await statEngine.recalculateAndPersistCharacter(created.id);

  await prisma.character.update({
    where: { id: created.id },
    data: { currentHp: 100 },
  });

  const row = await prisma.character.findUnique({
    where: { id: created.id },
    select: {
      id: true,
      name: true,
      level: true,
      worldPosX: true,
      worldPosY: true,
      worldPosZ: true,
      currentHp: true,
      accountId: true,
    },
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(row, null, 2));
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
