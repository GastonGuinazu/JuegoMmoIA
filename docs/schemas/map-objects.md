# Schema — Map Objects (Muros/Obstáculos)

Fuente de datos: `apps/server/config/map-objects-Zone_*.json`.

## Objetivo

Definir obstáculos estáticos del mundo que bloquean movimiento de personajes (Warden) y se renderizan en cliente (Weaver).

## Estructura JSON

```json
{
  "version": 1,
  "objects": [
    {
      "id": "string-unique",
      "zoneId": "Zone_0",
      "kind": "box",
      "propTemplateKey": "column_round",
      "yaw": 0,
      "position": { "x": 0, "y": 1, "z": 0 },
      "scale": { "x": 1.2, "y": 2, "z": 1.2 },
      "collisionPaddingMeters": 0.1
    }
  ]
}
```

## Campos

- `version`: versión de schema/config.
- `objects`: lista de obstáculos y portales.
- `objects[].id`: identificador único.
- `objects[].zoneId`: zona; si no está, aplica a todas.
- `objects[].kind`: `box` (AABB, sin rotación de colisión) o `portal`.
- `objects[].position`: **centro** del AABB en mundo. Con `y = scale.y / 2` la base queda en el suelo.
- `objects[].scale`: dimensiones del volumen de colisión (metros). No rota.
- `objects[].collisionPaddingMeters`: margen extra XZ.
- `objects[].propTemplateKey`: clave Weaver (`prop-visual-catalog.ts` → `/models/props/*.glb`). El Warden ignora el mesh.
- `objects[].yaw`: yaw **visual** en radianes. No gira el AABB.
- `objects[].blocksMovement`: default `true`. Con `false` el AABB **no** bloquea (senderos de loseta). El Weaver igual pinta el `.glb`; click-to-move y cámara atraviesan.

Assets: subset Nature + Ruins en `apps/client/public/models/props/` (`manifest.json`). Dumps OBJ en `_raw/quaternius/` (no se sirven). Puesto del mercader: `cart`, `barrel`, `chest`, `torch`, `pot`. Senderos: `floor_path`.

## Reglas de validación runtime

- El servidor valida cada intento de movimiento contra el AABB (no contra el GLB).
- Si el segmento entra a un obstáculo, se recorta al borde seguro.
- Si falta el `.glb`, el Weaver deja el AABB semitransparente.
- El cliente puede previsualizar colisión; la autoridad final sigue en servidor.
