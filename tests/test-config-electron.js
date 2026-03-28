const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
    const CONFIG_PATH = path.join(app.getPath('userData'), 'soundvault-config.json');
    let lib = path.join(app.getPath('documents'), 'SoundVault');
    if (fs.existsSync(CONFIG_PATH)) {
        try { lib = JSON.parse(fs.readFileSync(CONFIG_PATH,'utf-8')).libraryPath || lib; } catch(e){}
    }
    console.log("=== EXACT LIBRARY PATH ===");
    console.log(lib);
    console.log("==========================");
    let folders = [];
    try {
        folders = fs.readdirSync(lib).filter(f => fs.statSync(path.join(lib, f)).isDirectory() && !f.startsWith('.'));
    } catch(e) {}
    console.log("Folders inside it:", folders.join(', '));
    app.quit();
});
