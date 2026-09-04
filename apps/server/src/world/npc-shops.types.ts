export type NpcShopOfferConfig = {
  catalogKey: string;
  /** Precio de compra al NPC (Adena). La venta al NPC usa ⌊buy/3⌋ por unidad. */
  buyPriceAdena: number;
};

export type NpcShopConfigEntry = {
  npcTemplateKey: string;
  offers: NpcShopOfferConfig[];
};

export type NpcShopsConfigFile = {
  version: number;
  shops: NpcShopConfigEntry[];
};

export type NpcShopOffersList = NpcShopOfferConfig[];
