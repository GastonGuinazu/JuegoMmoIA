# The Warden — Autoridad, combate y penalizaciones

**Runtime:** `apps/server` (NestJS + motor de simulación / Socket.io).  
**Misión:** Ser la **única fuente de verdad** para el estado del mundo en tiempo real: cada intención del cliente se **valida**, se **ordena** en el tiempo de red, y se **aplica** en ticks deterministas antes de persistir efectos duraderos vía **The Ledger**.

**Blueprint de referencia:** [05-combate-warden-weaver.md](../blueprint/05-combate-warden-weaver.md), [02-karma-y-drops-warden.md](../blueprint/02-karma-y-drops-warden.md), [03-progresion-stats-warden.md](../blueprint/03-progresion-stats-warden.md), [06-mazmorras-diarias-cartographer.md](../blueprint/06-mazmorras-diarias-cartographer.md).

---

## 1. Principios de implementación

1. **No confiar en el cliente** para daño, hits, CD consumidos, selección de target ilegal o posición final.
2. **Determinismo relativo al tick:** todas las resoluciones de combate se anclan a `serverTick` (20 Hz) y a timestamps monotónicos del servidor.
3. **Separación de concerns:** el Warden **calcula** y **emite eventos**; el Ledger **persiste** inventario/muerte/drops en transacciones (ver contrato en [the_ledger.md](./the_ledger.md)).
4. **Contexto de kill:** cada aplicación de daño mortal debe portar `KillContext` (`attackerId`, `victimId`, `zoneId`, `instanceId`, `flags`: `PVP_DUNGEON`, `OPEN_WORLD`, `PVE`, …) para ramificar karma y expulsiones.

---

## 2. Skill: `TickSync`

### Objetivo

Mantener un **latido de simulación a 20 TPS** (`tickRate = 20`) y alinear **cadencia de ataque** con el reloj del servidor, no con el reloj del cliente.

### Responsabilidades

| Responsabilidad | Detalle técnico |
|-----------------|-----------------|
| Loop de tick | Scheduler único (o worker dedicado) que incrementa `globalTick` y procesa colas por shard/mapa. |
| Entrada de jugadores | Las acciones llegan con `clientTimestamp` opcional solo para **descarte de paquetes obsoletos**, no para autorizar hits. |
| `Atk_Speed` | Convertir el stat derivado (ver blueprint 03) a **periodo mínimo entre autoataques o casts** expresado en **ticks o ms de servidor**: `nextAttackServerTime = lastAttackServerTime + attackPeriodMs(effectiveStats)`. |
| Validación | Rechazar skill/autoataque si `now < nextAttackServerTime` o si el estado (stun, silence) lo impide. |
| Sincronización red | Emitir snapshots delta o eventos compactos post-tick; no bloquear el tick con I/O lento — usar colas outbound. |

### Contrato sugerido

- `GET_SERVER_TIME` / heartbeat: el cliente corrige **solo presentación** (Weaver `NetPredictor`).
- Los DTOs de intención incluyen `intentSequence` por entidad para detectar reordenamiento o replay.

---

## 3. Skill: `CombatResolver`

### Objetivo

Resolver **daño**, **ángulos**, **tipo de objetivo** y **mitigaciones especiales** de forma centralizada y testeable.

### 3.1 Facing Factor (valores de producto actuales)

| Caso | Modificador |
|------|-------------|
| Impacto en **espalda** del objetivo (cono posterior configurable, heredado de blueprint 05) | **+15% daño** (`backDamageMultiplier = 1.15`) aplicado **después** de stats base y **antes** de `P.Def` si el orden oficial es `facing → defense`; documentar orden en `damage_resolution_order`. |
| **Dark Knight** con **escudo** activo y golpe **frontal** | **50% mitigación** del daño físico entrante elegible (`shieldFrontalMitigation = 0.50`) salvo skills marcadas `ignoresShieldBlock` en datos. |

**Nota:** los conos frontal/trasero deben leerse de config (`degreesBack`, `degreesFront`) para tuning sin redeploy.

