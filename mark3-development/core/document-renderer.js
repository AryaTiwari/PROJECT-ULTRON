const { createZip } = require('./archive');

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeLines(content) {
  return String(content || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd());
}

function wrapText(text, width = 88) {
  const raw = String(text || '').trim();
  if (!raw) return [''];
  const words = raw.split(/\s+/);
  const out = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

function markdownBlocks(content) {
  const lines = normalizeLines(content);
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ type: 'p', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push({ type: `h${heading[1].length}`, text: heading[2].trim() });
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      flush();
      blocks.push({ type: 'li', text: bullet[1].trim() });
      continue;
    }
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      flush();
      blocks.push({ type: 'li', text: numbered[1].trim() });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

function pdfEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7E]/g, '?');
}

function createPdf(content, title = 'ULTRON Document') {
  const blocks = markdownBlocks(content);
  const pages = [];
  let page = [];
  let y = 760;

  const addLine = (text, size = 11, indent = 0, spacing = 15) => {
    if (y < 60) {
      pages.push(page);
      page = [];
      y = 760;
    }
    page.push({ text, size, x: 54 + indent, y });
    y -= spacing;
  };

  addLine(title, 18, 0, 24);
  y -= 8;
  for (const block of blocks) {
    const size = block.type === 'h1' ? 17 : block.type === 'h2' ? 15 : block.type === 'h3' ? 13 : 11;
    const width = block.type.startsWith('h') ? 72 : 92;
    const prefix = block.type === 'li' ? '• ' : '';
    const indent = block.type === 'li' ? 12 : 0;
    for (const line of wrapText(`${prefix}${block.text}`, width)) addLine(line, size, indent, size + 4);
    y -= block.type.startsWith('h') ? 6 : 4;
  }
  if (page.length || !pages.length) pages.push(page);

  const objects = [];
  const addObj = (body) => { objects.push(body); return objects.length; };
  const catalogId = addObj('<< /Type /Catalog /Pages 2 0 R >>');
  void catalogId;
  const pageIds = [];
  const fontId = 3;
  objects.push(null); // pages placeholder id 2
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (const rows of pages) {
    const commands = rows.map((row) => `BT /F1 ${row.size} Tf ${row.x} ${row.y} Td (${pdfEscape(row.text)}) Tj ET`).join('\n');
    const contentId = addObj(`<< /Length ${Buffer.byteLength(commands, 'ascii')} >>\nstream\n${commands}\nendstream`);
    const pageId = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets[i + 1] = Buffer.byteLength(pdf, 'ascii');
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

function wordParagraph(block) {
  const style = block.type === 'h1' ? 'Heading1' : block.type === 'h2' ? 'Heading2' : block.type === 'h3' ? 'Heading3' : null;
  const text = block.type === 'li' ? `• ${block.text}` : block.text;
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function createDocx(content, title = 'ULTRON Document') {
  const blocks = [{ type: 'h1', text: title }, ...markdownBlocks(content)];
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${blocks.map(wordParagraph).join('\n')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>`;

  return createZip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
  ]);
}

module.exports = { createPdf, createDocx, markdownBlocks, wrapText };
