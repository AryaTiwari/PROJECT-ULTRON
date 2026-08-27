import process from 'node:process';
import net from 'node:net';

function isOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

export async function waitFor(host, port, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await isOpen(host, port)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

export async function checkOmniRoute() {
  const host = process.env.OMNIROUTE_HOST || '127.0.0.1';
  const port = Number(process.env.OMNIROUTE_PORT || 20128);
  return isOpen(host, port);
}

export async function checkOpenCode() {
  const host = process.env.OPENCODE_HOST || '127.0.0.1';
  const port = Number(process.env.OPENCODE_PORT || 4096);
  return isOpen(host, port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ omniroute: await checkOmniRoute(), opencode: await checkOpenCode() }));
}
