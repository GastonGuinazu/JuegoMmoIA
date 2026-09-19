# The Weaver — Renderizado 3D, red cliente y UI

**Runtime:** `apps/client` (**Angular 19** + **Three.js**).  
**Misión:** Presentar el mundo con **rendimiento estable** y **UX reactiva**, sin contradecir al servidor: predicción e interpolación son **solo capa de presentación**.

**Blueprint de referencia:** [05-combate-warden-weaver.md](../blueprint/05-combate-warden-weaver.md), más UI/flows económicos en [04](../blueprint/04-economia-dual-ledger.md).

---

## 1. Principios

1. **Autoridad:** daño, loot, trade exitoso, resultado de síntesis = siempre **confirmación servidor**.
2. **Separación:** la escena Three.js no contiene reglas de negocio; delega en servicios Angular (signals/store) que consumen DTOs de `libs/shared`.
3. **Presupuesto de frame:** shaders y post-procesos acotados; perfiles de calidad configurables.

---

## 1.b Skill: `EntityVisualFactory` — Punto único de creación de mallas

**Archivo:** `apps/client/src/app/game/entity-visual-factory.service.ts`.

`GameViewportComponent` **no construye geometría ni materiales**: pide visuales a la fábrica. Esto concentra la migración de primitivas a `.gltf`/`.glb` en un solo archivo.

| Responsabilidad de la fábrica | API |
|-------------------------------|-----|
| Crear visuales de entidad | `createPlayerVisual`, `createOtherPlayerVisual`, `createMobVisual(id, templateKey)` (cubo fallback + `.gltf` async vía catálogo), `createNpcVisual`, `createDropVisual` |
| Animación de mob | `setMobLocomotion`, `playMobAttack`, `playMobHit`, `playMobDeath` |
| Crear geometría de mapa | `createObstacleVisual` / `createPortalVisual` (AABB collider + `.glb` por `propTemplateKey`), `createGroundVisual`, `createGroundGrid` |
| Albedo de suelo | `applyGroundAlbedoForZone` según `groundAlbedo` en `world-zones.json` (pasto Zone_0, nieve Zone_1) |
| Tinte / flash por frame | `applyTint`, `resolveDropTint` |
| Rig de arma y glow por `plusLevel` | `ensureWeaponRig`, `applyWeaponGlow`, `getWeaponAnchor` |
| Liberar GPU | `disposeVisual` (recorre hijos: arma, aura, cuerpo, cabeza, visor) |

**Al migrar a modelos:** `EntityVisual` es `THREE.Object3D` (puede ser un `THREE.Mesh` simple o un `THREE.Group` compuesto); `mobTemplateKey` / `npcTemplateKey` ya viajan en los DTOs del Warden y son la clave natural del asset. El componente sigue llamando igual, así que el cambio no se filtra al resto del viewport.

## 1.c Impacto registrado — Dummy compuesto de personaje (pre-GLTF)

`createPlayerVisual` / `createOtherPlayerVisual` dejaron de usar `BoxGeometry` y ahora devuelven un `THREE.Group` (`createHumanoidDummy`) con:

- **Cuerpo:** `CylinderGeometry` (torso).
- **Cabeza:** `SphereGeometry` superpuesta al tope del cuerpo.
- **Visor:** pequeña `BoxGeometry` sobre el eje `+Z` de la cabeza, única pieza que rompe la simetría rotacional para poder distinguir el **facing** de la entidad a simple vista (mismo eje que usa el anclaje del arma en `ensureWeaponRig`).

Las tres mallas comparten una **única instancia de `MeshLambertMaterial`**, guardada en `group.userData['bodyMesh']`. `applyTint` la resuelve así: si el visual es un `Group` con `bodyMesh` en `userData`, tintea ese material (afecta cuerpo+cabeza+visor a la vez); si es un `Mesh` simple (mob/npc/drop/obstáculo/portal), tintea su material directamente. El footprint vertical (pies en `-BOX/2`, tope ≈ `+BOX/2`) se mantiene igual al de la caja anterior para no romper offsets calibrados (anclaje de arma, cámara, HP bar).

Es un placeholder intermedio: al integrar `.gltf`, este método es el único punto a reemplazar.

## 1.d Impacto registrado — Primer modelo `.gltf`: Lizard Man Warrior (jugador)

