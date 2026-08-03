const SOUNDS = [
  { id: 'wood-tap', name: 'Wood Block Tap', cat: 'FOLEY', ogg: 'audio/wood-tap.ogg', tags: ['madera', 'wood', 'click', 'clic', 'tap', 'foley', 'block', 'golpe'] },
  { id: 'wood-high', name: 'Wood Block High', cat: 'FOLEY', ogg: 'audio/wood-high.ogg', tags: ['madera', 'wood', 'click', 'clic', 'foley', 'agudo', 'high', 'tick'] },
  { id: 'slab-bell', name: 'Concrete Slab + Bell', cat: 'IMPACT', ogg: 'audio/slab-bell.ogg', tags: ['metal', 'campana', 'bell', 'ring', 'hormigón', 'concrete', 'impacto', 'impact', 'golpe'] },
  { id: 'rocks-dry', name: 'Rock Impact Dry', cat: 'IMPACT', ogg: 'audio/rocks-dry.ogg', tags: ['piedra', 'rock', 'roca', 'stone', 'impacto', 'impact', 'seco', 'dry', 'golpe'] },
  { id: 'rock-tight', name: 'Rock Impact Tight', cat: 'IMPACT', ogg: 'audio/rock-tight.ogg', tags: ['piedra', 'rock', 'roca', 'stone', 'impacto', 'impact', 'tight', 'golpe', 'boom'] },
  { id: 'rock-mult', name: 'Rock Impact Multiple', cat: 'IMPACT', ogg: 'audio/rock-mult.ogg', tags: ['piedra', 'rock', 'roca', 'stone', 'impacto', 'impact', 'multiple', 'boom', 'grave'] },
  { id: 'metal-boom', name: 'Metal Wood Boom', cat: 'IMPACT', ogg: 'audio/metal-boom.ogg', tags: ['metal', 'madera', 'wood', 'boom', 'grave', 'low', 'impacto', 'impact', 'sub'] },
  { id: 'rock-solid', name: 'Stone Hit Solid', cat: 'IMPACT', ogg: 'audio/rock-solid.ogg', tags: ['piedra', 'rock', 'roca', 'stone', 'hit', 'golpe', 'solid', 'impacto', 'impact'] },
  { id: 'gravel-drop', name: 'Gravel Drop', cat: 'TEXTURE', ogg: 'audio/gravel-drop.ogg', tags: ['grava', 'gravel', 'caída', 'drop', 'textura', 'texture', 'piedra', 'foley', 'rumble'] },
  { id: 'gravel-scrape', name: 'Gravel Scrape', cat: 'TEXTURE', ogg: 'audio/gravel-scrape.ogg', tags: ['grava', 'gravel', 'raspado', 'scrape', 'textura', 'texture', 'roce', 'rumble'] },
  { id: 'debris-roll', name: 'Rock Debris Rolling', cat: 'TEXTURE', ogg: 'audio/debris-roll.ogg', tags: ['escombros', 'debris', 'rodar', 'rolling', 'textura', 'texture', 'rumble', 'grave', 'movimiento'] },
  { id: 'hen-weird', name: 'Processed Texture', cat: 'DESIGNED', ogg: 'audio/hen-weird.ogg', tags: ['diseñado', 'designed', 'procesado', 'processed', 'raro', 'rare', 'textura', 'texture', 'weird'] },
];

const COLLS = [
  { id: 'fav', name: 'Favoritos', color: '#fbbf24', ids: ['slab-bell', 'metal-boom', 'wood-tap'] },
  { id: 'impacts', name: 'Impactos', color: '#f87171', ids: ['slab-bell', 'rocks-dry', 'rock-tight', 'rock-mult', 'metal-boom', 'rock-solid'] },
  { id: 'textures', name: 'Texturas', color: '#22d3ee', ids: ['gravel-drop', 'gravel-scrape', 'debris-roll', 'hen-weird'] },
  { id: 'foley', name: 'Foley & Clicks', color: '#a3e635', ids: ['wood-tap', 'wood-high'] },
];

