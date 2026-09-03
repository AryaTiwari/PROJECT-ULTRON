(() => {
  const baseFetch = window.fetch.bind(window);
  const pending = [];

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
      reader.readAsDataURL(file);
    });
  }

  function renderPending() {
    const strip = document.querySelector('#attachmentStrip');
    if (!strip) return;
    strip.innerHTML = '';
    for (const item of pending) {
      const chip = document.createElement('div');
      chip.className = `attachment-chip${item.uploading ? ' uploading' : ''}`;
      chip.innerHTML = `<span title="${String(item.name || '').replace(/"/g, '&quot;')}">${item.uploading ? 'UPLOADING · ' : ''}${item.name} · ${formatBytes(item.size)}</span><button type="button" aria-label="Remove attachment">×</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        renderPending();
      });
      strip.appendChild(chip);
    }
  }

  async function uploadFile(file) {
    const item = { name: file.name, size: file.size, mime: file.type || 'application/octet-stream', uploading: true, id: null };
    pending.push(item);
    renderPending();
    try {
      const dataBase64 = await toBase64(file);
      const response = await baseFetch('/api/files/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, mime: item.mime, dataBase64 }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) throw new Error(data?.error || 'Upload failed.');
      item.id = data.file.id;
      item.name = data.file.name;
      item.mime = data.file.mime;
      item.size = data.file.size;
      item.uploading = false;
    } catch (error) {
      item.uploading = false;
      item.error = error.message;
      item.name = `${item.name} · FAILED`;
    }
    renderPending();
  }

  function clearSent(ids) {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (ids.includes(pending[i].id)) pending.splice(i, 1);
    }
    renderPending();
  }

  function renderArtifacts(artifacts = []) {
    if (!Array.isArray(artifacts) || !artifacts.length) return;
    const messages = document.querySelector('#messages');
    if (!messages) return;
    for (const artifact of artifacts) {
      if (!artifact?.id || document.querySelector(`[data-artifact-id="${CSS.escape(artifact.id)}"]`)) continue;
      const card = document.createElement('div');
      card.className = 'artifact-card';
      card.dataset.artifactId = artifact.id;
      const mime = String(artifact.mime || '');
      const name = artifact.name || 'Generated artifact';
      const inlineUrl = artifact.inlineUrl || `/api/files/download?id=${encodeURIComponent(artifact.id)}&inline=1`;
      const downloadUrl = artifact.downloadUrl || `/api/files/download?id=${encodeURIComponent(artifact.id)}`;
      const media = mime.startsWith('image/')
        ? `<img src="${inlineUrl}" alt="${String(name).replace(/"/g, '&quot;')}" loading="lazy">`
        : mime.startsWith('video/')
          ? `<video src="${inlineUrl}" controls preload="metadata"></video>`
          : '';
      card.innerHTML = `<div class="artifact-kicker">ULTRON ARTIFACT</div><div class="artifact-name">${name}</div>${media}<a class="artifact-link" href="${downloadUrl}">OPEN / SAVE FILE</a>`;
      messages.appendChild(card);
    }
    messages.scrollTop = messages.scrollHeight;
  }

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (!/(?:^|\/)api\/chat(?:$|[?#])/.test(url)) return baseFetch(input, init);

    let body = null;
    try { body = typeof init.body === 'string' ? JSON.parse(init.body) : { ...(init.body || {}) }; } catch {}
    if (!body || typeof body !== 'object') return baseFetch(input, init);

    const attachmentIds = pending.filter((item) => item.id && !item.uploading && !item.error).map((item) => item.id);
    if (attachmentIds.length) body.attachments = [...new Set([...(Array.isArray(body.attachments) ? body.attachments : []), ...attachmentIds])];
    const next = { ...init, body: JSON.stringify(body) };

    return baseFetch(input, next).then(async (response) => {
      try {
        const data = await response.clone().json();
        if (response.ok && attachmentIds.length) clearSent(attachmentIds);
        if (data?.artifacts) setTimeout(() => renderArtifacts(data.artifacts), 40);
      } catch {}
      return response;
    });
  };

  window.addEventListener('DOMContentLoaded', () => {
    const composer = document.querySelector('.composer');
    const textarea = document.querySelector('#input');
    if (!composer || !textarea) return;

    const strip = document.createElement('div');
    strip.id = 'attachmentStrip';
    strip.className = 'attachment-strip';
    composer.insertBefore(strip, composer.firstChild);

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.accept = '.txt,.md,.csv,.json,.html,.htm,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.m4a,.ogg,.webm,.mp4,.mov,.mkv';
    composer.appendChild(input);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'attachment-button';
    button.textContent = '+ FILE';
    button.title = 'Attach a file for ULTRON to read';
    composer.insertBefore(button, textarea);
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';
      for (const file of files.slice(0, 4)) void uploadFile(file);
    });
  });

  window.__ULTRON_ATTACHMENTS = { pending, renderArtifacts };
})();