`createPlayerVisual` / `createOtherPlayerVisual` siguen devolviendo el `Group` del dummy (1.c) de forma **síncrona** (el spawn nunca espera una descarga de red), pero ahora disparan `attachGltfCharacterModel(group)`: una carga asíncrona best-effort que reemplaza los hijos primitivos del grupo por un clon del modelo real apenas termina de bajar. Si la carga falla, el dummy queda como está (nunca se rompe el render por un asset faltante).

**Asset:** `apps/client/public/models/characters/lizard_man_warrior/` (`scene.gltf` + `scene.bin` + `textures/`). Licencia **CC-BY-4.0** — atribución obligatoria, ver `license.txt` en esa carpeta (autor: Vasian-Digital3D vía Sketchfab). Cualquier lugar donde el proyecto liste créditos de terceros debe incluir esa atribución.

**Convención de carpetas para próximos modelos:** `apps/client/public/models/<characters|mobs|npcs|drops>/<nombre>/scene.gltf` (Angular sirve todo `public/` en la raíz del sitio, por eso la URL runtime es `/models/...`, sin el prefijo `public`).

Detalles técnicos de la integración (`entity-visual-factory.service.ts`):

- **Carga y caché:** un único `GLTFLoader` a nivel de servicio; la plantilla (`gltf.scene`) se descarga una sola vez por sesión de cliente (`loadPlayerGltfTemplate`, promesa cacheada) y nunca se inserta directo en la escena. Cada personaje visible clona la plantilla con `SkeletonUtils.clone` (necesario en vez de `Object3D.clone()` porque hay que re-bindear el `Skeleton` a los huesos clonados) para tener transform/pose independiente.
- **Memoria GPU compartida:** `geometry`/`material`/texturas quedan compartidos entre todos los clones (comportamiento default de `clone()`). Las mallas que vienen del `.gltf` se marcan con `userData['sharedGltfAsset'] = true`; `disposeVisual` nunca llama `.dispose()` sobre geometría/material/textura de esas mallas al despawnear un personaje (sólo libera el `Skeleton`, que sí es por-instancia). Si algún día se libera el asset completo (ej. logout total), hay que limpiar `playerGltfTemplatePromise` a mano — no lo hace ningún código hoy.
- **Normalización de escala/posición:** el asset trae escala/pivote arbitrarios de su DCC de origen. Tras clonar se calcula el `Box3` de las mallas "buenas" (ver filtro abajo) en espacio local del clon, se reescala uniformemente para que la altura total sea `PLAYER_MODEL_TARGET_HEIGHT` y se apoyan los pies en `-Y_LIFT`. Después del idle pose se alinea la pelvis (`Bip001_Pelvis_04`) al origen del host para que el hitbox/floaters caigan en el torso y no detrás de la cola.
- **Escala visual (`PLAYER_VISUAL_SCALE = 3`):** `PLAYER_MODEL_TARGET_HEIGHT = BOX * PLAYER_VISUAL_SCALE`. Confirmado en cliente que 1x (misma altura que el dummy) se veía chico contra el resto del mundo; 3x quedó bien. Es **puramente cosmético**: el hitbox/rango de ataque/colisión sigue gobernado por el servidor sobre el valor lógico `BOX`, ajeno a esta escala. `ensureWeaponRig` escala su `anchor` (posición + tamaño de arma/aura) por el mismo factor para que el arma no quede a la altura del tobillo del modelo agrandado.
- **Filtrado de mallas duplicadas/no deseadas:** el export trae **dos variantes fusionadas** (`"...01..."` alta calidad, `"...03..."` LOD) más un **arma soldada**. La variante `"03"` se oculta. El arma horneada (`/weapon/i` en el material) queda visible si hay ítem en `WEAPON`; si **no** hay ítem se oculta y se parenta el espadón `espadon_warrior` al hueso `Bip001_R_Hand_029`. El arma no entra en el bbox de escala del cuerpo. El cubo de `ensureWeaponRig` es fallback del dummy pre-GLTF y se oculta al cargar el lizard.
- **Paperdoll de arma:** `applyPaperdollWeapon({ equipped, plusLevel })`. El `.gltf` del espadón es un prop (se descartan luces/cámara/clips de Sketchfab); no anima por su cuenta, sigue la mano. Glow de `plusLevel` por emissive del arma (sin esfera additive). Contrato: `weaponEquipped` en `player-visual-state` / snapshot (self también lee inventario local).
- **Facing:** `PLAYER_MODEL_YAW_OFFSET` (constante, hoy en `0`) corrige si el modelo no queda mirando hacia `+Z` (mismo eje que el visor del dummy y el anclaje de arma). Ajustar en cliente y en múltiplos de `Math.PI / 2` si el personaje se ve de espaldas/de costado.
- **Material `KHR_materials_pbrSpecularGlossiness`:** este export usa el workflow spec/gloss, que three.js **dejó de soportar nativamente** (deprecado por Khronos). En vez de reconvertir el archivo offline (`@gltf-transform/cli`) se agregó un plugin liviano de compatibilidad (`gltf-spec-gloss-compat.ts`) que registra un `GLTFLoaderPlugin` para mapear `diffuseFactor/diffuseTexture → color/map` y aproximar `glossinessFactor → roughness` sobre un `MeshStandardMaterial` estándar (sin sub-clasear materiales ni tocar shaders a mano: la extensión original de three.js pre-r140 dependía de un helper GLSL y de campos de `PhysicalMaterial` que ya no existen). Se pierde el detalle fino del mapa specular/glossiness; se conserva color, textura difusa y normal map, que es lo que más pesa visualmente.
- **Tinte (`applyTint`):** ya no asume `MeshLambertMaterial` único (`bodyMesh`). `resolveTintableMaterials` soporta además `userData['tintMeshes']` (array de mallas del `.gltf`, cada una con su propio `MeshStandardMaterial`) vía duck-typing (`color`/`emissive`/`emissiveIntensity`) en vez de `isMeshLambertMaterial`, así el flash de daño sigue afectando a todo el personaje cargado. En modelos `.gltf` **no** se pinta el albedo (`color`) cada frame: eso dejaba al lizard azul sólido. El flash de hit/heal usa sólo `emissive`.
- **Animación (gated por intención, no loop infinito):** el asset trae **un solo clip** `"Motion"` de 28.55 s con idle, caminata, golpes y un salto concatenados (export Sketchfab típico). `CharacterAnimRig` (`character-anim-rig.ts`) lo recorta con `AnimationUtils.subclip` a cuatro ventanas data-driven (`PLAYER_ANIM_WINDOWS`): **idle** (loop, 14.6–16.6), **walk** (loop, 5.7–6.9), **attack** (one-shot, 0.5–1.1) y **skill** (one-shot, 7.7–8.95, el salto). El viewport no habla con mixers: pide `setCharacterMoving(visual, moving)` (click-to-move local / desplazamiento visible de otros jugadores) y `playCharacterCombatAnim(visual, 'attack' | 'skill')` al confirmar `attack-mob-result` / `skill-hit-result`. Un golpe no se cancela si el personaje sigue caminando; al terminar el one-shot el rig vuelve solo a walk o idle. Power Strike y Rageful Blow comparten el clip `skill` (el asset no trae uno por habilidad). Root motion de cadera: se congelan **X/Z** de `Bip001_03.position` (plano horizontal Y-up) para que el modelo no se deslice respecto del `host`; se deja **Y** para el bob de idle y el salto de skill. Congelar X/Y y dejar Z desplazaba la piel delante del origen y el hit quedaba atrás. `tickAnimations` ahora avanza `CharacterAnimRig`s, no mixers crudos.

