const SEARCH="https://api.apollo.io/api/v1/mixed_people/api_search";
const TIERS=[
  {priority:1,label:"Founder / CEO / Director / Owner",titles:["founder","chief executive officer","ceo","owner","managing director","director","executive director"]},
  {priority:2,label:"Co-Founder / Recruiting Head / Manager",titles:["co-founder","cofounder","head recruiter","head of recruitment","recruitment head","recruitment manager","recruiting manager","head of talent acquisition","talent acquisition manager","hr manager","human resources manager","hiring manager"]},
  {priority:3,label:"HR Recruiter",titles:["hr recruiter","human resources recruiter","technical recruiter","talent acquisition recruiter","recruiter"]}
];
const words=s=>String(s||"").toLowerCase().replace(/\b(?:private|pvt|limited|ltd|llp|inc|corp|company|co)\b/g," ").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
function sameOrg(person,company){const a=words(company),b=words(person?.organization_name||person?.organization?.name||"");return a&&b&&(a===b||a.includes(b)||b.includes(a));}
function phoneOf(p){
  const candidates=[p?.phone_number,p?.sanitized_phone,p?.direct_phone,p?.mobile_phone,...(Array.isArray(p?.phone_numbers)?p.phone_numbers.map(x=>x?.sanitized_number||x?.raw_number||x?.number):[])];
  return candidates.find(Boolean)||null;
}
function personOf(p,tier,company){return{id:p.id||null,name:p.name||[p.first_name,p.last_name].filter(Boolean).join(" ")||null,title:p.title||null,linkedin:p.linkedin_url||null,email:p.email||null,phone:phoneOf(p),organization:p.organization_name||p.organization?.name||company,priority:tier.priority,priorityLabel:tier.label};}
async function searchTier(key,{company,domain,location},tier){
  const u=new URL(SEARCH);for(const t of tier.titles)u.searchParams.append("person_titles[]",t);
  if(domain)u.searchParams.append("q_organization_domains_list[]",domain);else u.searchParams.set("q_keywords",company);
  if(location)u.searchParams.append("person_locations[]",location);
  u.searchParams.set("include_similar_titles","true");u.searchParams.set("page","1");u.searchParams.set("per_page","25");
  const r=await fetch(u,{method:"POST",headers:{"x-api-key":key,Accept:"application/json"}});const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data?.message||data?.error||`Apollo HTTP ${r.status}`);
  return (data.people||data.contacts||[]).filter(x=>sameOrg(x,company)).map(p=>personOf(p,tier,company));
}
export async function findCompanyContacts({company,domain="",location="",limit=2,excludeLinkedin="",excludeName="",excludeEmail=""}){
  const key=String(process.env.APOLLO_API_KEY||"").trim();if(!key)throw new Error("APOLLO_API_KEY is not configured.");if(!company)throw new Error("company is required.");
  const selected=[],seen=new Set();
  const blockedLinkedin=String(excludeLinkedin||"").trim().toLowerCase().replace(/\/$/,"");
  const blockedName=String(excludeName||"").trim().toLowerCase();
  const blockedEmail=String(excludeEmail||"").trim().toLowerCase();
  for(const tier of TIERS){
    const people=await searchTier(key,{company,domain,location},tier);
    for(const person of people){
      const linkedin=String(person.linkedin||"").trim().toLowerCase().replace(/\/$/,"");
      const name=String(person.name||"").trim().toLowerCase();
      const email=String(person.email||"").trim().toLowerCase();
      if((blockedLinkedin&&linkedin===blockedLinkedin)||(blockedName&&name===blockedName)||(blockedEmail&&email===blockedEmail))continue;
      const identity=String(person.id||person.linkedin||person.email||person.name||"").toLowerCase();
      if(!identity||seen.has(identity))continue;
      seen.add(identity);selected.push(person);
      if(selected.length>=Math.max(1,Math.min(2,Number(limit)||2)))return{found:true,contacts:selected};
    }
  }
  return{found:selected.length>0,contacts:selected};
}
export async function findCompanyContact(args){
  const result=await findCompanyContacts({...args,limit:1});
  const person=result.contacts?.[0]||null;
  return person?{found:true,priority:person.priority,priorityLabel:person.priorityLabel,person}:{found:false,person:null};
}
