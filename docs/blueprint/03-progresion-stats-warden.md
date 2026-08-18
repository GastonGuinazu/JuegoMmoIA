# 03 — Progresión y stats (The Warden)

**Agente:** The Warden (cálculo de atributos efectivos, `CombatResolver`).  
**Cliente (Weaver):** muestra valores derivados y tooltips; **no** recalcula daño final.

## Objetivo de diseño

Unificar la nostalgia de **stats base estilo MU** (cuatro atributos fundamentales) con la sensación de build de **Lineage 2 Essence** mediante **stats derivados** que alimentan combate (velocidad de ataque, crítico, defensa física, etc.). Todo cálculo final de combate ocurre en **servidor**.

## Stats base (MU)

| Stat | Nombre | Rol narrativo / mecánico |
|------|--------|---------------------------|
| **STR** | Fuerza | Daño físico cuerpo a cuerpo, carga, penalizaciones de armadura pesada (si se habilitan). |
| **AGI** | Agilidad | Esquiva, precisión, contribución a velocidad de ataque y crítico. |
| **VIT** | Vitalidad | HP, resistencias básicas, regeneración pasiva. |
| **ENE** | Energía | Mana, daño mágico/skill, algunas reducciones de coste (según clase). |

### Puntos por nivel

- Los **puntos atributo** otorgados por nivel y por quests se definen en tablas por **clase** (`class_stat_growth`).
- Respetar **restricciones de clase** (arquitecto de clase no puede invertir libremente en stats prohibidos si el diseño lo exige).
- Baseline actual de producto (v1 DK/DW/FE): **+5 `availableStatPoints` por nivel**.
- La asignación se ejecuta por intención de cliente `DISTRIBUTE_STAT { statName, amount }`, pero la validación y mutación final son exclusivas del Warden.

## Stats derivados (estilo L2)

Ejemplos de derivados que **deben** existir en el modelo de combate (nombres working):

| Derivado | Entradas típicas (base + equipo + buffs) | Uso en combate |
|----------|------------------------------------------|----------------|
| **Atk.Speed** | AGI, STR (ligero), tipo de arma, buffs | Cadencia de skills básicos, animación servidor-cliente alineada. |
| **Crit.Rate** | AGI, crítico de ítem, buffs | Probabilidad de golpe crítico en fórmula de daño. |
| **P.Def** | VIT, armadura, opciones, buffs | Mitigación de daño físico entrante. |

Otros derivados recomendados en la misma capa (para documentar en datos): **M.Def**, **Accuracy**, **Evasion**, **Max HP/MP**, **HP/MP regen**.

## Pipeline de cálculo (servidor)

1. **Base:** stats del personaje (nivel + puntos asignados).
2. **Equipamiento:** suma de stats planos y porcentuales por slot; aplica restricciones de clase y nivel de ítem.
3. **Buffs/debuffs:** modificadores temporales con prioridad definida en `buff_stacking_rules`.
4. **Derivados:** función pura `computeDerivedStats(effectiveBase + equipment + buffs)` → objeto usado por `CombatResolver`.
5. **Caché:** invalidar caché de stats al cambiar equipamiento, nivel, buff o talento.

### Escalado por síntesis (`plusLevel`)

- El poder efectivo del equipo debe depender directamente de `plusLevel` (`synthesisLevel - 1`).
- Fórmula base de producto (lineal por tramo):  
  `statFinal = statBase * (1 + plusBonusPctAcumulado)`.
- `plusBonusPctAcumulado` se obtiene desde `config/synthesis-tiers.json`, sumando `statBonusPercent` de cada tramo desbloqueado por el ítem.
- Ejemplo v1 de balance (si cada tramo aporta `10%`): `+1 => x1.10`, `+2 => x1.20`, etc.
- El cálculo ocurre solo en Warden y se refleja en tooltips/character sheet vía DTOs de servidor.

### Data-driven

- Coeficientes `f(STR, AGI, VIT, ENE) → derivado` viven en **tablas** (`stat_derivation_coefficients`), no hardcodeados en servicios salvo constantes globales documentadas.

## Relación con clases

- Cada clase tiene **multiplicadores** sobre contribuciones de stats base a derivados (ej. mago: ENE pesa más en daño skill).
- Skills referencian **escalados** explícitos (% del daño de arma + coeficiente de INT/ENE, etc.) en catálogo de skills.

## Sincronización cliente

- El servidor envía al cliente un **resumen** (base + derivados redondeados) para UI.
- Tras cambios de síntesis exitosa en pieza equipada, el Warden debe emitir `PLAYER_STATS_UPDATE` para refresco inmediato de barras y daño sin reequipar.
- El cliente puede mostrar **previsualización** al equiparte, pero la decisión final la confirma el servidor al aplicar el cambio de equipamiento.
- El cliente muestra botones de asignación solo si `availableStatPoints > 0`; nunca muta stats localmente sin ACK del Warden.

## Testing y balance

- Tests unitarios del pipeline con fixtures de personaje + set de ítems conocido.
- Validar que buffs con el mismo `buffGroup` no se acumulan de forma indebida.