## 1.e Terreno base y grid de testeo

`createGroundVisual` arma un `PlaneGeometry` del `groundSizeMeters` de la zona (default **128**, no 256) rotado `-PI/2` en X, **Y = 0**. Los pies del dummy/gltf viven en `-Y_LIFT` sobre un host en `visualPos.y + Y_LIFT`, así que con spawn `y: 0` el personaje apoya en el plano.

Albedo por zona (`world-zones.json` → `groundAlbedo`, archivos en `/models/textures/`): Pradera `ground_grass_0.jpg`, Valle Congelado `ground_snow_1.jpg`. El catálogo se lee al boot; **el JSON/GLB/albedo de Zone_1 no se pide hasta** `ensureZoneLoaded('Zone_1')` (clic de portal en rango, o snapshot si el personaje ya está en el valle). Tiling `RepeatWrapping` a ~4 m por tile (`size/4`; 128 → 32×32) y color `0xffffff`. El viewport llama `applyGroundAlbedoForZone` + `setPlayableGroundSize` al reconciliar la zona.

`createGroundGrid` superpone un `GridHelper` (~2 u/celda, un pelo sobre Y=0) para percibir velocidad; no entra al raycast. El click-to-move sigue pikando sólo el plano.

## 1.e2 Props de entorno (Nature + Ruins)

