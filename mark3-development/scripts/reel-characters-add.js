const path = require('path');
const universe = require('../core/elevate-character-universe');

(() => {
  const supplied = process.argv.slice(2).join(' ').trim();
  const source = supplied || universe.discoverFinalLineup() || universe.discoverReference();
  if (!source) {
    console.error('Approved Elevate character lineup was not found automatically.');
    console.error('Save the final transparent lineup PNG in Downloads, then run npm run reels:characters:add again.');
    console.error('Recognized filename: ChatGPT Image Sep 8, 2026, 02_09_14 PM.png');
    console.error('You can also run: npm run reels:characters:add -- "C:\\path\\to\\final-lineup.png"');
    process.exit(1);
  }

  let installed;
  try {
    installed = universe.installCharacterAsset(source);
  } catch (error) {
    console.error(`Elevate character installation failed: ${error.message}`);
    process.exit(1);
  }

  const status = universe.status();
  if (!status.configured) {
    console.error(`Elevate character universe is not production-ready. ${status.installHint || 'Approved final transparent lineup is missing.'}`);
    process.exit(1);
  }

  console.log(`ULTRON Elevate character universe ready: ${status.castCount} canonical actors installed.`);
  console.log(`Final transparent lineup: READY at ${path.resolve(status.finalLineupPath)}`);
  console.log(`Renderer: ${status.renderer}`);
  if (installed?.mode === 'legacy-reference') {
    console.log('Legacy reference preserved, but production still uses the approved transparent final lineup.');
  }
  console.log('Cast: gym creator, fashion creator, UGC/skincare creator, info creator, Retention Devil, female Elevate doctor, male Elevate doctor.');
})();
