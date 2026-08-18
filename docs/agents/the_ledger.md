# The Ledger — Economía, persistencia e integridad de ítems

**Runtime:** `apps/server` (NestJS) + **Prisma** + **Supabase (PostgreSQL)**.  
**Misión:** Garantizar **integridad financiera** y **consistencia de inventario** con transacciones **atómicas**: ningún ítem ni moneda existe en un estado intermedio observable por otra sesión.

**Blueprint de referencia:** [01-sintesis-ledger.md](../blueprint/01-sintesis-ledger.md), [04-economia-dual-ledger.md](../blueprint/04-economia-dual-ledger.md), [02-karma-y-drops-warden.md](../blueprint/02-karma-y-drops-warden.md).

---

## 1. Regla de oro transaccional

> **Toda modificación de ítem, moneda, equipamiento o resultado de síntesis/market ocurre dentro de una transacción SQL con rollback automático ante cualquier fallo, violación de invariante o abort explícito.**

### Implicaciones prácticas

| Práctica | Detalle |
|----------|---------|
| Unidad lógica | Un caso de uso = una `$transaction` de Prisma (o equivalente) que agrupa lecturas con lock si hace falta + escrituras. |
| Sin “commit parcial” | No actualizar wallet en una query y el ítem en otra fuera de la misma transacción. |
| Idempotencia | `idempotencyKey` en operaciones iniciadas por el cliente (trade, síntesis, listado AH) almacenado con **unique constraint** para rechazar duplicados. |
| Errores | Cualquier excepción no capturada dentro del callback de transacción debe propagar **rollback** completo. |
| Lecturas fantasmas | En contienda alta (subasta, trade), usar `SELECT … FOR UPDATE` en filas de wallet/ítem o **serializable** donde el perfil de carga lo exija. |

---

## 2. Skill: `SynthesisEngine`

### Objetivo

Ejecutar síntesis **2×1** (**Main** + **Sacrifice**) con **pity** persistente y **conservación de affixes aleatorios** del principal.

### Flujo transaccional (obligatorio)

1. **BEGIN** (implícito en `$transaction`).
2. Bloquear fila del **ítem principal** y del **sacrificio** (o validar version/row lock).
3. Validar receta, niveles, costes (Adena / Aether-Shards), espacio futuro del inventario.
4. **Destruir sacrificio** (delete o move a void con audit log).
5. Debitar monedas.
6. Resolver RNG de éxito + pity; si éxito, incrementar `synthesisLevel` del principal; actualizar `pityCounter` según reglas de [01](../blueprint/01-sintesis-ledger.md).
7. **Los Random Affixes del principal no se recalculan** salvo recetas explícitas en datos.
8. **COMMIT**; emitir evento de dominio para el cliente.

### Pity

- Contador **atómico** en la misma transacción que el intento (columna en `ItemInstance` o tabla `synthesis_pity`).
- Reinicio de pity solo tras **éxito** confirmado en DB.

---

## 3. Skill: `MarketBroker`

### Objetivo

**Subasta asíncrona obligatoria** para equipo por encima de umbral (`auctionThreshold` / `valueScore` / lista de ítems).

### Responsabilidades

| Área | Implementación |
|------|----------------|
| Listado | Mover ítem a estado `IN_AUCTION_ESCROW` dentro de la misma transacción que crea el registro de listado. |
| Pujas | Validar saldo; **hold** o debito según diseño; nunca dejar “puja fantasma” sin fila de auditoría. |
| Cierre | Job por tiempo o tick: adjudicar ganador, transferir ítem, liquidar fondos, aplicar **fee** como sumidero. |
| Fallo | Sin pujas: devolver ítem al vendedor; fees opcionales en datos. |

Todo cierre de lote es **una transacción** por lote.

---

## 4. Skill: `F2F-Security`

### Objetivo

Permitir **trade directo** solo de ítems **Esenciales** (consumibles, materiales y categorías explícitas en `tradeable_categories_f2f`) y **bloquear** el flujo de equipo valioso hacia el AH o sistemas auditados.

### Reglas duras