Subset CC0 Quaternius en `/models/props/*.glb` (`manifest.json` + `prop-visual-catalog.ts`). Packs completos en `_raw/quaternius/` (no se sirven). `createObstacleVisual` / `createPortalVisual` arman un `Group`: collider AABB (fallback semitransparente; invisible si el GLB carga) y un clon cacheado del `.glb` (`loadPropGltfTemplate` + `clone(true)`: geometría/material GPU compartidos). Árboles/rocas/arbustos con AABB casi cúbico aplican `heightFitVisualMultiplier` (0.6–1.35) desde el scale del JSON. Fit `height` (copa puede sobresalir del hitbox). Columnas/muros/arcos/carreta usan fit `aabb`. Yaw visual no rota la colisión del Warden. El GLB de obstáculo tiene `raycast` vacío; click-to-move pica sólo el suelo. Losetas `floor_path` no proyectan sombra; el resto de props sí (micro-deco incluida).

`blocksMovement: false` (losetas `floor_path` y micro-deco `bush`/`stump`/`log`/`rock_b`): collider invisible, sin raycast; no entra a `obstacleRects` ni al AABB del Warden. La cámara las ignora. El click-to-move pica el plano.

Puesto del mercader: props `cart`/`barrel`/`chest`/`torch`/`pot` alrededor de (5, 5). `createNpcVisual` arma un `Group` (cubo verde fallback + `PointLight`). `npc-visual-catalog.ts` carga el trader (`/models/npcs/trader/`, CC-BY-4.0 by__Rx) y el cofre compañero (`/models/npcs/traderBox/`, CC-BY-4.0 Dasamura) con el mismo `npcInstanceId`: clic en cualquiera abre la tienda y dispara el clip `Opening` del cofre. Al cerrar el panel (o alejarse / ack fallido) el clip corre al revés y la tapa cierra. Idle Mixamo del trader en loop. Cubo verde sólo si faltan los `.gltf`.

Portales: además del arco, `attachPortalInteriorFx` pone un velo `ShaderMaterial` additive (óvalo cian con pulso) y un `PointLight` en el hueco. El velo no escribe depth; el picking de viaje sigue andando (lleva `portalId`). `tickAnimations` avanza `uTime`. Dos luces por zona (ida/vuelta); sin sombras. El fade de transición **sólo** arranca si el jugador está dentro de `interactionRadiusMeters` (default 4, mismo predicado que el Warden); si no, log + click-to-move hacia el portal, sin overlay.

## 1.f Mobs `.gltf`

`createMobVisual` sigue siendo síncrono: un `Group` con cubo rojo (fallback + collider de picking) y una `PointLight` de aggro apagada. Si `mobTemplateKey` está en `mob-visual-catalog.ts`, se clona el `.gltf` con `SkeletonUtils.clone` (geometría/material compartidos) y un `MobAnimRig` por instancia. El fit de escala usa un **holder** (no pisa el matrix Sketchfab del root): se aplica el primer frame de idle, se mide el AABB **skineado**, se ignoran decals planos, y se escala el holder a `targetHeight`. Mixamo (goblin) deja la cadera a decenas de unidades en el clip; medir bind pose sin skin subestima la altura y el modelo sale titán.

| `spider` / `spider2` | `models/mobs/spider/` | **0.5**, `yawOffset = π` | Mismo `.gltf` (walk / run / Attack / die). `spider2` es el pack SO lvl 12; el SE sigue en `spider` lvl 10. |
| `skeleton` | `models/mobs/skeleton/` | 1.0 | idle / walk / attack |
| `goblin` | `models/mobs/goblin/` | 1.0 | `G_Idle*` / `G_Walk` / `G_Attack` |
| `goblin2` | `models/mobs/goblin2/` | 1.0 | Idle / WalkForward / RunForward / **sólo** `AttackPower01` (DodgeStrike iba y venía) |
| `scorpion` | `models/mobs/scorpion/` | **0.7**, `yawOffset = 0` | Idle / Walk / Area Attack / Death |
| `zombie` | `models/mobs/zombie/` | 1.0 | idle / walk / attack / death |
| `zombie2` | `models/mobs/zombie2/` | 1.0 | un solo clip (`Take 001`): ataque; idle = primer frame congelado |
| `ogre` | `models/mobs/ogre/` | 1.0 | idle / **walk** (sin run: el clip run es un salto) / attack / death |
| `bull_fighter` | `models/mobs/bullfighter/` | **0.85** | stand `bstd` / atk / die (sin walk limpio) |
| `silver_dragonkin` | `models/mobs/silverdragonkin/` | 1.0 (alto) | Std / Walk / **Run01** (chase) / Atk01–03 (sin Atk04 de 6 s) / Die; `freezeRootY` en pelvis |

