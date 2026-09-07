const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline: streamPipeline } = require('stream/promises');

const factory = require('./reel-factory');
const render = require('./reel-pipeline');
const sources = require('./reel-sources');
const quality = require('./reel-quality');
const { writeJsonAtomic } = require('./persistence');

const VERSION = 3;
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const MAX_ASSET_BYTES = Math.max(8 * 1024 * 1024, Number(process.env.ULTRON_M3_ELEVATE_MAX_ASSET_BYTES || 45 * 1024 * 1024));
const DOWNLOAD_TIMEOUT_MS = Math.max(15000, Number(process.env.ULTRON_M3_ELEVATE_DOWNLOAD_TIMEOUT_MS || 90000));
const scoutCache = new Map();

const BRAND = Object.freeze({
  name: 'Elevate OS',
  positioning: 'The Operating System for Creators',
  audience: 'content creators',
  purpose: 'turn content into repeatable growth, stronger positioning and monetization opportunities',
  cta: 'Book your Free Strategy Session now — Elevate OS — elevateos.in',
  url: 'elevateos.in',
});

const RESOURCE = Object.freeze({
  target: '8GB Windows laptop',
  width: 1080, height: 1920, fps: 30, renderConcurrency: 1,
  maxAssetMB: Math.round(MAX_ASSET_BYTES / 1024 / 1024),
  localAi: false, browserRenderer: false, blender: false, fourK: false,
  paidGenerationAllowed: false,
  processing: 'streaming files + cached media + FFmpeg lightweight 2D',
});

const PILLARS = Object.freeze([
  { id: 'growth-retention', label: 'Growth & Retention', re: /\b(?:views?|reach|retention|watch time|skip|followers?|growth|viral|replay|completion|saves?|shares?)\b/i },
  { id: 'positioning', label: 'Positioning & Authority', re: /\b(?:position|niche|authority|identity|profile|bio|differentiate|stand out|personal brand)\b/i },
  { id: 'monetization', label: 'Monetization & Brand Opportunities', re: /\b(?:moneti[sz]|brand deal|collab|sponsor|income|earn|revenue|paid partnership|ugc|campaign)\b/i },
  { id: 'content-system', label: 'Content System', re: /\b(?:content strategy|pillar|consisten|calendar|workflow|posting|system|series|format|ideas?)\b/i },
  { id: 'conversion', label: 'Conversion & Action', re: /\b(?:conversion|profile visit|follow conversion|cta|lead|click|book|strategy session|dm|comment)\b/i },
]);

const MODES = Object.freeze(['stock-focus','kinetic-hook','metric-stack','retention-chart','growth-chart','conversion-funnel','comparison-card','content-pillars','creator-analytics','brand-cta']);
const MOTIONS = Object.freeze(['fast-text-pop','metric-pop','panel-rise','graph-reveal','slow-push','clean-cut']);

let installed = false;
const original = {};

