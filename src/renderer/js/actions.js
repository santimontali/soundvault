// User actions: context menus and the dialog flows behind them.
// Every destructive operation goes to the Recycle Bin and says so.
import { h, icon, count, stripExt, baseName } from './util.js';
import { state, bus, activeVault } from './store.js';
import { confirmDialog, promptDialog, pickDialog, modal, showMenu, toast } from './ui/overlays.js';
import { list } from './ui/list.js';
import { player, forget } from './audio/engine.js';
import { dropPeaks } from './audio/peaks.js';
import { selection } from './ui/selection.js';

const sv = window.sv;
export const PALETTE = ['#c8f76d', '#6ee7a0', '#5eead4', '#7eb8e0', '#6d8af7', '#c084fc', '#f76dbb', '#f97066', '#f79e6d', '#fbbf24', '#e0ddd5', '#94a3b8'];
const plural = (n, one) => count(n, one);

// ── collections ────────────────────────────────────────────────────────
export async function refreshCollections() {
    state.collections = await sv.collections.list();
    state.vaults = await sv.vaults.list();
    bus.emit('collections', state.collections);
    bus.emit('vaults', state.vaults);
}

export async function newCollection(initialItems = null) {
    const name = await promptDialog({ title: 'New collection', label: 'Name', placeholder: 'e.g. Gravel footsteps', confirm: 'Create' });
    if (!name) return null;
    const res = await sv.collections.create(name);
    if (!res.ok) { toast(res.error, { kind: 'error' }); return null; }
    if (initialItems && initialItems.length) await sv.collections.add(res.name, initialItems.map(i => i.path));
    await refreshCollections();
    toast(initialItems && initialItems.length ? `Created “${res.name}” with ${plural(initialItems.length, 'sound')}` : `Created “${res.name}”`);
    return res.name;
}

/** Pick (or create) a collection and add `items` to it. Returns the collection name. */
export async function addToCollectionFlow(items, title = 'Add to collection') {
    if (!items.length) return null;
    const picked = await pickDialog({
        title: items.length > 1 ? `${title} (${items.length} sounds)` : title,
        items: state.collections.map(c => ({ label: c.name, value: c.name, color: c.color, count: c.count })),
        create: 'New collection',
    });
    if (!picked) return null;
    let name = picked;
    if (typeof picked === 'object') {
        const res = await sv.collections.create(picked.create);
        if (!res.ok) { toast(res.error, { kind: 'error' }); return null; }
        name = res.name;
    }
    await addToCollection(name, items);
    return name;
}

export async function addToCollection(name, items) {
    const n = await sv.collections.add(name, items.map(i => i.path));
    await refreshCollections();
    if (n) toast(items.length === 1 ? `Added “${stripExt(items[0].name)}” to ${name}` : `Added ${plural(n, 'sound')} to ${name}`);
    else toast(items.length === 1 ? `Already in ${name}` : `All already in ${name}`, { icon: 'info' });
    return n;
}

export async function removeFromCollection(name, items) {
    await sv.collections.removeItems(name, items.map(i => i.path));
    await refreshCollections();
    list.removePaths(items.map(i => i.path));
    toast(`Removed ${items.length === 1 ? '“' + stripExt(items[0].name) + '”' : plural(items.length, 'sound')} from ${name}`, {
        action: { label: 'Undo', onClick: async () => { await sv.collections.add(name, items.map(i => i.path)); await refreshCollections(); bus.emit('view:reload'); } },
    });
}

/** The collection's menu: at a point (right-click) or under its "…" button (which then toggles it). */
export function collectionMenu({ name, x, y, anchor = null }) {
    showMenu(anchor || { x, y }, [
        { label: 'Open', icon: 'collection', onClick: () => bus.emit('nav:collection', name) },
        { label: 'Collect into this', icon: 'collection-plus', kbd: 'C', onClick: () => bus.emit('collect:set', name) },
        'sep',
        { label: 'Rename…', icon: 'pencil', onClick: () => renameCollection(name) },
        { label: 'Color…', color: (state.collections.find(c => c.name === name) || {}).color || '', onClick: () => colorDialog(name) },
        'sep',
        { label: 'Delete collection…', icon: 'trash', danger: true, onClick: () => deleteCollection(name) },
    ]);
}

