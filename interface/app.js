const WEBHOOK_URL = "http://localhost:5678/webhook-test/ultron";

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
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const reply = data.response || data.assistant_message || data.output || data.text;

    if (!reply) {
      throw new Error("ULTRON returned no response text.");
    }

    addMessage("assistant", reply);
    setStatus("CORE READY");
  } catch (error) {
    console.error(error);
    addMessage("assistant", "I couldn't reach the Ultron Core. Check that n8n is listening on the webhook and that the local interface is allowed to make the request.");
    setStatus("CORE OFFLINE");
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});
