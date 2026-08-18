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
| A1 | pendiente | Terreno base | Monorepo Nest + Angular + Three: piso 128 m, cámara, click-to-move, `world-zones.json`. Sin combate ni mobs. |
| A2 | pendiente | Entidades cubo | Personaje, otros jugadores y mobs/NPC en primitivas + sync socket. |
| A3 | pendiente | Combate autoritativo | Ticks 20 TPS, melee, skills, validación Warden. |
| A4 | pendiente | Inventario y economía | Paperdoll, Adena, tienda básica / catálogo. |
| A5 | pendiente | Zonas, portales y spots | Zonas segregadas, portales, SpawnSpots, IA de mobs. |
| A6 | pendiente | Modelo de personaje | Asset del jugador (reemplazo del dummy). |
| A7 | pendiente | Modelos de mobs | Catálogo visual de mobs. |
| A8 | pendiente | Props de entorno | Nature + Ruins (árboles, ruinas, albedo). |
| A9 | pendiente | Mercader y senderos | Puesto del NPC, losetas a cuadrantes de caza. |
| A10 | pendiente | Cierre | Lo que reste (síntesis UI, karma, GM, dungeons stub). |

## A0 — archivos de esta oleada

- ignore de git, `README.md`, `Agent.md`, `.cursorrules`
- `docs/agents/**`, `docs/blueprint/**`, `docs/schemas/**`, `docs/avances/**`
- `.cursor/rules/avances-git.mdc`
