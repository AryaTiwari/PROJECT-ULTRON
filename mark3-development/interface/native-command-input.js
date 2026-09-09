(() => {
  function ensureAttachmentControls(composer, textarea) {
    let strip = document.querySelector('#attachmentStrip');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'attachmentStrip';
      strip.className = 'attachment-strip';
      composer.insertBefore(strip, composer.firstChild);
    }

    let input = document.querySelector('#fileInput');
    if (!input) {
      input = document.createElement('input');
      input.id = 'fileInput';
      input.type = 'file';
      input.multiple = true;
      input.hidden = true;
      input.accept = '.txt,.md,.csv,.json,.html,.htm,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.m4a,.ogg,.webm,.mp4,.mov,.mkv';
      composer.appendChild(input);
    }

    let button = document.querySelector('#attachButton');
    if (!button) {
      button = document.createElement('button');
      button.id = 'attachButton';
      button.type = 'button';
      button.className = 'attachment-button native-attach-button';
      button.textContent = '+';
      button.title = 'Add context or a file';
      button.setAttribute('aria-label', 'Add context or a file');
      composer.insertBefore(button, textarea);
    }
    return { strip, input, button };
  }

  function install() {
    const stage = document.querySelector('.voice-stage');
    const copy = document.querySelector('.voice-copy');
    const composer = document.querySelector('.composer');
    const textarea = document.querySelector('#input');
    const send = document.querySelector('#send');
    if (!stage || !copy || !composer || !textarea || !send) return false;
    if (document.querySelector('.native-command-dock')) return true;

    const dock = document.createElement('section');
    dock.className = 'native-command-dock';
    dock.dataset.inputContract = 'mark4-ready-v1';
    dock.setAttribute('aria-label', 'ULTRON command input');

    const header = document.createElement('div');
    header.className = 'command-dock-head';
    header.innerHTML = '<span>COMMAND INPUT</span><span id="inputUnderstanding">CONTEXT READY</span>';
    dock.appendChild(header);

    ensureAttachmentControls(composer, textarea);
    dock.appendChild(composer);
    copy.insertAdjacentElement('afterend', dock);

    textarea.placeholder = 'Tell ULTRON what to do…';
    textarea.setAttribute('aria-label', 'ULTRON command');
    textarea.rows = 1;
    send.textContent = 'RUN';
    send.title = 'Run command';

    const toggle = document.querySelector('#chatToggle');
    if (toggle) toggle.textContent = 'TRANSCRIPT';
    const head = document.querySelector('.chat-head');
    if (head) {
      const kicker = head.querySelector('.panel-kicker');
      const strong = head.querySelector('strong');
      if (kicker) kicker.textContent = 'CONVERSATION MEMORY';
      if (strong) strong.textContent = 'TRANSCRIPT';
    }
    const shortcut = document.querySelector('.voice-shortcut');
    if (shortcut) shortcut.textContent = 'Speak or type naturally · recent command context stays active';
    const hint = document.querySelector('.hint');
    if (hint) hint.textContent = 'SPEAK OR TYPE → UNDERSTAND → ACT → RESPOND';

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(112, Math.max(44, textarea.scrollHeight))}px`;
    });

    try {
      const events = new EventSource('/api/events');
      const indicator = document.querySelector('#inputUnderstanding');
      events.addEventListener('input_interpreted', (event) => {
        if (!indicator) return;
        try {
          const data = JSON.parse(event.data || '{}');
          if (data.autoResolved) indicator.textContent = 'PRIOR COMMAND MATCHED';
          else if (data.vague) indicator.textContent = 'CONTEXT CHECKED';
          else indicator.textContent = 'EXPLICIT COMMAND';
          indicator.classList.toggle('resolved', Boolean(data.autoResolved));
        } catch {}
      });
      events.addEventListener('input_clarification', () => {
        if (!indicator) return;
        indicator.textContent = 'CLARIFICATION NEEDED';
        indicator.classList.remove('resolved');
      });
      events.addEventListener('task_completed', () => {
        if (!indicator) return;
        setTimeout(() => {
          indicator.textContent = 'CONTEXT READY';
          indicator.classList.remove('resolved');
        }, 1200);
      });
    } catch {}

    window.__ULTRON_NATIVE_COMMAND_INPUT = {
      version: '1.0.0',
      contract: 'mark4-ready-v1',
      composer,
      textarea,
      send,
    };
    return true;
  }

  window.addEventListener('DOMContentLoaded', install);
})();
