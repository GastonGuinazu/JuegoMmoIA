# Schema — Mobs AI (Aggro y Social Link)

Fuente de datos: `apps/server/config/mobs.json`.

## Objetivo

Definir comportamiento PvE data-driven de percepción y persecución de mobs para mantener autoridad total del servidor (The Warden) sobre aggro, asistencia social y movimiento.

## Estructura JSON (campos IA)

```json
{
  "templateKey": "spider",
  "level": 8,
  "socialFamily": "arachnid",
  "aggroRadius": 9,
  "socialLinkRadius": 8,
  "attackRange": 2.2,
  "baseMoveSpeed": 11,
  "chaseSpeed": 15.6,
  "dropTable": {
    "adenaRolls": [{ "chance": 1, "min": 15, "max": 55 }],
    "items": [{ "catalogKey": "spider_silk", "chance": 0.35, "minQty": 1, "maxQty": 2 }]
  }
}
```

## Campos

- `level`: nivel PvE autoritativo del mob para reglas de progresión y penalización de loot.
- `aggroRadius`: radio en unidades de mundo para detectar jugadores y entrar en estado `CHASE`.
- `socialLinkRadius`: radio de auxilio para alertar mobs cercanos cuando uno recibe daño.
- `socialFamily`: familia social opcional para asistencia cruzada entre templates (ej. `wolf_alpha` + `wolf_scout`).
- `baseMoveSpeed`: velocidad de patrulla / retorno al spawn (unidades/s). Player `baseWorldMoveSpeed` = 3.
- `chaseSpeed`: velocidad en `CHASE`. Set actual ≈ x2 del tuning previo (araña 15.6 vs player base 6): cierran en línea recta; el kite sigue siendo por obstáculos. El tick 20 Hz no se rompe (≈0.8 u por tick).
- `moveSpeed`: alias legacy de velocidad única; si no hay `baseMoveSpeed`/`chaseSpeed`, el runtime lo usa para ambos modos.
- `attackRange`: alcance melee del mob para validar golpe. Cuerpos grandes (ogro 3.8, dragonkin 4.8) deben cubrir el AABB visual, no sólo el origen.
- `meleeCooldownMs`: GCD melee mob→jugador. Si falta, `combat-timing.json` (`mobMeleeCooldownMs`, default 900).
- `meleeHitDelayMs`: ms entre telegraph del clip y el daño. 0 = inmediato. Ogro 300 / dragonkin 280 para alinear el contacto con el swing. Ogro y dragonkin: `meleeCooldownMs` 1000 (~1 golpe/s).
- `dropTable`: tabla data-driven de Adena e ítems (por `catalogKey`) usada por el Warden/Ledger al morir el mob.

## Compatibilidad y defaults

- `aggroRadius` reemplaza a `aggroRange` como nombre preferido.
- Si falta `aggroRadius`, el runtime usa `aggroRange` para compatibilidad legacy.
- Si falta `level`, el runtime asume nivel 1 para mantener compatibilidad.
- Si falta `socialLinkRadius`, el runtime usa default de producto (8m, acotado a 5-10m).
- Si falta `socialFamily`, el Social Link filtra por mismo template (`templateId`/`templateKey`).
- Si falta `baseMoveSpeed`, el runtime usa `moveSpeed` y luego el valor persistido en DB.
- Si falta `chaseSpeed`, el runtime usa `moveSpeed` y luego el valor persistido en DB.
- Si falta `meleeCooldownMs`, el runtime usa `combat-timing.json` (`mobMeleeCooldownMs`, default 900 ms).
- Si falta `meleeHitDelayMs`, el daño cae en el mismo tick que el telegraph (0 ms).

## Reglas runtime

- Toda detección de proximidad ocurre en servidor a 20 TPS.
- El melee mob→jugador se intenta a 20 TPS; el GCD (`meleeCooldownMs`) y el telegraph (`meleeHitDelayMs`) viven en RAM.
- Un mob agredido puede pedir auxilio dentro de `socialLinkRadius` solo a aliados de la misma familia social o mismo template.
- Los aliados solo reaccionan si están en `IDLE` o `PATROL` y no tienen combate activo con otro jugador.
- La persecución en `CHASE` usa `chaseSpeed` y navegación por grilla evitando obstáculos de `map-objects.json`.
- Varios mobs sobre el mismo target no caminan al centro: se reparten en un anillo (`attackRange * mobChaseRingFactor`) y se empujan con `mobBodyRadiusMeters` (world-spatial.json).
- Posición de patrulla/chase vive en **RAM** y se emite por `mob-moved` a 20 TPS. Prisma no se actualiza en cada tick (un UPDATE por mob tumba el loop y el cliente ve hops). Flush de pose cada 2 s.
- La patrulla / retorno a spawn usa `baseMoveSpeed`.
- La resolución de loot sigue orden autoritativo: primero contribución de daño + penalización por nivel, luego instanciación de `WORLD_DROP`.
- Para `characterLevel - mobLevel > 10`, el loot económico del mob se anula (Adena e ítems = 0).

## Hunting grounds (layout)

Los `spawnSpots` de `mobs.json` siguen los cuadrantes de [09-zonas-y-portales.md](../blueprint/09-zonas-y-portales.md). No mezclar familias en el mismo círculo; goblin/goblin2 y zombie/zombie2 sí pueden solaparse (misma familia, niveles a ±2). El silver dragonkin es boss: `maxEntities: 1`, familia propia, spot al este de Zone_1 sin solapar packs.