export async function renameCollection(name) {
    const n = await promptDialog({ title: 'Rename collection', label: 'Name', value: name, confirm: 'Rename' });
    if (!n || n === name) return;
    const res = await sv.collections.rename(name, n);
    if (!res.ok) return toast(res.error, { kind: 'error' });
    await refreshCollections();
    bus.emit('collection:renamed', { from: name, to: res.name });
}

export async function deleteCollection(name) {
    const c = state.collections.find(x => x.name === name);
    const ok = await confirmDialog({ title: `Delete “${name}”?`, message: `The collection is removed from this vault. Its ${plural(c ? c.count : 0, 'sound')} stay in your library.`, confirm: 'Delete collection', danger: true });
    if (!ok) return;
    const paths = await sv.collections.sounds(name).then(r => [...r.sounds.map(s => s.path), ...r.missing]).catch(() => []);
    const color = c && c.color;
    await sv.collections.remove(name);
    await refreshCollections();
    bus.emit('collection:deleted', name);
    toast(`Deleted “${name}”`, { action: { label: 'Undo', onClick: async () => { await sv.collections.create(name); if (paths.length) await sv.collections.add(name, paths); if (color) await sv.collections.setColor(name, color); await refreshCollections(); } } });
}

export async function colorDialog(name) {
    const c = state.collections.find(x => x.name === name);
    const cur = c ? c.color : '';
    const color = await modal({ title: `Color for “${name}”` }, close => ({
        body: h('div.swatches', {}, h('div.swatch.none' + (!cur ? '.on' : ''), { 'data-tip': 'No color', onclick: () => close('') }),
            ...PALETTE.map(p => h('div.swatch' + (p === cur ? '.on' : ''), { style: { background: p }, onclick: () => close(p) }))),
    }));
    if (color === undefined) return;
    await sv.collections.setColor(name, color);
    await refreshCollections();
}

// ── vaults ─────────────────────────────────────────────────────────────
export async function switchVault(id) {
    if (id === state.vaults.activeVaultId) return;
    await sv.vaults.switch(id);
    await refreshCollections();
    bus.emit('vault:switched');
}

export async function vaultDialog(v = null) {
    const isNew = !v;
    const res = await modal({ title: isNew ? 'New vault' : 'Edit vault', icon: 'vault' }, close => {
        const name = h('input.input', { type: 'text', placeholder: 'Project or game name', maxlength: '80' });
        name.value = v ? v.name : '';
        const desc = h('textarea.input', { placeholder: 'Intent, tonal direction, notes…', maxlength: '2000' });
        desc.value = v ? v.description || '' : '';
        let color = v ? v.color : PALETTE[0];
        const sw = h('div.swatches');
        const paint = () => sw.replaceChildren(...PALETTE.map(p => h('div.swatch' + (p === color ? '.on' : ''), { style: { background: p }, onclick: () => { color = p; paint(); } })));
        paint();
        const err = h('div.err');
        const submit = () => { if (!name.value.trim()) { err.textContent = 'Name is required'; name.focus(); return; } close({ name: name.value.trim(), description: desc.value.trim(), color }); };
        return {
            body: [h('div.field', {}, h('label', { text: 'Name' }), name), h('div.field', {}, h('label', { text: 'Description' }), desc), h('div.field', {}, h('label', { text: 'Color' }), sw), err],
            footer: [h('button.btn', { text: 'Cancel', onclick: () => close(null) }), h('button.btn.primary', { text: isNew ? 'Create vault' : 'Save', onclick: submit })],
            initialFocus: name, onEnter: submit,
        };
    });
    if (!res) return;
    if (isNew) { const id = await sv.vaults.create(res.name, res.color); if (res.description) await sv.vaults.update(id, { description: res.description }); await switchVault(id); }
    else { await sv.vaults.update(v.id, res); await refreshCollections(); bus.emit('vault:switched'); }
}

export async function deleteVault(v) {
    const ok = await confirmDialog({ title: `Delete vault “${v.name}”?`, message: `Its ${plural(v.collectionCount || 0, 'collection')} will be removed. Sound files are never deleted.`, confirm: 'Delete vault', danger: true });
    if (!ok) return;
    if (await sv.vaults.remove(v.id)) { await refreshCollections(); bus.emit('vault:switched'); toast(`Deleted vault “${v.name}”`); }
}

