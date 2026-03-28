const fs = require('fs');
const path = require('path');

function testScan() {
    const lib = 'c:\\Users\\santi\\Documents\\SoundVault_Tests';
    console.log("Scanning:", lib);
    const allWavs = [];
            
    const scanDir = (dir) => {
        if(!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const fullPath = path.join(dir, e.name);
            if (e.isDirectory()) {
                console.log("Entering dir:", fullPath);
                // Oh wait! In main.js the sidebar logic ONLY looks at FIRST LEVEL folders! 
                // Wait, but here I'm recursing. Why did it find 0?
                // Wait! Is "node_modules" getting scanned? Yes!
                // Does "node_modules" crash the scanner?
                if (e.name === 'node_modules') continue;
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
