# Colecciones recomendadas por vault: investigación técnica

**Fecha:** 25/09/2026 · **Rama:** `overhaul-2.0` · **Alcance:** solo investigación, sin cambios de código.

**Función a diseñar:** en la home de un vault, el usuario suma material de referencia (imágenes, notas cortas, sonidos de referencia). La app lo analiza localmente y propone colecciones con nombre, cada una con sonidos candidatos de su propia librería (~70k WAV). Tiene que sentirse instantánea y no puede frenar la app en laptops comunes sin GPU.

**Convenciones.** `[n]` es una fuente externa y `[Rn]` una fuente interna del repo (lista al final). `(est.)` marca una estimación propia, con el razonamiento indicado. `(medido)` es un micro-benchmark propio en la máquina de desarrollo (Intel Core i5-9400, 6 núcleos, Node 24.14.0, un hilo de JS); el código está en el apéndice. Tamaños en MB decimales (10^6 bytes), tomados de los listados de archivos de Hugging Face. Decimales con coma.

---

## Resumen

**Stack recomendado (v1 de la función)**

1. **Decodificación:** en un Web Worker del renderer, con `createImageBitmap` + `OffscreenCanvas`, a RGB de 224 × 224. Para TIFF, PSD y DDS, el ffmpeg que ya viene con la app.
2. **Encoder de imagen:** **SigLIP 2 ViT-B/16 a 224 px**, solo la torre visual, exportada por nosotros a un ONNX que cargue el onnxruntime-node 1.14 actual, cuantizada a int8 (≈95 MB). Apache 2.0, 78,2 % zero-shot en ImageNet [18][19].
3. **Puente imagen → sonido:** zero-shot contra un **vocabulario curado de conceptos sonoros derivado de UCS 8.2**. Cada concepto trae su embedding SigLIP (visual) y su embedding CLAP (audio), los dos precalculados en el build. Los conceptos ganadores se buscan en el índice HNSW de CLAP que ya existe: no se reindexa nada.
4. **Agrupamiento:** temas guiados por conceptos, cada candidato asignado a un solo tema, MMR con penalización por carpeta, y k-means esférico solo para partir temas mezclados. Todo en JS puro.
5. **Runtime:** quedarse en onnxruntime-node 1.14 para esta función. La migración a transformers.js v4 + ORT 1.30 (con DirectML o WebGPU opcionales) va como proyecto aparte, con auditoría de los vectores CLAP.
6. **Sin captioning en v1.** OCR opcional más adelante.

**Números clave**

| Qué | Valor |
|---|---|
| Latencia por imagen, SigLIP 2 B/16 int8, laptop de 4 a 6 núcleos | 40 a 105 ms (est., escalado desde [28]) |
| Tamaño del encoder visual SigLIP 2 B/16 | 94,6 MB int8 · 186,0 MB fp16 · 371,8 MB fp32 [20] |
| Escenario "10 imágenes + 5 palabras → 8 colecciones × 20", en caliente | ≈0,3 a 0,45 s (est. + medido) |
| El mismo escenario en frío (modelo sin cargar, imágenes sin analizar) | ≈1,1 a 2,7 s (est.), todo fuera del hilo de la UI |
| MMR, 8 temas × (250 → 20) | 48 a 52 ms (medido [R9]) |
| k-means k = 8 sobre 2.000 × 512 | 92 a 106 ms (medido [R9]) |
| Reindexar 70k archivos con otro encoder de audio (opción descartada) | ≈10 h (derivado de 540 ms/archivo [R1]) |

**Banderas rojas de licencia**

- **MobileCLIP, MobileCLIP2 y los DFN de Apple:** pesos bajo la Apple Machine Learning Research Model License, que limita el uso a investigación y excluye productos comerciales [8][10][25]. Descartados, aunque sean los más chicos.
- **ImageBind y MetaCLIP:** CC-BY-NC 4.0, no comerciales [26][44]. Descartados.
- **CLIP de OpenAI y los CLIP de LAION/DataComp:** licencia MIT, pero sus fichas declaran fuera de alcance cualquier uso desplegado, comercial o no [3][24]. Evitarlos sin revisión legal.
- **UCS:** el sitio oficial lo presenta como "public domain initiative" [41], pero no encontramos un archivo de licencia formal. Riesgo bajo; confirmarlo en la descarga oficial.
- **Sin problemas:** SigLIP y SigLIP 2 (Apache 2.0) [19], TinyCLIP (MIT) [15], EVA-CLIP (MIT) [27], Florence-2 (MIT) [31], SmolVLM y moondream2 (Apache 2.0) [35][37], PE-AV (Apache 2.0) [48].

---

## 1. Encoders de imagen en CPU vía ONNX

### 1.1 Tabla comparativa

**Método de latencia (est.).** No encontramos mediciones publicadas en ONNX Runtime sobre laptops x86 para estos modelos. Tomamos como referencia un ViT-B/16 (≈35 GFLOPs [1]) en ONNX Runtime: 149 ms en fp32 y 63 ms en int8 dinámico, en una c6i.xlarge de AWS (4 vCPU Ice Lake) [28]. Suponemos que una laptop de 4 a 6 núcleos rinde entre 0,6× y 1,5× esa máquina, y escalamos por GFLOPs del encoder [1]. Control cruzado: CLIP B/32 en ONNX tarda ≈115 ms por imagen en 2 vCPU de Colab [29], lo que con 4 a 6 núcleos daría unos 30 a 40 ms (est.), dentro del rango de la tabla. Las redes convolucionales móviles no escalan así en x86 [13].

