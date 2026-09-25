'use strict';
/**
 * Spanish → English for sound-search queries.
 *
 * The CLAP text model and almost every commercial SFX library are English
 * ("Footsteps Gravel 03.wav"), so Spanish queries scored poorly in the audit
 * ("pasos en grava" P@20 0.05 vs 0.50 for "footsteps gravel"). Words found
 * here are translated, Spanish function words are dropped, and anything
 * unknown is kept as typed (names, English words, numbers).
 * Pure and dependency-free: used by both lexical search (main) and the AI
 * query (engine host).
 */

const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Spanish function words that carry no sound meaning.
const STOP = new Set(('de del la las el los un una unos unas y o por para al a que se su sus lo le les ' +
    'como muy mas mas mucho poco sobre entre desde hacia hasta tipo sonido sonidos ruido ruidos efecto efectos').split(' '));

// Common SFX vocabulary. Keys are accent-folded; values may be multi-word.
const DICT = {
    // actions / movement
    pasos: 'footsteps', paso: 'footstep', pisadas: 'footsteps', pisada: 'footstep', caminar: 'walk', caminando: 'walking',
    correr: 'run', corriendo: 'running', saltar: 'jump', salto: 'jump', caida: 'fall', caer: 'fall', cayendo: 'falling',
    golpe: 'hit', golpes: 'hits', golpear: 'hit', impacto: 'impact', impactos: 'impacts', choque: 'crash', choques: 'crashes',
    romper: 'break', rotura: 'break', roto: 'broken', quebrar: 'break', aplastar: 'crush', arrastrar: 'drag', arrastre: 'drag',
    raspar: 'scrape', raspado: 'scrape', rasguno: 'scratch', frotar: 'rub', roce: 'rub', empujar: 'push', tirar: 'throw',
    lanzar: 'throw', abrir: 'open', abre: 'open', abriendo: 'opening', cerrar: 'close', cierra: 'close', cerrando: 'closing',
    portazo: 'door slam', agitar: 'shake', sacudir: 'shake', girar: 'spin', rodar: 'roll', rebote: 'bounce', rebotar: 'bounce',
    deslizar: 'slide', desliz: 'slide', explotar: 'explode', disparar: 'shoot', disparo: 'gunshot', disparos: 'gunshots',
    tiro: 'gunshot', tiros: 'gunshots', recarga: 'reload', recargar: 'reload', latigo: 'whip', latigazo: 'whip crack',
    zumbido: 'buzz', zumbar: 'buzz', silbido: 'whistle', silbar: 'whistle', susurro: 'whisper', susurros: 'whispers',
    grito: 'scream', gritos: 'screams', gritar: 'scream', risa: 'laugh', risas: 'laughter', llanto: 'crying', llorar: 'cry',
    tos: 'cough', respiracion: 'breathing', respirar: 'breath', suspiro: 'sigh', beso: 'kiss', aplausos: 'applause', aplauso: 'applause',
    voz: 'voice', voces: 'voices', habla: 'speech', hablando: 'talking', multitud: 'crowd', gente: 'crowd', muchedumbre: 'crowd',
    // weapons / combat
    explosion: 'explosion', explosiones: 'explosions', estallido: 'blast', bomba: 'bomb', arma: 'weapon', armas: 'weapons',
    pistola: 'pistol', rifle: 'rifle', escopeta: 'shotgun', ametralladora: 'machine gun', espada: 'sword', espadas: 'swords',
    cuchillo: 'knife', hacha: 'axe', flecha: 'arrow', arco: 'bow', escudo: 'shield', armadura: 'armor', puno: 'punch',
    punetazo: 'punch', patada: 'kick', pelea: 'fight', lucha: 'fight', canon: 'cannon', canones: 'cannons', bala: 'bullet', balas: 'bullets',
    casquillo: 'shell casing', casquillos: 'shell casings', silenciador: 'silencer',
    // materials
    madera: 'wood', metal: 'metal', metalico: 'metallic', vidrio: 'glass', cristal: 'glass', piedra: 'stone', piedras: 'stones',
    roca: 'rock', rocas: 'rocks', grava: 'gravel', arena: 'sand', tierra: 'dirt', barro: 'mud', lodo: 'mud', nieve: 'snow',
    hielo: 'ice', agua: 'water', papel: 'paper', carton: 'cardboard', plastico: 'plastic', tela: 'cloth', ropa: 'clothes',
    cuero: 'leather', goma: 'rubber', ceramica: 'ceramic', hojas: 'leaves', hoja: 'leaf', ramas: 'branches', rama: 'branch',
    pasto: 'grass', cesped: 'grass', hierba: 'grass', concreto: 'concrete', hormigon: 'concrete', cemento: 'concrete',
    ladrillo: 'brick', baldosa: 'tile', azulejo: 'tile', alfombra: 'carpet', cadena: 'chain', cadenas: 'chains',
    // nature / weather / ambience
    lluvia: 'rain', llueve: 'rain', trueno: 'thunder', truenos: 'thunder', tormenta: 'storm', relampago: 'lightning',
    rayo: 'lightning', viento: 'wind', brisa: 'breeze', fuego: 'fire', llamas: 'flames', llama: 'flame', hoguera: 'campfire',
    fogata: 'campfire', olas: 'waves', ola: 'wave', mar: 'ocean', oceano: 'ocean', playa: 'beach', rio: 'river', arroyo: 'stream',
    cascada: 'waterfall', gotas: 'drops', gota: 'drip', goteo: 'dripping', burbujas: 'bubbles', burbuja: 'bubble', salpicadura: 'splash',
    chapoteo: 'splash', bosque: 'forest', selva: 'jungle', noche: 'night', dia: 'day', manana: 'morning', ciudad: 'city',
    calle: 'street', trafico: 'traffic', pueblo: 'town', campo: 'countryside', desierto: 'desert', cueva: 'cave', montana: 'mountain',
    ambiente: 'ambience', ambientes: 'ambience', atmosfera: 'atmosphere', interior: 'interior', exterior: 'exterior',
    habitacion: 'room', cuarto: 'room', cocina: 'kitchen', bano: 'bathroom', oficina: 'office', fabrica: 'factory',
    restaurante: 'restaurant', bar: 'bar', iglesia: 'church', hospital: 'hospital', escuela: 'school', estadio: 'stadium',
    // animals
    perro: 'dog', perros: 'dogs', ladrido: 'bark', ladridos: 'barking', ladrando: 'barking', ladrar: 'bark', gato: 'cat',
    gatos: 'cats', maullido: 'meow', ronroneo: 'purr', caballo: 'horse', caballos: 'horses', relincho: 'neigh', galope: 'gallop',
    vaca: 'cow', oveja: 'sheep', cerdo: 'pig', gallina: 'chicken', gallo: 'rooster', pajaro: 'bird', pajaros: 'birds', ave: 'bird',
    aves: 'birds', canto: 'song', piar: 'chirp', gorjeo: 'chirping', cuervo: 'crow', buho: 'owl', lechuza: 'owl', aguila: 'eagle',
    paloma: 'pigeon', pato: 'duck', insecto: 'insect', insectos: 'insects', grillo: 'cricket', grillos: 'crickets',
    abeja: 'bee', abejas: 'bees', mosca: 'fly', moscas: 'flies', mosquito: 'mosquito', rana: 'frog', ranas: 'frogs',
    lobo: 'wolf', lobos: 'wolves', aullido: 'howl', leon: 'lion', rugido: 'roar', tigre: 'tiger', oso: 'bear', mono: 'monkey',
    serpiente: 'snake', raton: 'mouse', rata: 'rat', ballena: 'whale', delfin: 'dolphin', dinosaurio: 'dinosaur',
    monstruo: 'monster', criatura: 'creature', dragon: 'dragon', zombi: 'zombie', zombie: 'zombie', fantasma: 'ghost',
    // vehicles / machines
    auto: 'car', autos: 'cars', coche: 'car', coches: 'cars', carro: 'car', camion: 'truck', moto: 'motorcycle',
    motocicleta: 'motorcycle', bicicleta: 'bicycle', bici: 'bicycle', tren: 'train', avion: 'airplane', aviones: 'airplanes',
    helicoptero: 'helicopter', barco: 'boat', barcos: 'boats', bote: 'boat', nave: 'spaceship', cohete: 'rocket', motor: 'engine',
    motores: 'engines', bocina: 'horn', claxon: 'horn', sirena: 'siren', sirenas: 'sirens', frenos: 'brakes', freno: 'brake',
    frenada: 'brake squeal', derrape: 'skid', neumatico: 'tire', neumaticos: 'tires', rueda: 'wheel', ruedas: 'wheels',
    maquina: 'machine', maquinas: 'machines', maquinaria: 'machinery', engranaje: 'gear', engranajes: 'gears', mecanismo: 'mechanism',
    robot: 'robot', robots: 'robots', computadora: 'computer', ordenador: 'computer', teclado: 'keyboard', raton_: 'mouse',
    telefono: 'phone', celular: 'phone', timbre: 'doorbell', alarma: 'alarm', reloj: 'clock', tictac: 'tick tock', campana: 'bell',
    campanas: 'bells', puerta: 'door', puertas: 'doors', ventana: 'window', ventanas: 'windows', cajon: 'drawer', llave: 'key',
    llaves: 'keys', cerradura: 'lock', interruptor: 'switch', boton: 'button', botones: 'buttons', palanca: 'lever',
    ascensor: 'elevator', escalera: 'stairs', escaleras: 'stairs', ventilador: 'fan', aire: 'air', vapor: 'steam', electricidad: 'electricity',
    electrico: 'electric', chispa: 'spark', chispas: 'sparks', zumbido_: 'hum', estatica: 'static', radio: 'radio', television: 'tv',
    // UI / design vocabulary
    interfaz: 'ui', menu: 'menu', clic: 'click', click: 'click', notificacion: 'notification', error: 'error', exito: 'success',
    moneda: 'coin', monedas: 'coins', recoger: 'pickup', objeto: 'item', magia: 'magic', magico: 'magic', hechizo: 'spell',
    poder: 'power', energia: 'energy', transicion: 'transition', subida: 'riser', bajada: 'downer', golpe_: 'hit',
    zumbador: 'buzzer', pitido: 'beep', pitidos: 'beeps', tono: 'tone', tonos: 'tones', ciencia: 'sci-fi', ficcion: 'fiction',
    futurista: 'futuristic', espacial: 'space', espacio: 'space', laser: 'laser', rayos: 'rays', teletransporte: 'teleport',
    // descriptors
    fuerte: 'loud', suave: 'soft', lejano: 'distant', lejos: 'distant', distante: 'distant', cerca: 'close', cercano: 'close',
    grande: 'big', gran: 'big', pequeno: 'small', chico: 'small', largo: 'long', corto: 'short', rapido: 'fast', lento: 'slow',
    grave: 'low', agudo: 'high', profundo: 'deep', oscuro: 'dark', brillante: 'bright', pesado: 'heavy', liviano: 'light',
    ligero: 'light', seco: 'dry', humedo: 'wet', mojado: 'wet', hueco: 'hollow', denso: 'dense', aspero: 'harsh', metalica: 'metallic',
    viejo: 'old', antiguo: 'old', nuevo: 'new', electronico: 'electronic', mecanico: 'mechanical', natural: 'natural',
    tenebroso: 'dark', terror: 'horror', miedo: 'scary', misterio: 'mystery', tension: 'tension', tranquilo: 'calm',
    calma: 'calm', caos: 'chaos', epico: 'epic', sucio: 'dirty', limpio: 'clean', distorsionado: 'distorted', reverberacion: 'reverb',
    eco: 'echo', silencio: 'silence', crujido: 'creak', crujir: 'creak', chirrido: 'squeak', chirriar: 'squeak', crepitar: 'crackle',
    chasquido: 'snap', estruendo: 'rumble', retumbar: 'rumble', murmullo: 'murmur', tintineo: 'jingle', tintinear: 'jingle',
    // music
    musica: 'music', bateria: 'drums', tambor: 'drum', tambores: 'drums', bombo: 'kick drum', redoblante: 'snare', caja: 'snare',
    platillo: 'cymbal', platillos: 'cymbals', guitarra: 'guitar', piano: 'piano', cuerdas: 'strings', violin: 'violin',
    flauta: 'flute', trompeta: 'trumpet', coro: 'choir', sintetizador: 'synth', bajo: 'bass', melodia: 'melody', acorde: 'chord',
    ritmo: 'rhythm', loop: 'loop', bucle: 'loop', golpe_seco: 'thud',
    // footwear / gerunds common in foley queries
    botas: 'boots', bota: 'boot', zapatos: 'shoes', zapato: 'shoe', tacones: 'heels', zapatillas: 'sneakers', descalzo: 'barefoot',
    crepitando: 'crackling', crujiendo: 'creaking', goteando: 'dripping', sonando: 'ringing', explotando: 'exploding',
    rompiendo: 'breaking', golpeando: 'hitting', chocando: 'crashing', rodando: 'rolling', arrastrando: 'dragging',
    silbando: 'whistling', zumbando: 'buzzing', ardiendo: 'burning', hirviendo: 'boiling', friendo: 'frying',
    cortando: 'cutting', serrando: 'sawing', martillando: 'hammering', martillo: 'hammer', sierra: 'saw', taladro: 'drill',
    tijeras: 'scissors', herramientas: 'tools', herramienta: 'tool', clavo: 'nail', tornillo: 'screw',
};
// Keys ending in '_' are disambiguation placeholders. Identity entries (metal,
// piano, explosion…) are kept: they fix accents and word order but do not by
// themselves mark a query as Spanish.
for (const k of Object.keys(DICT)) if (k.endsWith('_')) delete DICT[k];
// Spanish words that are also common English SFX words ("mono kick", "Auto Fire",
// "grave digging", "arena crowd", "electric motor", "llama") are never translated.
for (const k of ['grave', 'llama', 'mono', 'arena', 'auto', 'motor', 'bar', 'once', 'red', 'pan']) delete DICT[k];