const SEMANTIC_MAP = {
  'golpe,hit,impacto,impact,golpear,strike,choque': ['slab-bell', 'rocks-dry', 'rock-tight', 'rock-mult', 'rock-solid', 'metal-boom', 'wood-tap', 'wood-high'],
  'grave,boom,bajo,low,profundo,deep,sub,retumbo': ['metal-boom', 'rock-mult', 'rock-tight', 'debris-roll', 'gravel-drop'],
  'textura,texture,raspado,scrape,ruido,rumble,movimiento,movement,roce': ['gravel-scrape', 'debris-roll', 'gravel-drop', 'hen-weird'],
  'madera,wood,click,clic,foley,tap,block,tick': ['wood-tap', 'wood-high'],
  'piedra,rock,stone,roca,grava,gravel,debris,escombro': ['rock-solid', 'rocks-dry', 'rock-tight', 'rock-mult', 'gravel-drop', 'gravel-scrape', 'debris-roll'],
  'metal,ring,campana,bell,anvil,yunque,brillo': ['slab-bell', 'metal-boom', 'rock-solid'],
  'raro,rare,diseñado,designed,weird,procesado,processed,cristal,crystal': ['hen-weird', 'slab-bell'],
};

const ECHO_SOURCE_ID = 'metal-boom';
const ECHO_ZONES = [0.30, 0.62];

const ECHO_SETS = [
  [
    { name: 'Concrete Slab + Bell', file: 'IMPACT/Concrete/slab_bar_bell_14kg.wav', sim: 96.2, preview: 'slab-bell', reg: [0.04, 0.22] },
    { name: 'Rock Impact Dry', file: 'IMPACT/Stone/rocks_multiple_dry.wav', sim: 89.4, preview: 'rocks-dry', reg: [0.1, 0.34] },
    { name: 'Stone Hit Solid', file: 'IMPACT/Stone/rock_hit_solid.wav', sim: 82.7, preview: 'rock-solid', reg: [0.02, 0.2] },
    { name: 'Wood Block Tap', file: 'FOLEY/Wood/wood_double_tap.wav', sim: 75.1, preview: 'wood-tap', reg: [0.0, 0.4] },
  ],
  [
    { name: 'Rock Impact Multiple', file: 'IMPACT/Stone/rock_impact_multiple.wav', sim: 95.0, preview: 'rock-mult', reg: [0.05, 0.4] },
    { name: 'Rock Impact Tight', file: 'IMPACT/Stone/rock_impact_tight.wav', sim: 88.3, preview: 'rock-tight', reg: [0.02, 0.3] },
    { name: 'Gravel Drop', file: 'TEXTURE/Stone/gravel_drop.wav', sim: 80.6, preview: 'gravel-drop', reg: [0.1, 0.5] },
    { name: 'Rock Debris Rolling', file: 'TEXTURE/Earth/debris_rolling.wav', sim: 72.4, preview: 'debris-roll', reg: [0.2, 0.6] },
  ],
  [
    { name: 'Gravel Scrape', file: 'TEXTURE/Stone/gravel_scrape.wav', sim: 93.1, preview: 'gravel-scrape', reg: [0.3, 0.7] },
    { name: 'Rock Debris Rolling', file: 'TEXTURE/Earth/debris_rolling.wav', sim: 86.5, preview: 'debris-roll', reg: [0.4, 0.85] },
    { name: 'Processed Texture', file: 'DESIGNED/Texture/processed_weird_03.wav', sim: 78.2, preview: 'hen-weird', reg: [0.25, 0.7] },
    { name: 'Gravel Drop', file: 'TEXTURE/Stone/gravel_drop.wav', sim: 70.8, preview: 'gravel-drop', reg: [0.5, 0.9] },
  ],
];
