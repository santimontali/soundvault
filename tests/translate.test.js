'use strict';
// Spanish → English query translation (AI search + file-name search).
const test = require('node:test');
const assert = require('node:assert/strict');
const { translateQuery } = require('../src/search/translate');

const t = q => translateQuery(q).text;

test('common Spanish sound queries become natural English', () => {
    assert.equal(t('pasos en grava'), 'footsteps on gravel');
    assert.equal(t('perro ladrando'), 'dog barking');
    assert.equal(t('olas del mar'), 'ocean waves');
    assert.equal(t('explosiones lejanas'), 'distant explosions');
    assert.equal(t('golpes de espada'), 'sword hits');
    assert.equal(t('explosión grande'), 'big explosion');
    assert.equal(t('sonido de lluvia en la ventana'), 'rain on window');
    assert.equal(t('puertas metálicas'), 'metallic doors');
});

test('English queries (and Spanish look-alikes common in SFX names) are left alone', () => {
    for (const q of ['metal door', 'a dog barking', 'Footsteps Gravel 03', 'mono kick', 'Auto Fire', 'grave digging', 'arena crowd', 'piano']) {
        const r = translateQuery(q);
        assert.equal(r.changed, false, q);
        assert.equal(r.text, q);
    }
});

test('unknown words are kept (accent-folded) so names and numbers still match', () => {
    const r = translateQuery('lluvia Kirchner 03');
    assert.ok(r.changed);
    assert.equal(r.text, 'rain kirchner 03');
});
