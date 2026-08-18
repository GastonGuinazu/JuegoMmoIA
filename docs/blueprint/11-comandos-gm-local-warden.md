# 11 — Comandos GM (desarrollo local, The Warden)

**Agente:** The Warden (validación autoritativa + permisos).  
**Ledger:** mutaciones de inventario / ítems bajo las mismas reglas que el resto del juego.  
**Weaver:** envía **intenciones** por Socket.IO y muestra feedback en el log de sistema; **no** aplica stats en cliente sin ACK.

## Objetivo

Permitir QA y tuning de mecánicas de alto nivel (brillo +7, inventario, nivel / puntos de núcleo, karma → drop rojo) **sin grind**, manteniendo el principio **server-authoritative**.

## Permisos

- Campo persistido `Character.isAdmin` (boolean, default `false`).
- Evento Socket.IO `execute-gm-command` con cuerpo `{ command: string, args?: string[] }`.
- El servidor **rechaza** cualquier comando si `isAdmin` es falso (`GM_FORBIDDEN`).
- Otorgar admin en DB (ejemplo local):

```sql
UPDATE "Character" SET "isAdmin" = true WHERE id = '<uuid-del-personaje>';
```

## Comandos soportados (v1)

| Comando | Args | Efecto |
|---------|------|--------|
| `setplus` | `<GearSlot>` `<plusLevel>` | Ajusta `synthesisLevel` del ítem **equipado** en el slot top-level (`plusLevel` 0-based; `synthesisLevel = plus + 1`). Clamp según `config/synthesis-tiers.json`. |
| `giveitem` | `<templateId \| catalogKey>` `<quantity>` | Crea instancias en **INVENTORY** (misma lógica de stack que tienda NPC). |
| `setlevel` | `<level>` | Fija nivel, pone EXP de barra en `0`, suma/resta `availableStatPoints` según delta de nivel × `statPointsPerLevel` en `config/experience-curve.json`. |
| `setkarma` | `<karmaPoints>` | Persiste `karmaPoints` y recalcula `karmaTier` vía `PenaltyManager.getKarmaTierFromPoints` (p. ej. `-120` → rojo según `karma-rules.json`). |

Los nombres de comando son **case-insensitive**; el `/` inicial en cliente es opcional.

## Contrato de red

- **Cliente → servidor:** `EXECUTE_GM_COMMAND` / `execute-gm-command`.
- **Ack:** `{ ok: true }` o `{ ok: false, code, message }`.
- Tras éxito, el Warden emite los mismos refrescos que otras mutaciones cuando aplica: `PLAYER_STATS_UPDATE`, `PLAYER_VITALS`, y si corresponde `LEVEL_UP`, `player-visual-state` (plus / karma).

## Weaver — feedback

- La barra de comandos GM solo se renderiza si `CharacterSheetDto.isAdmin === true` (dato HTTP autoritativo). **Tecla `Y`:** muestra u oculta esa barra; jugadores sin admin no tienen la barra ni reciben toggle (el servidor sigue siendo la única autoridad para ejecutar GM).
- Tras `ok: true`, el log de sistema debe mostrar: `[GM] Comando ejecutado con éxito`.
- Errores: prefijo `[GM]` + mensaje del servidor.

## Impacto

- **Inventario / síntesis:** `setplus` invalida stats derivados como un cambio de equipo.
- **Karma / PvP:** `setkarma` afecta flags visuales y tablas de drop en muerte (ver blueprint 02).
- **Progresión:** `setlevel` alinea puntos de núcleo con la curva documentada en blueprint 03.

**Producción:** mantener `isAdmin` solo en cuentas de staff; no exponer la barra GM en builds finales si el producto no lo requiere.