function clean(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
function clamp(v, min, max, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function pillarFor(brief = '') { return PILLARS.find((p) => p.re.test(clean(brief))) || PILLARS[0]; }

function hookScore(value = '') {
  const text = clean(value);
  if (!text) return 0;
  const words = text.split(/\s+/);
  let score = 15;
  if (words.length >= 5 && words.length <= 14) score += 25;
  if (/\b(?:not|never|stop|mistake|wrong|real|problem|reason|why|quietly|actually|still)\b/i.test(text)) score += 20;
  if (/\b(?:creator|content|views?|followers?|brand|reach|retention|growth|viral|posting)\b/i.test(text)) score += 15;
  if (/\b(?:you|your)\b/i.test(text)) score += 10;
  if (/[.!?]$/.test(text)) score += 5;
  if (/^(?:here are|today we|in this video|welcome|let'?s talk)/i.test(text)) score -= 25;
  return Math.max(0, Math.min(100, score));
}

function hookCandidate(brief = '') {
  const id = pillarFor(brief).id;
  if (id === 'monetization') return 'Your follower count is not what good brands actually buy.';
  if (id === 'positioning') return 'Good content still gets ignored when your positioning is weak.';
  if (id === 'content-system') return 'Posting more is not the same as having a content strategy.';
  if (id === 'conversion') return 'Views are useless when nobody takes the next step.';
  if (/\b(?:retention|skip|watch time|completion)\b/i.test(brief)) return 'Your Reel can get views and still lose the viewer.';
  return 'More views can still mean your creator growth system is failing.';
}

function directorDirective(brief = '') {
  const p = pillarFor(brief);
  return [
    'ELEVATE OS ONLY.',
    `Audience: content creators. Pillar: ${p.label}.`,
    'Open with a creator-specific 5-14 word pattern interrupt, never a generic intro.',
    'Explain one real mechanism and one actionable fix before the CTA.',
    'Never invent metrics, platform facts, earnings or guaranteed virality.',
    'Mix creator B-roll with sparse 2D analytics, funnel, retention, comparison or kinetic graphics when semantically useful.',
    'No decorative 3D, fake dashboards, glitch filler or text walls.',
    'Final CTA: book the free Elevate OS strategy session at elevateos.in.',
    'Instagram-native: 1080x1920, 30fps, mobile safe zones, fast first two seconds.',
  ].join(' ');
}

function strengthenHook(plan, brief, options = {}) {
  if (!plan?.scenes?.length) return plan;
  const current = clean(plan.hook || plan.scenes[0].narration);
  if (hookScore(current) >= 68) return { ...plan, hookDiagnostics: { score: hookScore(current), changed: false } };
  const candidate = hookCandidate(brief);
  const scenes = plan.scenes.map((s, i) => i ? { ...s } : {
    ...s, purpose: 'Pattern interrupt', narration: candidate,
    onScreenText: quality.shortenOnScreenText(candidate.replace(/[.!?]+$/, ''), 5),
    energy: 'high', transition: 'hard-cut',
  });
  const next = quality.ensureBrandScene({ ...plan, hook: candidate, scenes }, brief, { ...options, brandPromotion: true });
  const audit = quality.auditPlan(next, brief, { ...options, brandPromotion: true });
  return audit.ok ? { ...next, hookDiagnostics: { score: hookScore(candidate), previousScore: hookScore(current), changed: true } }
    : { ...plan, hookDiagnostics: { score: hookScore(current), candidateRejected: true, changed: false } };
}

function visualMode(scene = {}, index = 0) {
  if (scene.isBrandCta) return 'brand-cta';
  const t = clean(`${scene.purpose} ${scene.onScreenText} ${scene.subText} ${scene.narration}`);
  if (index === 0) return 'kinetic-hook';
  if (/\b(?:retention|watch time|drop.?off|skip rate|completion|replay)\b/i.test(t)) return 'retention-chart';
  if (/\b(?:conversion|convert|profile visit|view.+follow|follow conversion|funnel|next step)\b/i.test(t)) return 'conversion-funnel';
  if (/\b(?:versus|vs\.?|compare|comparison|virality.+loyalty|viral.+loyal|views?.+followers?)\b/i.test(t)) return 'comparison-card';
  if (/\b(?:pillar|content system|repeatable|consisten|calendar|workflow|strategy)\b/i.test(t)) return 'content-pillars';
  if (/\b(?:growth|increase|scale|momentum)\b/i.test(t) && /\b(?:metric|analytics|track|measure|performance)\b/i.test(t)) return 'growth-chart';
  if (/\b(?:views?|saves?|shares?|comments?|followers?|reach|profile visits?|engagement)\b/i.test(t)) return 'metric-stack';
  if (/\b(?:analytics|dashboard|performance|measure|signal|data)\b/i.test(t)) return 'creator-analytics';
  return 'stock-focus';
}

function motionFor(mode) {
  if (mode === 'kinetic-hook') return 'fast-text-pop';
  if (/chart/.test(mode)) return 'graph-reveal';
  if (mode === 'metric-stack') return 'metric-pop';
  if (['conversion-funnel','comparison-card','content-pillars','creator-analytics'].includes(mode)) return 'panel-rise';
  if (mode === 'brand-cta') return 'clean-cut';
  return 'slow-push';
}

function decorate(plan, brief = '') {
  const p = pillarFor(brief);
  const scenes = (plan.scenes || []).map((scene, index) => {
    const mode = visualMode(scene, index);
    return { ...scene, visualDesign: { mode, motion: motionFor(mode), lightweight: true, safeZoneRequired: true } };
  });
  const visualMix = scenes.reduce((a, s) => { const m = s.visualDesign.mode; a[m] = (a[m] || 0) + 1; return a; }, {});
  return {
    ...plan, scenes,
    elevateEngine: {
      version: VERSION, scope: 'elevate-os-only', positioning: BRAND.positioning,
      contentPillar: p.id, contentPillarLabel: p.label,
      hook: { score: hookScore(plan.hook || scenes[0]?.narration), changed: Boolean(plan.hookDiagnostics?.changed) },
      cta: { type: 'free-strategy-session', valueFirst: true, text: BRAND.cta },
      visualMix, graphicModes: MODES, motionPresets: MOTIONS,
      viralThemeTracking: 'existing-reel-intelligence-live-cache',
      viralClaimPolicy: 'directional-signal-only-never-guaranteed',
      publicMediaScout: 'wikimedia-commons-license-aware-fallback',
      resourceProfile: RESOURCE,
    },
  };
}

function enhancePlan(plan, brief = '', options = {}) {
  let next = quality.ensureBrandScene(plan, brief, { ...options, brandPromotion: true });
  next = strengthenHook(next, brief, options);
  next = decorate(next, brief);
  next.qualityAudit = quality.auditPlan(next, brief, { ...options, brandPromotion: true });
  return next;
}

function stripHtml(v = '') {
  return String(v).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim();
}
function mv(meta, key) { return stripHtml(meta?.[key]?.value || ''); }

function safeCommercialLicense(license = '') {
  const v = clean(license).toLowerCase();
  if (!v || /\b(?:nc|noncommercial|non-commercial|nd|no derivatives|all rights reserved)\b/i.test(v)) return false;
  if (/public domain|cc0|creative commons zero/.test(v)) return true;
  return (/cc\s*by\b|creative commons attribution\b/.test(v) && !/\bsa\b|share.?alike/i.test(v));
}

function normalizeCommonsPage(page = {}) {
  const info = page.imageinfo?.[0];
  if (!info?.url) return null;
  const mime = clean(info.mime).toLowerCase();
  const mediaType = String(info.mediatype).toUpperCase() === 'VIDEO' || mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : null;
  if (mediaType === 'image' && !/^image\/(?:jpeg|png|webp)$/i.test(mime)) return null;
  if (mediaType === 'video' && !/^video\/(?:mp4|webm|ogg)$/i.test(mime)) return null;
  if (!mediaType) return null;
  const meta = info.extmetadata || {};
  const license = mv(meta, 'LicenseShortName') || mv(meta, 'UsageTerms');
  if (!safeCommercialLicense(license)) return null;
  const artist = mv(meta, 'Artist') || mv(meta, 'Credit') || 'Wikimedia Commons contributor';
  const title = clean(page.title).replace(/^File:/i, '') || 'Commons media';
  return {
    provider: 'wikimedia-commons', mediaType, mime, id: String(page.pageid || title),
    width: Number(info.width || 0) || null, height: Number(info.height || 0) || null,
    url: mediaType === 'image' ? String(info.thumburl || info.url) : String(info.url),
    sourcePage: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title || '').replace(/ /g, '_'))}`,
    creator: artist, attribution: `${title} — ${artist} — ${license} — Wikimedia Commons`,
    license, commercialUse: true, publicMedia: true,
  };
}

async function searchPublicMedia(query, options = {}) {
  const q = clean(query).replace(/\bvertical video\b/gi, '').replace(/\bcontent creator\b/gi, 'creator').slice(0, 120);
  if (!q) return [];
  const key = `${q.toLowerCase()}|${Number(options.perPage || 6)}`;
  const cached = scoutCache.get(key);
  if (cached && Date.now() - cached.at < 12 * 60 * 60 * 1000) return cached.items;
  const params = new URLSearchParams({
    action:'query', format:'json', formatversion:'2', generator:'search', gsrsearch:q, gsrnamespace:'6',
    gsrlimit:String(Math.max(3, Math.min(8, Number(options.perPage || 6)))),
    prop:'imageinfo', iiprop:'url|mime|mediatype|size|extmetadata', iiurlwidth:'1080',
    iiextmetadatafilter:'LicenseShortName|LicenseUrl|Artist|Credit|UsageTerms', origin:'*',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(4000, Number(options.timeoutMs || 10000)));
  try {
    const response = await fetch(`${COMMONS_API}?${params}`, {
      headers:{ Accept:'application/json', 'User-Agent':'ULTRON-Mark3-Elevate-Reel-Engine/3.0' }, signal:controller.signal,
    });
    if (!response.ok) throw new Error(`Wikimedia Commons HTTP ${response.status}.`);
    const data = await response.json();
    const items = (data?.query?.pages || []).map(normalizeCommonsPage).filter(Boolean);
    scoutCache.set(key, { at:Date.now(), items });
    if (scoutCache.size > 50) scoutCache.delete(scoutCache.keys().next().value);
    return items;
  } finally { clearTimeout(timer); }
}

function assetExt(asset = {}) {
  if (asset.mime === 'image/png') return '.png';
  if (asset.mime === 'image/webp') return '.webp';
  if (asset.mediaType === 'image') return '.jpg';
  if (asset.mime === 'video/webm') return '.webm';
  if (asset.mime === 'video/ogg') return '.ogv';
  try {
    const ext = path.extname(new URL(asset.url).pathname).toLowerCase();
    if (['.mp4','.webm','.mov','.ogv','.jpg','.jpeg','.png','.webp'].includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch {}
  return '.mp4';
}

function safeAssetName(asset, index = 1) {
  const provider = clean(asset.provider || 'stock').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'stock';
  const id = clean(asset.id || index).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || String(index);
  return `${String(index).padStart(2,'0')}-${provider}-${id}${assetExt(asset)}`;
}

async function streamDownload(asset, destination, options = {}) {
  if (!asset?.url) throw new Error('Stock asset has no downloadable URL.');
  const target = path.resolve(destination);
  const temp = `${target}.${process.pid}.${Date.now()}.part`;
  fs.mkdirSync(path.dirname(target), { recursive:true });
  const maxBytes = Math.max(5 * 1024 * 1024, Number(options.maxBytes || MAX_ASSET_BYTES));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(15000, Number(options.timeoutMs || DOWNLOAD_TIMEOUT_MS)));
  let bytes = 0;
  try {
    const response = await fetch(asset.url, { headers:{ Accept:'video/*,image/*,*/*;q=0.2', 'User-Agent':'ULTRON-Mark3-Elevate-Reel-Engine/3.0' }, signal:controller.signal });
    if (!response.ok || !response.body) throw new Error(`Stock asset download HTTP ${response.status}.`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw new Error(`Asset exceeds lightweight limit (${declared} > ${maxBytes}).`);
    const limiter = new Transform({ transform(chunk, enc, cb) {
      bytes += chunk.length;
      cb(bytes > maxBytes ? new Error(`Asset exceeded ${Math.round(maxBytes/1048576)} MB lightweight limit.`) : null, bytes > maxBytes ? undefined : chunk);
    }});
    await streamPipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(temp));
    fs.renameSync(temp, target);
    return { ok:true, path:target, bytes, provider:asset.provider, id:asset.id, attribution:asset.attribution,
      sourcePage:asset.sourcePage, license:asset.license, commercialUse:asset.commercialUse !== false, mediaType:asset.mediaType || 'video' };
  } catch (e) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    throw e;
  } finally { clearTimeout(timer); }
}

async function searchWithScout(query, options = {}) {
  let base;
  try { base = await original.searchVideos(query, options); }
  catch (e) { base = { ok:false, query, items:[], providers:[], errors:[{provider:'stock-router',error:e.message}] }; }
  if ((base.items || []).length >= 4 && !/^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_REEL_PUBLIC_SCOUT_ALWAYS || '0'))) return base;
  let publicItems = [];
  const errors = [...(base.errors || [])];
  try { publicItems = await searchPublicMedia(query, { perPage:6 }); }
  catch (e) { errors.push({ provider:'wikimedia-commons', error:e.message }); }
  const seen = new Set();
  const items = [...(base.items || []), ...publicItems].filter((x) => { const k=`${x.provider}:${x.id}`; if(seen.has(k)) return false; seen.add(k); return true; });
  const providers = [...new Set(items.map((x) => x.provider))];
  return { ...base, ok:items.length > 0, provider:providers.length > 1 ? 'multi-stock+public' : providers[0] || null,
    providers, items, errors, degraded:errors.length > 0 && items.length > 0, publicMediaScoutUsed:publicItems.length > 0 };
}

function sourceStatus() {
  const base = original.sourceStatus();
  return { ...base, anyConfigured:true, configuredCount:Number(base.configuredCount || 0)+1,
    providers:[...(base.providers || []), {provider:'wikimedia-commons',configured:true,apiKeyRequired:false,commercialUse:true}],
    publicMediaScout:{implemented:true,licenseAware:true,blindScraping:false,photoAndVideo:true},
    streamingDownloads:true, maxAssetMB:RESOURCE.maxAssetMB };
}

function ffPath(v) { return String(v || '').replace(/\\/g,'/').replace(/^([A-Za-z]):/,'$1\\:').replace(/'/g,"\\'"); }
function en(s,e) { return `enable='between(t,${Number(s).toFixed(2)},${Number(e).toFixed(2)})'`; }
function box(x,y,w,h,c,s,e) { return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill:${en(s,e)}`; }
function text(font,label,x,y,size,s,e) {
  return `drawtext=fontfile='${ffPath(font)}':text='${label}':fontsize=${size}:fontcolor=white@0.94:borderw=1:bordercolor=black@0.6:x=${x}:y=${y}:${en(s,e)}`;
}

function graphicsFilters(plan, font) {
  const f=[]; let scenes=0; const modes={};
  (plan.scenes || []).forEach((scene,index) => {
    const mode=scene.visualDesign?.mode || visualMode(scene,index); modes[mode]=(modes[mode]||0)+1;
    if (mode==='stock-focus'||mode==='brand-cta') return;
    const s=Number(scene.start||0), e=Number(scene.end||s+1), g=Math.min(e-.2,s+.55); scenes++;
    if(mode==='kinetic-hook'){ f.push(box(116,540,8,270,'0x5B8CFF@0.95',s,Math.min(e,s+1.7))); return; }
    f.push(box(125,1080,830,350,'black@0.48',g,e), box(125,1080,8,350,'0x5B8CFF@0.95',g,e));
    if(mode==='retention-chart'||mode==='growth-chart'){
      f.push(text(font,mode==='retention-chart'?'RETENTION':'GROWTH SIGNAL',170,1110,34,g,e));
      const hs=mode==='retention-chart'?[180,150,118,92,70]:[62,88,118,150,185];
      hs.forEach((h,i)=>f.push(box(205+i*118,1365-h,68,h,'0x5B8CFF@0.88',g+.12+i*.09,e)));
      return;
    }
    if(mode==='conversion-funnel'){
      [['VIEW',210,660],['PROFILE',285,510],['FOLLOW',360,360]].forEach((r,i)=>{
        const y=1170+i*84, ss=g+.10+i*.11; f.push(box(r[1],y,r[2],58,i===2?'0x5B8CFF@0.9':'white@0.14',ss,e),text(font,r[0],r[1]+22,y+12,28,ss,e));
      }); return;
    }
    if(mode==='comparison-card'){
      f.push(box(180,1170,330,185,'white@0.12',g+.1,e),box(570,1170,330,185,'0x5B8CFF@0.45',g+.2,e),
        text(font,'VIEWS',245,1230,38,g+.1,e),text(font,'FOLLOWS',625,1230,38,g+.2,e)); return;
    }
    const labels=mode==='content-pillars'?['HOOK','VALUE','CTA']:['VIEWS','SAVES','FOLLOWS'];
    labels.forEach((label,i)=>{const y=1160+i*82,ss=g+.1+i*.1;f.push(box(190,y,700,58,i===2?'0x5B8CFF@0.62':'white@0.12',ss,e),text(font,label,220,y+12,28,ss,e));});
  });
  return {filters:f,graphicScenes:scenes,modes};
}

function trendSignal(plan={}) {
  const i=plan.intelligence||{}, formats=Array.isArray(i.selectedFormats)?i.selectedFormats:[];
  return { theme:formats[0]||null, supportingFormats:formats.slice(1,3), trendMode:i.trendMode||null,
    completedSources:i.completedSources||[], updatedAt:i.trendUpdatedAt||null, confidenceMode:'directional', guarantee:false };
}

function applyGraphics(result, options={}) {
  if(!result?.ok||options.graphics===false) return {result,meta:{applied:false,reason:'disabled-or-not-ready'}};
  const output=path.resolve(result.output?.path||result.paths?.output||'');
  const font=render.findCaptionFont();
  if(!output||!fs.existsSync(output)||!font) return {result,meta:{applied:false,reason:'output-or-font-missing'}};
  const spec=graphicsFilters(result.plan,font);
  if(!spec.filters.length) return {result,meta:{applied:false,reason:'no-semantic-graphics',modes:spec.modes}};
  const temp=path.join(result.paths.dir,'render-temp','elevate-graphics-pass.mp4');
  render.run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',output,'-vf',spec.filters.join(','),
    '-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf',String(clamp(options.graphicsCrf,18,23,19)),
    '-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',temp],{timeoutMs:300000});
  fs.copyFileSync(temp,output); try{fs.unlinkSync(temp);}catch{}
  return {result:{...result,output:render.verifyOutput(output)},meta:{applied:true,engine:'ffmpeg-lightweight-2d-v1',passCount:1,graphicScenes:spec.graphicScenes,modes:spec.modes,motions:MOTIONS}};
}

