# Arquitectura de la Búsqueda

# Semántica (IA) en SoundVault

Esta documentación explica paso a paso cómo funciona el motor de inteligencia artificial que acabamos de integrar en tu
explorador de sonidos, cómo interactúan sus piezas debajo del capó, y cómo podrías evolucionarlo en el futuro.

## 1. El Cerebro: CLAP (Contrastive

## Language-Audio Pretraining)

```
El corazón de este sistema es un modelo de Inteligencia Artificial llamado CLAP (creado originalmente por LAION y
Microsoft). Normalmente, una computadora ve los archivos de audio como listas infinitas de números, y los textos como
letras. No tienen relación geométrica. Lo que hace CLAP es traducir tanto el audio como el texto a un mismo
"idioma matemático" compuesto por 512 números. A esto se le llama un Vector o Embedding.
```
```
Si tú pasas el audio del viento soplando por el modelo de IA, te devolverá un vector (por ejemplo: [0.12, -0.44,
0.89, ...]). Si pasas el texto "viento fuerte" por el modelo de texto de la IA, te devolverá un vector casi idéntico.
Como ambos hablan el mismo idioma, la computadora ahora puede medirlos geométricamente para ver qué tan cerca
están el uno del otro.
```
## 2. El Proceso de Indexación (¿Cómo lee

## tus sonidos?)

```
Cuando presionas el botón "Index AI" , el programa no envía absolutamente nada a internet, todo ocurre en tu propio
procesador. El ciclo es el siguiente:
```
```
1. Escaneo de disco: El programa revisa tu carpeta SoundVault e ignora carpetas del sistema (como
node_modules).
2. Chequeo de cambios: Por cada archivo .wav encontrado, revisa si su fecha de modificación ya existe en la
base de datos para no hacer trabajo doble.
3. Conversión de Audio (ffmpeg): La Inteligencia Artificial es selectiva. Solo entiende audio en formato
Monofónico a 48,000Hz. Usamos una herramienta empaquetada llamada ffmpeg-static para que, sin
importar si el sonido está en estéreo o a 96kHz, se extraiga un "resumen" temporal compatible en un formato
llamado Float32Array. Todo esto ocurre en memoria, sin crear archivos basura.
4. Razonamiento (Inferencia): El código usa la librería Transformers.js para inyectar ese audio al modelo
ONNX de CLAP. El cerebro "escucha" el audio matemáticamente y genera el Embedding de 512 dimensiones.
```

## 3. Almacenamiento: ¿Dónde y cómo se

## guardan esos datos?

```
Para que no tengas que esperar media hora cada vez que abres la aplicación, esos Embeedings se guardan
permanentemente en tu disco duro en una base de datos SQLite , que es ligera, local e invisible.
```
```
Ubicación exacta: En Windows, se guarda en la carpeta oculta de datos de aplicación: C:\Users\tu-
usuario\AppData\Roaming\soundvault\soundvault-semantic.db.
Qué guarda la tabla:
file_path: La ubicación absoluta del archivo en el disco.
mtime: La fecha de última modificación (para saber si editaste el archivo y debe reescanearlo).
embedding: Una masa compacta de bytes (BLOB) que contiene los 512 números matemáticos que
representan la psique del sonido.
```
```
SQLite es inmensamente robusto y la usan desde aplicaciones de celulares hasta navegadores web para guardar su
caché. Soporta decenas de miles de filas sin inmutarse ni saturar tu memoria RAM.
```
## 4. La Búsqueda (Similitud del Coseno)

```
Cuando tú tecleas "impacto metálico profundo" y la tecla - AI - está encendida:
```
```
1. El texto se pasa instantáneamente por el modelo CLAP de texto, obteniendo un vector de 512 dimensiones.
2. Extraemos todos los audios guardados en SQLite.
3. El programa realiza una operación matemática llamada Similitud del Coseno. Compara el vector de tu texto
contra CADA UNO de los vectores de tus audios almacenados para dibujar un ángulo matemático entre ellos.
4. Finalmente, ordena la lista dejando los ángulos más cerrados (mayores coincidencias) en los primeros
resultados.
```
## 5. Requisitos para una Aplicación

## "Standalone" (Independiente)

Para que el día de mañana puedas enviarle este programa (SoundVault.exe) a un diseñador sonoro y le funcione sin
instalar nada y sin conexión a internet, nuestro sistema actualmente cumple (o encamina) estas premisas:

```
1. Binarios Embebidos: Al depender del paquete ffmpeg-static, el motor de procesamiento de audio viaja
dentro del propio programa en lugar de depender de que el usuario lo instale manualmente en Windows.
2. Inferencia Local (ONNX + V8 Engine): Node.js ejecuta la arquitectura ONNX directamente en la CPU. No
requiere que el usuario instale Python, Anaconda, Pytorch ni nada similar.
```

```
3. Caché de Modelos: Actualmente la IA descarga los pesos del cerebro (~400MB) desde HuggingFace el primer
día que se ejecuta la aplicación. Para hacerlo 100% offline desde el primer segundo, el siguiente paso de
compilación sería pre-descargar esos archivos ubicados en Xenova/clap-htsat-unfused y ordenarle a
Transformers.js que se inicialice apuntando a una carpeta interna en el sistema de archivos del
SoundVault.exe en lugar de buscarlos en la red.
```
## 6. Evolución, Robustez y Optimizaciones

## Futuras

Aunque el sistema es funcional, para competir contra estándares como _Basehead_ o _Soundminer_ , la matemática y la
velocidad de este buscador pueden llevarse al siguiente nivel:

### Optimizaciones de Búsqueda Extremas (sqlite-vss o

### Índices HNSW)

```
Actualmente comparamos tu texto uno a uno contra cada vector en JavaScript. Si tuvieras 50,000 sonidos,
JavaScript podría tardar hasta medio segundo en las multiplicaciones consecutivas. La solución futura: Instalar
un plugin llamado sqlite-vss (o migrar a DuckDB) que permite hacer las multiplicaciones de los 50,000 audios
de manera matemática matricial nativa en C++, reduciendo el tiempo de milisegundos a microsegundos,
haciéndolo de facto instantáneo.
```
### Aceleración por Tarjeta Gráfica (WebGPU)

```
Node.js ahora mismo usa la CPU para procesar los audios. A futuro, este proceso pesado puede enviarse a los
procesadores gráficos usando ONNXRuntime WebGPU. Esto convertiría una indexación de horas en apenas
unos pocos minutos.
```
### Segmentación Dinámica (Chunking)


_El cerebro CLAP está entrenado para escuchar solo unos_ **_pocos segundos (hasta ~10s) de audio_**_. Si le haces
indexar un archivo estéreo ambiental de 40 minutos (ej. pájaros cantando en la selva, donde en el minuto 25 hay
un trueno), CLAP resumirá y machacará todo y se "olvidará" del trueno._ **_La solución:_** _Al indexar archivos largos,
dividir el Float32Array en múltiples pedazos invisibles de 10 segundos, obtener un embedding por cada
pedazo, y guardarlos en la base de datos referenciando al unísono al mismo archivo. Si el usuario busca
"Trueno", saldrá el sonido del pájaro._

### Manejo de Hilos (Workers)

_Para evitar que la interfaz parpadee, la indexación inteligente debe mudarse de un simple "promise background"
en el hilo principal (main.js (file:///c:/Users/santi/Documents/SoundVault_Tests/src/main.js)), hacia un Worker
Thread de Node.js, para que ocupe de manera segregada un núcleo entero de la CPU sin entorpecer los clics
del usuario en la parte frontal de Electron._


