# SOUNDVAULT

### Arquitectura de Búsqueda Semántica con IA

##### Programa de Estudio Técnico: Diseño de Sonido & IA

```
5 Módulos · Del .wav al Vector · Optimización y Producción Real
Ingeniero de Software: Audio Digital & IA
```

## Introducción: ¿Qué estamos estudiando?

Este documento es un programa técnico de aprendizaje basado en la arquitectura real de
SoundVault. Cada módulo desglosa una capa del sistema: desde cómo un archivo .wav se
convierte en 512 números, hasta cómo esos números permiten buscar 'impacto metálico
profundo' y encontrar el sonido correcto en milisegundos.
El recorrido sigue la vida de un sonido dentro del sistema:

1. El archivo .wav entra al pipeline de pre-procesamiento (Módulo 1)
2. La IA lo convierte en un vector de 512 dimensiones (Módulo 2)
3. Ese vector se persiste en SQLite como un BLOB (Módulo 3)
4. Una búsqueda de texto dispara la comparación vectorial (Módulo 4)
5. Los problemas de producción real y sus soluciones (Módulo 5)
**Nota sobre las analogías**
Las analogías con audio se usan solo donde la geometría conceptual lo justifica naturalmente.
El objetivo es construir intuición técnica real, no decoración pedagógica.


## Módulo 1: El Pipeline de Pre-procesamiento

**Tema central:** ffmpeg, Float32Array, muestreo a 48kHz mono y por qué la IA es selectiva con el
formato de entrada.

#### 1.1 ¿Por qué la IA no puede leer directamente un .wav?

Un modelo de redes neuronales no 'escucha' en sentido perceptual. Procesa tensores: arrays
multidimensionales de números en punto flotante de 32 bits (Float32). La restricción de formato
no es arbitraria. El modelo CLAP fue entrenado con audio normalizado a 48,000 Hz
monofónico. Alimentarlo con 96kHz estéreo no produce un error de sintaxis; produce resultados
semánticamente incorrectos porque el modelo nunca vio esa distribución de datos durante el
entrenamiento.

#### 1.2 El rol de ffmpeg-static

ffmpeg es el decodificador universal de audio/video. La variante ffmpeg-static empaqueta el
binario compilado directamente dentro del bundle de la aplicación Electron, eliminando la
dependencia del sistema operativo del usuario. El comando que ejecuta SoundVault bajo el
capó es conceptualmente equivalente a:
ffmpeg -i input.wav -ac 1 -ar 48000 -f f32le -
**-ac 1** → downmix a mono (promedia los canales)
**-ar 48000** → resamplea a 48 kHz
**-f f32le** → raw float de 32 bits, little-endian (lo que espera CLAP)

**- (stdout)** → salida en memoria, sin archivos temporales en disco
La salida es un stream de bytes que se envuelve en un Float32Array. Para 10 segundos de
audio: 48,000 samples/s × 10 s × 4 bytes = 1.92 MB en RAM. Manejable, descartable, sin I/O
de disco.

#### 1.3 Float32Array: el puente entre audio y álgebra

En JavaScript, Float32Array es una TypedArray: memoria contigua de floats de 32 bits. A
diferencia de un Array genérico de JS que almacena punteros a objetos en el heap, un
Float32Array es un bloque de bytes consecutivos en memoria. Esto es crítico para la eficiencia:
la librería Transformers.js puede pasar este buffer directamente al runtime ONNX sin copias
adicionales.


```
Formato Descripción técnica
Array de JS Array de punteros a objetos en el heap. Lento para operaciones
numéricas masivas.
Float32Array Buffer de bytes contiguos. Compatible con WASM y ONNX sin
marshaling ni copias.
Int16Array PCM de 16 bits estándar de WAV. Requiere normalización antes de
entrar a la IA.
¿Por qué mono y no estéreo?
CLAP modela el contenido semántico del audio, no su imagen espacial.
La información de mid/side que distingue estéreo de mono es irrelevante para saber si un sonido
'es' un impacto metálico.
Además, el embedding de 512 dimensiones tiene capacidad fija: dedicar parte al canal derecho
significaría menor resolución semántica.
```
#### 1.4 El chequeo de mtime: no hacer trabajo doble

