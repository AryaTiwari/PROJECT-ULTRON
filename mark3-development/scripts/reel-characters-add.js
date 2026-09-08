const path = require('path');
const universe = require('../core/elevate-character-universe');

(() => {
  const supplied = process.argv.slice(2).join(' ').trim();
  const source = supplied || universe.discoverReference();
  if (!source) {
    console.error('Elevate character reference was not found automatically.');
    console.error('Run: npm run reels:characters:add -- "C:\\path\\to\\elevate-character-reference.jpg"');
    console.error('Or set ULTRON_M3_ELEVATE_CHARACTER_REFERENCE to the seven-character reference sheet.');
    process.exit(1);
  }

  let installed;
  try {
    installed = universe.installReference(source);
  } catch (error) {
    console.error(`Elevate character installation failed: ${error.message}`);
    process.exit(1);
  }

  const status = universe.status();
  if (!status.configured) {
    console.error(`Elevate character universe is not production-ready. ${status.installHint || 'Transparent sprite pack is incomplete.'}`);
    process.exit(1);
  }

  console.log(`ULTRON Elevate character universe ready: ${status.castCount} canonical actors installed.`);
  console.log(`Reference: ${path.resolve(installed)}`);
  if (status.spritePackReady) {
    console.log(`Transparent sprite pack: READY (7/7) at ${path.resolve(status.spriteRoot)}`);
  } else {
    console.log('Transparent sprite pack: compatibility mode only on this platform.');
  }
  console.log(`Renderer: ${status.renderer}`);
  console.log('Cast: gym creator, fashion creator, UGC/skincare creator, info creator, Retention Devil, female Elevate doctor, male Elevate doctor.');
})();
