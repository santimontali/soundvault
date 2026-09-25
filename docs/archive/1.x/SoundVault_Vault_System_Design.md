# SoundVault: Vault System Design Document

## Overview

This document defines the complete architecture for SoundVault's Vault system: a project-based workspace model where each Vault is an isolated, identity-rich context containing its own folders, collections, semantic database, and sound cache. The system prioritizes zero-latency switching, fluid micro-animations, and non-invasive AI-powered features.

---

## Phase 1: Vault Core + Switcher

### 1.1 Config Evolution

**File:** `soundvault-config.json` (in `app.getPath('userData')`)

Current structure:
```json
{ "libraryPath": "/Users/x/Documents/SoundVault" }
```

New structure:
```json
{
  "vaults": [
    {
      "id": "v_a1b2c3d4",
      "name": "Horror Project",
      "path": "/Users/x/Audio/HorrorGame",
      "color": "#e24b4a",
      "lastOpened": 1711400000000,
      "lastState": {
        "folder": "Ambiences",
        "collection": null,
        "scrollTop": 240
      }
    },
    {
      "id": "v_e5f6g7h8",
      "name": "Main Library",
      "path": "/Users/x/Documents/SoundVault",
      "color": "#c8f76d",
      "lastOpened": 1711390000000,
      "lastState": { "folder": null, "collection": "Favorites", "scrollTop": 0 }
    }
  ],
  "activeVaultId": "v_a1b2c3d4"
}
```

**Migration:** On first launch with old config, auto-create a single Vault entry from the existing `libraryPath`, named "Main Library", with the default accent color. Set it as `activeVaultId`.

### 1.2 Main Process Changes (`main.js`)

#### New helper functions:

```javascript
function generateVaultId() {
  return 'v_' + crypto.randomBytes(4).toString('hex');
}

function getActiveVault() {
  const config = getConfig();
  return config.vaults.find(v => v.id === config.activeVaultId) || config.vaults[0];
}

function getVaultDbPath(vaultId) {
  return path.join(app.getPath('userData'), `soundvault-semantic-${vaultId}.db`);
}

function getVaultCollectionsPath(vault) {
  return path.join(vault.path, '.soundvault-collections.json');
}
```

#### Modified `getConfig()`:
```javascript
function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      // Migration: old format -> new format
      if (raw.libraryPath && !raw.vaults) {
        const migrated = {
          vaults: [{
            id: generateVaultId(),
            name: 'Main Library',
            path: raw.libraryPath,
            color: '#c8f76d',
            lastOpened: Date.now(),
            lastState: { folder: null, collection: null, scrollTop: 0 }
          }],
          activeVaultId: null
        };
        migrated.activeVaultId = migrated.vaults[0].id;
        saveConfig(migrated);
        return migrated;
      }
      return raw;
    }
  } catch(e) {}
  const id = generateVaultId();
  return {
    vaults: [{
      id, name: 'Main Library',
      path: path.join(app.getPath('documents'), 'SoundVault'),
      color: '#c8f76d', lastOpened: Date.now(),
      lastState: { folder: null, collection: null, scrollTop: 0 }
    }],
    activeVaultId: id
  };
}
```

#### Vault switch flow:

```javascript
async function switchVault(vaultId) {
  const config = getConfig();
  const vault = config.vaults.find(v => v.id === vaultId);
  if (!vault) return false;

  // 1. Persist current vault's UI state (sent from renderer)
  // 2. Update active vault
  config.activeVaultId = vaultId;
  vault.lastOpened = Date.now();
  saveConfig(config);

  // 3. Re-initialize sound cache for new vault path
  await initSoundCache(); // Already reads from getActiveVault().path

  // 4. Re-initialize semantic engine for new vault DB
  await semanticEngine.switchDatabase(getVaultDbPath(vaultId), vault.path);

  // 5. Notify renderer
  mainWindow.webContents.send('vault-switched', {
    id: vault.id,
    name: vault.name,
    color: vault.color,
    lastState: vault.lastState
  });

  return true;
}
```

