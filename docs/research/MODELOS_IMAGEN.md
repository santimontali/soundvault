# Modelos de imagen para el Brief: SigLIP 2 large contra base, y alternativas livianas

**Fecha:** 25/09/2026 · **Rama:** `overhaul-2.0` · **Alcance:** evaluación. Sin cambios en `src/`; modelos y vocabularios de prueba en `build-assets/` (ignorado por git).

**Pregunta.** ¿Cuál es el modelo de imagen más liviano que funciona de verdad para pasar de arte conceptual, fotos, key art de juegos y moodboards a categorías de sonido UCS? Se probó SigLIP 2 large (patch16, 256 px) con el mismo pipeline que usa la app con base, y se investigaron alternativas sin descargarlas.

**Convenciones.** Tamaños en MB decimales. Decimales con coma. "(est.)" es una estimación propia. Máquina de prueba: Intel Core i5-9400 (6 núcleos), 32 GB, Node 24.14, onnxruntime-node 1.14.0, 4 hilos de ORT (lo que usa la app en esta máquina). Otros procesos (tests e2e, antivirus) compartían la máquina en parte de las mediciones: los tiempos se dan como rango de dos corridas.

---

## Resumen

**Recomendación**

1. **Lo más liviano que probamos y que funciona de verdad es SigLIP 2 large 256 en int8 (334 MB con su vocabulario).** Base es 3,2 veces más liviano, pero en fotos sin texto falla seguido: en las 16 portadas de Krotos recortadas sin su título, base acierta en 10 y da casi dos chips errados por cada correcto (21 correctos, 41 errados). Large acierta en las 16 (47 correctos, 20 errados; recalibrado, 37 y 9).
2. **Si se adopta large, hay que recalibrar dos umbrales:** `CONCEPT_Z` de 1,5 a 2,5 y `ALONE_Z` de 3,2 a 3,5. En las 51 imágenes los chips errados bajan de 59 a 23 y los errores en arte abstracto de 18 a 0. Leer solo 2 vistas (entera y zoom) en vez de hasta 5 casi no cambia el resultado y deja una imagen apaisada en ≈1,2 a 1,4 s en lugar de ≈3 s.
3. **MASHIK no lo resuelve ninguno de los dos.** El título grande domina: los dos modelos "leen" MASHIK (base: marshy, mushy, musicbox; large: mash, marsh, mask). Sin el título, large pone creature, grass y night entre sus 40 primeras palabras de 9.857; base las deja en los puestos 1.554, 8.916 y 1.015. Large entiende la imagen, pero para que salgan esos chips hace falta tratar el texto de la imagen (OCR, o que el usuario encuadre), no un modelo más grande.
4. **Antes de pagar 334 MB, una sola prueba puede cambiar la decisión:** SigLIP 2 base patch16 a 384 px. Pesa lo mismo que base (95,7 MB), cuesta ≈3 veces su cómputo (≈2/3 del de large, est.) y rinde 80,6 % en ImageNet contra 78,2 % y 82,5 %. Si se acerca a large en las portadas sin texto, sería la opción liviana. Archivos exactos en la sección 5.
5. **Si hay que quedarse en ≈100 MB sin más pruebas:** base con `TERM_Z` 4,0 en vez de 3,4. Baja los chips errados de 40 a 15 en las 51 imágenes (de 41 a 26 en las portadas sin texto) casi sin perder aciertos, pero no mejora lo que base no ve.
6. **No hay nada más liviano que base que sirva hoy:** MobileCLIP y MobileCLIP2 (11,8 a 36,7 MB) tienen licencia solo de investigación; TinyCLIP, PE Core T/S y OpenVision rinden menos que base en ImageNet (41 a 73 %) y algunos ni tienen ONNX; las variantes q4 de SigLIP 2 (63 MB) necesitan ORT 1.17 o más nuevo.

**Números clave**

| Qué | Base 224 (la actual) | Large 256 |
|---|---|---|
| Archivos que se envían (modelo + vocabulario) | 105,5 MB (96,3 + 9,1) | 334,0 MB (322,0 + 12,0) |
| Carga (vocabulario + sesión ORT) | 0,5 a 0,9 s | 1,0 a 1,2 s |
| Por vista, mediana (mínimo) | 0,13 a 0,15 s (0,10) | 0,53 a 0,72 s (0,45) |
| Imagen cuadrada (2 vistas), mediana | 0,31 a 0,36 s | 1,13 a 1,25 s |
| Imagen apaisada (5 vistas), mediana | 0,86 a 0,90 s | 2,98 a 3,11 s |
| RAM pico del proceso (Node solo: ≈40 MB) | ≈280 MB | ≈690 a 720 MB |
| Construir el vocabulario (una vez, en el build) | ≈20 min | ≈87 min (máquina compartida) |
| ImageNet zero-shot publicado | 78,2 % | 82,5 % |
| 51 imágenes: chips correctos / errados, umbrales actuales | 48 / 40 | 75 / 59 |
| 51 imágenes: chips correctos / errados, recalibrado | 41 / 15 (`TERM_Z` 4,0) | 68 / 23 |
| Imágenes concretas con algún chip correcto (de 31), actual y recalibrado | 22 y 21 | 29 y 27 |
| 16 portadas sin texto: correctos / errados / imágenes con acierto | 21 / 41 / 10 | 47 / 20 / 16 (recalibrado 37 / 9 / 14) |
| MASHIK | glitch | mash, glitch, cosmic (alien), basilisk (recalibrado: glitch, cosmic (alien)) |

