# SoundVault 2.0: Catálogo de casos de uso

Qué hace la app en cada situación de uso tradicional y cómo quedó verificado.

**Estados:** ✅ verificado (test automático o medición) · 🟡 funciona, con salvedad · ⛔ limitación conocida.
**Datos reales:** las mediciones "sobre la librería real" se hicieron en solo lectura sobre `D:\Librerias Sonido` (70.331 WAV) y sobre **copias** de la base de datos. La carpeta `%APPDATA%\soundvault` nunca se tocó.

Referencias a tests:
- `npm test`: 88 tests unitarios.
- `npm run test:engine`: motor completo en Electron (29 verificaciones) y espectrograma CLAP.
- `npm run test:e2e`: app completa con carpeta de usuario aislada, pruebas smoke y engine (14 verificaciones) más 7 pruebas del editor (134 verificaciones).

---

## A. Primer arranque y configuración

| # | Caso | Comportamiento | Estado |
|---|---|---|---|
| A1 | Primer arranque sin configuración | Crea `Documentos\SoundVault` vacía (única carpeta que se crea sola), abre en modo Vault, splash ~1,6 s | ✅ E2E smoke |
| A2 | Elegir una librería grande (70k, disco rígido) | Primer recorrido sin `stat` por archivo: la lista aparece al terminar de leer las carpetas; tamaños y fechas se completan en segundo plano | ✅ `LibraryIndex` tests |
| A3 | Librería en un disco desconectado o en una red caída | Se informa "Library folder not found". La verificación es asíncrona con tiempo límite (4 s), así que una unidad de red colgada nunca congela la ventana. No se recrea una carpeta vacía | ✅ (código + test de índice) |
| A4 | Cambiar de librería | El índice IA se acota a la librería actual. Los datos de la otra librería **no se borran** (antes se perdían sus 70k vectores). Si el catálogo pide un diff mientras la librería nueva todavía carga, espera: comparar contra memoria a medio cargar re-encolaba archivos ya analizados | ✅ engine test (alcance por raíz) |
| A5 | Abrir la app dos veces | Instancia única: la segunda enfoca la ventana existente | ✅ |
| A6 | Restaurar estado (modo, carpeta, colección, tamaño de ventana) | Persistido en `soundvault-config.json` con escritura atómica | ✅ `JsonStore` test |
| A7 | Actualización desde 1.x (config, vaults.json, base de 3 GB) | Formatos compatibles. La base se migra sola (ver K9). El índice HNSW viejo (151 MB, etiquetas incorrectas) se descarta | ✅ migración medida sobre copia real |
| A9 | Mover la librería a otro disco o letra de unidad | Al elegir la carpeta nueva, vectores, huellas Echo, archivos fallidos y colecciones (de todos los vaults) se re-vinculan por ruta relativa: mismo tamaño y fecha de modificación igual con hasta 2 s de diferencia (la precisión de FAT/exFAT y de muchas herramientas de copia). No se re-analiza nada. Hace falta que coincida al menos el 30 %, así dos librerías distintas nunca se mezclan | ✅ engine test ("moved library": 95/95 re-vinculados, 0 re-análisis) |
| A8 | Arranque en frío con la librería real | Índice persistido: carga instantánea más reconciliación solo de las carpetas cuyo `mtime` cambió. La UI no espera a los modelos IA. El motor corre en su propio proceso utilitario: en un hilo trabajador de Electron, cada buffer que devuelve SQLite pasa por el kernel, y cargar 70k vectores y huellas tardaba minutos | ✅ **medido sobre la librería real (70.114 vectores, 70.114 huellas): UI usable en 1,6 s, búsqueda IA y Echo listos a los ~4 s del arranque (antes 270-568 s)**. Búsquedas de 60-470 ms desde el primer segundo, también mientras se arma el índice y corre la pasada profunda |

## B. Navegar la librería (modo Sound)

