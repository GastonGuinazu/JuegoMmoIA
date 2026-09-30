# Plan de avances para la cátedra

Remote del trabajo: https://github.com/GastonGuinazu/JuegoMmoIA.git

El árbol de trabajo en disco ya incluye sistemas más nuevos que el historial. Cada avance suma **solo** los archivos de esa oleada. El resto queda para el hito siguiente. No agregar el árbol completo de una vez.

Un checkout viejo puede no abrir el cliente. El último snapshot es el juego completo. Las fechas son las del día del avance. No reescribir `main`.

## Cómo pedir el siguiente hito

Decir: `hacé el avance A1` (u otro id de la tabla). Entonces:

1. Leer esta tabla y tomar el pendiente que sigue.
2. Incluir únicamente los paths de esa oleada (y docs que se hayan tocado).
3. Crear el snapshot y publicarlo en `origin` si el remote ya está.
4. Marcar el hito como `hecho` en esta tabla.

No versionar secretos (`.env`), `node_modules`, `dist` ni el dump `_raw/quaternius`.

## Hitos

| Id | Estado | Título | Qué entra (criterio) |
|----|--------|--------|----------------------|
| A0 | hecho | Agentes y blueprint | `Agent.md`, `.cursorrules`, `docs/agents`, `docs/blueprint`, `docs/schemas`, este plan, README, ignore de git |
| A1 | hecho | Terreno base | Monorepo Nest + Angular + Three: piso 128 m, cámara, click-to-move, `world-zones.json`. Sin combate ni mobs. |
| A2 | hecho | Entidades cubo | Personaje, otros jugadores y mobs/NPC en primitivas + sync socket. |
| A3 | hecho | Combate autoritativo | Ticks 20 TPS, melee, skills, validación Warden. |
| A4 | hecho | Inventario y economía | Paperdoll, Adena, tienda básica / catálogo. |
| A5 | hecho | Zonas, portales y spots | Zonas segregadas, portales, SpawnSpots, IA de mobs. |
| A6 | hecho | Modelo de personaje | Asset del jugador (reemplazo del dummy). |
| A7 | hecho | Modelos de mobs | Catálogo visual de mobs. |
| A8 | hecho | Props de entorno | Nature + Ruins (árboles, ruinas, albedo). |
| A9 | hecho | Mercader y senderos | Puesto del NPC, losetas a cuadrantes de caza. |
| A10 | hecho | Cierre | Síntesis UI, karma y comandos GM. Mazmorras diarias quedan fuera (sin stub); ver `docs/blueprint/06-mazmorras-diarias-cartographer.md` para cuando se retomen. |

## A0 — archivos de esta oleada

- ignore de git, `README.md`, `Agent.md`, `.cursorrules`
- `docs/agents/**`, `docs/blueprint/**`, `docs/schemas/**`, `docs/avances/**`
- `.cursor/rules/avances-git.mdc`

## A1 — archivos de esta oleada

Scaffold Nest + Angular + `libs/shared-types`. Piso, cámara y click-to-move. Sin `combat/` (salvo el loader espacial), `mob/`, inventario, UI de progreso, `map-objects`, ni GLTF de personajes/mobs/props.

- `apps/client` scaffold (`package.json`, Angular/tsconfig, `src/app/*` bootstrap, `public/favicon.ico`)
- `apps/client/src/app/game/game-viewport.component.*`, `entity-visual-factory.service.ts`, `world-map-loader.service.ts`
- `apps/client/src/app/core/world-socket.service.ts`, `player-character-state.service.ts`
- `apps/client/public/models/textures/ground_grass_0.jpg`
- `apps/server` scaffold (`package.json`, Nest/tsconfig, `src/main.ts`, `src/app.module.ts`, `.env.example`)
- `apps/server/prisma/schema.prisma`, `src/prisma/**`
- `apps/server/config/world-zones.json`, `world-spatial.json`
- `apps/server/src/world/world.module.ts`, `world.gateway.ts`, `world-socket.module.ts`, `world-spatial.service.ts`, `world-zone.util.ts`, `world-presence.service.ts`, `world-socket-bridge.service.ts`, `config/world-zones.loaders.ts`
- `apps/server/src/combat/combat-config.loaders.ts` (carga spatial/zonas; el resto de combate queda afuera)
- `apps/server/src/character/**`
- `libs/shared-types/**`

## A2 — archivos de esta oleada

Cubos de jugador / otros jugadores / mobs / NPC y snapshot de zona por socket. Sin ticks de combate, IA de persecución, inventario, portales ni GLTF.

- `apps/client/src/app/game/world-entity-sync.service.ts`
- `apps/server/src/mob/mob.module.ts`, `mob.service.ts`, `mob-config.loaders.ts`, `mob-config.types.ts`, `mob-spawn-bootstrap.service.ts`
- `apps/server/config/mobs.json`
- `apps/server/config/character-classes.json`, `character-vitals.json`, `stat-derivation.json`, `experience-curve.json`
- `apps/server/scripts/seed-mobs.ts`, `create-test-character.ts`

