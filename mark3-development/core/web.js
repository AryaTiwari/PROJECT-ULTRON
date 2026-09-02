const dns = require('node:dns').promises;
const net = require('node:net');

const DEFAULT_TIMEOUT_MS = Math.max(3000, Number(process.env.ULTRON_M3_WEB_TIMEOUT_MS || 12000));
const DEFAULT_MAX_BYTES = Math.max(64 * 1024, Number(process.env.ULTRON_M3_WEB_MAX_BYTES || 1024 * 1024));
const DEFAULT_MAX_TEXT = Math.max(4000, Number(process.env.ULTRON_M3_WEB_MAX_TEXT_CHARS || 24000));

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL is required.');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only public HTTP/HTTPS URLs are supported.');
  return url;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  const value = ip.toLowerCase();
  return value === '::1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd');
}

async function assertPublicHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Local/private URLs are not allowed through the public web fetcher.');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Local/private URLs are not allowed through the public web fetcher.');
    return;
  }
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('The URL resolved to a local/private network address and was blocked.');
  }
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text || '')
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  const withoutNoise = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/section|\/article|\/h[1-6]|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutNoise)
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function titleFromHtml(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const remaining = Math.max(0, maxBytes - (total - buffer.length));
      if (remaining) chunks.push(buffer.subarray(0, remaining));
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPage(input, options = {}) {
  const requested = normalizeUrl(input);
  await assertPublicHost(requested);
  const controller = new AbortController();
  const timeoutMs = Math.max(3000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(requested, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'ULTRON-Mark3/1.0 (+local personal assistant)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    const finalUrl = new URL(response.url || requested.toString());
    await assertPublicHost(finalUrl);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok) throw new Error(`Web fetch HTTP ${response.status} for ${finalUrl.hostname}.`);
    const raw = await readLimitedBody(response, Number(options.maxBytes || DEFAULT_MAX_BYTES));
    const text = contentType.includes('html') ? htmlToText(raw) : raw.trim();
    if (!text) throw new Error('The page returned no readable text content.');
    return {
      requestedUrl: requested.toString(),
      url: finalUrl.toString(),
      status: response.status,
      contentType,
      title: contentType.includes('html') ? titleFromHtml(raw) : '',
      text: text.slice(0, Number(options.maxTextChars || DEFAULT_MAX_TEXT)),
      truncated: text.length > Number(options.maxTextChars || DEFAULT_MAX_TEXT),
    };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`Web fetch timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractFirstUrl(text) {
  const match = String(text || '').match(/(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[\/?#][^\s<>()]*)?/i);
  return match ? match[0].replace(/[),.;!?]+$/, '') : null;
}

module.exports = { fetchPage, extractFirstUrl, normalizeUrl, htmlToText };
