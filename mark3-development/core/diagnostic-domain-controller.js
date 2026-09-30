'use strict';

const diagnostics=require('./adaptive-diagnostic-layer');
const skillChooser=require('./skill-chooser');

function response(ok,text,extra={}){return{ok,text,response:text,model:'mark3-diagnostic-layer',provider:'local',taskType:'diagnostic',...extra};}
async function handle(message=''){
  const summary=diagnostics.summary();
  const skill=skillChooser.choose(message,{domain:'diagnostic',controller:'diagnostic-domain-controller'});
  const recent=summary.recent.slice(-5);
  const body=[
    `Mark 3 diagnostic state: ${summary.status}`,
    `Recent diagnoses: ${summary.recent.length}`,
    recent.length?recent.map(item=>`- ${item.subsystem}/${item.type} · ${item.code} · ${item.stage}${item.userActionRequired?' · user decision needed':''}`).join('\n'):'- none',
    'Automatic recovery is limited to approved safe/read-idempotent actions. Paid calls, destructive writes, safety bypasses and source-code mutation are never self-healed automatically.',
  ].join('\n');
  return response(true,body,{diagnostic:summary,skillSelection:skill});
}
module.exports={handle};
