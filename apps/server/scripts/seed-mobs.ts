/**
 * Uso: desde apps/server → `npx tsx scripts/seed-mobs.ts`
 * Lee config/mobs.json (spawnSpots), asegura MobTemplate y crea instancias por mancha.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { MobsConfigFile, SpawnSpotDefinition } from '../src/mob/mob-config.types';
import {
  assertSpawnSpotsSocialCoherence,
  resolvePersistedMobMoveSpeed,
} from '../src/mob/mob-config.loaders';

const prisma = new PrismaClient();

function loadMobsConfigFromDisk(): MobsConfigFile {
  const dir = join(__dirname, '..', 'config');
  const raw = readFileSync(join(dir, 'mobs.json'), 'utf8');
  return JSON.parse(raw) as MobsConfigFile;
}

function randomPointInSpotXZ(spot: SpawnSpotDefinition): { x: number; y: number; z: number } {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * spot.radius;
  return {
    x: spot.center.x + Math.cos(angle) * r,
    y: spot.center.y,
    z: spot.center.z + Math.sin(angle) * r,
  };
}

function upsertPayload(m: MobsConfigFile['mobs'][0]) {
  const expReward = m.baseExperience ?? m.expReward;
  if (typeof expReward !== 'number' || !Number.isFinite(expReward)) {
    throw new Error(`Mob ${m.templateKey}: missing baseExperience`);
  }
  const aggroRadius = m.aggroRadius ?? m.aggroRange ?? 10;
  return {
    displayName: m.displayName,
    maxHp: m.maxHp,
    pAtk: m.pAtk,
    pDef: m.pDef,
    mDef: m.mDef ?? 0,
    expReward: Math.floor(expReward),
    aggroRange: aggroRadius,
    moveSpeed: resolvePersistedMobMoveSpeed(m),
    attackRange: m.attackRange ?? 2.5,
    dropTable: m.dropTable as object,
  };
}

async function main(): Promise<void> {
  const cfg = loadMobsConfigFromDisk();
  assertSpawnSpotsSocialCoherence(cfg);
  const spots = cfg.spawnSpots ?? [];
  if (spots.length === 0) {
    throw new Error('mobs.json: spawnSpots[] vacío — configure al menos un SpawnSpot.');
  }

  await prisma.mobInstance.deleteMany({});
  const keepTemplateKeys = cfg.mobs.map((m) => m.templateKey);
  await prisma.mobTemplate.deleteMany({
    where: { templateKey: { notIn: keepTemplateKeys } },
  });

  let created = 0;
  for (const m of cfg.mobs) {
    await prisma.mobTemplate.upsert({
      where: { templateKey: m.templateKey },
      create: {
        templateKey: m.templateKey,
        ...upsertPayload(m),
      },
      update: upsertPayload(m),
    });
  }

  for (const spot of spots) {
    const t = await prisma.mobTemplate.findUnique({
      where: { templateKey: spot.templateKey },
    });
    if (!t) {
      throw new Error(`SpawnSpot ${spot.id}: template no encontrado ${spot.templateKey}`);
    }
    for (let i = 0; i < spot.maxEntities; i += 1) {
      const pos = randomPointInSpotXZ(spot);
      await prisma.mobInstance.create({
        data: {
          mobTemplateId: t.id,
          currentHp: t.maxHp,
          posX: pos.x,
          posY: pos.y,
          posZ: pos.z,
          spawnPosX: pos.x,
          spawnPosY: pos.y,
          spawnPosZ: pos.z,
          zoneId: spot.zoneId,
          isAlive: true,
        },
      });
      created += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        templates: cfg.mobs.length,
        spawnSpots: spots.length,
        instancesCreated: created,
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
