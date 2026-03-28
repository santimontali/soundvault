const semanticEngine = require('./src/semantic-engine');
const path = require('path');

async function testIndex() {
    await semanticEngine.init();
    
    // We will scan the Documents path which seemed to have 34 wavs earlier
    const lib1 = path.join(process.env.USERPROFILE, 'Documents', 'SoundVault');
    const lib2 = path.join(__dirname);
    
    console.log("Triggering start indexing on", lib1);
    await semanticEngine.startIndexing(lib1);
    console.log("Progress total:", semanticEngine.progress.total);
}

testIndex().catch(console.error);
