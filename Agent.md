# Aetheris — Blueprint del proyecto

Este archivo es el punto de entrada para humanos y agentes. La **única fuente de verdad** de reglas de juego, fórmulas y contratos de diseño está en `docs/blueprint/`.

## Stack objetivo

- **Servidor:** NestJS + Socket.io (autoritativo, 20 TPS).
- **Cliente:** Angular 19 + Three.js.
- **Datos:** Supabase + Prisma (persistencia y transacciones atómicas).

## Mapa de documentación (`docs/blueprint`)

| Documento | Agente principal | Contenido |
|-----------|------------------|-----------|
| [README.md](./docs/blueprint/README.md) | — | Índice, SSOT, convenciones |
| [01-sintesis-ledger.md](./docs/blueprint/01-sintesis-ledger.md) | The Ledger | Síntesis 2×1, niveles 1–10, pity |
| [02-karma-y-drops-warden.md](./docs/blueprint/02-karma-y-drops-warden.md) | The Warden | Karma, flags, penalización de drop |
| [03-progresion-stats-warden.md](./docs/blueprint/03-progresion-stats-warden.md) | The Warden | Stats MU → derivados estilo L2 |
| [04-economia-dual-ledger.md](./docs/blueprint/04-economia-dual-ledger.md) | The Ledger | Adena, Aether-Shards, subasta |
| [05-combate-warden-weaver.md](./docs/blueprint/05-combate-warden-weaver.md) | Warden / Weaver | Ticks, body block, facing |
| [06-mazmorras-diarias-cartographer.md](./docs/blueprint/06-mazmorras-diarias-cartographer.md) | The Cartographer | Instancias diarias estilo MIR4 |
| [07-inventario-recursivo.md](./docs/blueprint/07-inventario-recursivo.md) | Warden / Ledger / Weaver | Paperdoll, sub-slots, ripple de stats y guardas de integridad |
| [08-mercaderes-ledger.md](./docs/blueprint/08-mercaderes-ledger.md) | Warden / Ledger / Weaver | Interacción con mercaderes, rango de apertura y contrato socket de tienda |
| [09-zonas-y-portales.md](./docs/blueprint/09-zonas-y-portales.md) | Cartographer / Warden / Weaver | Zonas segregadas, SpawnSpots, portales y optimización de ticks |
| [10-visual-enchant-status-weaver.md](./docs/blueprint/10-visual-enchant-status-weaver.md) | The Weaver / The Warden | Glow por plus, estado visual PvP y evento `player-visual-state` |
| [11-comandos-gm-local-warden.md](./docs/blueprint/11-comandos-gm-local-warden.md) | The Warden / Ledger / Weaver | Comandos GM locales (`isAdmin`, `execute-gm-command`) para QA sin grind |

## Entregas de cátedra

El orden de avances para el repositorio está en [docs/avances/commit-plan.md](./docs/avances/commit-plan.md).

## Protocolo de trabajo

1. **Context check:** leer los documentos de blueprint afectados antes de implementar.
2. **Impact analysis:** documentar módulos cruzados (combate ↔ economía ↔ drops, etc.).
3. **Data-driven:** tablas de probabilidades, karma y stats en configuración o DB, no en lógica opaca.
4. **Server-authoritative:** el cliente envía intenciones; el servidor valida y emite estado.

## Estructura del monorepo

```
/apps/server   → NestJS (Warden + Ledger)
/apps/client   → Angular 19 + Three.js (Weaver)
/libs/shared-types → DTOs, tipos y constantes compartidas (evolución desde aquí)
/docs/blueprint → Manuales de diseño (SSOT)
/docs/agents   → Manuales de operación técnica por sub-agente
```

### Contrato compartido (`libs/shared-types`)

Un solo archivo define cada DTO y evento de socket; **está prohibido crear espejos por app**.

- **Servidor:** lo consume como paquete `@aetheris/shared-types` (dependencia `file:` → `node_modules`), porque su `rootDir` es `./src`. Los scripts `prebuild` / `prestart:dev` compilan la lib automáticamente; para compilarla a mano: `npm run build:shared` desde `apps/server`.
- **Cliente:** lo consume como fuentes, vía el `include` de `tsconfig.app.json`.

Al tocar el contrato hay que reconstruir la lib antes de que el servidor vea los tipos nuevos.

## Agencia técnica (`docs/agents`)

Guías de implementación por dominio: [the_warden.md](./docs/agents/the_warden.md), [the_ledger.md](./docs/agents/the_ledger.md), [the_weaver.md](./docs/agents/the_weaver.md), [the_cartographer.md](./docs/agents/the_cartographer.md).
