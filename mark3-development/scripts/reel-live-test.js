const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const sources = require('../core/reel-sources');

async function main() {
  const status = sources.status();
  if (!status.pexelsConfigured) {
    console.error('ULTRON Reel live test failed: PEXELS_API_KEY is not configured in the project .env.');
    process.exitCode = 1;
    return;
  }

  const query = process.argv.slice(2).join(' ').trim() || 'content creator filming smartphone vertical';
  const items = await sources.searchPexels(query, { orientation: 'portrait', size: 'medium', perPage: 6 });
  if (!items.length) throw new Error(`Pexels returned no usable video results for: ${query}`);

  const selected = items.find((item) => Number(item.height) > Number(item.width)) || items[0];
  const dir = path.resolve(config.projectRoot, '.ultron', 'reels', '_source-test');
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, sources.safeAssetName(selected, 1));
  const saved = await sources.downloadAsset(selected, destination, { maxBytes: 80 * 1024 * 1024 });

  console.log(`ULTRON Pexels source verified: ${selected.width || '?'}x${selected.height || '?'} video downloaded successfully.`);
  console.log(`Saved: ${saved.path}`);
  console.log(`Size: ${(saved.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Attribution: ${saved.attribution || 'Pexels'}`);
  console.log('No API key or secret was printed.');
}

main().catch((error) => {
  console.error(`ULTRON Reel live test failed: ${error.message}`);
  process.exitCode = 1;
});
