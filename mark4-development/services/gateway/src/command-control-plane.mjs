const SPREADSHEET=/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i;
const GID=/(?:[?#&]|\bgid\s*[:=]\s*)(\d+)/i;

const clean=value=>String(value||"").trim().replace(/[.,;]+$/g,"").trim();
const normalized=value=>clean(value).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();

export function parseSheetTarget(text=""){
  const raw=String(text||"");
  const spreadsheetId=raw.match(SPREADSHEET)?.[1]||null;
  const sheetIdMatch=raw.match(GID);
  const worksheetMatch=raw.match(/(?:worksheet|sheet\s+tab|tab)\s*(?:name\s*)?[-:=]\s*["“”']?([^\r\n"“”']+)/i)
    ||raw.match(/(?:worksheet|sheet\s+tab|tab)\s+["“”']([^"“”']+)["“”']/i)
    ||raw.match(/(?:worksheet|sheet\s+tab|tab)\s+([^\r\n]+)/i);
  return{
    spreadsheetId,
    sheetId:sheetIdMatch?Number(sheetIdMatch[1]):null,
    worksheet:worksheetMatch?clean(worksheetMatch[1]):null,
  };
}

function targetCount(text){
  const matches=[
    /(?:find|get|bring|discover|add|fill(?:\s+with)?)\s+(?:me\s+)?(\d{1,4})\b/i,
    /\btarget\s*(?:of|=|:)\s*(\d{1,4})\b/i,
    /\b(\d{1,4})\s+(?:unique\s+)?(?:companies|businesses|organizations|leads)\b/i,
  ];
  for(const pattern of matches){const value=Number(String(text).match(pattern)?.[1]);if(value>0)return Math.min(value,1000);}
  return 25;
}
function employeeRange(text){
  const raw=String(text);
  let m=raw.match(/(?:employees?|company\s+size)\s*(?:should\s+be|is|of|:)?\s*(?:under|below|less\s+than|up\s+to|max(?:imum)?)\s*(\d[\d,]*)/i);
  if(m)return{min:0,max:Number(m[1].replace(/,/g,""))};
  m=raw.match(/(?:employees?|company\s+size)[^\d]{0,18}(\d[\d,]*)\s*(?:-|to)\s*(\d[\d,]*)/i);
  if(m)return{min:Number(m[1].replace(/,/g,"")),max:Number(m[2].replace(/,/g,""))};
  m=raw.match(/(?:at\s+least|min(?:imum)?|over|more\s+than)\s*(\d[\d,]*)\s*(?:\+\s*)?(?:employees?)?/i);
  if(m)return{min:Number(m[1].replace(/,/g,"")),max:null};
  m=raw.match(/\b(\d[\d,]*)\s*\+\s*(?:employees?)?\b/i);
  if(m)return{min:Number(m[1].replace(/,/g,"")),max:null};
  return{min:null,max:null};
}
function geography(text){
  const raw=normalized(text);
  if(/\bindia(?:n)?\b/.test(raw))return["India"];
  const m=String(text).match(/(?:based\s+in|from|in)\s+([A-Z][A-Za-z .-]{2,35})(?=\s+(?:using|from|with|and|companies|company|businesses|organizations)|[,.;\n]|$)/);
  return m?[clean(m[1])]:[];
}
function concepts(text){
  const raw=normalized(text),out=[];
  if(/\bsaas\b/.test(raw))out.push("saas","software as a service");
  if(/\bproduct\b/.test(raw))out.push("software product","software platform");
  if(/\btech(?:nology)?\b/.test(raw))out.push("technology","software");
  const quoted=[...String(text).matchAll(/["“]([^"”]{2,80})["”]/g)].map(x=>clean(x[1]));
  for(const item of quoted)if(!out.some(x=>normalized(x)===normalized(item)))out.push(item);
  return out.length?[...new Set(out)]:["software company"];
}

export function compileCommand(input=""){
  const text=String(input||""),n=normalized(text),sheet=parseSheetTarget(text);
  const resume=n.match(/\b(?:resume|continue)\s+(?:apollo\s+)?(?:mission\s+)?(mission-[a-z0-9-]+|apollo-[a-z0-9-]+)/i);
  if(resume)return{owned:true,domain:"apollo-company-discovery",operation:"resume",missionId:resume[1],confidence:1,source:"deterministic-control-plane"};

  const hasApollo=/\bapollo\b/.test(n);
  const asksCompanies=/\b(compan(?:y|ies)|organizations?|businesses?|startups?|leads?)\b/.test(n)||(hasApollo&&/\b(saas|software|product|platform)\b/.test(n));
  const discovery=/\b(find|discover|search|get|bring|source|identify|list|fill)\b/.test(n);
  const contacts=/\b(poc|contact|email|phone|decision maker|enrich)\b/.test(n);
  const companyOnly=/\b(discovery only|company only|do not find pocs?|no pocs?)\b/.test(n);
  if(hasApollo&&asksCompanies&&discovery&&(!contacts||companyOnly)){
    const range=employeeRange(text);
    return{
      owned:true,domain:"apollo-company-discovery",operation:"apollo-company-discovery",confidence:1,
      source:"apollo",compiler:"deterministic-control-plane",originalRequest:text,targetCount:targetCount(text),
      sheet,spreadsheetId:sheet.spreadsheetId,sheetId:sheet.sheetId,sheetName:sheet.worksheet,country:geography(text),companyConcepts:concepts(text),employeeMin:range.min,employeeMax:range.max,sourceProvider:"apollo",filters:{geography:geography(text),employeeMin:range.min,employeeMax:range.max,concepts:concepts(text)},
      contactEnrichment:false,
    };
  }
  if(hasApollo&&contacts)return{owned:true,domain:"apollo-contact-enrichment",operation:"enrich-contacts",confidence:.98,source:"deterministic-control-plane",originalRequest:text,sheet};
  if(sheet.spreadsheetId&&/\b(sheet|worksheet|spreadsheet|append|update|fill)\b/.test(n))return{owned:true,domain:"google-sheet-operation",operation:"sheet-operation",confidence:.92,source:"deterministic-control-plane",originalRequest:text,sheet};
  if(/\blinkedin\b/.test(n)&&asksCompanies)return{owned:true,domain:"linkedin-company-research",operation:"company-research",confidence:.95,source:"deterministic-control-plane",originalRequest:text,sheet};
  if(/\b(reel|short video|instagram video)\b/.test(n))return{owned:true,domain:"reel-production",operation:"produce-reel",confidence:.9,source:"deterministic-control-plane",originalRequest:text};
  if(/\b(code|repository|github|bug|implement|refactor)\b/.test(n))return{owned:true,domain:"coding",operation:"coding",confidence:.82,source:"deterministic-control-plane",originalRequest:text};
  return{owned:false,domain:"general-conversation",operation:"conversation",confidence:.5,source:"deterministic-control-plane",originalRequest:text};
}

export const normalizeWorksheetTitle=normalized;
