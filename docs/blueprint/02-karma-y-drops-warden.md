# 02 — Karma, PK y drops (The Warden)

**Agente:** The Warden (`PenaltyManager`, resolución de muerte, tablas de drop).  
**Relacionado:** economía (04), combate (05), `Value Score` de ítems.

## Objetivo de diseño

Separar claramente el **estado moral del personaje** (karma / PK) en tres bandas visibles (**flags**), y aplicar **consecuencias económicas y de drop** proporcionales al riesgo asumido por el jugador **Rojo**, sin destruir la viabilidad del PvP opcional.

## Flags de karma / PK (Blanco / Púrpura / Rojo)

### Definición operativa

| Flag | Nombre working | Condición resumida (data-driven) |
|------|----------------|----------------------------------|
| **Blanco** | `WHITE` | Sin kills injustificados recientes por encima del umbral; karma ≥ umbral “limpio”. |
| **Púrpura** | `PURPLE` | Estado intermedio: agresor en ciertos contextos, o karma degradado pero no “criminal máximo”. |
| **Rojo** | `RED` | Criminal declarado: karma por debajo del umbral PK / acumulación de kills injustificados según reglas del servidor. |

Los **umbrales numéricos** (`karma_min_white`, `karma_max_purple`, etc.) viven en configuración. Este manual define **comportamiento**, no los números finales de balance.

### Transiciones

- Matar a jugador **Blanco** sin consentimiento de PvP (según zona y reglas) → empuja karma hacia **Púrpura/Rojo**.
- El tiempo online y acciones de “limpieza” (ver más abajo) mueven el karma hacia **Blanco**.
- El flag efectivo para UI y para **penalización de drop** se deriva del **valor actual de karma** y de **contadores de PK** al momento de la muerte.

## Penalización de drop para jugadores Rojos (equipo equipado)

### Alcance

- Aplica a jugadores con flag **Rojo** al morir en contextos PvP/PvE según tabla `drop_rules` (el servidor decide si la muerte genera drop de inventario y/o equipado).
- La penalización **no** es un drop plano fijo: se escala con el **Value Score** de los **ítems equipados** candidatos a caer.

### Value Score (concepto)

- Cada pieza equipable tiene un **`valueScore`** (entero) calculado a partir de rareza, nivel de síntesis, opciones, encantamiento, etc. La fórmula exacta es **data-driven** (`item_value_weights`).
- Objetivo de diseño: un jugador Rojo con **equipo caro** asume **más riesgo** de pérdida relevante que uno con equipo barato.

### Comportamiento de diseño (plantilla)

1. Al resolver muerte con drop habilitado, el servidor construye el **pool candidato** (slots equipados permitidos por reglas de zona).
2. Se calcula una **probabilidad de drop por slot** o un **número de rolls** según flag y `valueScore` agregado o por pieza.
3. **Jugador Blanco/Púrpura:** reglas estándar de drop (menor o nula caída de equipado según diseño de zona).
4. **Jugador Rojo:** incremento de probabilidad o de **cantidad de piezas** elegibles, **monotónico** con `valueScore` (ej. curva con techo para no ser instakill económico total en un solo death — opcional vía `max_equipped_drops_per_death`).

### Integridad

- Los ítems dropeados deben generarse como **entidades de suelo/contenedor** con trazabilidad (dueño anterior, causa de muerte) para logs y recuperación ante bugs.

## Limpieza de karma

Dos palancas complementarias; pesos en datos.

### 1. Tiempo online

- Por cada intervalo de **tiempo conectado** (y no AFK según reglas anti-exploit), el karma converge lentamente hacia valores menos criminales.
- **Anti-AFK:** solo cuenta tiempo en el que el jugador realiza acciones válidas (movimiento, combate, uso de objeto) según ventana deslizante — detalle de implementación en Warden.

### 2. Grind de mobs de nivel similar

- Derrotar mobs cuyo nivel esté dentro de un **rango configurable** respecto al nivel del jugador (ej. ±5) aplica un **delta de karma positivo** por kill, con **diminishing returns** diarios para evitar farm infinito.
- Mobs de nivel demasiado bajo **no aportan** o aportan cantidad despreciable.

### Orden de aplicación

- En cada tick o evento de kill, el servidor actualiza karma y **recalcula flag** para el siguiente broadcast a clientes.

## Relación con combate y zonas

- En **ciudad segura**, las reglas de ataque y de drop pueden inhibirse o alterarse (ver [05-combate-warden-weaver.md](./05-combate-warden-weaver.md)).
- El **body block** y el **facing** no modifican karma por sí solos; solo el **resultado** (quién mató a quién, en qué contexto).

## Telemetría y balance

- Métricas mínimas: distribución de flags en población, tasa de drop de equipado en Rojos, karma medio antes/después de sesiones de grind.
- Ajustar umbrales y curvas de `valueScore` solo vía datos tras pruebas.

## Contratos runtime (Warden/Weaver/Ledger)

- Config data-driven en `apps/server/config/karma-rules.json`:
  - `attackOnWhite`: transición inmediata a estado Púrpura por agresión injustificada.
  - `killOnWhite`: transición a Rojo por kill injustificada y penalización de karma.
  - `redDeathDrop`: curva de probabilidad de drop por `valueScore`.
- Eventos de socket en tiempo real:
  - `attack-player` / `attack-player-result` para resolución PvP autoritativa.
  - `player-visual-state` para sincronizar `karmaFlag` y `weaponPlusLevel` en todos los clientes cercanos.
- Drop PK Rojo:
  - El Warden decide la pieza a caer con la curva de `valueScore`.
  - El Ledger ejecuta `EQUIPPED -> WORLD_DROP` en la misma transacción de muerte para evitar estados intermedios.