Antes de procesar cualquier archivo, SoundVault consulta en SQLite si el mtime (timestamp de
modificación del filesystem) ya existe para ese path. Es un hash determinístico y gratuito: el
sistema operativo lo mantiene sin costo. Si el mtime no cambió, el embedding guardado sigue
siendo válido. Solo si el archivo fue modificado se reprocesa.
Este patrón es equivalente a un sistema de caché con invalidación basada en contenido, pero
más barato que calcular un hash MD5 del audio completo.

#### 1.5 Herramientas para profundizar

- Web Audio API (AudioBuffer, sampleRate, numberOfChannels): leer la especificación
    para ver cómo el browser modela audio de forma análoga.
- Experimento práctico: convertir un .wav estéreo a -f f32le con ffmpeg y abrirlo con
    numpy en Python (np.frombuffer) para visualizar la forma de onda raw.
- librosa (Python): inspeccionar sample rates, canales y representaciones espectrales
    antes de indexar.
✦ **Pregunta de Verificación**
Tenés un archivo ambiental grabado en campo a 96kHz, 24 bits, estéreo. Describí paso a paso qué
transformaciones matemáticas ocurren en el pipeline ffmpeg antes de que los datos lleguen al
modelo CLAP. ¿Qué información se descarta deliberadamente y por qué esa pérdida no afecta la
calidad de la búsqueda semántica?


## Módulo 2: CLAP y la Geometría del Significado

**Tema central:** Cómo CLAP convierte audio y texto al mismo espacio vectorial de 512
dimensiones, y qué significa 'similitud' geométricamente.

#### 2.1 El problema que resuelve CLAP

Antes de modelos multimodales como CLAP, existía un abismo de representación: el audio
vivía en el dominio de amplitudes muestreadas (o coeficientes espectrales), y el texto en
espacios de tokens discretos. No había una operación nativa para medir 'qué tan parecido' es
un sonido a una frase.
CLAP (Contrastive Language-Audio Pretraining), desarrollado por LAION y Microsoft, resuelve
esto con un entrenamiento contrastivo: se le muestran millones de pares (audio,
descripción_de_texto) y se le pide que aprenda una función de proyección tal que pares
correctos terminen cerca en el espacio vectorial, y pares incorrectos terminen lejos.

#### 2.2 La arquitectura dual

CLAP tiene dos encoders independientes que comparten el mismo espacio de salida:
**Encoder Descripción**
Audio Encoder (HTSAT) Hierarchical Token-Semantic Audio Transformer. Procesa el
espectrograma mel del audio. Arquitectura basada en Swin
Transformer adaptada para audio.
Text Encoder (BERT) Tokeniza y codifica la descripción textual. Proyecta el embedding de
texto al mismo espacio R^512 que el audio encoder.
Ambos encoders proyectan sus salidas a R^512 (espacio vectorial de 512 dimensiones) usando
capas de proyección lineal. El resultado: dado cualquier audio o cualquier texto, obtenés un
punto en el mismo espacio matemático.

#### 2.3 El espacio vectorial de 512 dimensiones

Un vector de 512 dimensiones es una lista ordenada de 512 números en punto flotante. Las
512 'dimensiones' representan rasgos semánticos aprendidos durante el entrenamiento
(textura, ataque, reverberación, origen, etc.), y ninguna tiene una etiqueta humana interpretable
directamente.
**Intuición geométrica**


```
Imaginá un espacio donde cada punto es un concepto.
'Trueno' y 'explosion' están cerca. 'Trueno' y 'flauta de madera' están lejos.
CLAP aprendió a ubicar automáticamente esos puntos al ver millones de pares audio-texto.
Tu trabajo como desarrollador es solo consultar ese espacio, no definirlo.
```
#### 2.4 ONNX: corriendo el modelo sin Python

Los pesos del modelo CLAP (~400MB) se distribuyen en formato ONNX (Open Neural Network
Exchange). ONNX es un formato de representación de grafos de cómputo ejecutable en
múltiples runtimes. SoundVault usa ONNXRuntime via Transformers.js, que puede correr el
grafo en WebAssembly o con bindings nativos en Node.js.
Esto elimina la dependencia de Python, PyTorch o CUDA. El modelo corre en la CPU del
usuario, en el mismo proceso de Node.js que maneja la UI de Electron.
**Runtime Características**
PyTorch / TensorFlow Frameworks de entrenamiento. Pesados, requieren instalación de
Python.
ONNX Runtime (CPU) Runtime de inferencia puro. Sin Python. Integrable en Node, C++,
.NET.
ONNX Runtime (WebGPU) Mismo runtime delegando al GPU del usuario. Ver Módulo 4.
Transformers.js Wrapper de alto nivel sobre ONNX Runtime para JS/Node. Maneja
tokenización y llamadas al modelo.