| # | Caso | Comportamiento | Estado |
|---|---|---|---|
| B1 | Árbol de carpetas con conteos recursivos, orden natural | Incluye carpetas vacías recién creadas y archivos sueltos en la raíz | ✅ `LibraryIndex` test |
| B2 | Carpeta con 52k archivos | Lista virtual (unas 30 filas en el DOM). Las filas liberadas quedan fuera de pantalla y ocultas a lectores de pantalla | ✅ |
| B3 | Ordenar (nombre/fecha/tamaño/carpeta/duración), incluir o no subcarpetas | Persistido. Orden natural (`kick 2` antes que `kick 10`) | ✅ |
| B4 | Cambios hechos fuera de la app (Explorer, DAW) | Un único `fs.watch` recursivo con debounce. Ante desborde del buffer de Windows reconcilia la carpeta completa. Detecta renombres y borrados de carpetas enteras | ✅ `LibraryWatcher` test |
| B5 | Cambios hechos con la app cerrada | Reconciliación al abrir, por `mtime` de carpeta | ✅ test "persisted index … offline changes" |
| B6 | Nombres difíciles (ñ, 日本語, emoji, `%`, `&`, `#`, 260+ caracteres) | Se ven y reproducen. El protocolo de audio no decodifica dos veces (antes fallaba con `%`) | ✅ fixtures E2E |
| B7 | Carpetas ignoradas (`.git`, `node_modules`, `$RECYCLE.BIN`, `System Volume Information`) | Se excluyen por nombre de carpeta, no por ruta absoluta (antes una librería dentro de `x.github.io` quedaba vacía) | ✅ test |

## C. Audición

| # | Caso | Comportamiento | Estado |
|---|---|---|---|
| C1 | Clic en play, pausa, reanudar | Streaming por `soundvault://` con soporte de Range: arranque en 7-35 ms para cualquier largo (antes 1,8 s en un archivo de 10 min) | ✅ auditoría de audio (medido) |
| C2 | ↑/↓ con reproducción automática, Enter, Espacio, ←/→ | Espacio al estilo DAW: pausa, reanuda la selección o reproduce la fila del cursor | ✅ E2E smoke |
| C3 | Clics rápidos entre filas | Cada reproducción lleva un token. Nunca suena el archivo anterior bajo el nombre del nuevo. Los handlers del `<audio>` viejo se desconectan antes de soltarlo | ✅ |
| C4 | Sonidos muy cortos (5 ms, 1 s) | La duración se muestra en ms o "0,42 s", nunca "0:00". La forma de onda cubre hasta la última muestra | ✅ `computeWavPeaks` tests |
| C5 | Sonidos largos (3-10 min, 96 kHz, 24 bit) | Streaming con seek instantáneo. Los picos se calculan en streaming con memoria constante | ✅ |
| C6 | Loop (archivo o selección) | Cambiarlo durante la reproducción aplica en el acto | ✅ |
| C7 | Formatos: PCM 8/16/24/32, float 32/64, EXTENSIBLE, RF64, metadatos grandes antes de `data`, `data` de tamaño falso | El lector de chunks salta metadatos de cualquier tamaño. Los archivos truncados se leen hasta donde existen | ✅ `wav-io` tests |
| C8 | Archivos rotos (0 bytes, texto renombrado, cabecera RIFX) | La fila se marca "unreadable", nunca queda en estado fantasma de "reproduciendo" | ✅ fixtures |
| C9 | Forma de onda estéreo con un canal mudo | Se dibuja el máximo de todos los canales (antes solo el canal 0) | ✅ |

## D. Selección y fades

| # | Caso | Comportamiento | Estado |
|---|---|---|---|
| D1 | Arrastrar sobre la forma de onda para seleccionar y ajustar los bordes | La selección se define sobre la duración real del archivo | ✅ E2E |
| D5 | Fades a la vista, sin atajos | Un punto en cada esquina superior de la selección: arrastrarlo crea el fade, doble clic lo quita. El fade se dibuja como en un DAW: línea de ganancia y un velo sobre lo que se atenúa, sin tapar la onda. Los tiradores de los bordes ocupan todo el borde menos la franja de los puntos, así redimensionar y hacer fades nunca se pisan. En selecciones muy angostas los puntos se ocultan (queda Shift + borde). Mientras se arrastra, una etiqueta muestra la duración del fade, y al soltar suena la selección con su fade | ✅ E2E `editor-fades` (12 verificaciones con mouse real) |
| D2 | Fades que se solapan | La previsualización usa la misma envolvente que el render (fade-in × fade-out), así que lo que se escucha es lo que se exporta | ✅ (código) |
| D3 | Seek fuera de la selección durante la reproducción | Se limita al segmento; ya no rompe la reproducción | ✅ |
| D4 | La selección sale de vista o la lista cambia | La barra de herramientas se reubica o desaparece si el archivo ya no está en la lista | ✅ |

