'use strict';
// Must be truthy: transformers/src/utils/image.js throws at import time if `sharp` is falsy in Node.
module.exports = function sharpNotBundled() {
  throw new Error('sharp is not bundled with SoundVault (image pipelines are unsupported)');
};