## A3 — archivos de esta oleada

Ticks 20 TPS, melee, skills y ciclo de muerte/respawn PvE. Sin inventario, tienda, karma, IA de persecución ni GLTF.

- `apps/server/src/combat/combat.module.ts`, `combat.service.ts`, `combat-timing.loaders.ts`, `pve-melee-damage.util.ts`
- `apps/server/src/combat/player-combat-runtime.service.ts`, `player-combat-tick.service.ts`, `mob-combat-tick.service.ts`, `damage-contribution-tracker.service.ts`
- `apps/server/src/mob/mob-combat-regen.service.ts`
- `apps/server/src/world/mob-respawn.service.ts`, `config/world-spawn.loaders.ts`
- `apps/server/config/combat-damage.json`, `combat-timing.json`, `skills.json`, `world-spawn.json`
- `apps/client/src/app/game/world-combat-floaters.ts`
- `apps/client/src/app/ui/progress/player-hp-bar.component.*`, `target-frame.component.*`, `xp-bar.component.*`

## A4 — archivos de esta oleada

Paperdoll, Adena, catálogo de ítems, drops al suelo y tienda NPC básica. Sin síntesis UI, karma, portales, IA ni el puesto visual del mercader (A9).

- `apps/server/src/inventory/**`, `apps/server/src/items/**`, `apps/server/src/ledger/**`, `apps/server/src/idempotency/**`
- `apps/server/src/world/npc-shop.service.ts`, `npc-shops.loaders.ts`, `npc-shops.types.ts`
- `apps/server/src/world/world-drop.service.ts`, `pending-world-drop.service.ts`
- `apps/server/config/items.json`, `equipment-presets.json`, `npc-shops.json`
- `apps/server/scripts/give-starter-items.ts`
- `apps/client/src/app/core/inventory-api.service.ts`, `npc-shop-ui.service.ts`
- `apps/client/src/app/ui/progress/inventory-panel.component.*`, `character-sheet-panel.component.*`, `gear-slots.ts`
- `apps/client/src/app/ui/progress/npc-shop-panel.component.*`, `system-log-panel.component.*`

## A5 — archivos de esta oleada

Zonas con `map-objects`, portales, SpawnSpots e IA de persecución. Sin GLTF de personaje/mobs/props, albedo de nieve, síntesis ni karma.

- `apps/server/config/map-objects-Zone_0.json`, `map-objects-Zone_1.json`
- `apps/server/src/mob/mob-ai-tick.service.ts`
- `apps/client/src/app/game/mob-visual-interp.ts`
- `docs/blueprint/09-zonas-y-portales.md`, `docs/schemas/map-objects.md`, `docs/schemas/mobs-ai.md`, `docs/agents/the_cartographer.md`

## A6 — archivos de esta oleada

Modelo `.gltf` del jugador (lizard + espadón) y rig de animación. Sin catálogo de mobs, props, NPC trader, síntesis ni karma.

- `apps/client/public/models/characters/lizard_man_warrior/**`, `espadon_warrior/**`
- `apps/client/src/app/game/character-anim-rig.ts`
- `apps/client/src/app/game/gltf-spec-gloss-compat.ts`

## A7 — archivos de esta oleada

Catálogo `.gltf` de mobs y `MobAnimRig`. Sin props, albedo de nieve, NPC trader, síntesis ni karma.

- `apps/client/public/models/mobs/**`
- `apps/client/src/app/game/mob-visual-catalog.ts`
- `apps/client/src/app/game/mob-anim-rig.ts`

## A8 — archivos de esta oleada

Subset CC0 de Nature + Ruins (`.glb` estáticos), su catálogo visual y los albedos de zona. Sin NPC trader/cofre, síntesis ni karma.

- `apps/client/public/models/props/**`
- `apps/client/src/app/game/prop-visual-catalog.ts`
- `apps/client/public/models/textures/ground_grass_0B.jpg`, `ground_snow_1.jpg`
- `docs/agents/the_weaver.md`

## A9 — archivos de esta oleada

Skin GLTF del NPC mercader (trader + cofre compañero con clip `Opening`) y su catálogo visual. Sin síntesis UI, karma ni GM.

- `apps/client/public/models/npcs/**`
- `apps/client/src/app/game/npc-visual-catalog.ts`
- `apps/client/scripts/convert-npc-merchant.mjs`
- `docs/blueprint/08-mercaderes-ledger.md`

## A10 — archivos de esta oleada

Síntesis 2×1 con UI, karma/penalizaciones y comandos GM locales. Mazmorras diarias no entran en esta oleada (sin stub); quedan para un hito futuro si se retoman.

- `apps/client/src/app/ui/progress/synthesis.component.*`
- `apps/server/config/karma-rules.json`, `synthesis-equipment-bonuses.json`, `synthesis-tiers.json`
- `apps/server/src/combat/penalty-config.loaders.ts`, `penalty-manager.service.ts`
- `apps/server/src/gm/**`
- `apps/server/src/synthesis/**`