### 3.2 Target-Lock (Single)

- Un solo **`primaryTargetId`** activo por entidad atacante en modo lock (salvo skills que explícitamente limpien lock).
- Validar **rango**, **LOS**, **faction/hostility** y **estado** en el tick del intento.
- El servidor es autoridad del **cambio de target**; el cliente solo envía `SET_TARGET` / `ATTACK_TARGET`.

### 3.3 AOE direccional

- Skills AOE se resuelven con **origen** = posición del caster + **facing** + **hull** (sector, rectángulo, cápsula) en coordenadas del mundo.
- **Orden de muestreo:** recoger entidades en AOI → filtrar por geometría → aplicar mismas reglas de facing/mitigación **por víctima** según su orientación relativa al caster.
- No usar detección del cliente; opcionalmente el cliente muestra “área fantasma” solo visual.

### 3.4 Integración con stats

- Consumir el objeto `DerivedCombatStats` producido según blueprint 03 (Atk.Speed, Crit.Rate, P.Def, etc.).
- Tests unitarios: matriz de ángulos, DK con/sin escudo, backstab constante 1.15.

---

## 3.5 Skill: `CommandInterceptor` (GM local)

**SSOT:** [11-comandos-gm-local-warden.md](../blueprint/11-comandos-gm-local-warden.md).

| Pieza | Rol |
|-------|-----|
| Socket `execute-gm-command` | Única entrada soportada para intenciones GM; el cuerpo no sustituye la verificación de `Character.isAdmin` en servidor. |
| `GmCommandService` | Enruta `setplus`, `giveitem`, `setlevel`, `setkarma` y devuelve ack tipado; mutaciones vía Prisma / `CharacterService` alineadas al Ledger. |
| Post-mutación | `WorldGateway` emite `PLAYER_STATS_UPDATE`, `PLAYER_VITALS`, `LEVEL_UP` si aplica, y `player-visual-state` tras cambios de plus o karma. |

El cliente **nunca** puede forzar stats: solo recibe ACK y eventos autoritativos.

---

## 4. Skill: `PenaltyManager`

### Objetivo

Mantener la **máquina de estados de Karma** en **tres tiers** alineados con diseño y UI, y aplicar **Smart Drop** de equipamiento para jugadores en estado criminal alto.

### 4.1 Tiers de Karma (Tier I / II / III)

Mapeo **lógico** (nombres de producto en blueprint 02: Blanco / Púrpura / Rojo):

| Tier | Flag runtime | Comportamiento resumido |
|------|--------------|-------------------------|
| **Tier I** | `KARMA_TIER_1` (limpio) | Sin penalizaciones de drop por karma; reglas estándar de zona. |
| **Tier II** | `KARMA_TIER_2` (intermedio) | Advertencias / restricciones suaves según tablas de diseño. |
| **Tier III** | `KARMA_TIER_3` (criminal) | Equivalente operativo a **Rojo**: habilitar **Smart Drop** de equipado en muertes elegibles. |

Las transiciones dependen de `karmaPoints`, kills injustificados y reglas de zona; todo **data-driven**. Al cambiar tier, broadcast a cliente para badge/color.

### 4.2 Smart Drop (Tier III / Rojo)

- Construir candidatos de slots equipados según `drop_rules` de la zona.
- Ponderar o escalar probabilidad usando **`valueScore`** por pieza (ver blueprint 02).
- Delegar en Ledger la **creación del ítem en suelo** y la **mutación de inventario** en una transacción; el Warden solo **decide** qué cae.

---

## 5. Regla especial: PvP en Dungeons Diarias

**Fuente SSOT:** [06](../blueprint/06-mazmorras-diarias-cartographer.md) (sección PvP competitivo).

