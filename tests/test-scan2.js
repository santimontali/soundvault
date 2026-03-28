const fs = require('fs');
const path = require('path');

function testScan() {
    const lib = 'c:\\Users\\santi\\Documents\\SoundVault_Tests';
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
