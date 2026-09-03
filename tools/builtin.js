const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { registerTool } = require('../core/executor');
const voice = require('../core/voice');
const github = require('../core/github-controller');
const modelIntelligence = require('../core/model-intelligence');
const artifacts = require('../core/artifacts');

function registerBuiltinTools() {
  registerTool('system_info', async () => ({ platform: process.platform, arch: process.arch, hostname: os.hostname(), release: os.release(), cpus: os.cpus().length, memory_gb: Number((os.totalmem() / 1024 ** 3).toFixed(2)), free_memory_gb: Number((os.freemem() / 1024 ** 3).toFixed(2)), uptime_seconds: os.uptime(), username: os.userInfo().username }), {
    description: 'Read non-destructive local system information.', requiresConfirmation: false, risk: 'low', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });

  registerTool('list_directory', async (input = {}) => {
    const resolved = path.resolve(String(input.path || '.'));
    return fs.readdirSync(resolved, { withFileTypes: true }).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
  }, {
    description: 'List files and folders in a requested local directory.', requiresConfirmation: false, risk: 'low',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  });

  registerTool('read_file', async (input = {}) => {
    const resolved = path.resolve(String(input.path || ''));
    if (!resolved || !fs.existsSync(resolved)) throw new Error('File does not exist.');
    return { path: resolved, content: fs.readFileSync(resolved, 'utf8').slice(0, 200000) };
  }, {
    description: 'Read a local UTF-8 text file.', requiresConfirmation: false, risk: 'low',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
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

  registerTool('create_pdf', async (input = {}) => artifacts.createPdf(input), {
    description: 'Create a real local PDF artifact and return its actual ULTRON download URL. Use this whenever the user asks to create, generate, export, send, or provide a PDF. Never invent a sandbox:, file:, or download URL instead.',
    requiresConfirmation: false,
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title.' },
        content: { type: 'string', description: 'Complete document content. Simple Markdown headings and bullets are supported.' },
        filename: { type: 'string', description: 'Optional PDF filename.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
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

  registerTool('github_repo_info', async input => github.getRepo(input), {
    description: 'Read ULTRON GitHub repository metadata.', requiresConfirmation: false, risk: 'low',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });
  registerTool('github_list_files', async input => github.listFiles(input), {
    description: 'List files and directories in the ULTRON GitHub repository.', requiresConfirmation: false, risk: 'low',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, ref: { type: 'string' } }, additionalProperties: false },
  });
  registerTool('github_read_file', async input => github.readFile(input), {
    description: 'Read a UTF-8 file from the ULTRON GitHub repository.', requiresConfirmation: false, risk: 'low',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, ref: { type: 'string' } }, required: ['path'], additionalProperties: false },
  });
  registerTool('github_create_file', async input => github.createFile(input), {
    description: 'Create a UTF-8 file in the ULTRON GitHub repository automatically.', requiresConfirmation: false, risk: 'medium',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  });
  registerTool('github_update_file', async input => github.updateFile(input), {
    description: 'Update an existing UTF-8 file in the ULTRON GitHub repository automatically. Reads the current SHA when one is not supplied.', requiresConfirmation: false, risk: 'medium',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string' }, sha: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  });

  registerTool('model_catalog', async input => modelIntelligence.catalog(input), {
    description: 'Inspect ULTRON model intelligence: current configured model, accessible model catalog, provider counts, and recent performance history. Use before rating or comparing models.',
    requiresConfirmation: false,
    risk: 'low',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, taskType: { type: 'string' }, refresh: { type: 'boolean' } }, additionalProperties: false },
  });
}

module.exports = { registerBuiltinTools };
