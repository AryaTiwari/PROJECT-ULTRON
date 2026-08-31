/* ──────────────────────────────────────────────────────────────
   ULTRON Interface — app.js
   All original voice/daemon/orb logic preserved.
   Additions: markdown rendering, conversation persistence,
   typing indicator, copy buttons, new chat.
   ────────────────────────────────────────────────────────────── */

const composer = document.getElementById("composer");
const input = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const conversation = document.getElementById("conversation");
const hero = document.getElementById("hero");
const statusText = document.getElementById("statusText");
const orbWrap = document.getElementById("orbWrap");
const voiceToggle = document.getElementById("voiceToggle");
const voiceToggleText = document.getElementById("voiceToggleText");
const wakeToggle = document.getElementById("wakeToggle");
const wakeToggleText = document.getElementById("wakeToggleText");
const voiceStateText = document.getElementById("voiceStateText");
const wakeStateText = document.getElementById("wakeStateText");
const newChatBtn = document.getElementById("newChat");

let voiceEnabled = localStorage.getItem("ultron.voice.enabled") !== "false";
let wakeEnabled = localStorage.getItem("ultron.wake.enabled") === "true";
let daemonState = { running: false, ready: false, state: "idle", wakeWord: "ULTRON" };

/* ── Markdown Setup ────────────────────────────────────────── */

if (typeof marked !== "undefined") {
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: function (code, lang) {
      if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch (_) { /* fall through */ }
      }
      return code;
    },
  });
}

function renderMarkdown(text) {
  if (!text) return "";
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escapeHtml(text);
  }
  try {
    const raw = marked.parse(text);
    return DOMPurify.sanitize(raw);
  } catch (_) {
    return escapeHtml(text);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ── Conversation Persistence ──────────────────────────────── */

const STORAGE_KEY = "ultron.conversations";
const CONV_ID_KEY = "ultron.currentConv";

function loadConversations() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch (_) { return {}; }
}

function saveConversations(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch (_) { /* quota exceeded — silently continue */ }
}

function getCurrentConversationId() {
  return localStorage.getItem(CONV_ID_KEY) || null;
}

function setCurrentConversationId(id) {
  localStorage.setItem(CONV_ID_KEY, id);
}

function getMessagesForCurrent() {
  const id = getCurrentConversationId();
  if (!id) return [];
  const convs = loadConversations();
  return convs[id] ? convs[id].messages : [];
}

function addMessageToStorage(role, text) {
  let id = getCurrentConversationId();
  const convs = loadConversations();

  if (!id || !convs[id]) {
    id = id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    convs[id] = {
      id: id,
      title: role === "user" ? text.slice(0, 80) : "New Chat",
      messages: [],
      created: Date.now(),
      updated: Date.now(),
    };
    setCurrentConversationId(id);
  }

  convs[id].messages.push({ role: role, text: text, ts: Date.now() });
  convs[id].updated = Date.now();
  if (convs[id].messages.length === 1 && role === "user") {
    convs[id].title = text.slice(0, 80);
  }
  saveConversations(convs);
}

function restoreConversation() {
  const messages = getMessagesForCurrent();
  if (messages.length === 0) return;
  hero.style.minHeight = "auto";
  for (const msg of messages) {
    appendMessage(msg.role, msg.text);
  }
}

function startNewChat() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  setCurrentConversationId(id);
  conversation.innerHTML = "";
  hero.style.minHeight = "";
  input.value = "";
  input.style.height = "auto";
  input.focus();
}

/* ── UI Helpers ────────────────────────────────────────────── */

function setStatus(text) {
  statusText.textContent = text;
}

function setOrbState(state) {
  orbWrap.classList.remove("is-idle", "is-listening", "is-thinking", "is-speaking", "is-error");
  orbWrap.classList.add("is-" + state);
  var labels = {
    idle: "VOICE READY",
    listening: "LISTENING",
    thinking: "THINKING",
    speaking: "SPEAKING",
    error: "VOICE ERROR",
  };
  voiceStateText.textContent = labels[state] || "VOICE READY";
}