function install() {
  if(installed) return status();
  original.searchVideos=sources.searchVideos; original.safeAssetName=sources.safeAssetName; original.downloadAsset=sources.downloadAsset; original.sourceStatus=sources.status;
  sources.searchVideos=searchWithScout; sources.safeAssetName=safeAssetName; sources.downloadAsset=streamDownload; sources.status=sourceStatus;

  original.createJob=factory.createJob;
  factory.createJob=async(brief,options={})=>{
    const scoped={...options,brandPromotion:true,style:`${clean(options.style||'cinematic, fast-paced, premium creator reel')}. ${directorDirective(brief)}`.slice(0,4200)};
    const result=await original.createJob(brief,scoped);
    if(!result?.plan)return result;
    result.plan=enhancePlan(result.plan,brief,scoped);
    if(result.job){result.job.qualityAudit=result.plan.qualityAudit;result.job.elevateEngine=result.plan.elevateEngine;result.job.zeroCostOnly=true;result.job.paidGenerationAllowed=false;if(result.paths?.job)writeJsonAtomic(result.paths.job,result.job);}
    if(result.paths?.plan)writeJsonAtomic(result.paths.plan,result.plan);
    return result;
  };

  original.build=render.build;
  render.build=async(brief,options={})=>{
    let result=await original.build(brief,{...options,brandPromotion:true});
    if(!result?.ok)return result;
    result.plan={...result.plan,elevateEngine:{...(result.plan.elevateEngine||{}),trendSignal:trendSignal(result.plan)}};
    if(result.paths?.plan)writeJsonAtomic(result.paths.plan,result.plan);
    try{
      const g=applyGraphics(result,options);result=g.result;result.polish={...(result.polish||{}),graphicsEngine:g.meta};
      if(result.job){result.job.output=result.output;result.job.polish=result.polish;result.job.elevateEngine=result.plan.elevateEngine;result.job.updatedAt=new Date().toISOString();if(result.paths?.job)writeJsonAtomic(result.paths.job,result.job);}
    }catch(e){result.polish={...(result.polish||{}),graphicsEngine:{applied:false,reason:e.message,degradedGracefully:true}};}
    return result;
  };
  installed=true; return status();
}

function status(){return{implemented:true,installed,version:VERSION,scope:'elevate-os-only',brand:BRAND,
  contentPillars:PILLARS.map(({id,label})=>({id,label})),hookEngine:true,ctaEngine:true,semanticVisualRouter:true,
  graphicModes:MODES,motionPresets:MOTIONS,viralThemeIntelligence:{implemented:true,source:'Reel Intelligence live/cached public research',guaranteesVirality:false},
  publicMediaScout:{implemented:true,provider:'Wikimedia Commons Action API',apiKeyRequired:false,licenseAware:true,blindScraping:false,photoAndVideo:true},
  streamingDownloads:true,zeroCostOnly:true,paidGenerationAllowed:false,resourceProfile:RESOURCE};}

module.exports={VERSION,BRAND,RESOURCE,PILLARS,MODES,MOTIONS,pillarFor,hookScore,hookCandidate,directorDirective,strengthenHook,
  visualMode,motionFor,decorate,enhancePlan,safeCommercialLicense,normalizeCommonsPage,searchPublicMedia,safeAssetName,
  streamDownload,searchWithScout,sourceStatus,graphicsFilters,trendSignal,applyGraphics,install,status};
