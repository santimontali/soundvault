# Librerías online (Freesound y otras): investigación

**Fecha:** 25/09/2026 · **Rama:** `overhaul-2.0` · **Alcance:** solo investigación, sin cambios de código.

**Pregunta:** ¿podemos sumar librerías gratuitas online, como Freesound, con conexión a internet, como hace SoundQ?

**Convenciones.** `[n]` es una fuente externa y `[Rn]` una del repo (lista al final). `(est.)` marca una estimación propia y "a verificar", algo que la documentación pública no aclara. Las cifras de Freesound salen de las facetas de su buscador, consultado el 25/09/2026 [9]. Nada de esto es asesoramiento legal.

---

## Resumen

**Respuesta corta: sí, con una sola fuente: Freesound.** Es la única gratuita con API pública y documentada: 736.391 sonidos (52 % CC0), búsqueda con filtros por licencia y datos técnicos, previews en streaming, similitud calculada en su servidor con CLAP y descarga del original con OAuth2 [4][9]. El resto no tiene API (BBC, Pixabay para audio, Zapsplat, Mixkit, Sonniss, OpenGameArt, SoundBible, Free To Use Sounds), tiene licencias que no permiten este uso, o son servicios pagos que exigen un acuerdo comercial (Epidemic, Storyblocks, Pro Sound Effects, Magnific).

**Propuesta**

1. Una fuente **Online** opcional y apagada por defecto. Primero lo local; Freesound aparece en su propia sección, a pedido.
2. **CC0 por defecto**, igual que SoundQ y Soundly [21][27]. CC BY se habilita con un clic y trae créditos automáticos. CC BY-NC y Sampling+ quedan ocultos.
3. **Escuchar no es traer.** Los resultados online se escuchan como preview en el reproductor de siempre, pero se arrastran al DAW recién después de **Download**: baja el original, lo pasa a WAV si hace falta, lo guarda en una carpeta de la librería con un sidecar JSON de licencia y lo deja listo para Describe, Echo y colecciones.
4. **Antes de programar, escribirle a Freesound.** La API es gratis "only for non-commercial purposes" [5]: SoundVault es gratis y MIT [R9], así que en principio encaja, pero conviene confirmarlo. Además, sus términos piden que las credenciales nunca queden expuestas al público [6], y eso es imposible con una clave embebida en una app de código abierto [57]. Mientras tanto, cada usuario usa su propia clave, que es gratis [7].
5. **Plan:** Fase 1, buscar y escuchar (4-6 días). Fase 2, descargar con licencia y créditos (5-7 días). Fase 3, extras opcionales (0,5-3 días cada uno). Todo (est.).

**Números clave**

| Qué | Valor |
|---|---|
| Sonidos en Freesound | 736.391 (714.671 a fin de 2025) [9][10] |
| Licencias: CC0 / CC BY / CC BY-NC / Sampling+ | 52,0 % / 35,3 % / 11,2 % / 1,5 % [9] |
| Originales que no son WAV | 24,5 % (la mitad con pérdida: MP3, M4A, OGG) [9] |
| Límite de la API | 60 pedidos/min y 2.000/día; originales, 30/min y 500/día [2] |
| Resultados por pedido | hasta 150 [4] |
| Previews | OGG ~192 kbps y MP3 ~128 kbps, sin OAuth [4] |
| Sesión OAuth | token de 24 h, con refresh [3] |
| Fuentes gratis con API usable | 1: Freesound. Openverse e Internet Archive tienen API, pero no suman [46][49] |

---

## 1. Cómo lo resuelven otros

### 1.1 SoundQ (Pro Sound Effects)

- **Qué es:** app de escritorio gratuita [20]. Tres fuentes online: la librería de PSE (más de 1 millón de sonidos que se compran con créditos), "SoundQ Free" (más de 2.000 sonidos curados, según PSE) y **Freesound "CC0 only"**, que PSE aclara que no cura [20][21].
- **Búsqueda:** una sola barra sobre lo local y la nube, con colecciones que se muestran u ocultan. Freesound acepta solo parte de los operadores (sus términos se unen con OR) [21].
- **Metadatos:** los de Freesound se ven pero no se editan [21]; los locales se escriben en iXML [20].
- **Cuenta y offline:** cuenta obligatoria, con login en el navegador. Sin conexión, las colecciones en la nube se desactivan, y el uso offline depende de una "offline key" que se renueva con la suscripción [22].
- **Precio:** en 2021, gratis con 5 créditos y 9,99 USD/mes por 30 créditos [23]; en 2025 las suscripciones de PSE iban de 29 a 299 USD/mes [25].
- **Quejas:** en la versión gratis, un tope de 5.000 resultados locales y resultados bloqueados mezclados con los usables ("scroll down 10 pages"); archivos descargados que dejan de estar disponibles al vencer la suscripción [23]; créditos escasos en los planes bajos [24]; cuelgues reportados en el foro de Freesound [19].
- **Cómo baja de Freesound:** no está documentado. Freesound solo entrega originales con OAuth, salvo acuerdos especiales [13]; lo probable (est.) es que PSE tenga una licencia comercial de la API.

### 1.2 Otras apps

| App | Qué integra | Lo que sirve de referencia |
|---|---|---|
| Soundly | Librería propia (Pro: 250.000 sonidos), tienda de add-ons y Freesound como add-on con la opción "Creative Commons 0 only" [27][28]. En 2026, búsqueda en lenguaje natural [28] | CC0 como opción explícita. En 2022 un usuario se quejó de que Freesound pasó a requerir suscripción paga [19] |
| BaseHead | "CloudPacks" de PSE, Airborne y Zapsplat: 26.000 sonidos gratis en 2024 [30]; hoy solo en Premium, porque "bandwidth costs us money" [29]. En 2026 suma un panel de agente IA y un generador con ElevenLabs [29] | El ancho de banda cuesta: por eso Freesound limita su API |
| Soundminer | Soundchute: nube en S3 para distribuir librerías propias, desde 60 USD/mes [31] | No integra librerías gratuitas |
| Sononym | Nada online: funciona completo sin internet [32] | El modelo "offline" que hoy sigue SoundVault |
| Splice | Catálogo propio por créditos, con licencia perpetua; genera un "certified license" descargable [33] | Un documento de licencias exportable |
| Krotos Studio | Packs que se bajan con un botón y quedan disponibles offline [34] | Descarga explícita, después todo offline |
| Ardour (DAW libre) | Pestaña Freesound en el diálogo de importación, con filtro de licencia; OAuth pegando el código que muestra Freesound, en cada sesión [35]. Su código trae un token y un client id por defecto [36] | Precedente de app open source con Freesound |

