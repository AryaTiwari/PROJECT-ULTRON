export const APOLLO_CONTACT_STAGES=["INPUT_RESOLUTION","TARGET_PRECHECK","READ_EXISTING_DATA","DEDUPE","IDENTIFY_COMPANY","IDENTIFY_PRIMARY_CONTACT","APOLLO_APPROVAL","CONTACT_SEARCH","CONTACT_SELECTION","CONTACT_VALIDATION","WRITE_CONTACTS","READBACK_VERIFY","COMPLETE"];
export const LEAD_DISCOVERY_STAGES=["INPUT_RESOLUTION","TARGET_PRECHECK","DISCOVERY","QUALIFICATION","DEDUPE","SELECTION","WRITE","READBACK_VERIFY","COMPLETE"];
export const CREATOR_RESEARCH_STAGES=["INPUT_RESOLUTION","DISCOVERY","PROFILE_VERIFICATION","METRIC_VERIFICATION","FIT_SCORING","DEDUPE","SELECTION","WRITE","READBACK_VERIFY","COMPLETE"];
export const REEL_STAGES=["BRIEF","GOAL","HOOK","SCRIPT","CTA","VISUAL_PLAN","ASSET_PLAN","ASSET_RETRIEVAL","STORYBOARD","SCENE_GENERATION","PREVIEW","RENDER","QUALITY_CHECK","FINAL_OUTPUT"];

const human=id=>String(id).toLowerCase().replaceAll("_"," ").replace(/\b\w/g,c=>c.toUpperCase());
export function progressFor(stages,currentStage,{completed=0,total=null,currentItem=null,summaries={}}={}){
  const index=Math.max(0,stages.indexOf(currentStage));
  return{currentStage,stages:stages.map((id,i)=>({id,label:human(id),status:id==="COMPLETE"&&currentStage==="COMPLETE"?"completed":i<index?"completed":i===index?"active":"pending",current:null,target:null,summary:summaries[id]||null})),currentItem,completed:Number(completed)||0,total:Number.isFinite(Number(total))?Number(total):null};
}
export function withProgress(state,stages,currentStage,metrics={}){return{...state,currentStage,progress:progressFor(stages,currentStage,metrics)};}
