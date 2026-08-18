# 07 — Inventario recursivo, Paperdoll y sub-slots

**Agentes:** The Warden + The Ledger + The Weaver  
**Ámbito:** `apps/server` + `apps/client` + `libs/shared-types`

## Objetivo de diseño

Implementar un inventario tipo Lineage 2 con:

- **Paperdoll** top-level (slots visibles del personaje).
- **Equipamiento anidado recursivo** (ej: Pulsera -> Talismanes).
- **Cálculo autoritativo de stats** condicionado por cadena de ancestros equipada.

## Reglas de dominio

1. El cliente solo envía intención `EQUIP_ITEM { itemId, slot, parentItemId? }`.
2. El Warden valida:
   - ownership;
   - slot válido;
   - compatibilidad `parentSlotType` <-> `subSlotType`;
   - sin ciclos recursivos.
3. Si un ancestro deja de estar equipado, todos los beneficios de sus descendientes quedan inactivos.
4. Integridad anti-pérdida:
   - al desequipar un contenedor, su subárbol vuelve a mochila;
   - no se permite transición a `WORLD_DROP` de contenedor que todavía tenga hijos equipados.

## Modelo de datos (data-driven)

### ItemTemplate

- `hasSubSlots: boolean`
- `maxSubSlots: number`
- `subSlotType: string | null`
- `parentSlotType: string | null`

### ItemInstance

- `parentItemInstanceId: UUID | null`
- `parentSubSlotIndex: number | null`

## Pipeline de stats (Ripple Effect)

1. Construir bosque de equipados por `parentItemInstanceId`.
2. Tomar raíces (`parentItemInstanceId = null`).
3. Recorrer recursivamente cada raíz y agregar stats de nodo + síntesis + affixes.
4. Ignorar cualquier nodo cuyo ancestro no esté en estado equipado activo.

## Impact Analysis

- **Warden (`StatEngineService`)**: agrega agregación recursiva de equipo.
- **Ledger (`InventoryService`)**: persistencia de relaciones padre/hijo y mutaciones atómicas del subárbol.
- **Weaver (`InventoryPanel`)**: popovers de sub-slots, indicadores visuales de nested content y tooltip compuesto.
- **Shared types**: DTOs de inventario/socket ampliados para sub-items.

## QA mínimo obligatorio

- Equipar/desequipar pulsera activa/desactiva talismanes correctamente.
- Mover ítem entre sub-slots no duplica ni pierde instancias.
- Intento de `WORLD_DROP` sobre contenedor con hijos equipados devuelve error de integridad.

## Sistema de grados y penalización (Warden + Ledger + Weaver)

Los `ItemTemplate` incorporan `grade` con la escala:

- `None`
- `D`
- `C`
- `B`
- `A`
- `S`

### Tabla de validación de nivel (server-authoritative)

| Grade | Nivel mínimo para evitar penalización |
|-------|----------------------------------------|
| None | Sin restricción |
| D | 20 |
| C | 40 |
| B | 52 |
| A | Sin regla de penalización en v1 (reservado) |
| S | Sin regla de penalización en v1 (reservado) |

### Penalización por grado

Si el personaje equipa al menos un ítem con `grade` por encima del nivel permitido:

- `P.Atk` efectivo: `-50%` (multiplicador `0.5`)
- `Atk.Speed` efectivo: `-50%` (multiplicador `0.5`)

### Emisión de estado a cliente

El Warden emite `GRADE_PENALTY_STATUS { active: boolean }` al socket del personaje para permitir feedback visual en UI.

### Regla operativa

La validación de nivel vs `grade` se ejecuta en cada sincronización de stats de combate (`PlayerCombatRuntimeService.syncProgressionDrivenCombatState`) y en cada recálculo autoritativo de derivados (`StatEngineService.computeDerivedStats`).
