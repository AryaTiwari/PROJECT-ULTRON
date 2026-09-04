const pipeline = require('../core/reel-pipeline');

async function main() {
  const args = process.argv.slice(2);
  const useAi = args.includes('--ai');
  const brief = args.filter((arg) => arg !== '--ai').join(' ').trim()
    || 'Why small creators stop growing after their first viral reel';

  console.log(`ULTRON Reel render starting: ${brief}`);
  console.log(`Director: ${useAi ? 'cloud AI with deterministic fallback' : 'deterministic test mode'}`);
  const result = await pipeline.build(brief, {
    durationSec: 15,
    style: 'dark cinematic fast-paced creator reel',
    localOnly: !useAi,
  });

  if (!result.ok) {
    console.error(`ULTRON Reel render paused: ${result.blocker || result.job?.state || 'unknown blocker'}`);
    if (result.paths?.job) console.error(`Job state: ${result.paths.job}`);
    process.exitCode = 1;
    return;
  }

  console.log('ULTRON Reel rendered successfully.');
  console.log(`Output: ${result.output.path}`);
  console.log(`Size: ${(result.output.bytes / 1024 / 1024).toFixed(2)} MB`);
  if (result.output.durationSec) console.log(`Duration: ${result.output.durationSec.toFixed(2)} sec`);
  console.log(`Narration: ${result.narration?.ok ? 'ready' : 'not available; silent render used'}`);
  console.log('State: rendered');
}

main().catch((error) => {
  console.error(`ULTRON Reel render failed: ${error.message}`);
  process.exitCode = 1;
});
