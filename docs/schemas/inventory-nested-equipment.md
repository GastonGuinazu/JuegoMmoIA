# Inventory Nested Equipment Schema

## Purpose

Define a recursive, server-authoritative inventory model where equipped items can contain other equipped items (example: bracelet -> talismans).

## Item Template Fields

- `baseSlot: GearSlot | null`
- `hasSubSlots: boolean`
- `maxSubSlots: number`
- `subSlotType: string | null` (type accepted inside this container, example `TALISMAN_SLOT`)
- `parentSlotType: string | null` (type required to be equipped as a child, example `TALISMAN_SLOT`)

## Test Kit (Sub-slot Ripple QA)

- `initiate_bracelet` -> "Pulsera de Aprendiz"
  - `baseSlot: BRACELET_1`
  - `hasSubSlots: true`
  - `maxSubSlots: 4`
  - `subSlotType: TALISMAN_SLOT`
- `initiate_talisman_power` -> "Talismán de Fuerza"
  - `parentSlotType: TALISMAN_SLOT`
  - `baseStats: { "str": 10 }`
- `initiate_talisman_swiftness` -> "Talismán de Rapidez"
  - `parentSlotType: TALISMAN_SLOT`
  - `baseStats: { "agi": 15 }`

## Item Instance Fields

- `location: ItemInstanceLocation`
- `gearSlot: GearSlot | null` (paperdoll slot for top-level equipment)
- `parentItemInstanceId: UUID | null` (self-reference to equipped parent item)
- `parentSubSlotIndex: number | null` (slot index inside parent, zero-based)

## Invariants

1. Top-level equipped item:
   - `location = EQUIPPED`
   - `gearSlot != null`
   - `parentItemInstanceId = null`
2. Nested equipped item:
   - `location = EQUIPPED`
   - `gearSlot = null`
   - `parentItemInstanceId != null`
   - `parentSubSlotIndex >= 0`
3. Parent compatibility:
   - Parent item template has `hasSubSlots = true`
   - `0 <= parentSubSlotIndex < parent.maxSubSlots`
   - Child `parentSlotType` equals parent `subSlotType`
4. Uniqueness:
   - For a given parent item, one child per `parentSubSlotIndex`.
5. Recursive stat rule:
   - Child stats are active only if every ancestor in the chain remains equipped.

## Network Intent (Warden)

`EQUIP_ITEM { itemId, slot, parentItemId? }`

- If `parentItemId` is omitted, `slot` targets a paperdoll `GearSlot`.
- If `parentItemId` is present, `slot` targets the parent sub-slot index.
