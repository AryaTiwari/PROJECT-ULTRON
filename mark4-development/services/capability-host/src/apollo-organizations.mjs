const ENDPOINT="https://api.apollo.io/api/v1/mixed_companies/search";

const number=value=>Number.isFinite(Number(value))?Number(value):null;
const cleanUrl=value=>String(value||"").trim()||null;
export function normalizeApolloOrganization(item={}){
  const organization=item.organization||item;
  const city=organization.city||organization.raw_address?.city||null;
  const state=organization.state||organization.raw_address?.state||null;
  const country=organization.country||organization.raw_address?.country||null;
  const domain=organization.primary_domain||organization.domain||organization.website_url?.replace(/^https?:\/\//i,"").replace(/\/.*$/,"")||null;
  return{
    id:organization.id||null,apolloOrganizationId:organization.id||null,name:organization.name||null,companyName:organization.name||null,domain,website:cleanUrl(organization.website_url)||(domain?`https://${domain}`:null),
    linkedin:cleanUrl(organization.linkedin_url),linkedinUrl:cleanUrl(organization.linkedin_url),employees:number(organization.estimated_num_employees),employeeCount:number(organization.estimated_num_employees),industry:organization.industry||null,
    city,state,country,location:[city,state,country].filter(Boolean).join(", ")||null,
    keywords:Array.isArray(organization.keywords)?organization.keywords.filter(Boolean):[],
    description:organization.short_description||organization.seo_description||null,
  };
}

export async function searchApolloOrganizations({locations=[],employeeMin=null,employeeMax=null,keywords="",page=1,perPage=100,fetchImpl=fetch}={}){
  const apiKey=String(process.env.APOLLO_API_KEY||"").trim();
  if(!apiKey)throw Object.assign(new Error("APOLLO_API_KEY is not configured."),{code:"APOLLO_AUTH_REQUIRED"});
  const url=new URL(ENDPOINT);
  for(const location of locations.filter(Boolean))url.searchParams.append("organization_locations[]",String(location));
  if(employeeMin!==null||employeeMax!==null){
    const low=employeeMin===null?0:Number(employeeMin),high=employeeMax===null?"":Number(employeeMax);
    url.searchParams.append("organization_num_employees_ranges[]",`${low},${high}`);
  }
  const keywordList=(Array.isArray(keywords)?keywords:[keywords]).map(value=>String(value||"").trim()).filter(Boolean);
  for(const keyword of keywordList)url.searchParams.append("q_organization_keyword_tags[]",keyword);
  url.searchParams.set("page",String(Math.max(1,Number(page)||1)));
  url.searchParams.set("per_page",String(Math.max(1,Math.min(100,Number(perPage)||100))));
  const response=await fetchImpl(url,{method:"POST",headers:{"x-api-key":apiKey,Accept:"application/json","Content-Type":"application/json"},body:"{}"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error(data?.message||data?.error||`Apollo HTTP ${response.status}`);
    error.code=response.status===401||response.status===403?"APOLLO_AUTH_FAILED":response.status===429?"APOLLO_RATE_LIMITED":"APOLLO_SEARCH_FAILED";
    error.status=response.status;throw error;
  }
  const raw=data.organizations||data.accounts||data.companies||[];
  return{organizations:raw.map(normalizeApolloOrganization).filter(item=>item.id||item.name),pagination:data.pagination||null,page:Number(page)||1,callCount:1,endpoint:ENDPOINT};
}

export const APOLLO_ORGANIZATION_SEARCH_ENDPOINT=ENDPOINT;
