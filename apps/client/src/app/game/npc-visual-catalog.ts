/**
 * Mapping data-driven `npcTemplateKey` → `.gltf` (The Weaver).
 * El Warden ignora el mesh; picking y rango de tienda no cambian.
 */
export interface NpcCompanionVisualDef {
  url: string;
  targetHeight: number;
  yawOffset: number;
  /** Offset en espacio del host (metros), al lado del NPC. */
  offset: { x: number; y: number; z: number };
  openClip: RegExp;
}

export interface NpcVisualDef {
  url: string;
  /** Altura visual objetivo (pies en `-Y_LIFT`). Cosmético. */
  targetHeight: number;
  yawOffset: number;
  /** Clip de idle a loopear (Mixamo suele llamarse `mixamo.com`). */
  idleClip?: RegExp;
  companion?: NpcCompanionVisualDef;
}

export const NPC_VISUAL_BY_TEMPLATE: Readonly<Record<string, NpcVisualDef>> = {
  merchant_aetheris: {
    url: '/models/npcs/trader/scene.gltf',
    targetHeight: 2.2,
    /** Mira hacia la plaza (origen) desde el puesto en (5, 5). */
    yawOffset: (-Math.PI * 3) / 4,
    idleClip: /mixamo/i,
    companion: {
      url: '/models/npcs/traderBox/scene.gltf',
      targetHeight: 0.78,
      yawOffset: (-Math.PI * 3) / 4,
      offset: { x: 1.15, y: 0, z: 0.4 },
      openClip: /opening/i,
    },
  },
};

export function resolveNpcVisualDef(npcTemplateKey: string | null | undefined): NpcVisualDef | null {
  if (!npcTemplateKey) {
    return null;
  }
  return NPC_VISUAL_BY_TEMPLATE[npcTemplateKey] ?? null;
}
