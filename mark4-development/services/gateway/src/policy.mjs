const APPROVAL_SIDE_EFFECTS = new Set(["external_communication","destructive","financial","publish"]);
export function assessAction(action={}) {
  const sideEffect=action.sideEffect||"read";
  if(action.approval==="required"||APPROVAL_SIDE_EFFECTS.has(sideEffect))
    return {allowed:false,approvalRequired:true,reason:`Action has ${sideEffect} side effects.`};
  if(action.costClass==="paid"&&String(process.env.ULTRON_M4_ALLOW_PAID||"0")!=="1")
    return {allowed:false,approvalRequired:false,reason:"Paid execution is disabled by policy."};
  return {allowed:true,approvalRequired:false,reason:null};
}
export function legacyAllowed(name) {
  if(String(process.env.ULTRON_M4_ALLOW_LEGACY||"0")!=="1") return false;
  const key=`ULTRON_M4_ALLOW_LEGACY_${String(name||"").toUpperCase().replace(/[^A-Z0-9]+/g,"_")}`;
  return String(process.env[key]||"0")==="1";
}