function updateVoiceControls() {
  voiceToggle.setAttribute("aria-pressed", String(voiceEnabled));
  voiceToggle.classList.toggle("is-active", voiceEnabled);
  voiceToggleText.textContent = voiceEnabled ? "VOICE ON" : "VOICE OFF";

  var wakeActive = wakeEnabled && daemonState.running && daemonState.ready;
  wakeToggle.setAttribute("aria-pressed", String(wakeEnabled));
  wakeToggle.classList.toggle("is-active", wakeActive);
  wakeToggleText.textContent = wakeActive ? "WAKE ON" : (wakeEnabled ? "WAKE\u2026" : "WAKE OFF");

  wakeStateText.textContent = wakeActive ? "WAKE WORD ON" : "WAKE WORD OFF";
}

function syncDaemonState(next) {
  daemonState = Object.assign({}, daemonState, next);
  updateVoiceControls();
  if (daemonState.state) setOrbState(daemonState.state);

  if (daemonState.ready) {
    setStatus(daemonState.state === "idle" ? "WAKE READY" : daemonState.state.toUpperCase());
  }
}

function findReply(data) {
  if (!data) return "";
  if (typeof data === "string") return data.trim();

  if (Array.isArray(data)) {
    for (var i = 0; i < data.length; i++) {
      var reply = findReply(data[i]);
      if (reply) return reply;
    }
    return "";
  }

  if (typeof data === "object") {
    var direct = [
      data.assistant_message,
      data.response,
      data.output,
      data.text,
      data.message,
    ];

    for (var j = 0; j < direct.length; j++) {
      if (typeof direct[j] === "string" && direct[j].trim()) return direct[j].trim();
    }

    var keys = ["body", "data", "result", "json"];
    for (var k = 0; k < keys.length; k++) {
      var nested = findReply(data[keys[k]]);
      if (nested) return nested;
    }
  }

  return "";
}

function isDirectVoiceCommand(text) {
  return /^(?:ultron\s+)?(?:speak|say)\s*:/i.test(String(text || "").trim());
}

/* ── Voice ─────────────────────────────────────────────────── */

async function speakReply(text, opts) {
  var replay = opts && opts.replay;
  if (!voiceEnabled || !text) return;
  try {
    if (!replay) setOrbState("speaking");
    var response = await fetch("/api/tts/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    });
    var raw = await response.text();
    if (!response.ok) {
      var message = "Voice request failed (" + response.status + ")";
      try {
        var data = JSON.parse(raw);
        message = data.error || message;
      } catch (_) { /* use default */ }
      throw new Error(message);
    }
  } catch (error) {
    console.warn("ULTRON voice output failed:", error);
  } finally {
    if (!daemonState.ready) setOrbState("idle");
  }
}

/* ── Messages ──────────────────────────────────────────────── */

function appendMessage(role, text) {
  var wrapper = document.createElement("div");
  wrapper.className = "message-row " + role;

  var element = document.createElement("div");
  element.className = "message " + role;

  if (role === "assistant") {
    element.innerHTML = renderMarkdown(text);

    /* Add copy button to each code block */
    var pres = element.querySelectorAll("pre");
    for (var p = 0; p < pres.length; p++) {
      (function (pre) {
        pre.style.position = "relative";
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "code-copy-btn";
        btn.textContent = "\u2398";
        btn.title = "Copy code";
        btn.setAttribute("aria-label", "Copy code block");
        btn.addEventListener("click", function () {
          var codeEl = pre.querySelector("code");
          var codeText = codeEl ? codeEl.textContent : pre.textContent;
          navigator.clipboard.writeText(codeText).then(function () {
            btn.textContent = "\u2713";
            setTimeout(function () { btn.textContent = "\u2398"; }, 1500);
          });
        });
        pre.appendChild(btn);
      })(pres[p]);
    }
  } else {
    element.textContent = text;
  }

  wrapper.appendChild(element);

  if (role === "assistant") {
    /* Copy entire message */
    var copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "message-action copy-btn";
    copyButton.textContent = "\u2398";
    copyButton.title = "Copy message";
    copyButton.setAttribute("aria-label", "Copy message text");
    copyButton.addEventListener("click", function () {
      navigator.clipboard.writeText(text).then(function () {
        copyButton.textContent = "\u2713";
        setTimeout(function () { copyButton.textContent = "\u2398"; }, 1500);
      });
    });
    wrapper.appendChild(copyButton);

    /* Voice replay */
    var replayButton = document.createElement("button");
    replayButton.type = "button";
    replayButton.className = "message-action";
    replayButton.textContent = "\u21BB";
    replayButton.title = "Replay ULTRON's voice";
    replayButton.setAttribute("aria-label", "Replay ULTRON voice");
    replayButton.addEventListener("click", function () {
      speakReply(text, { replay: true });
    });
    wrapper.appendChild(replayButton);
  }

  conversation.appendChild(wrapper);
  wrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });
  hero.style.minHeight = "auto";
  return wrapper;
}

