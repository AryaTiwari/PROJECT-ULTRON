const fs = require('fs');
const crypto = require('crypto');
const { emit } = require('./events');

function verifyText(text) {
  const value = String(text || '').trim();
  return { ok: Boolean(value), check: 'response_non_empty', details: value ? 'Response contains displayable text.' : 'Response was empty.' };
}

function verifyFile(file, expectedContentHash = null) {
  if (!fs.existsSync(file)) return { ok: false, check: 'file_exists', details: 'File does not exist.' };
  const content = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return { ok: !expectedContentHash || hash === expectedContentHash, check: 'file_hash', hash, expectedContentHash };
}

function report(result, operation) { emit('verification_complete', { operation, result }); return result; }

module.exports = { verifyText, verifyFile, report };
