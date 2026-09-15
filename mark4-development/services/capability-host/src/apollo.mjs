const SEARCH="https://api.apollo.io/api/v1/mixed_people/api_search";
const TIERS=[
  {priority:1,label:"Founder / Director / Owner",titles:["founder","co-founder","owner","director","managing director","executive director"]},
  {priority:2,label:"Recruiting Head / Manager",titles:["head recruiter","head of recruitment","recruitment head","recruitment manager","recruiting manager","head of talent acquisition","talent acquisition manager","hr manager","human resources manager","hiring manager","manager"]},
  {priority:3,label:"HR Recruiter",titles:["hr recruiter","human resources recruiter","technical recruiter","talent acquisition recruiter","recruiter"]}
];
const words=s=>String(s||"").toLowerCase().replace(/\b(?:private|pvt|limited|ltd|llp|inc|corp|company|co)\b/g," ").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
function sameOrg(person,company){const a=words(company),b=words(person?.organization_name||person?.organization?.name||"");return a&&b&&(a===b||a.includes(b)||b.includes(a));}
export async function findCompanyContact({company,domain="",location=""}){
  const key=String(process.env.APOLLO_API_KEY||"").trim();if(!key)throw new Error("APOLLO_API_KEY is not configured.");if(!company)throw new Error("company is required.");
  for(const tier of TIERS){
    const u=new URL(SEARCH);for(const t of tier.titles)u.searchParams.append("person_titles[]",t);
    if(domain)u.searchParams.append("q_organization_domains_list[]",domain);else u.searchParams.set("q_keywords",company);
    if(location)u.searchParams.append("person_locations[]",location);
    u.searchParams.set("include_similar_titles","true");u.searchParams.set("page","1");u.searchParams.set("per_page","25");
    const r=await fetch(u,{method:"POST",headers:{"x-api-key":key,Accept:"application/json"}});const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data?.message||data?.error||`Apollo HTTP ${r.status}`);
    const p=(data.people||data.contacts||[]).filter(x=>sameOrg(x,company))[0];
    if(p)return{found:true,priority:tier.priority,priorityLabel:tier.label,person:{id:p.id||null,name:p.name||[p.first_name,p.last_name].filter(Boolean).join(" "),title:p.title||null,linkedin:p.linkedin_url||null,email:p.email||null,organization:p.organization_name||p.organization?.name||company}};
  }
  return{found:false,person:null};
}