/* Typing indicator */
function showTypingIndicator() {
  var wrapper = document.createElement("div");
  wrapper.className = "message-row assistant";
  wrapper.id = "typingIndicator";

  var element = document.createElement("div");
  element.className = "message assistant";

  var dots = document.createElement("div");
  dots.className = "typing-indicator";
  dots.innerHTML = "<span></span><span></span><span></span>";
  element.appendChild(dots);

  wrapper.appendChild(element);
  conversation.appendChild(wrapper);
  wrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });
  hero.style.minHeight = "auto";
}

function removeTypingIndicator() {
  var el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

/* ── Daemon Status ─────────────────────────────────────────── */

async function refreshDaemonStatus() {
  try {
    var response = await fetch("/api/voice/daemon", { cache: "no-store" });
    var data = await response.json();
    syncDaemonState(data);
  } catch (_) {
    daemonState = Object.assign({}, daemonState, { running: false, ready: false, state: "idle" });
    updateVoiceControls();
  }
}

async function refreshVoiceStatus() {
  try {
    var response = await fetch("/api/voice/status", { cache: "no-store" });
    var data = await response.json();
    if (!data.configured) {
      voiceEnabled = false;
      localStorage.setItem("ultron.voice.enabled", "false");
      setStatus("VOICE UNAVAILABLE");
      voiceStateText.textContent = "VOICE UNAVAILABLE";
    }
  } catch (_) {
    /* Core status is handled separately by the main chat request. */
  }
}

async function setWakeDaemon(enabled) {
  try {
    var endpoint = enabled ? "/api/voice/daemon/start" : "/api/voice/daemon/stop";
    var response = await fetch(endpoint, { method: "POST" });
    var data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || "Wake-word daemon request failed.");
    wakeEnabled = enabled;
    localStorage.setItem("ultron.wake.enabled", String(enabled));
    syncDaemonState(data);
  } catch (error) {
    wakeEnabled = false;
    localStorage.setItem("ultron.wake.enabled", "false");
    updateVoiceControls();
    setStatus("WAKE ERROR");
    console.error(error);
  }
}

/* ── Event Listeners ───────────────────────────────────────── */

voiceToggle.addEventListener("click", function () {
  voiceEnabled = !voiceEnabled;
  localStorage.setItem("ultron.voice.enabled", String(voiceEnabled));
  updateVoiceControls();
  if (!voiceEnabled) setOrbState("idle");
});

wakeToggle.addEventListener("click", function () {
  setWakeDaemon(!wakeEnabled);
});

newChatBtn.addEventListener("click", startNewChat);

input.addEventListener("input", function () {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
});

input.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener("submit", async function (event) {
  event.preventDefault();

  var message = input.value.trim();
  if (!message || sendButton.disabled) return;

  addMessage("user", message);
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  setStatus("THINKING");
  setOrbState("thinking");
  showTypingIndicator();

  try {
    var response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message }),
    });

    var raw = await response.text();
    var data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      throw new Error("Invalid response from local core: " + raw.slice(0, 300));
    }

    if (!response.ok) {
      throw new Error(data.details || data.error || "HTTP " + response.status);
    }

    var reply = findReply(data);
    if (!reply) throw new Error("ULTRON returned no response text.");

    removeTypingIndicator();
    addMessage("assistant", reply);
    setStatus("CORE READY");
    setOrbState("idle");

    if (voiceEnabled && !isDirectVoiceCommand(message)) {
      void speakReply(reply);
    }
  } catch (error) {
    console.error(error);
    removeTypingIndicator();
    addMessage("assistant", "I couldn't reach the Ultron Core. " + error.message);
    setStatus("CORE OFFLINE");
    setOrbState("error");
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});

/* ── Init ──────────────────────────────────────────────────── */

updateVoiceControls();
setOrbState("idle");
restoreConversation();
void refreshVoiceStatus();
void refreshDaemonStatus();

setInterval(refreshDaemonStatus, 1500);