#### New IPC handlers:

```javascript
ipcMain.handle('get-vaults', () => {
  const config = getConfig();
  return {
    vaults: config.vaults.map(v => ({
      id: v.id, name: v.name, color: v.color,
      path: v.path, lastOpened: v.lastOpened
    })),
    activeVaultId: config.activeVaultId
  };
});

ipcMain.handle('create-vault', async (_, { name, path: vaultPath, color }) => {
  const config = getConfig();
  if (!fs.existsSync(vaultPath)) return { error: 'Path does not exist' };
  const id = generateVaultId();
  config.vaults.push({
    id, name, path: vaultPath, color: color || '#c8f76d',
    lastOpened: Date.now(),
    lastState: { folder: null, collection: null, scrollTop: 0 }
  });
  saveConfig(config);
  return { id };
});

ipcMain.handle('switch-vault', async (_, vaultId) => {
  return switchVault(vaultId);
});

ipcMain.handle('save-vault-state', (_, { folder, collection, scrollTop }) => {
  const config = getConfig();
  const vault = config.vaults.find(v => v.id === config.activeVaultId);
  if (vault) {
    vault.lastState = { folder, collection, scrollTop };
    saveConfig(config);
  }
});

ipcMain.handle('rename-vault', (_, vaultId, name) => {
  const config = getConfig();
  const v = config.vaults.find(x => x.id === vaultId);
  if (v) { v.name = name; saveConfig(config); return true; }
  return false;
});

ipcMain.handle('delete-vault', async (_, vaultId) => {
  const config = getConfig();
  if (config.vaults.length <= 1) return false; // Can't delete last vault
  config.vaults = config.vaults.filter(v => v.id !== vaultId);
  if (config.activeVaultId === vaultId) {
    config.activeVaultId = config.vaults[0].id;
    saveConfig(config);
    await switchVault(config.activeVaultId);
  } else {
    saveConfig(config);
  }
  // Optionally delete the semantic DB file
  const dbPath = getVaultDbPath(vaultId);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return true;
});

ipcMain.handle('set-vault-color', (_, vaultId, color) => {
  const config = getConfig();
  const v = config.vaults.find(x => x.id === vaultId);
  if (v) { v.color = color; saveConfig(config); return true; }
  return false;
});
```

### 1.3 Semantic Engine Changes (`semantic-engine.js`)

Add a `switchDatabase` method:

```javascript
async switchDatabase(dbPath, libraryPath) {
  // Close existing DB
  if (this.db) {
    await new Promise(r => this.db.close(r));
  }

  // Open new DB
  this.db = new sqlite3.Database(dbPath);
  await new Promise((resolve, reject) => {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT UNIQUE,
        mtime INTEGER,
        vector BLOB
      )
    `, (err) => err ? reject(err) : resolve());
  });

  // Reload vector cache
  await this._loadCacheFromDB();

  // Clear search caches
  this._lastQueryText = null;
  this._lastBaseVector = null;
  this._lastWordVectors = {};

  console.log(`[SemanticEngine] Switched to ${dbPath} (${this._count} vectors)`);
}
```

### 1.4 Preload Additions (`preload.js`)

```javascript
// Vaults
getVaults: () => ipcRenderer.invoke('get-vaults'),
createVault: (data) => ipcRenderer.invoke('create-vault', data),
switchVault: (id) => ipcRenderer.invoke('switch-vault', id),
saveVaultState: (state) => ipcRenderer.invoke('save-vault-state', state),
renameVault: (id, name) => ipcRenderer.invoke('rename-vault', id, name),
deleteVault: (id) => ipcRenderer.invoke('delete-vault', id),
setVaultColor: (id, color) => ipcRenderer.invoke('set-vault-color', id, color),
onVaultSwitched: (cb) => ipcRenderer.on('vault-switched', (_, data) => cb(data)),
```

### 1.5 Logo & Vault Switcher UI (`index.html`)

#### Logo HTML (replaces static `.logo` div):

```html
<div class="logo-wrap" id="vault-switcher-wrap">
  <div class="logo" id="vault-logo" tabindex="0">
    <span class="logo-sound" id="logo-sound">SOUND</span>
    <span class="logo-dot">·</span>
    <span class="logo-vault" id="logo-vault">VAULT</span>
    <svg class="logo-chevron" id="logo-chevron" width="8" height="8"
         viewBox="0 0 8 8">
      <path d="M1 3l3 3 3-3" fill="none" stroke="currentColor"
            stroke-width="1.2" stroke-linecap="round"/>
    </svg>
  </div>
  <div class="vault-dropdown" id="vault-dropdown"></div>