| Modelo | Encoder de imagen: params · ONNX fp32 / fp16 / int8 | Latencia CPU por imagen (laptop 4 a 6 núcleos) | Zero-shot IN-1k | Licencia de los pesos | ONNX listo en HF | transformers.js |
|---|---|---|---|---|---|---|
| **SigLIP 2 B/16, 224 px** (recomendado) | ≈93 M (derivado del fp32 de [20]) · 371,8 / 186,0 / 94,6 MB [20] | ≈35 GFLOPs (est., misma arquitectura que SigLIP B/16 [1][23]) · fp32 100 a 250 ms · int8 40 a 105 ms (est.) | 78,2 % [18] | Apache 2.0 [19]: apta | `onnx-community/siglip2-base-patch16-224-ONNX`, torre visual separada [20] | v3/v4 [20][23]. En 2.17 solo si el archivo es IR ≤ 8 [55][63] |
| SigLIP 2 B/32, 256 px (plan B rápido) | ≈94,6 M (derivado de [22]) · fp32 378,4 MB [22] · int8 ≈95 MB (est.) | ≈11,5 GFLOPs (est., análogo a ViT-B-32-256 [1]) · fp32 35 a 80 ms · int8 15 a 35 ms (est.) | 74,0 % [18] | Apache 2.0 [19]: apta. El repo de immich no declara licencia [22] | `immich-app/ViT-B-32-SigLIP2-256__webli`, formato OpenCLIP, sin cuantizar [22] | No aplica: ORT directo o export propio |
| SigLIP B/16, 224 px (v1) | 92,9 M [1] · 371,8 / 186,1 / 94,1 MB [21] | 35,4 GFLOPs [1] · fp32 100 a 250 ms · int8 40 a 105 ms (est.) | 76,2 % [18] | Apache 2.0 [19]: apta | `Xenova/siglip-base-patch16-224` [21] | 2.17 tiene `SiglipVisionModel` [R4]. Los int8 se regeneraron para v3 en 07/2025 [21] |
| CLIP OpenAI B/32 | 87,8 M [1] · 351,7 / 176,1 / 88,6 MB [5] | 8,8 GFLOPs [1] · fp32 25 a 60 ms · int8 10 a 25 ms (est.) | 63,3 % [2] | Código MIT [4]; la ficha excluye todo uso desplegado [3]: dudosa | `Xenova/clip-vit-base-patch32` [5] | 2.17: sí (`CLIPVisionModelWithProjection`) [R4]; v3/v4: sí [40] |
| CLIP OpenAI B/16 | 86,2 M [1] · 345,1 / 172,8 / 87,5 MB [6] | 35,1 GFLOPs [1] · fp32 100 a 250 ms · int8 40 a 105 ms (est.) | 68,3 % [2] | Igual que B/32: dudosa [3][4] | `Xenova/clip-vit-base-patch16` [6] | Igual que B/32 |
| MobileCLIP S0 / S1 / S2 / B | 11,4 / 21,5 / 35,7 / 86,3 M [7] · fp32 45,5 / 86,0 / 143,0 / 345,6 MB · int8 11,8 / 22,4 / 36,7 / 87,5 MB [12] | Sin dato en x86 con ONNX. En iPhone 12 Pro Max: 1,5 / 2,5 / 3,6 / 10,4 ms [7]. S2 en PyTorch sobre un i7-12700K: 171 ms, contra 114 ms de ViT-B/32-256 [13] | 67,8 / 72,6 / 74,4 / 76,8 % [7] | Apple ML Research Model License, solo investigación [8][10]: **no apta** | `Xenova/mobileclip_s0`, `_s1`, `_s2`, `_b` [12] | v3/v4 (MobileCLIP listado) [40] |
| MobileCLIP2 S0 / S2 / B | 11,4 / 35,7 / 86,3 M [7] | Igual que MobileCLIP [7] | 71,5 / 77,2 / 79,4 % [7] | La misma licencia de investigación [10]: **no apta** | Solo exportaciones comunitarias [14] | Sin verificar |
| TinyCLIP ViT-8M/16 (YFCC-15M) | ≈8 M (según el nombre) · modelo combinado imagen+texto 94,1 / 47,2 / 24,3 MB [17] | 2,0 GMACs por par [15] · 10 a 30 ms (est.) | 41,1 % [15] | MIT [15][16]: apta | `onnx-community`, solo modelo combinado [17] | v3/v4 [17] |
| TinyCLIP ViT-39M/16 (YFCC-15M) | ≈39 M · combinado 332,8 / 166,6 / 84,7 MB [17] (83,1 M en total [16]) | 9,5 GMACs por par [15] · fp32 55 a 135 ms · int8 25 a 55 ms (est.) | 63,5 % [15] | MIT [15][16]: apta | `onnx-community`, solo combinado [17] | v3/v4 [17] |
| TinyCLIP ViT-61M/32 y auto-45M/32 (LAION-400M) | ≈61 / ≈45 M (según el nombre) | 5,3 / 3,7 GMACs por par [15] · fp32 20 a 75 ms (est.) | 62,4 / 61,4 % [15] | MIT [15]: apta | No encontrado | ORT directo tras export propio |
| OpenCLIP B/32 LAION-2B (s34b_b79k) | 87,8 M [1] | 8,8 GFLOPs [1] · fp32 25 a 60 ms · int8 10 a 25 ms (est.) | 66,6 % [2] | MIT, pero la ficha excluye todo uso desplegado [24]: dudosa | `immich-app/ViT-B-32__laion2b-s34b-b79k` [22] | ORT directo |
| OpenCLIP B/32 256 px DataComp (s34b_b86k) | 87,9 M [1] | 11,5 GFLOPs [1] · fp32 35 a 80 ms · int8 15 a 35 ms (est.) | 72,7 % [24] | MIT, con la misma exclusión [24]: dudosa | No encontrado | ORT directo tras export propio |
| DFN2B B/16 (Apple) | 86,2 M [1] | 35,1 GFLOPs [1] · fp32 100 a 250 ms (est.) | 76,2 % [2] | apple-amlr [25]: **no apta** | No buscado | No aplica |
| MetaCLIP B/32 | 87,8 M [1] | 8,8 GFLOPs [1] · fp32 25 a 60 ms (est.) | 67,7 % [2] | CC-BY-NC 4.0 [26]: **no apta** | No buscado | No aplica |
| EVA02-CLIP B/16 | 86,3 M [1] | 35,1 GFLOPs [1] · fp32 100 a 250 ms · int8 40 a 105 ms (est.) | 74,7 % [2] | MIT [27]: apta | No encontrado | ORT directo tras export propio (EVA usa código propio) |

### 1.2 Notas por familia

- **SigLIP y SigLIP 2 (Google).** Mejor calidad por FLOP con licencia limpia. SigLIP 2 B/16 supera a SigLIP B/16 por 2 puntos al mismo costo (78,2 % contra 76,2 % [18]). La variante FixRes (la de 224 px) es compatible hacia atrás con la arquitectura SigLIP [23], así que el grafo visual es el mismo que el de v1. Dos detalles que importan:
  - **Salida sigmoide:** SigLIP da una probabilidad independiente por etiqueta (`sigmoid` de los logits [23]). Una imagen puede ser "lluvia" y "castillo" a la vez sin que compitan, y eso encaja mejor con un etiquetado multi-concepto que el softmax de CLIP.
  - **Torre de texto pesada:** el encoder de texto de SigLIP 2 usa el tokenizador de Gemma con 256k tokens [18] y pesa 1.129,5 MB en fp32 y 283,4 MB en int8 [20]. **No hay que enviarlo:** los embeddings del vocabulario se calculan una vez en el build (con `padding="max_length"`, `max_length=64` y texto en minúsculas, como pide la documentación [23]).
- **CLIP de OpenAI.** Es el único que corre hoy sin tocar nada (transformers.js 2.17 tiene la clase [R4]), pero queda último en precisión dentro de su tamaño (63,3 % el B/32 y 68,3 % el B/16 [2]) y su ficha deja fuera de alcance cualquier uso desplegado [3]. El repo es MIT [4], pero esa licencia no menciona los pesos.
- **MobileCLIP y MobileCLIP2 (Apple).** Muy chicos (S0: 11,8 MB en int8 [12]) y buenos (MobileCLIP2-B 79,4 % [7]), pero hoy los pesos de ambas generaciones figuran bajo la licencia de investigación de Apple [8][10]. Detalle histórico: entre julio de 2024 y agosto de 2025 el repo traía una licencia de pesos permisiva de Apple, que permitía usar, reproducir, modificar y redistribuir [9]; se reemplazó en el commit del lanzamiento de MobileCLIP2 [8][9]. La situación es ambigua y no conviene apoyarse en ella. Además, su ventaja de latencia se midió en el Neural Engine del iPhone; en CPU x86 con PyTorch, S2 fue más lento que un ViT-B/32 a 256 px [13].
- **TinyCLIP (Microsoft).** MIT y liviano, pero los que caben en el presupuesto rinden como CLIP B/32 (61 a 64 % [15]) o bastante menos (41,1 % el de 8M [15]). En Hugging Face solo hay modelos combinados imagen+texto [17]: habría que re-exportar la torre visual.
- **OpenCLIP (LAION, DataComp).** El B/32 a 256 px de DataComp llega a 72,7 % [24] con ≈11,5 GFLOPs [1], parecido a SigLIP 2 B/32-256 (74,0 % [18]), pero arrastra la misma exclusión de uso desplegado en la ficha [24].
- **EVA02-CLIP B/16.** MIT y 74,7 % [2], pero sin exportación ONNX lista y con código propio. No aporta nada sobre SigLIP 2 B/16, que es mejor al mismo costo.

### 1.3 Compatibilidad con el runtime actual

- La app usa `@xenova/transformers` 2.17.2, que fija `onnxruntime-node` 1.14.0 [R4]. ORT 1.14 acepta hasta **IR 8 y opset 18** [55]. Muchos modelos exportados en la era de transformers.js v3 vienen con IR 9 o más y fallan en 2.17.2 [63]. Por ejemplo, los int8 de `Xenova/siglip-base-patch16-224` se regeneraron para v3 en julio de 2025 [21].
- En Node, los procesadores de imagen de transformers.js 2.17 redimensionan y recortan con `sharp` [R4], y SoundVault reemplaza `sharp` por un stub que tira error [R5]. **Conclusión:** con cualquier modelo, el camino real es preprocesar a mano y pasar `pixel_values` directo a una sesión de ORT, con o sin las clases de transformers.js.
- **Recomendación práctica:** exportar la torre visual nosotros (opset 17, IR 8), cuantizarla con dynamic int8 usando herramientas contemporáneas de ORT 1.14, y agregar un test que la cargue con el ORT del producto. Alternativa sin export: fijar una revisión anterior a julio de 2025 de `Xenova/siglip-base-patch16-224` (SigLIP v1, 76,2 %), creado en diciembre de 2023 para transformers.js v2 [21]. Esa compatibilidad hay que verificarla, porque no la confirmamos.
- **fp16:** en ORT 1.30, `Gemm` y `MatMul` en fp16 sobre CPU solo corren en fp16 si el hardware lo acelera; si no, caen a fp32 [52]. Un modelo fp16 no es más rápido en una laptop común (est.). Para ahorrar disco sin perder precisión sirve la técnica que el repo ya usa con el texto de CLAP: pesos guardados en fp16 más un `Cast` a fp32 al cargar (501 → 251 MB, coseno 1,00000 [R6]).

