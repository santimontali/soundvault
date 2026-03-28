const { AutoTokenizer, AutoProcessor, ClapTextModelWithProjection, ClapAudioModelWithProjection } = require('@xenova/transformers');
const fs = require('fs');

async function testClap() {
    console.log("Loading CLAP Text/Audio Models...");
    try {
        const tokenizer = await AutoTokenizer.from_pretrained('Xenova/clap-htsat-unfused');
        const text_model = await ClapTextModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused');
        
        let inputs = tokenizer(['ambient pad', 'heavy explosion'], { padding: true, truncation: true });
        let { text_embeds } = await text_model(inputs);
        console.log("Text embeds shape:", text_embeds.dims); // Should be [2, 512]
        console.log("CLAP Text test SUCCESS");

    } catch (e) {
        console.error("Error loading CLAP:", e);
    }
}

testClap();
