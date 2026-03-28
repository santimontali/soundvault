const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_PATH = path.join(process.env.APPDATA, 'soundvault', 'soundvault-config.json');
// Electron places user data in AppData/Roaming/soundvault on Windows... wait, appName is 'soundvault'
// Wait, we can just read the config directly if we know where it is, or we can just ask electron.

function testScan() {
    // let's just search the Documents/SoundVault path used by default
    const lib = path.join(process.env.USERPROFILE, 'Documents', 'SoundVault');
    console.log("Scanning:", lib);
    if (!fs.existsSync(lib)) {
        console.log("Does not exist.");
        return;
    }
    const allWavs = [];
            
    const scanDir = (dir) => {
        if(!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const fullPath = path.join(dir, e.name);
            if (e.isDirectory()) {
                scanDir(fullPath);
            } else if (e.name.toLowerCase().endsWith('.wav')) {
                allWavs.push(fullPath);
            }
        }
    };
    
    scanDir(lib);
    console.log(`Found ${allWavs.length} wavs.`);
}
testScan();
