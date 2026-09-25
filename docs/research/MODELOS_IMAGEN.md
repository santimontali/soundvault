# Modelos de imagen para el Brief: base 224, base 384, large y alternativas livianas

**Fecha:** 25/09/2026 · **Rama:** `overhaul-2.0` · **Alcance:** evaluación. Sin cambios en `src/`; modelos y vocabularios de prueba en `build-assets/` (ignorado por git), borrados al terminar.

**Pregunta.** ¿Cuál es el modelo de imagen más liviano que funciona de verdad para pasar de arte conceptual, fotos, key art de juegos y moodboards a categorías de sonido UCS? Se probaron SigLIP 2 large (patch16, 256 px) y SigLIP 2 base a 384 px con el mismo pipeline que usa la app con base 224, y se investigaron alternativas sin descargarlas.

**Convenciones.** Tamaños en MB decimales. Decimales con coma. "(est.)" es una estimación propia. Máquina de prueba: Intel Core i5-9400 (6 núcleos), 32 GB, Node 24.14, onnxruntime-node 1.14.0, 4 hilos de ORT (lo que usa la app en esta máquina). Otros procesos (tests, antivirus, REAPER, una instancia de la app) compartían la máquina en parte de las mediciones: los tiempos se dan como rango, o como la pasada más tranquila cuando se dice.

---

## Resumen

**Decisión final: se queda SigLIP 2 base 224 con `TERM_Z` 4,0, lo que ya está en el producto.**

1. **Base 224 es lo más liviano que sirve** (105,5 MB con su vocabulario, ≈0,1 s por vista). No hay nada más chico que se pueda distribuir y rinda (sección 4).
2. **Base 384 no lo mejora** (sección 2). Pesa lo mismo, pero es ≈4 veces más lento por vista (0,50 contra 0,11 s) y no acierta más: en las 51 imágenes da 32 chips correctos y 12 errados contra 41 y 15; en las 16 portadas sin título, 17 y 22 contra 22 y 26, con las mismas 10 imágenes acertadas; en las 14 imágenes grandes (lado corto de 384 px o más), donde la resolución podría ayudar, empata (11 contra 10 imágenes con acierto, 19 contra 24 chips correctos). Descartado; sus archivos se borraron.
3. **Large 256 sí ve mejor, pero quedó descartado por pesado** (decisión del usuario): 334 MB, ≈4 a 5 veces más lento y ≈700 MB de RAM pico. En las 16 portadas sin título acertó en 16 (14 con sus umbrales recalibrados) contra 10 de base (sección 1). Sus archivos se borraron.
4. **MASHIK no lo resuelve ninguno de los tres.** El título grande manda: los tres "leen" MASHIK o lo ven como glitch. Sin el título, solo large pone creature, grass y night entre sus 40 primeras palabras; base 224 y 384 las dejan cientos o miles de puestos abajo. Para key art con títulos lo que falta es tratar el texto de la imagen (OCR, o dejar que el usuario encuadre), no otro modelo del mismo tamaño.
5. **`TERM_Z` 4,0 para base 224 está bien elegido:** comparado con 3,4, baja los chips errados de 40 a 15 en las 51 imágenes y de 41 a 26 en las portadas sin título, a cambio de pocos aciertos (de 48 a 41 chips correctos, de 22 a 21 imágenes), y la validación en dos mitades lo vuelve a elegir.
6. **Nada más liviano que base sirve hoy:** MobileCLIP y MobileCLIP2 (11,8 a 36,7 MB) tienen licencia solo de investigación; TinyCLIP, PE Core T/S y OpenVision rinden menos que base en ImageNet (41 a 73 %) y algunos ni tienen ONNX; las variantes q4 de SigLIP 2 (63 MB) necesitan ORT 1.17 o más nuevo.

**Números clave**

| Qué | Base 224 (producto) | Base 384 (probado, descartado) | Large 256 (probado, descartado) |
|---|---|---|---|
| Archivos que se envían (modelo + vocabulario) | 105,5 MB (96,3 + 9,1) | 106,6 MB (97,5 + 9,1) | 334,0 MB (322,0 + 12,0) |
| Carga (vocabulario + sesión ORT) | 0,4 a 0,9 s | 0,5 a 0,9 s | 1,0 a 1,2 s |
| Por vista, mediana (máquina tranquila a cargada) | 0,11 a 0,15 s | 0,50 a 0,73 s | 0,53 a 0,72 s |
| Imagen cuadrada (2 vistas), mediana de la pasada más tranquila | 0,29 s | 0,89 s | 1,13 s |
| Imagen apaisada (5 vistas), mediana de la pasada más tranquila | 0,64 s | 2,30 s | 2,98 s |
| RAM pico del proceso (Node solo: ≈40 MB) | ≈280 a 300 MB | ≈350 a 370 MB | ≈690 a 720 MB |
| Construir el vocabulario (una vez, en el build) | ≈20 min | 86 min (máquina compartida) | 87 min (máquina compartida) |
| ImageNet zero-shot publicado | 78,2 % | 80,6 % | 82,5 % |
| 51 imágenes, mejores umbrales de cada uno: correctos / errados / imágenes con acierto (de 31) | 41 / 15 / 21 (`TERM_Z` 4,0) | 32 / 12 / 19 | 68 / 23 / 27 |
| Lo mismo, eligiendo umbrales en una mitad y midiendo en la otra | 39 / 22 / 20 | 43 / 36 / 20 | 67 / 27 / 26 |
| 16 portadas sin título: correctos / errados / imágenes con acierto | 22 / 26 / 10 | 17 / 22 / 10 | 37 / 9 / 14 |
| MASHIK (con título) | nada | glitchiness (glitch) | glitch, cosmic (alien) |

---

## 1. SigLIP 2 large 256: prueba real

**Descartado por pesado (decisión del usuario); sus archivos se borraron de `build-assets/`.** Queda como registro de lo que ve un modelo más grande.

### 1.1 Preparación

