const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { registerTool } = require('../core/executor');
const voice = require('../core/voice');

function registerBuiltinTools() {
  registerTool('system_info', async () => ({ platform: process.platform, arch: process.arch, hostname: os.hostname(), release: os.release(), cpus: os.cpus().length, memory_gb: Number((os.totalmem() / 1024 ** 3).toFixed(2)), free_memory_gb: Number((os.freemem() / 1024 ** 3).toFixed(2)), uptime_seconds: os.uptime(), username: os.userInfo().username }), {
    description: 'Read non-destructive local system information.', requiresConfirmation: false, risk: 'low', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });

  registerTool('list_directory', async (input = {}) => {
    const resolved = path.resolve(String(input.path || '.'));
    return fs.readdirSync(resolved, { withFileTypes: true }).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
  }, {
    description: 'List files and folders in a requested local directory.', requiresConfirmation: false, risk: 'low',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path.' } }, additionalProperties: false },
  });

  registerTool('read_file', async (input = {}) => {
    const resolved = path.resolve(String(input.path || ''));
    if (!resolved || !fs.existsSync(resolved)) throw new Error('File does not exist.');
    return { path: resolved, content: fs.readFileSync(resolved, 'utf8').slice(0, 200000) };
  }, {
    description: 'Read a local UTF-8 text file.', requiresConfirmation: false, risk: 'low',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path.' } }, required: ['path'], additionalProperties: false },
  });

  registerTool('write_file', async (input = {}) => {
    const resolved = path.resolve(String(input.path || ''));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, String(input.content || ''), 'utf8');
    return { written: true, path: resolved, bytes: Buffer.byteLength(String(input.content || ''), 'utf8') };
  }, {
    description: 'Write or replace a local UTF-8 text file. Requires confirmation.', requiresConfirmation: true, destructive: true, risk: 'high',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  });

  registerTool('run_powershell', async (input = {}) => {
    if (process.platform !== 'win32') throw new Error('PowerShell tool currently targets Windows.');
    const command = String(input.command || '').trim();
    if (!command) throw new Error('PowerShell command is required.');
    const result = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: Number(input.timeoutMs) || 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
    return { stdout: result.stdout, stderr: result.stderr };
  }, {
    description: 'Execute a PowerShell command on the local Windows machine. Always requires confirmation.', requiresConfirmation: true, destructive: true, risk: 'high',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command'], additionalProperties: false },
  });

  registerTool('open_url', async (input = {}) => {
    const url = String(input.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed.');
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise((resolve, reject) => execFile(command, args, error => error ? reject(error) : resolve()));
    return { opened: true, url };
  }, {
    description: 'Open a web URL using the system default browser.', requiresConfirmation: true, risk: 'medium',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  });

  registerTool('speak_text', async (input = {}) => voice.speakAndPlay(input.text, { filename: input.filename }), {
    description: 'Convert text into ULTRON cloned voice audio and play it on the local Windows machine.', requiresConfirmation: false, risk: 'low',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, filename: { type: 'string' } }, required: ['text'], additionalProperties: false },
  });
}

module.exports = { registerBuiltinTools };