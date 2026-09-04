// Loaded only by the Mark 3 server process. Delay installation until server.js has
// finished loading the normal assistant so Forge can wrap it without circular imports.
setImmediate(() => {
  try {
    const result = require('./bootstrap').install();
    console.log(`[Mark 3] ULTRON Forge ready${result.recovered?.length ? `; recovered ${result.recovered.length} mission(s)` : ''}.`);
  } catch (error) {
    console.error(`[Mark 3] ULTRON Forge bootstrap failed: ${error.message}`);
  }
});