| Requisito | Implementación |
|-----------|----------------|
| Sin karma por PvP en instancia | Si `KillContext.flags` incluye `PVP_DUNGEON_COMPETITIVE`, **no** invocar transiciones de `PenaltyManager` por este kill. |
| Expulsión | Al `death` con `killer` jugador y mismo contexto, emitir evento de dominio `DungeonPvpVictimEliminated` con `victimId`, `instanceId`, `remainingQuotaMs`. |
| Tiempo | **Cartographer / NexusManager** consume el **tiempo restante** de la sesión diaria del expulsado y cierra su sesión de instancia. |

El Warden **no** debe duplicar lógica de cuota: reacciona al evento y confirma **unattach** del jugador del `InstanceShard`.

---

## 6. Colisión y zonas (coordinación con Cartographer)

- **Body block ON** fuera de ciudades; **OFF** en ciudades (`zone_collision_profile`). El Warden valida movimiento contra el grid/NavMesh que expone el Cartographer o servicio compartido.
- No mezclar reglas de path con resolución de daño: misma posición autoritativa.

---

## 7. Observabilidad y tests

- Métricas: ticks tardíos, cola de intents, rechazos por CD, distribución de kills por contexto.
- Tests de integración: kill PvP en dungeon → sin delta karma + evento expulsión mockeado.
- Property tests opcionales sobre `attackPeriodMs` monótono respecto a Atk.Speed.

---

## 8. Dependencias cruzadas

| Agente | Interacción |
|--------|-------------|
| **Ledger** | Persistencia atómica de drops, muerte, inventario. |
| **Cartographer** | `instanceId`, límites de tiempo, flags PvP de instancia. |
| **Weaver** | Contrato de eventos visuales y predicción; nunca fuente de verdad. |

---

## 9. Skill: `RecursiveStatEngine` (Ripple Effect)

### Objetivo

Garantizar que los stats de equipo anidado se apliquen solo cuando toda la cadena de ancestros está equipada.

### Regla de activación

- Un ítem hijo (ej. Talismán) **no** aporta stats por sí mismo.
- Solo aporta si:
  1. está marcado como equipado;
  2. su `parentItemInstanceId` existe;
  3. cada ancestro hasta la raíz permanece equipado.

### Motivo de diseño

Evita exploits de “stat fantasma” (hijos activos sin contenedor activo), mantiene consistencia visual-funcional y respeta el modelo server-authoritative: el cliente puede previsualizar, pero la activación efectiva la decide el Warden.

### Implementación esperada

1. Construir árbol de equipados por `parentItemInstanceId`.
2. Calcular desde raíces (`parentItemInstanceId = null`).
3. Agregar recursivamente stats de cada nodo válido.
4. Invalidar caché de derivados cuando cambia cualquier vínculo padre/hijo.

---

## 10. Impacto registrado — Grade Penalty (Ítems D/C/B)

### Contexto

Se agregó validación autoritativa por `ItemTemplate.grade` para equipamiento:

- Grades soportados: `None`, `D`, `C`, `B`, `A`, `S`.
- Umbrales activos de penalización v1: `D >= 20`, `C >= 40`, `B >= 52`.

### Reglas aplicadas

Cuando un personaje equipa un ítem por encima de su umbral:

- `derivedPAtk *= 0.5`
- `derivedAtkSpeed *= 0.5`

La validación se aplica en:

1. `StatEngineService.computeDerivedStats` (recálculo autoritativo).
2. `PlayerCombatRuntimeService.syncProgressionDrivenCombatState` (validación recurrente por tick de stats).

### Evento de red

El Warden emite al socket del jugador:

- `GRADE_PENALTY_STATUS { active: boolean }`

El objetivo es habilitar warning visual en Weaver sin mover autoridad al cliente.

---

## 11. Impacto registrado — Apertura de tienda de mercader

### Evento autoritativo

- Contrato canónico: `OPEN_MERCHANT_STORE` (`open-merchant-store`).
- `NPC_INTERACT` se mantiene como alias temporal de compatibilidad.

### Validaciones obligatorias

1. `npcInstanceId` válido y NPC existente.
2. Coincidencia de zona (`character.currentZoneId` vs `npc.zoneId`).
3. Distancia 3D dentro de `npcInteractionRadiusMeters` (`world-spatial.json`).