### 1.3 Qué copiar y qué evitar

- **Copiar:** CC0 por defecto; Freesound presentado como fuente no curada; fuentes online que se apagan sin romper nada offline; un documento de licencias exportable.
- **Evitar:** resultados bloqueados mezclados con los usables; límites que empeoran cuanto más grande es la librería; archivos que dependen de una suscripción; pedir login en cada sesión.

---

## 2. Fuentes candidatas

### 2.1 Gratuitas

| Fuente | Tamaño | ¿API pública usable? | Licencia de los sonidos | Veredicto |
|---|---|---|---|---|
| **Freesound** (MTG, UPF, Barcelona) | 736.391 [9] | **Sí.** REST con token u OAuth2 [1] | CC0, CC BY, CC BY-NC y Sampling+ (ver 2.3) | **Integrar** |
| Openverse (WordPress) | Freesound 591.449, Jamendo 644.709 (música), Wikimedia 3.965.183 [49] | Sí: anónima, 20 pedidos/min y 200/día; más con registro [49] | CC por ítem, con un campo `attribution` listo; Openverse no verifica licencias [49] | No suma: índice parcial de Freesound, y los originales igual piden OAuth de Freesound. Plan B para buscar y escuchar |
| Internet Archive | Enorme | Sí, lectura sin clave [46] | `licenseurl` por ítem; hay subidas no autorizadas, como un volcado completo de la BBC [46] | No: licencias poco confiables |
| BBC Sound Effects | ~33.000 [37] | No | RemArc: uso personal, educativo o de investigación, con crédito a la BBC; no comercial [37]. Licencia comercial vía PSE, 5 USD por sonido [38] | No |
| Pixabay | ~130.000 efectos [41] | No para audio: la API solo cubre imágenes y video [39] | Uso comercial sin atribución; prohíbe distribuir el contenido tal cual [40] | No. Muchos de sus efectos son CC0 de Freesound re-subidos por la cuenta "freesound_community" [41] |
| Zapsplat | 160.000+ [42] | No | Gratis: MP3, 4 descargas por hora, crédito a ZapSplat. Premium (4,99 GBP/mes): sin crédito. Prohíbe que los sonidos sean el valor principal de un producto, como una app de efectos [42] | No: la licencia lo impide |
| Mixkit (Envato) | 3.000+ (reseña) [43] | No | Comercial sin atribución; prohíbe poner los ítems a disposición de terceros [43] | No |
| Sonniss GDC | 2026: 7,47 GB, 347 archivos, 17 marcas; más de 200 GB en años anteriores [44] | No: descarga directa, Drive o torrent | Comercial, sin crédito, sin redistribución; prohíbe entrenar IA (v2.0, 27/08/2026) [44] | Sí, pero como **importación de packs**: tu librería ya tiene 1.966 archivos de GDC 2019 y 2023 [R11] |
| OpenGameArt | s/d | No oficial [45] | CC0, CC BY, CC BY-SA, OGA-BY y GPL [45] | No: share-alike y GPL complican las entregas a clientes |
| SoundBible | s/d | No | CC BY 3.0, dominio público y "solo uso personal" [47] | No |
| Free To Use Sounds | s/d | No | Gratis con crédito; prohíbe redistribuir y entrenar IA [48] | No |

### 2.2 Pagas (para comparar)

| Servicio | Acceso por API | Notas |
|---|---|---|
| Epidemic Sound | Solo con acuerdo de partner; los usuarios se conectan por OAuth ("Connect") [50] | 250.000 efectos; prohíbe cachear metadatos localmente [50] |
| Artlist | API Enterprise, solo música [51] | |
| Storyblocks | API B2B con efectos, firmada con HMAC [52] | La usan Descript, Magix y Clipchamp [52] |
| Pro Sound Effects | Partner API para socios enterprise (06/2025), precio por acuerdo [26] | Es la misma API de su web y de su app [26] |
| Magnific (ex Freepik) | API de efectos con clave, cobro por créditos [53] | Catálogo y condiciones sin verificar |
| Lots of Sounds | API de efectos: 15 USD/mes por 1.000 descargas [54] | Operador y licencia sin verificar |

El mercado pago existe, pero es B2B y exige contrato: no encaja con una app gratuita y offline.

### 2.3 Freesound en detalle

**API v2** [4]

| Recurso | Qué da | Autenticación |
|---|---|---|
| `GET /apiv2/search/` | Texto (`query`) con filtros Solr en `filter` (`license`, `duration`, `samplerate`, `bitdepth`, `channels`, `type`, `tag`, `category`, `subcategory`, `avg_rating`, `num_downloads`, `created`, `is_explicit` y más de 100 descriptores de audio), `sort`, `fields`, `group_by_pack` y `page_size` hasta 150 | Token |
| Similitud | `similar_to` (id de un sonido o un vector) con `similarity_space`: `laion_clap` (512-D, checkpoint `630k-audioset-fusion-best.pt`) o `freesound_classic` (100-D). También `GET /apiv2/sounds/<id>/similar/`. Cada resultado trae `score` | Token |
| `GET /apiv2/sounds/<id>/` | `name`, `tags`, `description`, `license`, `username`, `pack`, `type`, `channels`, `samplerate`, `bitdepth`, `duration`, `filesize`, `md5`, `category`, `previews`, `images`, `gen_ai_preference` | Token |
| Previews | `preview-hq-ogg` ~192 kbps, `preview-hq-mp3` ~128, `preview-lq-ogg` ~80, `preview-lq-mp3` ~64. Vienen de `cdn.freesound.org` [49] | Alcanza con la URL (est.) |
| `GET /apiv2/sounds/<id>/download/` | El original, en el formato en que se subió (también hay descarga de packs) | **OAuth2** |
| `GET /apiv2/usage/` | Consumo actual; no cuenta para el límite | Token |

