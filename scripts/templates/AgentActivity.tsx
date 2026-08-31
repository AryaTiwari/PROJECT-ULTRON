import React, { useEffect, useMemo, useState } from 'react';

type ActivityEvent = { type: string; state?: string; label?: string; text?: string; tool?: string; toolCalls?: any[]; toolResults?: any[]; status?: string; error?: string; at?: number; durationMs?: number; partial?: boolean };
const LABELS: Record<string, string> = { thinking: 'THINKING', planning: 'PLANNING', researching: 'RESEARCHING', inspecting: 'INSPECTING', executing: 'EXECUTING', synthesizing: 'SYNTHESIZING', responding: 'RESPONDING', speaking: 'SPEAKING', complete: 'COMPLETE', error: 'ERROR' };
const DOTS: Record<string, string> = { thinking: '◌', planning: '◌', researching: '⌁', inspecting: '⌕', executing: '⚙', synthesizing: '◇', responding: '→', speaking: '◉', complete: '✓', error: '!' };
function normalizeState(event: ActivityEvent) { const raw = String(event.state || event.type || '').toLowerCase(); if (raw === 'meta') return 'thinking'; if (raw === 'tool') return 'executing'; if (raw === 'delta') return 'responding'; if (raw === 'final') return 'complete'; return LABELS[raw] ? raw : 'thinking'; }
function formatDuration(ms: number) { return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '0.0s'; }
export const AgentActivity: React.FC = () => {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [active, setActive] = useState<ActivityEvent | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const handler = (customEvent: Event) => {
      const detail = (customEvent as CustomEvent<ActivityEvent>).detail || {};
      const event = { ...detail, at: detail.at || Date.now() };
      const state = normalizeState(event);
      const normalized = { ...event, state };
      if (state === 'complete' || state === 'error') { setActive(null); setEvents((prev) => [...prev, normalized].slice(-10)); }
      else { setStartedAt((current) => current ?? Date.now()); setActive(normalized); setEvents((prev) => { const last = prev[prev.length - 1]; if (last?.state === state && state === 'responding') return prev; return [...prev, normalized].slice(-10); }); }
    };
    window.addEventListener('ultron:activity', handler);
    return () => window.removeEventListener('ultron:activity', handler);
  }, []);
  useEffect(() => { if (!startedAt || !active) return; const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 100); return () => window.clearInterval(timer); }, [startedAt, active]);
  useEffect(() => { const finalEvent = events[events.length - 1]; if (!finalEvent) return; if (finalEvent.state === 'complete' || finalEvent.state === 'error') { if (finalEvent.durationMs != null) setElapsed(finalEvent.durationMs); setStartedAt(null); } }, [events]);
  const currentState = active ? normalizeState(active) : (events[events.length - 1]?.state || 'complete');
  const currentLabel = LABELS[currentState] || 'ULTRON';
  const isLive = Boolean(active && !['complete', 'error'].includes(currentState));
  const recent = useMemo(() => events.slice(-5), [events]);
  return <div className="fixed right-5 top-20 z-[70] w-[min(360px,calc(100vw-2rem))] pointer-events-none font-mono">
    <div className="rounded-2xl border border-cyan-500/20 bg-slate-950/80 backdrop-blur-xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-900"><div className="flex items-center gap-2"><span className={`w-2 h-2 rounded-full ${isLive ? 'bg-cyan-400 animate-pulse' : 'bg-slate-600'}`} /><span className="text-[9px] font-black tracking-[0.2em] text-slate-300">LIVE ACTIVITY</span></div><span className={`text-[9px] font-bold tracking-widest ${currentState === 'error' ? 'text-red-300' : currentState === 'complete' ? 'text-emerald-300' : 'text-cyan-300'}`}>{currentLabel}</span></div>
      <div className="px-4 py-3"><div className="flex items-start gap-3"><div className="w-8 h-8 rounded-lg border border-cyan-500/20 bg-cyan-950/20 flex items-center justify-center text-cyan-300">{DOTS[currentState] || '◉'}</div><div className="min-w-0 flex-1"><div className="text-[11px] font-bold text-white tracking-wide">{active?.label || active?.text || (currentState === 'complete' ? 'Task complete.' : 'Standing by.')}</div>{active?.tool && <div className="mt-1 text-[9px] text-cyan-300 break-all">{active.tool}</div>}{active?.error && <div className="mt-1 text-[9px] text-red-300">{active.error}</div>}<div className="mt-2 flex items-center gap-3 text-[8px] tracking-[0.14em] text-slate-500"><span>{formatDuration(elapsed)}</span>{active?.toolCalls?.length ? <span>{active.toolCalls.length} TOOL{active.toolCalls.length === 1 ? '' : 'S'}</span> : null}{active?.partial ? <span>PARTIAL</span> : null}</div></div></div>{recent.length > 1 && <div className="mt-3 pt-3 border-t border-slate-900 space-y-1.5">{recent.slice(0, -1).reverse().map((item, index) => <div key={`${item.at}-${index}`} className="flex items-center gap-2 text-[8px] tracking-wider text-slate-500"><span>{DOTS[item.state || 'thinking'] || '•'}</span><span>{LABELS[item.state || 'thinking'] || String(item.state).toUpperCase()}</span>{item.tool && <span className="truncate text-slate-600">{item.tool}</span>}</div>)}</div>}</div>
    </div>
  </div>;
};
