import React, { useMemo, useRef, useState } from "react";
import type { ChatMessage, LiveEvent, Mission } from "../types";

function toolName(event: LiveEvent) {
  const data: any = event.data || {};
  return String(data.name || data.tool_name || data.tool || data.function || event.type);
}

export function CommandView(props: {
  messages: ChatMessage[];
  events: LiveEvent[];
  streaming: string;
  busy: boolean;
  mission?: Mission | null;
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.messages, props.streaming]);

  const tools = useMemo(
    () => props.events.filter(event => /tool\.|subagent\./.test(event.type)).slice(-6),
    [props.events]
  );

  async function submit() {
    const value = draft.trim();
    if (!value || props.busy) return;
    setDraft("");
    await props.onSend(value);
  }

  function voice() {
    const w: any = window;
    const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Recognition) {
      setDraft(value => value || "Voice recognition is unavailable in this browser.");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "en-IN";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onresult = (event: any) => setDraft(String(event.results?.[0]?.[0]?.transcript || ""));
    recognition.start();
  }

  return (
    <section className="command-view">
      <div className="conversation">
        {props.messages.length === 0 && (
          <div className="empty-state">
            <div className="core-mark">U4</div>
            <h2>ULTRON is online.</h2>
            <p>Give it an objective. Multi-step work becomes a persistent mission when needed.</p>
          </div>
        )}

        {props.messages.map(message => (
          <article key={message.id} className={"message " + message.role}>
            <div className="message-role">
              {message.role === "user" ? "ARYA" : message.role === "assistant" ? "ULTRON" : message.role.toUpperCase()}
            </div>
            <div className="message-body">{message.content}</div>
          </article>
        ))}

        {props.streaming && (
          <article className="message assistant streaming">
            <div className="message-role">ULTRON</div>
            <div className="message-body">
              {props.streaming}
              <span className="cursor" />
            </div>
          </article>
        )}

        {props.busy && tools.length > 0 && (
          <div className="tool-strip">
            {tools.map((event, index) => (
              <span key={index} className="tool-chip">
                <span className="pulse-dot" />
                {toolName(event)}
              </span>
            ))}
          </div>
        )}

        <div ref={endRef} />
      </div>

      <div className="composer-shell">
        {props.mission && (
          <div className="mission-context">MISSION · {props.mission.objective}</div>
        )}
        <div className="composer">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="Give ULTRON an objective…"
            rows={1}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button className={"icon-button " + (listening ? "active" : "")} onClick={voice} title="Voice input">◉</button>
          <button className="send-button" disabled={props.busy || !draft.trim()} onClick={() => void submit()}>↑</button>
        </div>
      </div>
    </section>
  );
}