## E. Llevar sonidos al DAW

| # | Caso | Comportamiento | Estado |
|---|---|---|---|
| E1 | Arrastrar uno o varios archivos | Arrastre nativo de Windows con miniatura de la forma de onda | ✅ |
| E2 | Arrastrar una selección | Se pre-renderiza al asentarse la selección, así el arrastre arranca en menos de 1 ms. Frecuencia nativa (96/192 kHz se conservan). Mantiene el formato: float queda float (nada se recorta arriba de 0 dBFS), 16 bits queda 16, el resto 24 | ✅ |
| E3 | Arrastrar una edición del editor | Igual que E2. "Preparing…" hasta que el archivo existe | ✅ E2E editor-export |
| E4 | Renders persistentes | Nombres únicos y legibles en `Documentos\SoundVault Renders`, nunca se sobreescriben. **Solo se guarda lo que realmente se arrastra**: las previsualizaciones van a `.staging` y se limpian (antes una sesión dejaba ~160 MB de WAV sin usar) | ✅ test `Renders` |
| E5 | Guardar selección o edición como sonido nuevo en la librería | Junto al original, con nombre único. Aparece y se indexa solo | ✅ |

## F. Editor

| # | Caso | Estado |
|---|---|---|
| F1 | Abrir (E) una selección o un archivo: 11-260 ms. Un archivo de 120 s a 96k estéreo tarda 2,3 s, casi todo decodificación | ✅ E2E editor |
| F2 | Crop con handles, fades con curvas (lineal, potencia, potencia igual, S), ganancia, pitch/varispeed, reverse, normalizar | ✅ `edit-dsp` (20 tests) + E2E |
| F3 | Curvas de fade a la vista | El menú de formas dibuja cada curva (con la misma ley de ganancia que se aplica al audio) y marca la actual; las lecturas del editor muestran la curva de cada fade junto a su duración, y un clic ahí abre las formas | ✅ E2E `editor-fades` |
| F3 | Reproducción en vivo: la ganancia y el pitch cambian sobre la misma voz, nunca hay dos voces | ✅ E2E editor-playback |
| F4 | Deshacer/rehacer: cada gesto es un paso, 200 niveles | ✅ E2E (fuzz de 40 gestos) |
| F5 | Exportar a la frecuencia nativa con sinc (alias < -60 dB). Float si el pico supera 0 dBFS | ✅ |
| F6 | Zoom y minimapa. Forma de onda exacta (una pirámide que nunca pierde un transitorio) | ✅ |
| F7 | ⛔ El pitch en la previsualización usa interpolación lineal (la exportación usa sinc). Contenido por encima de 24 kHz no se escucha en la previsualización pero sí se exporta | ⛔ |
| F8 | ⛔ El historial del editor dura solo la sesión | ⛔ |

## G. Búsqueda

| # | Caso | Comportamiento | Estado |
|---|---|---|---|
| G1 | Por nombre: palabras en cualquier orden, acentos, camelCase, números | Todas las palabras deben aparecer, en cualquier campo (nombre, carpeta, vendor) | ✅ `lexical-search` (17) |
| G2 | "rain" no debe traer "train/grain/brain" | Coincidencia por límite de palabra. Las colas de compuestos sí valen ("wood" encuentra "firewood") | ✅ test |
| G3 | Plurales y gerundios | "explosions" = "explosion", "whooshes" = "whoosh", "slide" encuentra "sliding" | ✅ test |
| G4 | Abreviaturas de categorías UCS | "impact" encuentra `IMPT`, "whoosh" encuentra `WHSH`, "footsteps" encuentra `FS_…` | ✅ test |
| G5 | Frases naturales ("sword swing") | Si ningún archivo tiene todas las palabras, muestra los que tienen la mayoría, marcados "closest matches" | ✅ test |
| G6 | Consultas en español | "pasos en grava" → "footsteps on gravel", "explosiones lejanas" → "distant explosions". Palabras ambiguas con el inglés de SFX (mono, auto, grave, arena) no se traducen | ✅ `translate` tests |
| G7 | Búsqueda IA (describir el sonido) | Primero los archivos cuyo nombre coincide, ordenados por cuánto suenan a la consulta; después los que solo encontró la IA. Corte de similitud calibrado | ✅ auditoría semántica: P@20 0,52 → 0,77 |
| G8 | Relevancia IA visible | Indicador de 4 barras calibrado en lugar de un "45%" engañoso (la similitud texto-audio de CLAP nunca pasa de ~0,6) | ✅ |
| G9 | Alcance (librería / carpeta / colección / vault) | Ranking exacto dentro del alcance, no un top-200 global filtrado (antes un vault encontraba 7 de 59) | ✅ engine + E2E |
| G10 | Búsquedas simultáneas o escritura rápida | Sin estado compartido entre consultas (antes 3 consultas simultáneas devolvían la misma respuesta) | ✅ engine test |
| G11 | Pesos por palabra (arrastrar el chip) | Funciona más de una vez | ✅ |
| G12 | Búsqueda IA mientras se indexa | Cada sonido es buscable apenas se analiza (lotes chicos al principio) | ✅ |