---

## 2. Captioning y etiquetado: ¿suman sobre el zero-shot?

| Modelo | Tamaño | Costo en CPU | Licencia | transformers.js | ¿Suma para sonido? |
|---|---|---|---|---|---|
| Florence-2-base (-ft) | 231,6 M params [31] · ONNX total ≈1.085,9 MB fp32, ≈544,0 MB fp16, ≈275,0 MB int8 (suma de archivos de [32]) | Entrada de 768 × 768 [32]. Solo el encoder visual: 744 ms en ORT CPU, hardware no informado [34]. Varios segundos por imagen en CPU, según Roboflow [33] | MIT [31] | v3/v4 (`Florence2ForConditionalGeneration`) [40]; sensible a cuantizar el encoder [62] | OCR y detección de objetos: sí. Conceptos sonoros: poco (est.) |
| BLIP base (captioning) | ≈247 M (est., del checkpoint fp32 de 989,8 MB [38]) | 0,5 a 2 s por imagen (est.) | BSD-3-Clause [38] | No figura entre los modelos soportados [40] | No |
| RAM++ | Checkpoint de 3,01 GB más 478,9 MB de embeddings de etiquetas [39] | Swin-L: más de 1 s por imagen (est.) | Apache 2.0 [39] | No | 4.585 etiquetas visuales genéricas [39], no sonoras |
| SmolVLM-256M | 256 M, encoder SigLIP de 93 M [35] · ONNX total ≈1.028,5 MB fp32, ≈259,9 MB int8 (suma de archivos de [35]) | Teselas de 512 px, con lado mayor de 2048 por defecto [35]. 2 a 6 s por imagen (est.) | Apache 2.0 [35] | v3/v4 (SmolVLM, Idefics3) [40] | Texto libre que hay que volver a mapear: no |
| moondream2 | 1,93 B params [37] | 5 a 20 s por imagen (est.) | Apache 2.0 [37] | Figura "Moondream1"; moondream2 sin verificar [40] | No para v1 |

**Veredicto.** No en v1. Un caption describe lo que se ve ("un hombre frente a un castillo") y después hay que volver a mapear ese texto a conceptos sonoros. El zero-shot sobre un vocabulario sonoro curado ya devuelve esos conceptos, con puntaje, a una fracción del costo: un caption de Florence-2 cuesta del orden de 10 a 100 veces una pasada de SigLIP B/16 (est., comparando [33][34] con la tabla 1.1), y descarga unas 3 a 11 veces más (275,0 a 1.085,9 MB contra 94,6 MB [20][32]). Lo único que un captioner aporta de verdad es **OCR** en capturas y moodboards con texto ("Nivel 3: cavernas de hielo"). Si las pruebas muestran que hace falta:

- OCR solo: PaddleOCR (Apache 2.0); su modelo tiny PP-OCRv6 tiene 1,5 M params [76].
- Descripción más rica: Florence-2-base como "análisis profundo" opcional, descargado a pedido.

---

## 3. Puente imagen → sonido

### 3.1 Opción A: zero-shot sobre conceptos sonoros, CLAP texto y HNSW (recomendada)

1. **Vocabulario.** UCS 8.2 tiene 82 categorías y 753 subcategorías con explicaciones y sinónimos [43][77]; 8.2 fue declarada la versión final [42] y 8.2.1 (enero de 2024) solo corrigió un error y sumó sinónimos [41]. Sobre esa base se arma una tabla curada de ≈1.000 a 1.500 conceptos (est.). Cada concepto lleva:
   - etiqueta en español y en inglés (UCS tiene versiones traducidas [41]);
   - CatIDs de UCS (así el buscador léxico, que ya entiende abreviaturas UCS [R1], puede sumar coincidencias por nombre de archivo);
   - 3 a 8 *prompts visuales* para SigLIP ("a rainy night street", "concept art of a rainy city");
   - 2 a 5 *prompts de audio* para CLAP ("heavy rain on pavement with distant thunder");
   - un tipo (ambiente, objeto, acción, material, género).
2. **Build.** Se promedian los embeddings de los prompts de cada concepto. En CLIP, ensamblar 80 prompts sumó 3,5 puntos en ImageNet sin costo de inferencia, y junto con la ingeniería de prompts casi 5 [30]. Resultado: una matriz SigLIP de ≈1.500 × 768 y una CLAP de ≈1.500 × 512 en fp16, unos 4 MB en total (est.). Los vectores CLAP se calculan con el mismo modelo de texto fp16 del producto [R6].
3. **Runtime.** La imagen se convierte en vector SigLIP, se puntúa contra los conceptos con sigmoide [23], los mejores conceptos pasan a sus vectores CLAP y esos vectores se buscan en el HNSW actual (< 1 ms por consulta [R0]).

**Por qué es la opción pragmática:** reutiliza los 70k vectores CLAP ya calculados (reindexar con otro encoder de audio costaría ≈10 h por máquina: 540 ms por archivo [R1]); los nombres de las colecciones salen solos del concepto, en el idioma de UCS que los diseñadores ya usan; se puede curar (sacar conceptos, sumar sinónimos); la licencia es limpia; y solo agrega un encoder visual de ≈95 MB más ≈4 MB de vocabulario (est.).

**Límite conocido:** hay categorías UCS que no se ven en una imagen (USER INTERFACE, SWOOSHES, DESIGNED [77]). Salen de las notas de texto o de pistas de género ("captura de videojuego sci-fi" lleva a beeps de UI), y eso depende del mapeo curado.

### 3.2 Opción B: embeddings conjuntos imagen-audio

| Modelo | Tamaño | Licencia | ¿Reusa el índice CLAP? | Viabilidad |
|---|---|---|---|---|
| ImageBind (huge) | Encoder de imagen ViT-H de 630 M [44] | CC-BY-NC 4.0 para código y pesos [44] | No | Nula por licencia |
| AudioCLIP | CLIP RN50 + ESResNeXt [45] | Código MIT [45]; depende de los pesos CLIP de OpenAI [3] | No | Baja: modelo de 2021; zero-shot 69,4 % en ESC-50 [45] |
| Wav2CLIP | Audio ResNet-18 destilado de CLIP sobre VGGSound [46] | MIT [46] | No | Baja: calidad menor y datos de YouTube |
| LanguageBind (audio) | Checkpoint de audio de 1,71 GB [47] | MIT la mayor parte; el dataset es CC-BY-NC 4.0 [47] | No | Baja: pesado |
| PE-AV (Meta, 2025) | 847 M (small) a 2,23 B (large) params [48] | Apache 2.0 [48] | No | Baja en CPU: tamaño, sin ONNX y reindexado total |
| V2A-Mapper (idea) | Mapper liviano de embedding visual CLIP a embedding de audio CLAP, con los modelos base congelados [50] | Sin evaluar | **Sí** | Línea de investigación futura: necesita pares imagen-audio para entrenarse |

Todas las opciones de B, salvo el mapper, necesitan un segundo índice de audio sobre 70k archivos y un segundo espacio vectorial que mantener. Además, esos modelos se entrenan con video "in the wild". Wilkins et al. (WASPAA 2023) buscan efectos de sonido de alta calidad a partir de video usando **el lenguaje como puente**, y los usuarios prefirieron sus resultados frente a la línea base audiovisual entrenada con YouTube el 67 % de las veces [49].

