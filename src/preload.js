'use strict';
// SoundVault preload: the only bridge between the sandboxed renderer and the
// main process. Namespaced, promise-based API plus push events (no polling).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = channel => cb => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('sv', {
    platform: process.platform,
    /** Absolute path of a dropped File (Electron ≥32 removed File.path). */
    pathForFile: f => { try { return webUtils.getPathForFile(f) || ''; } catch (e) { return ''; } },

    app: {
        info: () => invoke('app:info'),
        onToast: subscribe('app:toast'),
    },
    settings: {
        get: () => invoke('settings:get'),
        set: patch => invoke('settings:set', patch),
        chooseLibrary: () => invoke('settings:choose-library'),
        chooseRendersDir: () => invoke('settings:choose-renders-dir'),
        openFolder: which => invoke('settings:open-folder', which),
        onChanged: subscribe('settings:changed'),
    },
    library: {
        status: () => invoke('library:status'),
        tree: () => invoke('library:tree'),
        list: opts => invoke('library:list', opts),
        search: opts => invoke('library:search', opts),
        resolve: paths => invoke('library:resolve', paths),
        rescan: () => invoke('library:rescan'),
        onChanged: subscribe('library:changed'),
        onProgress: subscribe('library:progress'),
    },
    files: {
        import: (paths, targetRel) => invoke('files:import', paths, targetRel),
        importDialog: targetRel => invoke('files:import-dialog', targetRel),
        move: (paths, targetRel) => invoke('files:move', paths, targetRel),
        rename: (path, newName) => invoke('files:rename', path, newName),
        trash: paths => invoke('files:trash', paths),
        mkdir: (parentRel, name) => invoke('files:mkdir', parentRel, name),
        renameFolder: (rel, name) => invoke('files:rename-folder', rel, name),
        trashFolder: rel => invoke('files:trash-folder', rel),
        reveal: path => invoke('files:reveal', path),
        openFolder: rel => invoke('files:open-folder', rel),
        onProgress: subscribe('files:progress'),
    },
    audio: {
        peaks: items => invoke('audio:peaks', items),
        render: opts => invoke('audio:render', opts),
        saveToLibrary: opts => invoke('audio:save-to-library', opts),
        url: path => 'soundvault://audio/?path=' + encodeURIComponent(path),
    },
    drag: {
        start: (paths, icon) => ipcRenderer.send('drag:start', { paths: Array.isArray(paths) ? paths : [paths], icon: icon || null }),
    },
    vaults: {
        list: () => invoke('vaults:list'),
        create: (name, color) => invoke('vaults:create', name, color),
        switch: id => invoke('vaults:switch', id),
        update: (id, patch) => invoke('vaults:update', id, patch),
        remove: id => invoke('vaults:remove', id),
        duplicate: id => invoke('vaults:duplicate', id),
    },
    collections: {
        list: () => invoke('collections:list'),
        create: name => invoke('collections:create', name),
        rename: (oldName, newName) => invoke('collections:rename', oldName, newName),
        remove: name => invoke('collections:remove', name),
        setColor: (name, color) => invoke('collections:set-color', name, color),
        add: (name, paths) => invoke('collections:add', name, paths),
        removeItems: (name, paths) => invoke('collections:remove-items', name, paths),
        sounds: name => invoke('collections:sounds', name),
        onChanged: subscribe('collections:changed'),
    },
    engine: {
        status: () => invoke('engine:status'),
        onStatus: subscribe('engine:status'),
        index: opts => invoke('engine:index', opts || {}),
        failures: () => invoke('engine:failures'),
        cancelIndex: () => invoke('engine:cancel-index'),
        search: (query, opts) => invoke('engine:search', query, opts),
        suggest: (name, limit) => invoke('engine:suggest', name, limit),
        echo: params => invoke('engine:echo', params),
        echoFile: (path, opts) => invoke('engine:echo-file', path, opts),
    },
});
