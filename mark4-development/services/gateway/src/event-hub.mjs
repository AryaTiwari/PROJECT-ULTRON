const clients = new Set();
const frame = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

export function subscribe(res) {
  clients.add(res);
  res.write(frame("connected", { at:new Date().toISOString() }));
  const timer=setInterval(()=>{ try { res.write(": heartbeat\n\n"); } catch {} },20000);
  timer.unref?.();
  const close=()=>{ clearInterval(timer); clients.delete(res); };
  res.on("close",close); res.on("error",close);
}
export function publish(type,payload={}) {
  const text=frame(type,{...payload,at:payload.at||new Date().toISOString()});
  for(const res of [...clients]) { try { res.write(text); } catch { clients.delete(res); } }
}