### 3.3 Veredicto

**A.** Es la única opción con licencia limpia, costo marginal chico y sin reindexar. Queda anotado V2A-Mapper [50] como posible mejora futura que respeta el índice CLAP.

---

## 4. Runtime: onnxruntime-node y transformers.js

**Estado.**

- **Hoy:** `@xenova/transformers` 2.17.2 (29/05/2024 [58]) con `onnxruntime-node` 1.14.0 (11/02/2023 [52]) [R4].
- **Última versión:** `onnxruntime-node` **1.30.0**, publicada el 10/09/2026 [51][52].
  - Proveedores en Node [53]: CPU en todas las plataformas; **DirectML** en Windows x64 y arm64; **WebGPU** en Windows, marcado como experimental; CUDA solo en Linux x64.
  - Los binarios de Windows x64 suman ≈66,9 MB [54]: `DirectML.dll` 18,5 MB, `dxcompiler.dll` 18 MB, `dxil.dll` 1,51 MB, `onnxruntime.dll` 28,8 MB. El `onnxruntime.dll` de 1.14 pesa 9,3 MB [R4].
- **DirectML:** en mantenimiento ("sustained engineering"); Microsoft recomienda Windows ML para lo nuevo [56]. Requiere GPU DirectX 12 y Windows 10 1903 o posterior, no admite optimizaciones de *memory pattern* ni llamadas concurrentes a `Run` sobre la misma sesión [56]. Se elige con `executionProviders: ['dml', 'cpu']` [57].
- **transformers.js en Node:**
  - v3.0.0 (22/10/2024) sumó Deno y Bun a Node y cambió `quantized` por `dtype` [58][62]; la última v3 es la 3.8.1 (02/12/2025) [58].
  - v4.0.0 (30/03/2026) trae un runtime WebGPU que también corre en Node, Bun y Deno [58][59].
  - La 4.3.0 (16/09/2026) depende de `onnxruntime-node` 1.30.0, de `onnxruntime-web` 1.31.0-dev y de `sharp` ^0.35.4 [60].
  - En Node el dispositivo por defecto es CPU; en Windows ofrece `dml` y `webgpu` [61].

**Qué implica migrar desde 1.14.**

1. **Vectores guardados:** los 70k vectores CLAP se calcularon con ORT 1.14. Hay que auditar que el modelo de audio y el de texto den lo mismo (umbral sugerido: coseno ≥ 0,9999 y mismo top-k sobre una muestra, como en la auditoría de fp16 [R6]). Hay un caso documentado en que un cambio de API en v3 cargó otro archivo de modelo y cambió los embeddings sin aviso [64]: `dtype: 'fp32'` explícito para CLAP.
2. **Empaquetado:** pasa de `bin/napi-v3` a `bin/napi-v6` [54]. Hay rutas fijas en `package.json`, `scripts/verify-dist.js` y `scripts/stage-crt-dlls.js` [R7]. Se suman unos 58 MB de binarios (≈66,9 MB [54] contra 9,3 MB [R4]); si no se usa DirectML, se podrían podar sus DLL, cosa que hay que verificar.
3. **Stubs:** `sharp` y `onnxruntime-web` siguen siendo dependencias en v4 [60], así que los stubs actuales [R5] siguen haciendo falta.
4. **DLL de Windows:** si ya hay cargado un DLL con el mismo nombre, Windows usa ese sin importar la carpeta [65]. No se pueden mezclar dos versiones de ORT en un mismo proceso. Además, hay instalaciones de Windows con un `onnxruntime.dll` 1.17.1 en System32 que otras apps terminaron cargando por error [66]: después de migrar, verificar qué DLL carga la app empaquetada.
5. **Formato de modelos:** lo nuevo (IR 9 o 10) necesita ORT 1.16 o 1.18 como mínimo [55], así que la migración también destraba los exports actuales de Hugging Face.

**Recomendación.** Para esta función no hace falta migrar: el encoder visual corre en CPU en menos de 1,1 s para 10 imágenes (est., tabla 1.1). DirectML está en mantenimiento y WebGPU en Node es experimental [53][56]. Conviene planear la migración a v4 + ORT 1.30 como proyecto propio, con la auditoría CLAP, cuando aparezca otra razón (seguridad, GPU opcional, ARM64). No conviene levantar un segundo proceso con otro ORT solo para las imágenes: duplica binarios y obliga a instalar dos versiones del mismo paquete npm.

---

## 5. Agrupamiento y diversidad en JS

**Mediciones propias** [R9]. Son 2.000 vectores unitarios sintéticos de 512 dimensiones con estructura de clusters, en JS puro y un hilo, en un i5-9400. Cada cifra es la mediana de 3 a 5 repeticiones, y el rango cubre dos corridas: una con bucle simple y otra con desenrollado × 8, que no mejoró los tiempos. En una laptop de gama media esperá entre 1 y 2 veces estos tiempos (est.).

| Operación | Tiempo | Comentario |
|---|---|---|
| 1 millón de productos punto de 512-D | 953 a 1.020 ms | ≈0,5 G multiplicaciones-suma por segundo en un hilo |
| k-means esférico, k = 8, k-means++, hasta 25 iteraciones | 92 a 106 ms | Lloyd cuesta O(n·k·d·i) [71] |
| k-means, k = 16 | 155 a 170 ms | |
| Matriz de similitud completa 2.000 × 2.000 | 2,0 s | **Evitar.** El aglomerativo sin restricciones es caro [72] |
| Aglomerativo average-linkage (cadena de vecinos más cercanos), con la matriz ya hecha | 83 a 112 ms | Algoritmos eficientes en [73]; el costo está en la matriz |
| MMR, 8 temas × (250 → 20), λ = 0,7 | 48 a 52 ms | MMR [74] |
| Zero-shot: 10 imágenes × 3.000 conceptos × 768-D | 37 a 77 ms | Cota superior; con ≈1.500 conceptos, la mitad (est.) |
| Búsqueda exacta: 8 consultas × 70k × 512-D | 586 a 597 ms | Por eso se usa HNSW (< 1 ms por consulta [R0]) |

**Algoritmo recomendado.** No hace falta un clustering genérico para *nombrar* grupos: los temas salen de los conceptos.

1. **Evidencia por concepto:** probabilidades sigmoides de las imágenes (con tope por imagen para que una sola no domine), más la similitud de las notas y de los sonidos de referencia con el vector CLAP del concepto.
2. **Elección de temas:** selección golosa con diversidad (MMR sobre los vectores CLAP de los conceptos), para no proponer "lluvia" y "lluvia fuerte" como dos colecciones. Los casi sinónimos se unen en un tema con varias consultas.
3. **Candidatos:** por tema, HNSW top-250 (8 × 250 = 2.000 candidatos).
4. **Asignación exclusiva:** cada sonido va al tema donde puntúa más alto. Se aplica el piso calibrado que ya existe (`cutoffFor`: por debajo de 0,30 de coseno, a lo sumo el 8 % fue relevante [R2]). Ojo: en CLAP la similitud texto-audio nunca pasa de ≈0,6 [R1].
5. **Diversidad por tema:** MMR con penalización por carpeta. En la librería real, el 88 % de las veces el top-10 de vecinos incluye un "hermano" de la misma sesión [R1], así que sin esto una colección se llena con un solo pack. Se quitan duplicados exactos con la regla de 0,9995 que ya existe [R2].
6. **Ranking:** los temas se ordenan por evidencia × calidad de su top-20; quedan 8.
7. **Opcional:** k-means esférico (k = 2 o 3) para partir un tema que salió mezclado (ej.: "bosque" en pájaros y viento).

Sin dependencias nuevas: `ml-kmeans` y `ml-hclust` existen y son MIT [75], pero un k-means esférico sobre `Float32Array` son ≈30 líneas (ver apéndice). Para no trabar las búsquedas del engine host, el trabajo se corta en tramos cortos, como ya se hace al armar el HNSW (tramos de ≤ 35 ms [R1]).

---

## 6. Decodificar imágenes en Electron sin dependencias nativas

