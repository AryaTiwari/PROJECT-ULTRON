// Development-only, in-memory fixtures. Never writes to the gateway or external services.
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {MissionView} from "./components/MissionView";
import {ApprovalModal} from "./components/ApprovalModal";
import {OutputsView} from "./components/OutputsView";
import type {Mission,SystemOverview} from "./types";
import "./styles.css";import "./polish.css";
function QA(){
 const[stages,setStages]=useState(13),[active,setActive]=useState(""),[approval,setApproval]=useState(false),[view,setView]=useState("missions"),[notice,setNotice]=useState("");
 const base={createdAt:"2026-09-28T10:00:00Z",updatedAt:"2026-09-28T10:01:00Z",constraints:{},strategy:{},completionCriteria:{},blockers:[],outputs:[],events:[]};
 const rows:Mission[]=["running","waiting_input","awaiting_approval","paused","blocked","verifying","completed","failed"].map((status,i)=>({...base,id:"fixture-"+i,status,objective:i===0?"Contact enrichment for a long company portfolio with existing first and second decision makers, preserving previously verified contact evidence":"Contact enrichment · "+status.replaceAll("_"," "),state:{nativeOperation:"apollo-contact-enrichment",attentionState:status==="waiting_input"?"MISSING_PARAMETER":null,metrics:{processed:18,fullMatch:14,partialMatch:2,noMatch:2,requests:20,remaining:13},progress:{completed:18,total:31,currentStage:"CONTACT_VERIFICATION",currentItem:"Acme Technologies",stages:Array.from({length:stages},(_,n)=>({id:"stage-"+n,label:["Resolve input","Check worksheet","Compile schema","Discover contacts","Verify identity","Check employer","Rank candidates","Hydrate details","Select contacts","Prepare rows","Write results","Verify writes","Finish","Record output","Publish receipt"][n],status:n<4?"completed":n===4?"active":"pending",summary:n===4?"Checking supplied evidence":null}))}}}));
 const overview={outputs:[
 {type:"google_sheet",name:"Verified companies",worksheet:"Arya",verifiedRows:18,range:"A2:J19",verification:"18 rows verified",url:"https://docs.google.com/"},
 {type:"reel",name:"Launch Reel",duration:"24 seconds",resolution:"1080 × 1920",verification:"Not verified",preview:"/api/missing-preview.jpg"},
 {type:"lead_list",name:"India product companies",companyCount:25,enrichedCount:18,sourceIntegration:"Apollo",verification:"Verified"},
 {type:"document",name:"Research report",destination:"Local report",verification:"Recorded"},
 {type:"code",name:"Interface improvements",branch:"mark4-development",commit:"example",tests:"117 passed",verification:"Verified",url:"javascript:alert(1)"},
 {type:"document",name:"Broken destination",url:"https://example.invalid/result",verification:"Pending"}
 ]} as unknown as SystemOverview;
 return <main className="workspace"><aside className="inline-alert"><b>Developer diagnostics · UI fixtures</b><p>In-memory examples only. Actions do not run missions, use credits, or write files.</p><div className="filter-bar">{[5,8,13,15].map(n=><button key={n} aria-pressed={stages===n} onClick={()=>setStages(n)}>{n} stages</button>)}<button onClick={()=>{setView("missions");setActive("")}}>Mission board</button><button onClick={()=>setView("outputs")}>Output fixtures</button><button onClick={()=>setApproval(true)}>Approval fixture</button></div></aside><p role="status">{notice}</p>{view==="missions"?<MissionView missions={rows} activeId={active} onSelect={setActive} onNew={()=>setNotice("New mission action received")} onOpenSession={()=>{}} onUpdate={async()=>setNotice("Mission action received")}/>:<OutputsView overview={overview} missions={[]}/>}<ApprovalModal approval={approval?{kind:"Apollo",description:"Enrich 31 companies. Existing Sheet data will be preserved.",choices:["deny","once","mission"],estimatedCalls:62}:null} onClose={()=>setApproval(false)} onResolve={async c=>{setApproval(false);setNotice("Approval recorded: "+c)}}/></main>
}
if(import.meta.env.DEV){const root=createRoot(document.getElementById("root")!);root.render(<QA/>);import.meta.hot?.dispose(()=>root.unmount());}
