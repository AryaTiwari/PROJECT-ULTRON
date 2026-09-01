const integrations = require('../core/integrations');

(async () => {
  try {
    const catalog = await integrations.models();
    const raw = Array.isArray(catalog?.data) ? catalog.data : Array.isArray(catalog?.models) ? catalog.models : [];
    const ids = [...new Set(raw.map((item) => typeof item === 'string' ? item : item?.id || item?.model || item?.name || '').map(String).map((value) => value.trim()).filter(Boolean))];
    const usable = ids.filter((id) => !/big[-_ ]?pickle/i.test(id));
    console.log(`OmniRoute /v1/models: PASS (${ids.length} concrete models returned).`);
    if (!usable.length) throw new Error('No concrete model remains after Big Pickle exclusion.');
    const model = usable[0];
    console.log(`Selected concrete model for live inference test: ${model}`);
    const result = await integrations.chat([{ role: 'user', content: 'Reply with exactly: OMNIROUTE_OK' }], model, null);
    const content = result?.choices?.[0]?.message?.content || result?.response || result?.text || '';
    if (!String(content).trim()) throw new Error('OmniRoute chat returned no usable text.');
    console.log(`OmniRoute /v1/chat/completions: PASS (model=${model}).`);
    console.log(`Live response: ${String(content).trim().slice(0, 120)}`);
    console.log('OmniRoute end-to-end test: PASS.');
  } catch (error) {
    console.error(`OmniRoute end-to-end test: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
})();