- El endpoint viejo de búsqueda por texto quedó obsoleto en noviembre de 2025 y hoy redirige a `/apiv2/search/` [4]. El código actual de Ardour todavía usa la ruta vieja [36]: un ejemplo del mantenimiento que pide la integración.
- **Categorías BST** (desde abril de 2025): 5 categorías y 23 subcategorías; los sonidos anteriores se clasificaron con un algoritmo [12]. Sirven para quedarse con efectos y ambientes y dejar afuera la música. Ejemplo de la doc: `category:Music` [4]; los nombres exactos, a verificar.

**Autenticación** [3]

- **Token:** `Authorization: Token <clave>`. Alcanza para buscar, ver fichas, similares y previews.
- **OAuth2** (authorization code): `/apiv2/oauth2/authorize/` devuelve un código (10 min, un solo uso) que se canjea en `/apiv2/oauth2/access_token/` con `client_id` y **`client_secret`**. El access token dura 24 h y viene con refresh token. Hay una sola access token por par app y usuario. Si la app no puede recibir la redirección, Freesound muestra el código en pantalla para copiarlo. La doc no menciona PKCE.
- **Los originales solo se bajan con OAuth.** Las previews HQ son "fine in most cases", según Frederic Font, de Freesound (mayo de 2024) [13].

**Límites** [2]: 60 pedidos por minuto y 2.000 por día; bajar originales (igual que subir, comentar o puntuar) tiene 30 por minuto y 500 por día. Al pasarse, HTTP 429; más cupo se pide por formulario. La doc no dice si el límite es por clave o por usuario (a verificar), y prohíbe registrar varias claves para esquivarlo [5].

**Términos de la API**

- "You can use the Freesound API for free only for non-commercial purposes" [5]; el uso comercial se negocia caso por caso con la UPF [6][7]. No hay una definición escrita de "comercial" [14][17].
- "Remember to properly credit Freesound and Freesound users in accordance to sounds' licenses" [5]. No piden logo (est.).
- No replicar Freesound ni presentar sus datos como propios; no armar bases similares ni scrapear; solo copias intermedias limitadas y necesarias [5][6].
- Las credenciales "must be kept secret and confidential and under no circumstances be exposed to the public"; una clave por aplicación, revocable si se comparte [6].
- La licencia de uso "is temporary and may be withdrawn by Freesound at any time"; ante un incumplimiento avisan y dan 7 días para corregir [6].

**Licencias de los sonidos** [8][9]

| Licencia | Parte del catálogo | ¿Sirve para trabajo pago? | Obligación | En SoundVault |
|---|---|---|---|---|
| CC0 | 52,0 % (382.983) | Sí | Ninguna. Aunque la descripción pida crédito, manda la licencia [18] | Visible por defecto |
| CC BY (la versión exacta viene en la URL de licencia de cada sonido) | 35,3 % (259.674) | Sí | Crédito con título, autor, fuente y licencia, e indicar si se modificó [59]. Formato sugerido: "sound1 by user1 (URL) licensed under ..." [8] | Opcional, con créditos automáticos |
| CC BY-NC | 11,2 % (82.322) | No | Crédito y solo uso no comercial | Oculto; opción avanzada |
| Sampling+ | 1,5 % (11.412) | Limitado; licencia en retiro, "difficult to interpret" [8] | Varias | Oculto siempre |

- **Tendencia:** el 72 % de lo subido en 2025 fue CC0 [10].
- **Irrevocables:** una copia obtenida bajo CC sigue valiendo aunque el autor después cambie la licencia o borre el sonido [58]. Por eso hay que guardar la licencia vigente al descargar.
- **CC BY en juegos:** CC BY 4.0 prohíbe aplicar medidas tecnológicas (DRM) que impidan ejercer la licencia sobre el material [59]. Para audio mezclado dentro de un juego es zona gris; OpenGameArt creó OGA-BY justamente por esto [45]. Para juegos, mejor CC0.
- **Historial:** las descargas por API no aparecían en la "attribution list" de la cuenta (2012) [16] y no hay endpoint de historial (2023) [15]. La app tiene que llevar su propio registro.
- **IA generativa:** desde julio de 2026 los autores declaran preferencias (`gen_ai_preference`) [4][11]. Indexar con CLAP es inferencia local, no entrenamiento; igual, SoundVault no debe entrenar nada con estos sonidos.

**Formatos de los originales** [9]

| Formato | Todo Freesound | Solo CC0 |
|---|---|---|
| WAV | 75,5 % | 73,5 % |
| AIFF | 7,5 % | 10,3 % |
| FLAC | 4,6 % | 3,9 % |
| MP3 | 9,6 % | 8,9 % |
| M4A | 1,9 % | 2,6 % |
| OGG | 1,0 % | 0,9 % |

Frecuencias: 44,1 kHz 64,8 %, 48 kHz 28,1 %, 96 kHz 4,8 %. Canales: estéreo 73,0 %, mono 26,7 %.

---

## 3. Diseño técnico para SoundVault

### 3.1 Principios

- **Apagado por defecto.** Nada sale de la máquina hasta que activás Online en Settings.
- **La red vive en main.** Todos los pedidos salen del proceso principal con `net.fetch`, que usa la red de Chromium y respeta el proxy del sistema [56], contra una lista blanca: `freesound.org` y `cdn.freesound.org`. El renderer sigue sin red: la CSP actual (`connect-src 'self' soundvault:`, `media-src 'self' soundvault: blob:`) no cambia [R4].
- **Lo local no espera.** La búsqueda local responde como hoy; lo online llega después, en su sección.
- **Una sola puerta a la librería:** lo descargado entra por FileOps, sin sobrescribir nunca [R1][R6].
- **Nada pesado en el hilo de main:** la red y el md5 son streams asíncronos y ffmpeg corre como proceso aparte [R1].
- **Fuente enchufable:** una interfaz `OnlineSource` (buscar, ficha, similares, preview, descarga) con Freesound como primera implementación.