**Veredicto: el enfoque es sólido.** Además, es el único que no agrega dependencias: en el proceso del motor no hay DOM, y el camino de imágenes de transformers.js en Node necesita `sharp` [R4], que SoundVault no incluye [R5].

- **Dónde:** en un **Web Worker** del renderer. `createImageBitmap` y `OffscreenCanvas` funcionan en workers [67], así que la UI nunca se traba.
- **Cómo:**
  - `createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'none', resizeWidth: 224, resizeHeight: 224, resizeQuality: 'high' })` [67]. `from-image` respeta la orientación EXIF; `default` convierte los perfiles de color a lo que decide el navegador (sRGB en la práctica, est.).
  - Para PNG con transparencia: dibujar sobre un canvas opaco con fondo neutro antes de `getImageData`, para que el alfa no se vuelva negro (est.).
  - Enviar RGB `Uint8` (150 KB por imagen) y normalizar en el motor, donde viven la media y el desvío de cada modelo.
- **Preprocesado igual al del entrenamiento:**
  - SigLIP 2 redimensiona a 224 × 224 **sin recorte** (aplasta), con remuestreo bilineal y media/desvío 0,5 [20].
  - El B/32-256 de immich usa 256 × 256, aplastado y bicúbico [22].
  - CLIP usa el lado corto a 224 más recorte central, bicúbico, con su propia media y desvío [5].
  - El remuestreo del navegador no es idéntico al de PIL: validar contra la referencia en Python (ver riesgos).
- **Transporte:**
  - Por el RPC actual (renderer → main → engine host): son pocos KB y el costo es despreciable (est.).
  - O con un `MessagePort` directo. Main crea un `MessageChannelMain`, le pasa una punta al renderer con `webContents.postMessage`, que es la única forma de transferir puertos [70], y la otra al utility process con `child.postMessage(msg, [port])` [70].
- **Formatos:**
  - Chromium decodifica JPEG, PNG, WebP, AVIF, GIF, BMP, ICO y SVG; TIFF no (fuera de Safari) [69].
  - Para TIFF, PSD y DDS, el ffmpeg 6.1.1 incluido tiene decodificadores `tiff`, `psd` y `dds` [R8]: puede escalar a 224 y devolver `rawvideo rgb24` por stdout.
  - HEIC no está cubierto (pregunta abierta).
- **Imágenes enormes:** una de 8.000 × 8.000 ocupa ≈256 MB en RGBA al decodificar (est.). Conviene limitar el tamaño o leer las dimensiones antes. `ImageDecoder` acepta `desiredWidth`/`desiredHeight`, pero solo sirven si el códec decodifica a menor resolución [68].
- **Moodboards y collages:** un embedding global diluye los detalles. Conviene sumar teselas (imagen entera + cuadrícula 2 × 2) y tomar el máximo por concepto, a 5 veces el costo por imagen (est.).

---

## 7. Stack recomendado

```
Renderer (Web Worker)                 Engine host (utility process, ORT 1.14)
────────────────────                  ─────────────────────────────────────────
imagen ─ createImageBitmap ─► RGB 224 ─► SigLIP 2 B/16 visual (int8, carga perezosa)
         (TIFF/PSD: ffmpeg)               └► vector 768 ─► sigmoide vs conceptos (precalc.)
nota ─────────────────────────────────►  translate.js ─► CLAP texto (ya cargado)
sonido de referencia ─────────────────►  CLAP audio (carga perezosa, ya existe)
                                          │
                                          ▼
                        evidencia por concepto ─► temas (MMR de conceptos)
                                          ─► HNSW CLAP (existente) top-250 por tema
                                          ─► asignación exclusiva + piso calibrado
                                          ─► MMR con penalización por carpeta ─► 8 × 20
```

**Justificación, en corto.**

- **SigLIP 2 B/16:** la mejor precisión zero-shot entre los modelos de licencia limpia y costo de un ViT-B (78,2 % [18], Apache 2.0 [19]). La salida sigmoide sirve para etiquetar varios conceptos a la vez [23]. Solo se envía la torre visual (94,6 MB en int8 [20]).
- **Plan B:** SigLIP 2 B/32-256 cuesta unas 3 veces menos (≈11,5 contra ≈35 GFLOPs, est. [1]) y pierde 4,2 puntos (74,0 % [18]). Se elige con el benchmark en las laptops objetivo, no antes.
- **Nada de reindexar:** el puente por conceptos reutiliza CLAP y el HNSW, que ya andan. Evita ≈10 h de reanálisis por usuario [R1] y la licencia no comercial de ImageBind [44].
- **Mismo runtime:** sin migrar ORT, el riesgo sobre los 70k vectores guardados es cero.
- **Sensación instantánea:**
  - Cada referencia se analiza **al agregarla** (≈0,05 a 0,1 s por imagen, est.) y se guardan su vector y sus puntajes por concepto.
  - Al abrir la home del vault se muestran las propuestas guardadas: es leer un JSON, sin costo apreciable (est.).
  - Las propuestas se recalculan en segundo plano, con un debounce como los 800 ms que ya usa el motor [R2].
  - El modelo visual se descarga de memoria tras un rato inactivo, igual que el worker de indexado (60 s [R2]).
  - Mientras se analizan referencias conviene pausar o frenar el catálogo, que usa hasta "núcleos menos 2" hilos de ONNX [R1].

---

## 8. Presupuesto: "10 imágenes + 5 palabras → 8 colecciones × 20 candidatos"

| Paso | Costo | Base |
|---|---|---|
| Decodificar y redimensionar 10 imágenes (Web Worker) | 10 a 60 ms por imagen de 2 a 12 MP; en paralelo con la inferencia | est. |
| Cargar el encoder visual int8 (primera vez) | 0,3 a 1,0 s | est. |
| Inferencia SigLIP 2 B/16 int8, 10 imágenes | 0,4 a 1,05 s (40 a 105 ms c/u) | est., tabla 1.1 |
| (Alternativa B/32-256 int8) | 0,15 a 0,35 s | est., tabla 1.1 |
| Zero-shot 10 × ≤3.000 conceptos | 37 a 77 ms | medido [R9] |
| 5 palabras: traducción + CLAP texto | ≈250 ms (≈50 ms c/u); ≈0 si están en la caché LRU de 128 consultas [R2] | [R3] |
| Evidencia, fusión y elección de temas | < 10 ms | est. |
| HNSW: 8 temas × hasta 3 consultas | < 25 ms | [R0] |
| Asignación + MMR 8 × (250 → 20) | 48 a 52 ms | medido [R9] |
| k-means opcional (2.000 × 512, k = 8) | 92 a 106 ms | medido [R9] |
| **Total en caliente** (imágenes ya analizadas al agregarlas) | **≈0,3 a 0,45 s**; ≈0,05 a 0,2 s con las palabras en caché | suma |
| **Total en frío** (B/16) | **≈1,1 a 2,7 s** | suma |
| **Total en frío** (B/32-256) | ≈0,8 a 2,0 s | suma |
| RAM extra con el modelo visual cargado | +100 a 250 MB, liberables | est. |
| Disco extra | +94,6 MB (int8) [20] + ≈4 MB de vocabulario (est.) | |

Todo corre fuera del hilo de la UI (Web Worker y utility process). Las cifras medidas son de un escritorio i5-9400; en una laptop lenta pueden duplicarse (est.) y el caso en caliente sigue por debajo de 1 s.

---

## 9. Riesgos

