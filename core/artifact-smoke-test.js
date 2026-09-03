const fs = require('fs');
const path = require('path');
const artifacts = require('./artifacts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const result = artifacts.createPdf({
  title: 'ULTRON Artifact Smoke Test',
  filename: 'ultron-artifact-smoke-test.pdf',
  content: '# Artifact Test\n\n- Real PDF generation\n- Local artifact URL\n\nDownload integrity verified.',
});

assert(result.created === true, 'Artifact service did not report creation.');
assert(result.type === 'pdf', 'Artifact type is not pdf.');
assert(result.url === '/api/artifacts/ultron-artifact-smoke-test.pdf', 'Artifact URL is not the expected server path.');
assert(!/sandbox:|file:/i.test(result.url), 'Artifact URL contains a forbidden fake/local scheme.');
assert(fs.existsSync(result.path), 'Generated PDF file does not exist.');
const bytes = fs.readFileSync(result.path);
assert(bytes.length > 200, 'Generated PDF is unexpectedly small.');
assert(bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-1.4'), 'Generated file is not a PDF.');
const lookup = artifacts.getArtifact(path.basename(result.path));
assert(lookup && lookup.file === result.path, 'Artifact lookup failed.');

fs.rmSync(result.path, { force: true });
console.log('ULTRON artifact smoke test passed.');
