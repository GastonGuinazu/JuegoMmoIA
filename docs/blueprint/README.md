# Blueprint Aetheris — Única fuente de verdad (SSOT)

Este directorio concentra las **reglas de diseño** del Web-MMORPG Aetheris. Cualquier implementación en `apps/server`, `apps/client` o datos en Supabase debe **ajustarse a estos manuales**. Si el producto cambia una regla, se actualiza primero aquí y luego el código.

## Principios transversales

1. **Servidor autoritativo:** el cliente no resuelve resultados críticos (síntesis, drops, combate, subastas). Solo predice visualmente donde aplique (Weaver).
2. **Data-driven:** probabilidades de síntesis, umbrales de karma, `Value Score`, fórmulas de stats y tablas de mazmorras viven en **config versionada** y/o **tablas de base de datos**, no dispersas en código.
3. **Integridad económica:** transacciones atómicas (Ledger) para inventario, monedas, subasta y síntesis; auditoría anti-duplicación.
4. **Agentes:** cada manual indica el agente responsable de la implementación ([ver `Agent.md`](../../Agent.md) en la raíz).

Las **guías de implementación** (skills, contratos Nest, responsabilidades) están en [`docs/agents/`](../agents/README.md).

## Índice de manuales

| ID | Archivo | Tema |
|----|---------|------|
| 01 | [01-sintesis-ledger.md](./01-sintesis-ledger.md) | Sistema de síntesis 2×1, niveles 1–10, pity (The Ledger) |
| 02 | [02-karma-y-drops-warden.md](./02-karma-y-drops-warden.md) | Karma, flags Blanco/Púrpura/Rojo, drops y `Value Score` (The Warden) |
| 03 | [03-progresion-stats-warden.md](./03-progresion-stats-warden.md) | Stats base MU y derivados estilo L2 (The Warden) |
| 04 | [04-economia-dual-ledger.md](./04-economia-dual-ledger.md) | Adena, Aether-Shards, subasta obligatoria (The Ledger) |
| 05 | [05-combate-warden-weaver.md](./05-combate-warden-weaver.md) | Loop 20 TPS, body block, facing, escudo DK (Warden/Weaver) |
| 06 | [06-mazmorras-diarias-cartographer.md](./06-mazmorras-diarias-cartographer.md) | Dungeons diarias estilo MIR4 (The Cartographer) |
| 07 | [07-inventario-recursivo.md](./07-inventario-recursivo.md) | Paperdoll, equipamiento anidado y ripple de stats (Warden/Ledger/Weaver) |
| 08 | [08-mercaderes-ledger.md](./08-mercaderes-ledger.md) | Interacción con mercaderes, validación de rango y contrato de tienda (Warden/Ledger/Weaver) |
| 09 | [09-zonas-y-portales.md](./09-zonas-y-portales.md) | Zonas segregadas, SpawnSpots y portales (Cartographer/Warden/Weaver) |
| 10 | [10-visual-enchant-status-weaver.md](./10-visual-enchant-status-weaver.md) | Glow de encantamiento, status visual PvP y `player-visual-state` (Weaver/Warden) |
| 11 | [11-comandos-gm-local-warden.md](./11-comandos-gm-local-warden.md) | Comandos GM locales, `isAdmin`, socket `execute-gm-command` (Warden/Ledger/Weaver) |

## Convenciones de documentación

- Los valores numéricos marcados como **plantilla** son defaults de diseño; el balance final se carga desde datos.
- Los términos en inglés (`Value Score`, `Pity`, `tick`) se mantienen para alinear código y protocolos de red.
- **Versionado:** cuando un manual cambie de forma incompatible, añadir nota de versión al inicio del archivo afectado (fecha + resumen).

## Próximos artefactos (fuera de este paquete inicial)

- Esquemas de base de datos e ítems en `docs/schemas/` (cuando se definan).
- DTOs compartidos en `libs/shared/` al iniciar el código.