</div>
```

#### Logo CSS:

```css
.logo {
  display: flex;
  align-items: baseline;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.15s;
  -webkit-app-region: no-drag;
}
.logo:hover { background: rgba(255,255,255,0.04); }

.logo-sound, .logo-vault {
  font-size: 14px;
  transition: font-weight 0.35s cubic-bezier(0.25,0.46,0.45,0.94),
              color 0.35s,
              letter-spacing 0.25s;
}

.logo-dot {
  font-size: 9px;
  margin: 0 2px;
  transition: color 0.35s, opacity 0.35s;
}

.logo-chevron {
  margin-left: 5px;
  opacity: 0.3;
  transition: transform 0.2s, opacity 0.2s;
  color: var(--text-secondary);
}

/* State: Sound mode (default when browsing) */
.logo.mode-sound .logo-sound {
  font-weight: 800; letter-spacing: 3px; color: var(--accent);
}
.logo.mode-sound .logo-vault {
  font-weight: 400; letter-spacing: 2px; color: var(--text-muted);
}
.logo.mode-sound .logo-dot { color: var(--text-muted); opacity: 0.3; }

/* State: Vault mode (dropdown open) */
.logo.mode-vault .logo-sound {
  font-weight: 400; letter-spacing: 2px; color: var(--text-muted);
}
.logo.mode-vault .logo-vault {
  font-weight: 800; letter-spacing: 3px; color: var(--accent);
}
.logo.mode-vault .logo-dot { color: var(--accent); opacity: 0.5; }
.logo.mode-vault .logo-chevron { transform: rotate(180deg); opacity: 0.6; }

/* State: Neutral (no vault selected) */
.logo.mode-neutral .logo-sound,
.logo.mode-neutral .logo-vault {
  font-weight: 600; letter-spacing: 2.5px; color: var(--text-primary);
}
.logo.mode-neutral .logo-dot { color: var(--text-secondary); opacity: 0.5; }
```

#### Vault Dropdown CSS:

```css
.vault-dropdown {
  position: absolute;
  top: 44px;
  left: 0;
  min-width: 220px;
  background: var(--bg-surface);
  border: 0.5px solid var(--border);
  border-radius: 10px;
  padding: 5px;
  z-index: 10000;
  box-shadow: 0 12px 32px rgba(0,0,0,0.4);
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
  transition: opacity 0.18s, transform 0.18s cubic-bezier(0.16,1,0.3,1);
  pointer-events: none;
}
.vault-dropdown.open {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}

.vault-dd-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-primary);
  transition: background 0.1s;
}
.vault-dd-item:hover { background: var(--bg-hover); }
.vault-dd-item.active { background: var(--bg-active); }

.vault-dd-dot {
  width: 8px; height: 8px;
  border-radius: 3px;
  flex-shrink: 0;
  border: 0.5px solid rgba(255,255,255,0.1);
}

.vault-dd-check {
  margin-left: auto;
  font-size: 11px;
  color: var(--accent);
  opacity: 0;
}
.vault-dd-item.active .vault-dd-check { opacity: 1; }