export const vaultHandlers = {
    switch: switchVault,
    create: () => vaultDialog(null),
    edit: () => vaultDialog(activeVault()),
    duplicate: async () => { const id = await sv.vaults.duplicate(state.vaults.activeVaultId); if (id) { await switchVault(id); toast('Vault duplicated'); } },
    remove: () => deleteVault(state.vaults.vaults.find(v => v.id === state.vaults.activeVaultId)),
};

// ── folders ────────────────────────────────────────────────────────────
export function folderMenu({ rel, name, isRoot, x, y }) {
    showMenu({ x, y }, [
        { label: 'Open', icon: 'folder', onClick: () => bus.emit('nav:folder', rel) },
        { label: 'New folder inside…', icon: 'folder-plus', onClick: () => newFolder(rel) },
        { label: 'Import sounds here…', icon: 'import', onClick: () => importDialog(rel) },
        { label: 'Show in Explorer', icon: 'reveal', onClick: () => sv.files.openFolder(rel) },
        'sep',
        { label: 'Rename…', icon: 'pencil', disabled: isRoot, onClick: () => renameFolder(rel, name) },
        { label: 'Move folder to Recycle Bin…', icon: 'trash', danger: true, disabled: isRoot, onClick: () => trashFolder(rel, name) },
    ]);
}

export async function newFolder(parentRel = '') {
    const name = await promptDialog({ title: parentRel ? `New folder in “${parentRel.split('/').pop()}”` : 'New folder', label: 'Name', confirm: 'Create' });
    if (!name) return;
    const res = await sv.files.mkdir(parentRel, name);
    if (!res.ok) return toast(res.error, { kind: 'error' });
    bus.emit('tree:reload');
    bus.emit('nav:folder', res.rel);
}

export async function renameFolder(rel, name) {
    const n = await promptDialog({ title: 'Rename folder', label: 'Name', value: name, confirm: 'Rename' });
    if (!n || n === name) return;
    const res = await sv.files.renameFolder(rel, n);
    if (!res.ok) return toast(res.error, { kind: 'error' });
    bus.emit('tree:reload');
    bus.emit('folder:renamed', { from: rel, to: res.rel });
    toast(`Renamed to “${n}” · collections updated`);
}

export async function trashFolder(rel, name) {
    const node = findNode(state.tree, rel);
    const ok = await confirmDialog({ title: `Move “${name}” to the Recycle Bin?`, message: `${plural(node ? node.count : 0, 'sound')} will be moved to the Recycle Bin. You can restore them from there.`, confirm: 'Move to Recycle Bin', danger: true });
    if (!ok) return;
    const res = await sv.files.trashFolder(rel);
    if (!res.ok) return toast(res.error, { kind: 'error' });
    for (const p of res.removed || []) { forget(p); dropPeaks(p); }
    bus.emit('tree:reload');
    bus.emit('folder:deleted', rel);
    toast(`Moved “${name}” to the Recycle Bin`);
}

function findNode(n, rel) {
    if (!n) return null;
    if (n.rel === rel) return n;
    for (const c of n.children || []) { const f = findNode(c, rel); if (f) return f; }
    return null;
}

// ── files ──────────────────────────────────────────────────────────────
export async function importDialog(targetRel = null) {
    const rel = targetRel ?? (state.view.kind === 'folder' ? state.view.folder : '');
    const res = await sv.files.importDialog(rel);
    if (res) reportImport(res, rel);
}

export async function importPaths(paths, rel) {
    const t = toast(`Importing ${plural(paths.length, 'item')}…`, { progress: 0, timeout: 0 });
    const off = sv.files.onProgress(p => { if (p.op === 'import') t.update(`Importing ${p.done} / ${p.total}…`, p.total ? p.done / p.total * 100 : 0); });
    try {
        const res = await sv.files.import(paths, rel);
        t.close();
        reportImport(res, rel);
        return res;
    } catch (e) { t.close(); toast('Import failed: ' + e.message, { kind: 'error' }); return null; }
    finally { off(); }
}

