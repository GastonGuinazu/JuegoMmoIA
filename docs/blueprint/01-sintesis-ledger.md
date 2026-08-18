# 01 — Sistema de síntesis (The Ledger)

**Agente:** The Ledger (`SynthesisEngine`).  
**Dependencias:** inventario atómico, definición de ítems, moneda Aether-Shards (síntesis avanzada, ver manual 04).

## Objetivo de diseño

La síntesis es un **consumo de dos ítems** para producir **un único resultado** sobre el ítem principal, elevando su **nivel de síntesis** (1–10). El sistema debe ser predecible en el largo plazo gracias al **pity** (éxito garantizado tras una racha de fallos), sin eliminar la tensión del riesgo a corto plazo.

## Regla 2×1 (lógica nuclear)

| Rol | Comportamiento |
|-----|----------------|
| **Ítem principal (target)** | Es el que recibe el intento de subida de nivel. **Conserva sus stats aleatorios** (rolls, bonus, identidad del ítem) salvo que una tabla de datos explícita indique recalculo para ciertos tipos. |
| **Ítem sacrificio** | Se **destruye siempre** al confirmar el intento de síntesis (éxito o fallo). No se recupera. |
| **Resultado** | Un solo ítem en inventario: el principal, con nivel de síntesis actualizado o sin cambio según el resultado. |

### Flujo autoritativo (resumen)

1. El cliente envía **intención**: IDs de principal y sacrificio, nivel objetivo implícito (siguiente nivel) o explícito según implementación.
2. El servidor valida: compatibilidad de pares, nivel actual, costes (Adena / Shards si aplica), espacio de inventario, estado del jugador (no en combate bloqueado, etc.).
3. Se consume **sacrificio** y **costes** de forma **atómica**.
4. Se calcula éxito con RNG de servidor + pity.
5. Se persiste el principal actualizado o se deja nivel sin cambio en fallo.
6. Se notifica resultado al cliente.

## Niveles de síntesis (1–10)

- El **nivel de síntesis** es un entero de **1 a 10** asociado al ítem principal (no confundir con nivel de personaje).
- Cada transición `N → N+1` tiene una **probabilidad base** definida en datos (`synthesis_tier_probability` o equivalente).
- El nivel 10 es **tope**: no existe intento `10 → 11`.

### Tabla de probabilidades base (plantilla data-driven)

Los valores siguientes son **plantilla de balance**; la implementación debe leerlos desde configuración/DB.

| Nivel actual → siguiente | Probabilidad base de éxito (%) | Pity: fallos consecutivos máx. antes de éxito forzado |
|--------------------------|--------------------------------|--------------------------------------------------------|
| 1 → 2 | 85 | 4 |
| 2 → 3 | 75 | 5 |
| 3 → 4 | 65 | 6 |
| 4 → 5 | 55 | 7 |
| 5 → 6 | 45 | 8 |
| 6 → 7 | 35 | 10 |
| 7 → 8 | 25 | 12 |
| 8 → 9 | 15 | 15 |
| 9 → 10 | 10 | 20 |

**Notas de diseño:**

- A mayor riesgo, **pity más largo** para evitar frustración extrema en rangos altos.
- Opcional: multiplicadores por **rareza del ítem** o **tipo** (espada vs joya) como columnas adicionales en la misma tabla.

## Sistema Pity (éxito garantizado tras X fallos)

### Definiciones

- **Contador de pity** por ítem principal (o por “slot de síntesis” del jugador — decisión de implementación; recomendado **por ítem** para claridad).
- **Fallo consecutivo:** intento válido donde el RNG indica fallo **después** de consumir sacrificio.
- Al **éxito** (natural o forzado), el contador de pity del ítem **se reinicia a 0**.

### Reglas

1. En cada intento `N → N+1`, si `fallos_consecutivos >= X` definido para ese tramo, el servidor **fuerza éxito** (no se tira RNG de fallo).
2. Si el RNG hubiera dado éxito antes de alcanzar X, cuenta como éxito normal y reinicio de pity.
3. El pity es **por transición de nivel** (recomendado): al pasar de 5→6 se usa la fila 5→6 para probabilidad y para X.

### Transparencia para el jugador (UX / Weaver)

- Mostrar en UI el **progreso hacia garantía** (p. ej. “Próximo intento garantizado tras N fallos” o barra abstracta) según política de producto — sin filtrar semillas RNG.
- Implementado en Weaver: indicador visual `+N` en esquina superior derecha del ícono del ítem en mochila/paperdoll, legible sin abrir tooltip.
- Implementado en Weaver: tooltip con título `Nombre del Ítem +N` cuando `plusLevel > 0`, manteniendo color por grado.
- El tooltip debe mostrar el valor real ya escalado por síntesis para stats planos (ej. `P.Atk: 11 (+1)`), usando datos autoritativos del servidor.

## Conservación de stats aleatorios del principal

- Los **atributos aleatorios** del ítem principal (daño, defensa extra, opciones, etc.) **no se rerollean** por el mero hecho de sintetizar.
- Solo se actualizan campos explícitos del resultado de síntesis (típicamente `synthesisLevel` y, si el diseño lo exige, `itemTier` o flags visuales).
- Si en el futuro existen síntesis que **sí** rerollean opciones, deben ser **tipos de receta** distintos en datos, no el comportamiento default.

## Anti-abuso e integridad

- Validar que el sacrificio cumple **reglas de par** (misma familia, rareza mínima, etc.) según tablas de receta.
- **Idempotencia:** cada solicitud lleva token o secuencia para evitar doble submit desde el cliente.
- **Log de auditoría:** intentos, resultado, ítems involucrados y snapshot de pity para soporte y detección de anomalías.

## Interfaz con economía dual

- La síntesis **básica** puede costar principalmente **Adena**; la **avanzada** (rangos altos o tipos especiales) puede exigir **Aether-Shards** además del sacrificio. Detalle de costes en [04-economia-dual-ledger.md](./04-economia-dual-ledger.md).
