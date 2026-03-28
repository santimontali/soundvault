const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), 'AppData', 'Roaming', 'soundvault', 'soundvault-config.json');

function check() {
    console.log("Reading config:", CONFIG_PATH);
    try {
        if(fs.existsSync(CONFIG_PATH)) {
            console.log("Config:", fs.readFileSync(CONFIG_PATH, 'utf-8'));
        } else {
            console.log("Config does not exist there.");
        }
    } catch(e) { console.error(e); }
}

check();
