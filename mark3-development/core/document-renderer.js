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

function normalizeTypography(value) {
  return String(value || '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u25CF\u25E6\u2043]/g, '-')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u2194/g, '<->')
    .replace(/\u00D7/g, 'x')
    .replace(/[\u00A0\u202F]/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function cleanInline(value) {
  return normalizeTypography(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapText(text, width = 88) {
  const raw = cleanInline(text);
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

function splitTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('|')) return [];
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cleanInline(cell));
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function markdownBlocks(content) {
  const lines = normalizeLines(content);
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) {
      const text = cleanInline(paragraph.join(' '));
      if (text) blocks.push({ type: 'p', text });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    if (/^```/.test(trimmed)) { flush(); continue; }
    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ type: 'rule' });
      continue;
    }

    const maybeHeader = splitTableRow(trimmed);
    if (maybeHeader.length >= 2 && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flush();
      const headers = maybeHeader;
      index += 2;
      let rowCount = 0;
      while (index < lines.length) {
        const rowLine = lines[index].trim();
        if (!rowLine || !rowLine.includes('|')) { index -= 1; break; }
        const cells = splitTableRow(rowLine);
        if (cells.length < 2) { index -= 1; break; }
        blocks.push({ type: 'tableRow', headers, cells });
        rowCount += 1;
        index += 1;
      }
      if (!rowCount) blocks.push({ type: 'p', text: headers.join(' - ') });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push({ type: `h${heading[1].length}`, text: cleanInline(heading[2]) });
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      flush();
      blocks.push({ type: 'li', text: cleanInline(bullet[1]) });
      continue;
    }
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      flush();
      blocks.push({ type: 'li', text: cleanInline(numbered[2]), marker: `${numbered[1]}.` });
      continue;
    }
    const quote = trimmed.match(/^>\s*(.+)$/);
    if (quote) {
      flush();
      blocks.push({ type: 'quote', text: cleanInline(quote[1]) });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

function pdfSafeText(value) {
  return normalizeTypography(cleanInline(value))
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function sameText(a, b) {
  return cleanInline(a).toLowerCase() === cleanInline(b).toLowerCase();
}

function tableRecord(block) {
  const headers = Array.isArray(block.headers) ? block.headers : [];
  const cells = Array.isArray(block.cells) ? block.cells : [];
  const pairs = headers.map((header, index) => ({ header: cleanInline(header), value: cleanInline(cells[index] || '') }));
  const firstHeader = String(pairs[0]?.header || '').toLowerCase();
  const secondHeader = String(pairs[1]?.header || '').toLowerCase();
  if ((firstHeader === '#' || firstHeader === 'no.' || firstHeader === 'no') && secondHeader === 'brand') {
    return {
      title: [pairs[0]?.value, pairs[1]?.value].filter(Boolean).join('. '),
      details: pairs.slice(2).filter((pair) => pair.value),
    };
  }
  return {
    title: pairs[0]?.value || 'Table row',
    details: pairs.slice(1).filter((pair) => pair.value),
  };
}

function createPdf(content, title = 'ULTRON Document') {
  let blocks = markdownBlocks(content);
  if (blocks[0]?.type === 'h1' && sameText(blocks[0].text, title)) blocks = blocks.slice(1);

  const pages = [];
  let page = [];
  let y = 748;

  const startPage = () => {
    if (page.length) pages.push(page);
    page = [];
    y = 748;
  };

  const ensureRoom = (height = 20) => {
    if (y - height < 58) startPage();
  };

  const addLine = (text, { size = 11, indent = 0, spacing = 15, bold = false } = {}) => {
    ensureRoom(spacing + 3);
    page.push({ text: pdfSafeText(text), size, x: 54 + indent, y, bold });
    y -= spacing;
  };

  const addWrapped = (text, { width = 88, size = 11, indent = 0, spacing = size + 4, bold = false } = {}) => {
    for (const line of wrapText(text, width)) addLine(line, { size, indent, spacing, bold });
  };

  addWrapped(title, { width: 58, size: 19, spacing: 23, bold: true });
  addLine('Generated by ULTRON', { size: 8.5, spacing: 16 });
  y -= 5;

  for (const block of blocks) {
    if (block.type === 'rule') {
      ensureRoom(12);
      addLine('--------------------------------------------------------------', { size: 8, spacing: 12 });
      y -= 3;
      continue;
    }

    if (block.type === 'tableRow') {
      const record = tableRecord(block);
      ensureRoom(48);
      addWrapped(record.title, { width: 72, size: 11.5, spacing: 15, bold: true });
      for (const detail of record.details) {
        addWrapped(`${detail.header}: ${detail.value}`, { width: 78, size: 9.5, indent: 12, spacing: 13 });
      }
      y -= 6;
      continue;
    }

    if (block.type.startsWith('h')) {
      const size = block.type === 'h1' ? 16 : block.type === 'h2' ? 14 : 12.5;
      ensureRoom(size + 18);
      y -= block.type === 'h1' ? 7 : 4;
      addWrapped(block.text, { width: block.type === 'h1' ? 66 : 74, size, spacing: size + 5, bold: true });
      y -= 4;
      continue;
    }

    if (block.type === 'li') {
      const marker = block.marker || '-';
      addWrapped(`${marker} ${block.text}`, { width: 82, size: 10.5, indent: 10, spacing: 14 });
      y -= 2;
      continue;
    }

    if (block.type === 'quote') {
      addWrapped(`> ${block.text}`, { width: 80, size: 10.5, indent: 12, spacing: 14 });
      y -= 3;
      continue;
    }

    addWrapped(block.text, { width: 88, size: 10.5, spacing: 14 });
    y -= 5;
  }
  if (page.length || !pages.length) pages.push(page);

  const objects = [];
  const addObj = (body) => { objects.push(body); return objects.length; };
  addObj('<< /Type /Catalog /Pages 2 0 R >>');
  const pageIds = [];
  objects.push(null); // pages placeholder id 2
  const regularFontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const rows = pages[pageIndex];
    const commands = rows.map((row) => `BT /${row.bold ? 'F2' : 'F1'} ${row.size} Tf ${row.x} ${row.y} Td (${row.text}) Tj ET`);
    commands.push(`BT /F1 8 Tf 54 30 Td (ULTRON  |  Page ${pageIndex + 1} of ${pages.length}) Tj ET`);
    const stream = commands.join('\n');
    const contentId = addObj(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
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
  if (block.type === 'rule') return '<w:p/>';
  if (block.type === 'tableRow') {
    const record = tableRecord(block);
    const rows = [
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEscape(record.title)}</w:t></w:r></w:p>`,
      ...record.details.map((detail) => `<w:p><w:pPr><w:ind w:left="360"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(`${detail.header}: ${detail.value}`)}</w:t></w:r></w:p>`),
    ];
    return rows.join('\n');
  }
  const marker = block.type === 'li' ? `${block.marker || '-'} ` : block.type === 'quote' ? '> ' : '';
  const text = `${marker}${cleanInline(block.text)}`;
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function createDocx(content, title = 'ULTRON Document') {
  let bodyBlocks = markdownBlocks(content);
  if (bodyBlocks[0]?.type === 'h1' && sameText(bodyBlocks[0].text, title)) bodyBlocks = bodyBlocks.slice(1);
  const blocks = [{ type: 'h1', text: title }, ...bodyBlocks];
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

module.exports = { createPdf, createDocx, markdownBlocks, wrapText, normalizeTypography, cleanInline };
