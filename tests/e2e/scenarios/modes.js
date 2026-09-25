'use strict';
// Mode switch, title bar and vault colors on the fixture library (real app,
// isolated userData, trusted input):
//  • the brand morph never waits for loading: the content area shows stand-in
//    rows (Sound) or cards (the vault's home) at once, the real content lands
//    only after the morph, and no long task runs while the mark moves (both
//    directions, several times);
//  • the brand's hitbox hugs the mark and the word, the rest of the left block
//    drags the window;
//  • Vault mode takes the interface color from the vault (a usable tint: a red
//    vault stays clear of the danger red, a dark one is lifted), Sound mode keeps
//    the global accent, canvases re-tint only when the color changes, at once.
// Screenshots: a frame mid-switch, the title bar hitbox at 1280 and 1440, a red
// and a dark vault.
const { T, checker } = require('../editor-helpers');

// OKLab distance and WCAG contrast, to judge the colors independently of theme.js
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = hex => { const n = parseInt(String(hex).trim().slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function oklab(hex) {
    const [r, g, b] = rgb(hex).map(v => lin(v / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
const dist = (a, b) => { const p = oklab(a), q = oklab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const hue = hex => { const [, a, b] = oklab(hex); return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360; };
const lum = hex => { const [r, g, b] = rgb(hex).map(v => lin(v / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

module.exports = async (ctx) => {
    const { check, done } = checker(ctx);
    const shot = async name => { ctx.wc.invalidate(); await ctx.wait(160); return ctx.shot(name); };
    await ctx.waitFor(() => !document.getElementById('splash'), 60000, 'splash gone');
    ctx.wc.focus();
    await ctx.exec(async () => { (await import('./js/audio/engine.js')).setVolume(0); return true; });
    // A vault with collections, so its home has a grid to bring back after each switch.
    await ctx.exec(async () => {
        const all = await window.sv.library.list({ folder: '' });
        const groups = [['Rain', /rain|dur_\d+s/i], ['Kicks', /kick/i], ['Whooshes', /whoosh/i], ['Metal', /metal/i], ['Beeps', /beep/i], ['Clicks', /click/i], ['Families', /^fam/i], ['Footsteps', /step|foot/i]];
        for (const [name, re] of groups) { await window.sv.collections.create(name); await window.sv.collections.add(name, all.filter(x => re.test(x.name)).slice(0, 8).map(x => x.path)); }
        await (await import('./js/actions.js')).refreshCollections();
        return true;
    });
    await ctx.waitFor(() => document.querySelectorAll('.cols > .col').length === 8, 8000, 'collections grid');
    await ctx.wait(600);
    const css = () => ctx.exec(() => { const cs = getComputedStyle(document.documentElement); return { accent: cs.getPropertyValue('--accent').trim(), ink: cs.getPropertyValue('--accent-ink').trim(), mode: cs.getPropertyValue('--mode-color').trim(), danger: cs.getPropertyValue('--danger').trim(), bg: cs.getPropertyValue('--bg-1').trim() }; });
    const mode = () => ctx.exec(() => document.querySelector('.brand .word').textContent);

    // ── 1. Title bar: the brand hugs the mark and the word; the rest drags ──
    const tb = await ctx.exec(() => {
        const r = s => document.querySelector(s).getBoundingClientRect();
        const b = r('.brand'), l = r('.tb-left'), s = r('.search'), word = r('.brand .word-wrap');
        const x = Math.round((b.right + l.right) / 2), y = Math.round(b.top + b.height / 2);
        const hit = document.elementFromPoint(x, y);
        const region = sel => getComputedStyle(document.querySelector(sel)).getPropertyValue('-webkit-app-region');
        return { brand: { left: b.left, right: b.right, width: b.width }, wordRight: word.right, left: { right: l.right }, search: s.left, gap: { x, y }, hitIsDrag: !!hit && hit.classList.contains('tb-left'), regions: { left: region('.tb-left'), brand: region('.brand'), search: region('.search'), space: region('.drag-space') } };
    });
    check('the brand hitbox hugs the mark and the word (comfortable padding, far from the search)', tb.brand.width <= 130 && tb.brand.right - tb.wordRight >= 6 && tb.brand.right - tb.wordRight <= 16 && tb.search - tb.brand.right > 100, tb);
    check('the freed space drags the window; the brand and the search do not', tb.hitIsDrag && tb.regions.left === 'drag' && tb.regions.space === 'drag' && tb.regions.brand === 'no-drag' && tb.regions.search === 'no-drag', tb.regions);
    const m0 = await mode();
    await T.click(ctx, tb.gap.x, tb.gap.y);
    await ctx.wait(700);
    check('a click beside the brand does not switch modes', (await mode()) === m0, { before: m0, after: await mode() });
    const outline = () => ctx.exec(() => { const s = document.createElement('style'); s.id = 'hitbox-debug'; s.textContent = '.tb-left { background: repeating-linear-gradient(135deg, rgba(255,255,255,.05) 0 6px, transparent 6px 12px); } .drag-space { background: repeating-linear-gradient(135deg, rgba(255,255,255,.05) 0 6px, transparent 6px 12px); } .brand { outline: 1px dashed var(--accent); outline-offset: -1px; background: rgba(255,255,255,.04); }'; document.head.appendChild(s); return true; });
    await outline();
    await shot('01-titlebar-hitbox-1280');
    ctx.win.setContentSize(1440, 900); await ctx.wait(500);
    const tb1440 = await ctx.exec(() => { const b = document.querySelector('.brand').getBoundingClientRect(), s = document.querySelector('.search').getBoundingClientRect(); return { width: b.width, search: s.left }; });
    await shot('01b-titlebar-hitbox-1440');
    check('same hitbox at 1440 px, the search stays lined up with the content', tb1440.width === tb.brand.width && tb1440.search === tb.search, { tb1440, at1280: { width: tb.brand.width, search: tb.search } });
    ctx.win.setContentSize(1280, 800); await ctx.wait(500);
    await ctx.exec(() => { document.getElementById('hitbox-debug').remove(); return true; });

    // ── 2. Mode switches: stand-in at once, list after the morph, no long task while it moves ──
    const arm = () => ctx.exec(() => {
        window.__m = { lt: [], rows: null, cards: null, loadingSeen: false, cardsLoadingSeen: false, rowsDuring: 0, t0: performance.now(), frames: [] };
        const m = window.__m;
        m.po = new PerformanceObserver(l => { for (const e of l.getEntries()) m.lt.push({ at: Math.round(e.startTime - m.t0), d: Math.round(e.duration) }); });
        m.po.observe({ type: 'longtask' });
        const tick = t => {
            m.frames.push(t);
            const main = document.getElementById('main'), bv = document.querySelector('.bv');
            const standIn = !!bv && main.classList.contains('brief-on') && (bv.classList.contains('cols-loading') || bv.classList.contains('moving'));
            const cardsIn = !!bv && main.classList.contains('brief-on') && !standIn && document.querySelectorAll('.cols > .col').length > 3;
            if (t - m.t0 < 520) {
                if (main.classList.contains('loading')) m.loadingSeen = true;
                if (standIn && getComputedStyle(document.querySelector('.col-skel')).display !== 'none') m.cardsLoadingSeen = true;
                m.rowsDuring = Math.max(m.rowsDuring, document.querySelectorAll('.list .row:not([aria-hidden="true"])').length);
            }
            if (m.rows === null && !main.classList.contains('loading') && !main.classList.contains('brief-on') && document.querySelectorAll('.list .row:not([aria-hidden="true"])').length > 3) m.rows = Math.round(t - m.t0);
            if (m.cards === null && cardsIn) m.cards = Math.round(t - m.t0);
            if (t - m.t0 < 1800) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
    });
    const collect = () => ctx.exec(() => { const m = window.__m; m.po.disconnect(); const gaps = []; for (let i = 1; i < m.frames.length; i++) gaps.push(m.frames[i] - m.frames[i - 1]); return { lt: m.lt, rows: m.rows, cards: m.cards, loadingSeen: m.loadingSeen, cardsLoadingSeen: m.cardsLoadingSeen, rowsDuring: m.rowsDuring, worstGap: Math.round(Math.max(0, ...gaps.slice(0, 32))) }; });
    const runs = [];
    for (let i = 0; i < 4; i++) {
        const toSound = (await mode()) === 'Vault';
        // Before the first switch back, the vault gains a collection: its grid is stale and comes back after the morph.
        if (i === 1) await ctx.exec(async () => { const all = await window.sv.library.list({ folder: '' }); await window.sv.collections.create('Late'); await window.sv.collections.add('Late', all.slice(0, 3).map(x => x.path)); await (await import('./js/actions.js')).refreshCollections(); return true; });
        await arm();
        await T.key(ctx, 'Tab', ['control']);
        if (i < 2) {
            await ctx.wait(110);
            ctx.wc.invalidate();
            await ctx.shot(i === 0 ? '02-mid-switch-sound' : '02b-mid-switch-vault');
        }
        await ctx.waitFor(toSound ? () => document.querySelectorAll('.list .row:not([aria-hidden="true"])').length > 3 && !document.getElementById('main').classList.contains('loading') : () => !!document.querySelector('.main.brief-on'), 10000, 'switched');
        await ctx.wait(1900);
        const r = await collect();
        r.toSound = toSound;
        r.during = r.lt.filter(x => x.at < 540 && x.at + x.d > 0);
        runs.push(r);
        ctx.log('switch', i, JSON.stringify(r));
        if (i === 0) await shot('03-after-switch-sound');
        if (i === 1) await shot('03b-after-switch-vault');
    }
    const toSound = runs.filter(r => r.toSound), toVault = runs.filter(r => !r.toSound);
    check('switching to Sound mode shows the stand-in rows at once and no list rows while the mark moves', toSound.every(r => r.loadingSeen && r.rowsDuring === 0), toSound.map(r => ({ loading: r.loadingSeen, rows: r.rowsDuring })));
    check('the list lands after the morph (never during it)', toSound.every(r => r.rows !== null && r.rows >= 480), toSound.map(r => r.rows));
    const late = await ctx.exec(() => [...document.querySelectorAll('.cols > .col')].map(c => c.dataset.col));
    check('back in Vault mode the grid waits behind stand-in cards while the mark moves (however many), the cards come after', toVault.every(r => r.cardsLoadingSeen && r.cards !== null && r.cards >= 480), toVault.map(r => ({ standIn: r.cardsLoadingSeen, cards: r.cards })));
    check('a collection added while in Sound mode is in the grid when it comes back', late.includes('Late'), late);
    check('no long task while the mark morphs, in either direction', runs.every(r => r.during.length === 0), runs.map(r => r.during));
    const skel = await ctx.exec(() => ({ loading: document.getElementById('main').classList.contains('loading'), vis: getComputedStyle(document.querySelector('.skel')).visibility }));
    check('the stand-in is gone once the content is in', !skel.loading && skel.vis === 'hidden', skel);

    // ── 3. Colors: the vault drives the interface in Vault mode ────────────
    // A sound in the player, so the scrubber's accent copy can be checked too.
    if ((await mode()) !== 'Sound') { await T.key(ctx, 'Tab', ['control']); await ctx.wait(1400); }
    await ctx.exec(async () => { const { list } = await import('./js/ui/list.js'); const i = list.items.findIndex(x => /whoosh/i.test(x.name)); list.setCursor(i < 0 ? 0 : i, { play: true }); return true; });
    await ctx.waitFor(async () => { const { player } = await import('./js/audio/engine.js'); return player.playing; }, 8000, 'playing');
    await ctx.wait(700);
    await ctx.exec(async () => { const { player } = await import('./js/audio/engine.js'); player.pause(); return true; });
    await ctx.wait(200);
    // the accent copy of the scrubber: the RMS core is drawn in exactly the accent
    const scrubColor = () => ctx.exec(() => {
        const cv = document.querySelector('.scrub .track canvas.played'), c = cv.getContext('2d');
        const d = c.getImageData(0, 0, cv.width, cv.height).data, y = Math.floor(cv.height / 2);
        for (let x = 0; x < cv.width; x++) { const i = (y * cv.width + x) * 4; if (d[i + 3] === 255) return '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join(''); }
        return null;
    });
    const global = await ctx.exec(() => window.sv.settings.get().then(s => s.accentColor));
    const sound = await css();
    check('Sound mode keeps the global accent (and the scrubber is drawn in it)', sound.accent === global && (await scrubColor()) === global, { sound, global });
    const accentEvents = () => ctx.exec(async () => { const { bus } = await import('./js/store.js'); window.__acc = 0; if (!window.__accOff) window.__accOff = bus.on('accent', () => { window.__acc++; }); return true; });
    const setVaultColor = c => ctx.exec(async c => {
        const v = await window.sv.vaults.list(); await window.sv.vaults.update(v.activeVaultId, { color: c });
        const A = await import('./js/actions.js'); await A.refreshCollections();
        (await import('./js/theme.js')).refreshColors();
        return true;
    }, c);
    await accentEvents();
    // Back to Vault mode with a blue vault: everything follows at once.
    await setVaultColor('#6d8af7');
    await T.key(ctx, 'Tab', ['control']);
    const atOnce = await ctx.exec(() => { const cs = getComputedStyle(document.documentElement); const cv = document.querySelector('.scrub .track canvas.played'), c = cv.getContext('2d'), d = c.getImageData(0, 0, cv.width, cv.height).data, y = Math.floor(cv.height / 2); let px = null; for (let x = 0; x < cv.width && !px; x++) { const i = (y * cv.width + x) * 4; if (d[i + 3] === 255) px = '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join(''); } return { accent: cs.getPropertyValue('--accent').trim(), scrub: px, events: window.__acc }; });
    await ctx.wait(1400);
    check('in Vault mode the interface takes the vault color, the scrubber in the same task as the CSS', atOnce.accent !== global && dist(atOnce.accent, '#6d8af7') < 0.03 && atOnce.scrub === atOnce.accent && atOnce.events === 1, atOnce);
    const btn = await ctx.exec(() => { const s = document.querySelector('.big-play'); return getComputedStyle(s).backgroundColor; });
    const rgbStr = hex => `rgb(${rgb(hex).join(', ')})`;
    check('the play button follows the vault color', btn === rgbStr(atOnce.accent), { btn, accent: atOnce.accent });
    // Same color, other vault: nothing to re-tint.
    await accentEvents();
    const twin = await ctx.exec(async () => { const id = await window.sv.vaults.create('Twin', '#6d8af7'); const A = await import('./js/actions.js'); await A.switchVault(id); return id; });
    await ctx.wait(900);
    const twinEvents = await ctx.exec(() => window.__acc);
    check('switching to a vault of the same color re-tints nothing', twinEvents === 0, twinEvents);

    // A red vault: rose accent, clearly apart from danger; identity keeps the red.
    await accentEvents();
    await setVaultColor('#f97066');
    await ctx.wait(500);
    const red = await css();
    const redEvents = await ctx.exec(() => window.__acc);
    ctx.log('red vault', JSON.stringify(red), 'distance to danger', dist(red.accent, red.danger).toFixed(3));
    check('a red vault: the accent stays clear of the danger red, the identity keeps the red', dist(red.accent, red.danger) >= 0.1 && hueGap(hue(red.mode), hue('#f97066')) < 8 && redEvents === 1, { red, d: dist(red.accent, red.danger), redEvents });
    check('text on the red vault accent is readable', contrast(red.accent, red.ink) >= 4.5, contrast(red.accent, red.ink));
    await ctx.exec(() => { document.querySelector('.vault-switch').click(); return true; });
    await ctx.waitFor(() => [...document.querySelectorAll('.menu .mi.danger')].length > 0, 3000, 'vault menu');
    const dangerItem = await ctx.exec(() => getComputedStyle(document.querySelector('.menu .mi.danger')).color);
    check('destructive actions keep the danger red in a red vault', dangerItem === rgbStr(red.danger), { dangerItem, danger: red.danger });
    await shot('04-vault-red');
    await T.key(ctx, 'Escape');
    // A dark vault: lifted to a readable tint.
    await setVaultColor('#1f2a44');
    await ctx.wait(500);
    const dark = await css();
    check('a dark vault gets a readable tint (on the UI and under its ink)', contrast(dark.accent, dark.bg) >= 4.5 && contrast(dark.accent, dark.ink) >= 4.5 && hueGap(hue(dark.accent), hue('#1f2a44')) < 12, { dark, onBg: contrast(dark.accent, dark.bg), ink: contrast(dark.accent, dark.ink) });
    await shot('05-vault-dark');
    // Back to Sound mode: the global accent again.
    await T.key(ctx, 'Tab', ['control']);
    await ctx.wait(1400);
    const back = await css();
    check('Sound mode brings the global accent back', back.accent === global && (await scrubColor()) === global, back);
    await ctx.exec(async id => { const v = await window.sv.vaults.list(); const other = v.vaults.find(x => x.id !== id); const A = await import('./js/actions.js'); if (other) await A.switchVault(other.id); await window.sv.vaults.remove(id); await A.refreshCollections(); return true; }, twin);

    // ── 4. Menus: the button that opens one closes it; dialogs never show "null" ──
    const center = sel => ctx.exec(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, sel);
    const menuOpen = () => ctx.exec(() => !!document.querySelector('.menu'));
    const toggles = [];
    const toggle = async (label, sel) => {
        const p = await center(sel);
        if (!p) { toggles.push({ label, missing: true }); return; }
        await T.click(ctx, p.x, p.y); await ctx.wait(220);
        const opened = await menuOpen(), exp = await ctx.exec(s => document.querySelector(s).getAttribute('aria-expanded'), sel);
        await T.click(ctx, p.x, p.y); await ctx.wait(220);
        toggles.push({ label, opened, exp, closed: !(await menuOpen()), exp2: await ctx.exec(s => document.querySelector(s).getAttribute('aria-expanded'), sel) });
        if (await menuOpen()) { await T.key(ctx, 'Escape'); await ctx.wait(150); }
    };
    const nulls = () => ctx.exec(() => {
        const d = document.querySelector('.dialog');
        if (!d) return null;
        const w = document.createTreeWalker(d, NodeFilter.SHOW_TEXT), bad = [];
        while (w.nextNode()) if (/^(null|undefined)$/.test(w.currentNode.nodeValue.trim())) bad.push(w.currentNode.nodeValue);
        return { bad, title: (d.querySelector('.dlg-head h3') || {}).textContent };
    });
    const dialogs = [];
    const dialog = async (label, open) => {
        await open();
        const d = await ctx.waitFor(() => document.querySelector('.dialog') && true, 4000, label).then(() => nulls()).catch(() => null);
        dialogs.push({ label, ...(d || { missing: true }) });
        await T.key(ctx, 'Escape'); await ctx.wait(250);
        if (await ctx.exec(() => !!document.querySelector('.dialog'))) { await T.key(ctx, 'Escape'); await ctx.wait(200); }
    };
    if ((await mode()) !== 'Vault') { await T.key(ctx, '1', ['control']); await ctx.wait(1300); }
    await ctx.waitFor(() => document.querySelector('.main.brief-on') && document.querySelectorAll('.cols > .col').length > 3, 8000, 'home');
    await toggle('vault switcher', '.vault-switch');
    await toggle('search scope', '.search .scope');
    await toggle('vault options', '.bhead .head-actions .icon-btn');
    await dialog('color', () => ctx.exec(() => { document.querySelector('.node[data-kind="collection"] .col-color').click(); return true; }));
    await dialog('new collection', () => ctx.exec(() => { document.querySelector('.sb-head .icon-btn').click(); return true; }));
    await dialog('edit vault', async () => { const p = await center('.vault-switch'); await T.click(ctx, p.x, p.y); await ctx.wait(200); await ctx.exec(() => { [...document.querySelectorAll('.menu .mi')].find(m => m.textContent.startsWith('Edit vault')).click(); return true; }); });
    await dialog('settings', () => ctx.exec(() => { document.querySelector('.tb-right .icon-btn').click(); return true; }));
    // a collection's own menu, and a confirm dialog from it
    await ctx.exec(() => { document.querySelector('.node[data-kind="collection"]').click(); return true; });
    await ctx.waitFor(() => !document.querySelector('.main.brief-on') && document.querySelector('.panel-head [aria-label="Collection options"]'), 8000, 'collection open');
    await ctx.wait(700);
    await toggle('collection options', '.panel-head [aria-label="Collection options"]');
    await dialog('delete collection (confirm)', async () => { const p = await center('.panel-head [aria-label="Collection options"]'); await T.click(ctx, p.x, p.y); await ctx.wait(200); await ctx.exec(() => { [...document.querySelectorAll('.menu .mi')].find(m => m.textContent.startsWith('Delete collection')).click(); return true; }); });
    // Sound mode: the sort menu, and the collect picker (C on a sound)
    await T.key(ctx, '2', ['control']);
    await ctx.waitFor(() => document.querySelectorAll('.list .row:not([aria-hidden="true"])').length > 3 && !document.getElementById('main').classList.contains('loading'), 10000, 'sounds');
    await ctx.wait(400);
    await toggle('sort', '.panel-head .head-actions .btn');
    await dialog('collect into (C)', async () => { await ctx.exec(async () => { const { list } = await import('./js/ui/list.js'); list.el.focus(); list.setCursor(0, { play: false }); return true; }); await T.key(ctx, 'C'); });
    ctx.log('toggles', JSON.stringify(toggles));
    ctx.log('dialogs', JSON.stringify(dialogs));
    check('every menu button is a toggle: a second press closes its menu (aria-expanded follows)', toggles.length === 5 && toggles.every(t => t.opened && t.closed && t.exp === 'true' && t.exp2 === 'false'), toggles);
    check('no dialog shows "null" (collect, color, prompt, vault, confirm, settings)', dialogs.length === 6 && dialogs.every(d => !d.missing && d.bad.length === 0), dialogs);

    // ── 5. Collection cards are wells: darker than the page, a hairline carrying the color, no gradient ──
    await T.key(ctx, '1', ['control']);
    await ctx.wait(900);
    await ctx.exec(() => { document.querySelector('.brief-node').click(); return true; });        // the home (Vault mode reopened the last collection)
    await ctx.exec(async () => { const l = await window.sv.collections.list(); await window.sv.collections.setColor(l[0].name, '#f97066'); await (await import('./js/actions.js')).refreshCollections(); return true; });
    await ctx.waitFor(() => document.querySelector('.main.brief-on') && document.querySelectorAll('.cols > .col').length > 3 && !document.querySelector('.bv.cols-loading'), 8000, 'home again');
    await ctx.wait(500);
    const well = await ctx.exec(() => {
        const lum = c => { const m = c.match(/[\d.]+/g).map(Number); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
        const card = document.querySelector('.cols > .col'), cs = getComputedStyle(card), page = getComputedStyle(document.getElementById('main'));
        const n = cs.borderTopColor.match(/[\d.]+/g).map(Number), k = /^color\(/.test(cs.borderTopColor) ? 255 : 1;   // color-mix() computes to color(srgb r g b / a)
        const b = n.slice(0, 3).map(v => v * k);
        return { card: lum(cs.backgroundColor), page: lum(page.backgroundColor), image: cs.backgroundImage, shadow: cs.boxShadow, border: cs.borderTopColor, redTrace: b[0] > b[1] + 20 && b[0] > b[2] + 20 };
    });
    check('collection cards are wells: darker than the page, no gradient, a soft inner shadow, the red trace in the hairline', well.card < well.page && well.image === 'none' && /inset/.test(well.shadow) && well.redTrace, well);
    await shot('06-cards-wells');

    const errors = ctx.report.console.filter(m => m.level === 3 || m.level === 'error').map(m => m.message);
    check('no renderer errors', errors.length === 0, errors.slice(0, 5));
    done();
};