// Prepositions worth keeping for the text model ("lluvia en la ventana" → "rain on window").
const PREP = { en: 'on', sobre: 'on', con: 'with', sin: 'without', dentro: 'inside', fuera: 'outside' };
// Translated descriptors that go before the noun in English.
const ADJ = new Set(('loud soft distant close big small long short fast slow low high deep dark bright heavy light dry wet ' +
    'hollow dense harsh metallic old new electronic mechanical natural scary calm epic dirty clean distorted magic futuristic ' +
    'electric broken space').split(' '));

function lookup(f) {
    if (DICT[f]) return DICT[f];
    const tries = [];
    // plurals: "explosiones" → "explosion", "tambores" → "tambor", "olas" → "ola"
    if (f.length > 4 && f.endsWith('es')) tries.push(f.slice(0, -2));
    if (f.length > 3 && f.endsWith('s')) tries.push(f.slice(0, -1));
    // gender: "lejana(s)" → "lejano", "metalicas" → "metalico"
    for (const t of [f, ...tries]) if (t.length > 3 && t.endsWith('a')) tries.push(t.slice(0, -1) + 'o');
    for (const t of tries) if (DICT[t]) return DICT[t];
    return null;
}

/**
 * @param {string} q raw query
 * @returns {{ text: string, changed: boolean, pairs: Array<[string, string]> }}
 *   text: English query for the model / extra lexical terms; pairs: [original, english]
 */
