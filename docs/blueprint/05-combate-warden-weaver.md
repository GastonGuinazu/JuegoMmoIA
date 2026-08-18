# 05 — Combate, ticks y facing (The Warden / The Weaver)

**Agentes:** The Warden (autoridad, daño, colisiones); The Weaver (presentación, predicción cliente, interpolación).  
**Relacionado:** stats (03), karma (02).

## Objetivo de diseño

Combate **servidor autoritativo** con **20 ticks por segundo** (20 TPS), sensación de impacto en melee mediante **body block** fuera de zonas seguras, y profundidad posicional con **facing** (bonus por espalda, mitigación frontal con escudo para Dark Knight).

## Servidor autoritativo y loop de 20 TPS

### Definición

- **Tick:** unidad fija de simulación del mundo (`tickRate = 20 Hz`).
- En cada tick el servidor procesa, como mínimo: intenciones recibidas, movimiento validado, CD de skills, aplicación de daño diferido, estados (stun, root), y sincronización parcial a clientes.

### Cliente

- El cliente **no** aplica daño final ni decide hits. Envía **intenciones**: movimiento deseado, skill objetivo, cambio de target.
- The Weaver implementa **predicción local** opcional para movimiento; el servidor **corrige** con snapshots autoritativos.

### Sincronización

- Broadcast de estado relevante (posición, HP, animación trigger) según reglas de **interest management** (AOI) para optimizar red.

## Catálogo de skills DK (v1)

- El catálogo de habilidades activas del **Dark Knight** se define en `apps/server/config/skills.json` (data-driven).
- Primer set operativo:
  - `power_strike`: objetivo único, coste **15 MP**, multiplicador **1.6x**, cooldown **2000 ms**, rango **2.0 m**.
  - `rageful_blow`: objetivo único, coste **30 MP**, multiplicador **2.2x**, cooldown **5000 ms**, rango **2.0 m**.
- El ataque básico también se considera data-driven en runtime con rango base de producto de **1.5 m** (override futuro por arma/clase).
- Regla de validación autoritativa por cast: recursos (MP), cooldown de skill, objetivo vivo y en rango en el tick servidor.
- Si el cast es válido, el Warden aplica daño y emite evento de resultado para feedback visual del Weaver.

## Mana y regeneración en runtime

- El runtime de combate del personaje debe mantener `currentMp` y `maxMp` en RAM junto con HP.
- Regeneración base inicial: **5% de `maxMp` cada 3 segundos** (sin decisión del cliente).
- El cliente puede prevalidar UX (cooldown/MP local) para evitar spam visual, pero el resultado final de combate sigue siendo autoritativo.

## Body block (fuera de ciudades)

### Regla

- Fuera de **zonas seguras / ciudades**, las entidades con **colisión de cuerpo** (jugadores y, si aplica, mobs grandes) **bloquean** el paso de otros: no se puede atravesar el modelo de otros personajes.
- **Dentro de ciudades** (o zonas marcadas `city_safe = true`), el body block puede **desactivarse** o relajarse para fluidez social — definido por `zone_collision_profile`.

### Implementación (orientación)

- Pathfinding y empuje validados en servidor; el cliente renderiza posiciones interpoladas.
- Evitar “rubber banding” excesivo con límites de velocidad y validación de inputs.

## Facing factor

### Concepto

- Cada entidad tiene un **vector de orientación** (hacia dónde mira) usado en resolución de daño melee y algunas skills.

### Daño extra por la espalda

- Si el atacante impacta al objetivo desde un **ángulo posterior** respecto al facing del objetivo (cono configurable, ej. 120° trasero), aplica un **multiplicador de daño** `backstabMultiplier` (tabla por skill/tipo de arma).
- **Valor base de producto (default data-driven):** **+15%** de daño por impacto trasero (`backstabMultiplier = 1.15`) salvo skills con override explícito.
- Objetivo: recompensa posicionamiento sin reemplazar el cálculo principal de stats (03).

### Bloqueo frontal de escudo (Dark Knight)

- Para la clase **DK** (o ítems con flag `shield_active`), si el daño entrante proveniente del frente (cono frontal configurable) y el objetivo tiene **escudo equipado + skill/estado de block**, aplica **reducción de daño** o **chance de bloqueo total** según `shield_block_table`.
- **Valor base de producto (default data-driven):** **50% de mitigación** del daño físico elegible en arco frontal con bloqueo activo (`shieldFrontalMitigation = 0.50`), salvo skills `ignoresShieldBlock`.
- El escudo **no** bloquea automáticamente impactos por la espalda salvo skills especiales documentadas.

## Integración con stats derivados

- **Atk.Speed** condiciona cadencia real entre ticks permitidos para autoataque.
- **Crit.Rate** y **P.Def** entran en la fórmula después de facing y bloqueo (orden exacto en `damage_resolution_order` en datos).

## Fair play y anti-cheat

- Validar distancia, línea de visión, CD y recursos **en el mismo tick** que aplica el efecto.
- Logs de combate para disputas PvP y ajuste de karma (02).

## PvP de targeting e input (Warden/Weaver)

### Mecánica base incorporada

- El jugador puede seleccionar:
  - **Mob** (flujo PvE tradicional).
  - **Jugador** (flujo PvP directo).
- Input base:
  - Tecla **`1`** mantiene ataque básico.
  - Si el target activo es jugador, `1` emite intención `attack-player`.
  - Si el target activo es mob, `1` mantiene `combat-target` / autoataque PvE.

### Contratos de red

- Nuevo evento de intención PvP: `attack-player`.
- Nuevo resultado de impacto PvP: `attack-player-result`.
- El servidor puede emitir en paralelo updates visuales (`player-visual-state`) cuando cambian flag/arma.
- El servidor procesa el AI de mobs a **20 TPS** con pose en RAM; `mob-moved` sale cada tick. Prisma no persiste XZ en cada paso (flush ~2 s) para no convertir el movimiento en hops.
- Ogro y boss usan `meleeHitDelayMs` (300 / 280): el Warden emite `mob-melee-result` con `damage: 0` para arrancar el clip y aplica HP al contacto, para no pegar en el wind-up.
- El golpe exige distancia ≤ `attackRange` del template + `mobMeleeRangeBufferMeters` (`world-spatial.json`); no reutiliza el stack de alcance del jugador. Cuerpos grandes: ogre **3.8 m**, dragonkin **4.8 m**. El daño es `pAtk` del template con mitigación **porcentual**: `pAtk * (1 - effDef/(effDef + mobToPlayerDefenseSoftCap))`, donde `effDef = P.Def * physicalMitigationFactor`. Cada template tiene su `pAtk` (cubo 6 … dragonkin 78).

## Priority Logic — Mob vs Jugador

### Regla de prioridad

1. Si hay `activePlayerTargetId`, la intención de ataque básico se resuelve como **PvP**.
2. Si no hay target de jugador y existe `activeTargetId` de mob, se resuelve como **PvE**.
3. Si no hay target válido, no se emite ataque y solo hay feedback de UI.

### Autoridad final

- El cliente decide **a quién intenta atacar** (targeting UX).
- El Warden decide **si el ataque es válido** (zona, rango, cooldown, estado del objetivo).