### Resultado

- Solo si pasa validaciones, el Warden devuelve `offers[]` para abrir UI.
- Si falla, responde `TOO_FAR`, `ZONE_MISMATCH` u otros códigos explícitos sin exponer mutaciones económicas.

---

## 12. Impacto registrado — `PenaltyManager` runtime (Karma + PK Drop)

### Fuente de configuración

- Archivo data-driven: `apps/server/config/karma-rules.json`.
- Loader runtime: `loadKarmaRulesConfig()` (`apps/server/src/combat/penalty-config.loaders.ts`).

### Transición de flags (Blanco -> Púrpura -> Rojo)

El `PenaltyManager` aplica transiciones sin lógica hardcodeada en handlers:

1. **Ataque injustificado a Blanco**:
   - aplica `attackOnWhite.karmaPointsDelta`;
   - fuerza tier mínimo `attackOnWhite.forceMinimumTier` (operativamente Púrpura).
2. **Kill injustificado a Blanco**:
   - aplica `killOnWhite.karmaPointsDelta`;
   - incrementa `unjustifiedKillCount` por `killOnWhite.unjustifiedKillIncrement`;
   - fuerza `killOnWhite.forceTier` (operativamente Rojo).
3. **Re-evaluación por puntos**:
   - `getKarmaTierFromPoints()` usa umbrales `tier2MaxPoints` / `tier3MaxPoints`.

### Curva de `valueScore` para PK Drop

Cuando una víctima con tier Rojo muere:

- Se arma pool de equipados candidatos (`gearSlot != null`).
- Se calcula:
  - `totalValueScore = sum(max(0, valueScore))`
  - `chance = min(maxChance, baseChance + totalValueScore * valueScoreFactor)`
- Si el roll pasa:
  - selección ponderada por `max(1, valueScore)` por pieza;
  - el Warden decide la pieza;
  - el Ledger ejecuta `EQUIPPED -> WORLD_DROP` en la misma transacción de muerte.

### Contrato de sincronización visual

- Tras transición de karma o cambio de arma, el Warden emite `player-visual-state` con:
  - `karmaFlag`
  - `weaponPlusLevel`
- Objetivo: nombre/flag y glow de arma consistentes para todos los clientes en AOI.

---

## 13. Impacto registrado — Fix del Handshake Exploit (zona autoritativa)

### Vulnerabilidad corregida

`WorldGateway.handleConnection` leía `handshake.auth.zoneId` (enviado por el cliente) y lo usaba como zona de spawn, incluso persistiéndolo en `Character.currentZoneId`. Un cliente modificado podía forzar su ingreso a cualquier zona (bypass de gating por nivel/instancia) sin pasar por portal ni por la resolución de respawn del servidor.

### Regla aplicada

- El tipo del payload de `handshake.auth` **ya no declara `zoneId`**; el servidor no lo lee bajo ninguna circunstancia.
- La zona de conexión es **siempre** `normalizeZoneId(character.currentZoneId)` leído de Prisma. Sólo se persiste de vuelta si `normalizeZoneId` cambió el valor (migración de alias legado `default`/`null`), nunca por intención del cliente.
- El cliente (`WorldSocketService.connect`) dejó de aceptar/enviar `zoneId`; el campo "Zona" de la UI de conexión fue eliminado por ser información que el frontend ya no controla.
- `zone-snapshot` sigue siendo la única forma en que el cliente conoce su zona real, emitido después de resolver `zoneId` server-side.

### Verificación

- Compilación limpia de servidor (`nest build`) y cliente (`ng build --configuration production`) tras el cambio.
- **Pendiente de test en vivo:** no se pudo ejercitar la reconexión contra la base real porque la `DATABASE_URL` de `apps/server/.env` (Supabase) devuelve `ENOTFOUND (tenant/user ... not found)`; requiere que se regeneren las credenciales del pooler antes de validar el flujo end-to-end.
