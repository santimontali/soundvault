# Distribuir SoundVault a cualquier PC

Guía completa para generar el instalador/ejecutable y compartirlo. Todo el proceso fue auditado, probado sobre una simulación de PC limpio (instalación silenciosa + app instalada ejecutándose offline) y quedó cubierto por tests (`tests/packaging.test.js`, `tests/hnsw-integration.test.js`, `tests/hnsw-perf.test.js`) y un validador post-build (`scripts/verify-dist.js`).

---

## 1. Requisitos (solo en la máquina que CONSTRUYE)

- Windows 10/11 x64, Node.js ≥ 20 y npm.
- No hace falta nada más: ni Visual Studio ni Python (los módulos nativos ya vienen precompilados o son N-API; `npmRebuild` está desactivado en la config porque `postinstall` ya ejecuta `electron-rebuild`).

## 2. Comandos

```powershell
npm install            # instala deps + reconstruye better-sqlite3 (postinstall)
npm test               # 62 tests — incluye la suite de packaging
npm run pack           # build rápida: dist\win-unpacked (sin instalador)
npm run verify:dist    # valida el empaquetado (43 checks; falla = build rota)
npm run dist           # build completa: NSIS Setup + Portable en dist\
```

Si actualizas el modelo CLAP o las dependencias nativas, vuelve a generar el bundle del modelo antes de `npm run dist`:

```powershell
Copy-Item "node_modules\@xenova\transformers\.cache\Xenova" "build-assets\models\Xenova" -Recurse -Force
```

El icono se regenera con `node scripts\make-icon.js` (sin dependencias externas).

## 3. Artefactos generados (en `dist/`)

| Archivo | Qué es | Uso recomendado |
|---|---|---|
| `soundvault-1.0.0-Setup.exe` (~668 MB) | Instalador NSIS por usuario (sin admin). Elige carpeta, crea accesos directos en Escritorio y Menú Inicio, y desinstalador. | **Compartir este** |
| `soundvault-1.0.0-Portable.exe` (~668 MB) | Ejecutable único que se auto-extrae a `%TEMP%` y corre sin instalar. | USB / prueba rápida |
| `soundvault-1.0.0-Setup.exe.blockmap` | Mapa de bloques para futuras auto-actualizaciones | Conservar junto al Setup |

El tamaño incluye el modelo CLAP completo (592 MB FP32) bundleado: **la app funciona 100% offline desde el primer arranque** — no descarga nada.

## 4. En el PC de destino

1. Copiar `soundvault-1.0.0-Setup.exe` y ejecutarlo (doble clic).
2. Windows SmartScreen mostrará *"Windows protected your PC"* → **More info → Run anyway** (la app no está firmada con certificado de código; ver §7).
3. Elegir carpeta (por defecto `%LOCALAPPDATA%\Programs\soundvault`, sin permisos de administrador) y listo: acceso directo en Escritorio y Menú Inicio.
4. Primer arranque: crea `%APPDATA%\soundvault\` (config + base de datos) y `Documents\SoundVault\` (biblioteca por defecto). Elegir la carpeta de sonidos desde la app si ya existe una.

**Requisitos del PC destino:** Windows 10/11 **x64** (no ARM nativo; en Windows ARM correría por emulación x64, no soportado oficialmente), ~1.5 GB de espacio libre, 8 GB RAM recomendados (el motor semántico usa ~1.2 GB durante la indexación). **No necesita** Node, Python, ni Visual C++ Redistributable (las DLL `msvcp140/vcruntime140` viajan junto a `onnxruntime.dll`).

## 5. Qué se verificó en la simulación de PC limpio

- Instalación silenciosa (`Setup.exe /S`) OK; accesos directos en Escritorio + Menú Inicio; desinstalador presente.
- App instalada arranca y carga el modelo CLAP **desde los recursos bundleados, sin red** (`allowRemoteModels=false` cuando está empaquetada).
- ffmpeg ejecutable fuera del asar (indexación y peaks Tier-3 funcionan); better-sqlite3, sharp, onnxruntime-node y hnswlib-node desempaquetados y cargando.
- Búsqueda léxica y de peaks puras sin dependencias (offline por diseño).
- Índice HNSW se construye **en background** sin congelar la UI (~53 s para 70k vectores; la búsqueda funciona vía brute-force mientras).

## 6. Datos del usuario (importante al compartir)

- La app guarda su estado en `%APPDATA%\soundvault\` (config, vaults, `soundvault-semantic.db` con los embeddings). **Desinstalar NO borra estos datos** — sobrevive a reinstalaciones/actualizaciones.
- La **versión Portable** usa el mismo `%APPDATA%\soundvault` (los datos no viajan en el USB).
- Si dos personas comparten el mismo PC, cada una tiene su propio `%APPDATA%`.

## 7. Firmado de código (opcional pero recomendado para distribución amplia)

El instalador actual está sin firmar → SmartScreen avisará. Para quitarlo:

1. Conseguir un certificado OV (~70–400 USD/año; Certum y SSL.com son de los baratos) o EV (confianza instantánea).
2. Exportar estas variables antes de `npm run dist`:

```powershell
$env:CSC_LINK = "C:\ruta\al\certificado.pfx"
$env:CSC_KEY_PASSWORD = "tu_password"
```

electron-builder firma automáticamente el Setup, el Portable y los exe internos.

## 8. Notas legales

- `ffmpeg-static` (binario GPL) se redistribuye con la app: al compartirla públicamente, GPL exige ofrecer el código fuente correspondiente de ffmpeg (basta un enlace a https://ffmpeg.org/download.html en el README o en la app).
- El modelo `Xenova/clap-htsat-unfused` (LAION CLAP) tiene su propia licencia (MIT para el código; revisar la tarjeta del modelo en HuggingFace para uso comercial de los pesos).

## 9. REAPER (opcional)

`reaper-scripts/SoundVault_Export.lua` se instala manualmente copiándolo a la carpeta `Scripts` de REAPER (`%APPDATA%\REAPER\Scripts`). No se incluye en el instalador; autodetecta la biblioteca leyendo `%APPDATA%\soundvault\soundvault-config.json` (por eso `productName` se mantiene en minúsculas `soundvault`).

## 10. Actualizaciones futuras

Para publicar una nueva versión: subir `version` en `package.json`, `npm run dist`, y compartir el nuevo Setup. El instalador NSIS instala encima preservando `%APPDATA%\soundvault`. Los artefactos `latest.yml` + `.blockmap` ya quedan listos si más adelante se quiere auto-update con `electron-updater`.
