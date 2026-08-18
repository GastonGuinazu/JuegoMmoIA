# 09 — Zonas segregadas y portales (Cartographer / Warden / Weaver)

## Objetivo

- **Cartographer:** mundo partido en zonas con `map-objects` propios y spawns por **SpawnSpots** (sin dispersión masiva aleatoria).
- **Warden:** validación de rango al portal, requisito de nivel por zona, tick de IA de mobs solo donde hay jugadores (salvo aggro activo).
- **Weaver:** picking de portal con clic derecho, mensaje en log, fade de transición **sólo en rango** (`interactionRadiusMeters`); mapas cargados desde `world-zones.json`. El hueco del arco lleva velo cian + point light (señal de viaje, sin cambiar colisión).

## SSOT de datos

| Archivo | Rol |
|---------|-----|
| `apps/server/config/world-zones.json` | Lista de zonas: `zoneId`, `displayName`, `minCharacterLevel`, `mapObjectsFile`, `entrySpawn`, `groundAlbedo`, `groundSizeMeters` (piso jugable; default **128**). **Única fuente de coordenadas de reaparición.** |
| `apps/server/config/map-objects-Zone_*.json` | Obstáculos (`kind: box`) y portales (`kind: portal`). Visual: `propTemplateKey` + `yaw`. Colisión: AABB `position`/`scale`. `blocksMovement: false` = deco caminable (losetas de sendero): el Warden y el navgrid las ignoran. |
| `apps/server/config/mobs.json` | `spawnSpots[]`: `id`, `zoneId`, `center`, `radius`, `templateKey`, `maxEntities`; `respawnSweepIntervalMs`. |
| `apps/server/config/world-spawn.json` | Política de muerte: `deathRespawn.respawnInDeathZone`, `fallbackZoneId`, `hpPercentOfMax`. **Sin coordenadas.** |

## Reglas de oro

1. **SpawnSpot:** un spot usa un solo `templateKey` → misma plantilla, misma `socialFamily` y nivel; entre spots que **se solapan** en XZ (círculos `center`+`radius`), el servidor valida misma familia social y niveles a **±2** (arranque / `seed-mobs`).
2. **Zona canónica:** `null`, `''`, `default` se normalizan a **`Zone_0`** (Pradera del Novicio) en servidor y cliente.
3. **Portal:** el cliente envía `PORTAL_TRAVEL` con `portalId`; el Warden exige distancia ≤ `interactionRadiusMeters` (o 4 m por defecto) y `character.level >= minCharacterLevel` de la zona destino (p. ej. **Zone_1 = 15** para no bloquear progresión respecto al mob máx. ~13 de Zone_0); si no, `PORTAL_TRAVEL_DENIED` con mensaje **`Nivel insuficiente para esta zona`** (código `LEVEL_TOO_LOW`).
4. **Post-portal:** `ZONE_SNAPSHOT` + aviso `PLAYER_MOVED` en la sala nueva; la sala vieja recibe `PLAYER_LEFT_ZONE`.
5. **Respawn por muerte:** las coordenadas salen **siempre** del `entrySpawn` de una zona de `world-zones.json`; `world-spawn.json` sólo elige **qué** zona y con cuánta vida. Si la zona de muerte no existe en config, cae a `fallbackZoneId`.
6. **Zona y posición atómicas:** al resucitar, `currentZoneId` y las coordenadas se escriben en la **misma** actualización, de modo que no pueden divergir.

## Ciclo de muerte y reaparición (Warden)

Dos fases, nunca una sola:

| Fase | Qué hace el servidor | Estado del personaje |
|------|----------------------|----------------------|
| **Muerte** | Penaliza EXP, pone `currentHp = 0`, limpia aggro y emite `player-death` a la sala. **No mueve al personaje.** | Muerto, en el punto de caída. `currentHp <= 0` es el único predicado de muerte. |
| **Reaparición** | Sólo tras `request-respawn` del cliente: migra `currentZoneId` + posición al `entrySpawn` y restaura `hpPercentOfMax`. | Vivo en la zona destino. |

Mientras está muerto, el Warden rechaza movimiento (`PLAYER_POSITION_CORRECTED` con `CHARACTER_DEAD`), ataques, skills, fijar objetivo y portales. La regeneración fuera de combate **no** cura cadáveres y reconectarse tampoco resucita: el cliente recibe otra vez `player-death`.

## Hunting grounds (cuadrantes)

