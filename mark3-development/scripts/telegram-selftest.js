const telegram = require('../core/telegram-remote');
const tools = require('../core/free-tool-registry');

function assert(condition, message) { if (!condition) throw new Error(message); }

const status = telegram.status();
assert(status.implemented === true, 'Telegram remote connector must remain implemented.');
assert(status.longPolling === true, 'Telegram remote must use local long polling unless deliberately redesigned.');
assert(/single-chat allowlist/i.test(status.security || ''), 'Telegram remote must preserve explicit single-chat allowlist security.');
assert(status.requestScopedLocalVoiceSuppression === true, 'Remote Telegram requests must not unexpectedly speak through the PC by default.');

const chunks = telegram.chunkText('a'.repeat(9000), 3900);
assert(chunks.length >= 3 && chunks.every((row) => row.length <= 3900), 'Telegram responses must be split under message-size limits.');

const registry = tools.byId('telegram-bot');
assert(registry?.implemented === true, 'Free-tool registry must reflect the actual Telegram implementation.');
assert(registry?.env?.includes('TELEGRAM_ALLOWED_CHAT_ID'), 'Telegram readiness must require the private-chat allowlist, not only the bot token.');

console.log('ULTRON Telegram self-test passed: implemented remote surface, message chunking, local-voice suppression and single-chat allowlist validated.');