## H. Echo (encontrar sonidos parecidos)

| # | Caso | Comportamiento | Estado |
|---|---|---|---|
| H1 | Desde una selección | Huellas espectrales comparadas en un único espacio normalizado. Se usan hasta ±50 ms de contexto real para las derivadas | ✅ **medido sobre la librería real (copia):** origen en el top-10 **78%** (antes 5%). ≥1 s: **95%**. <1 s: 69%. 50 ms: 64%. Offset exacto (±50 ms): 97% |
| H2 | Selecciones de 1-3 s en archivos largos | Coincidencia exacta con ventana deslizante y poda exacta de candidatos | ✅ 3 s: 100% R@10, 1,4 s |
| H11 | Velocidad de Echo sobre 70k | La comparación fina corre en el proceso del motor, en tramos de ~8 ms (las búsquedas se intercalan), con caché de candidatos preparados. En un hilo trabajador, leer y preparar ~400 candidatos costaba 5× más, y además la primera consulta pagaba ~0,2 s de arranque | ✅ **medido sobre la librería real:** consultas típicas 52-150 ms en frío (antes 364-~800 ms) y 15-18 ms repetidas. Si los candidatos son ambientes largos, ~0,4 s en caliente y ~1,2 s en frío |
| H3 | "Más como este archivo" | Ranking por CLAP (medido: 88% encuentra un hermano de la misma sesión en el top-10, P@10 71%, 64 ms). Duplicados exactos agrupados y marcados "Identical" | ✅ medido (antes 39% y 3,6 s) |
| H4 | Porcentaje de coincidencia | Calibrado contra el azar según el largo de la consulta; nunca "el primero = 100%". Los resultados débiles siguen listados pero bajo "Loosely similar" | ✅ |
| H5 | Duración del tramo coincidente | La del fragmento buscado (antes era el archivo entero) | ✅ engine test |
| H6 | Selección en silencio o demasiado corta | Mensaje claro en vez de "0 resultados" | ✅ |
| H7 | Echo again encadenado, migas de pan clickeables, localizar, coleccionar, arrastrar al DAW | Todo accionable con teclado (↑/↓, Enter, E, C, Esc) | ✅ E2E |
| H8 | Presets y ejes (Balanced/Tone/Texture/Punch) | Re-rank con debounce. Una consulta nueva cancela la anterior | ✅ |
| H9 | Archivos más largos que 2 min | Se analizan los primeros 120 s (antes 30 s) | 🟡 coincidencias pasados los 2 min no se encuentran |
| H10 | Ruido fuerte (SNR 20 dB) | Precisión baja (auditoría: 11% a 1 s) | ⛔ limitación del enfoque espectral |

## I. Colecciones y vaults