### 3.2 Piezas

```
Renderer                          Main                                    Red
sección Freesound ─── IPC ─────►  online/freesound.js ── net.fetch ────►  freesound.org/apiv2
<audio> ─ soundvault://online ─►  online/cache.js ───── net.fetch ────►  cdn.freesound.org
Download ──── IPC ─────────────►  online/download.js ─► online/auth.js (OAuth, safeStorage)
                                    │ ffmpeg si no es WAV → sidecar JSON → FileOps.importPaths
                                    ▼
                   LibraryIndex ─► motor: CLAP + Echo, con prioridad de "cambios del usuario"
```

- Canales IPC nuevos (`online:status`, `online:search`, `online:similar`, `online:download`, `online:sign-in`, `online:sign-out`, `online:credits`), validados como el resto [R7].
- `%APPDATA%\soundvault\soundvault-sources.json`: registro de procedencia (ruta, id, md5, licencia), con escritura atómica como los demás JSON [R1].
- `%APPDATA%\soundvault\online-auth.bin`: tokens y claves, cifrados.
- `%LOCALAPPDATA%\soundvault\online-cache\`: previews, con tope de tamaño (fuera del perfil móvil).

### 3.3 Búsqueda

- **Dónde:** una sección "Freesound" debajo de los resultados locales, a pedido ("Search Freesound for …"), nunca con cada tecla. Si la búsqueda local trae pocos resultados, la sección se ofrece sola. Con Online activado se puede elegir que busque siempre (apagado por defecto).
- **Idioma:** la consulta en español se traduce con el mismo `translateQuery` de la búsqueda por nombre [R7] ("pasos en grava" → "footsteps gravel") y la UI muestra qué se envió.
- **Un pedido por página:** `page_size` 50 (máximo 150) y `fields` solo con lo que muestra la fila. Filtros por defecto: CC0, categorías de efectos y ambientes, `is_explicit:false`.
- **Describe:** en la v1 la consulta viaja como texto y Freesound busca por palabras, así que la sección lo dice: "Online results match words, not sound". El ranking por sonido llega en la fase 3 (ver 3.10).
- **Sin mezclar puntajes:** el `score` de Freesound y la similitud CLAP local no son comparables. Lo online tiene su propia sección y su propio orden.

### 3.4 Previews en el reproductor

- El reproductor ya hace streaming con `<audio>` sobre `soundvault://`, con Range [R1][R3]. Se suma la ruta `soundvault://online/preview?src=freesound&id=80929`: main valida el id, toma la URL de su propia caché de resultados (nunca una URL que mande el renderer), baja la preview a disco y la sirve con Range. Los efectos cortos pesan de 50 a 300 KB (est.).
- Calidad: HQ OGG por defecto (~192 kbps) y MP3 como alternativa. Hay que verificar con un test que el Chromium de Electron 41 reproduzca MP3 en la app empaquetada.
- La forma de onda sale de decodificar la preview en el renderer, como hoy. Sobre una preview se escucha, se hace loop y se navega; no se abre el editor ni se arrastra.
- Las previews salen del CDN y no deberían contar para el límite de la API (est.).

### 3.5 Descarga a la librería