1. **ONNX y ORT 1.14:** los exports nuevos con IR 9 o más no cargan [55][63]. *Mitigación:* export propio con opset ≤ 17 e IR 8, más un test de carga en CI.
2. **Dos ORT en un proceso:** Windows reutiliza el DLL ya cargado [65]. *Mitigación:* una sola versión de ORT por proceso, y migración completa cuando toque.
3. **`onnxruntime.dll` en System32** (1.17.1 en algunas PCs [66]) al migrar. *Mitigación:* verificar en la app empaquetada qué DLL se carga.
4. **Paridad de preprocesado** (navegador contra PIL) **y cuantización int8.** *Mitigación:* sobre 100 imágenes, comparar contra la referencia en Python: coseno ≥ 0,99 y mismo top-5 de conceptos en ≥ 90 % de los casos (umbrales est.). Si int8 no pasa, usar pesos fp16 con `Cast` [R6].
5. **Formatos no soportados:** HEIC, PSD con capas raras, TIFF de 16 bits [69][R8]. *Mitigación:* ffmpeg como respaldo y un mensaje claro para lo que no se pueda leer.
6. **Collages y conceptos invisibles** (UI, whooshes): teselado, notas y mapeo curado. La calidad depende de la curaduría del vocabulario.
7. **Calibración:** la similitud texto-audio de CLAP es baja por naturaleza (≤ ≈0,6 [R1]). *Mitigación:* pisos por tema y descartar temas con candidatos débiles, en vez de rellenar hasta 20.
8. **Hermanos de sesión:** colecciones monótonas si no se penaliza por carpeta [R1].
9. **Competencia por CPU con el catálogo** [R1]: coordinar prioridades y limitar los hilos de la sesión visual.
10. **Notas en español:** `translate.js` es un diccionario de vocabulario SFX y deja sin traducir lo que no conoce [R10], y CLAP solo entiende inglés. *Mitigación:* sumar sinónimos en español al vocabulario, con las traducciones de UCS [41].
11. **Procedencia de pesos:** el export de immich no declara licencia [22]. *Mitigación:* exportar desde los pesos originales de Google [19] e incluir el aviso de Apache 2.0.
12. **Migración futura de ORT:** cambios de API que cargan otro archivo sin avisar [64]. *Mitigación:* `dtype` explícito y auditoría de CLAP.

## 10. Preguntas abiertas

1. ¿El modelo visual viaja en el instalador (+94,6 MB) o se descarga al primer uso?
2. ¿B/16 o B/32-256? Decidirlo con un benchmark en 2 o 3 laptops objetivo, una de gama baja incluida.
3. ¿Quién cura el vocabulario y con qué criterio de "audibilidad"? ¿Los nombres de las colecciones van en español (traducciones UCS) o en inglés?
4. ¿Hace falta OCR para capturas con texto (PaddleOCR [76] o Florence-2 [31])?
5. ¿Hay que soportar HEIC? Chromium no lo decodifica [69]; con el ffmpeg incluido no lo verificamos.
6. ¿Puede un mismo sonido aparecer en dos colecciones propuestas?
7. ¿Qué conjunto de evaluación usamos? Propuesta: 50 a 100 referencias reales con sus colecciones esperadas, medidas con P@20 como en la auditoría semántica existente (0,77 [R1]).
8. ¿Cuándo migrar ORT, y por qué motivo además de este?
9. Confirmar los términos de uso de UCS en la descarga oficial [41].

## 11. Próximos pasos sugeridos

1. **Benchmark (1 a 2 días, est.):** exportar SigLIP 2 B/16 y B/32-256 (fp32 e int8, IR 8) y medir ms por imagen con el ORT 1.14 del producto en las laptops objetivo.
2. **Prototipo de vocabulario:** 100 conceptos con 30 referencias de prueba; medir la precisión de los temas y el P@20 de los candidatos.
3. **Integración:** worker de decodificación, sesión visual perezosa en el engine host y caché por referencia en el vault.

---

## Fuentes

### Externas

