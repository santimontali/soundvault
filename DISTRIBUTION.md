# Distribuir SoundVault

Cómo generar el instalador y compartirlo. El empaquetado está cubierto por `tests/packaging.test.js` y por un validador que corre después del build (`scripts/verify-dist.js`).

## 1. Requisitos (solo en la máquina que construye)
- Windows 10/11 x64, Node.js 20 o superior, npm.
- Modelo CLAP en `build-assets/models/Xenova/clap-htsat-unfused/`. Esa carpeta está en `.gitignore`: se copia de `node_modules\@xenova\transformers\.cache\Xenova` después de haber corrido la app una vez en desarrollo:

```powershell
Copy-Item "node_modules\@xenova\transformers\.cache\Xenova" "build-assets\models\Xenova" -Recurse -Force
```

- Modelo de imágenes del Brief (sin él, las imágenes solo aportan su paleta de colores). En `build-assets/vocab-build/`, que también está en `.gitignore`:
  - `siglip2-base-patch16-224-ONNX/` desde https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX: `onnx/vision_model_int8.onnx` (95 MB), `onnx/text_model_int8.onnx` (283 MB), `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `config.json` y `preprocessor_config.json`.
  - `UCS v8.2.1 Full List.xlsx`, la lista de categorías de https://universalcategorysystem.com (dominio público).

  Después, una sola vez:

```powershell
node scripts/prepare-image-model.js
node scripts/run-electron-node.js scripts/build-image-vocabulary.js
```

  El primero adapta el codificador de imagen al ONNX Runtime de la app y lo deja en `build-assets/models/siglip2/` (96 MB). El segundo usa el codificador de texto para calcular los 753 conceptos UCS con sus sinónimos (`concepts.json` y `concepts.f16`, unos 3 min). Al instalador solo viajan el codificador de imagen y el vocabulario; el de texto se usa únicamente para compilar.

## 2. Comandos

```powershell
npm install
npm test               # tests unitarios (incluye la suite de packaging)
npm run test:engine    # motor completo sobre una librería sintética
npm run test:e2e       # la app real sobre fixtures, con carpeta de usuario aislada
npm run dist           # instalador NSIS + ZIP portable en dist\
npm run verify:dist    # valida dist\win-unpacked
```

`npm run dist` primero:
- deja las DLL del runtime de Visual C++ junto a `onnxruntime.dll`,
- convierte el modelo de texto de CLAP a float16 (`scripts/prepare-models.js`; el FP32 original queda en `build-assets\text_model.fp32.onnx`),
- revisa el modelo de imágenes (`scripts/prepare-image-model.js --if-needed`: lo prepara si falta o quedó viejo, y corta el build si falta el vocabulario),
- genera el ícono multi-tamaño (`electron scripts/make-icon.js`).

## 3. Artefactos (`dist/`)
| Archivo | Qué es |
|---|---|
| `soundvault-<versión>-Setup.exe` | Instalador por usuario (sin permisos de administrador). Accesos directos en Escritorio y Menú Inicio, y desinstalador. **Es el que conviene compartir** |
| `soundvault-<versión>-x64.zip` | Versión portable: se descomprime y se ejecuta `soundvault.exe`. Reemplaza al `.exe` portable anterior, que re-extraía ~1 GB en %TEMP% en cada arranque (70-166 s) |

La app funciona 100% offline desde el primer arranque. Los modelos van incluidos: audio 117 MB y texto 251 MB en float16, con resultados idénticos a FP32 (coseno ≥ 0,99999) y ~480 MB menos de RAM. La comprensión de imágenes (SigLIP 2, 97 MB) se carga recién al analizar una imagen y se libera después de 2 minutos sin uso.

## 4. En la PC de destino
1. Ejecutar el Setup. SmartScreen muestra *"Windows protected your PC"* → **More info → Run anyway** (sin certificado de firma; ver §6).
2. La carpeta por defecto es `%LOCALAPPDATA%\Programs\soundvault`.
3. En el primer arranque se crean `%APPDATA%\soundvault\` (configuración y bases) y `Documentos\SoundVault\` (librería por defecto). Elegí tu carpeta de sonidos desde la app.
4. El análisis IA arranca solo y se puede pausar en Ajustes. En una librería de 70k archivos analizada de cero tarda unas 10 h en segundo plano. Cada sonido es buscable apenas se analiza.

**Actualizar desde 1.x:** se instala encima y conserva vaults, colecciones y el análisis ya hecho. La primera vez, Echo convierte su tabla al formato nuevo en segundo plano (~1-2 min con 70k archivos). Los ~4.300 archivos que la versión vieja había guardado mal se re-analizan solos.

**Requisitos:** Windows 10/11 x64, ~1,3 GB de espacio, 8 GB de RAM recomendados. No hace falta Node, Python ni el Visual C++ Redistributable.

## 5. Datos del usuario
- Todo queda en `%APPDATA%\soundvault\`. Desinstalar **no** lo borra.
- La versión ZIP usa la misma carpeta de datos.

## 6. Firma de código (opcional)
Con un certificado OV/EV:

```powershell
$env:CSC_LINK = "C:\ruta\al\certificado.pfx"
$env:CSC_KEY_PASSWORD = "tu_password"
npm run dist
```

## 7. Notas legales
- `ffmpeg-static` (GPL) se redistribuye: al publicar la app hay que ofrecer el código fuente de ffmpeg (alcanza con un enlace a https://ffmpeg.org/download.html).
- Modelo `Xenova/clap-htsat-unfused` (LAION CLAP): revisar la licencia de los pesos para uso comercial.
- Modelo de imágenes SigLIP 2 (`google/siglip2-base-patch16-224`, exportado por onnx-community): Apache 2.0.
- Vocabulario de conceptos: UCS v8.2.1 (Universal Category System), dominio público.

## 8. REAPER (opcional)
`reaper-scripts/SoundVault_Export.lua` se copia a mano a `%APPDATA%\REAPER\Scripts`. Encuentra la librería leyendo `%APPDATA%\soundvault\soundvault-config.json`; por eso `productName` sigue en minúsculas.
