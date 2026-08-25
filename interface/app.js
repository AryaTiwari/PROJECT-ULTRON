const composer = document.getElementById("composer");
const input = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const conversation = document.getElementById("conversation");
const hero = document.getElementById("hero");
const statusText = document.getElementById("statusText");

function addMessage(role, text) {
  const element = document.createElement("div");
  element.className = `message ${role}`;
  element.textContent = text;
  conversation.appendChild(element);
  element.scrollIntoView({ behavior: "smooth", block: "nearest" });
  hero.style.minHeight = "auto";
}

function setStatus(text) {
  statusText.textContent = text;
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

    for (const key of ["body", "data", "result", "json"] ) {
      const reply = findReply(data[key]);
      if (reply) return reply;
    }
  }

  return "";
}

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

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
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

    if (!reply) {
      throw new Error("ULTRON returned no response text.");
    }

    addMessage("assistant", reply);
    setStatus("CORE READY");
  } catch (error) {
    console.error(error);
    addMessage("assistant", `I couldn't reach the Ultron Core. ${error.message}`);
    setStatus("CORE OFFLINE");
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});
