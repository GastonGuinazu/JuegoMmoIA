/** Créditos de assets de terceros usados en el juego. Fuente: los `license.txt` que
 * acompañan cada modelo en `public/models/**` — mantener esta lista en sync si se agrega
 * o saca un asset con licencia (CC0 de Quaternius no exige atribución, pero se lista igual). */
export interface AssetCredit {
  title: string;
  author: string;
  authorUrl: string;
  license: string;
}

export const ASSET_CREDITS: readonly AssetCredit[] = [
  { title: 'Espadon Sencillo', author: 'FrederickCDXII', authorUrl: 'https://sketchfab.com/FrederickCDXII', license: 'CC-BY-4.0' },
  { title: 'Lizard Man Warrior', author: 'Vasian-Digital3D', authorUrl: 'https://sketchfab.com/Vasian-Digital3D', license: 'CC-BY-4.0' },
  { title: 'Sorceress', author: 'AlienKat', authorUrl: 'https://sketchfab.com/alienkatgames', license: 'CC-BY-4.0' },
  { title: '[Warcraft] - Witch Doctor', author: 'Northcliffe', authorUrl: 'https://sketchfab.com/Northcliffe', license: 'CC-BY-NC-4.0' },
  { title: 'Black Myth: Wukong — Hao Fu Li Shi', author: 'Haku Dragon', authorUrl: 'https://sketchfab.com/hakudragons', license: 'CC-BY-4.0' },
  { title: 'Dog Monster', author: 'Ploobert', authorUrl: 'https://sketchfab.com/Ploobert', license: 'CC-BY-NC-SA-4.0' },
  { title: 'Goblin Simple', author: 'marianofer1996', authorUrl: 'https://sketchfab.com/marianofer1996', license: 'CC-BY-4.0' },
  { title: 'The Elder Scrolls Blades Goblin', author: 'OrangeSauceu', authorUrl: 'https://sketchfab.com/orangesauceu', license: 'CC-BY-4.0' },
  { title: 'OGRE yamtar games', author: 'RustyPan90', authorUrl: 'https://sketchfab.com/RustyPan90', license: 'CC-BY-4.0' },
  { title: 'Scorpion', author: 'anthonyvanoo', authorUrl: 'https://sketchfab.com/anthonyvanoo', license: 'CC-BY-4.0' },
  { title: 'Silver Dragonkin (Mir4)', author: 'Doctor A.', authorUrl: 'https://sketchfab.com/doctorA', license: 'CC-BY-4.0' },
  { title: 'Skeleton — low tier enemy', author: 'CommunicationNode', authorUrl: 'https://sketchfab.com/Starven38', license: 'CC-BY-SA-4.0' },
  { title: 'Animated Low-Poly Spider', author: '3DHaupt', authorUrl: 'https://sketchfab.com/dennish2010', license: 'CC-BY-NC-ND-4.0' },
  { title: 'Terror Engine — Male Zombie', author: 'JuanCarlosOsanteHernandez', authorUrl: 'https://sketchfab.com/juancarlososantehernandez', license: 'CC-BY-NC-4.0' },
  { title: 'Zombie Normal Attack Animation', author: 'Leong Ji Fei', authorUrl: 'https://sketchfab.com/JiFeiii', license: 'CC-BY-4.0' },
  { title: 'Medieval Knight | Sculpture (mercader)', author: 'by__Rx', authorUrl: 'https://sketchfab.com/by__Rx', license: 'CC-BY-4.0' },
  { title: 'Medieval Wooden Chest', author: 'Dasamura', authorUrl: 'https://sketchfab.com/Dasamura', license: 'CC-BY-4.0' },
  { title: 'LowPoly Models (props y ruinas)', author: 'Quaternius', authorUrl: 'https://www.patreon.com/quaternius', license: 'CC0 1.0' },
];
