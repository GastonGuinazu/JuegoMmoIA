# 06 — Mazmorras diarias (The Cartographer)

**Agente:** The Cartographer (`InstanceManager`, `SpawnController`, `MapGridSystem`).  
**Relacionado:** economía (04), drops/karma (02).

## Objetivo de diseño

Ofrecer **instancias diarias** con **cámaras especializadas** inspiradas en el loop de **MIR4**: el jugador elige un **tipo de recompensa** (oro, experiencia, drop) con **límite de tiempo jugable por día**, de modo que el grind diario sea claro, acotado y equilibrado entre monedas y progresión.

## Estructura general (estilo MIR4)

### Instancia

- Cada dungeon es una **instancia privada o de grupo** (según diseño) con **mapa o segmento** propio generado al entrar.
- Entrada mediante **NPC, menú o portal**; el servidor valida **elegibilidad diaria** antes de crear la instancia.

### Cámaras especializadas

Tres (o más) **variantes** de la misma plantilla de dungeon, diferenciadas por **tabla de spawns** y **multiplicadores de recompensa**:

| Tipo de cámara | Enfoque de recompensa | Comportamiento esperado |
|----------------|------------------------|-------------------------|
| **Oro** | Adena y vendibles | Mayor tasa de oro por mob o cofres dedicados; menos experiencia relativa. |
| **Exp** | Experiencia de personaje | Mobs con más XP, menos drop de ítems valiosos. |
| **Drop** | Loot de ítems / materiales | Mejor tabla de rareza dentro de límites diarios; menos oro plano. |

Los números exactos son **data-driven** (`daily_dungeon_room_profiles`).

## Límite de tiempo diario

### Concepto

- Cada cuenta/personaje dispone de un **presupuesto de tiempo** **por día** (reset según `timezone_server` o UTC configurable) para consumir en **cualquier combinación** de cámaras, o por separado según decisión de producto. **Default de implementación acordado:** **60 minutos/día** (parametrizable en datos).

### Modos de cuota (elegir e implementar una como default)

1. **Bolsa única:** un solo pool de minutos para las tres cámaras (flexible).
2. **Por cámara:** minutos independientes para Oro / Exp / Drop (más predecible para balance).
3. **Híbrido:** bolsa global + bonus por evento.

Este manual recomienda **documentar en datos** el modo activo (`daily_time_mode`).

### Comportamiento al agotar tiempo

- El servidor **finaliza la instancia** de forma segura (teleport fuera, entregar recompensas ya ganadas, no spawnear más oleadas).
- Opcional: **advertencia** a 1 minuto en UI (Weaver).

## Spawns y NavMesh

- Cada cámara define **oleadas** (`spawn_waves`) con composición de mobs acorde al nivel recomendado de la instancia.
- **NavMesh** y **grid** deben estar alineados con reglas de combate (05): body block desactivado o reducido dentro de instancia si el diseño lo requiere para no atascar melee.

## Recompensas y economía dual

- Cámara **Oro** → principalmente **Adena**.
- Cámara **Drop** → chance de materiales y, con rareza acotada, **Aether-Shards** o entradas a sistemas premium (tabla de boss final opcional).
- **Exp** no consume Adena directamente pero alimenta progresión de stats (03).

## Elegibilidad y anti-abuso

- **Una entrada activa** por personaje (o grupo) a la vez; evitar duplicar instancias.
- **Cooldown** o **cap de entradas** además del tiempo si el producto lo exige.
- Log de: tipo de cámara, tiempo usado, recompensas otorgadas.

## PvP competitivo dentro de las mazmorras diarias

Las instancias **no** son exclusivamente PvE: existe **PvP competitivo** entre jugadores con reglas especiales para no contaminar el sistema de karma del mundo abierto.

| Regla | Comportamiento |
|-------|----------------|
| **Karma** | El combate **jugador vs jugador** dentro de la dungeon diaria **no** modifica karma (ni positivo ni negativo): flags **Tier I / II / III** permanecen **inalterados** por kills PvP en esta zona. |
| **Muerte por PvP** | Si un jugador muere **a manos de otro jugador** en la instancia, el servidor lo **expulsa de la sala de forma inmediata** (teleport a nexus seguro o punto de salida). |
| **Tiempo diario** | Esa expulsión **consume el tiempo restante** de la bolsa diaria del personaje para esa sesión de dungeon (el reloj de instancia se da por **terminado** para el expulsado: no puede “volver a entrar con los mismos minutos”). |
| **PvE** | Muerte por mobs sigue las tablas globales de `instance` (exp, drops, karma si aplica fuera de PvP dungeon — ver abajo). |

**Implementación:** marcar la instancia con `pvp_mode = DUNGEON_COMPETITIVE` y en `CombatResolver` / `PenaltyManager` **omitir** cualquier transición de karma cuando `killContext` incluya ese flag; en cambio, emitir evento `dungeon_pvp_expulsion` consumido por **NexusManager** (Cartographer) para cerrar sesión y tiempo.

## Integración con The Warden

- **Muerte PvE** dentro de instancia: aplicar reglas de exp perdida / drops según zona `instance` en tablas globales (karma según diseño; no por PvP de dungeon).
- **Muerte PvP** en dungeon diaria: **sin** ganancia/pérdida de karma por el hecho del kill; **expulsión + consumo de tiempo** como arriba.
- **Smart Drop** por flag Rojo (02) aplica en contextos donde el diseño lo habilite; en la dungeon competitiva, priorizar la **regla de expulsión** como consecuencia principal del PvP; drops de equipado en PvP de instancia son **data-driven** (`dungeon_pvp_drop_rules`) si el producto los define aparte del mundo abierto.