---

## 1. SigLIP 2 large 256: prueba real

### 1.1 Preparación

- **Descarga** (solo lo aprobado), de `onnx-community/siglip2-large-patch16-256-ONNX` a `build-assets/vocab-build/siglip2-large-patch16-256-ONNX/`: `onnx/vision_model_int8.onnx` (319.618.816 bytes, sha256 `861d6b69…`), `onnx/text_model_int8.onnx` (568.343.664 bytes, sha256 `e87f841f…`), `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `config.json`, `preprocessor_config.json`. Los hashes coinciden con los de Hugging Face.
- **Mismo tokenizer que base:** `tokenizer.json`, `tokenizer_config.json` y `special_tokens_map.json` son idénticos byte a byte (y lo son en todas las variantes base y large de onnx-community). Cambia la dimensión (1024) y la entrada (256 × 256, misma normalización 0,5 / 0,5).
- **El parche de ConvInteger funciona igual.** El export int8 de large tiene exactamente la misma cadena que base (DynamicQuantizeLinear, ConvInteger con pesos int8, Cast y dos Mul). La copia parametrizada de `prepare-image-model.js` la reemplaza por una Conv en float (786.432 pesos, zero point 0, escala 2,334e-3): 322,0 MB, IR 7, opset 14, solo operadores estándar. Carga y corre en ORT 1.14 (`pooler_output` de 1 × 1024). Nota: el `vision_model_uint8.onnx` de onnx-community (mismo tamaño) usa ConvInteger uint8 × uint8, que ORT 1.14 sí implementa, así que debería cargar sin parche; no se probó porque no estaba en la lista aprobada.
- **Vocabulario** con el encoder de texto de large (copia parametrizada de `build-image-vocabulary.js`, `DIM` leído de `config.json`): 753 conceptos y 9.857 términos en 5.235 s (≈18 min los conceptos y ≈70 min los términos, con la máquina compartida con otros trabajos; el de base tardó ≈20 min). Salida en `build-assets/models/siglip2-large/`: `vision_model.onnx` 322,0 MB, `terms.q8` 10,1 MB, `concepts.f16` 1,5 MB, `concepts.json` 0,4 MB. `build-assets/models/siglip2/` no se tocó. Si large no se adopta, se puede borrar todo lo de esta prueba: `build-assets/vocab-build/siglip2-large-patch16-256-ONNX/` (922 MB), `build-assets/vocab-build/siglip2-large-tokenizer/` (11 MB) y `build-assets/models/siglip2-large/` (334 MB).

### 1.2 Cómo se midió

- **Imágenes:** las de `vis/all.txt` del orquestador más MASHIK: 51 en total (19 portadas de packs, 26 fondos de Windows entre paisajes y arte abstracto, MASHIK y 5 portadas o fondos más). La lista original tenía una línea con dos rutas pegadas (img19.jpg y MASHIK), así que la calibración anterior no leía esas dos; acá se separaron y se quitaron dos duplicados.
- **Vistas:** las del renderer (`modelViews`: entera aplastada, cuadrado central, las dos puntas si es apaisada o vertical, zoom al centro), hechas con `nativeImage` como el `calib.js` del orquestador: 224 px para base y 256 px para large.
- **Selección:** una copia de `ImageConcepts` con tamaño y dimensión por modelo y umbrales por instancia; el algoritmo es el mismo. Se guardan los z de cada imagen, así los umbrales se reprueban sin volver a correr el modelo.
- **Juicio:** cada chip se marcó correcto (+), neutro o evocativo (~: "plastic" para una flor abstracta, "shimmer" para un arco de luz) o errado (x), con patrones por imagen escritos mirando las imágenes (`judge.js`). Es un juicio propio sobre pocas imágenes: sirve para comparar modelos entre sí, no como métrica absoluta.
- **Portadas sin texto:** las 19 portadas llevan escrita su categoría ("FOOTSTEPS", "WEAPONS", "MAGIC"), y large la lee muy bien. Para separar "lee el título" de "entiende la foto" se recortaron las 16 portadas de Krotos debajo del título (queda solo el logo chico de Krotos) y se corrieron los dos modelos sobre esos recortes.

### 1.3 Resultados

**Las 51 imágenes** (tabla completa, imagen por imagen, en el anexo A):

| Total | Base, umbrales actuales | Base, `TERM_Z` 4,0 | Large, umbrales actuales | Large, recalibrado |
|---|---|---|---|---|
| Chips correctos (+) | 48 | 41 | 75 | 68 |
| Chips neutros o evocativos (~) | 52 | 31 | 43 | 37 |
| Chips errados (x) | 40 | 15 | 59 | 23 |
| Imágenes concretas con algún chip correcto (de 31) | 22 | 21 | 29 | 27 |
| Chips errados en arte abstracto (20 imágenes) | 7 | 4 | 18 | 0 |
| Imágenes sin ningún chip | 3 | 11 | 1 | 7 |

Por tipo de imagen, con los umbrales actuales: en las 24 portadas con texto large saca 62 correctos contra 30 de base (22 imágenes con acierto contra 16), buena parte porque lee la palabra de la portada. En los 6 paisajes sin texto empatan: los dos aciertan en las 6 (base encuentra la playa del tríptico, large las dunas). En el arte abstracto large, sin recalibrar, inventa más ("loop", "desktop", "windows").

**Las 16 portadas de Krotos sin su título** (la prueba que separa leer de ver):

| # | Imagen | Base 224, actual | Large 256, actual | Large 256, recalibrado |
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

| Total (16 recortes) | Base, actual | Base, `TERM_Z` 4,0 | Large, actual | Large, recalibrado |
|---|---|---|---|---|
| Chips correctos (+) | 21 | 22 | 47 | 37 |
| Chips errados (x) | 41 | 26 | 20 | 9 |
| Imágenes con algún chip correcto | 10 | 10 | 16 | 14 |

La diferencia no es de lectura: sin texto, base confunde armaduras con carteras y equipaje, una amoladora con carteras y cerraduras, una bruja con circuitos; large dice armadura y espada, soldadura y amoladora, fantasma y brujo.

### 1.4 MASHIK

| | Base 224 | Large 256 |
|---|---|---|
| Chips (umbrales actuales) | glitch | mash (squish), glitch, cosmic (alien), basilisk (reptilian) |
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
| Large, después (propuesto) | `CONCEPT_Z` **2,5** · `ALONE_Z` **3,5** (el resto igual) | 68 / 23 | 27 | 0 |
| Large, validación en dos mitades | elegidos en cada mitad: `CONCEPT_Z` 2,5 las dos veces | 67 / 27 (antes 75 / 59) | 26 | 0 |
| Base, antes | los actuales | 48 / 40 | 22 | 7 |
| Base, después | `TERM_Z` **4,0** | 41 / 15 | 21 | 4 |
| Base, validación en dos mitades | elegidos en cada mitad: `TERM_Z` 4,0 las dos veces | 39 / 22 (antes 48 / 40) | 20 | 4 |

- En large manda `CONCEPT_Z`: la categoría de una palabra tiene que estar clara en la imagen. Con 2,5, `GENERIC_Z` (2,5) queda redundante.
- `TERM_Z` 3,2 (con `MIN_EVIDENCE` 4,4) da un poco más en la muestra (73 / 28), y la validación eligió 3,0 y 3,2: `TERM_Z` no es crítico en large, así que se propone el cambio mínimo, solo `CONCEPT_Z` y `ALONE_Z`.
- Lo que se pierde al recalibrar large: "cinema" en las butacas, el tríptico playa/cerezo/lago y "creatures" en Fun Monsters.
- Con solo 2 vistas (entera y zoom) y los umbrales propuestos, large da 61 / 22 y 27 imágenes con acierto: casi lo mismo con 60 % menos de cómputo en las apaisadas.

---

## 2. Base con más recortes (sin descargar nada)

Se sumaron a las vistas de la app 4 a 6 recortes cuadrados del 55 % del lado corto, repartidos sobre la imagen (2x2 en las cuadradas, 3x2 en las apaisadas): de 2 a 5 vistas por imagen se pasa a 6 a 15.

| Base 224 | Vistas de la app | App + recortes |
|---|---|---|
| Chips correctos / errados | 48 / 40 | 53 / 117 |
| Imágenes concretas con algún chip correcto (de 31) | 22 | 24 |
| Términos con z ≥ 3,4 por imagen (media) | 15,1 | 32,5 |
| Mejor resultado posible barriendo umbrales | 22 imágenes, 12 a 15 errados | 18 imágenes, 12 errados |
| MASHIK | glitch | plastic, glitch, rubber |

Cada vista extra es otra oportunidad de que una palabra salga alta por azar (el máximo sobre las vistas sube de 4,75 a 5,13 de media), y los errores casi se triplican. En los recortes del pasto de MASHIK base ve plásticos y gomas. Más recortes no es el camino, y más resolución requiere otro checkpoint (sección 5).

---

## 3. Alternativas (investigadas, sin descargar)

Tamaños de los listados de Hugging Face (API `tree/main`) al 25/09/2026. "Visión" es lo que se enviaría; el texto solo se usa para construir el vocabulario. ImageNet es zero-shot top-1 publicado por los autores. Para las familias ya evaluadas en `RECOMENDACIONES_VAULT.md` §1 (CLIP de OpenAI, OpenCLIP, DFN, EVA02) vale lo dicho ahí.

### 3.1 Familia SigLIP 2 (Apache 2.0, exports de onnx-community)

| Variante | Visión int8 | Texto int8 (build) | ImageNet | Dim | Entrada (tokens) | Nota |
|---|---|---|---|---|---|---|
| base p16 224 (la actual) | 94,6 MB (96,3 parchada) | 283,4 MB | 78,2 % | 768 | 224 px (196) | Referencia |
| base p16 256 | 94,7 MB | 283,4 MB | 79,1 % | 768 | 256 px (256) | ≈1,3x el cómputo de base 224 |
| base p16 384 | 95,7 MB | 283,4 MB | 80,6 % | 768 | 384 px (576) | ≈3x; candidato a probar |
| base p16 512 | 97,1 MB | 283,4 MB | 81,2 % | 768 | 512 px (1024) | ≈6x: más cómputo que large 256 (est.) |
| base p32 256 | 95,9 MB | 283,4 MB | 74,0 % | 768 | 256 px (64) | Mismo tamaño, ≈3x menos cómputo, peor |
| base p16 NaFlex | sin int8: fp32 371,7, fp16 185,9, q4 59,2 MB | no está en el repo (hay un fp32 comunitario de 1.129 MB) | 78,5 % (secuencia 256) | 768 | variable | Ver 3.3 |
| **large p16 256 (probado)** | 319,6 MB (322,0 parchada) | 568,3 MB | 82,5 % | 1024 | 256 px (256) | Sección 1 |
| large p16 384 / 512 | 320,9 / 322,8 MB | 568,3 MB | 83,1 / 83,5 % | 1024 | 384 / 512 px | Mismo tamaño, más cómputo |
| so400m p16 256 | 432,2 MB | 711,1 MB | 83,4 % | 1152 | 256 px | Más pesado que large |
| giant opt p16 256 | 1.170,8 MB | 711,6 MB | 84,5 % | 1536 | 256 px | Fuera de escala |

Cada checkpoint tiene su propio encoder de texto (hashes distintos): cambiar de variante obliga a rehacer el vocabulario con el texto de esa variante. Tokenizer, `tokenizer_config.json` y `special_tokens_map.json` son los mismos en todas.

### 3.2 Otras familias

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

### 3.3 Compatibilidad con onnxruntime-node 1.14

- **int8 de onnx-community:** la incrustación de parches es un ConvInteger con pesos int8 que 1.14 no implementa; se arregla con nuestro parche (verificado en base y en large) o usando el `_uint8.onnx` del mismo tamaño (ConvInteger uint8 × uint8, que 1.14 sí tiene; no probado).
- **q4, q4f16 y bnb4:** usan MatMulNBits o MatMulBnb4, operadores de `com.microsoft` que aparecen recién en ORT 1.17. Con 1.14 no cargan. Es la única forma de bajar base a 63 MB o large a 206 MB, y exige actualizar ORT (lo que arrastra a transformers.js; ver `RECOMENDACIONES_VAULT.md`).
- **fp16:** en CPU, 1.14 casi no tiene kernels fp16; además pesa el doble que int8.
- **NaFlex:** solo fp32 (371,7 MB), fp16 y q4; sin encoder de texto en el repo. Habría que generar el int8 y el texto por nuestra cuenta. Su gracia (respetar el aspecto de la imagen) no compensa: rinde como base 224 (78,5 %).
- **Modelos sin ONNX (PE Core, TIPS, OpenVision):** requieren exportar con PyTorch. En esta máquina hay Python 3.11 con torch 2.12, pero faltan `open_clip`, `timm` y `onnx`, y habría que bajar los pesos (348,8 MB PE Core S16 completo).

### 3.4 Por qué no hay algo más liviano que base

- Los únicos más chicos y buenos (MobileCLIP, MobileCLIP2) no se pueden distribuir por licencia.
- Todo lo que se puede distribuir y pesa menos rinde menos que base en ImageNet: TinyCLIP 41 a 64 %, PE Core T/S 62,1 y 72,7 %, OpenVision sin cifra comparable. En esta prueba, 4,3 puntos de ImageNet (base contra large) separaron "falla en 6 de 16 fotos" de "acierta en las 16"; un modelo 5 puntos o más por debajo de base sería peor que base (est.).
- Base a 384 px no ahorra cómputo (≈3 veces el de base 224) pero no agrega MB: es la única variante que podría acercarse a large sin su peso (sección 5).

---

## 4. Recomendación

1. **Para que funcione en fotos y arte: large 256 int8**, con `CONCEPT_Z` 2,5 y `ALONE_Z` 3,5, vistas de 256 px, y de preferencia solo 2 vistas por imagen. Costo: +228,5 MB en la instalación (334,0 contra 105,5 MB), ≈+420 MB de RAM mientras el modelo está cargado (se libera a los 2 min sin uso) y ≈1,2 s por imagen con 2 vistas. El vocabulario tarda ≈1,5 h en construirse, una vez.
2. **Antes de decidir, probar base 384** (sección 5): si iguala a large en las 16 portadas sin texto, queda en ≈105 MB con ≈0,4 s por vista (est.).
3. **Si el tamaño manda y no se prueba nada más:** base con `TERM_Z` 4,0. Menos chips errados, mismos aciertos, y el usuario debería saber que en fotos de objetos y acciones va a faltar.
4. **Para key art con títulos (MASHIK),** ningún tamaño alcanza: hace falta tratar el texto de la imagen. Large ya tiene la señal (creature, grass, night en su top 40 sin el título); base no.

---

## 5. Si se quiere probar otro candidato: archivos exactos

**SigLIP 2 base patch16 384**, de `https://huggingface.co/onnx-community/siglip2-base-patch16-384-ONNX/resolve/main/`:

| Archivo | Bytes | MB | sha256 (inicio) |
|---|---|---|---|
| `onnx/vision_model_int8.onnx` | 95.720.693 | 95,7 | `ef04b4da38291ee7` |
| `onnx/text_model_int8.onnx` (solo para el build) | 283.438.275 | 283,4 | `30a94b43b9ddc39c` |
| `config.json` | 458 | 0,0 | |
| `preprocessor_config.json` | 394 | 0,0 | |

Total ≈379,2 MB. El tokenizer no hace falta: es idéntico al que ya está (`build-assets/vocab-build/siglip2-tokenizer` sirve tal cual). Con los scripts de esta evaluación: parche (≈1 s), vocabulario (≈25 a 30 min, est.), vistas a 384 px y las mismas dos pruebas (51 imágenes y 16 portadas sin texto).

Alternativa más barata, si se quiere ver primero el efecto de la resolución: `onnx-community/siglip2-base-patch16-256-ONNX`, `onnx/vision_model_int8.onnx` (94.737.653 bytes, 94,7 MB) y `onnx/text_model_int8.onnx` (283.438.275 bytes, 283,4 MB), más `config.json` y `preprocessor_config.json`. Es menos probable que decida algo (79,1 % en ImageNet).

---

## 6. Reproducir

Scripts en `C:\Users\santi\AppData\Local\Temp\sv-model-eval\` (fuera del repo):

| Script | Qué hace |
|---|---|
| `download-large.sh` | Baja exactamente los 7 archivos aprobados de large |
| `onnx-ops.js` | Opsets, operadores y tipos de un ONNX (sin dependencias) |
| `prepare-model.js` | Copia de `prepare-image-model.js` con `--src`, `--hf`, `--out` y `--check` |
| `build-vocab.js` | Copia de `build-image-vocabulary.js` con `--hf`, `--tok`, `--out`; `DIM` desde `config.json` |
| `image-concepts-param.js` | Copia de `ImageConcepts`: tamaño y dimensión por modelo, umbrales por instancia, `select()` separado, tiempos por vista |
| `make-views.js`, `crop-title.js`, `crop-covers.js`, `contact.js` | Electron: vistas como el renderer (224 y 256 px, más recortes), MASHIK sin título, portadas sin título, hojas de contactos |
| `run-calib.js` | Corre el pipeline sobre las vistas: chips, tiempos, carga, RAM pico y volcado de z (`--two` usa 2 vistas) |
| `judge.js`, `replay.js`, `compare.js` | Juicio por imagen, reprueba de umbrales (`--search`, `--cv`) y tablas |
| `per-view.js`, `why.js`, `zstats.js`, `bench.js` | Palabras por vista y puestos de las esperadas, por qué entra o no una palabra, dispersión de z, microbenchmark |
| `brief-cards.js` | Copia del `brief-images-real.js` del orquestador con `MODEL_DIR` y `T` por variable de entorno (base de datos real en solo lectura) |
| `hf-info.js` | Licencia y archivos ONNX con tamaños de un repo de Hugging Face (solo la API) |

Ejemplo: `node run-calib.js --model build-assets/models/siglip2-large --views <vistas> --size 256 --mode app --T "{\"CONCEPT_Z\":2.5,\"ALONE_Z\":3.5}"`. Los resultados (`out/*.json`) y los volcados de z (`z/*.bin`) quedaron en la misma carpeta: `replay.js` reprueba umbrales sin volver a correr los modelos. Las vistas (en `D:\sv-audit-tmp`) se borraron; `make-views.js` las regenera.

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

Leyenda: + correcto · ~ neutro o evocativo · x errado. Entre paréntesis, la categoría UCS cuando difiere de la palabra.

| # | Imagen | Base 224, umbrales actuales | Large 256, umbrales actuales | Large 256, recalibrado |
|---|---|---|---|---|
| 0 | Gore: calavera, huesos, sangre | +gore, +blood, xinside (clock mechanics), xvomit | +gore, +bone | +gore, +bone |
| 1 | Libro de magia y nebulosa | ~holographic (scifi ambience), +shimmering (shimmer), +ethereal (angelic magic), +astral (creature ethereal) | +magick (magic), +alchemy (elemental magic), ~intergalactic (sci-fi weapon), +dreamscape (fantasy), +cosmic (alien), +galactica (sci-fi spaceship) | +magick (magic), +alchemy (elemental magic), ~intergalactic (sci-fi weapon), +dreamscape (fantasy), +cosmic (alien), +galactica (sci-fi spaceship) |
| 2 | Monstruos de dibujo animado | +monster (blob), +toon (cartoon creak), +cartoon swish | xfunhouse (machine amusement), +monster, +creatures, +cartoon swish | +monster |
| 3 | Hielo, cielo, fuego, tierra agrietada | +elemental magic, ~hydrogeology (geothermal) | +elements (weather), +elemental magic | +elements (weather) |
| 4 | Ciudad de noche desde el aire | xcable (audio visual), xbinary (sci-fi computer), xswitchgear (switch), xcyberspace (computers), xelectrician (electricity) | xcyberpunk (scifi ambience), xatmospheric (ambience), xscifi (sci-fi mechanism) | xcyberpunk (scifi ambience), xatmospheric (ambience) |
| 5 | Tigre | +tiger (wild cat), +animalism (wild animal), xleather | +tiger (wild cat), xcreatures, +critters (wild animal), xmonster | +tiger (wild cat), xcreatures, +critters (wild animal) |
| 6 | Butacas rojas de cine | +cinema (public place), xscifi ambience, xhemoglobin (blood) | +cinema (public place) | (nada) |
| 7 | Campera de cuero | +leather, xbookstore (book), ~purse (bag), ~bag (recreational equipment) | +cloth, xscifi (sci-fi mechanism), +garment (fashion), +leather | +cloth, +garment (fashion), +leather |
| 8 | Cuello herido, sangre | +bleeding (blood), +fleshly (flesh) | +flesh, +gore | +flesh, +gore |
| 9 | Zapatilla pisando un charco | +sneakers (fashion) | +footstep (feet), +shuffle (footsteps), xmotion | +footstep (feet), +shuffle (footsteps) |
| 10 | Pistola entre humo | (nada) | +gunflint (antique gun), xsteam-powered (train steam), +firearm (guns), xtrains, +rifle (bullets), +gunshot (bullet impact) | xsteam-powered (train steam), +firearm (guns), +gunstock (gun handle), xtrains, +rifle (bullets) |
| 11 | Puño ensangrentado | +bleeding (blood), +flesh | +gore, +bloodshed (blood), +hand (grab), +fists (fight impact) | +gore, +bloodshed (blood), +hand (grab), +fists (fight impact) |
| 12 | Bruja con ramas, bosque oscuro | +magic (evil magic), xsci-fi (scifi) | +magick (magic), +sorcerer (spell), +magical (fantasy) | +magick (magic), +sorcerer (spell) |
| 13 | Amoladora con chispas sobre metal | xbookstore (book), xgramophone (phonograph), xlaserdisc (audio visual) | xmechanic (gun mechanism), xmechanism (clock mechanics), +machinery (machines), +spark (sparks), xcogwheel (gears), xscifi (sci-fi mechanism) | xmechanic (gun mechanism), xmechanism (clock mechanics), +machinery (machines), +spark (sparks), xcogwheel (gears), xscifi (sci-fi mechanism) |
| 14 | Caballeros y caballo con armadura | xcable (audio visual), xswitchgear (switch), xmellophone (brass), xhandbag (bag), xpulley-block (pulley) | +melee (battle crowd), +combatant (fight), +helm (armor), xscifi (sci-fi mechanism), xcyborg (robots), xcyberpunk (scifi ambience) | +melee (battle crowd), +combatant (fight), +helm (armor), xcyborg (robots), xcyberpunk (scifi ambience) |
| 15 | Arma futurista, neón | +sci-fi (sci-fi weapon), +scifi (sci-fi mechanism) | +scifi (sci-fi mechanism), +cyberpunk (scifi ambience), +futuristic (sci-fi weapon), +cyborg (robots), xglitch, +cyberqueer (hitech ambience) | +cyberpunk (scifi ambience), +futuristic (sci-fi weapon), +scifi, +cyborg (robots), xglitch, +weapon (laser gun) |
| 16 | Madera, grava, piedras | xsci-fi (sci-fi energy), xsubstance (chemicals), xplastic | +rocks | +rocks |
| 17 | Fusil de asalto | +firearm (pistol), +cartridge (bullets) | +weapon (artillery), +firearm (guns), +armament (sci-fi weapon), xscifi (sci-fi mechanism), xcyberpunk (scifi ambience) | +weaponry (warfare), +firearm (guns), +weapons, +armament (sci-fi weapon), +rifle, xcyberpunk (scifi ambience) |
| 18 | Ruta con estelas de luz | xterabytes (hard drive) | +whoosh (swoosh whoosh), xspacex (rocket), xscifi ambience | +whoosh (swoosh whoosh) |
| 19 | Abstracto: flor azul (Windows) | ~plastic, ~rubber, xwindows | ~cloth | ~cloth |
| 20 | Abstracto: arco de luz azul | ~glow (shimmer), ~lidar (laser beam), ~spectrum (electromagnetic), ~spectral (creature ethereal) | ~holographic (scifi ambience), ~aura (shimmer), ~forcefield (sci-fi energy), ~plasma (arc), ~spectrum (electromagnetic) | ~holographic (scifi ambience), ~aura (shimmer), ~forcefield (sci-fi energy), ~plasma (arc), ~spectrum (electromagnetic) |
| 21 | Lago al atardecer, colinas nevadas | +iceberg (tundra), xmoonscape (scifi ambience), +reflection (shimmer), ~atmospheric (weather) | +lakescape (lakeside), xmoonscape (scifi ambience) | +lakescape (lakeside), xmoonscape (scifi ambience) |
| 22 | Abstracto: cintas naranja y violeta | ~plastic, ~rubber, ~paper, xbinder (object office) | xloop, ~abstract (experimental musical), ~cloth | ~cloth |
| 23 | Abstracto: flor gris azulada | ~plastic, ~paper | ~cloth | ~cloth |
| 24 | Azul plano | (nada) | (nada) | (nada) |
| 25 | Abstracto: flor azul | xwindows, ~plastic | xwindows, xdesktop (computers), xloop | (nada) |
| 26 | Tríptico: playa, cerezo, lago | +beach (seaside), +dune (desert), xglass (fashion), +dirt and sand, xhydrogeology (geothermal), ~reflection (shimmer) | +alpine, +lakeside | (nada) |
| 27 | Abstracto: arco de luz violeta | ~glowing (shimmer), ~lidar (laser beam), ~spectrum (electromagnetic), ~photon (sci-fi impact) | ~planet (scifi ambience), ~plasma (arc), ~shield (sci-fi energy), ~glowing (shimmer), ~photon (sci-fi impact) | ~planet (scifi ambience), ~plasma (arc), ~shield (sci-fi energy), ~glowing (shimmer), ~photon (sci-fi impact) |
| 28 | Abstracto: arco de luz azul | ~glow (shimmer), ~lidar (laser beam), ~spectrum (electromagnetic), ~spectral (creature ethereal) | ~holographic (scifi ambience), ~aura (shimmer), ~forcefield (sci-fi energy), ~plasma (arc), ~spectrum (electromagnetic) | ~holographic (scifi ambience), ~aura (shimmer), ~forcefield (sci-fi energy), ~plasma (arc), ~spectrum (electromagnetic) |
| 29 | Abstracto: arco de luz rojo | ~spectrum (electromagnetic), ~lidar (laser beam), ~glow (shimmer), ~photon (sci-fi impact), ~spectral (creature ethereal) | ~planet (scifi ambience), ~plasma (arc), ~forcefield (sci-fi energy), ~glowing (shimmer) | ~planet (scifi ambience), ~plasma (arc), ~forcefield (sci-fi energy), ~glowing (shimmer) |
| 30 | Abstracto: arco de luz verde | ~lidar (laser beam), ~spectrum (electromagnetic), ~lasers, ~glow (shimmer), ~spectral (creature ethereal), ~holographic (scifi ambience) | ~aura (shimmer), ~holographic (scifi ambience), ~spectrum (electromagnetic), ~hologram (sci-fi energy), ~plasma (arc), ~spectral (creature ethereal) | ~aura (shimmer), ~holographic (scifi ambience), ~spectrum (electromagnetic), ~hologram (sci-fi energy), ~plasma (arc) |
| 31 | Abstracto: formas de vidrio | ~paper | ~abstract (experimental musical) | (nada) |
| 32 | Abstracto: cintas | ~abstract (experimental musical) | xloop, ~abstract (experimental musical) | ~abstract (experimental musical) |
| 33 | Abstracto: remolino | ~plastic, ~rubber | ~abstract (experimental musical), xglitch, xloop | ~abstract (experimental musical) |
| 34 | Abstracto: gotas y burbujas | ~abstract (experimental musical), ~blob | xscifi ambience, ~abstract (experimental musical), ~liquid and mud, xwater | ~liquid and mud |
| 35 | Lago, amanecer, nieve | +iceberg (tundra), +lakewater (lakeside), +water, +reflection (shimmer), xboat underwater | +lakewater (lakeside), +icefield (tundra), xhydrogeology (geothermal) | +lakewater (lakeside), +icefield (tundra), xhydrogeology (geothermal) |
| 36 | Lago de montaña con bosque | +lakewater (lakeside), +lagoon (swamp), +water | +lakewater (lakeside), +icecap (tundra), +snow, xhydrogeology (geothermal) | +lakewater (lakeside), +icecap (tundra), +snow |
| 37 | Lago, amanecer, nieve | +iceberg (tundra), +lakewater (lakeside), xsubmerged (boat underwater), +reflection (shimmer), +water | +lakescape (lakeside), xdreamland (fantasy) | +lakescape (lakeside), xdreamland (fantasy) |
| 38 | Dunas junto a un lago | +reflection (shimmer), +water | +dune (desert), +lakeview (lakeside), +dirt and sand, xlandslip (avalanche) | +dune (desert), +lakeview (lakeside) |
| 39 | Abstracto: flor celeste | ~plastic, ~paper, ~rubber, xworkbook (book) | ~cloth, ~paper | ~cloth, ~paper |
| 40 | Abstracto: flor verde salvia | ~plastic | xscifi ambience, xpetals (leaves), ~cloth, ~ceramics | ~cloth |
| 41 | Abstracto: flor rosa | ~paper, xworkbook (book) | ~petals (leaves), ~paper, xloop | ~paper |
| 42 | Abstracto: flor gris | ~plastic, ~rubber | xloop, ~cloth, ~rubber, xscifi ambience | ~cloth, ~rubber |
| 43 | Abstracto: flor azul | xwindows, ~plastic | xwindows, xdesktop (computers), xloop | (nada) |
| 44 | Abstracto: flor azul sobre negro | xwindows | xdesktop (computers) | (nada) |
| 45 | MASHIK: criatura en pasto de noche, ojos gigantes, título | xglitch | xmash (squish), xglitch, +cosmic (alien), xbasilisk (reptilian) | xglitch, +cosmic (alien) |
| 46 | Caja de juego casual con gemas | +boardgame (board game), +baccarat (casino game), ~mechanical toy, +puzzle (machine mechanism), xpaper | +user interface, xice, +console (video game), +celestial (angelic magic), xshimmer | +user interface, xice, +console (video game) |
| 47 | Figura encapuchada con energía azul | xdimmer (switch) | +sci-fi energy, +energy (elemental magic), +electrically (electricity), xray (laser impact), xelectrified (experimental musical), +electrocute (arc) | +sci-fi energy, +energy (elemental magic), +electrically (electricity), xray (laser impact), +electrocute (arc), +warlock (evil magic) |
| 48 | Personaje anime con martillo | (nada) | xdata, xzip | xdata |
| 49 | Maza clavada en tierra | +dirt (dirt and sand), +mud (liquid and mud), +detritus (destruction crash and debris) | +dirt and sand, +shovel (garden tool), xmetal, +digger (vehicle construction), +demolition (construction ambience), xmudslide (avalanche) | +dirt and sand, +shovel (garden tool), xmetal, +demolition (construction ambience), +mud (liquid and mud) |
| 50 | Letras metálicas "MODULAR UI" | xtypeface (typewriter), +circuit (switch) | +user interface, +mcu (sci-fi computer), xdata, xcyberqueer (hitech ambience), +interstellar (scifi ambience), xrender (audio visual) | +user interface, +mcu (sci-fi computer), xdata, xcyberqueer (hitech ambience), +interstellar (scifi ambience) |

| Total | Base 224, umbrales actuales | Large 256, umbrales actuales | Large 256, recalibrado |
|---|---|---|---|
| Chips correctos (+) | 48 | 75 | 68 |
| Chips neutros o evocativos (~) | 52 | 43 | 37 |
| Chips errados (x) | 40 | 59 | 23 |
| Imágenes concretas con al menos un chip correcto (de 31) | 22 | 29 | 27 |
| Chips errados en arte abstracto | 7 | 18 | 0 |
| Imágenes sin ningún chip | 3 | 1 | 7 |