#### 2.5 Herramientas para profundizar

- sentence-transformers (Python): correr un modelo de embeddings de texto y visualizar
    vectores con t-SNE o UMAP.
- Repositorio LAION-AI/CLAP en GitHub: leer los detalles de la función de pérdida
    contrastiva (InfoNCE loss).
- Netron (netron.app): visualizar el grafo ONNX del modelo para ver qué capas existen
    entre la entrada de audio y el vector de salida.
✦ **Pregunta de Verificación**
Cuando SoundVault indexa un disparo de arma y un golpe de timbal, ambos producen vectores de
512 números. ¿Qué propiedad del entrenamiento de CLAP garantiza que esos dos vectores sean
similares entre sí (ataques percusivos) pero distintos del vector de 'viento suave'? ¿Cómo se llama
la función de pérdida que hace posible esto?


## Módulo 3: Almacenamiento y la Matemática de la

## Búsqueda

**Tema central:** SQLite como base de datos vectorial ad-hoc, BLOBs, y la Similitud del Coseno
como operación de búsqueda.

#### 3.1 SQLite: una base de datos en un archivo

SQLite no es un servidor. Es una librería que implementa un motor de base de datos relacional
completo dentro del proceso de la aplicación. La base de datos vive en un único archivo binario
en disco (soundvault-semantic.db). No hay instalación, no hay conexiones de red, no hay
procesos externos.
**Campo Tipo y uso**
file_path TEXT PRIMARY KEY. Ruta absoluta del archivo .wav en disco.
mtime INTEGER. Unix timestamp de modificación del archivo (para
invalidación de caché).
embedding BLOB. Los 512 floats serializados como 2048 bytes (512 × 4 bytes
por float32).

#### 3.2 El BLOB: serializar un vector

Un BLOB (Binary Large Object) es una secuencia de bytes arbitraria en SQLite. SoundVault
serializa el Float32Array directamente a su representación binaria: 512 floats × 4 bytes =
exactamente 2,048 bytes por embedding.
// Serialización
Buffer.from(embedding.buffer) // Float32Array → Buffer → BLOB
// Deserialización
new Float32Array(blob.buffer) // BLOB → Buffer → Float32Array
No hay JSON, no hay CSV, no hay codificación intermedia. Es el mismo layout de memoria que
usa la CPU internamente para representar floats de 32 bits.

#### 3.3 Similitud del Coseno: la operación central de búsqueda

Dada una query de texto, CLAP produce un vector q de 512 dimensiones. Para cada audio
indexado con vector v, se calcula:


#### similitud(q, v) = (q · v) / (||q|| × ||v||)

Donde q · v es el producto punto (suma de productos elemento a elemento) y ||q|| es la norma
euclidiana del vector. El resultado está en el rango [-1, 1]:

- 1.0 → vectores idénticos (máxima similitud semántica)
- 0.0 → vectores ortogonales (sin relación semántica)
- -1.0 → vectores opuestos (conceptos antitéticos)
En la práctica, los embeddings de CLAP tienen norma unitaria (||v|| = 1) después de una capa
de normalización L2. Esto simplifica la similitud del coseno a un producto punto puro, que es la
operación más rápida posible sobre dos arrays numéricos.

#### 3.4 El loop de búsqueda actual

6. Obtener el vector de query de CLAP (inferencia de texto, ~50ms)
7. Extraer todos los rows de SQLite como Float32Arrays
8. Para cada audio: calcular similitud del coseno con el vector de query
9. Ordenar descendentemente y retornar los top-N resultados
Para 1,000 sonidos esto es instantáneo. Para 50,000, el paso 3 implica 50,000 × 512
multiplicaciones en punto flotante en JavaScript puro, potencialmente 200-500ms. Este cuello
de botella se resuelve en el Módulo 4.
**¿Por qué el coseno y no la distancia euclidiana?**
La distancia euclidiana depende de la magnitud de los vectores. Un vector con norma 0.5 y otro
con norma 1.0 apuntando en la misma dirección tendrían distancia no nula aunque representen el
mismo concepto.
El coseno mide solo el ángulo entre vectores, ignorando la magnitud: exactamente lo que se quiere
para comparar conceptos independientemente de la 'intensidad' de su representación.

