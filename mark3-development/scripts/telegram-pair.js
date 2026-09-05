const telegram = require('../core/telegram-remote');

(async () => {
  if (!telegram.status().tokenConfigured) {
    console.error('ULTRON Telegram pairing: TELEGRAM_BOT_TOKEN is not configured in the root .env.');
    process.exitCode = 1;
    return;
  }
  try {
    const chats = await telegram.discoverChats();
    if (!chats.length) {
      console.log('No Telegram chat update is waiting. Open your bot in Telegram, send /start, then run this command again.');
      return;
    }
    console.log('ULTRON Telegram pairing candidates (bot token is not printed):');
    for (const chat of chats) {
      console.log(`TELEGRAM_ALLOWED_CHAT_ID=${chat.chatId}    type=${chat.chatType || 'unknown'}    username=${chat.username || 'unknown'}`);
    }
    console.log('Copy only the TELEGRAM_ALLOWED_CHAT_ID line for your private chat into the root .env, then restart Ultron.');
  } catch (error) {
    console.error(`ULTRON Telegram pairing failed: ${error.message}`);
    process.exitCode = 1;
  }
})();