| # | Caso | Estado |
|---|---|---|
| I1 | Crear, renombrar, borrar, colorear colecciones (con deshacer). Nombres con comillas o `<script>` son texto inerte | ✅ `VaultStore` test |
| I2 | Agregar (menú, tecla C, arrastrar a la colección, Resonance) y quitar (con deshacer) | ✅ |
| I3 | Archivos que faltan (movidos o borrados por fuera) | Banner "Remove missing". Si se movieron dentro de la app, las rutas se actualizan solas en todos los vaults | ✅ |
| I4 | Vaults: crear, editar, duplicar, borrar, cambiar. El color del vault es identidad (logo, punto, barra de colección), nunca pinta la interfaz de "peligro" | ✅ |
| I5 | Resonance: sugerencias para una colección. Una colección mixta (pasos + explosiones) recibe de ambos. Duplicados exactos se muestran una sola vez | ✅ |
| I6 | `vaults.json` dañado | Se recupera del `.bak` (antes se reemplazaba por un vault vacío y se perdían todas las colecciones) | ✅ test |
| I7 | Brief del vault: palabras, sonidos de referencia e imágenes se convierten en colecciones sugeridas, cada una con sus candidatos. Un sonido aparece en una sola tarjeta. Lo que no tiene material fuerte en la librería se informa como "sin coincidencia" en vez de inventar una tarjeta floja | ✅ engine test (brief) · **librería real: 10 palabras dan 7 tarjetas en 52 ms, ningún sonido repetido** |
| I8 | Imagen de referencia: se reconocen conceptos UCS (mar, bosque, sangre, arma sci-fi, magia) que entran al Brief como consultas. Busca también por el código UCS en el nombre del archivo (`AMBSea_...`) y por sinónimos ("tiger" para felinos) | ✅ **librería real, 45 imágenes: una playa da una tarjeta de grabaciones de costa, una portada gore da "blood", "gore splat" y "gore", la de magia 6 tarjetas.** 🟡 Las portadas con mucho texto y el arte abstracto no dan conceptos (a propósito), y a veces aparece uno de más ("leather" en un tigre), que se quita con un clic |
| I9 | Imágenes compartidas entre vaults: se guardan una vez por contenido y se borran cuando ningún vault las usa | ✅ `VaultStore` test |

## J. Gestión de archivos

| # | Caso | Estado |
|---|---|---|
| J1 | Importar archivos o carpetas (diálogo o soltar). Nunca sobreescribe: nombres únicos, duplicados (mismo nombre y tamaño) se omiten, la estructura de carpetas se conserva | ✅ `FileOps` test |
| J2 | Mover (menú o soltar sobre una carpeta del árbol) con deshacer. Colecciones, vectores IA y huellas Echo siguen al archivo sin re-analizar | ✅ engine test ("app move re-keys") |
| J3 | Renombrar archivo o carpeta, incluido cambio solo de mayúsculas | ✅ |
| J4 | Mover o renombrar en el Explorer | El vector y la huella siguen al archivo (se empareja por tamaño + fecha) | ✅ engine test |
| J5 | Borrar → siempre a la Papelera, nunca permanente | ✅ |
| J6 | Nombres inválidos, reservados de Windows o intentos de path traversal | Se rechazan | ✅ `paths` test |

## K. Catálogo IA (análisis en segundo plano)

| # | Caso | Comportamiento | Estado |
|---|---|---|---|
| K1 | Catálogo automático | Arranca solo y se mantiene al día (desactivable en Ajustes). Una segunda pasada sin cambios no hace nada | ✅ E2E |
| K2 | Velocidad | Decodificación WAV nativa (5-50× más rápida que ffmpeg, embeddings idénticos), espectrograma CLAP 2,4× más rápido y FFT de huellas 1,5× más rápida, ambos con salida idéntica, una sola decodificación por archivo, orden por carpeta (menos saltos del disco) | ✅ **medido: 956 → 540 ms/archivo.** Catalogar 70k de cero: ~18-22 h antes, ~10 h ahora |
| K3 | Archivos largos | Primera pasada con los primeros 10 s (buscable enseguida). Luego una pasada profunda con ventanas repartidas por **todo** el archivo (antes solo los primeros 2 min) | ✅ |
| K4 | Archivos que no se pueden leer | Se registran y no se reintentan hasta que cambien. En Ajustes se ven ("Show") y se puede reintentar | ✅ engine test |
| K5 | Pausar / reanudar | "Pause" en Ajustes. Al terminar, el worker se cierra solo tras 1 min y libera ~400 MB | ✅ |
| K6 | La app sigue fluida durante el catálogo | El worker usa como máximo núcleos - 2 hilos de ONNX | ✅ E2E: IPC máx. 3-128 ms |
| K7 | Normalización de vectores | Todos los vectores se normalizan en memoria (antes se rankeaba por norma: "1384% match") | ✅ vector-store test |
| K8 | Índice HNSW | Etiquetas estables (id de la base). Altas, bajas y cambios incrementales sin reconstruir. Se guarda con la generación de la base y se carga en ms (antes se reconstruía 22-51 s en cada sesión). Cuando hay que armarlo (primer arranque de la 2.0): **100 s → 19 s** sobre los 70k vectores reales, en tramos de ≤ 35 ms y recién después de cargar el modelo de texto. El armado anterior re-insertaba al final todos los vectores como "actualizaciones", y eso bloqueaba el motor decenas de segundos. Recall@20 0,999 | ✅ vector-store test + medido |
| K9 | Migración de la base 1.x | Echo convierte su tabla a float16 en un worker: sobre la copia real, 72 s, 65.765 huellas convertidas, 4.349 descartadas por el bug de normalización viejo (se re-analizan solas). La base no crece | ✅ medido |
| K10 | Crash del motor | Se reinicia en la siguiente búsqueda con la misma librería. Un archivo que tumbe el decodificador se reintenta una vez y queda registrado | ✅ |
| K11 | Diff del catálogo (70k archivos) | Se compara contra los metadatos que el motor ya tiene en memoria, sin leer la base: **~0,35 s** en cualquier disco. Antes, 4 s en la corrida real, y hasta 75 s con el disco rígido ocupado, con las búsquedas en espera | ✅ medido sobre copia real |
| K12 | Archivos dañados | Un WAV cuyo encabezado es todo ceros (descarga o copia incompleta) se detecta sin lanzar ffmpeg y se informa claro en Ajustes ("Damaged file: it is filled with zeros"). Los errores de ffmpeg se traducen a mensajes legibles. En la librería real: **217 de los 288 WAV de "Boom Library Cannons" están dañados** | ✅ medido |
| K13 | Catálogo automático sin repeticiones | Se saltea si ni la librería ni el proceso del motor cambiaron desde el último (al arrancar corría dos veces seguidas). Se vuelve a lanzar solo si el motor se reinicia tras un crash (antes esos pendientes quedaban sin hacer hasta el próximo cambio) o si se reactiva el análisis automático | ✅ medido: 1 diff por arranque |