#### 3.5 Herramientas para profundizar

- Implementar manualmente la similitud del coseno en Python con numpy y medir tiempos
    para arrays de 100, 1000 y 50,000 vectores.
- Explorar la librería better-sqlite3 (Node.js) para entender cómo SoundVault interactúa
    con SQLite de forma síncrona y de alta performance.
- Leer sobre vectores de norma unitaria y por qué el l2-normalize es estándar en sistemas
    de recuperación de información (Information Retrieval).


✦ **Pregunta de Verificación**
Si tenés 10,000 audios indexados y cada embedding es de 512 dimensiones en Float32, ¿cuántos
megabytes ocupa la tabla de embeddings en SQLite? Calculá también cuántas operaciones de
multiplicación en punto flotante ejecuta JavaScript en el peor caso para responder una única
búsqueda.


## Módulo 4: Optimización: Velocidad a Escala

**Tema central:** Por qué JavaScript es lento para álgebra vectorial masiva, índices HNSW,
sqlite-vss y aceleración WebGPU.

#### 4.1 El problema: JavaScript no es un motor de álgebra lineal

JavaScript fue diseñado para manipular el DOM y responder a eventos de usuario, no para
ejecutar millones de operaciones de punto flotante consecutivas. Los motores modernos (V8)
compilan JS a código nativo y optimizan loops, pero tienen overhead significativo comparado
con C++ que opera sobre bloques de memoria alineados usando instrucciones SIMD (Single
Instruction, Multiple Data) del procesador.
El cuello de botella específico: calcular similitud del coseno para 50,000 vectores de 512
dimensiones significa 25,600,000 multiplicaciones en punto flotante más 50,000 divisiones. En
NumPy (C nativo con SIMD) esto toma microsegundos. En JavaScript puro, decenas de
milisegundos.

#### 4.2 sqlite-vss: llevar el cálculo a C++

sqlite-vss es una extensión de SQLite que implementa búsqueda vectorial usando el algoritmo
FAISS (Facebook AI Similarity Search) directamente dentro del proceso de SQLite, en C++
nativo. Una vez instalada, la búsqueda semántica se convierte en una query SQL:
SELECT file_path, vss_distance(embedding, ?) AS dist
FROM soundvault_vss
WHERE vss_match(embedding, ?)
ORDER BY dist LIMIT 20;
El motor de C++ puede usar instrucciones AVX2/AVX-512 del procesador para hacer las
multiplicaciones de vectores en paralelo a nivel de hardware. La diferencia de velocidad para
50,000 vectores es de ~500ms en JS a ~2ms en sqlite-vss.

#### 4.3 Índices HNSW: no comparar contra todos

La solución de sqlite-vss sigue siendo una búsqueda exhaustiva (compara contra todos los
vectores). Para colecciones de millones de sonidos, el siguiente nivel son los índices de
aproximación de vecinos cercanos. El más usado es HNSW (Hierarchical Navigable Small
World).
La intuición de HNSW: en lugar de un grafo plano de conexiones entre vectores, construye
múltiples capas jerárquicas. La capa superior tiene pocos nodos con conexiones de largo


alcance para navegar hacia la región correcta del espacio. Las capas inferiores tienen nodos
con conexiones locales finas para refinar el resultado.
Una búsqueda HNSW en 1,000,000 de vectores puede devolver los top-20 resultados en
menos de 1ms con más del 99% de recall exacto. El trade-off: requiere construir el índice una
vez (proceso offline) y tiene overhead de memoria del 10-15%.
**Estrategia Cuándo usarla**
JS puro (actual) Menos de 5,000 sonidos. Sin dependencias adicionales.
sqlite-vss (C++) 5,000 a 500,000 sonidos. Búsqueda exhaustiva pero nativa.
HNSW (hnswlib-node) Más de 500,000 sonidos. Búsqueda aproximada, sub-milisegundo.
DuckDB + vectores Análisis masivo con joins y metadatos complejos.

#### 4.4 WebGPU: mover la inferencia al GPU

El cuello de botella no es solo la búsqueda: también es la indexación. Procesar 10,000 sonidos
a través de CLAP usando la CPU puede tomar horas. WebGPU permite delegar la inferencia
del modelo ONNX a la GPU del usuario. ONNXRuntime Web tiene soporte experimental para
WebGPU:
// CPU (actual)
const env = { backends: { onnx: { wasm: { numThreads: 4 } } } };
// WebGPU (futuro)
const env = { backends: { webgpu: { powerPreference: 'high-performance' } } };
Una GPU moderna puede paralelizar las operaciones matriciales del transformer con miles de
cores simultáneos. Para la indexación de 10,000 sonidos: de ~2 horas en CPU a ~8 minutos en
GPU.

