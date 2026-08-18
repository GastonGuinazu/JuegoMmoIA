# 08 — Mercaderes, interacción y contrato de tienda

**Agentes:** The Weaver + The Warden + The Ledger  
**Ámbito:** `apps/client` + `apps/server` + `libs/shared-types`

## Objetivo de diseño

Definir un flujo único para abrir tiendas de NPC mercaderes con autoridad de servidor, catálogo data-driven y UX consistente con el esquema de clics del juego.

## Reglas de interacción (Weaver)

1. **Clic izquierdo** sobre un NPC con `npcRole = MERCHANT` envía intención de abrir tienda.
2. **Clic derecho** queda reservado para movimiento manual en suelo (no abre tienda).
3. El contexto de clic derecho del inventario (`contextmenu` de mochila/paperdoll) se limita a acciones de inventario y no debe bloquear la interacción de mercader por clic izquierdo en el mundo.
4. El cliente abre la UI solo con `ack.ok = true` del servidor.

## Distancia y validación (Warden)

- El Warden valida en `OPEN_MERCHANT_STORE`:
  - personaje y NPC en la misma zona (`ZONE_MISMATCH` si no coincide);
  - distancia euclídea 3D dentro de `npcInteractionRadiusMeters`.
- Fuente SSOT de rango: `apps/server/config/world-spatial.json`.
  - valor v1: `npcInteractionRadiusMeters = 4`.
- La misma validación de distancia/zona aplica también a `BUY_ITEM` y `SELL_ITEM`.

## Catálogo data-driven y precios (Ledger)

- Catálogo de mercaderes en `apps/server/config/npc-shops.json`.
- Cada oferta define `catalogKey` y `buyPriceAdena` (unidad en Adena).
- El precio de recompra al jugador se deriva como `sellPriceAdena = floor(buyPriceAdena / 3)`.
- No se permite hardcodear precios en handlers de socket.

## Contrato socket: abrir tienda

### Cliente -> Servidor

- **Evento:** `open-merchant-store`
- **Payload:** `{ npcInstanceId: string }`

### Servidor -> Cliente (ack)

- **OK:**
  - `{ ok: true, npcInstanceId, displayName, npcTemplateKey, offers[] }`
- **Error:**
  - `{ ok: false, code, message }`

### Códigos de error esperados

- `NOT_BOUND`
- `INVALID_PAYLOAD`
- `NPC_NOT_FOUND`
- `NOT_FOUND`
- `ZONE_MISMATCH`
- `TOO_FAR`

### Compatibilidad

- `npc-interact` queda como alias temporal de compatibilidad, pero el contrato canónico es `open-merchant-store`.

## Impact Analysis

- **Weaver:** picking de NPC, apertura/cierre de panel de tienda y logs de UX. El cubo verde del mercader convive con el puesto de mapa (carreta/barril/cofre/antorcha); no abre tienda el prop, sólo el NPC.
- **Warden:** routing de evento y guardas autoritativas de zona/distancia.
- **Ledger:** resolución de catálogo, integridad de precios en Adena y transacciones de compra/venta.

## QA mínimo obligatorio

- Clic izquierdo en MERCHANT abre tienda dentro de rango.
- Fuera de rango responde `TOO_FAR` y no abre UI.
- Clic derecho en suelo mantiene movimiento y no abre tienda.
- Clic derecho de inventario sigue ejecutando usar/equipar/desequipar sin romper la apertura de tienda por clic izquierdo.