.vault-dd-add {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
  border-top: 0.5px solid var(--border);
  margin-top: 4px;
  padding-top: 10px;
}
.vault-dd-add:hover { color: var(--accent); }
```

---

## Phase 2: Collection-Scoped Search & Suggestions

### 2.1 Scoped Search

#### Renderer logic (no new IPC needed):

```javascript
// In the search handler:
async function doSearch(query) {
  let results;

  if (useSemanticSearch) {
    const res = await window.api.semanticSearch(query, currentWeights);
    results = res.results;
  } else {
    results = await window.api.searchAllSounds(query);
  }

  // Apply collection scope filter if active
  if (currentCollection && collectionScopedSearch) {
    const colSounds = await window.api.getCollectionSounds(currentCollection);
    const colPaths = new Set(colSounds.map(s => s.path));
    results = results.filter(r => colPaths.has(r.path));
  }

  renderSounds(results);
}
```

#### Scope Pill UI:

When `currentCollection` is set and the search box is focused, inject a scope pill before the input:

```javascript
function updateSearchScope() {
  const pill = document.getElementById('scope-pill');
  if (currentCollection && document.activeElement === searchBox) {
    pill.style.display = 'flex';
    pill.querySelector('.sp-name').textContent = currentCollection;
    // Set dot color from collection colors
  } else {
    pill.style.display = 'none';
  }
}
```

### 2.2 Semantic Suggestions ("Related")

#### New IPC in `main.js`:

```javascript
ipcMain.handle('semantic-suggest', async (_, filePath) => {
  if (!semanticEngine.isReady || semanticEngine._count === 0) return [];

  // Find the file's vector index
  const idx = semanticEngine._paths.indexOf(filePath);
  if (idx === -1) return [];

  // Extract its vector
  const vec = semanticEngine._matrix.subarray(idx * DIM, (idx + 1) * DIM);

  // Run dot product (reusing _searchFlat with topK=9 to get 8 after self-exclusion)
  const raw = semanticEngine._searchFlat(vec, 9);

  // Exclude self
  return raw.filter(r => r.path !== filePath).slice(0, 8);
});
```

#### New preload entry:

```javascript
semanticSuggest: (path) => ipcRenderer.invoke('semantic-suggest', path),
```

#### Renderer UI: "Related" button in panel header:

```javascript
// In panel-actions area, add:
// <button class="btn-small" id="related-btn" title="Related sounds" style="display:none">
//   <svg ...node icon.../> ~
// </button>

document.getElementById('related-btn').addEventListener('click', async () => {
  if (!currentSound) return;
  const related = await window.api.semanticSuggest(currentSound.path);
  if (!related.length) return;
  showRelatedDropdown(related);
});

function showRelatedDropdown(items) {
  // Position dropdown below the related-btn
  // Each item: name, score, clickable to load that sound
  // Close on outside click
}
```

---

## Phase 3: Incremental Indexing & Performance

### 3.1 Filesystem Watcher

```javascript
// In main.js, after switchVault or on startup:
const chokidar = require('chokidar'); // Add to dependencies

let watcher = null;
function startVaultWatcher(vaultPath) {
  if (watcher) watcher.close();

  watcher = chokidar.watch(vaultPath, {
    ignored: /(^|[\/\\])\.|node_modules/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500 }
  });

  watcher.on('add', async (fp) => {
    if (!fp.toLowerCase().endsWith('.wav')) return;
    const rel = path.relative(vaultPath, fp);
    try {
      const st = await fs.promises.stat(fp);
      const entry = {
        name: path.basename(fp),
        path: fp,
        folder: path.dirname(rel).replace(/\\/g, '/'),
        topLevel: rel.split(path.sep)[0],
        size: st.size,
        dateAdded: st.mtimeMs
      };
      soundCache.push(entry);
      soundCache.sort((a,b) => b.dateAdded - a.dateAdded);

      // Queue for semantic indexing
      semanticIndexQueue.push({ path: fp, mtime: st.mtimeMs });
      processIndexQueue();

      // Notify renderer of new file
      mainWindow?.webContents.send('sound-added', entry);
    } catch(e) {}
  });

  watcher.on('unlink', (fp) => {
    soundCache = soundCache.filter(s => s.path !== fp);
    mainWindow?.webContents.send('sound-removed', fp);
  });
}
```

### 3.2 Background Index Queue

```javascript
let semanticIndexQueue = [];
let isProcessingQueue = false;

