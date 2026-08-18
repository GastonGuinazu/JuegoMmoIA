# 10 — Visual Enchant & Status (The Weaver)

**Agente:** The Weaver (`ShaderMaster`, `UI-Signals`, `NetPredictor`).  
**Relacionado:** combate (05), karma y drops (02), manual Weaver (`docs/agents/the_weaver.md`).

## Objetivo de diseño

Alinear la identidad visual del riesgo PvP y progresión de equipo con datos autoritativos del servidor, sin mover reglas de negocio al cliente.

## Glow de encantamiento por `plusLevel`

### Paleta visual oficial

| Tramo de plus | Lectura de jugador | Color principal | Aura |
|---------------|--------------------|-----------------|------|
| `+1..+3` | Mejora inicial | Blanco frío | Halo blanco tenue |
| `+4..+6` | Mejora intermedia | Azul | Halo azul energético |
| `+7+` | Mejora alta | Dorado / fuego | Halo naranja-dorado intenso |

### Regla de aplicación

- El glow no se calcula por cliente desde fórmulas ocultas: se aplica con el `weaponPlusLevel` recibido por socket.
- **Paperdoll:** con ítem en slot `WEAPON` se muestra la espada horneada del lizard; sin ítem se oculta esa malla y se parenta el `.gltf` de arma (`espadon_warrior`) al hueso de la mano. El clip de ataque es siempre el del personaje.
- El plus no usa esfera additive (se veía como bola naranja en la empuñadura). En `.gltf` el glow va por `emissive` del material del arma visible.

### Acople al mesh durante animación

- The Weaver parenta el mesh de arma (horneada o paperdoll) al esqueleto del personaje.
- El glow de plus se aplica sobre el material del arma visible (horneada o espadón).
- El swing de combate lo resuelve la animación de esqueleto (`attack` / `skill`); ya no se rota un cubo suelto.

## Estado visual de PvP por nombre

### Contrato visual de flags

| Flag | Color de nombre | Significado |
|------|-----------------|-------------|
| `WHITE` | Blanco | Estado limpio |
| `PURPLE` | Púrpura | Agresor/intermedio |
| `RED` | Rojo | Criminal / alto riesgo |

- El color del nombre es señal primaria, pero debe mantener legibilidad (family-friendly y alto contraste).

## Evento de red `player-visual-state`

### Propósito

Sincronizar en tiempo real la identidad visual de estado (karma + encantamiento) para todos los jugadores cercanos.

### Payload

```ts
{
  characterId: string;
  karmaFlag: 'WHITE' | 'PURPLE' | 'RED';
  weaponPlusLevel: number;
  weaponEquipped?: boolean;
}
```

### Política de actualización

- El Warden emite al menos en:
  - cambio de flag de karma;
  - cambios de equipamiento/síntesis que alteran `weaponPlusLevel`;
  - snapshot/entrada a zona (bootstrap).
- Weaver aplica cambios de forma incremental sin reconstruir la escena completa.

## Regla de oro

El cliente solo decide **cómo mostrar** el estado visual.  
El servidor decide **cuál es** el estado visual válido.
