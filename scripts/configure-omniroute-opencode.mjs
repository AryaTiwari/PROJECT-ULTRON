import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load: loadCredentials } = require('../core/credentials/local-store');

const host = process.env.OMNIROUTE_HOST || '127.0.0.1';
const port = Number(process.env.OMNIROUTE_PORT || 20128);
const baseURL = `http://${host}:${port}/v1`;
const configPath = path.resolve(process.env.ULTRON_OPENCODE_CONFIG || path.join(process.cwd(), '.ultron', 'opencode-omniroute.json'));

async function readCatalog() {
  const credentials = await loadCredentials();
  const apiKey = String(credentials.OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim();
  if (!apiKey) throw new Error('OmniRoute API key is not available in the ULTRON credential vault/environment.');

  const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OmniRoute model catalog HTTP ${response.status}: ${raw.slice(0, 1000)}`);
  const data = raw ? JSON.parse(raw) : {};
  const models = Array.isArray(data?.data) ? data.data : [];
  if (!models.length) throw new Error('OmniRoute model catalog returned no models.');
  return { apiKey, models };
}

function buildConfig(models) {
  const modelMap = {};
  for (const model of models) {
    const id = String(model?.id || '').trim();
    if (!id) continue;
    modelMap[id] = {
      name: String(model?.name || model?.id || id),
      limit: {
        context: Number(model?.context_length || model?.contextWindow || model?.context_length_tokens || 0) || undefined,
        output: Number(model?.max_output_tokens || model?.outputTokenLimit || 0) || undefined,
      },
    };
    for (const key of ['limit']) {
      const value = modelMap[id][key];
      if (value && !value.context && !value.output) delete modelMap[id][key];
    }
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      omniroute: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OmniRoute — ULTRON Fabric',
        options: {
          baseURL,
          apiKey: '{env:OMNIROUTE_API_KEY}',
        },
        models: modelMap,
      },
    },
  };
}

async function main() {
  const { apiKey, models } = await readCatalog();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(buildConfig(models), null, 2), 'utf8');
  process.stdout.write(JSON.stringify({ configPath, modelCount: models.length, apiKey }, null, 2));
}

main().catch(error => {
  console.error(`[OmniRoute Config] ${error.message}`);
  process.exit(1);
});