function reportImport(res, rel) {
    const n = res.imported.length, where = rel ? '“' + rel.split('/').pop() + '”' : 'the library';
    const extra = [res.renamed ? `${res.renamed} renamed to avoid overwriting` : '', res.skipped.length ? `${res.skipped.length} already there` : '', res.ignored ? `${res.ignored} non-WAV ignored` : '', res.failed.length ? `${res.failed.length} failed` : ''].filter(Boolean).join(' · ');
    if (!n && !res.failed.length) toast(extra ? `Nothing imported · ${extra}` : 'Nothing to import', { icon: 'info' });
    else toast(`Imported ${plural(n, 'sound')} into ${where}${extra ? ' · ' + extra : ''}`, { kind: res.failed.length ? 'warn' : undefined, timeout: 4000 });
}

export async function renameFile(item) {
    const n = await promptDialog({ title: 'Rename sound', label: 'Name', value: stripExt(item.name), confirm: 'Rename' });
    if (!n || n === stripExt(item.name)) return;
    const res = await sv.files.rename(item.path, n);
    if (!res.ok) return toast(res.error, { kind: 'error' });
    forget(item.path); dropPeaks(item.path);
    const next = { ...item, path: res.path, name: baseName(res.path) };
    list.patchItem(item.path, next);
    if (player.isCurrent(item.path)) player.sound = next;
    if (selection.isOn(item.path)) selection.clear();
    toast(`Renamed to “${stripExt(next.name)}”`);
}

export async function trashFiles(items) {
    if (!items.length) return;
    const one = items.length === 1;
    const ok = await confirmDialog({
        title: one ? `Move “${stripExt(items[0].name)}” to the Recycle Bin?` : `Move ${plural(items.length, 'sound')} to the Recycle Bin?`,
        message: 'You can restore files from the Recycle Bin. Collections keep their references and show them as missing.',
        confirm: 'Move to Recycle Bin', danger: true,
    });
    if (!ok) return;
    if (items.some(i => player.isCurrent(i.path))) player.stop();
    if (items.some(i => selection.isOn(i.path))) selection.clear();
    const res = await sv.files.trash(items.map(i => i.path));
    for (const p of res.removed) { forget(p); dropPeaks(p); }
    list.removePaths(res.removed);
    if (res.failed.length) toast(`${res.failed.length} could not be moved: ${res.failed[0].error}`, { kind: 'error', timeout: 6000 });
    else toast(one ? `Moved “${stripExt(items[0].name)}” to the Recycle Bin` : `Moved ${plural(res.removed.length, 'sound')} to the Recycle Bin`);
}

export async function moveFiles(items, targetRel = null) {
    let rel = targetRel;
    if (rel === null) {
        const folders = flattenTree(state.tree);
        const picked = await pickDialog({ title: items.length > 1 ? `Move ${items.length} sounds to…` : `Move “${stripExt(items[0].name)}” to…`, items: folders.map(f => ({ label: f.rel || '(library root)', value: f.rel, count: f.count })), placeholder: 'Filter folders…' });
        if (picked === undefined || picked === null || typeof picked === 'object') return;
        rel = picked;
    }
    const res = await sv.files.move(items.map(i => i.path), rel);
    for (const m of res.moves) { forget(m.from); dropPeaks(m.from); if (player.isCurrent(m.from)) player.stop(); }
    bus.emit('tree:reload');
    bus.emit('view:reload');
    if (res.failed.length) toast(`${res.failed.length} could not be moved: ${res.failed[0].error}`, { kind: 'error', timeout: 6000 });
    else if (res.moves.length) toast(`Moved ${plural(res.moves.length, 'sound')} to ${rel ? '“' + rel.split('/').pop() + '”' : 'the library root'} · collections updated`, {
        action: { label: 'Undo', onClick: () => undoMoves(res.moves) },
    });
}

/** Move files back to the folders they came from (grouped per original folder). */
async function undoMoves(moves) {
    const root = (state.library.root || '').replace(/[\\/]+$/, '');
    const groups = new Map();
    for (const m of moves) {
        const dir = m.from.slice(0, Math.max(m.from.lastIndexOf('\\'), m.from.lastIndexOf('/')));
        const rel = dir.length > root.length ? dir.slice(root.length + 1).replace(/\\/g, '/') : '';
        if (!groups.has(rel)) groups.set(rel, []);
        groups.get(rel).push(m.to);
    }
    for (const [rel, paths] of groups) await sv.files.move(paths, rel);
    bus.emit('tree:reload');
    bus.emit('view:reload');
    toast('Move undone');
}