Cada zona abierta se parte en **cuatro cuadrantes XZ** alrededor de una plaza central (origen). Los ejes `x = 0` y `z = 0` quedan como corredores (hueco para estructuras futuras). Un SpawnSpot no cruza de cuadrante: packs del mismo tipo, sin “sopa” de templates.

El **piso jugable** (`groundSizeMeters`, v1 = **128**) cubre esos cuadrantes (±32) y el boss de Zone_1 (x=48) con ~16 m de margen. No comprimir los packs hacia el origen: más GLTF en el mismo frustum empeora los picos de lag. El vacío de 256×256 era click-to-move a ninguna parte, no contenido.

Convención de ejes: **+X este**, **+Z sur** (yaw 0 del Warden mira +Z).

Losetas `floor_path` marcan el corredor de plaza → pack. Van sobre los ejes y un codo en L hacia cada cuadrante; se cortan **antes** del centro del SpawnSpot. El portal este de Zone_0 (14, 0) rompe el eje +X: el sendero salta 12–16. Zone_1 suma un brazo hacia el boss hasta x=40 (el spawn está en 48, 0).

### Zone_0 — Pradera del Novicio (lvl 1–15)

Plaza y portales en el origen. El jugador elige el farm; no hace falta atravesar el pack más alto para salir.

| Cuadrante | Centro aprox. | Spot(s) | Niveles | Rol |
|-----------|---------------|---------|---------|-----|
| SO | (−32, +32) | cubos | 4 | Tutorial, junto a la plaza |
| NO | (−32, −32) | goblin + goblin2 (misma `socialFamily`, ±2) | 6 / 8 | Primer grind mixto |
| SE | (+32, +32) | arañas | 10 | Mid de zona |
| NE | (+32, −32) | escorpiones | 13 | Tope de Zone_0 |

### Zone_1 — Valle Congelado (contenido 20–40; acceso lvl 15)

Entrada y portal de regreso hacia el **NO** (pack más bajo). Progresión en sentido horario: esqueletos → zombies → ogros → bull fighters. El boss no comparte mancha ni familia social con los packs.

| Cuadrante | Centro aprox. | Spot(s) | Niveles | Rol |
|-----------|---------------|---------|---------|-----|
| NO | (−32, −32) | esqueletos | 22 | Entrada / farm 20–24 |
| NE | (+32, −32) | zombie + zombie2 | 25 / 26 | Farm 25–28 |
| SO | (−32, +32) | ogros | 31 | Farm 30–33 |
| SE | (+32, +32) | bull fighters | 36 | Farm 35–38 |
| Este (entre NE y SE) | (+48, 0) | silver dragonkin ×1 | 40 | Boss de zona; respawn largo |

Stats (`pAtk`, HP, EXP, aggro) van en `mobs.json` y deben seguir esa escalera; el retoque fino de balance se hace en datos, no en código.

## Ciclo de respawn de mobs (Cartographer)

La fuente de verdad es la DB (`MobInstance.isAlive = false` + `diedAt`), no el temporizador en memoria:

- `diedAt + respawnDelayMs` (de `mobs.json`) define el vencimiento.
- Barrido de arranque + reconciliador cada `respawnSweepIntervalMs`: revive lo vencido y reagenda lo pendiente, así un reinicio del proceso no deja mobs muertos para siempre.
- La transición `isAlive false → true` es condicional, por lo que temporizador y barrido no pueden duplicar un respawn.

## Eventos Socket (`libs/shared-types/src/world-socket.ts`)

- Cliente → servidor: `portal-travel` (`WsPortalTravelClientPayload`), `request-respawn` (ack `WsRequestRespawnAckPayload`).
- Servidor → cliente: `portal-travel-denied`, `player-left-zone`, `player-death` (`WsPlayerDeathPayload`), `player-respawn` (`WsPlayerRespawnPayload`).

## Impacto cruzado

- **Combate / aggro:** `zonesMatch` y `normalizeZoneId` unifican comparaciones (mob vs personaje vs drops).
- **Economía / drops:** `worldDropZoneId` y personaje deben seguir alineados a la zona canónica.
- **Cliente:** assets de build incluyen `world-zones.json` y `map-objects-*.json` bajo `/config`.

## Operación

Tras cambiar spawns: desde `apps/server`, `npx tsx scripts/seed-mobs.ts` (borra instancias y repuebla por `spawnSpots`).
