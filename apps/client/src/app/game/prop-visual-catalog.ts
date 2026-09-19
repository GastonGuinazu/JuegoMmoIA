/**
 * Mapping data-driven `propTemplateKey` → `.glb` estático (The Weaver).
 * Colisión AABB sigue en `map-objects-Zone_*.json` (Cartographer / Warden).
 */
export type PropFitMode = 'aabb' | 'height';

export interface PropVisualDef {
  url: string;
  yawOffset: number;
  /**
   * `aabb`: estira el mesh al `scale` del JSON (columnas, muros, arcos).
   * `height`: escala uniforme a `targetHeight`; la base apoya en el suelo del AABB.
   *          El hitbox lógico no crece (copa del árbol puede sobresalir).
   */
  fit: PropFitMode;
  targetHeight?: number;
}

export const PROP_VISUAL_BY_TEMPLATE: Readonly<Record<string, PropVisualDef>> = {
  tree_oak: {
    url: '/models/props/tree_oak.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 6.2,
  },
  tree_oak_b: {
    url: '/models/props/tree_oak_b.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 5.4,
  },
  tree_birch: {
    url: '/models/props/tree_birch.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 5.8,
  },
  rock: {
    url: '/models/props/rock.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 1.35,
  },
  rock_b: {
    url: '/models/props/rock_b.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 1.2,
  },
  stump: {
    url: '/models/props/stump.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 0.85,
  },
  log: {
    url: '/models/props/log.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 0.7,
  },
  bush: {
    url: '/models/props/bush.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 1.25,
  },
  bush_b: {
    url: '/models/props/bush_b.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 1.1,
  },
  plant: {
    url: '/models/props/plant.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 0.9,
  },
  pine_snow: {
    url: '/models/props/pine_snow.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 6.8,
  },
  pine_snow_b: {
    url: '/models/props/pine_snow_b.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 6.2,
  },
  rock_snow: {
    url: '/models/props/rock_snow.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 1.5,
  },
  stump_snow: {
    url: '/models/props/stump_snow.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 0.9,
  },
  tree_dead_snow: {
    url: '/models/props/tree_dead_snow.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 5.6,
  },
  column_round: {
    url: '/models/props/column_round.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  column_square: {
    url: '/models/props/column_square.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  column_short: {
    url: '/models/props/column_short.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  wall_broken: {
    url: '/models/props/wall_broken.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  wall_half: {
    url: '/models/props/wall_half.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  wall_overgrown: {
    url: '/models/props/wall_overgrown.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  arch_round: {
    url: '/models/props/arch_round.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  crate: {
    url: '/models/props/crate.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  cart: {
    url: '/models/props/cart.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  barrel: {
    url: '/models/props/barrel.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 1.05,
  },
  chest: {
    url: '/models/props/chest.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
  torch: {
    url: '/models/props/torch.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 1.55,
  },
  pot: {
    url: '/models/props/pot.glb',
    yawOffset: 0,
    fit: 'height',
    targetHeight: 0.72,
  },
  floor_path: {
    url: '/models/props/floor_path.glb',
    yawOffset: 0,
    fit: 'aabb',
  },
};

export function resolvePropVisualDef(propTemplateKey: string | null | undefined): PropVisualDef | null {
  if (!propTemplateKey) {
    return null;
  }
  return PROP_VISUAL_BY_TEMPLATE[propTemplateKey] ?? null;
}
