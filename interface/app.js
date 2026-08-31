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

let voiceEnabled = localStorage.getItem("ultron.voice.enabled") !== "false";
let wakeEnabled = localStorage.getItem("ultron.wake.enabled") === "true";
let daemonState = { running: false, ready: false, state: "idle", wakeWord: "ULTRON" };

function setStatus(text) {
  statusText.textContent = text;
}

function setOrbState(state) {
  orbWrap.classList.remove("is-idle", "is-listening", "is-thinking", "is-speaking", "is-error");
  orbWrap.classList.add(`is-${state}`);
  const labels = {
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

  const wakeActive = wakeEnabled && daemonState.running && daemonState.ready;
  wakeToggle.setAttribute("aria-pressed", String(wakeEnabled));
  wakeToggle.classList.toggle("is-active", wakeActive);
  wakeToggleText.textContent = wakeActive ? "WAKE ON" : (wakeEnabled ? "WAKE…" : "WAKE OFF");

  wakeStateText.textContent = wakeActive ? "WAKE WORD ON" : "WAKE WORD OFF";
}

function syncDaemonState(next) {
  daemonState = { ...daemonState, ...next };
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
    for (const item of data) {
      const reply = findReply(item);
      if (reply) return reply;
    }
    return "";
  }

  if (typeof data === "object") {
    const direct = [
      data.assistant_message,
      data.response,
      data.output,
      data.text,
      data.message,
    ];

    for (const value of direct) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }

    for (const key of ["body", "data", "result", "json"]) {
      const reply = findReply(data[key]);
      if (reply) return reply;
    }
  }

  return "";
}

function isDirectVoiceCommand(text) {
  return /^(?:ultron\s+)?(?:speak|say)\s*:/i.test(String(text || "").trim());
}

async function speakReply(text, { replay = false } = {}) {
  if (!voiceEnabled || !text) return;
  try {
    if (!replay) setOrbState("speaking");
    const response = await fetch("/api/tts/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const raw = await response.text();
    if (!response.ok) {
      let message = `Voice request failed (${response.status})`;
      try {
        const data = JSON.parse(raw);
        message = data.error || message;
      } catch {}
      throw new Error(message);
    }
  } catch (error) {
    console.warn("ULTRON voice output failed:", error);
  } finally {
    if (!daemonState.ready) setOrbState("idle");
  }
}

function addMessage(role, text) {
  const wrapper = document.createElement("div");
  wrapper.className = `message-row ${role}`;

  const element = document.createElement("div");
  element.className = `message ${role}`;
  element.textContent = text;
  wrapper.appendChild(element);

  if (role === "assistant") {
    const replayButton = document.createElement("button");
    replayButton.type = "button";
    replayButton.className = "message-action";
    replayButton.textContent = "↻";
    replayButton.title = "Replay ULTRON's voice";
    replayButton.setAttribute("aria-label", "Replay ULTRON voice");
    replayButton.addEventListener("click", () => speakReply(text, { replay: true }));
    wrapper.appendChild(replayButton);
  }

  conversation.appendChild(wrapper);
  wrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });
  hero.style.minHeight = "auto";
}

async function refreshDaemonStatus() {
  try {
    const response = await fetch("/api/voice/daemon", { cache: "no-store" });
    const data = await response.json();
    syncDaemonState(data);
  } catch {
    daemonState = { ...daemonState, running: false, ready: false, state: "idle" };
    updateVoiceControls();
  }
}

async function refreshVoiceStatus() {
  try {
    const response = await fetch("/api/voice/status", { cache: "no-store" });
    const data = await response.json();
    if (!data.configured) {
      voiceEnabled = false;
      localStorage.setItem("ultron.voice.enabled", "false");
      setStatus("VOICE UNAVAILABLE");
      voiceStateText.textContent = "VOICE UNAVAILABLE";
    }
  } catch {
    // Core status is handled separately by the main chat request.
  }
}

async function setWakeDaemon(enabled) {
  try {
    const endpoint = enabled ? "/api/voice/daemon/start" : "/api/voice/daemon/stop";
    const response = await fetch(endpoint, { method: "POST" });
    const data = await response.json();
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

voiceToggle.addEventListener("click", () => {
  voiceEnabled = !voiceEnabled;
  localStorage.setItem("ultron.voice.enabled", String(voiceEnabled));
  updateVoiceControls();
  if (!voiceEnabled) setOrbState("idle");
});

wakeToggle.addEventListener("click", () => setWakeDaemon(!wakeEnabled));

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = input.value.trim();
  if (!message || sendButton.disabled) return;

  addMessage("user", message);
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  setStatus("THINKING");
  setOrbState("thinking");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`Invalid response from local core: ${raw.slice(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(data.details || data.error || `HTTP ${response.status}`);
    }

    const reply = findReply(data);
    if (!reply) throw new Error("ULTRON returned no response text.");

    addMessage("assistant", reply);
    setStatus("CORE READY");
    setOrbState("idle");

    if (voiceEnabled && !isDirectVoiceCommand(message)) {
      void speakReply(reply);
    }
  } catch (error) {
    console.error(error);
    addMessage("assistant", `I couldn't reach the Ultron Core. ${error.message}`);
    setStatus("CORE OFFLINE");
    setOrbState("error");
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});

updateVoiceControls();
setOrbState("idle");
void refreshVoiceStatus();
void refreshDaemonStatus();

setInterval(refreshDaemonStatus, 1500);
