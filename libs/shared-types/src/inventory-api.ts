/**
 * Contratos HTTP Inventory / progreso (Weaver ↔ Ledger/Warden).
 */

export type InventoryItemRowDto = {
  id: string;
  itemTemplateId: string;
  name: string;
  catalogKey: string | null;
  icon: string;
  quantity: number;
  location: 'INVENTORY' | 'EQUIPPED' | string;
  gearSlot: string | null;
  baseSlot: string | null;
  synthesisLevel: number;
  /** Nivel visual +N (normalizado desde `synthesisLevel`). */
  plusLevel: number;
  grade: 'None' | 'D' | 'C' | 'B' | 'A' | 'S';
  /** Bonos de plantilla para tooltip (ej. `P.Atk: +10`). Ausente en respuestas legacy. */
  statLines?: string[];
  /** `baseStats.consumable` de la plantilla (Weaver: clic para usar). */
  consumable?: boolean;
  hasSubSlots?: boolean;
  maxSubSlots?: number;
  subSlotType?: string | null;
  parentSlotType?: string | null;
  parentItemInstanceId?: string | null;
  parentSubSlotIndex?: number | null;
  subItems?: {
    id: string;
    name: string;
    parentSubSlotIndex: number | null;
  }[];
};

export type CharacterSheetDto = {
  characterId: string;
  name: string;
  characterClass: string;
  level: number;
  experience: number;
  experienceRequiredForNext: number;
  availableStatPoints: number;
  /** Staff / QA: el servidor valida igual en comandos GM; el cliente solo oculta UI. */
  isAdmin: boolean;
  core: {
    str: number;
    agi: number;
    vit: number;
    ene: number;
  };
  derived: {
    pAtk: number;
    mAtk: number;
    pDef: number;
    atkSpeed: number;
    critRate: number;
    /** Ver `WsPlayerStatsUpdatePayload.derived.pvpSwingCooldownMs` en world-socket.ts. */
    pvpSwingCooldownMs: number;
  };
  vitals: {
    currentHp: number;
    maxHp: number;
  };
};

export type InventoryProgressResponseDto = {
  items: InventoryItemRowDto[];
  character: CharacterSheetDto;
  /** Adena total de la cuenta (wallet), como string decimal. */
  adena: string;
};

export type InventoryEquipResponseDto = {
  equippedItemId: string;
  gearSlot: string | null;
  displacedItemId: string | null;
  parentItemId?: string | null;
  parentSubSlotIndex?: number | null;
  character: CharacterSheetDto;
};

export type InventoryUnequipResponseDto = {
  unequippedItemId: string;
  previousGearSlot: string | null;
  character: CharacterSheetDto;
};
