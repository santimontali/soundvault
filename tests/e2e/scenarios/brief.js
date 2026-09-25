'use strict';
// Vault Brief end to end on the fixture library (real app, isolated userData):
// the vault's home shows its collections and never suggests on its own (the
// suggestion and "more" requests are counted in the main process); the calm
// empty vault; the suggestions opened on demand: words typed in the real field
// (trusted keys), cards once the catalog is done, Create collection (sidebar,
// the home's grid, sounds, card gone), Dismiss (still dismissed after reopening
// the Brief), the Review sheet driven by the keyboard, the "no strong matches"
// line, a reference from the row menu, images through the paste and drop paths,
// "Use image colors"; then the collections grid: hiding the suggestions stops
// them, a card auditions its sounds, "Find more" goes through the review sheet
// and grows the collection, a click opens it.
// Screenshots of every state at 1280x800 and a few at 1440x900.
// The fixture's rain files are near-identical takes, so the engine keeps one of
// them and fills the card with other rain-like sounds (the dur_* files are
// rain noise too); other words may legitimately give no card.
const { ipcMain } = require('electron');
const { T, checker } = require('../editor-helpers');

const RAINY = /^rain_|^dur_\d+s/i;

module.exports = async (ctx) => {
    const { check, done } = checker(ctx);
    const t0 = Date.now();

    // Count the suggestion requests in the main process (nothing may ask unless the user did).
    const asked = { suggest: 0, more: [] };
    const H = ipcMain._invokeHandlers;
    const counting = !!(H && H.get('brief:suggest') && H.get('brief:more'));
    if (counting) {
        const s = H.get('brief:suggest'), m = H.get('brief:more');
        H.set('brief:suggest', (e, ...a) => { asked.suggest++; return s(e, ...a); });
        H.set('brief:more', (e, ...a) => { asked.more.push((a[0] && a[0].name) || '*'); return m(e, ...a); });
    } else ctx.log('ipcMain handlers not reachable: request counts are not checked');

    // ── helpers ─────────────────────────────────────────────────────────
    const shot = async name => { ctx.wc.invalidate(); await ctx.wait(160); return ctx.shot(name); };
    const center = async (fn, ...args) => {
        const r = await ctx.exec(`(() => { const e = (${fn})(...${JSON.stringify(args)}); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const b = e.getBoundingClientRect(); return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`);
        if (r) await ctx.wait(120);
        return r;
    };
    const clickOn = async (label, fn, ...args) => {
        const p = await center(fn, ...args);
        if (!p) throw new Error('nothing to click: ' + label);
        await T.click(ctx, p.x, p.y);
        return p;
    };
    const typeText = async text => { for (const ch of text) await T.key(ctx, ch === ' ' ? 'Space' : ch); };
    const cards = () => ctx.exec(() => [...document.querySelectorAll('.cards > .card:not(.leaving)')].map(c => ({ key: c.dataset.key, title: c.querySelector('h3').textContent, n: c._card.candidates.length, names: c._card.candidates.map(x => x.name) })));
    const cardBtn = () => (k, a) => { const c = [...document.querySelectorAll('.cards > .card:not(.leaving)')].find(e => e.dataset.key === k); return c && c.querySelector(`[data-act="${a}"]`); };
    const colCard = () => n => [...document.querySelectorAll('.cols > .col')].find(e => e.dataset.col === n);
    const grid = () => ctx.exec(() => [...document.querySelectorAll('.cols > .col')].map(c => ({ name: c.dataset.col, count: c.querySelector('.c-count').textContent, rows: c.querySelectorAll('.c-row').length })));
    const until = async (fn, args, ms, label) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            try { const v = await ctx.exec(fn, ...args); if (v) return v; } catch (e) { /* keep polling */ }
            await ctx.wait(150);
        }
        throw new Error('timeout: ' + label);
    };
    const settle = () => ctx.waitFor(() => { const s = document.querySelector('.bv .sec-head h2 .i'); return s && !s.classList.contains('listening') && !document.querySelector('.cards.pending'); }, 30000, 'suggestions settled');
    const stopPlayer = () => ctx.exec(async () => { const { player } = await import('./js/audio/engine.js'); player.stop(); return true; });
    const playerState = () => ctx.exec(async () => { const { player } = await import('./js/audio/engine.js'); return { sound: player.sound && player.sound.name, playing: player.playing || player.loading }; });

    await ctx.waitFor(() => !document.getElementById('splash'), 60000, 'splash gone');
    ctx.wc.focus();
    await ctx.exec(async () => { (await import('./js/audio/engine.js')).setVolume(0); return true; });
    const autoPlay = await ctx.exec(() => window.sv.settings.get().then(s => !!s.autoPlay));

    // ── 1. A new vault opens on its home: no collections, a calm offer, nothing suggested ──
    const home = await ctx.waitFor(() => document.querySelector('.main.brief-on .cols-empty:not(.hidden)') && {
        mode: document.querySelector('.brand .word').textContent,
        briefNode: !!document.querySelector('.brief-node.active'),
        nodeCount: !!document.querySelector('.brief-node .cnt'),
        open: document.querySelector('.bv').classList.contains('open'),
        suggestShown: !!(document.querySelector('.suggest') && document.querySelector('.suggest').offsetParent),
        toggle: (t => t && { text: t.textContent, expanded: t.getAttribute('aria-expanded') })(document.querySelector('.bhead .suggest-toggle')),
        emptyActions: [...document.querySelectorAll('.cols-empty .actions .btn')].map(b => b.textContent),
        moving: document.querySelectorAll('.cols-empty [class*="shim"], .cols-empty .gcard').length,
        header: document.querySelector('.bhead h1').textContent,
        headText: document.querySelector('.bhead').textContent,
    }, 20000, 'empty vault home');
    check('a new vault opens on its home: no collections, "New collection" and "Start from a brief", nothing moving', home.mode === 'Vault' && home.briefNode && !home.open && !home.suggestShown && home.emptyActions.join() === 'New collection,Start from a brief' && home.moving === 0 && !/null|undefined/.test(home.headText), home);
    check('the Brief node carries no suggestion count, the header offers "Suggest collections"', !home.nodeCount && home.toggle && home.toggle.text === 'Suggest collections' && home.toggle.expanded === 'false', home);
    const leak = await ctx.exec(() => { const w = document.querySelector('.search .words'); return w ? getComputedStyle(w).borderTopWidth : 'none'; });
    check('Brief styles do not leak into the title bar search', leak === '0px' || leak === 'none', leak);
    await shot('01-empty-vault');
    ctx.win.setContentSize(1440, 900); await ctx.wait(500);
    await shot('01b-empty-vault-1440');
    ctx.win.setContentSize(1280, 800); await ctx.wait(500);

    // The one-line description is edited in place (the suggestions stay closed).
    await clickOn('description', () => document.querySelector('.bhead .desc'));
    await ctx.waitFor(() => document.activeElement && document.activeElement.matches('.bhead .desc.editing input'), 3000, 'description editor');
    await typeText('Close, wet, 1890s.');
    await T.key(ctx, 'Enter');
    const desc = await ctx.waitFor(async () => {
        const v = await window.sv.vaults.list();
        const d = v.vaults.find(x => x.id === v.activeVaultId).description;
        const shown = document.querySelector('.bhead .desc .dt');
        return d && shown && { saved: d, shown: shown.textContent };
    }, 5000, 'description saved');
    check('the one-line description is edited in place and saved on the vault', desc.saved === 'Close, wet, 1890s.' && desc.shown === desc.saved, desc);
    await ctx.wait(1500);
    if (counting) check('nothing asked Resonance for suggestions while the home was shown', asked.suggest === 0 && asked.more.length === 0, asked);

    // ── 2. Suggestions on demand: the brief opens, words through the real field ──
    await clickOn('Start from a brief', () => [...document.querySelectorAll('.cols-empty .btn')].find(b => b.textContent === 'Start from a brief'));
    const opened = await ctx.waitFor(() => document.querySelector('.bv.open .ezone') && {
        expanded: document.querySelector('.bhead .suggest-toggle').getAttribute('aria-expanded'),
        text: document.querySelector('.bhead .suggest-toggle').textContent,
        ghosts: document.querySelectorAll('.ghost-cards .gcard').length,
        examples: [...document.querySelectorAll('.ez-try .ex')].map(b => b.textContent),
        compact: !!document.querySelector('.cols-empty.compact'),
    }, 5000, 'brief opened');
    check('"Start from a brief" opens the brief with its examples; the toggle reads "Hide suggestions"', opened.expanded === 'true' && opened.text === 'Hide suggestions' && opened.ghosts === 3 && opened.examples.length === 3 && opened.compact, opened);
    await clickOn('words field', () => document.querySelector('.ez-field input'));
    await typeText('rain');
    await T.key(ctx, 'Enter');
    const afterFirst = await ctx.waitFor(() => document.querySelector('.brief .words .cc') && {
        chips: [...document.querySelectorAll('.brief .words .cc')].map(c => c.textContent),
        focused: !!(document.activeElement && document.activeElement.classList.contains('words-in')),
    }, 5000, 'first chip');
    check('Enter turns the typed word into a chip and keeps the focus in the field', afterFirst.chips.join() === 'rain' && afterFirst.focused, afterFirst);
    await ctx.wait(500);
    const early = await ctx.exec(() => ({ sub: document.querySelector('.bv .suggest .sec-head .sub').textContent, empty: document.querySelector('.cards-empty').textContent, ghosts: !document.querySelector('.ghost-cards').classList.contains('hidden') }));
    ctx.log('while the library is analysed:', JSON.stringify(early));
    check('before the library is analysed the Brief waits calmly (no "nothing to suggest")', !/Nothing/.test(early.empty) && !/null/.test(early.sub + early.empty), early);
    await shot('02-first-word');
    await typeText('whoosh');
    await T.key(ctx, 'Enter');
    await ctx.waitFor(() => document.querySelectorAll('.brief .words .cc').length === 2, 5000, 'second chip');
    const saved = await ctx.exec(() => window.sv.brief.get());
    check('words are saved in the vault brief', JSON.stringify(saved.words) === JSON.stringify(['rain', 'whoosh']), saved.words);

    // ── 3. Suggestions once Resonance has listened to the library ───────
    await ctx.waitFor(() => window.sv.engine.status().then(s => s.ready), 120000, 'engine ready');
    const tIdx = Date.now();
    let sawIndexing = false;
    while (Date.now() - tIdx < 600000) {
        const st = await ctx.exec(() => window.sv.engine.status());
        if (st.indexing) sawIndexing = true;
        if (sawIndexing && !st.indexing && st.progress && st.progress.phase === 'done') break;
        if (!sawIndexing && Date.now() - tIdx > 20000 && st.vectors > 0) break;
        await ctx.wait(1000);
    }
    ctx.log('catalog done in', Math.round((Date.now() - tIdx) / 1000), 's');
    await ctx.waitFor(() => [...document.querySelectorAll('.cards > .card')].some(c => c.dataset.key === 'w:rain'), 60000, 'rain card');
    await settle();
    let list = await cards();
    ctx.log('cards', JSON.stringify(list.map(c => `${c.title} (${c.n}): ${c.names.slice(0, 5).join(', ')}`)));
    const rain = list.find(c => c.key === 'w:rain');
    check('a "rain" card suggests rain sounds (a rain file first)', rain && /^rain_/i.test(rain.names[0]) && rain.names.every(n => RAINY.test(n)), rain && rain.names);
    const visibleUnmatched = () => ctx.exec(() => [...document.querySelectorAll('.bv .unmatched .um')].filter(b => b.offsetParent).map(b => b.textContent));
    let unmatched = await visibleUnmatched();
    ctx.log('unmatched', JSON.stringify(unmatched), 'whoosh card:', list.some(c => c.key === 'w:whoosh'));
    check('every word is a card or listed under "No strong matches yet"', !unmatched.includes('rain') && (list.some(c => c.key === 'w:whoosh') || unmatched.includes('whoosh')), { unmatched });
    const nodeCount = await ctx.exec(() => ({ cnt: !!document.querySelector('.brief-node .cnt'), text: document.querySelector('.brief-node').textContent }));
    check('the Brief node still shows no count while suggestions are open', !nodeCount.cnt && nodeCount.text === 'Brief', nodeCount);

    // A word the fixture library cannot answer: listed calmly, editable and removable from there.
    await clickOn('words field', () => document.querySelector('.brief .words-in'));
    await typeText('glass harmonica');
    await T.key(ctx, 'Enter');
    await ctx.wait(500);
    await settle();
    unmatched = await visibleUnmatched();
    ctx.log('unmatched after "glass harmonica":', JSON.stringify(unmatched));
    if (unmatched.includes('glass harmonica')) {
        await shot('03a-unmatched');
        await clickOn('unmatched word', () => [...document.querySelectorAll('.bv .unmatched .um')].find(b => b.offsetParent && b.textContent === 'glass harmonica'));
        const menu = await ctx.waitFor(() => { const m = document.querySelector('.menu'); return m && [...m.querySelectorAll('.mi')].map(x => x.textContent); }, 3000, 'unmatched menu');
        check('an unmatched word opens Edit / Remove', menu.join() === 'Edit word,Remove word', menu);
        await clickOn('Remove word', () => [...document.querySelectorAll('.menu .mi')].find(x => x.textContent === 'Remove word'));
        const words = await ctx.waitFor(() => window.sv.brief.get().then(s => !s.words.includes('glass harmonica') && s.words), 5000, 'word removed');
        check('Remove word takes it out of the brief', !words.includes('glass harmonica'), words);
        await settle();
    } else {
        ctx.log('"glass harmonica" found a card on this library, removing it by its chip');
        await clickOn('chip x', () => [...document.querySelectorAll('.brief .words .cc')].find(c => c.textContent === 'glass harmonica').querySelector('.x'));
        await settle();
    }

    // More words so there is something to dismiss and to review.
    for (const w of ['kick', 'metal', 'beep']) {
        if ((await cards()).length >= 4) break;
        await clickOn('words field', () => document.querySelector('.brief .words-in'));
        await typeText(w);
        await T.key(ctx, 'Enter');
        await ctx.wait(400);
        await settle();
    }
    list = await cards();
    ctx.log('cards now', JSON.stringify(list.map(c => `${c.title} (${c.n})`)));

    // A click on a word chip pins it: saved, and the card it explains shows the pin.
    await clickOn('kick chip', () => [...document.querySelectorAll('.brief .words .cc')].find(c => c.textContent === 'kick').querySelector('.cc-t'));
    await ctx.waitFor(() => window.sv.brief.get().then(s => s.pinned.includes('w:kick')), 4000, 'kick pinned').catch(() => null);
    await settle();
    const pin = await ctx.exec(() => ({
        chip: !!document.querySelector('.brief .words .cc.pinned'),
        saved: null,
        reason: [...document.querySelectorAll('.cards > .card')].filter(c => c.querySelector('.wc.pinned')).map(c => c.dataset.key),
        first: (document.querySelector('.cards > .card') || {}).dataset.key || null,
    }));
    pin.saved = await ctx.exec(() => window.sv.brief.get().then(s => s.pinned));
    check('a click pins a word: saved, and its card shows the pin and comes first', pin.chip && pin.saved.includes('w:kick') && (!list.some(c => c.key === 'w:kick') || (pin.reason.includes('w:kick') && pin.first === 'w:kick')), pin);
    await clickOn('kick chip', () => [...document.querySelectorAll('.brief .words .cc')].find(c => c.textContent === 'kick').querySelector('.cc-t'));
    await ctx.waitFor(() => window.sv.brief.get().then(s => !s.pinned.includes('w:kick')), 4000, 'kick unpinned').catch(() => null);
    await settle();
    list = await cards();

    // Audition from a card: the row shows the playing state and the player follows.
    await clickOn('first rain row', () => [...document.querySelectorAll('.cards > .card')].find(c => c.dataset.key === 'w:rain').querySelector('.c-row'));
    const playing = await ctx.waitFor(async () => {
        const { player } = await import('./js/audio/engine.js');
        const row = document.querySelector('.cards .c-row.playing');
        return row && player.sound && { row: row.querySelector('.nm').textContent, player: player.sound.name };
    }, 8000, 'card row playing');
    check('clicking a card row auditions it (playing state on the row)', playing && playing.player.startsWith(playing.row), playing);
    await ctx.wait(300);
    await shot('03-suggestions');
    ctx.win.setContentSize(1440, 900); await ctx.wait(600);
    await shot('03b-suggestions-1440');
    ctx.win.setContentSize(1280, 800); await ctx.wait(600);
    await stopPlayer();

    // ── 4. Review with the keyboard ──────────────────────────────────────
    // Longer sounds make the pause / resume check calm: whooshes and metal hits before kicks.
    const reviewKey = (['w:whoosh', 'w:metal', 'w:kick'].map(k => list.find(c => c.key === k && c.n >= 5)).find(Boolean) || list.find(c => c.key !== 'w:rain' && c.n >= 5) || {}).key;
    check('there is a second card to review', !!reviewKey, list.map(c => c.key));
    if (reviewKey) {
        const n = list.find(c => c.key === reviewKey).n;
        await clickOn('Review', cardBtn(), reviewKey, 'review');
        await ctx.waitFor(() => document.querySelector('.rv.open') && document.activeElement && document.activeElement.classList.contains('rv-list'), 5000, 'review open and focused');
        await ctx.wait(400);
        await T.key(ctx, 'Down');
        await T.key(ctx, 'Down');
        if (!autoPlay) await T.key(ctx, 'Space');       // with auto-play the cursor already auditions
        const heard = await ctx.waitFor(async () => {
            const { player } = await import('./js/audio/engine.js');
            const cur = document.querySelector('.rv .rr.cursor');
            return player.sound && cur && cur.classList.contains('playing') && { cursor: cur.querySelector('.nm').textContent, playing: player.sound.name, index: [...document.querySelectorAll('.rv .rr')].indexOf(cur) };
        }, 8000, 'review audition').catch(() => null);
        check('↓ ↓ moves to the third candidate and auditions it', heard && heard.index === 2 && heard.playing.startsWith(heard.cursor), { heard, autoPlay });
        await T.key(ctx, 'Space');
        await ctx.wait(250);
        const paused = await playerState();
        // The candidates are short (a kick is 0.6 s): record the play event instead of sampling it later.
        await ctx.exec(async () => { const { player } = await import('./js/audio/engine.js'); window.__svPlayed = null; const off = player.on('state', s => { if (s.playing && s.sound) { window.__svPlayed = s.sound.name; off(); } }); return true; });
        await T.key(ctx, 'Space');
        const resumed = await ctx.waitFor(() => window.__svPlayed, 3000, 'played again').catch(() => null);
        check('Space pauses and plays the candidate under the cursor', !paused.playing && resumed === (heard && heard.playing), { paused, resumed });
        await T.key(ctx, 'Enter');                    // everything starts kept: Enter drops it, the cursor moves on
        await T.key(ctx, 'Delete');                   // Delete drops the next one too
        const rv = await ctx.exec(() => ({ kept: document.querySelectorAll('.rv .rr.kept').length, total: document.querySelectorAll('.rv .rr').length, go: document.querySelector('.rv .rv-foot .btn.primary').textContent, cursor: [...document.querySelectorAll('.rv .rr')].findIndex(r => r.classList.contains('cursor')) }));
        check('Enter and Delete drop candidates, the button counts what is kept', rv.total === n && rv.kept === n - 2 && rv.go === `Create collection with ${n - 2} sounds` && rv.cursor === 4, rv);
        await shot('04-review');
        ctx.win.setContentSize(1440, 900); await ctx.wait(600);
        await shot('04b-review-1440');
        ctx.win.setContentSize(1280, 800); await ctx.wait(600);
        await T.key(ctx, 'Escape');
        await ctx.waitFor(() => !document.querySelector('.rv.open'), 3000, 'review closed');
        check('Esc closes the review sheet', true);
        await stopPlayer();
    }

    // ── 5. Create collection from the rain card ──────────────────────────
    const before = await ctx.exec(() => window.sv.collections.list());
    await clickOn('Create collection', cardBtn(), 'w:rain', 'create');
    await ctx.wait(330);
    await shot('05a-create-flying');
    const node = await ctx.waitFor(() => { const n = [...document.querySelectorAll('.node[data-kind="collection"]')].find(e => e.dataset.col === 'Rain'); return n && !n.classList.contains('arriving') && { count: n.querySelector('.cnt').textContent }; }, 10000, 'Rain in the sidebar');
    const rainSounds = await ctx.exec(() => window.sv.collections.sounds('Rain'));
    const rainNames = rainSounds.sounds.map(s => s.name);
    check('Create collection adds "Rain" to the sidebar with the card\'s sounds', before.every(c => c.name !== 'Rain') && rainNames.length === rain.n && +node.count === rain.n && rainNames.every(n => RAINY.test(n)), { node, rainNames });
    const rainCard = await ctx.waitFor(() => { const c = [...document.querySelectorAll('.cols > .col')].find(e => e.dataset.col === 'Rain'); return c && { count: c.querySelector('.c-count').textContent, rows: [...c.querySelectorAll('.c-row .nm')].map(x => x.textContent), empty: !document.querySelector('.cols-empty:not(.hidden)') }; }, 5000, 'Rain in the grid');
    check('the new collection shows in the home\'s grid with its first sounds', rainCard.count === `${rain.n} sounds` && rainCard.rows.length === Math.min(3, rain.n) && rainCard.rows[0] === rainNames[0].replace(/\.wav$/i, '') && rainCard.empty, rainCard);
    await ctx.waitFor(() => ![...document.querySelectorAll('.cards > .card:not(.leaving)')].some(c => c.dataset.key === 'w:rain'), 5000, 'rain card gone');
    const toastActs = await ctx.exec(() => [...document.querySelectorAll('.toast')].filter(t => /Created “Rain”/.test(t.textContent)).map(t => [...t.querySelectorAll('.act')].map(a => a.textContent)));
    check('the card is gone and the toast offers Open and Undo', toastActs.length === 1 && toastActs[0].join() === 'Open,Undo', toastActs);
    await ctx.wait(500);
    await shot('05b-created');
    await settle();

    // ── 6. Dismiss, then reopen the Brief: it stays dismissed ────────────
    list = await cards();
    const dismissKey = (list.find(c => c.key !== reviewKey) || list[0] || {}).key;
    check('there is a card to dismiss', !!dismissKey, list.map(c => c.key));
    if (dismissKey) {
        await clickOn('Dismiss', cardBtn(), dismissKey, 'dismiss');
        await until(k => ![...document.querySelectorAll('.cards > .card:not(.leaving)')].some(c => c.dataset.key === k), [dismissKey], 5000, 'dismissed card gone');
        await settle();
        await clickOn('Rain in the sidebar', () => [...document.querySelectorAll('.node[data-kind="collection"]')].find(e => e.dataset.col === 'Rain'));
        await ctx.waitFor(() => !document.querySelector('.main.brief-on') && document.querySelectorAll('.list .row:not([aria-hidden="true"])').length > 2, 8000, 'Rain collection open');
        check('opening a collection leaves the Brief (node no longer active)', await ctx.exec(() => !document.querySelector('.brief-node.active') && !!document.querySelector('.node.active[data-col="Rain"]')));
        await shot('06a-rain-collection');
        await clickOn('Brief node', () => document.querySelector('.brief-node'));
        await ctx.waitFor(() => document.querySelector('.main.brief-on') && document.querySelector('.brief-node.active'), 5000, 'brief again');
        await ctx.wait(400);
        await settle();
        const again = await cards();
        const st = await ctx.exec(() => window.sv.brief.get());
        const stillOpen = await ctx.exec(() => document.querySelector('.bv').classList.contains('open'));
        check('a dismissed suggestion stays dismissed after reopening the Brief (the suggestions stay open this session)', stillOpen && !again.some(c => c.key === dismissKey) && st.dismissed.includes(dismissKey) && !again.some(c => c.key === 'w:rain'), { stillOpen, again: again.map(c => c.key), dismissed: st.dismissed, created: st.created });
    }

    // ── 7. Review and create with the keyboard (Ctrl+Enter), then Undo ───
    list = await cards();
    const rk = (list.find(c => c.key === reviewKey) || list[0] || {}).key;
    if (rk) {
        const card = list.find(c => c.key === rk);
        await clickOn('Review', cardBtn(), rk, 'review');
        await ctx.waitFor(() => document.querySelector('.rv.open') && document.activeElement && document.activeElement.classList.contains('rv-list'), 5000, 'review open');
        await ctx.wait(300);
        await T.key(ctx, 'Delete');
        await T.key(ctx, 'Enter', ['control']);
        const name = await until(k => window.sv.brief.get().then(s => s.created[k]), [rk], 10000, 'created from review').catch(() => null);
        const got = name ? await ctx.exec(n => window.sv.collections.sounds(n), name) : { sounds: [] };
        check('Ctrl+Enter in the review creates the collection with what was kept', !!name && got.sounds.length === card.n - 1, { name, n: got.sounds.length, expected: card.n - 1 });
        await ctx.wait(1200);
        await ctx.exec(n => { const t = [...document.querySelectorAll('.toast')].find(x => x.textContent.includes(`“${n}”`)); const u = t && [...t.querySelectorAll('.act')].find(a => a.textContent === 'Undo'); if (u) u.click(); return !!u; }, name);
        await until(n => window.sv.collections.list().then(l => !l.some(c => c.name === n)), [name], 8000, 'undo removed the collection').catch(() => null);
        await until(k => [...document.querySelectorAll('.cards > .card:not(.leaving)')].some(c => c.dataset.key === k), [rk], 15000, 'card back after undo').catch(() => null);
        const back = await ctx.exec((k, n) => ({ card: [...document.querySelectorAll('.cards > .card:not(.leaving)')].some(c => c.dataset.key === k), inGrid: [...document.querySelectorAll('.cols > .col')].some(c => c.dataset.col === n) }), rk, name);
        const cols = await ctx.exec(() => window.sv.collections.list());
        check('Undo removes the collection (sidebar and grid) and brings the suggestion back', back.card && !back.inGrid && !cols.some(c => c.name === name), { back, cols: cols.map(c => c.name) });
    }

    // ── 8. A reference sound from the row menu ───────────────────────────
    await clickOn('Rain in the sidebar', () => [...document.querySelectorAll('.node[data-kind="collection"]')].find(e => e.dataset.col === 'Rain'));
    await ctx.waitFor(() => document.querySelectorAll('.list .row:not([aria-hidden="true"])').length > 2, 8000, 'rows');
    await ctx.wait(300);
    const row = await center(() => [...document.querySelectorAll('.list .row')].find(r => r.getAttribute('aria-hidden') !== 'true' && r.getBoundingClientRect().top > 0).querySelector('.meta'));
    await T.rclick(ctx, row.x, row.y);
    const item = await ctx.waitFor(() => { const m = [...document.querySelectorAll('.menu .mi')].find(x => x.textContent.includes('Use as Brief reference')); return m ? m.textContent : null; }, 3000, 'menu item');
    check('the row menu offers "Use as Brief reference"', item === 'Use as Brief reference', item);
    const refName = await ctx.exec(() => document.querySelector('.list .row.cursor .nm').textContent);
    await clickOn('menu item', () => [...document.querySelectorAll('.menu .mi')].find(x => x.textContent.includes('Use as Brief reference')));
    const refToast = await ctx.waitFor(() => { const t = [...document.querySelectorAll('.toast')].find(x => x.textContent.includes('Brief')); return t && t.textContent; }, 4000, 'reference toast');
    check('a toast confirms the reference', /Added “.+” to the .+ Brief/.test(refToast), refToast);
    await clickOn('Brief node', () => document.querySelector('.brief-node'));
    // the duration comes with the tile's waveform, which loads once the tile is in view
    const tileNow = () => { const t = document.querySelector('.brief .tile.snd'); return t && { name: t.querySelector('.s-name').textContent, meta: t.querySelector('.s-meta').textContent }; };
    await ctx.waitFor(tileNow, 8000, 'reference tile');
    await center(() => document.querySelector('.brief .tile.snd'));
    const tile = await ctx.waitFor(`(${tileNow})() && /\\d/.test((${tileNow})().meta) && (${tileNow})()`, 8000, 'reference duration').catch(() => ctx.exec(tileNow));
    check('the reference shows in the Brief with its name and duration', tile.name === refName && /\d/.test(tile.meta), tile);
    await clickOn('reference play', () => document.querySelector('.brief .tile.snd .pb'));
    const refPlaying = await ctx.waitFor(() => !!document.querySelector('.brief .tile.snd .media.playing'), 6000, 'reference playing').catch(() => false);
    check('the reference plays from its tile', refPlaying);
    await clickOn('reference pin', () => document.querySelector('.brief .tile.snd .tpin'));
    const pinned = await ctx.waitFor(() => window.sv.brief.get().then(s => s.pinned.length && s.pinned), 4000, 'pinned').catch(() => []);
    check('the pin on a reference saves its key', pinned.some(k => k.startsWith('s:') && k === k.toLowerCase()) && await ctx.exec(() => document.querySelector('.brief .tile.snd .tpin').classList.contains('on')), pinned);
    await ctx.wait(500);
    await settle();
    await shot('07-reference');
    await stopPlayer();

    // ── 9. Images: paste and drop go through the same path ───────────────
    const makeImage = (w, colors, name, how) => ctx.exec(async (w, colors, name, how) => {
        const c = new OffscreenCanvas(w, Math.round(w * 0.62)), x = c.getContext('2d'), H = c.height;
        const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, colors[0]); g.addColorStop(1, colors[1]); x.fillStyle = g; x.fillRect(0, 0, w, H);
        x.fillStyle = colors[2]; x.fillRect(0, H * 0.7, w, H * 0.3);
        x.fillStyle = colors[3]; x.beginPath(); x.arc(w * 0.7, H * 0.3, H * 0.14, 0, Math.PI * 2); x.fill();
        x.fillStyle = colors[4]; x.fillRect(w * 0.1, H * 0.5, w * 0.3, H * 0.22);
        const file = new File([await c.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' });
        const dt = new DataTransfer(); dt.items.add(file);
        if (how === 'paste') { const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.body.dispatchEvent(ev); return ev.defaultPrevented; }
        const zone = document.querySelector('.brief');
        for (const type of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
        return true;
    }, w, colors, name, how);
    const pasted = await makeImage(1800, ['#0b1a2a', '#23465c', '#2f6f5e', '#f0b050', '#7a4a2a'], 'harbour-night.png', 'paste');
    check('pasting an image is taken by the Brief', pasted);
    await ctx.wait(250);
    await shot('08a-image-analysing');
    const img = await ctx.waitFor(() => { const t = document.querySelector('.brief .tile.img:not(.analysing):not(.out) img'); return t && t.src.startsWith('data:image/') && { src: t.src.slice(0, 16), swatches: document.querySelectorAll('.bv .palette .sw').length, note: !document.querySelector('.img-note').classList.contains('hidden'), concepts: [...document.querySelectorAll('.brief .tile.img .concepts .cc')].map(c => c.textContent), none: !!document.querySelector('.brief .tile.img .cc-none') }; }, 20000, 'image tile');
    const stImg = await ctx.exec(() => window.sv.brief.get());
    ctx.log('image model:', stImg.imageModel, 'concepts:', JSON.stringify(stImg.images[0] && stImg.images[0].concepts));
    check('the image is stored as WebP with a 4 or 5 color palette', img.src.startsWith('data:image/webp') && stImg.images.length === 1 && stImg.images[0].palette.length >= 4 && stImg.images[0].palette.length <= 5, { img, palette: stImg.images[0] && stImg.images[0].palette });
    // Synthetic pictures legitimately give no concepts: only the two model states are asserted.
    check('the image model is either ready or unavailable', ['ready', 'unavailable'].includes(stImg.imageModel), stImg.imageModel);
    if (stImg.imageModel === 'unavailable') check('without the image model, images say they add their colors for now', img.note && img.swatches >= 4, img);
    else check('with the image model, no "colors for now" line, and concepts show as chips', !img.note && img.concepts.length === stImg.images[0].concepts.length && (img.concepts.length > 0 || !stImg.images[0].analyzed || img.none), { img, analyzed: stImg.images[0].analyzed });
    const size = await ctx.exec(() => new Promise(r => { const t = document.querySelector('.brief .tile.img:not(.out) img'); const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r(null); setTimeout(() => r(null), 5000); i.src = t.src; }));
    check('the stored image is at most 640 px on its long side', !!size && Math.max(...size) === 640, size);
    await makeImage(900, ['#20160f', '#5a3a22', '#8a5a30', '#d8c8a0', '#40302a'], 'deck-keyart.png', 'drop');
    await ctx.waitFor(() => document.querySelectorAll('.brief .tile.img:not(.analysing):not(.out)').length === 2, 20000, 'second image (drop)');
    check('dropping an image adds it too', true);
    const vaultBefore = await ctx.exec(() => window.sv.vaults.list().then(v => v.vaults.find(x => x.id === v.activeVaultId).color));
    await clickOn('Use image colors', () => [...document.querySelectorAll('.bv .palette .btn')].find(b => /Use image colors/.test(b.textContent)));
    const vaultAfter = await until(async b => { const v = await window.sv.vaults.list(); const c = v.vaults.find(x => x.id === v.activeVaultId).color; return c !== b && c; }, [vaultBefore], 5000, 'vault color').catch(() => null);
    const colors = await ctx.exec(async () => { const cs = getComputedStyle(document.documentElement); const t = await import('./js/theme.js'); const v = await window.sv.vaults.list(); const c = v.vaults.find(x => x.id === v.activeVaultId).color; return { mode: cs.getPropertyValue('--mode-color').trim(), accent: cs.getPropertyValue('--accent').trim(), legible: t.legible(c), derived: t.vaultAccent(c) }; });
    check('"Use image colors" sets the vault color from the moodboard, and the interface follows it', !!vaultAfter && vaultAfter !== vaultBefore && colors.mode === colors.legible && colors.accent === colors.derived, { vaultBefore, vaultAfter, colors });
    await ctx.wait(600);
    await settle();
    await ctx.exec(() => { document.querySelector('.bscroll').scrollTop = 0; return true; });
    await shot('08b-images-palette');
    ctx.win.setContentSize(1440, 900); await ctx.wait(600);
    await shot('08c-brief-1440');
    await ctx.exec(() => { document.querySelector('.bscroll').scrollTop = 99999; return true; });
    await ctx.wait(400);
    await shot('08d-brief-1440-bottom');
    ctx.win.setContentSize(1280, 800); await ctx.wait(500);

    // ── 10. Hide the suggestions: the home is the collections, nothing runs unasked ──
    await clickOn('Hide suggestions', () => document.querySelector('.bhead .suggest-toggle'));
    await ctx.waitFor(() => !document.querySelector('.bv').classList.contains('open'), 3000, 'suggestions hidden');
    await ctx.wait(800);
    const hidden = await ctx.exec(() => ({ shown: !!document.querySelector('.suggest').offsetParent, toggle: document.querySelector('.bhead .suggest-toggle').textContent }));
    const askedBefore = asked.suggest;
    await ctx.exec(async () => {
        const all = await window.sv.library.list({ folder: '' });
        await window.sv.collections.create('Kicks');
        await window.sv.collections.add('Kicks', all.filter(x => /kick/i.test(x.name)).slice(0, 5).map(x => x.path));
        await window.sv.collections.setColor('Kicks', '#f79e6d');
        await window.sv.collections.create('Empty one');
        await (await import('./js/actions.js')).refreshCollections();
        return true;
    });
    await ctx.waitFor(() => document.querySelectorAll('.cols > .col').length >= 3, 5000, 'grid updated');
    await ctx.wait(2000);
    const g = await grid();
    check('hidden suggestions stay hidden (the brief is kept), the grid follows the collections', !hidden.shown && hidden.toggle === 'Suggest collections' && g.some(c => c.name === 'Kicks' && c.count === '5 sounds' && c.rows === 3) && g.some(c => c.name === 'Empty one' && c.rows === 0), { hidden, g });
    if (counting) check('with the suggestions hidden nothing asks for them, even as collections change', asked.suggest === askedBefore, { before: askedBefore, after: asked.suggest });
    const emptyCard = await ctx.exec(() => { const c = [...document.querySelectorAll('.cols > .col')].find(e => e.dataset.col === 'Empty one'); return { text: c.textContent, find: !!c.querySelector('.find') }; });
    check('an empty collection says how to fill it (no "Find more")', /No sounds yet/.test(emptyCard.text) && !emptyCard.find && !/null|undefined/.test(emptyCard.text), emptyCard);
    await shot('09-home-collections');
    ctx.win.setContentSize(1440, 900); await ctx.wait(600);
    await shot('09b-home-collections-1440');
    ctx.win.setContentSize(1280, 800); await ctx.wait(600);

    // ── 11. A collection card: audition, Find more (on demand), open ─────
    await clickOn('Kicks row', () => [...document.querySelectorAll('.cols > .col')].find(e => e.dataset.col === 'Kicks').querySelector('.c-row'));
    const colPlaying = await ctx.waitFor(async () => {
        const { player } = await import('./js/audio/engine.js');
        const r = document.querySelector('.cols .c-row.playing');
        return r && player.sound && { row: r.querySelector('.nm').textContent, player: player.sound.name, view: document.querySelector('.main.brief-on') ? 'brief' : 'other' };
    }, 8000, 'collection row playing');
    check('a collection card auditions its sounds in place', colPlaying.player.startsWith(colPlaying.row) && colPlaying.view === 'brief', colPlaying);
    await stopPlayer();
    const moreBefore = asked.more.length;
    const rainCount0 = (await ctx.exec(() => window.sv.collections.list())).find(c => c.name === 'Rain').count;
    await clickOn('Find more', () => [...document.querySelectorAll('.cols > .col')].find(e => e.dataset.col === 'Rain').querySelector('.find'));
    const sheet = await ctx.waitFor(() => document.querySelector('.rv.open') && document.activeElement && document.activeElement.classList.contains('rv-list') && { title: document.querySelector('.rv-head h3').textContent, rows: document.querySelectorAll('.rv .rr').length, label: document.querySelector('.rv-tools span').textContent, go: document.querySelector('.rv .rv-foot .btn.primary').textContent }, 10000, 'find more sheet').catch(() => null);
    check('"Find more" asks for that collection only, and the sounds come in the review sheet', !!sheet && sheet.title === 'Rain' && sheet.rows > 0 && sheet.label === 'Suggested additions' && sheet.go === `Add ${sheet.rows} sound${sheet.rows === 1 ? '' : 's'} to Rain` && (!counting || (asked.more.length === moreBefore + 1 && asked.more[asked.more.length - 1] === 'Rain')), { sheet, more: asked.more });
    // the sheet's waveforms load as they come into view: wait for the visible ones before the picture
    await ctx.waitFor(() => [...document.querySelectorAll('.rv .rr')].filter(r => { const b = r.getBoundingClientRect(); return b.bottom < innerHeight - 60; }).every(r => r.querySelector('.du').textContent), 10000, 'sheet waveforms').catch(() => null);
    await shot('10-find-more');
    let added = 0;
    if (sheet) {
        await T.key(ctx, 'Delete');                                  // keep all but the first
        await T.key(ctx, 'Enter', ['control']);
        const after = await until(n => window.sv.collections.list().then(l => { const c = l.find(x => x.name === 'Rain'); return c && c.count > n && c.count; }), [rainCount0], 8000, 'sounds added').catch(() => null);
        added = after ? after - rainCount0 : 0;
        const countNow = () => { const c = [...document.querySelectorAll('.cols > .col')].find(e => e.dataset.col === 'Rain'); return c && c.querySelector('.c-count').textContent; };
        const cardCount = await until(want => { const c = [...document.querySelectorAll('.cols > .col')].find(e => e.dataset.col === 'Rain'); return c && c.querySelector('.c-count').textContent === want && want; }, [`${rainCount0 + added} sounds`], 4000, 'card count').catch(() => ctx.exec(countNow));
        const toastAdd = await ctx.exec(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).find(t => /to Rain/.test(t)) || null);
        check('confirming adds what was kept, the card and a toast say so', added === sheet.rows - 1 && cardCount === `${rainCount0 + added} sounds` && !!toastAdd, { added, cardCount, toastAdd });
    }
    await ctx.wait(400);
    const rainPos = await center(() => { const c = [...document.querySelectorAll('.cols > .col')].find(e => e.dataset.col === 'Rain'); return c && c.querySelector('.c-count'); });
    await T.click(ctx, rainPos.x, rainPos.y);
    const opened2 = await ctx.waitFor(() => !document.querySelector('.main.brief-on') && document.querySelector('.crumbs h1') && { title: document.querySelector('.crumbs h1').textContent, active: !!document.querySelector('.node.active[data-col="Rain"]') }, 8000, 'Rain opened from its card');
    check('a click on a collection card opens it', opened2.title.endsWith('Rain') && opened2.active, opened2);

    // ── 12. Housekeeping: no renderer errors along the way ──────────────
    const errors = ctx.report.console.filter(m => m.level === 3 || m.level === 'error').map(m => m.message);
    check('no renderer errors', errors.length === 0, errors.slice(0, 5));
    ctx.log('suggestion requests:', asked.suggest, 'more:', JSON.stringify(asked.more));
    ctx.log('brief scenario took', Math.round((Date.now() - t0) / 1000), 's');
    done();
};
