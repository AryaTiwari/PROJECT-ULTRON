const path = require('path');
const universe = require('../core/elevate-character-universe');

(() => {
  const supplied = process.argv.slice(2).join(' ').trim();
  const source = supplied || universe.discoverReference();
  if (!source) {
    console.error('Elevate character reference was not found automatically.');
    console.error('Run: npm run reels:characters:add -- "C:\\path\\to\\1000248121.jpg"');
    console.error('Or set ULTRON_M3_ELEVATE_CHARACTER_REFERENCE to the seven-character reference sheet.');
    process.exit(1);
  }
  const installed = universe.installReference(source);
  const status = universe.status();
  console.log(`ULTRON Elevate character universe ready: ${status.castCount} canonical actors installed.`);
  console.log(`Reference: ${path.resolve(installed)}`);
  console.log('Cast: gym creator, fashion creator, UGC/skincare creator, info creator, Retention Devil, female Elevate doctor, male Elevate doctor.');
})();
