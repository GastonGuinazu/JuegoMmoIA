/** Orden de visualización de slots de equipo (coincide con enum Prisma `GearSlot`). */
export const EQUIP_SLOT_ORDER: string[] = [
  'HELM',
  'CLOAK',
  'ARMOR',
  'PANTS',
  'GLOVES',
  'BOOTS',
  'WEAPON',
  'SHIELD',
  'WINGS',
  'BRACELET_1',
  'BRACELET_2',
  'PENDANT',
  'RING_1',
  'RING_2',
  'EARRING_1',
  'EARRING_2',
];

export const GEAR_SLOT_LABELS: Record<string, string> = {
  HELM: 'Casco',
  CLOAK: 'Capa',
  ARMOR: 'Pechera',
  PANTS: 'Pantalones',
  GLOVES: 'Guantes',
  BOOTS: 'Botas',
  WEAPON: 'Arma',
  SHIELD: 'Escudo',
  WINGS: 'Alas',
  BRACELET_1: 'Pulsera I',
  BRACELET_2: 'Pulsera II',
  PENDANT: 'Amuleto',
  RING_1: 'Anillo I',
  RING_2: 'Anillo II',
  EARRING_1: 'Aro I',
  EARRING_2: 'Aro II',
};

export const INVENTORY_SLOT_COUNT = 30;
export const INVENTORY_GRID_COLS = 6;

export type PaperdollSlotLayout = {
  slot: string;
  x: number;
  y: number;
};

export const PAPERDOLL_LAYOUT: PaperdollSlotLayout[] = [
  { slot: 'HELM', x: 2, y: 0 },
  { slot: 'CLOAK', x: 3, y: 0 },
  { slot: 'WEAPON', x: 0, y: 1 },
  { slot: 'ARMOR', x: 2, y: 1 },
  { slot: 'SHIELD', x: 4, y: 1 },
  { slot: 'GLOVES', x: 1, y: 2 },
  { slot: 'PANTS', x: 2, y: 2 },
  { slot: 'BOOTS', x: 2, y: 3 },
  { slot: 'WINGS', x: 4, y: 3 },
  { slot: 'BRACELET_1', x: 0, y: 4 },
  { slot: 'BRACELET_2', x: 4, y: 4 },
  { slot: 'EARRING_1', x: 1, y: 5 },
  { slot: 'PENDANT', x: 2, y: 5 },
  { slot: 'EARRING_2', x: 3, y: 5 },
  { slot: 'RING_1', x: 1, y: 6 },
  { slot: 'RING_2', x: 3, y: 6 },
];