1. OpenCLIP, `model_profile.csv` (params y GFLOPs por torre). https://github.com/mlfoundations/open_clip/blob/main/docs/model_profile.csv
2. OpenCLIP, `openclip_results.csv` (zero-shot ImageNet-1k). https://github.com/mlfoundations/open_clip/blob/main/docs/openclip_results.csv
3. OpenAI CLIP, ficha del modelo. https://github.com/openai/CLIP/blob/main/model-card.md
4. OpenAI CLIP, LICENSE (MIT). https://github.com/openai/CLIP/blob/main/LICENSE
5. Xenova/clip-vit-base-patch32, archivos ONNX y `preprocessor_config.json`. https://huggingface.co/Xenova/clip-vit-base-patch32/tree/main/onnx
6. Xenova/clip-vit-base-patch16, archivos ONNX. https://huggingface.co/Xenova/clip-vit-base-patch16/tree/main/onnx
7. apple/ml-mobileclip, README (tablas MobileCLIP y MobileCLIP2). https://github.com/apple/ml-mobileclip
8. apple/ml-mobileclip, LICENSE_MODELS (Apple Machine Learning Research Model License). https://github.com/apple/ml-mobileclip/blob/main/LICENSE_MODELS
9. apple/ml-mobileclip, LICENSE_weights_data histórico (commit 341ef05, julio de 2024) e historial del archivo (reemplazo el 29/08/2025, commit "MobileCLIP2 release"). https://github.com/apple/ml-mobileclip/blob/341ef058802f0e4e5ab13c02f0cb32a3a94e367b/LICENSE_weights_data · https://github.com/apple/ml-mobileclip/commits/main/LICENSE_weights_data
10. Fichas apple/MobileCLIP-S0 y apple/MobileCLIP2-S0 (licencia apple-amlr). https://huggingface.co/apple/MobileCLIP-S0 · https://huggingface.co/apple/MobileCLIP2-S0
11. MobileCLIP, paper (arXiv 2311.17049). https://arxiv.org/abs/2311.17049
12. Xenova/mobileclip_s0, _s1, _s2, _b (ONNX). https://huggingface.co/Xenova/mobileclip_s0 · https://huggingface.co/Xenova/mobileclip_s1 · https://huggingface.co/Xenova/mobileclip_s2 · https://huggingface.co/Xenova/mobileclip_b
13. Discusión en HF: MobileCLIP-S2 más lento que ViT-B-32-256 en CPU y GPU. https://huggingface.co/apple/MobileCLIP-S2-OpenCLIP/discussions/3
14. Exportaciones comunitarias de MobileCLIP2. https://huggingface.co/plhery/mobileclip2-onnx · https://huggingface.co/RuteNL/MobileCLIP2-S0-OpenCLIP-ONNX
15. TinyCLIP, README (model zoo) y LICENSE (MIT). https://github.com/microsoft/Cream/tree/main/TinyCLIP · https://github.com/microsoft/Cream/blob/main/LICENSE
16. wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M (MIT). https://huggingface.co/wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M
17. onnx-community, TinyCLIP en ONNX. https://huggingface.co/onnx-community/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M-ONNX · https://huggingface.co/onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX
18. SigLIP 2, paper (arXiv 2502.14786), Tabla 1. https://arxiv.org/abs/2502.14786
19. Fichas de Google (Apache 2.0). https://huggingface.co/google/siglip2-base-patch16-224 · https://huggingface.co/google/siglip2-base-patch32-256 · https://huggingface.co/google/siglip-base-patch16-224
20. onnx-community/siglip2-base-patch16-224-ONNX (archivos y `preprocessor_config.json`). https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX
21. Xenova/siglip-base-patch16-224 (archivos e historial de commits). https://huggingface.co/Xenova/siglip-base-patch16-224
22. immich-app en Hugging Face (ViT-B-32-SigLIP2-256__webli y otros exports OpenCLIP). https://huggingface.co/immich-app/ViT-B-32-SigLIP2-256__webli · https://huggingface.co/immich-app
23. Documentación de Transformers, SigLIP2. https://huggingface.co/docs/transformers/model_doc/siglip2
24. Fichas de LAION. https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K · https://huggingface.co/laion/CLIP-ViT-B-32-256x256-DataComp-s34B-b86K · https://huggingface.co/laion/CLIP-ViT-B-32-DataComp.XL-s13B-b90K
25. apple/DFN2B-CLIP-ViT-B-16 (apple-amlr). https://huggingface.co/apple/DFN2B-CLIP-ViT-B-16
26. facebook/metaclip-b32-400m (CC-BY-NC-4.0). https://huggingface.co/facebook/metaclip-b32-400m
27. QuanSun/EVA-CLIP (MIT). https://huggingface.co/QuanSun/EVA-CLIP
28. P. Schmid, "Accelerate Vision Transformer (ViT) with Quantization using Optimum". https://www.philschmid.de/optimizing-vision-transformer
29. Lednik7/CLIP-ONNX, benchmark. https://github.com/Lednik7/CLIP-ONNX/blob/main/benchmark.md
30. CLIP, paper (arXiv 2103.00020). https://arxiv.org/abs/2103.00020
31. microsoft/Florence-2-base (MIT). https://huggingface.co/microsoft/Florence-2-base
32. onnx-community/Florence-2-base-ft (ONNX y `preprocessor_config.json`). https://huggingface.co/onnx-community/Florence-2-base-ft
33. Roboflow, "Florence-2: Vision-language Model". https://blog.roboflow.com/florence-2/
34. antonlnz/florence2-base-vision-coreml (latencias del encoder visual). https://huggingface.co/antonlnz/florence2-base-vision-coreml
35. HuggingFaceTB/SmolVLM-256M-Instruct (ficha y ONNX). https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct
36. SmolVLM, paper (arXiv 2504.05299). https://arxiv.org/abs/2504.05299
37. vikhyatk/moondream2 (Apache 2.0). https://huggingface.co/vikhyatk/moondream2
38. Salesforce/blip-image-captioning-base (BSD-3-Clause). https://huggingface.co/Salesforce/blip-image-captioning-base
39. Recognize Anything (RAM++), repo y checkpoint. https://github.com/xinyu1205/recognize-anything · https://huggingface.co/xinyu1205/recognize-anything-plus-model
40. transformers.js, README (modelos soportados). https://github.com/huggingface/transformers.js
41. Universal Category System, sitio oficial. https://universalcategorysystem.com/
42. A Sound Effect, "Tim Nielsen releases the final version of the Universal Category System". https://www.asoundeffect.com/universal-category-system-final-version/
43. Sonofex, UCS (82 categorías, 753 subcategorías). https://sonofex.com/ucs/
44. ImageBind, README (licencia) y paper. https://github.com/facebookresearch/ImageBind · https://arxiv.org/abs/2305.05665
45. AudioCLIP, README. https://github.com/AndreyGuzhov/AudioCLIP
46. Wav2CLIP, repo y paper. https://github.com/descriptinc/lyrebird-wav2clip · https://arxiv.org/abs/2110.11499
47. LanguageBind, repo y checkpoint de audio. https://github.com/PKU-YuanGroup/LanguageBind · https://huggingface.co/LanguageBind/LanguageBind_Audio_FT
48. PE Audio Video (Meta): documentación y fichas. https://huggingface.co/docs/transformers/model_doc/pe_audio_video · https://huggingface.co/facebook/pe-av-small · https://huggingface.co/facebook/pe-av-large
49. Wilkins et al., "Bridging High-Quality Audio and Video via Language for Sound Effects Retrieval from Visual Queries", WASPAA 2023. https://arxiv.org/abs/2308.09089
50. Wang et al., "V2A-Mapper", AAAI 2024. https://arxiv.org/abs/2308.09300
51. onnxruntime-node en npm. https://www.npmjs.com/package/onnxruntime-node
52. ONNX Runtime v1.30.0 (10/09/2026) y v1.14.0 (11/02/2023). https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0 · https://github.com/microsoft/onnxruntime/releases/tag/v1.14.0
53. onnxruntime, README del binding de Node (tabla de proveedores). https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md
54. Listado de binarios de onnxruntime-node 1.30.0 para win32/x64. https://app.unpkg.com/onnxruntime-node@1.30.0/files/bin/napi-v6/win32/x64
55. ONNX Runtime, compatibilidad de IR y opset. https://onnxruntime.ai/docs/reference/compatibility.html
56. DirectML Execution Provider y estado de DirectML. https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html · https://github.com/microsoft/DirectML
57. onnxruntime-inference-examples, opciones de sesión en JS (proveedor `dml`). https://github.com/microsoft/onnxruntime-inference-examples/blob/main/js/api-usage_session-options/README.md
58. transformers.js, releases (2.17.2, 3.0.0, 3.8.1, 4.0.0, 4.3.0). https://github.com/huggingface/transformers.js/releases
59. Hugging Face, "Transformers.js v4". https://huggingface.co/blog/transformersjs-v4
60. `@huggingface/transformers` en npm (dependencias de 4.3.0). https://www.npmjs.com/package/@huggingface/transformers
61. transformers.js, backend ONNX (dispositivos en Node). https://github.com/huggingface/transformers.js/blob/main/packages/transformers/src/backends/onnx.js
62. transformers.js, guía de dtypes. https://huggingface.co/docs/transformers.js/guides/dtypes
63. IR 9 contra máximo IR 8 en transformers.js 2.x. https://github.com/huggingface/transformers.js/issues/847 · https://huggingface.co/onnx-community/depth-anything-v2-small/discussions/2
64. onnxruntime issue #20156 (embeddings distintos por el cambio de API de v3). https://github.com/microsoft/onnxruntime/issues/20156
65. Microsoft Learn, orden de búsqueda de DLL. https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order
66. sherpa-onnx issue #3059 (`onnxruntime.dll` 1.17.1 en System32). https://github.com/k2-fsa/sherpa-onnx/issues/3059
67. MDN, `createImageBitmap()`. https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap
68. MDN, constructor de `ImageDecoder`. https://developer.mozilla.org/en-US/docs/Web/API/ImageDecoder/ImageDecoder
69. MDN, guía de formatos de imagen. https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types
70. Electron, MessagePorts y `utilityProcess`. https://www.electronjs.org/docs/latest/tutorial/message-ports · https://www.electronjs.org/docs/latest/api/utility-process
71. Wikipedia, k-means (costo de Lloyd). https://en.wikipedia.org/wiki/K-means_clustering
72. scikit-learn, guía de clustering. https://scikit-learn.org/stable/modules/clustering.html
73. D. Müllner, "Modern hierarchical, agglomerative clustering algorithms" (arXiv 1109.2378). https://arxiv.org/abs/1109.2378
74. J. Carbonell y J. Goldstein, "The Use of MMR, Diversity-Based Reranking...", SIGIR 1998. https://dl.acm.org/doi/10.1145/290941.291025
75. `ml-kmeans` y `ml-hclust` (MIT). https://www.npmjs.com/package/ml-kmeans · https://www.npmjs.com/package/ml-hclust
76. PaddleOCR (Apache 2.0). https://github.com/PaddlePaddle/PaddleOCR
77. BigSoundBank, lista de categorías UCS. https://bigsoundbank.com/categories.html

### Internas (repo)

- **R0.** Contexto del producto: HNSW con hnswlib-node, menos de 1 ms por consulta.
- **R1.** `docs/CASOS_DE_USO.md`: A8, G4, G7 (P@20 0,77), G8 (texto-audio de CLAP ≈0,6 como máximo), H3 (88 % sibling@10), K2 (540 ms por archivo, ≈10 h para 70k), K6 ("núcleos menos 2" hilos), K8 (HNSW en tramos de ≤ 35 ms, recall@20 0,999).
- **R2.** `src/engine/semantic-engine.js`: `cutoffFor` (coseno < 0,30, ≤ 8 % relevante), `suggest()` (duplicados con 0,9995), LRU(128), `CHANGE_DEBOUNCE_MS = 800`, `WORKER_IDLE_MS = 60000`, modelo de audio perezoso.
- **R3.** `docs/archive/1.x/SOUNDVAULT_FIND_SIMILAR_RFC.md` y `docs/archive/1.x/desarrollo teorico.md`: consulta de texto CLAP de ≈50 ms (estimación interna).
- **R4.** `node_modules/@xenova/transformers`: `package.json` (onnxruntime-node 1.14.0, sharp ^0.32.0), `src/utils/image.js` (en Node, resize y crop con sharp), `src/models.js` (clases disponibles). `node_modules/onnxruntime-node/bin/napi-v3/win32/x64` (`onnxruntime.dll` de 9,3 MB).
- **R5.** `packaging/stubs/sharp` y la sección `build` de `package.json`.
- **R6.** `scripts/prepare-models.js`: texto CLAP en fp16 (501 → 251 MB, coseno 1,00000, top-1 igual en 70/70).
- **R7.** `scripts/verify-dist.js` y `scripts/stage-crt-dlls.js`: rutas `napi-v3` fijas.
- **R8.** `node_modules/ffmpeg-static`: ffmpeg 6.1.1 (gyan.dev essentials) con decodificadores `psd`, `tiff`, `dds`, `webp`, `png`, `bmp`.
- **R9.** Micro-benchmark propio (apéndice), Intel Core i5-9400, Node 24.14.0.
- **R10.** `src/search/translate.js`: traductor español → inglés por diccionario de vocabulario SFX.

