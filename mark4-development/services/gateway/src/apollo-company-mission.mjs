import crypto from "node:crypto";
import { googleSheetPreflight,googleSheetRead,googleSheetAppendRows,googleSheetReadback } from "../../capability-host/src/workspace.mjs";
import { searchApolloOrganizations } from "../../capability-host/src/apollo-organizations.mjs";

const aliases={
  companyName:["company name","company","organization name","organisation name","account name"],
  companyLink:["company link","company linkedin","linkedin company","linkedin url","company url"],
  website:["website","company website","domain","company domain"],employees:["employees","employee count","company size","headcount"],
  industry:["industry","sector"],location:["location","company location","headquarters","hq"],source:["source","data source"],
};
const norm=value=>String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const canonicalDomain=value=>String(value||"").toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").replace(/\/.*$/,"").trim();
const canonicalUrl=value=>String(value||"").toLowerCase().replace(/[?#].*$/,"").replace(/\/$/,"").trim();
const columnName=value=>{let result="";for(let n=Math.max(1,Number(value)||1);n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;};
function columns(headers){
  const map={};headers.forEach((header,index)=>{const n=norm(header);for(const[key,items]of Object.entries(aliases))if(items.includes(n)&&map[key]===undefined)map[key]=index;});return map;
}
function companyKey(item){return item.id?`id:${item.id}`:item.domain?`domain:${canonicalDomain(item.domain)}`:item.linkedin?`linkedin:${canonicalUrl(item.linkedin)}`:`name:${norm(item.name)}`;}
function evidenceText(item){return norm([item.name,item.industry,item.description,...(item.keywords||[])].filter(Boolean).join(" "));}
function qualifies(item,filters){
  if(!item?.name)return false;
  const geography=(filters.geography||[]).map(norm);if(geography.length&&!geography.some(place=>evidenceText({...item,keywords:[item.location,item.country]}).includes(place)))return false;
  if(filters.employeeMin!==null&&filters.employeeMin!==undefined&&(item.employees===null||item.employees<Number(filters.employeeMin)))return false;
  if(filters.employeeMax!==null&&filters.employeeMax!==undefined&&(item.employees===null||item.employees>Number(filters.employeeMax)))return false;
  const concepts=(filters.concepts||[]).map(norm).filter(Boolean);if(concepts.length&&!concepts.some(concept=>evidenceText(item).includes(concept)&&concept!=="software company")){
    if(!/(software|saas|cloud|technology|platform|product)/.test(evidenceText(item)))return false;
  }
  return true;
}
function score(item,filters){
  const text=evidenceText(item);let value=0;
  for(const concept of filters.concepts||[])if(text.includes(norm(concept)))value+=25;
  if(/\bsaas\b|software as a service/.test(text))value+=30;if(/software|platform|product/.test(text))value+=15;
  if(/staffing|recruitment agency|outsourcing|consulting|digital marketing agency|web development agency/.test(text))value-=60;
  if(item.linkedin)value+=8;if(item.domain||item.website)value+=8;if(item.employees!==null)value+=5;
  return value;
}
function existingKeys(values,map){
  const keys=new Set();for(const row of values.slice(1)){const name=row[map.companyName],link=map.companyLink===undefined?null:row[map.companyLink],website=map.website===undefined?null:row[map.website];if(name)keys.add(`name:${norm(name)}`);if(link){keys.add(`linkedin:${canonicalUrl(link)}`);keys.add(`domain:${canonicalDomain(link)}`);}if(website)keys.add(`domain:${canonicalDomain(website)}`);}return keys;
}
function rowFor(item,headers,map){const row=Array(headers.length).fill("");if(map.companyName!==undefined)row[map.companyName]=item.name||"";if(map.companyLink!==undefined)row[map.companyLink]=item.linkedin||item.website||"";if(map.website!==undefined)row[map.website]=item.website||item.domain||"";if(map.employees!==undefined)row[map.employees]=item.employees??"";if(map.industry!==undefined)row[map.industry]=item.industry||"";if(map.location!==undefined)row[map.location]=item.location||"";if(map.source!==undefined)row[map.source]="Apollo Organization Search";return row;}

export function createApolloCompanyMissionRunner({db,publish,workspace={googleSheetPreflight,googleSheetRead,googleSheetAppendRows,googleSheetReadback},apollo={searchApolloOrganizations}}){
  const emit=(missionId,type,payload={})=>{db.addEvent({missionId,type,payload});publish(type,{missionId,...payload});};
  const patch=(id,value)=>db.updateMission(id,value);
  const fail=(id,error,stage)=>{const code=error.code||error.message||"MISSION_FAILED";patch(id,{status:"blocked",state:{currentStage:stage,error:code,errorMessage:error.message},blockers:[{code,message:error.message,stage}],nextAction:["SELECTION","SHEET_WRITE","READBACK_VERIFY"].includes(stage)?`Resume mission ${id} after Google Sheets access is restored; saved Apollo results will be reused.`:"Correct the reported problem and resume the mission."});emit(id,"mission.blocked",{stage,error:code,message:error.message});return db.getMission(id);};
  async function start({sessionId,intent}){
    const id=`apollo-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    db.createMission({id,objective:`Discover ${intent.targetCount} companies with Apollo and write them to Google Sheets`,originalRequest:intent.originalRequest,status:"active",state:{nativeOperation:"apollo-company-discovery",currentStage:"TARGET_VALIDATION",sessionId,intent,approvalRequired:true,approvalGranted:false,apolloCalls:0,candidates:[],selectedCompanies:[],writtenCompanies:[]},constraints:{...intent.filters,contactEnrichment:false},completionCriteria:{targetCount:intent.targetCount,verifiedSheetWrite:true},nextAction:"Validate Google authentication and the exact worksheet."});
    emit(id,"operation.selected",{operation:"Apollo company discovery",domain:intent.domain,owned:true});
    if(!intent.sheet?.spreadsheetId)return fail(id,Object.assign(new Error("GOOGLE_SPREADSHEET_ID_REQUIRED"),{code:"GOOGLE_SPREADSHEET_ID_REQUIRED"}),"TARGET_VALIDATION");
    try{
      patch(id,{state:{currentStage:"AUTH_CHECK"},nextAction:"Verify Google authentication and worksheet access."});emit(id,"auth.checking",{service:"Google Sheets"});
      const preflight=await workspace.googleSheetPreflight({spreadsheetId:intent.sheet.spreadsheetId,sheetId:intent.sheet.sheetId,sheetName:intent.sheet.worksheet});
      const map=columns(preflight.headers);if(map.companyName===undefined){const error=new Error("GOOGLE_SHEET_COMPANY_NAME_COLUMN_REQUIRED");error.code="GOOGLE_SHEET_COMPANY_NAME_COLUMN_REQUIRED";throw error;}
      patch(id,{status:"awaiting_approval",state:{currentStage:"AWAITING_APOLLO_APPROVAL",sheetTarget:preflight.target,headers:preflight.headers,preflightValues:preflight.values,headerMap:map},nextAction:"Approve this Apollo Organization Search run."});
      emit(id,"target.resolved",{spreadsheetId:preflight.target.spreadsheetId,sheetId:preflight.target.sheetId,sheetName:preflight.target.sheetName,resolutionMethod:preflight.target.resolutionMethod,rowCount:preflight.rowCount});emit(id,"auth.ready",{service:"Google Sheets"});
      const requestId=`approval-${crypto.randomUUID()}`;patch(id,{state:{approvalRequestId:requestId}});
      const message=`Apollo Organization Search is ready for ${intent.targetCount} companies. Google Sheet “${preflight.target.sheetName}” is authenticated and verified. Approve Apollo for this one run only?`;
      emit(id,"approval.required",{run_id:id,request_id:requestId,kind:"apollo_company_discovery",message});
      return{ok:true,native:true,mission:db.getMission(id),runId:id,requestId,message};
    }catch(error){return{ok:false,native:true,mission:fail(id,error,"TARGET_VALIDATION"),runId:id,error:error.message};}
  }
  async function approve(id,input={}){
    const mission=db.getMission(id);if(!mission||mission.state?.nativeOperation!=="apollo-company-discovery")return null;
    if(mission.state.approvalGranted)return{ok:true,alreadyApproved:true,mission};
    const choice=norm(input.choice||input.decision||"");if(!["approve","approved","allow","yes","once"].includes(choice)){
      const cancelled=patch(id,{status:"cancelled",state:{currentStage:"CANCELLED"},approvals:[...(mission.approvals||[]),{choice:input.choice||"denied",at:new Date().toISOString()}],nextAction:null});emit(id,"mission.cancelled",{});return{ok:true,cancelled:true,mission:cancelled};
    }
    patch(id,{status:"active",state:{approvalGranted:true,currentStage:"APOLLO_SEARCH"},approvals:[...(mission.approvals||[]),{choice:"approved",requestId:input.request_id||mission.state.approvalRequestId,at:new Date().toISOString()}],nextAction:"Search Apollo organizations."});
    emit(id,"approval.granted",{run_id:id,request_id:input.request_id||mission.state.approvalRequestId,choice:"approved"});
    void execute(id);return{ok:true,started:true,mission:db.getMission(id)};
  }
  async function execute(id){
    let mission=db.getMission(id);if(!mission)return null;const intent=mission.state.intent,filters=intent.filters||{};
    try{
      let selected=mission.state.selectedCompanies||[];
      if(!selected.length){
        const variants=[...(filters.concepts||[]),"B2B software","cloud software"].filter((v,i,a)=>v&&a.indexOf(v)===i);
        const target=Math.max(1,Number(intent.targetCount)||25),poolTarget=Math.max(100,target*4);let candidates=mission.state.candidates||[],calls=Number(mission.state.apolloCalls||0),pagesSearched=mission.state.pagesSearched||[];
        patch(id,{state:{searchVariants:variants,pagesSearched}});
        if(!mission.state.discoveryComplete){
          emit(id,"apollo.search.started",{target,poolTarget,variants:variants.length});
          outer:for(const keyword of variants){for(let page=1;page<=3;page++){
            const result=await apollo.searchApolloOrganizations({locations:filters.geography||[],employeeMin:filters.employeeMin,employeeMax:filters.employeeMax,keywords:keyword,page,perPage:100});calls+=result.callCount||1;pagesSearched=[...pagesSearched,{keyword,page,received:(result.organizations||[]).length}];
            const byKey=new Map(candidates.map(item=>[companyKey(item),item]));for(const item of result.organizations||[])byKey.set(companyKey(item),item);candidates=[...byKey.values()];
            patch(id,{state:{currentStage:"APOLLO_SEARCH",candidates,apolloCalls:calls,searchCheckpoint:{keyword,page},pagesSearched,candidateCount:candidates.length},nextAction:`Qualify ${candidates.length} Apollo candidates.`});
            emit(id,"apollo.search.page",{keyword,page,received:(result.organizations||[]).length,uniqueCandidates:candidates.length,calls});
            if(candidates.length>=poolTarget||calls>=8)break outer;if(!(result.organizations||[]).length)break;
          }}
          patch(id,{state:{discoveryComplete:true,discoveryCompletedAt:new Date().toISOString(),candidates,apolloCalls:calls,pagesSearched,candidateCount:candidates.length}});
          emit(id,"apollo.search.completed",{calls,candidates:candidates.length});
        }else{
          emit(id,"apollo.search.reused",{calls,candidates:candidates.length});
        }
        patch(id,{state:{currentStage:"QUALIFICATION"}});const qualified=candidates.filter(item=>qualifies(item,filters)).sort((a,b)=>score(b,filters)-score(a,filters));emit(id,"qualification.completed",{candidates:candidates.length,qualified:qualified.length});
        patch(id,{state:{currentStage:"DEDUPLICATION",qualifiedCount:qualified.length}});const unique=[...new Map(qualified.map(item=>[companyKey(item),item])).values()];emit(id,"deduplication.completed",{before:qualified.length,after:unique.length});
        patch(id,{state:{currentStage:"SELECTION"},nextAction:"Compare saved Apollo candidates with the live Google Sheet before writing."});
        const targetInfo=mission.state.sheetTarget;const live=await workspace.googleSheetRead({spreadsheetId:targetInfo.spreadsheetId,range:`'${String(targetInfo.sheetName).replace(/'/g,"''")}'!A1:ZZ`});
        const map=mission.state.headerMap||columns(mission.state.headers||[]),seen=existingKeys(live.values||[],map);
        const available=unique.filter(item=>!seen.has(companyKey(item))&&!seen.has(`name:${norm(item.name)}`)&&!seen.has(`domain:${canonicalDomain(item.domain||item.website)}`)&&!seen.has(`linkedin:${canonicalUrl(item.linkedin)}`));selected=available.slice(0,target);
        const duplicateCount=(qualified.length-unique.length)+(unique.length-available.length);
        patch(id,{state:{currentStage:"SELECTION",selectedCompanies:selected,liveValuesBeforeWrite:live.values||[],qualifiedCount:qualified.length,duplicateCount},nextAction:`Write ${selected.length} selected companies to Google Sheets.`});
        emit(id,"selection.completed",{requested:target,selected:selected.length,shortfall:Math.max(0,target-selected.length)});
      }
      mission=db.getMission(id);const targetInfo=mission.state.sheetTarget,headers=mission.state.headers||[],map=mission.state.headerMap||columns(headers);
      if(!selected.length){const error=new Error("APOLLO_NO_QUALIFIED_NEW_COMPANIES");error.code="APOLLO_NO_QUALIFIED_NEW_COMPANIES";throw error;}
      const before=mission.state.liveValuesBeforeWrite||mission.state.preflightValues||[],rows=selected.map(item=>rowFor(item,headers,map)),startRow=before.length+1,endRow=startRow+rows.length-1;
      if(!mission.state.writeCommitted){
        patch(id,{state:{currentStage:"SHEET_WRITE",pendingRows:rows,writeStartRow:startRow,writeEndRow:endRow},nextAction:"Append selected company rows."});emit(id,"sheet.write.started",{sheetName:targetInfo.sheetName,rows:rows.length,startRow});
        await workspace.googleSheetAppendRows({spreadsheetId:targetInfo.spreadsheetId,sheetName:targetInfo.sheetName,rows});
        patch(id,{state:{currentStage:"READBACK_VERIFY",writeCommitted:true,writeStartRow:startRow,writeEndRow:endRow},nextAction:"Verify the exact written row span."});emit(id,"sheet.write.completed",{sheetName:targetInfo.sheetName,rows:rows.length,startRow,endRow});
      }
      const verifiedStart=Number(mission.state.writeStartRow||startRow),verifiedEnd=Number(mission.state.writeEndRow||endRow);
      patch(id,{state:{currentStage:"READBACK_VERIFY"},nextAction:"Verify the exact written row span."});
      const verify=await workspace.googleSheetReadback({spreadsheetId:targetInfo.spreadsheetId,sheetName:targetInfo.sheetName,startRow:verifiedStart,endRow:verifiedEnd,width:headers.length});
      const actual=verify.values||[],verified=selected.every((item,index)=>{const nameMatches=norm(actual[index]?.[map.companyName])===norm(item.name);if(!nameMatches)return false;if(map.companyLink===undefined)return true;const intended=item.linkedin||item.website||"",written=actual[index]?.[map.companyLink]||"";return !intended||canonicalUrl(written)===canonicalUrl(intended);});if(!verified){const error=new Error("GOOGLE_SHEET_READBACK_MISMATCH");error.code="GOOGLE_SHEET_READBACK_MISMATCH";throw error;}
      emit(id,"verification.completed",{verified:true,rows:actual.length,startRow,endRow});
      const artifact={type:"google_sheet",url:`https://docs.google.com/spreadsheets/d/${targetInfo.spreadsheetId}/edit#gid=${targetInfo.sheetId}`,sheetName:targetInfo.sheetName,range:`A${startRow}:${columnName(headers.length)}${endRow}`};
      mission=patch(id,{status:"completed",state:{currentStage:"COMPLETE",writtenCompanies:selected,verifiedRows:actual.length,completedAt:new Date().toISOString()},artifacts:[...(mission.artifacts||[]),artifact],nextAction:null});
      const duplicateCount=Number(mission.state.duplicateCount||0);const message=`Done, Sir. ${selected.length} companies were added to “${targetInfo.sheetName}”. Apollo candidates inspected: ${mission.state.candidateCount||0}. Qualified: ${mission.state.qualifiedCount||0}. Selected: ${selected.length}. Duplicates skipped: ${duplicateCount}. Rows written: ${actual.length}. Company rows removed: 0.`;
      emit(id,"mission.completed",{operation:"apollo-company-discovery",companiesWritten:selected.length,candidatesInspected:mission.state.candidateCount||0,qualified:mission.state.qualifiedCount||0,duplicatesSkipped:duplicateCount,companyRowsRemoved:0,apolloCalls:mission.state.apolloCalls||0,artifact,message});emit(id,"assistant.completed",{native:true,sessionId:mission.state.sessionId,content:message,missionId:id});return mission;
    }catch(error){mission=db.getMission(id);const stage=mission?.state?.currentStage||"EXECUTION";return fail(id,error,["SHEET_WRITE","SELECTION","READBACK_VERIFY"].includes(stage)?stage:stage);}
  }
  async function resume(id){const mission=db.getMission(id);if(!mission||mission.state?.nativeOperation!=="apollo-company-discovery")throw Object.assign(new Error("MISSION_NOT_RESUMABLE"),{code:"MISSION_NOT_RESUMABLE"});if(!mission.state.approvalGranted)throw Object.assign(new Error("MISSION_APPROVAL_REQUIRED"),{code:"MISSION_APPROVAL_REQUIRED"});const resumeStage=mission.state.writeCommitted?"READBACK_VERIFY":mission.state.selectedCompanies?.length?"SHEET_WRITE":mission.state.discoveryComplete?"QUALIFICATION":"APOLLO_SEARCH";patch(id,{status:"active",state:{currentStage:resumeStage,error:null,errorMessage:null},blockers:[],nextAction:"Resume from the saved checkpoint."});emit(id,"mission.resumed",{checkpoint:mission.state.searchCheckpoint||null,reusesSelectedCompanies:Boolean(mission.state.selectedCompanies?.length),reusesApolloDiscovery:Boolean(mission.state.discoveryComplete)});void execute(id);return{ok:true,started:true,mission:db.getMission(id)};}
  const isNativeRun=id=>db.getMission(id)?.state?.nativeOperation==="apollo-company-discovery";
  return{start,approve,resume,execute,isNativeRun,qualifies,score,columns};
}