function flattenTree(n, out = []) {
    if (!n) return out;
    out.push({ rel: n.rel, count: n.count });
    for (const c of n.children || []) flattenTree(c, out);
    return out;
}

// ── vault brief ─────────────────────────────────────────────────────────
/** Append library sounds to the active vault's Brief as reference sounds. */
export async function addBriefRefs(items) {
    const b = await sv.brief.get();
    const have = new Set(b.refs.map(r => r.path.toLowerCase()));
    const add = items.filter(i => !i.external && !have.has(i.path.toLowerCase()));
    if (!add.length) return toast(items.length === 1 ? 'Already a reference in the Brief' : 'Already references in the Brief', { icon: 'info' });
    const room = 24 - b.refs.length;
    if (room <= 0) return toast('A brief holds up to 24 reference sounds', { icon: 'info' });
    const next = await sv.brief.update({ refs: [...b.refs.filter(r => !r.missing).map(r => r.path), ...add.slice(0, room).map(i => i.path)] });
    bus.emit('brief:changed', next);
    const n = Math.min(add.length, room), v = activeVault();
    const where = v ? `the ${v.name} Brief` : 'the Brief';
    toast(n === 1 ? `Added “${stripExt(add[0].name)}” to ${where}` : `Added ${plural(n, 'reference')} to ${where}`,
        { action: state.view.kind === 'brief' ? undefined : { label: 'Open Brief', onClick: () => bus.emit('nav:brief', { suggest: true }) } });
}

// ── row context menu ────────────────────────────────────────────────────
export function rowMenu({ item, items, x, y }) {
    const multi = items.length > 1;
    const inCollection = state.view.kind === 'collection';
    const cols = state.collections;
    const recent = cols.slice(0, 6);
    const local = items.filter(i => !i.external);
    showMenu({ x, y }, [
        multi ? { header: `${items.length} sounds` } : null,
        !multi ? { label: player.isCurrent(item.path) && player.playing ? 'Pause' : 'Play', icon: player.isCurrent(item.path) && player.playing ? 'pause' : 'play', kbd: 'Space', onClick: () => bus.emit('list:toggle-item', item) } : null,
        !multi ? { label: 'Echo: find similar', icon: 'echo', kbd: 'Ctrl+E', onClick: () => bus.emit('echo:file', item) } : null,
        'sep',
        { label: multi ? `Add ${items.length} to collection…` : 'Add to collection…', icon: 'collection-plus', kbd: 'C', onClick: () => addToCollectionFlow(items) },
        ...(recent.length && !multi ? recent.map(c => ({ label: c.name, color: c.color || '', onClick: () => addToCollection(c.name, items) })) : []),
        inCollection ? { label: `Remove from “${state.view.collection}”`, icon: 'x', onClick: () => removeFromCollection(state.view.collection, items) } : null,
        local.length ? { label: local.length > 1 ? `Use ${local.length} as Brief references` : 'Use as Brief reference', icon: 'board', onClick: () => addBriefRefs(local) } : null,
        'sep',
        !multi && !item.external ? { label: 'Show in library folder', icon: 'folder', onClick: () => bus.emit('locate', item) } : null,
        !multi ? { label: 'Show in Explorer', icon: 'reveal', onClick: () => sv.files.reveal(item.path) } : null,
        !multi && !item.external ? { label: 'Rename…', icon: 'pencil', kbd: 'F2', onClick: () => renameFile(item) } : null,
        !items.some(i => i.external) ? { label: multi ? 'Move to folder…' : 'Move to folder…', icon: 'move', onClick: () => moveFiles(items) } : null,
        { label: 'Copy path', icon: 'collection', onClick: () => { navigator.clipboard.writeText(items.map(i => i.path).join('\n')); toast(multi ? 'Paths copied' : 'Path copied'); } },
        'sep',
        !items.some(i => i.external) ? { label: 'Move to Recycle Bin…', icon: 'trash', kbd: 'Del', danger: true, onClick: () => trashFiles(items) } : null,
    ].filter(x => x !== null));
}