#### 4.5 Worker Threads: no bloquear la UI

Node.js y Electron tienen un event loop single-threaded. Una indexación larga en el hilo
principal congela la interfaz. La solución es mover el trabajo a un Worker Thread: un hilo
separado de Node.js con su propio event loop, que puede usar un núcleo completo del CPU sin
interferir con los eventos de la UI. La comunicación es por paso de mensajes (postMessage),
similar al modelo de Web Workers en browsers.

#### 4.6 Herramientas para profundizar


- hnswlib-node: construir un índice HNSW con vectores sintéticos en Python y medir la
    diferencia de velocidad contra búsqueda exhaustiva.
- Documentación de FAISS (Facebook AI Similarity Search): entender los distintos tipos
    de índices (Flat, IVF, HNSW) y sus trade-offs de velocidad vs. recall.
- Experimentar con worker_threads en Node.js: mover un loop de cómputo intensivo fuera
    del hilo principal y medir la diferencia de responsividad en la UI.
✦ **Pregunta de Verificación**
Explicá la diferencia conceptual entre una búsqueda vectorial exhaustiva y una búsqueda
aproximada con HNSW. En el contexto de SoundVault, ¿en qué escenario práctico aceptarías un
1% de error en el recall a cambio de latencia sub-milisegundo? ¿Y cuándo ese trade-off sería
inaceptable?


## Módulo 5: Problemas de Producción Real

**Tema central:** Chunking de archivos largos, el límite de ~10s de CLAP, estrategias de
segmentación y gestión de embeddings múltiples por archivo.

#### 5.1 El límite de contexto del modelo

CLAP fue entrenado con clips de audio de duración máxima de aproximadamente 10
segundos. Este no es un límite arbitrario del código, sino una consecuencia del entrenamiento:
los datos usados para entrenar el modelo son mayoritariamente clips cortos etiquetados
(AudioCaps, LAION-Audio-630K). El modelo nunca aprendió a representar 40 minutos de
grabación ambiental como un concepto coherente.
Si se le pasa un archivo de 40 minutos, el audio encoder hace un downsampling temporal
agresivo y produce un embedding que representa el promedio estadístico del contenido
completo. Un trueno en el minuto 25 queda diluido en 40 minutos de pájaros: su contribución al
embedding final es aproximadamente 1/240 del total.
**El problema concreto**
Grabación de campo de 40 min: pájaros (0-24 min), trueno (min 25), lluvia (26-40 min).
Sin chunking: buscar 'trueno' no encuentra este archivo porque el embedding lo representa
mayoritariamente como 'ambiente natural con aves'.
Con chunking: el chunk del minuto 25 tiene un embedding que representa 'trueno', y ese chunk
apunta al mismo archivo .wav con su timestamp exacto.

#### 5.2 Estrategia de Chunking

La implementación futura de chunking divide el Float32Array en segmentos de 10 segundos
con overlap para no perder eventos en los bordes:
const CHUNK_SAMPLES = 48000 * 10; // 10s × 48kHz = 480,000 samples
const OVERLAP_SAMPLES = 48000 * 2; // 2s de overlap en bordes
for (let i = 0; i < audio.length; i += CHUNK_SAMPLES - OVERLAP_SAMPLES) {
const chunk = audio.slice(i, i + CHUNK_SAMPLES);
const embedding = await clap.encode_audio(chunk);
db.insert({ file_path, chunk_offset: i, embedding });
}
Para el archivo de 40 minutos: (40 × 60 × 48000) / (480000 - 96000) ≈ 300 chunks. Cada chunk
genera un embedding y se guarda en SQLite con el campo chunk_offset indicando su posición
en el archivo original.


#### 5.3 Cambios en el esquema de SQLite

CREATE TABLE embeddings (
id INTEGER PRIMARY KEY AUTOINCREMENT,
file_path TEXT NOT NULL,
chunk_start INTEGER NOT NULL DEFAULT 0, -- sample offset
chunk_end INTEGER NOT NULL DEFAULT -1, -- -1 = archivo completo
mtime INTEGER NOT NULL,
embedding BLOB NOT NULL
);
El resultado de búsqueda retorna file_path + chunk_start. El player de SoundVault puede saltar
directamente al timestamp donde ocurre el evento buscado:
const timestamp_seconds = chunk_start / 48000;

