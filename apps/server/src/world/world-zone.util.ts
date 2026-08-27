import type { Prisma } from '@prisma/client';

/**
 * Zona canónica del overworld. `null` / `default` se tratan como la pradera inicial (Zone_0).
 */
export function normalizeZoneId(zoneId: string | null | undefined): string {
  if (zoneId === null || zoneId === undefined || zoneId === '' || zoneId === 'default') {
    return 'Zone_0';
  }
  return zoneId;
}

export function zonesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeZoneId(a) === normalizeZoneId(b);
}

export function prismaMobZoneFilter(zoneId: string): Prisma.MobInstanceWhereInput {
  const z = normalizeZoneId(zoneId);
  if (z === 'Zone_0') {
    return { OR: [{ zoneId: null }, { zoneId: 'default' }, { zoneId: 'Zone_0' }] };
  }
  return { zoneId: z };
}

export function prismaCharacterZoneFilter(zoneId: string): Prisma.CharacterWhereInput {
  const z = normalizeZoneId(zoneId);
  if (z === 'Zone_0') {
    return {
      OR: [{ currentZoneId: null }, { currentZoneId: 'default' }, { currentZoneId: 'Zone_0' }],
    };
  }
  return { currentZoneId: z };
}

export function prismaWorldDropZoneFilter(zoneId: string): Prisma.ItemInstanceWhereInput {
  const z = normalizeZoneId(zoneId);
  if (z === 'Zone_0') {
    return {
      OR: [
        { worldDropZoneId: null },
        { worldDropZoneId: 'default' },
        { worldDropZoneId: 'Zone_0' },
      ],
    };
  }
  return { worldDropZoneId: z };
}

export function prismaNpcZoneFilter(zoneId: string): Prisma.NpcInstanceWhereInput {
  const z = normalizeZoneId(zoneId);
  if (z === 'Zone_0') {
    return { OR: [{ zoneId: null }, { zoneId: 'default' }, { zoneId: 'Zone_0' }] };
  }
  return { zoneId: z };
}
