const os = require('os');
const fs = require('fs');
const path = require('path');
const { registerTool } = require('../core/executor');
const voice = require('../core/voice');

function registerBuiltinTools() {
  registerTool('system_info', async () => ({
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    release: os.release(),
    cpus: os.cpus().length,
    memory_gb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
    free_memory_gb: Number((os.freemem() / 1024 ** 3).toFixed(2)),
    uptime_seconds: os.uptime(),
    username: os.userInfo().username,
  }), {
    description: 'Read non-destructive local system information.',
    requiresConfirmation: false,
    risk: 'low',
  });

  registerTool('list_directory', async (input = {}) => {
    const requested = String(input.path || '.');
    const resolved = path.resolve(requested);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }));
  }, {
    description: 'List files and folders in a requested local directory.',
    requiresConfirmation: false,
    risk: 'low',
  });

  registerTool('open_url', async (input = {}) => {
    const url = String(input.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed.');
    const { execFile } = require('child_process');
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise((resolve, reject) => execFile(command, args, error => error ? reject(error) : resolve()));
    return { opened: true, url };
  }, {
    description: 'Open a web URL using the system default browser.',
    requiresConfirmation: true,
    risk: 'medium',
  });

  registerTool('speak_text', async (input = {}) => voice.synthesize(input.text, {
    filename: input.filename,
  }), {
    description: 'Convert text into ULTRON voice audio using the configured TTS provider.',
    requiresConfirmation: false,
    risk: 'low',
  });
}

module.exports = { registerBuiltinTools };