#### 5.4 Chunking inteligente vs. chunking fijo

El chunking de ventanas fijas de 10s puede cortar un evento en la mitad. Una explosión que
dura 3s y ocurre en el segundo 9 de un chunk queda dividida entre dos embeddings,
degradando ambos.
El siguiente nivel es el chunking por detección de transitorios: usar un onset detector (picos de
energía RMS o flujo espectral) para cortar en puntos de silencio natural o entre eventos
discretos. Librerías como librosa.onset.onset_detect en Python proveen esta funcionalidad.
**Estrategia de chunking Adecuada para**
Ventana fija (10s) Ambientales continuos: lluvia, viento, multitud. Contenido
estadísticamente homogéneo.
Ventana fija + overlap (2s) Ambientales con eventos esporádicos. El overlap protege eventos
en los bordes.
Detección de transitorios Grabaciones de FX discretos mezclados. Cada evento queda en su
propio chunk.
Silence gating Sesiones de foley: múltiples takes separados por silencio. Cortar en
los silencios.

#### 5.5 Implicaciones para el workflow del diseñador

Con chunking implementado, el buscador cambia su semántica de resultado: en lugar de
retornar archivos, retorna momentos dentro de archivos. Esto habilita flujos de trabajo más
granulares:


- Buscar 'impacto grave' en una sesión de foley de 2 horas y saltar directamente al take
    correcto.
- Buscar 'silencio con textura' en grabaciones de campo largas para encontrar el gap útil.
- Indexar packs completos de ambientales sin necesidad de segmentarlos manualmente
    en el DAW.

#### 5.6 Herramientas para profundizar

- Implementar un chunker simple en Python: cargar un .wav con scipy.io.wavfile, dividirlo
    en ventanas de 10s y medir la diferencia de embeddings entre chunks con CLAP.
- librosa.onset.onset_detect: entender cómo detectar automáticamente el inicio de
    eventos en audio para chunking inteligente.
- Literatura de Audio Segmentation en MIR (Music Information Retrieval): trabajos sobre
    segmentación estructural de audio largo.
✦ **Pregunta de Verificación**
Diseñá el schema completo de SQLite para un sistema de chunking con overlap. ¿Cómo invalidás
el caché correctamente cuando un archivo .wav de 40 minutos es modificado? ¿Borrás todos los
chunks y reindexás, o es posible un sistema más granular? ¿Qué campos adicionales agregarías
para soportar búsqueda por rango de tiempo dentro del archivo?


## Resumen del Programa

El mapa completo de conceptos cubiertos, organizados por su posición en el pipeline de
SoundVault:
**Módulo Conceptos clave**
1 · Pre-procesamiento ffmpeg-static, Float32Array, 48kHz mono, invalidación por mtime
2 · CLAP y Embeddings Entrenamiento contrastivo, encoders duales, ONNX Runtime, R^
3 · Almacenamiento SQLite, BLOB, serialización de floats, Similitud del Coseno
4 · Optimización JS vs. C++, sqlite-vss, HNSW, WebGPU, Worker Threads
5 · Producción Real Límite de contexto CLAP, chunking, overlap, onset detection

#### Ruta de aprendizaje recomendada

10. Dominar la álgebra de embeddings (similitud del coseno, norma L2) con numpy.
11. Correr CLAP directamente en Python con transformers de HuggingFace para
    inspeccionar vectores.
12. Implementar un buscador mínimo: índice en memoria, similitud del coseno, top-
    resultados.
13. Añadir persistencia SQLite y medir el overhead de I/O.
14. Implementar chunking y medir la diferencia en calidad de búsqueda para archivos
    largos.
15. Profilar el loop de búsqueda y comparar JS puro vs. sqlite-vss vs. hnswlib.
**Próximos pasos para SoundVault**
Corto plazo: implementar Worker Threads para la indexación y eliminar el freeze de UI.
Mediano plazo: implementar chunking con overlap para búsqueda dentro de archivos largos.
Largo plazo: evaluar sqlite-vss para colecciones de más de 10,000 sonidos y pre-empaquetar los
pesos de CLAP en el bundle para operación 100% offline desde el primer segundo.