Facing: yaw 0 del Warden mira +Z. El spider de Sketchfab mira −Z → `yawOffset = π`. Escorpión y el resto arrancan en `0`.

Root motion: `MobAnimRig` congela **sólo** tracks de pelvis/hips/root (`freezeRootMotion`). Congelar `.position` de pies/IK convertía walk/run en saltitos (ogro, dragonkin, goblin2).

Clips empaquetados (Sketchfab/Lineage): Walk/Idle/Run del dragonkin viven en t=54–65 de un clip con `duration` 65 s. `normalizePackedClipTimeline` recorta la ventana real de keys y la desplaza a t=0; si no, el mixer sostiene la primera pose casi un minuto (el boss “no camina”).

Locomoción: walk/run según **velocidad visual** de la malla (histeresis ~0.55 / 0.22 m/s). El visual **no persigue** el último `mob-moved`: `MobVisualInterp` dibuja ~90 ms en el pasado interpolando entre muestras (y extrapola ≤140 ms si el siguiente paquete tarda). Perseguir el auth frenaba la malla entre ticks y se veía como walk a trompicones. Snap duro si un sample salta ≥ 8 m (leash/respawn). El swing lo dispara `mob-melee-result` **siempre**. Un Attack en curso **no** se cancela si el visual sale un frame del rango.

Aggro: **no** se pinta el albedo ni el emissive naranja del `.gltf`. Feedback = `!` flotante + luz puntual suave en la base.

`mob-respawn`: `mixer.stopAllAction()`, reset del clip Death e Idle inmediato (`resetMobVisualAfterRespawn`) para que la malla no quede en pose de cadáver.

Daño por clip de ataque: un `pAtk` por template (Warden). Varios clips de ataque del `.gltf` se intercalan sólo visualmente.

---

## 2. Skill: `ShaderMaster` — Glow por nivel de síntesis

### Objetivo

Visualizar la **potencia de síntesis** del equipo mediante **emisión / rim light** coherente en modelos 3D, **data-driven** por `synthesisLevel` (1–10).

### Diseño técnico

| Componente | Responsabilidad |
|------------|-----------------|
| **Material pipeline** | Capa de emisión en mesh/skinned mesh; evitar recompilar shaders por frame. |
| **Tabla visual** | Mapeo `synthesisLevel → { color, intensity, pulse? }` cargado desde JSON estático o endpoint de config. |
| **Instancing** | Para muchos jugadores/mobs, preferir uniforms por instancia o atlas de materiales limitado. |
| **Sincronización** | Al recibir actualización de ítem equipado (evento red o snapshot), actualizar **solo** el uniform asociado al slot visual. |

### Rendimiento

- LOD: reducir intensidad o desactivar glow en distancia larga.
- Mobile/web: fallback a **glow billbboard** o anillo simple si `gpuTier` bajo.

---

## 3. Skill: `NetPredictor` — Predicción e interpolación

### Objetivo

Reducir la sensación de latencia en movimiento y en **ataques cosméticos** sin desalinear el estado autoritativo.

### Predicción (cliente)

| Área | Política |
|------|----------|
| Movimiento | Aplicar input local inmediatamente; al recibir snapshot del tick, **reconciliar** con suavizado (lerp corto o rewind mínimo). |
| Ataques | Opcional: animación de wind-up local; **no** mostrar daño numérico final hasta ACK del servidor. |
| Secuencia | Usar `serverTick` + `intentSequence` expuestos por el Warden para descartar estados obsoletos. |

### Interpolación

- Entidades remotas: buffer de estados 1–2 ticks; interpolar posición/rotación entre muestras conocidas.
- Mobs: `MobVisualInterp` (`mob-visual-interp.ts`) — delay 70 ms, lerp entre `mob-moved`, extrapolación ≤ 180 ms. El Warden emite pose desde RAM a 20 TPS (sin UPDATE Prisma por tick).
- Extrapolación limitada (<100–150 ms) para evitar “teleport” suave que oculte errores graves.

