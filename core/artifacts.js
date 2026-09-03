const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const artifactRoot = path.resolve(process.env.ULTRON_ARTIFACT_DIR || '.ultron/artifacts');

function ensureArtifactRoot() {
  fs.mkdirSync(artifactRoot, { recursive: true });
  return artifactRoot;
}

function sanitizeFilename(value, fallback = 'ultron-document.pdf') {
  const raw = String(value || '').trim() || fallback;
  const base = path.basename(raw).replace(/[^a-zA-Z0-9._ -]+/g, '-').replace(/\s+/g, '_');
  const withExt = /\.pdf$/i.test(base) ? base : `${base}.pdf`;
  return withExt.slice(0, 140) || fallback;
}

function safeArtifactPath(filename) {
  const root = ensureArtifactRoot();
  const file = path.resolve(root, path.basename(filename));
  if (!file.startsWith(root + path.sep)) throw new Error('Invalid artifact path.');
  return file;
}

function toPdfSafeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
}

function escapePdfText(value) {
  return toPdfSafeText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapLine(text, maxChars = 88) {
  const source = toPdfSafeText(text);
  if (!source.trim()) return [''];
  const words = source.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (word.length <= maxChars) {
      line = word;
    } else {
      let rest = word;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function normalizeDocument(title, content) {
  const titleText = toPdfSafeText(title || 'ULTRON Document').trim() || 'ULTRON Document';
  const raw = String(content || '').replace(/\r\n/g, '\n');
  const blocks = raw.split('\n');
  const lines = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) {
      lines.push({ text: '', size: 11, leading: 16 });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const size = heading[1].length === 1 ? 16 : heading[1].length === 2 ? 14 : 12;
      for (const line of wrapLine(heading[2], size >= 14 ? 72 : 82)) lines.push({ text: line, size, leading: size + 6 });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    const prefix = bullet ? '- ' : '';
    const body = bullet ? bullet[1] : trimmed;
    for (const [index, line] of wrapLine(body, bullet ? 82 : 88).entries()) {
      lines.push({ text: `${index === 0 ? prefix : '  '}${line}`, size: 11, leading: 16 });
    }
  }
  return { title: titleText, lines };
}

function buildPdfBuffer({ title, content }) {
  const doc = normalizeDocument(title, content);
  const pages = [];
  let current = [];
  let y = 744;

  const pushLine = (entry) => {
    if (y - entry.leading < 54) {
      pages.push(current);
      current = [];
      y = 744;
    }
    current.push({ ...entry, y });
    y -= entry.leading;
  };

  pushLine({ text: doc.title, size: 20, leading: 30 });
  pushLine({ text: '', size: 11, leading: 14 });
  for (const line of doc.lines) pushLine(line);
  if (current.length || !pages.length) pages.push(current);

  const objects = [];
  const addObject = (body) => { objects.push(body); return objects.length; };
  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];

  for (const page of pages) {
    let stream = 'BT\n';
    let activeSize = null;
    for (const line of page) {
      if (activeSize !== line.size) {
        stream += `/F1 ${line.size} Tf\n`;
        activeSize = line.size;
      }
      stream += `1 0 0 1 54 ${line.y} Tm (${escapePdfText(line.text)}) Tj\n`;
    }
    stream += 'ET\n';
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}endstream`);
    const pageId = addObject(null);
    pageIds.push({ pageId, contentId });
  }

  const pagesId = addObject(null);
  const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  for (const item of pageIds) {
    objects[item.pageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${item.contentId} 0 R >>`;
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(item => `${item.pageId} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n%ULTRON\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

function createPdf(input = {}) {
  const title = String(input.title || 'ULTRON Document').trim();
  const content = String(input.content || '').trim();
  if (!content) throw new Error('PDF content is required.');
  const filename = sanitizeFilename(input.filename || title || `ultron-${crypto.randomUUID()}.pdf`);
  const file = safeArtifactPath(filename);
  const buffer = buildPdfBuffer({ title, content });
  fs.writeFileSync(file, buffer);
  return {
    created: true,
    type: 'pdf',
    filename,
    path: file,
    bytes: buffer.length,
    url: `/api/artifacts/${encodeURIComponent(filename)}`,
    markdown: `[Download ${filename}](/api/artifacts/${encodeURIComponent(filename)})`,
  };
}

function getArtifact(filename) {
  const safeName = path.basename(decodeURIComponent(String(filename || '')));
  if (!safeName) return null;
  const file = safeArtifactPath(safeName);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { file, filename: safeName, stat: fs.statSync(file) };
}

module.exports = { artifactRoot, createPdf, getArtifact, sanitizeFilename };