1. **Whitelist** de `itemCategory` / flags `tradeableF2f = true`.
2. **Equipo** (`gearSlot` definido): **rechazo** en validación previa a abrir ventana o al confirmar.
3. **CAP diario de Adena** (por **cuenta**): ver [04](../blueprint/04-economia-dual-ledger.md), sección *CAP diario de Adena en trade F2F*.

### Implementación del CAP

| Campo | Uso |
|-------|-----|
| `f2f_adena_sent_today` / similar | Acumulado neto saliente (y opcionalmente entrante) por `accountId` y fecha UTC. |
| Pre-check | Antes de mutar inventarios, `proposedAdena + sentToday <= cap` → si no, abort completo. |
| Reset | Misma ventana diaria que el resto del juego. |

### Transacción de trade F2F

- Ambas wallets y stacks involucrados en **una sola** `$transaction`.
- Registrar `trade_id`, snapshot de ítems y cantidades para soporte.

---

## 5. Coordinación con The Warden

- **Smart Drop:** el Warden decide **qué** cae; el Ledger ejecuta `removeFromEquipped` + `createGroundItem` + logs en **una** transacción.
- **Muerte en dungeon:** si el diseño define drops en PvP de instancia, misma regla transaccional.

---

## 6. Supabase y límites de tier gratuito

- Índices en `auction_bid(auction_id)`, `auction_listing(status, ends_at)`, `wallet(account_id)`.
- Paginación estricta en APIs de listado; evitar N+1 en cierre masivo de subastas (batch por ventana de tiempo).

---

## 7. Auditoría y anti-dupe

- Trazabilidad: `item_instance_id` único, historial de cambios de `owner_id`, prohibición de clonar sin origen.
- Alertas sobre saltos imposibles de `quantity` o `valueScore` en ventana corta.

---

## 8. Contrato con The Weaver

- El cliente **muestra** balances e ítems según último snapshot autoritativo; tras acciones económicas, el servidor envía **estado reconciliado** (no confiar en UI optimista salvo feedback temporal claro).

---

## 9. Persistencia de inventario recursivo (Nested Equipment)

### Objetivo

Persistir equipamiento anidado sin pérdida de datos y sin permitir relaciones inválidas.

### Modelo Prisma

| Entidad | Campos |
|---------|--------|
| `ItemTemplate` | `hasSubSlots`, `maxSubSlots`, `subSlotType`, `parentSlotType` |
| `ItemInstance` | `parentItemInstanceId` (self-reference), `parentSubSlotIndex` |

### Invariantes Ledger

1. Contenedor equipado (`hasSubSlots=true`) puede tener hijos equipados.
2. Un sub-slot (`parentItemInstanceId`, `parentSubSlotIndex`) admite un solo hijo.
3. Si un contenedor deja estado equipado, su subárbol se desacopla de forma atómica hacia mochila.
4. No se permite transición de un contenedor con hijos equipados a `WORLD_DROP` (integridad anti-pérdida).

### Política transaccional

- Toda operación de equip/desequip nested y desplazamiento de sub-slots usa `$transaction` serializable.
- El recálculo de stats del personaje se ejecuta en la misma unidad lógica que la mutación de inventario.

---

## 10. Estándar de interceptores Prisma (sin `$use`)

### Regla vigente

- En versiones modernas de Prisma, **no** se usa `$use` (middleware deprecado/retirado).
- Toda guarda transversal de integridad se implementa con **Prisma Client Extensions** vía `this.$extends({ query: ... })`.

### Guarda obligatoria de `ItemInstance -> WORLD_DROP`

- Interceptar `itemInstance.update` y `itemInstance.updateMany`.
- Si `data.location` (o `data.location.set`) cambia a `WORLD_DROP`, validar integridad **antes** de ejecutar la query.
- Si el ítem (o cualquier ítem afectado por `updateMany`) tiene hijos en `equippedSubItems`, abortar con error:
  - `INTEGRITY_NESTED_DROP_BLOCKED: move nested sub-items to inventory before WORLD_DROP.`

### Objetivo de seguridad

- Evitar pérdida u orfandad de sub-items anidados cuando un contenedor intenta migrar a drop de mundo.
- Mantener el flujo **server-authoritative**: el cliente no puede forzar mutaciones inválidas aunque intente enviar estados inconsistentes.