---

## Apéndice: micro-benchmark de agrupamiento y diversidad

<details>
<summary>Código (Node, sin dependencias). Ejecutar con <code>node bench-grouping.js</code></summary>

```js
'use strict';
// Costs of grouping/diversity steps on ~2,000 candidate 512-D unit vectors in plain JS (single thread).
const { performance } = require('perf_hooks');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const rand = rng(12345);
function gauss() { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function normalize(a, off, d) { let s = 0; for (let i = 0; i < d; i++) s += a[off + i] * a[off + i]; const inv = 1 / Math.sqrt(s); for (let i = 0; i < d; i++) a[off + i] *= inv; }
function dot(a, ao, b, bo, d) { let s = 0; for (let i = 0; i < d; i++) s += a[ao + i] * b[bo + i]; return s; }

function makeData(n, d, centers, noise) {
    const C = new Float32Array(centers * d);
    for (let i = 0; i < C.length; i++) C[i] = gauss();
    for (let c = 0; c < centers; c++) normalize(C, c * d, d);
    const X = new Float32Array(n * d);
    for (let i = 0; i < n; i++) {
        const c = Math.floor(rand() * centers);
        for (let j = 0; j < d; j++) X[i * d + j] = C[c * d + j] + noise * gauss() / Math.sqrt(d);
        normalize(X, i * d, d);
    }
    return X;
}

// Spherical k-means (cosine), k-means++ seeding.
function kmeans(X, n, d, k, maxIter) {
    const cent = new Float32Array(k * d);
    const first = Math.floor(rand() * n);
    cent.set(X.subarray(first * d, first * d + d), 0);
    const best = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < k; c++) {
        let sum = 0;
        for (let i = 0; i < n; i++) { const dist = 1 - dot(X, i * d, cent, (c - 1) * d, d); if (dist < best[i]) best[i] = dist; sum += best[i] * best[i]; }
        let r = rand() * sum, pick = 0;
        for (let i = 0; i < n; i++) { r -= best[i] * best[i]; if (r <= 0) { pick = i; break; } }
        cent.set(X.subarray(pick * d, pick * d + d), c * d);
    }
    const assign = new Int32Array(n).fill(-1);
    let it = 0;
    for (; it < maxIter; it++) {
        let changed = 0;
        for (let i = 0; i < n; i++) {
            let bc = 0, bs = -2;
            for (let c = 0; c < k; c++) { const s = dot(X, i * d, cent, c * d, d); if (s > bs) { bs = s; bc = c; } }
            if (assign[i] !== bc) { assign[i] = bc; changed++; }
        }
        cent.fill(0);
        for (let i = 0; i < n; i++) { const c = assign[i]; for (let j = 0; j < d; j++) cent[c * d + j] += X[i * d + j]; }
        for (let c = 0; c < k; c++) normalize(cent, c * d, d);
        if (!changed) break;
    }
    return { assign, iters: it + 1 };
}

// Full similarity matrix + average-linkage agglomerative via NN-chain.
function simMatrix(X, n, d) {
    const S = new Float32Array(n * n);
    for (let i = 0; i < n; i++) { S[i * n + i] = 1; for (let j = i + 1; j < n; j++) { const s = dot(X, i * d, X, j * d, d); S[i * n + j] = s; S[j * n + i] = s; } }
    return S;
}
function agglomerativeAverage(S, n, k) {
    const D = new Float32Array(n * n); for (let i = 0; i < n * n; i++) D[i] = 1 - S[i];
    const size = new Int32Array(n).fill(1), active = new Uint8Array(n).fill(1);
    let clusters = n; const chain = [];
    while (clusters > k) {
        if (!chain.length) { for (let i = 0; i < n; i++) if (active[i]) { chain.push(i); break; } }
        const a = chain[chain.length - 1];
        let b = -1, bd = Infinity;
        for (let j = 0; j < n; j++) if (active[j] && j !== a) { const x = D[a * n + j]; if (x < bd || (x === bd && j === chain[chain.length - 2])) { bd = x; b = j; } }
        if (chain.length > 1 && b === chain[chain.length - 2]) {
            chain.pop(); chain.pop();
            const sa = size[a], sb = size[b];
            for (let j = 0; j < n; j++) if (active[j] && j !== a && j !== b) { const v = (sa * D[a * n + j] + sb * D[b * n + j]) / (sa + sb); D[a * n + j] = v; D[j * n + a] = v; }
            size[a] = sa + sb; active[b] = 0; clusters--;
        } else chain.push(b);
    }
    return clusters;
}

// MMR: pick m of the candidates; relevance = cosine to the query, redundancy = max cosine to the picked ones.
function mmr(X, d, cand, query, qo, m, lambda) {
    const rel = cand.map(i => dot(X, i * d, query, qo, d));
    const maxSim = new Float64Array(cand.length).fill(-1);
    const picked = [], used = new Uint8Array(cand.length);
    for (let t = 0; t < m && t < cand.length; t++) {
        let bi = -1, bs = -Infinity;
        for (let c = 0; c < cand.length; c++) { if (used[c]) continue; const s = lambda * rel[c] - (1 - lambda) * (picked.length ? maxSim[c] : 0); if (s > bs) { bs = s; bi = c; } }
        used[bi] = 1; picked.push(cand[bi]);
        for (let c = 0; c < cand.length; c++) if (!used[c]) { const s = dot(X, cand[c] * d, X, cand[bi] * d, d); if (s > maxSim[c]) maxSim[c] = s; }
    }
    return picked;
}

function time(label, fn, reps = 5) {
    fn();
    const t = [];
    for (let r = 0; r < reps; r++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); }
    t.sort((a, b) => a - b);
    console.log(`${label}: median ${t[Math.floor(t.length / 2)].toFixed(1)} ms (min ${t[0].toFixed(1)}, max ${t[t.length - 1].toFixed(1)})`);
}

const D = 512, N = 2000;
const X = makeData(N, D, 12, 1.2);
time('1M dot products of 512-D', () => { let s = 0; for (let i = 0; i < 1000; i++) for (let j = 0; j < 1000; j++) s += dot(X, i * D, X, (j + 1000) * D, D); return s; }, 3);
time('k-means k=8 (k-means++ init, max 25 iters)', () => kmeans(X, N, D, 8, 25));
time('k-means k=16 (max 25 iters)', () => kmeans(X, N, D, 16, 25));
let S;
time('similarity matrix 2000x2000 (512-D)', () => { S = simMatrix(X, N, D); }, 3);
time('agglomerative average linkage to 8 clusters (given matrix)', () => agglomerativeAverage(S, N, 8), 3);
const Q = makeData(8, D, 8, 0.5);
const cands = Array.from({ length: 8 }, (_, t) => Array.from({ length: 250 }, (_, i) => (t * 250 + i) % N));
time('MMR 8 themes x (250 -> 20), lambda 0.7', () => { for (let t = 0; t < 8; t++) mmr(X, D, cands[t], Q, t * D, 20, 0.7); });
const I = makeData(10, 768, 10, 0.5), V = makeData(3000, 768, 50, 1.0);
time('zero-shot 10 images x 3000 concepts (768-D)', () => { const out = new Float32Array(30000); for (let i = 0; i < 10; i++) for (let c = 0; c < 3000; c++) out[i * 3000 + c] = dot(I, i * 768, V, c * 768, 768); return out; });
const L = makeData(70000, D, 200, 1.5);
time('exact search 8 queries x 70k vectors (512-D)', () => { const out = new Float32Array(70000); for (let q = 0; q < 8; q++) for (let i = 0; i < 70000; i++) out[i] = dot(L, i * D, Q, q * D, D); return out; }, 3);
```

</details>