function translateQuery(q) {
    const raw = String(q || '').trim();
    if (!raw) return { text: '', changed: false, pairs: [] };
    const words = raw.split(/\s+/);
    // tokens: { t: english/kept text, en: translated?, adj: descriptor?, of: preceded by "de/del"? }
    const toks = [], pairs = [];
    let translated = 0, pendingOf = false;
    for (const w of words) {
        const f = fold(w).replace(/[^a-z0-9'-]/g, '');
        if (!f) continue;
        const en = lookup(f);
        if (en) {
            toks.push({ t: en, en: true, adj: ADJ.has(en), of: pendingOf });
            if (en !== f) { pairs.push([w, en]); translated++; }
            pendingOf = false;
            continue;
        }
        if (PREP[f]) { toks.push({ t: PREP[f], prep: true }); pendingOf = false; continue; }
        if (STOP.has(f)) { pendingOf = f === 'de' || f === 'del'; continue; }
        toks.push({ t: f }); pendingOf = false;
    }
    // Only treat the query as Spanish when something was actually translated;
    // an English query with an accidental "a"/"de" stays as typed.
    if (!translated) return { text: raw, changed: false, pairs: [] };
    // English word order for the text model: "explosiones lejanas" → "distant
    // explosions", "golpes de espada" → "sword hits".
    for (let i = 1; i < toks.length; i++) {
        const a = toks[i - 1], b = toks[i];
        if (b.en && a.en && (b.adj && !a.adj || b.of)) { toks[i - 1] = b; toks[i] = a; b.of = false; }
    }
    while (toks.length && toks[toks.length - 1].prep) toks.pop();
    while (toks.length && toks[0].prep) toks.shift();
    const text = toks.map(t => t.t).join(' ');
    return { text, changed: text !== fold(raw), pairs };
}

module.exports = { translateQuery, fold };
