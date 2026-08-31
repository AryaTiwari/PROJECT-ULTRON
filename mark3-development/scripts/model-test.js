const models = require('../core/model-intelligence');
(async()=>{ try { const result = await models.intelligence(); console.log(`Live OmniRoute model catalog: ${result.live.count} models.`); console.log(`Observed performance entries: ${result.observed.length}.`); } catch(error) { console.log(`Model catalog unavailable (non-fatal preflight): ${error.message}`); } })();