async function processIndexQueue() {
  if (isProcessingQueue || !semanticEngine.isReady) return;
  isProcessingQueue = true;

  while (semanticIndexQueue.length > 0) {
    const item = semanticIndexQueue.shift();

    // Check if already indexed with same mtime
    const isIndexed = await new Promise(r => {
      semanticEngine.db.get(
        'SELECT mtime FROM embeddings WHERE file_path = ?',
        [item.path],
        (err, row) => r(row && row.mtime === item.mtime)
      );
    });

    if (!isIndexed) {
      await semanticEngine.indexFile(item.path, item.mtime);
    }

    // Yield to event loop between files
    await new Promise(r => setImmediate(r));
  }

  isProcessingQueue = false;
}
```

### 3.3 Vault Switch Animation (Renderer)

```javascript
// Listen for vault switch from main process
window.api.onVaultSwitched(async (data) => {
  // 1. Fade out content
  const content = document.getElementById('content');
  content.style.transition = 'opacity 0.2s';
  content.style.opacity = '0.3';

  // 2. Update logo state
  updateLogoMode('sound');
  document.getElementById('vault-dropdown').classList.remove('open');

  // 3. Restore last state
  if (data.lastState.collection) {
    currentCollection = data.lastState.collection;
    await loadCollections();
    await loadCollectionSounds();
  } else if (data.lastState.folder) {
    currentFolder = data.lastState.folder;
    await loadFolders();
    await loadSounds();
  } else {
    currentFolder = null;
    currentCollection = null;
    await loadFolders();
    await loadCollections();
  }

  // 4. Restore scroll position
  document.getElementById('sound-list').scrollTop = data.lastState.scrollTop || 0;

  // 5. Fade in
  requestAnimationFrame(() => {
    content.style.opacity = '1';
  });
});

// Persist state before switching away
async function persistCurrentVaultState() {
  await window.api.saveVaultState({
    folder: currentFolder,
    collection: currentCollection,
    scrollTop: document.getElementById('sound-list').scrollTop
  });
}
```

---

## Phase 4 (Future): Cross-Vault Search

### Architecture:

- Toggle in search bar: "All Vaults" mode
- Main process opens all registered Vault DBs in read-only mode
- Loads each `_matrix` into a `Map<vaultId, Float32Array>`
- Executes `_searchFlat` against each matrix in parallel
- Merges results sorted by score (scores are directly comparable, same CLAP space, L2-normalized)
- Results include `vaultId` + `vaultColor` for badge rendering in UI
- Memory: 70k files × 2KB = 140MB per vault, acceptable for 2-3 concurrent vault matrices

### IPC:

```javascript
ipcMain.handle('semantic-search-global', async (_, queryText) => {
  // Implementation deferred to Phase 4
});
```

---

## Summary of New Dependencies

| Dependency | Purpose | Phase |
|---|---|---|
| `chokidar` | Filesystem watching for live indexing | Phase 3 |
| `crypto` (built-in) | UUID generation for vault IDs | Phase 1 |

No other new dependencies. The system remains vanilla JS + Electron.

---

## File Change Summary

| File | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| `main.js` | Config migration, vault IPC handlers, `switchVault()` | `semantic-suggest` IPC | Filesystem watcher, index queue |
| `semantic-engine.js` | `switchDatabase()` method | (uses existing `_searchFlat`) | (no changes) |
| `preload.js` | 7 new vault API methods | `semanticSuggest` | `onSoundAdded`, `onSoundRemoved` |
| `index.html` | Logo rewrite, vault dropdown, CSS states | Scope pill, related dropdown | Vault switch animation, watcher listeners |
| `package.json` | (no changes) | (no changes) | Add `chokidar` |