## L. Ajustes

| # | Caso | Estado |
|---|---|---|
| L1 | Librería, rescan, vigilar cambios, análisis automático | ✅ |
| L2 | Reproducción automática, loop, volumen, carpeta de renders (validada fuera de la librería) | ✅ |
| L3 | Color de acento | Un solo acento interactivo. Contraste AA en textos | ✅ |
| L4 | Hoja de atajos | ✅ |

## M. Ventana y sistema

| # | Caso | Estado |
|---|---|---|
| M1 | Barra de título integrada (WCO), sin menú, tema oscuro nativo | ✅ |
| M2 | Ventanas chicas, zoom 150%, DPI 125/150% | ✅ auditoría UI |
| M3 | Cerrar durante el catálogo | Se guarda el estado, se cierra la base, el índice HNSW se persiste, los workers terminan limpio y se borran las previsualizaciones no arrastradas | ✅ |
| M4 | Si el motor IA no puede cargar (antivirus, DLL faltante), la librería igual funciona | Los modelos se cargan en diferido | ✅ packaging test |

## N. Distribución

| # | Caso | Estado |
|---|---|---|
| N1 | Instalador por usuario (sin admin), accesos directos, desinstalar conserva los datos | ✅ |
| N2 | Offline: modelos incluidos | El modelo de texto va en float16: 251 MB en vez de 501 MB, coseno ≥ 0,99999 contra FP32, -478 MB de RAM | ✅ `model-parity` |
| N3 | Tamaño | app.asar 97 → ~2 MB (dependencias muertas fuera, stubs para sharp y onnxruntime-web) | ✅ verify-dist |
| N4 | "Portable" | ZIP de la app descomprimida (el .exe portable anterior re-extraía ~1 GB en %TEMP% en cada arranque) | ✅ |
| N5 | PC sin Visual C++ Redistributable | DLLs del CRT junto a onnxruntime | ✅ |
| N6 | ⛔ Instalador sin firma digital | SmartScreen avisa "editor desconocido" | ⛔ requiere certificado |
| N7 | ⛔ Nombre de usuario de Windows con caracteres no ASCII | hnswlib no abre esas rutas: el índice HNSW se reconstruye en cada sesión (la búsqueda sigue funcionando, exacta hasta que termina) | 🟡 |

---

### Limitaciones conocidas (resumen)
- Solo WAV. FLAC, AIFF y MP3 no se muestran (la librería real tiene 3 MP3 en 70.331 archivos).
- Echo con mucho ruido de fondo y coincidencias más allá de los 2 min de un archivo largo.
- Firma de código del instalador.