1. **Download** en la fila, "D" con la fila seleccionada, o "Add to collection" (las colecciones guardan rutas locales, así que primero baja). Carpeta: la última usada; por defecto `<librería>\Freesound\`. También se puede soltar la fila sobre una carpeta del árbol.
2. Sin sesión, pide "Sign in with Freesound" (ver 3.7).
3. `GET /download/` con el token, a un `.part` de staging; al terminar se verifican el tamaño y el `md5` [4].
4. Si no es WAV, lo convierte el ffmpeg que ya viene con la app [R10]. FLAC, AIFF y WV: sin pérdida, con la misma frecuencia, canales y bits. MP3, M4A y OGG: WAV float de 32 bits (nada se recorta arriba de 0 dBFS, como en E2 [R2]), marcado "lossy source".
5. Nombre: `<id>__<usuario>__<nombre>.wav`, la convención que usa Freesound con el id adelante [16]. Así la procedencia se recupera aunque se pierda el sidecar.
6. Se escriben el sidecar `<archivo>.wav.json` y la entrada del registro.
7. `FileOps.importPaths` lo lleva a la carpeta (nombre único) → LibraryIndex → el motor lo analiza con prioridad de cambios del usuario: en alrededor de 1 s se encuentra con Describe y Echo (est., a 540 ms por archivo [R2]).
8. La fila deja de ser online: se arrastra, se edita y se colecciona como cualquier otra.

Arrastrar una fila sin descargar muestra "Download to use it in your DAW". Además de la licencia hay una razón técnica: el arrastre nativo de Windows necesita un archivo que ya exista al empezar [R7].

**Sidecar (ejemplo)**

```json
{
  "schema": "soundvault-source/1",
  "source": "freesound",
  "id": 80929,
  "page": "https://freesound.org/s/80929/",
  "title": "Door slam 2.wav",
  "author": "bennstir",
  "license": { "name": "CC BY 4.0", "url": "https://creativecommons.org/licenses/by/4.0/", "commercial": true, "credit": true },
  "credit": "\"Door slam 2.wav\" by bennstir (https://freesound.org/s/80929/), licensed under CC BY 4.0",
  "tags": ["door", "slam"],
  "original": { "type": "wav", "samplerate": 44100, "bytes": 247232, "md5": "..." },
  "converted": null,
  "downloaded": "2026-09-25T14:03:00Z"
}
```

**Cambios en lo que ya existe**

- FileOps: mover, renombrar y mandar a la Papelera también el `.json` (hoy solo conoce WAV [R5][R6]).
- LibraryWatcher: ignorar los `.json`; si el usuario renombra en el Explorer, re-vincular por `md5` o por el id del nombre.
- Búsqueda por nombre: sumar los tags de Freesound como un campo más del índice léxico (hoy: nombre, carpeta y primer nivel [R7]).
- Opcional: escribir también `LIST/INFO` (título, artista, copyright, comentario) en los archivos que convierte ffmpeg, para que la licencia viaje dentro del WAV. Los WAV originales quedan intactos (md5 verificable).

### 3.6 Atribución y créditos

- **Registro de procedencia** (`soundvault-sources.json`): se arma con los sidecars y se reconstruye si falta.
- **Derivados:** arrastrar una selección o una edición genera un render nuevo [R7]; el render hereda la procedencia del original, y lo mismo pasa con "Save to library" (E5 [R2]). CC BY exige indicar si hubo modificación [59], así que la línea de crédito dice "modified". Sin esto, los créditos se pierden justo en el flujo más común.
- **Registro de uso:** cada arrastre al DAW de un archivo con procedencia (o derivado de uno) se anota en el vault activo.
- **Export credits…** en el menú del vault y de cada colección: texto listo para pegar (con el formato de Freesound [8]) y CSV. Dos alcances: lo usado (arrastrado) o lo guardado en colecciones. Agrupa por licencia, lista CC0 aparte como cortesía y avisa si hay algo NC.

```
Sounds from Freesound (freesound.org) used in "Forest Level":
CC BY 4.0
- "Door slam 2.wav" by bennstir (https://freesound.org/s/80929/), modified. https://creativecommons.org/licenses/by/4.0/
CC0 (no credit required)
- ...
```

### 3.7 Credenciales, OAuth y tokens

| | A. Clave propia del usuario | B. Clave de SoundVault |
|---|---|---|
| Qué es | Cada usuario crea credenciales gratis en freesound.org/apiv2/apply [7] y las pega en Settings | Una credencial de la app dentro del instalador |
| Términos | Cumple "no exponer credenciales" [6] | Choca con [6] salvo permiso: un secreto repartido con la app no es confidencial [57]. Ardour lo hace [36] |
| Límite | 2.000 pedidos/día por usuario | 2.000/día compartidos si el límite es por clave (a verificar): hay que pedir más |
| UX | 2-3 minutos de configuración, una vez | "Sign in with Freesound" y listo |

**Recomendación:** A para el prototipo y el uso personal; B solo con el OK de Freesound por escrito.

**Flujo OAuth** (igual en A y B)

1. `shell.openExternal` a `authorize` con un `state` aleatorio. El usuario inicia sesión en **su navegador**, nunca dentro de SoundVault: RFC 8252 prohíbe los navegadores embebidos para esto, porque la app podría leer la contraseña [57].
2. Recibir el código:
   - Preferido: redirección a `http://127.0.0.1:<puerto>/callback`, con un servidor de un solo uso en main (RFC 8252, sección 7.3 [57]). A verificar que Freesound acepte esa URL.
   - Respaldo probado por Ardour [35]: Freesound muestra el código y SoundVault ofrece "Paste code".
3. Canje con `client_id` y `client_secret` [3]; refresh automático antes de las 24 h.
4. **Guardado:** `safeStorage` cifra tokens y claves con DPAPI, y se escriben en `online-auth.bin` [55]. Protege contra otros usuarios de la PC, no contra otros programas del mismo usuario [55]. Si el cifrado no está disponible, quedan solo en memoria durante la sesión. El renderer nunca ve un token: recibe `{ signedIn, username }`.
5. **Sign out:** borra el archivo y abre la página de permisos de apps de Freesound para revocar el acceso (URL a verificar).

Como hay "una sola access token por app y usuario" [3], iniciar sesión en una segunda PC puede invalidar la primera: un 401 dispara un refresh o pide login otra vez.

### 3.8 Límites, caché y offline

- **Limitador local:** 60/min y 2.000/día para la API; 30/min y 500/día para originales [2]. Settings muestra el consumo del día con `/apiv2/usage/` [4].
- **Errores:** un 429 frena y avisa ("Freesound limit reached. Try again in 12 min."), sin reintentos en cadena. Un 5xx: hasta 2 reintentos con espera creciente y aleatoria. Timeout de 8 s (est.).
- **Caché de búsquedas:** en memoria, 100 consultas durante 1 h (est.). Nada de espejar el catálogo: lo prohíben los términos [6].
- **Caché de previews:** LRU con tope de 500 MB (configurable, con "Clear" en Settings); se vacía al apagar Online. Lo escuchado se puede volver a escuchar offline mientras siga en caché.
- **Offline:** la sección dice "Offline" y no reintenta sola. Lo descargado es WAV local y funciona siempre, sin cuenta ni suscripción (lo contrario de SoundQ [22][23]).

### 3.9 Privacidad

- Al activar Online, una línea explica qué sale: el texto de búsqueda (ya traducido), los filtros y la sesión de Freesound si la hay. Nunca salen nombres, rutas, audio ni vectores de la librería.
- Sin prefetch, sin pedidos en segundo plano, sin telemetría. Un test verifica que con Online apagado no haya ni un pedido de red.
- Los textos de Freesound (nombres, descripciones, tags) se muestran como texto plano, como ya pasa con los nombres de archivo [R2].
- La web promete "0 telemetría · 0 red" y "sin cuenta" [R9]: pasaría a "sin red salvo que actives Online".

### 3.10 Encaje con Brief, Echo y Describe

| Idea | Cómo | Costo (est.) |
|---|---|---|
| Brief: buscar afuera lo que falta | Las palabras sin buen material local ("No strong matches yet for: …" [R8]) suman "Search Freesound" en su menú | 0,5-1 día |
| "Similar on Freesound" | `similar_to=<id>` en `laion_clap` [4] | 0,5 día |
| "Like this in my library" | Preview → CLAP de audio local (ya existe) → HNSW de la librería | 1 día |
| Describe con ranking por sonido | Bajar las previews del top 10-20 y puntuarlas con el CLAP local contra el texto; misma barra de relevancia que lo local | 2-3 días; ~0,6 s por preview en CPU (est., desde K2 [R2]) |
| Describe sobre todo Freesound | Mandar el vector de texto como `similar_to`. **No funciona con el modelo actual:** SoundVault usa `clap-htsat-unfused` [R12] y Freesound `630k-audioset-fusion-best` [4], dos espacios distintos. Habría que sumar, a pedido, la torre de texto del modelo "fused" (Apache 2.0 [60]) y verificar que coincida | 3-5 días de investigación |
| Importar packs (Sonniss GDC) | "Import pack…" copia la carpeta y le asigna una licencia por carpeta (bundle, año, URL). Sirve también para marcar los 1.966 archivos GDC que ya tenés [R11] | 1-1,5 días |
| Reconocer descargas manuales | Detectar nombres `<id>__<usuario>__…` y completar la licencia por API. Hoy tu librería no tiene ninguno [R11] | 1 día |

Echo no se extiende a lo online: sus huellas son propias y Freesound no ofrece nada equivalente. Lo descargado entra a Echo solo, como cualquier archivo.

### 3.11 Cómo se vería

```
[ footsteps gravel                              ]  Library ▾   Describe
  128 sounds in your library
  ... filas locales ...
  ── Freesound · 1,284 results ─── CC0 ▾  Effects ▾  Any length ▾ ──────
  ☁  80929__bennstir__door-slam-2   0.4 s   WAV 44.1k   CC0     ↓ Download
  ☁  123__user__gravel-steps        6.2 s   MP3 lossy   CC BY   ↓ Download
                              Load 50 more
```

Textos de la UI (en inglés):

- Settings › Online: "Search Freesound" (apagado). "Your search text is sent to freesound.org. Your sounds, file names and library never leave this computer." "API key". "Sign in with Freesound" / "Signed in as {user}. Sign out". "Download folder". "Preview cache: 84 MB. Clear". "Requests today: 312 of 2,000".
- Badges: "CC0", "CC BY" (tooltip "Credit required"), "NC" ("Non-commercial only"), "Lossy source".
- Estados: "Offline", "Freesound limit reached. Try again in 12 min.", "Online results match words, not sound."
- Menú del vault: "Export credits…".
- Sin la palabra "AI": la búsqueda por descripción sigue siendo Describe [R12].

---

## 4. Riesgos

| # | Riesgo | Por qué | Mitigación |
|---|---|---|---|
| 1 | Uso "comercial" de la API | Gratis solo para uso no comercial, sin definición escrita [5][14][17] | SoundVault es gratis y MIT [R9]; confirmarlo por escrito con Freesound. Si algún día se cobra, licencia comercial |
| 2 | Credenciales expuestas | Los términos piden secreto [6]; en una app abierta cualquier clave se extrae [57] | Clave propia (A) o permiso escrito (B) |
| 3 | Licencia mal declarada en origen | La licencia la elige quien sube; Openverse ni siquiera verifica [49] | CC0 por defecto; guardar la licencia vigente al descargar [58]; carpeta propia para poder auditar |
| 4 | CC BY en entregas a clientes | El crédito pasa al producto final; en juegos con DRM, zona gris de CC BY 4.0 [59] | Créditos exportables, con "modified"; recomendar CC0 para juegos |
| 5 | NC en trabajo pago | 11,2 % del catálogo [9] | Oculto por defecto; aviso al descargar si se habilita |
| 6 | Cláusulas sobre IA | Sonniss y Free To Use Sounds prohíben entrenar IA [44][48]; Freesound registra preferencias [11] | SoundVault solo indexa (inferencia). No entrenar nada con estos sonidos, ni siquiera un mapeo entre espacios CLAP |
| 7 | Mezclar material licenciado y de terceros | Hoy la librería son librerías compradas; lo de Freesound trae obligaciones propias | Carpeta propia, badge de licencia persistente, filtro "Needs credit", registro de uso |
| 8 | Calidad dispar y metadatos pobres | Freesound no está curado (PSE lo advierte [21]) | Filtros por frecuencia y bits, ocultar "lossy", ordenar por rating o descargas |
| 9 | Latencia de red en una app que responde en 60-470 ms [R2] | La red es impredecible | Sección aparte, a pedido, que nunca bloquea lo local |
| 10 | Solo WAV [R2] | El 24,5 % de los originales no es WAV [9] | Conversión al descargar; previews solo para escuchar |
| 11 | Sidecars huérfanos | Renombres en el Explorer | Registro central con md5 e id; el id en el nombre |
| 12 | Límite diario | 2.000 pedidos/día [2] | Limitador, caché y pedidos a demanda |
| 13 | Modelos CLAP distintos | Los vectores locales no sirven en `laion_clap` [4] | No mandar vectores locales; solo `similar_to` por id |
| 14 | La API cambia | Búsqueda de texto reemplazada en 11/2025 [4]; en la web, las Collections reemplazaron a los bookmarks (09/2026) [11] | Cliente chico y aislado, tests contra un servidor falso y una prueba manual contra la API real antes de cada release: 0,5-1 día por trimestre (est.) |
| 15 | Los términos pueden retirarse | "temporary and may be withdrawn" [6] | Online se apaga sin romper nada: lo descargado queda |

---

## 5. Plan por fases

| Fase | Qué incluye | Esfuerzo (est.) | Listo cuando |
|---|---|---|---|
| **0. Decisiones** | Mail a Freesound: uso no comercial, clave propia o de la app, límites, crédito requerido. Spike: MP3 y OGG en el `<audio>` de Electron 41 y redirección a loopback | 1 día, más la espera | Respuesta de Freesound y spike OK |
| **1. Buscar y escuchar** | Settings (opt-in, clave), cliente con limitador, sección Freesound con filtros (CC0 fijo), previews por `soundvault://online`, estados offline y de límite, tests con un servidor falso | 4-6 días | Se busca "pasos en grava" y se escuchan 20 previews; la CSP no cambia; con Online apagado no sale ni un pedido (test) |
| **2. Descargar con licencia** | OAuth y safeStorage; descarga, conversión, sidecar y FileOps; sidecars al mover, renombrar y borrar; badges; procedencia de renders; registro de uso; "Export credits…"; CC BY opcional | 5-7 días | Un CC BY descargado, recortado y arrastrado aparece en los créditos del vault; Describe y Echo lo encuentran |
| **3. Extras** | Los de la tabla 3.10, uno por uno, según el uso real | 0,5-3 días cada uno | Según cada ítem |

**Primer paso mínimo recomendado:** Fase 0 y Fase 1 con CC0 fijo. Si en el uso real Freesound aporta material que tu librería no tiene (lo que el Brief marca "sin coincidencia" es un buen termómetro), seguir con la Fase 2, que es donde está el valor para trabajar.

## 6. Decisiones abiertas

1. ¿Clave propia o de la app? Depende de la respuesta de Freesound.
2. ¿CC BY visible por defecto, o solo CC0?
3. ¿Mostrar NC alguna vez?
4. ¿Carpeta fija `Freesound\` o elegir siempre?
5. ¿Guardar la preview como archivo cuando no hay sesión? Recomiendo que no: meter MP3 de 128 kbps en una librería profesional es una trampa.
6. ¿Escribir la licencia dentro del WAV (INFO), además del sidecar?

---

## Fuentes

### Externas

**Freesound**

1. Freesound API, documentación. https://freesound.org/docs/api/
2. Freesound API, Overview (límites de uso). https://freesound.org/docs/api/overview.html
3. Freesound API, Authentication (token y OAuth2). https://freesound.org/docs/api/authentication.html
4. Freesound API, Resources APIv2 (búsqueda, similitud, previews, descarga, usage). https://freesound.org/docs/api/resources_apiv2.html
5. Freesound API, Terms of Use (resumen de la documentación). https://freesound.org/docs/api/terms_of_use.html
6. Freesound, Terms of use of the Freesound API (texto completo). https://freesound.org/help/tos_api/
7. Freesound, ayuda para desarrolladores. https://freesound.org/help/developers/
8. Freesound, FAQ (licencias y atribución). https://freesound.org/help/faq/
9. Freesound, buscador con facetas, consultado el 25/09/2026: todo el catálogo y solo CC0. https://freesound.org/search/?q= · https://freesound.org/search/?q=&f=license%3A%22Creative+Commons+0%22
10. Freesound Blog, "2025 in numbers" (30/01/2026). https://blog.freesound.org/?p=2347
11. Freesound Blog, índice (Collections, 08/09/2026; Generative AI Preferences, 10/07/2026). https://blog.freesound.org/browse/
12. Freesound Blog, "Introducing the Broad Sound Taxonomy" (11/04/2025). https://blog.freesound.org/?p=2206
13. Grupo freesound-api, "How to directly download files without oAuth" (05/2024). https://groups.google.com/g/freesound-api/c/8qQyjHQ8H4g
14. Grupo freesound-api, "Inquiry About Freesound API Usage and Licensing" (03/2025). https://groups.google.com/g/freesound-api/c/tZ9-GWKFydw
15. Grupo freesound-api, "Possible to add a /user/downloads endpoint?" (09/2023). https://groups.google.com/g/freesound-api/c/tzuEtR5_Rqk
16. Foro de Freesound, "API Downloads and Attribution" (01/2012). https://freesound.org/forum/legal-help-and-attribution-questions/17736/
17. Foro de Freesound, "Can a commercial software use the API to download noncommercial sounds?" (06/2012). https://freesound.org/forum/legal-help-and-attribution-questions/32688/
18. Foro de Freesound, "License is CC0 but description says to attribute?" (02/2020). https://freesound.org/forum/legal-help-and-attribution-questions/42164/
19. Foro de Freesound, "Recommendations for a decent MacOS client…" (11/2022). https://freesound.org/forum/freesound-project/43841/

**Apps**

20. Pro Sound Effects, SoundQ. https://www.prosoundeffects.com/soundq
21. SoundQ, User Guide. https://hello.prosoundeffects.com/soundq/user-guide
22. SoundQ, FAQ. https://hello.prosoundeffects.com/soundq/faq
23. Creative Field Recording, "First Look: SoundQ" (06/10/2021). https://www.creativefieldrecording.com/2021/10/06/soundq-sound-effects-library-manager/
24. 344 Audio, reseña de SoundQ. https://www.344audio.com/post/review-soundq-from-pro-sound-effects
25. Production Expert, "Pro Sound Effects CORE 6 Tested" (02/06/2025). https://www.production-expert.com/production-expert-1/pro-sound-effects-core-6-tested
26. Pro Sound Effects, "Introducing the PSE Partner API" (12/06/2025). https://blog.prosoundeffects.com/pse-partner-api
27. Soundly, uso comercial del add-on de Freesound. https://getsoundly.com/faq/how-can-i-use-the-freesound-library/
28. Soundly, sitio y planes. https://getsoundly.com/ · https://getsoundly.com/faq/what-are-the-differences-between-the-subscriptions/
29. basehead FREE y sitio de basehead. https://baseheadinc.com/bhfree/ · https://baseheadinc.com/
30. Creative Field Recording, "basehead FREE Revealed" (24/07/2024). https://www.creativefieldrecording.com/2024/07/24/bashead-free-revealed/
31. Avosound, Soundminer Soundchute. https://www.avosound.com/en-us/sound-archive-management/soundchute
32. Sononym. https://www.sononym.net/
33. Splice, licencias y "certified license". https://support.splice.com/en/articles/8652642-splice-sounds-licensing-faq · https://splice.com/blog/generate-certified-license/
34. Krotos Studio, Getting Started. https://krotos.studio/guide/getting-started-krotos
35. Ardour Manual, Import Dialog (Freesound). https://manual.ardour.org/adding-pre-existing-material/import-dialog/
36. Ardour, `sfdb_freesound_mootcher.cc`. https://github.com/Ardour/ardour/blob/master/gtk2_ardour/sfdb_freesound_mootcher.cc

**Otras fuentes de sonido**

37. BBC Sound Effects, licencia RemArc (el sitio no se deja leer de forma automática; resumen en prensa). https://sound-effects.bbcrewind.co.uk/licensing · https://www.cined.com/bbc-gives-away-16000-sound-effects-for-free/ · https://djmag.com/news/you-can-now-download-over-33000-sound-effects-bbc-archive
38. Pro Sound Effects, "How to License BBC Sound Effects…". https://blog.prosoundeffects.com/how-to-license-bbc-sound-effects-to-use-in-your-commercial-productions
39. Pixabay, API docs. https://pixabay.com/api/docs/
40. Pixabay, License summary. https://pixabay.com/service/license-summary/
41. Pixabay, efectos de sonido y cuenta "freesound_community". https://pixabay.com/sound-effects/ · https://pixabay.com/users/freesound_community-46691455/
42. ZapSplat, Standard License, planes y FAQ. https://www.zapsplat.com/license-type/standard-license/ · https://www.zapsplat.com/registration-plans/ · https://www.zapsplat.com/faq/
43. Mixkit, licencia, información oficial y reseña con el tamaño del catálogo. https://mixkit.co/license/ · https://mixkit.co/llm-info/ · https://kripeshadwani.com/mixkit-review/
44. Sonniss, GDC 2026 Game Audio Bundle, licencia y archivo. https://gdc.sonniss.com/ · https://sonniss.com/gdc-bundle-license/ · https://sonniss.com/gameaudiogdc
45. OpenGameArt, FAQ e hilo sobre una API. https://opengameart.org/content/faq · https://opengameart.org/forumtopic/opengameart-api
46. Internet Archive, APIs y ejemplo de volcado de la BBC. https://archive.org/developers/index-apis.html · https://archive.org/details/BBCSoundEffectsComplete
47. SoundBible, About. https://soundbible.com/about.php
48. Free To Use Sounds, License Agreement. https://www.freetousesounds.com/license-agreement
49. Openverse API: esquema, estadísticas de audio, términos y una consulta de prueba (encabezados de límite), 25/09/2026. https://api.openverse.org/v1/schema/ · https://api.openverse.org/v1/audio/stats/ · https://docs.openverse.org/terms_of_service.html · https://api.openverse.org/v1/audio/?q=door%20slam&source=freesound
50. Epidemic Sound, Partner API (FAQ y documentación). https://developers.epidemicsound.com/docs/FAQ/ · https://developers.epidemicsound.com/docs/
51. Artlist, Enterprise API. https://developer.artlist.io/welcome
52. Storyblocks, API. https://www.storyblocks.com/resources/business-solutions/api · https://documentation.storyblocks.com/
53. Magnific (ex Freepik), Sound Effects API. https://docs.magnific.com/api-reference/sfx/overview
54. Lots of Sounds. https://www.lotsofsounds.com/

**Técnica y licencias**

55. Electron, `safeStorage`. https://www.electronjs.org/docs/latest/api/safe-storage
56. Electron, `net`. https://www.electronjs.org/docs/latest/api/net
57. RFC 8252, "OAuth 2.0 for Native Apps" (navegador externo, loopback, secretos en apps distribuidas). https://www.rfc-editor.org/rfc/rfc8252
58. Creative Commons, FAQ (las licencias no se revocan). https://creativecommons.org/faq/
59. CC BY 4.0, código legal (secciones 2(a)(5)(C) y 3(a)). https://creativecommons.org/licenses/by/4.0/legalcode.en
60. Hugging Face, `laion/clap-htsat-unfused` y `laion/clap-htsat-fused` (Apache 2.0). https://huggingface.co/laion/clap-htsat-unfused · https://huggingface.co/laion/clap-htsat-fused

### Internas (repo)

- **R1.** `docs/ARCHITECTURE.md`: protocolo `soundvault://` con Range, invariantes (nada pesado en main, la librería solo se toca con FileOps), escrituras JSON atómicas.
- **R2.** `docs/CASOS_DE_USO.md`: A8 (búsquedas de 60-470 ms), E2 (float queda float), E5 (guardar en la librería), I1 (nombres como texto inerte), K2 (540 ms por archivo), limitación "solo WAV".
- **R3.** `src/main/audio-protocol.js`: solo sirve `.wav`, con Range.
- **R4.** `src/renderer/index.html`: CSP (`connect-src 'self' soundvault:`, `media-src 'self' soundvault: blob:`).
- **R5.** `src/main/paths.js`: `AUDIO_EXT = '.wav'`.
- **R6.** `src/main/file-ops.js`: `COPYFILE_EXCL`, nombres únicos, Papelera.
- **R7.** `src/main.js` y `src/search/lexical-search.js`: IPC validado, `translateQuery` en la búsqueda por nombre, `drag:start` con `renders.promote`, campos del índice léxico (nombre, carpeta, primer nivel).
- **R8.** `src/renderer/js/ui/brief.js`: línea "No strong matches yet for: …" y su menú.
- **R9.** `web/index.html`: "Sin cuenta, sin suscripción, sin telemetría", "0 telemetría · 0 red", licencia MIT.
- **R10.** `DISTRIBUTION.md`: ffmpeg incluido (`ffmpeg-static`, GPL).
- **R11.** Índice de la librería real (`soundvault-library.json`, solo lectura, 25/09/2026): 70.331 WAV, 1.966 de "Sonnis GDC" (bundles 2019 y 2023), ninguno con nombre `<id>__<usuario>__…`.
- **R12.** `PROJECT_INSTRUCTIONS.md`: modelo `Xenova/clap-htsat-unfused`; la UI dice Describe y Resonance, nunca "AI"; textos de la UI en inglés.
