import { useEffect, useMemo, useRef } from "react";
import type { LiveEvent, Mission } from "../types";

const STATIONS = {
  core: { x: 0.50, y: 0.50, label: "CORE" },
  research: { x: 0.20, y: 0.30, label: "RESEARCH" },
  engineering: { x: 0.77, y: 0.28, label: "ENGINEERING" },
  intel: { x: 0.18, y: 0.72, label: "INTEL" },
  comms: { x: 0.78, y: 0.72, label: "COMMS" },
  media: { x: 0.50, y: 0.82, label: "MEDIA" }
} as const;

type Station = keyof typeof STATIONS;

function stationFor(event?: LiveEvent): Station {
  const text = JSON.stringify(event || {}).toLowerCase();
  if (/linkedin|search|browser|web|research/.test(text)) return "research";
  if (/apollo|contact|enrich|lead/.test(text)) return "intel";
  if (/email|instagram|message|dm|slack|gmail/.test(text)) return "comms";
  if (/reel|video|image|media|ffmpeg/.test(text)) return "media";
  if (/github|terminal|code|file|patch|build/.test(text)) return "engineering";
  return "core";
}

export function OperationsView({
  events,
  mission
}: {
  events: LiveEvent[];
  mission?: Mission | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const position = useRef({ x: 0.5, y: 0.5 });
  const target = useRef({ x: 0.5, y: 0.5 });
  const current = useMemo(() => stationFor(events.at(-1)), [events]);

  useEffect(() => {
    target.current = { x: STATIONS[current].x, y: STATIONS[current].y };
  }, [current]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = 0;
    let alive = true;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    function draw(timestamp: number) {
      if (!alive) return;
      raf = requestAnimationFrame(draw);
      if (document.hidden || timestamp - last < 33) return;
      last = timestamp;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      ctx.clearRect(0, 0, width, height);

      const background = ctx.createLinearGradient(0, 0, 0, height);
      background.addColorStop(0, "#05090f");
      background.addColorStop(1, "#071423");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(70,137,255,.12)";
      ctx.lineWidth = 1;
      for (let index = 0; index < 12; index += 1) {
        const y = height * 0.17 + index * 30;
        ctx.beginPath();
        ctx.moveTo(width * 0.12, y);
        ctx.lineTo(width * 0.88, y);
        ctx.stroke();
      }

      ctx.fillStyle = "#08111d";
      ctx.strokeStyle = "#173d67";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(width * 0.12, height * 0.18);
      ctx.lineTo(width * 0.88, height * 0.18);
      ctx.lineTo(width * 0.96, height * 0.83);
      ctx.lineTo(width * 0.04, height * 0.83);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      for (const [key, station] of Object.entries(STATIONS)) {
        const x = station.x * width;
        const y = station.y * height;
        const active = key === current;

        ctx.fillStyle = active ? "rgba(45,128,255,.18)" : "rgba(11,28,48,.85)";
        ctx.strokeStyle = active ? "#4a9cff" : "#1c456d";
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(x - 58, y - 22, 116, 44, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = active ? "#f2f7ff" : "#7f9bb8";
        ctx.font = "600 10px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(station.label, x, y + 4);
      }

      const p = position.current;
      const t = target.current;
      p.x += (t.x - p.x) * 0.055;
      p.y += (t.y - p.y) * 0.055;

      const x = p.x * width;
      const y = p.y * height - 24;

      ctx.save();
      ctx.shadowColor = "#2f86ff";
      ctx.shadowBlur = 18;
      ctx.fillStyle = "#0d6eea";
      ctx.beginPath();
      ctx.moveTo(x, y - 28);
      ctx.lineTo(x - 18, y + 18);
      ctx.lineTo(x + 18, y + 18);
      ctx.closePath();
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = "#d9ebff";
      ctx.beginPath();
      ctx.arc(x, y - 34, 8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#0a1018";
      ctx.fillRect(x - 5, y - 36, 10, 3);
      ctx.fillStyle = "#4ba1ff";
      ctx.fillRect(x - 4, y - 35, 8, 1);
      ctx.restore();

      ctx.fillStyle = "rgba(118,174,229,.55)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText("ULTRON / LIVE OPERATIONS", 18, 24);
    }

    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [current]);

  return (
    <section className="operations-view">
      <div className="ops-stage">
        <canvas ref={canvasRef} />
        <div className="ops-hud">
          <span className="live-pill">● LIVE</span>
          <b>{mission?.objective || "Standby"}</b>
          <small>Station: {STATIONS[current].label}</small>
        </div>
      </div>

      <aside className="ops-feed">
        <div className="panel-label">ACTIVITY</div>
        {events.slice(-12).reverse().map((event, index) => (
          <div className="ops-event" key={index}>
            <span>{event.type}</span>
            <small>
              {String(
                (event.data as any)?.name ||
                (event.data as any)?.tool_name ||
                (event.data as any)?.summary ||
                ""
              )}
            </small>
          </div>
        ))}
      </aside>
    </section>
  );
}