- **Descarga** (solo lo aprobado), de `onnx-community/siglip2-large-patch16-256-ONNX` a `build-assets/vocab-build/siglip2-large-patch16-256-ONNX/`: `onnx/vision_model_int8.onnx` (319.618.816 bytes, sha256 `861d6b69…`), `onnx/text_model_int8.onnx` (568.343.664 bytes, sha256 `e87f841f…`), `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `config.json`, `preprocessor_config.json`. Los hashes coinciden con los de Hugging Face.
- **Mismo tokenizer que base:** `tokenizer.json`, `tokenizer_config.json` y `special_tokens_map.json` son idénticos byte a byte (y lo son en todas las variantes base y large de onnx-community). Cambia la dimensión (1024) y la entrada (256 × 256, misma normalización 0,5 / 0,5).
- **El parche de ConvInteger funciona igual.** El export int8 de large tiene exactamente la misma cadena que base (DynamicQuantizeLinear, ConvInteger con pesos int8, Cast y dos Mul). La copia parametrizada de `prepare-image-model.js` la reemplaza por una Conv en float (786.432 pesos, zero point 0, escala 2,334e-3): 322,0 MB, IR 7, opset 14, solo operadores estándar. Carga y corre en ORT 1.14 (`pooler_output` de 1 × 1024). Nota: el `vision_model_uint8.onnx` de onnx-community (mismo tamaño) usa ConvInteger uint8 × uint8, que ORT 1.14 sí implementa, así que debería cargar sin parche; no se probó porque no estaba en la lista aprobada.
- **Vocabulario** con el encoder de texto de large (copia parametrizada de `build-image-vocabulary.js`, `DIM` leído de `config.json`): 753 conceptos y 9.857 términos en 5.235 s (≈18 min los conceptos y ≈70 min los términos, con la máquina compartida con otros trabajos; el de base tardó ≈20 min). Salida en `build-assets/models/siglip2-large/`: `vision_model.onnx` 322,0 MB, `terms.q8` 10,1 MB, `concepts.f16` 1,5 MB, `concepts.json` 0,4 MB. `build-assets/models/siglip2/` no se tocó. Al descartarlo se borraron esas carpetas (1,27 GB en total).

### 1.2 Cómo se midió

- **Imágenes:** las de `vis/all.txt` del orquestador más MASHIK: 51 en total (19 portadas de packs, 26 fondos de Windows entre paisajes y arte abstracto, MASHIK y 5 portadas o fondos más). La lista original tenía una línea con dos rutas pegadas (img19.jpg y MASHIK), así que la calibración anterior no leía esas dos; acá se separaron y se quitaron dos duplicados.
- **Vistas:** las del renderer (`modelViews`: entera aplastada, cuadrado central, las dos puntas si es apaisada o vertical, zoom al centro), hechas con `nativeImage` como el `calib.js` del orquestador: 224 px para base y 256 px para large.
- **Selección:** una copia de `ImageConcepts` con tamaño y dimensión por modelo y umbrales por instancia; el algoritmo es el mismo. Se guardan los z de cada imagen, así los umbrales se reprueban sin volver a correr el modelo.
- **Juicio:** cada chip se marcó correcto (+), neutro o evocativo (~: "plastic" para una flor abstracta, "shimmer" para un arco de luz) o errado (x), con patrones por imagen escritos mirando las imágenes (`judge.js`). Es un juicio propio sobre pocas imágenes: sirve para comparar modelos entre sí, no como métrica absoluta.
- **Portadas sin texto:** las 19 portadas llevan escrita su categoría ("FOOTSTEPS", "WEAPONS", "MAGIC"), y large la lee muy bien. Para separar "lee el título" de "entiende la foto" se recortaron las 16 portadas de Krotos debajo del título (queda solo el logo chico de Krotos) y se corrieron los dos modelos sobre esos recortes.

### 1.3 Resultados

En esta sección "umbrales de entonces" son los del producto en ese momento (`TERM_Z` 3,4; hoy es 4,0).

**Las 51 imágenes** (imagen por imagen en el anexo A, cada modelo con sus mejores umbrales):

| Total | Base, umbrales de entonces | Base, `TERM_Z` 4,0 | Large, umbrales de entonces | Large, recalibrado |
|---|---|---|---|---|
| Chips correctos (+) | 48 | 41 | 75 | 68 |
| Chips neutros o evocativos (~) | 52 | 31 | 43 | 37 |
| Chips errados (x) | 40 | 15 | 59 | 23 |
| Imágenes concretas con algún chip correcto (de 31) | 22 | 21 | 29 | 27 |
| Chips errados en arte abstracto (20 imágenes) | 7 | 4 | 18 | 0 |
| Imágenes sin ningún chip | 3 | 11 | 1 | 7 |

Por tipo de imagen, con los umbrales de entonces: en las 24 portadas con texto large saca 62 correctos contra 30 de base (22 imágenes con acierto contra 16), buena parte porque lee la palabra de la portada. En los 6 paisajes sin texto empatan: los dos aciertan en las 6 (base encuentra la playa del tríptico, large las dunas). En el arte abstracto large, sin recalibrar, inventa más ("loop", "desktop", "windows").

**Las 16 portadas de Krotos sin su título** (la prueba que separa leer de ver):

| # | Imagen | Base 224, umbrales de entonces | Large 256, umbrales de entonces | Large 256, recalibrado |
|---|---|---|---|---|
| 0 | Hielo, cielo, fuego, tierra agrietada | +rocks, ~hydrogeology (geothermal), xcontractor (construction ambience), +elemental magic, +canyon (desert), xelectrical (sparks) | +arid (desert), +drought (natural disaster), +scorched (burn), ~thermogeological (geothermal), +elemental magic, +fiery (burning) | +drought (natural disaster), +scorched (burn), ~thermogeological (geothermal), +elemental magic, +fiery (burning) |
| 1 | Ciudad de noche desde el aire | xcable (audio visual), xelectrician (electricity), xcircuit (switch) | +metropolis (urban), xcyberpunk (scifi ambience), xglitch | +metropolis (urban), xcyberpunk (scifi ambience), xglitch |
| 2 | Tigre | +tiger (wild cat), xwhiskers (domestic cat), xleather, xscreaming (panic crowd) | +tiger (wild cat), xcreatures, +zoology (animals), +beast | +tiger (wild cat), xcreatures, +zoology (animals) |
| 3 | Butacas rojas de cine | +seating (train interior), +chair (furniture), +cinema (public place), +audience (applause crowd) | +theater (public place), xstageplay (performance), xmotion, xkernel (glitch) | (nada) |
| 4 | Campera de cuero | +leather, +zipper, ~purse (bag), ~bag (recreational equipment), +cloth, xplastic | +leather, +jacket (zipper), +cloth, +fashion, xrope | +leather, +jacket (zipper), +cloth, +fashion |
| 5 | Cuello herido, sangre | +bleeding (blood), +bloodbaths (gore), xliquid and mud, xpurse (bag) | +bloodshed (blood), +bloodbaths (gore), xkillshot (bullet impact) | +bloodshed (blood), +bloodbaths (gore) |
| 6 | Zapatilla pisando un charco | +sneakers (fashion), +shoe (feet), xservo, xelectrician (electricity), xrobotic (industrial machine), xkeyholes (keys) | +sneakers (fashion), +footsteps, xglitch, +rain on concrete, +puddle (rain on water) | +footsteps, xglitch, +rain on concrete, +puddle (rain on water) |
| 7 | Pistola entre humo | xwater, +steam vent (fumarole), xhumidifier (hvac), xchemical reaction | xkillshot (bullet impact), +firearm (guns), xwater, xminigun (automatic), +weaponization (warfare), xriot (protest) | +firearm (guns), xminigun (automatic), +weaponization (warfare) |
| 8 | Puño ensangrentado | +bleeding (blood), xrope, xleather, xliquid and mud, +flesh | +bloodshed (blood), +bloodbaths (gore), +fists (fight impact) | +bloodshed (blood), +bloodbaths (gore) |
| 9 | Bruja con ramas, bosque oscuro | xcircuit (switch), xkeyholes (keys) | +ghost (creature ethereal), +warlock (evil magic) | +ghost (creature ethereal), +warlock (evil magic) |
| 10 | Amoladora con chispas sobre metal | xpurse (bag), xleather, xkeyholes (keys) | +metal, +welding (sparks), +grinder (pneumatic tool), +fabrication (industrial ambience), +manufacturing (industrial machine) | +metal, +welding (sparks), +grinder (pneumatic tool), +manufacturing (industrial machine) |
| 11 | Caballeros y caballo con armadura | xpurse (bag), xbaggage (luggage), xcable (audio visual), xswitchgear (switch), xinside (clock mechanics), xinductor (buzz and hum) | +armour (armor), +sword, xantiarmor (artillery), xrobots, xmetropolis (urban), xglitch | +armour (armor), +sword, xglitch |
| 12 | Arma futurista, neón | (nada) | +cyberpunk (scifi ambience), +cyborg (robot movement), xglitch, +cyberqueer (hitech ambience), +robot vocal, +scifi (sci-fi mechanism) | +cyberpunk (scifi ambience), +cyborg (robot movement), xglitch, +robot vocal, +hologram (sci-fi machine) |
| 13 | Madera, grava, piedras | +rocks, xceramics, xcloth, xplastic, xpaper | +rocks, xceramics | +rocks, xceramics |
| 14 | Fusil de asalto | xcamara (camera), +firearm (pistol), xcamcorder (audio visual), +holster (tactical equipment), xcompartment (vehicle mechanism), xcarry-on (luggage) | +firearm (hitech gun), +handgun (pistol), +weapon (laser gun), +holster (tactical equipment), +killshot (bullet impact), +tactical (military vehicle) | +firearm (hitech gun), +handgun (pistol), +weapon (laser gun), +holster (tactical equipment) |
| 15 | Ruta con estelas de luz | xlidar (laser beam) | xkernel (glitch), +asphalt (rain on concrete) | xkernel (glitch) |

| Total (16 recortes) | Base, umbrales de entonces | Base, `TERM_Z` 4,0 | Large, umbrales de entonces | Large, recalibrado |
|---|---|---|---|---|
| Chips correctos (+) | 21 | 22 | 47 | 37 |
| Chips errados (x) | 41 | 26 | 20 | 9 |
| Imágenes con algún chip correcto | 10 | 10 | 16 | 14 |

La diferencia no es de lectura: sin texto, base confunde armaduras con carteras y equipaje, una amoladora con carteras y cerraduras, una bruja con circuitos; large dice armadura y espada, soldadura y amoladora, fantasma y brujo.

### 1.4 MASHIK

| | Base 224 | Large 256 |
|---|---|---|
| Chips (umbrales de entonces) | glitch | mash (squish), glitch, cosmic (alien), basilisk (reptilian) |
| Chips (recalibrado) | (nada con `TERM_Z` 4,0) | glitch, cosmic (alien) |
| Palabras top de la imagen entera | glitch, muffs, reshape, marshy, musicbox, mushy, mash | mash, mushy, nightstick, basilisk, marsh, mashing, mesmerize |
| Puesto de creature / grass / night (de 9.857), imagen completa | 2.806 / 9.256 / 6.378 | 275 / 320 / 274 |
| Sin el título (recortado): palabras top | glitch, glitchiness, eyeballs, headlights, holodeck, lidar | dreamscape, hallucination, eyewall, mesmerize, glitch, cryptid, nocturnal, dreamworld, surrealist, eye |
| Sin el título: puesto de creature / grass / night | 1.554 / 8.916 / 1.015 | 24 / 32 / 39 |
| Sin el título: conceptos top | glitch, robot vocal, distortion, blob | creature ethereal, glitch, alien, cartoon horn, avian creature |

- Los dos modelos leen el título: base lo convierte en palabras parecidas a "mash" y en "glitch"; large, que lee texto mucho mejor, en mash, marsh, mask, mushy. Esas palabras se llevan la imagen entera, el cuadrado central y una punta.
- En las vistas sin título (el zoom, los recortes del pasto) large ve lo que el usuario espera: nocturnal, cryptid, nightbirds, creature ethereal, nightmare. Base ve polypropylene, silicone y neoprene en el mismo pasto: no entiende este estilo pictórico.
- Por eso large no alcanza: creature, grass y night quedan con z ≈2,3 a 2,4 en la imagen completa y ≈2,7 a 2,8 sin el título, debajo de `TERM_Z` 3,4, y cada una pesa poco frente a las palabras del título. Bajar los umbrales llena de ruido el resto. Lo que falta es no dejar que el texto de la imagen mande (OCR para descartar palabras leídas, o permitir encuadrar), o una regla que sume varias palabras débiles de una misma categoría; ninguna de las dos se probó.
- En el Brief real (biblioteca de 70k, solo lectura): con base, MASHIK da una sola tarjeta, "glitch" (sonidos de glitch de UI). Con large recalibrado, "glitch" y "cosmic" (VOXAlien), que trae "Alien Beast Small" y "Beast Throaty": un poco más cerca de una criatura, todavía lejos de pasto y noche.

### 1.5 Umbrales: large necesita otros

Los z de large tienen colas más largas: por imagen, 17,1 términos sobre 3,4 (base 15,1) y 3,24 conceptos sobre 3,2 (base 2,14). Con los umbrales de base, large ofrece más cosas y más ruido, sobre todo conceptos sueltos en arte abstracto ("loop", "desktop").

Se barrieron 2.800 combinaciones (`TERM_Z`, `CONCEPT_Z`, `ALONE_Z`, `MIN_EVIDENCE`) con un puntaje que castiga más un chip errado que lo que premia uno correcto. Para no sobreajustar se validó en dos mitades: umbrales elegidos con la mitad de las imágenes y medidos en la otra.

| | Umbrales | Chips correctos / errados | Imágenes con acierto (de 31) | Errados en abstracto |
|---|---|---|---|---|
| Large, antes | `TERM_Z` 3,4 · `CONCEPT_Z` 1,5 · `ALONE_Z` 3,2 · `MIN_EVIDENCE` 4,8 | 75 / 59 | 29 | 18 |
| Large, después (si se hubiera adoptado) | `CONCEPT_Z` **2,5** · `ALONE_Z` **3,5** (el resto igual) | 68 / 23 | 27 | 0 |
| Large, validación en dos mitades | elegidos en cada mitad: `CONCEPT_Z` 2,5 las dos veces | 67 / 27 (antes 75 / 59) | 26 | 0 |
| Base, antes | los de entonces | 48 / 40 | 22 | 7 |
| Base, después (hoy en el producto) | `TERM_Z` **4,0** | 41 / 15 | 21 | 4 |
| Base, validación en dos mitades | elegidos en cada mitad: `TERM_Z` 4,0 las dos veces | 39 / 22 (antes 48 / 40) | 20 | 4 |

- En large manda `CONCEPT_Z`: la categoría de una palabra tiene que estar clara en la imagen. Con 2,5, `GENERIC_Z` (2,5) queda redundante.
- `TERM_Z` 3,2 (con `MIN_EVIDENCE` 4,4) da un poco más en la muestra (73 / 28), y la validación eligió 3,0 y 3,2: `TERM_Z` no es crítico en large, así que se propone el cambio mínimo, solo `CONCEPT_Z` y `ALONE_Z`.
- Lo que se pierde al recalibrar large: "cinema" en las butacas, el tríptico playa/cerezo/lago y "creatures" en Fun Monsters.
- Con solo 2 vistas (entera y zoom) y esos umbrales, large da 61 / 22 y 27 imágenes con acierto: casi lo mismo con 60 % menos de cómputo en las apaisadas.

---

## 2. SigLIP 2 base 384: prueba real

**Resultado: no mejora a base 224 (donde comete menos errores también acierta menos) y es ≈4 veces más lento por vista. Descartado; sus archivos se borraron de `build-assets/`.**

### 2.1 Preparación

- **Descarga** (solo lo aprobado), de `onnx-community/siglip2-base-patch16-384-ONNX`: `onnx/vision_model_int8.onnx` (95.720.693 bytes, sha256 `ef04b4da…`), `onnx/text_model_int8.onnx` (283.438.275 bytes, sha256 `30a94b43…`), `config.json` (458 bytes) y `preprocessor_config.json` (394 bytes). Tamaños y hashes verificados contra la API de Hugging Face (sha256 en los ONNX, oid de git en los JSON).
- **Mismo export que base 224** (IR 7, opset 14, la misma cadena ConvInteger con pesos int8). El parche la reemplaza igual (589.824 pesos, zero point 0, escala 1,816e-3): 97,5 MB, carga y corre en ORT 1.14 (salida 1 × 768).
- **Vocabulario** con su propio encoder de texto (768-D) y el tokenizer ya convertido de `build-assets/vocab-build/siglip2-tokenizer`, sin tocarlo: 753 conceptos y 9.857 términos en 86 min, con la máquina compartida. El `build-image-vocabulary.js` del repo exige `tokenizer.json` en la carpeta del modelo aunque use el convertido; en la copia de prueba se relajó esa condición.
- **Vistas:** las del renderer, a 384 px. Las portadas de Krotos miden 291 px, así que a 384 se agrandan sin ganar detalle; por eso se miran aparte las imágenes grandes (lado corto de 384 px o más).

### 2.2 Resultados

"Recalibrado" es lo mejor de 2.800 combinaciones de umbrales en las 51 imágenes (`TERM_Z` 3,6 · `CONCEPT_Z` 2,25 · `ALONE_Z` 3,5 · `MIN_EVIDENCE` 4,4). Aun así queda por debajo de base 224 con el mismo puntaje (61,6 contra 70,7).

| | Base 224 (producto: `TERM_Z` 4,0) | 384, umbrales del producto | 384, recalibrado |
|---|---|---|---|
| 51 imágenes: correctos / errados | 41 / 15 | 32 / 20 | 32 / 12 |
| Imágenes concretas con algún chip correcto (de 31) | 21 | 18 | 19 |
| Umbrales elegidos en una mitad y medidos en la otra: correctos / errados / imágenes | 39 / 22 / 20 | no aplica | 43 / 36 / 20 |
| 14 imágenes grandes: correctos / errados / imágenes con acierto | 24 / 6 / 10 | 18 / 8 / 10 | 19 / 7 / 11 |
| 16 portadas sin título: correctos / errados / imágenes con acierto | 22 / 26 / 10 | 15 / 23 / 8 | 17 / 22 / 10 |
| Solo 2 vistas (entera y zoom), 51 imágenes: correctos / errados / imágenes | no aplica | 29 / 14 / 17 | 28 / 10 / 16 |
| MASHIK con título | nada | glitch | glitchiness (glitch) |
| MASHIK sin título | glitch, robot vocal | glitchiness, scifi ambience | glitchiness |
| Sin título, puesto de creature / grass / night (de 9.857) | 1.554 / 8.916 / 1.015 | 359 / 9.307 / 1.096 | igual |

- **Donde gana:** "forestland (forest)" en el lago de montaña con bosque; "scifi ambience" y "retrofuturistic" en las letras de Modular UI; "metal" en los caballeros sin título, donde base ve carteras y equipaje.
- **Donde pierde:** "firearm" en el fusil sin título (384 ve "seatbelt" y "hasselblad"); "casino game" en la caja de Casual UI; ruido nuevo en el tigre sin título ("screaming", "vocalizing", "throat") y en las butacas ("red (blood)", "stateroom").
- **Por qué no rinde más:** sus z quedan más bajos arriba (la palabra top de cada imagen promedia 4,54 contra 4,75), así que con los mismos umbrales pasan menos palabras (3,3 por imagen sobre 4,0, contra 4,3), y al bajarlos entra ruido. Además, las vistas de la app (centro, puntas, zoom) probablemente ya le dan a base 224 buena parte del detalle que aportaría la resolución (est.).

| Rendimiento (mismas condiciones) | Base 224 | Base 384 |
|---|---|---|
| Archivos que se envían | 105,5 MB | 106,6 MB |
| Carga | 0,4 a 0,9 s | 0,5 a 0,9 s |
| Por vista, mediana (microbenchmark, máquina tranquila) | 0,11 a 0,12 s | 0,50 s |
| Imagen cuadrada (2 vistas) / apaisada (5 vistas), pasada más tranquila | 0,29 / 0,64 s | 0,89 / 2,30 s |
| RAM pico del proceso | ≈280 a 300 MB | ≈350 a 370 MB |

Con la máquina cargada todo se estira: según la pasada, 384 quedó entre 2 y 5 veces más lento que 224.

---

## 3. Base con más recortes (sin descargar nada)

Se sumaron a las vistas de la app 4 a 6 recortes cuadrados del 55 % del lado corto, repartidos sobre la imagen (2x2 en las cuadradas, 3x2 en las apaisadas): de 2 a 5 vistas por imagen se pasa a 6 a 15.

| Base 224 | Vistas de la app | App + recortes |
|---|---|---|
| Chips correctos / errados | 48 / 40 | 53 / 117 |
| Imágenes concretas con algún chip correcto (de 31) | 22 | 24 |
| Términos con z ≥ 3,4 por imagen (media) | 15,1 | 32,5 |
| Mejor resultado posible barriendo umbrales | 22 imágenes, 12 a 15 errados | 18 imágenes, 12 errados |
| MASHIK | glitch | plastic, glitch, rubber |

Cada vista extra es otra oportunidad de que una palabra salga alta por azar (el máximo sobre las vistas sube de 4,75 a 5,13 de media), y los errores casi se triplican. En los recortes del pasto de MASHIK base ve plásticos y gomas. Más recortes no es el camino, y más resolución (base 384, sección 2) tampoco ayudó.

---

## 4. Alternativas (investigadas, sin descargar)

Tamaños de los listados de Hugging Face (API `tree/main`) al 25/09/2026. "Visión" es lo que se enviaría; el texto solo se usa para construir el vocabulario. ImageNet es zero-shot top-1 publicado por los autores. Para las familias ya evaluadas en `RECOMENDACIONES_VAULT.md` §1 (CLIP de OpenAI, OpenCLIP, DFN, EVA02) vale lo dicho ahí.

### 4.1 Familia SigLIP 2 (Apache 2.0, exports de onnx-community)

| Variante | Visión int8 | Texto int8 (build) | ImageNet | Dim | Entrada (tokens) | Nota |
|---|---|---|---|---|---|---|
| base p16 224 (la actual) | 94,6 MB (96,3 parchada) | 283,4 MB | 78,2 % | 768 | 224 px (196) | Referencia |
| base p16 256 | 94,7 MB | 283,4 MB | 79,1 % | 768 | 256 px (256) | ≈1,3x el cómputo de base 224 |
| base p16 384 (probado) | 95,7 MB (97,5 parchada) | 283,4 MB | 80,6 % | 768 | 384 px (576) | ≈4x más lento medido; no mejora a 224 (sección 2) |
| base p16 512 | 97,1 MB | 283,4 MB | 81,2 % | 768 | 512 px (1024) | ≈6x: más cómputo que large 256 (est.) |
| base p32 256 | 95,9 MB | 283,4 MB | 74,0 % | 768 | 256 px (64) | Mismo tamaño, ≈3x menos cómputo, peor |
| base p16 NaFlex | sin int8: fp32 371,7, fp16 185,9, q4 59,2 MB | no está en el repo (hay un fp32 comunitario de 1.129 MB) | 78,5 % (secuencia 256) | 768 | variable | Ver 3.3 |
| **large p16 256 (probado)** | 319,6 MB (322,0 parchada) | 568,3 MB | 82,5 % | 1024 | 256 px (256) | Sección 1 |
| large p16 384 / 512 | 320,9 / 322,8 MB | 568,3 MB | 83,1 / 83,5 % | 1024 | 384 / 512 px | Mismo tamaño, más cómputo |
| so400m p16 256 | 432,2 MB | 711,1 MB | 83,4 % | 1152 | 256 px | Más pesado que large |
| giant opt p16 256 | 1.170,8 MB | 711,6 MB | 84,5 % | 1536 | 256 px | Fuera de escala |

Cada checkpoint tiene su propio encoder de texto (hashes distintos): cambiar de variante obliga a rehacer el vocabulario con el texto de esa variante. Tokenizer, `tokenizer_config.json` y `special_tokens_map.json` son los mismos en todas.

### 4.2 Otras familias

| Modelo | Visión (lo que se envía) | Texto (build) | ImageNet | Dim / entrada | ONNX con ORT 1.14 | Licencia de los pesos |
|---|---|---|---|---|---|---|
| MobileCLIP S0 / S1 / S2 / B (Apple, 2024) | int8 11,8 / 22,4 / 36,7 / 87,5 MB (`Xenova/mobileclip_*`) | int8 42,8 / 64,1 MB | 67,8 / 72,6 / 74,4 / 76,8 % | 512 / 256 px | Listo; es convolucional, así que el int8 tendría ConvInteger con pesos int8 en muchas capas (est.): habría que usar el uint8 | Apple ML Research Model License: solo investigación, excluye productos. **No apta** |
| MobileCLIP2 S0 / S2 / B (Apple, 2025) | solo fp32 comunitario: 45,6 / 143,0 / 345,5 MB | fp32 254,1 MB | 71,5 / 77,2 / 79,4 % | 512 / 256 px | Sin int8 publicado | La misma. **No apta** |
| TinyCLIP ViT 8M/16 (Microsoft) | modelo combinado imagen + texto, int8 24,3 MB | incluido | 41,1 % | 512 / 224 px | Solo combinado: hay que separar la torre visual | MIT |
| TinyCLIP ViT 39M/16 | combinado, int8 84,7 MB | incluido | 63,5 % | 512 / 224 px | Igual | MIT |
| TinyCLIP ViT 40M/32 y 61M/32 | combinado, int8 85,6 / 117,2 MB | incluido | 59,8 / 62,4 % | 512 / 224 px | Igual | MIT |
| PE Core T16 384 (Meta, julio de 2025) | sin ONNX. Torre visual fp32 de 24,6 MB (≈6 M params, ≈6 MB en int8, est.) | texto tipo CLIP, 12 capas, 512 de ancho | 62,1 % | 512 / 384 px (576) | Exportar desde PyTorch y cuantizar | Apache 2.0 |
| PE Core S16 384 (Meta, julio de 2025) | sin ONNX. Visión fp32 de 95,1 MB (≈24 M params, ≈24 MB en int8, est.) | igual | 72,7 % | 512 / 384 px (576) | Igual | Apache 2.0 |
| PE Core B16 224 | sin ONNX oficial | 0,31 B params | 78,4 % | 1024 / 224 px | Igual | Apache 2.0 |
| TIPS S/14 (Google) | sin ONNX. 22 M params | 34 M | no publicado en la ficha | 384 / 448 px (1024) | Exportar; a 448 px cuesta más cómputo que base 224 | Apache 2.0 |
| OpenVision tiny / small (UCSC, 2025) | sin ONNX. 5,9 / 22,4 M params | propio | no publican ImageNet zero-shot (CLIP bench 49,6 / 65,9) | 224 px | Exportar | Apache 2.0 |
| nomic embed vision v1.5 | int8 96,7 MB | nomic embed text v1.5, int8 137,3 MB | 71,0 % | 768 / 224 px | Listo | Apache 2.0 |
| jina clip v1 | int8 87,9 MB | int8 138,1 MB | no figura en la ficha | 768 / 224 px | Listo | Apache 2.0 |
| SigLIP 1 base p16 224 | int8 94,1 MB | int8 111,0 MB | 76,2 % | 768 / 224 px | Listo | Apache 2.0 |
| MetaCLIP 2 (S16, B32...) y MoEViE (Meta, 2026) | solo fp32 comunitario | | | | | CC BY-NC 4.0. **No apta** |

### 4.3 Compatibilidad con onnxruntime-node 1.14

- **int8 de onnx-community:** la incrustación de parches es un ConvInteger con pesos int8 que 1.14 no implementa; se arregla con nuestro parche (verificado en base y en large) o usando el `_uint8.onnx` del mismo tamaño (ConvInteger uint8 × uint8, que 1.14 sí tiene; no probado).
- **q4, q4f16 y bnb4:** usan MatMulNBits o MatMulBnb4, operadores de `com.microsoft` que aparecen recién en ORT 1.17. Con 1.14 no cargan. Es la única forma de bajar base a 63 MB o large a 206 MB, y exige actualizar ORT (lo que arrastra a transformers.js; ver `RECOMENDACIONES_VAULT.md`).
- **fp16:** en CPU, 1.14 casi no tiene kernels fp16; además pesa el doble que int8.
- **NaFlex:** solo fp32 (371,7 MB), fp16 y q4; sin encoder de texto en el repo. Habría que generar el int8 y el texto por nuestra cuenta. Su gracia (respetar el aspecto de la imagen) no compensa: rinde como base 224 (78,5 %).
- **Modelos sin ONNX (PE Core, TIPS, OpenVision):** requieren exportar con PyTorch. En esta máquina hay Python 3.11 con torch 2.12, pero faltan `open_clip`, `timm` y `onnx`, y habría que bajar los pesos (348,8 MB PE Core S16 completo).

### 4.4 Por qué no hay algo más liviano que base

- Los únicos más chicos y buenos (MobileCLIP, MobileCLIP2) no se pueden distribuir por licencia.
- Todo lo que se puede distribuir y pesa menos rinde menos que base en ImageNet: TinyCLIP 41 a 64 %, PE Core T/S 62,1 y 72,7 %, OpenVision sin cifra comparable. En esta prueba, 4,3 puntos de ImageNet (base contra large) separaron "falla en 6 de 16 fotos" de "acierta en las 16"; un modelo 5 puntos o más por debajo de base sería peor que base (est.).
- La única variante sin más MB que podía acercarse a large era base 384, y no lo hizo (sección 2).

---

## 5. Recomendación

1. **Se queda base 224 con `TERM_Z` 4,0**, como está en el producto: es lo más liviano que sirve y lo más rápido de lo probado (≈0,3 s una imagen cuadrada y ≈0,6 s una apaisada, 105,5 MB, ≈300 MB de RAM pico mientras está cargado).
2. **Base 384 y large quedan descartados.** 384 pesa lo mismo pero es ≈4 veces más lento y no acierta más (sección 2); large acierta más pero pesa 334 MB y es 4 a 5 veces más lento (sección 1). Sus archivos se borraron de `build-assets/`.
3. **Para key art con títulos (MASHIK) la mejora posible no es de modelo:** tratar el texto de la imagen (OCR para que el título no mande, o dejar que el usuario encuadre), o una regla que sume varias palabras débiles de una misma categoría. Ninguna de las dos se probó.
4. **Si algún día se actualiza ORT (1.17 o más nuevo):** el `vision_model_q4.onnx` de base 224 (63,3 MB) achicaría el modelo un tercio. Habría que medir su calidad con estas mismas pruebas.

---

## 6. Reproducir

Scripts en `C:\Users\santi\AppData\Local\Temp\sv-model-eval\` (fuera del repo):

| Script | Qué hace |
|---|---|
| `download-large.sh`, `download-384.sh` | Bajan exactamente los archivos aprobados de large (7) y de base 384 (4) |
| `onnx-ops.js` | Opsets, operadores y tipos de un ONNX (sin dependencias) |
| `prepare-model.js` | Copia de `prepare-image-model.js` con `--src`, `--hf`, `--out` y `--check` |
| `build-vocab.js` | Copia de `build-image-vocabulary.js` con `--hf`, `--tok`, `--out`; `DIM` desde `config.json`; reusa un tokenizer ya convertido sin pedir `tokenizer.json` |
| `image-concepts-param.js` | Copia de `ImageConcepts`: tamaño y dimensión por modelo, umbrales por instancia, `select()` separado, tiempos por vista |
| `make-views.js`, `crop-title.js`, `crop-covers.js`, `contact.js` | Electron: vistas como el renderer (tamaños por `SIZES`, por ejemplo `224,384`, más recortes), MASHIK sin título, portadas sin título, hojas de contactos |
| `run-calib.js`, `phase2.sh` | Corre el pipeline sobre las vistas: chips, tiempos, carga, RAM pico y volcado de z (`--two` usa 2 vistas, `--only` un subconjunto); `phase2.sh` hace todas las corridas de calidad de 384 |
| `judge.js`, `replay.js`, `compare.js` | Juicio por imagen, reprueba de umbrales (`--search`, `--cv`) y tablas |
| `per-view.js`, `why.js`, `zstats.js`, `bench.js` | Palabras por vista y puestos de las esperadas, por qué entra o no una palabra, dispersión de z, microbenchmark |
| `brief-cards.js` | Copia del `brief-images-real.js` del orquestador con `MODEL_DIR` y `T` por variable de entorno (base de datos real en solo lectura) |
| `hf-info.js` | Licencia y archivos ONNX con tamaños de un repo de Hugging Face (solo la API) |

Ejemplo: `node run-calib.js --model <carpeta del modelo> --views <vistas> --size 224 --mode app --T "{\"TERM_Z\":4.0}"`. Los resultados (`out/*.json`) y los volcados de z (`z/*.bin`) quedaron en la carpeta de scripts: `replay.js` reprueba umbrales sin volver a correr los modelos, pero necesita la carpeta del modelo con su vocabulario (para 384 y large habría que volver a prepararlas). Las vistas (en `D:\sv-audit-tmp`) y los modelos de prueba se borraron; `make-views.js` y los scripts de preparación los regeneran.

---

## Fuentes

1. SigLIP 2, paper (tabla 1 y tabla 7 de NaFlex). https://arxiv.org/abs/2502.14786
2. Fichas y licencia de Google (Apache 2.0). https://huggingface.co/google/siglip2-base-patch16-224
3. Exports de onnx-community (listados de archivos): https://huggingface.co/onnx-community/siglip2-large-patch16-256-ONNX · https://huggingface.co/onnx-community/siglip2-base-patch16-384-ONNX · https://huggingface.co/onnx-community/siglip2-base-patch16-naflex-ONNX
4. MobileCLIP y MobileCLIP2: tabla de modelos y licencia de los pesos. https://huggingface.co/apple/MobileCLIP2-S0 · https://github.com/apple/ml-mobileclip/blob/main/LICENSE_MODELS · https://huggingface.co/Xenova/mobileclip_s0 · https://huggingface.co/plhery/mobileclip2-onnx
5. TinyCLIP, model zoo. https://github.com/microsoft/Cream/tree/main/TinyCLIP · https://huggingface.co/onnx-community/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M-ONNX
6. Perception Encoder (PE Core T, S, B). https://github.com/facebookresearch/perception_models · https://huggingface.co/facebook/PE-Core-S16-384 · https://huggingface.co/timm/PE-Core-S-16-384 · https://huggingface.co/timm/vit_pe_core_small_patch16_384.fb
7. OpenVision, paper. https://arxiv.org/abs/2505.04601
8. TIPS. https://huggingface.co/google/tipsv1-s14
9. nomic embed vision v1.5. https://huggingface.co/nomic-ai/nomic-embed-vision-v1.5
10. jina clip v1. https://huggingface.co/jinaai/jina-clip-v1
11. MetaCLIP 2 y MoEViE (CC BY-NC 4.0). https://huggingface.co/facebook/metaclip-2-worldwide-s16 · https://huggingface.co/facebook/MoEViE-B16-224
12. ONNX Runtime, operadores contrib de 1.17 (MatMulNBits). https://github.com/microsoft/onnxruntime/blob/rel-1.17.0/docs/ContribOperators.md
13. Interno: `docs/research/RECOMENDACIONES_VAULT.md` §1 (familias CLIP, OpenCLIP, DFN, EVA02 y compatibilidad con transformers.js).

---

## Anexo A: las 51 imágenes, una por una

Leyenda: + correcto · ~ neutro o evocativo · x errado. Entre paréntesis, la categoría UCS cuando difiere de la palabra. Cada modelo con sus mejores umbrales: base 224 con los del producto, 384 y large recalibrados (secciones 1.5 y 2.2).

| # | Imagen | Base 224, producto (TERM_Z 4,0) | Base 384, recalibrado | Large 256, recalibrado |
|---|---|---|---|---|
| 0 | Gore: calavera, huesos, sangre | +gore, +blood, xinside (clock mechanics) | +blood, +gore, xvomit | +gore, +bone |
| 1 | Libro de magia y nebulosa | +shimmer, ~holographic (scifi ambience), +angelic magic | ~holographic (scifi ambience), +aura (shimmer) | +magick (magic), +alchemy (elemental magic), ~intergalactic (sci-fi weapon), +dreamscape (fantasy), +cosmic (alien), +galactica (sci-fi spaceship) |
| 2 | Monstruos de dibujo animado | +blob, +cartoon creak, +cartoon swish | +toon (cartoon swish) | +monster |
| 3 | Hielo, cielo, fuego, tierra agrietada | +elemental magic | (nada) | +elements (weather) |
| 4 | Ciudad de noche desde el aire | xcable (audio visual) | xsupercomputer (computers), xgigabytes (hard drive) | xcyberpunk (scifi ambience), xatmospheric (ambience) |
| 5 | Tigre | +tiger (wild cat), +animalism (wild animal) | +tiger (wild cat), +animals | +tiger (wild cat), xcreatures, +critters (wild animal) |
| 6 | Butacas rojas de cine | +cinema (public place), xscifi ambience | (nada) | (nada) |
| 7 | Campera de cuero | +leather, xbookstore (book), ~purse (bag), ~bag (recreational equipment) | +leather, +zipper, ~purse (bag) | +cloth, +garment (fashion), +leather |
| 8 | Cuello herido, sangre | +bleeding (blood), +flesh | +blood, +decaying (flesh) | +flesh, +gore |
| 9 | Zapatilla pisando un charco | +sneakers (fashion) | +sneakers (fashion) | +footstep (feet), +shuffle (footsteps) |
| 10 | Pistola entre humo | (nada) | (nada) | xsteam-powered (train steam), +firearm (guns), +gunstock (gun handle), xtrains, +rifle (bullets) |
| 11 | Puño ensangrentado | +blood, +flesh | +blood, +flesh | +gore, +bloodshed (blood), +hand (grab), +fists (fight impact) |
| 12 | Bruja con ramas, bosque oscuro | +magic (evil magic) | +magickal (magic) | +magick (magic), +sorcerer (spell) |
| 13 | Amoladora con chispas sobre metal | (nada) | (nada) | xmechanic (gun mechanism), xmechanism (clock mechanics), +machinery (machines), +spark (sparks), xcogwheel (gears), xscifi (sci-fi mechanism) |
| 14 | Caballeros y caballo con armadura | (nada) | xswitchgear (switch) | +melee (battle crowd), +combatant (fight), +helm (armor), xcyborg (robots), xcyberpunk (scifi ambience) |
| 15 | Arma futurista, neón | +sci-fi (sci-fi weapon) | (nada) | +cyberpunk (scifi ambience), +futuristic (sci-fi weapon), +scifi, +cyborg (robots), xglitch, +weapon (laser gun) |
| 16 | Madera, grava, piedras | (nada) | (nada) | +rocks |
| 17 | Fusil de asalto | +firearm (pistol), +cartridge (bullets) | +wesson (pistol) | +weaponry (warfare), +firearm (guns), +weapons, +armament (sci-fi weapon), +rifle, xcyberpunk (scifi ambience) |
| 18 | Ruta con estelas de luz | (nada) | (nada) | +whoosh (swoosh whoosh) |
| 19 | Abstracto: flor azul (Windows) | ~plastic, ~rubber, xwindows | ~plastic, ~rubber | ~cloth |
| 20 | Abstracto: arco de luz azul | ~glow (shimmer), ~spectrum (electromagnetic) | ~lidar (laser beam), ~glow (shimmer) | ~holographic (scifi ambience), ~aura (shimmer), ~forcefield (sci-fi energy), ~plasma (arc), ~spectrum (electromagnetic) |
| 21 | Lago al atardecer, colinas nevadas | +iceberg (tundra), +reflection (shimmer), xscifi ambience | +iceberg (tundra), xmoonscape (scifi ambience) | +lakescape (lakeside), xmoonscape (scifi ambience) |
| 22 | Abstracto: cintas naranja y violeta | ~plastic, ~rubber, ~paper | ~plastic, ~paper, xsketchbook (book), ~rubber | ~cloth |
| 23 | Abstracto: flor gris azulada | ~plastic, ~paper | ~plastic, ~paper | ~cloth |
| 24 | Azul plano | (nada) | (nada) | (nada) |
| 25 | Abstracto: flor azul | xwindows | ~blob | (nada) |
| 26 | Tríptico: playa, cerezo, lago | +beach (seaside), +dune (desert), xglass (fashion), xhydrogeology (geothermal), +dirt and sand | +beach (seaside), +dune (desert) | (nada) |
| 27 | Abstracto: arco de luz violeta | ~glowing (shimmer) | ~lidar (laser beam), ~glow (shimmer) | ~planet (scifi ambience), ~plasma (arc), ~shield (sci-fi energy), ~glowing (shimmer), ~photon (sci-fi impact) |
| 28 | Abstracto: arco de luz azul | ~glow (shimmer), ~spectrum (electromagnetic) | ~lidar (laser beam), ~glow (shimmer) | ~holographic (scifi ambience), ~aura (shimmer), ~forcefield (sci-fi energy), ~plasma (arc), ~spectrum (electromagnetic) |
| 29 | Abstracto: arco de luz rojo | ~spectrum (electromagnetic), ~spectral (creature ethereal) | ~glow (shimmer) | ~planet (scifi ambience), ~plasma (arc), ~forcefield (sci-fi energy), ~glowing (shimmer) |
| 30 | Abstracto: arco de luz verde | ~lidar (laser beam), ~spectrum (electromagnetic), ~lasers, ~glow (shimmer), ~spectral (creature ethereal) | ~lidar (laser beam), ~hologram (sci-fi energy), ~holographic (scifi ambience), ~glow (shimmer) | ~aura (shimmer), ~holographic (scifi ambience), ~spectrum (electromagnetic), ~hologram (sci-fi energy), ~plasma (arc) |
| 31 | Abstracto: formas de vidrio | ~paper | (nada) | (nada) |
| 32 | Abstracto: cintas | (nada) | xdistortion (glitch) | ~abstract (experimental musical) |
| 33 | Abstracto: remolino | ~plastic, ~rubber | ~plastic, ~rubber, ~paper | ~abstract (experimental musical) |
| 34 | Abstracto: gotas y burbujas | ~abstract (experimental musical), ~blob | ~blob | ~liquid and mud |
| 35 | Lago, amanecer, nieve | +iceberg (tundra), +lakewater (lakeside), +water, xboat underwater | +iceberg (tundra), xseascape (seaside), +water | +lakewater (lakeside), +icefield (tundra), xhydrogeology (geothermal) |
| 36 | Lago de montaña con bosque | +lakewater (lakeside), +lagoon (swamp) | +forestland (forest), +iceberg (tundra) | +lakewater (lakeside), +icecap (tundra), +snow |
| 37 | Lago, amanecer, nieve | +iceberg (tundra), +lakewater (lakeside), xsubmerged (boat underwater), +reflection (shimmer) | +iceberg (tundra), +lakewater (lakeside), +reflection (shimmer) | +lakescape (lakeside), xdreamland (fantasy) |
| 38 | Dunas junto a un lago | +reflection (shimmer) | +reflection (shimmer), xmoonscape (scifi ambience) | +dune (desert), +lakeview (lakeside) |
| 39 | Abstracto: flor celeste | ~plastic | ~paper, ~plastic | ~cloth, ~paper |
| 40 | Abstracto: flor verde salvia | (nada) | ~blob | ~cloth |
| 41 | Abstracto: flor rosa | ~paper | ~paper | ~paper |
| 42 | Abstracto: flor gris | ~rubber | ~blob | ~cloth, ~rubber |
| 43 | Abstracto: flor azul | xwindows | ~blob | (nada) |
| 44 | Abstracto: flor azul sobre negro | xwindows | ~blob | (nada) |
| 45 | MASHIK: criatura en pasto de noche, ojos gigantes, título | (nada) | xglitchiness (glitch) | xglitch, +cosmic (alien) |
| 46 | Caja de juego casual con gemas | +boardgame (board game), +casino game, xpaper, ~mechanical toy, +puzzle (machine mechanism) | xpaper, +boardgame (board game), +puzzle (machine mechanism) | +user interface, xice, +console (video game) |
| 47 | Figura encapuchada con energía azul | (nada) | (nada) | +sci-fi energy, +energy (elemental magic), +electrically (electricity), xray (laser impact), +electrocute (arc), +warlock (evil magic) |
| 48 | Personaje anime con martillo | (nada) | (nada) | xdata |
| 49 | Maza clavada en tierra | +dirt (dirt and sand), +mud (liquid and mud), +detritus (destruction crash and debris) | +dirt (dirt and sand), +mud (liquid and mud), xsubterranean (underground) | +dirt and sand, +shovel (garden tool), xmetal, +demolition (construction ambience), +mud (liquid and mud) |
| 50 | Letras metálicas "MODULAR UI" | xtypeface (typewriter) | +scifi ambience, +retrofuturistic (sci-fi retro) | +user interface, +mcu (sci-fi computer), xdata, xcyberqueer (hitech ambience), +interstellar (scifi ambience) |

| Total | Base 224, producto (TERM_Z 4,0) | Base 384, recalibrado | Large 256, recalibrado |
|---|---|---|---|
| Chips correctos (+) | 41 | 32 | 68 |
| Chips neutros o evocativos (~) | 31 | 32 | 37 |
| Chips errados (x) | 15 | 12 | 23 |
| Imágenes concretas con al menos un chip correcto (de 31) | 21 | 19 | 27 |
| Chips errados en arte abstracto | 4 | 2 | 0 |
| Imágenes sin ningún chip | 11 | 11 | 7 |
