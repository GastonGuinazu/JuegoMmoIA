# 04 — Economía dual y comercio (The Ledger)

**Agente:** The Ledger (`MarketBroker`, inventario, monedas).  
**Relacionado:** síntesis (01), karma/drops (02).

## Objetivo de diseño

Separar el **grinding cotidiano** de la **progresión de alto valor** mediante dos monedas con **fuentes y sumideros** distintos, y forzar el intercambio de **ítems de equipo valiosos** por un **mercado asíncrono** (subasta) para trazabilidad, equidad y anti-estafa.

## Monedas

### Adena

| Aspecto | Definición |
|---------|------------|
| **Origen** | Drop **común** de mobs, quests, venta de chatarra a NPC, recompensas de bajo valor. |
| **Usos** | **Consumibles** (pociones, scrolls, materiales comunes), reparaciones, teleports, costes base de algunos servicios. |
| **Carácter** | Líquida, inflación controlada por sumideros (impuestos NPC, fees suaves donde aplique). |

### Aether-Shards

| Aspecto | Definición |
|---------|------------|
| **Origen** | Drop **raro**, logros, mazmorras diarias de alto riesgo, desmantelamiento selecto, eventos. |
| **Usos** | **Joyería** de alto tier, **síntesis avanzada**, slots especiales, cosméticos con stat (si existen), fees premium de mercado. |
| **Carácter** | Escasa; actúa como freno y progresión horizontal “premium”. |

## Reglas de comercio entre jugadores

### Prohibición de intercambio cara a cara de equipo

- El **equipamiento** (armas, armaduras, accesorios de personaje con `gearSlot` definido) **no** puede transferirse por **trade directo jugador–jugador** (ventana de intercambio F2F).
- Objetivo: eliminar scams, RMT facilitado y duplicación de estados ambiguos; centralizar el flujo en sistemas auditables.

### Excepciones (definir en datos)

- Si el diseño permite F2F para **consumibles** o **materiales no equipables**, debe listarse en `tradeable_categories_f2f`.
- Cualquier excepción a la regla de equipo debe ser **explícita** y aprobada en diseño.

### CAP diario de Adena en trade F2F (anti-bots / anti-RMT)

**Requisito de producto:** el intercambio **cara a cara** de **Adena** debe estar **capado por cuenta y por ventana diaria** para impedir el **vaciado masivo** de oro mediante cuentas automatizadas o circuitos de RMT de baja fricción.

| Aspecto | Especificación |
|---------|----------------|
| **Alcance** | Cuantía neta de **Adena** que una **cuenta** puede **transferir o recibir** vía ventana F2F en un **día calendario** (UTC o `timezone_server`, igual que otros resets). |
| **Contabilidad** | Trackear **saliente** y **entrante** por cuenta, o solo **saliente** según política anti-evasión; lo crítico es que el **volumen diario movido por F2F** no pueda superar `f2f_adena_daily_cap_per_account` sin bloqueo. |
| **Umbral** | Valor **data-driven** (ej. millones de Adena); revisable sin deploy si vive en DB o config versionada. |
| **Al exceder CAP** | Rechazar la transacción F2F **antes** de mutar inventarios; código de error explícito para UI (“límite diario de comercio directo alcanzado”). |
| **Exclusiones** | El CAP **no** aplica a **subasta**, **mail del sistema**, **NPC**, **quests** ni otros canales: solo al pipeline **`F2F-Security` / trade directo**. |
| **Telemetría** | Log de intentos rechazados, cuentas en el límite y distribución de volúmenes para ajustar el CAP. |

> **Principio:** el F2F existe solo para **ítems esenciales** (consumibles/materiales permitidos); aun así, la Adena puede usarse como contraparte — ese vector debe ser **numéricamente acotado** cada 24h.

## Subasta asíncrona obligatoria para ítems de valor

### Definición

- Los ítems que superen un **`auctionThreshold`** (por `valueScore`, rareza o lista de `itemIds`) **solo** pueden cambiar de dueño mediante el **sistema de subasta** del juego.
- La subasta es **asíncrona:** duración de listado configurable; pujas procesadas en servidor; notificaciones al vendedor/comprador al cerrar.

### Flujo resumido

1. Jugador lista ítem → servidor congela ítem en **depósito de subasta** (no usable ni equipable mientras tanto).
2. Otros jugadores pujan con **Adena** y/o **Aether-Shards** según categoría del ítem (tabla `auction_currency_rules`).
3. Al expirar el listado, el servidor adjudica al mejor postor, transfiere ítem y fondos de forma **atómica**.
4. Si no hay pujas válidas, el ítem vuelve al vendedor con fee opcional.

### Integridad (Ledger)

- Transacciones DB con **bloqueo optimista/pesimista** sobre filas de ítem y wallet.
- **Impuesto / comisión** configurable como sumidero de Adena/Shards.
- **Historial** de ventas para soporte y detección de abusos.

## Relación con síntesis y drops

- La síntesis consume **sacrificio** y monedas según manual 01; rangos altos pueden exigir **Aether-Shards**.
- Los drops de equipamiento valioso entran al inventario del ganador; si quiere venderlos, deben pasar por **subasta** si cruzan el umbral.

## Free-tier y Supabase

- Listados de subasta y wallets deben diseñarse con **índices** y **paginación** para no explotar lecturas/escrituras en tier gratuito.
- Jobs de cierre de subastas pueden agruparse por tick o cron ligero.