---

## 11. Inventarios de NPC mercaderes (data-driven)

### Fuente de verdad

- Catálogo de tiendas en `apps/server/config/npc-shops.json`.
- Cada entrada define `npcTemplateKey` + `offers[]`.
- Cada oferta define `catalogKey` y `buyPriceAdena`.

### Política de precios

- Compra al NPC: `buyPriceAdena` (Adena por unidad).
- Venta al NPC: `sellPriceAdena = floor(buyPriceAdena / 3)` (derivado, no duplicar manualmente en config).
- Las mutaciones de wallet e inventario se realizan en una única `$transaction` serializable.

### Integridad operativa

1. El NPC solo vende/compra ítems listados para su `npcTemplateKey`.
2. Si un `catalogKey` no existe en `ItemTemplate`, rechazar con error explícito (`ITEM_TEMPLATE_MISSING`).
3. El Ledger nunca confía en precios enviados por cliente; los resuelve desde catálogo data-driven.
4. Las operaciones validan distancia/zona autoritativas vía Warden antes de mutar economía.

### Contrato con Warden y Weaver

- **Warden:** expone `OPEN_MERCHANT_STORE` y valida rango antes de entregar ofertas.
- **Weaver:** muestra precios de `ack` autoritativo, sin lógica de precio local.

---

## 12. Impacto registrado — Item grades en catálogo

### Cambio de datos

`config/items.json` incorpora `grade` por plantilla con valores:

- `None`, `D`, `C`, `B`, `A`, `S`.

Para el kit de sub-slots de testing:

- `initiate_bracelet`: `D`
- `initiate_talisman_power`: `D`
- `initiate_talisman_swiftness`: `D`

### Persistencia

Para mantener compatibilidad de esquema actual de `ItemTemplate`, el grade se persiste en `ItemTemplate.baseStats.grade` durante el sync de catálogo (`item-catalog-upsert`).

Esto mantiene la estrategia data-driven sin exigir migración de Prisma en esta iteración.

---

## 13. Synthesis & Pity Logic

### Contrato de socket (Warden -> Ledger)

- Evento autoritativo: `REQUEST_SYNTHESIS { itemAId, itemBId }`.
- Pre-quote opcional para UI: `REQUEST_SYNTHESIS_QUOTE` (costo Adena + chance efectiva + estado de pity).
- El cliente solo envía intención; la resolución ocurre íntegramente en servidor.

### Validación atómica obligatoria

Dentro de una única transacción serializable:

1. Verificar propiedad de ambos `ItemInstance` por `ownerId`.
2. Verificar par válido: mismo `itemTemplateId`, mismo `synthesisLevel`, `itemAId != itemBId`.
3. Verificar ubicaciones permitidas:
   - principal: `INVENTORY` o `EQUIPPED`;
   - sacrificio: `INVENTORY`.
4. Verificar `maxSynthesisLevel` y tramo de tabla de síntesis.
5. Verificar saldo de wallet (`adena >= adenaCost`).

Si cualquier guarda falla: rollback completo, sin destrucción parcial.

### Secuencia de mutación (2x1)

1. Debitar Adena (`wallet.adena`).
2. Destruir ítem sacrificio.
3. Resolver éxito con RNG servidor + pity incremental.
4. Actualizar principal:
   - éxito: `synthesisLevel + 1`, pity -> `0`;
   - fallo: nivel sin cambio, pity -> `+1`.
5. Commit y respuesta reconciliada (`items`, `character`, `adena`).

### Pity incremental + garantía

- La chance efectiva se calcula por tramo:
  - `effective = min(100, baseSuccessPercent + pityCount * pityBonusPerFailPercent)`.
- Garantía hard-pity:
  - si `pityCount >= maxPityConsecutiveFails`, el intento se fuerza a éxito.
- Al éxito (natural o forzado), pity reinicia a `0`.

### Regla de oro de integridad

- Ningún ítem se destruye sin commit exitoso de la transacción en DB.
- El sacrificio se consume solo después de validar saldo y par de síntesis.
- Ante conflicto serializable (`P2034`), no hay commit parcial: reintento o error explícito.