### Corrección

- Si divergencia > umbral (`maxPositionError`), **snap** autoritativo sin animación larga en competencia PvP.

### Rendimiento de frame (prueba Weaver)

Tres cambios reversibles para el hitch al pegar/matar (el loop del Warden no se toca):

1. Effects separados: el mapa (`reconcileMapObstacles`) ya no corre cuando cambia el HP de un mob.
2. Daño/XP/heal/loot: sprites Three.js con pool (`world-combat-floaters.ts`), sin `div` CSS2D ni rAF extra. Barras de HP de mobs siguen en CSS2D.
3. Cámara: ray vs AABB de `obstacleRects` (lo que bloquea movimiento). No recorre el bosque en `intersectObjects`.

Si no convence, revertir `game-viewport.component.ts` + borrar `world-combat-floaters.ts`.

---

## 4. Skill: `UI-Signals` — Interfaz moderna y flujos de juego

### Objetivo

UI **minimalista**, legible y reactiva con **Angular Signals** (y/o control flow moderno), cubriendo flujos críticos de sesión.

### Áreas funcionales

| Módulo | Comportamiento |
|--------|----------------|
| **Auto-Hunt** | Configuración local + confirmación servidor al activar (si el servidor valida zona/rango); mostrar estado claro (ON/OFF, target prioridad). No ejecutar lógica de combate en cliente. |
| **Perfiles de equipamiento (Swapping)** | Conjuntos guardados (build PvE/PvP); al aplicar, enviar **intención** de cambio de equipamiento; UI en “loading” hasta snapshot de stats/ítems confirmado. |
| **Economía** | Mensajes explícitos para CAP F2F de Adena, errores de subasta y síntesis fallida. |
| **Dungeon diaria** | Contador de tiempo restante, aviso pre-expulsión, feedback de **expulsión PvP** (sin mostrar karma cambiado). |

### Estándar visual

Seguir lineamientos de producto **family-friendly**: contraste alto, iconografía clara, sin dependencia de color como única señal (accesibilidad).

### Inventario Paperdoll + Sub-slots (Signals)

- Estado UI recomendado:
  - `equippedBySlot` (mapa de paperdoll).
  - `activeSubSlotRoot` (contenedor cuyo popover está activo).
  - colección de `subItems` por `parentItemInstanceId`.
- Interacción:
  - hover/click en slot contenedor abre popover adyacente;
  - clic derecho en hijo equipado ejecuta intención de desequipar;
  - ítems de mochila con `parentSlotType` equipan en sub-slot activo compatible.
- Feedback visual:
  - marcador/borde azul en contenedor con hijos;
  - tooltip del contenedor incluye lista de talismanes internos.
- Regla de autoridad:
  - el popover es puramente visual; la validez final de `EQUIP_ITEM` la confirma el Warden.

---

## 5. Contratos de datos

- DTOs compartidos desde `libs/shared`: no duplicar interfaces TS divergentes entre módulos.
- Versionado de protocolo: campo `schemaVersion` en payloads críticos si el juego evoluciona en beta.

---

## 6. Integración por agente

| Agente | Rol del Weaver |
|--------|----------------|
| **Warden** | Consumir eventos de combate y estado de entidades; nunca recalcular `CombatResolver`. |
| **Ledger** | Formularios de AH/síntesis/trade; reflejar rollback como error UX. |
| **Cartographer** | Cargar assets de mapa/instancia; transiciones de portal y pantallas de carga. |

---

## 7. Pruebas recomendadas

- E2E ligero: flujo “equipar → glow visible”; “mover → corrección servidor”.
- Pruebas de componentes: signals y estados de CAP/trade sin llamar API real (mocks).

---

## 8. Impacto registrado — Interacción con mercaderes

### Regla de input

- **Clic izquierdo** sobre NPC con `npcRole = MERCHANT`: enviar `OPEN_MERCHANT_STORE`.
- **Clic derecho** en viewport: movimiento manual, sin abrir tienda.
- El cliente abre panel solo tras ack `ok: true`.

### Conflicto de eventos UI

- El `contextmenu` del inventario queda restringido a acciones de inventario.
- La apertura de tienda no depende de clic derecho, evitando bloqueo cruzado entre inventario y NPC.
