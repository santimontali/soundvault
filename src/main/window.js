'use strict';
/**
 * Main window: custom titlebar with native Windows controls (Window Controls
 * Overlay), no default menu bar, restored size/position, no white flash.
 */
const path = require('path');
const { BrowserWindow, Menu, screen } = require('electron');

const TITLEBAR_HEIGHT = 44;
const COLORS = { bg: '#0e0e11', symbol: '#a4a2ab' };

function clampBounds(b) {
    if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
    // Keep the window on a connected display (monitor may have been unplugged)
    const displays = screen.getAllDisplays();
    const visible = displays.some(d => {
        const a = d.workArea;
        return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 60;
    });
    return visible ? b : { width: b.width, height: b.height };
}

/**
 * @param {object} o
 * @param {string} o.preload
 * @param {string} o.indexHtml
 * @param {object} [o.state] persisted { bounds, maximized }
 * @param {(state:object)=>void} [o.onStateChange]
 * @param {string} [o.icon]
 */
function createMainWindow(o) {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    const saved = clampBounds(o.state && o.state.bounds);
    const win = new BrowserWindow({
        width: saved?.width || 1280, height: saved?.height || 800,
        x: saved?.x, y: saved?.y,
        minWidth: 900, minHeight: 560,
        show: false,
        backgroundColor: COLORS.bg,
        title: 'SoundVault',
        icon: o.icon,
        titleBarStyle: 'hidden',
        titleBarOverlay: process.platform === 'darwin' ? undefined : { color: COLORS.bg, symbolColor: COLORS.symbol, height: TITLEBAR_HEIGHT },
        trafficLightPosition: { x: 14, y: 14 },
        webPreferences: {
            preload: o.preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            backgroundThrottling: false,
        },
    });
    if (o.state && o.state.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.loadFile(o.indexHtml);

    // Block navigation away from the app and new windows (drag&drop of a file
    // onto the window would otherwise navigate to it).
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    let t = null;
    const persist = () => {
        clearTimeout(t);
        t = setTimeout(() => {
            if (win.isDestroyed()) return;
            const maximized = win.isMaximized();
            const bounds = maximized || win.isMinimized() ? (o.state && o.state.bounds) : win.getBounds();
            o.onStateChange && o.onStateChange({ bounds, maximized });
        }, 400);
    };
    win.on('resize', persist);
    win.on('move', persist);
    win.on('maximize', persist);
    win.on('unmaximize', persist);
    win.on('close', () => { clearTimeout(t); if (!win.isDestroyed()) o.onStateChange && o.onStateChange({ bounds: win.isMaximized() ? (o.state && o.state.bounds) : win.getBounds(), maximized: win.isMaximized() }); });
    return win;
}

/** Keep the native caption buttons in sync with the accent/theme if needed. */
function setOverlayColors(win, colors) {
    if (process.platform === 'darwin' || !win || win.isDestroyed()) return;
    try { win.setTitleBarOverlay({ color: colors.bg || COLORS.bg, symbolColor: colors.symbol || COLORS.symbol, height: TITLEBAR_HEIGHT }); } catch (e) { /* older OS */ }
}

module.exports = { createMainWindow, setOverlayColors, TITLEBAR_HEIGHT, COLORS };
