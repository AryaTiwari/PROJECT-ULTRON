const path = require('path');
const web = require('./web');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');

const RECEIPT_PATH = path.join(config.dataDir, 'research-receipt.json');

function stripInvocation(text) {
  return String(text || '')
    .trim()
    .replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '')
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^(?:this\s+is\s+not\s+what\s+i\s+asked\s+you\s+to\s+do[\s,:;.!-]*)/i, '')
    .replace(/^(?:that(?:'s|\s+is)\s+not\s+what\s+i\s+asked(?:\s+for)?[\s,:;.!-]*)/i, '')
    .replace(/^(?:i\s+(?:basically|actually|already)?\s*asked\s+you\s+to\s+)/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVoiceIntent(text) {
  return stripInvocation(text)
    .replace(/\b(?:wheels|reals)\b(?=\s+(?:theme|themes|trend|trends|video|videos|content))/gi, 'reels')
    .replace(/\bmy\s+limit\s+(?:is|was)\s+(?=[a-z])/gi, 'my niche is ')
    .replace(/\blimit\s+(?:is|was)\s+(?=[a-z])/gi, 'niche is ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isContinuation(text) {
  const value = String(text || '').trim();
  return /^(?:just\s+)?(?:do\s+it|do\s+that(?:\s+now)?|go\s+ahead(?:\s+and\s+do\s+it)?|run\s+it|execute\s+it|continue|finish(?:\s+it)?(?:\s+now)?|resume|proceed|retry|try\s+again)\b/i.test(value)
    || /\bwhat\s+are\s+you\s+waiting\s+for\b[\s,;:!-]*(?:just\s+)?(?:do\s+it|go\s+ahead|start|proceed|execute)/i.test(value);
}

function isContentTrendTask(text) {
  const value = normalizeVoiceIntent(text);
  const trend = /\b(?:trend|trending|viral|theme|themes|content idea|content ideas|format|formats|what(?:'s| is) working|content opportunity)\b/i.test(value);
  const content = /\b(?:video|videos|reel|reels|short[- ]form|instagram|tiktok|youtube shorts?|creator|creators|influencer|influencers|client|clients|content)\b/i.test(value);
  return trend && content;
}

function isCreatorCollabTask(text) {
  const value = normalizeVoiceIntent(text);
  return /\b(?:creator|creators|influencer|influencers|ugc|instagram|reel|reels|tiktok|youtube)\b/i.test(value)
    && /\b(?:collab|collabs|collaboration|brand deal|brand deals|campaign|sponsor|sponsorship|ambassador|gifting|paid partnership|brand opportunity|marketplace)\b/i.test(value);
}

function regionHint(text) {
  if (/\b(?:india|indian|kolkata|delhi|mumbai|bangalore|bengaluru|hyderabad|chennai|pune)\b/i.test(String(text || ''))) return 'India';
  if (/\b(?:global|worldwide|international)\b/i.test(String(text || ''))) return 'global';
  return '';
}

function canonicalize(text) {
  const cleaned = normalizeVoiceIntent(text);
  const region = regionHint(cleaned);
  if (isContentTrendTask(cleaned)) {
    const location = region ? ` ${region}` : '';
    return `current short-form video content themes and social trends${location} for creators: Instagram Reels, TikTok and YouTube Shorts; practical themes clients can publish now. User intent: ${cleaned}`;
  }
  if (isCreatorCollabTask(cleaned)) {
    const location = region ? ` ${region}` : '';
    return `current creator brand collaboration opportunities${location}, paid partnerships, gifting and campaign market signals. User intent: ${cleaned}`;
  }
  return cleaned;
}

function qualifies(text) {
  const canonical = canonicalize(text);
  if (!canonical) return false;
  return isContentTrendTask(canonical) || isCreatorCollabTask(canonical) || web.researchProfile(canonical).shouldResearch;
}

function historyRows(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim())
    .map((item) => ({ role: item.role, content: String(item.content || '') }));
}

function resolve(message, history = []) {
  const current = String(message || '').trim();
  if (!current) return null;

  if (qualifies(current) && !isContinuation(current)) {
    const query = canonicalize(current);
    return {
      original: current,
      query,
      resumed: false,
      kind: isContentTrendTask(query) ? 'content-trends' : isCreatorCollabTask(query) ? 'creator-collabs' : 'general-research',
    };
  }

  if (!isContinuation(current)) return null;
  const rows = historyRows(history);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.role !== 'user') continue;
    if (!qualifies(row.content) || isContinuation(row.content)) continue;
    const query = canonicalize(row.content);
    return {
      original: row.content,
      query,
      resumed: true,
      continuation: current,
      kind: isContentTrendTask(query) ? 'content-trends' : isCreatorCollabTask(query) ? 'creator-collabs' : 'general-research',
    };
  }
  return null;
}

function receiptTemplate() {
  return { available: false, updatedAt: null, task: null, requestedSources: [], completedSources: [], errors: [], resultCount: 0, fetchedPages: 0, cached: false };
}

function lastReceipt() {
  return readJson(RECEIPT_PATH, receiptTemplate());
}

function saveReceipt(task, evidence) {
  const receipt = {
    available: true,
    updatedAt: new Date().toISOString(),
    task: {
      kind: task?.kind || 'general-research',
      original: task?.original || null,
      query: task?.query || evidence?.query || null,
      resumed: Boolean(task?.resumed),
    },
    provider: evidence?.provider || null,
    requestedSources: [...new Set(evidence?.research?.requestedSources || [])],
    completedSources: [...new Set(evidence?.research?.completedSources || [])],
    errors: Array.isArray(evidence?.research?.errors) ? evidence.research.errors : [],
    resultCount: Array.isArray(evidence?.results) ? evidence.results.length : 0,
    fetchedPages: Array.isArray(evidence?.pages) ? evidence.pages.filter((item) => item?.text).length : 0,
    cached: Boolean(evidence?.research?.cached),
  };
  writeJsonAtomic(RECEIPT_PATH, receipt);
  return receipt;
}

function isProvenanceQuestion(text) {
  const value = String(text || '').trim();
  return /\b(?:did\s+(?:you|u)\s+(?:use|search|check)|what\s+(?:source|sources|tools?|sites?)\s+did\s+(?:you|u)\s+use|where\s+did\s+(?:you|u)\s+get|was\s+(?:that|this)\s+(?:from|based\s+on)|did\s+(?:that|this)\s+use)\b/i.test(value)
    || /\b(?:hootsuite|afluencer|tinyfish)\b.*\b(?:use|used|search|searched|check|checked|source)\b/i.test(value);
}

function sourceLabel(source) {
  if (source === 'hootsuite') return 'Hootsuite';
  if (source === 'afluencer-india') return 'Afluencer India';
  if (source === 'afluencer-global') return 'Afluencer Global';
  if (source === 'general') return 'TinyFish general web';
  return source;
}

function provenanceAnswer(text) {
  if (!isProvenanceQuestion(text)) return null;
  const receipt = lastReceipt();
  if (!receipt.available) return { response: 'No verified research receipt is available yet, Sir. I won’t guess about sources I cannot prove.', receipt };

  const requested = new Set(receipt.requestedSources || []);
  const completed = new Set(receipt.completedSources || []);
  const wantsHootsuite = /\bhootsuite\b/i.test(String(text || ''));
  const wantsAfluencer = /\bafluencer\b/i.test(String(text || ''));
  const wantsTinyFish = /\btinyfish\b/i.test(String(text || ''));

  if (wantsHootsuite) {
    if (completed.has('hootsuite')) return { response: `Yes, Sir. Hootsuite completed in that research run, alongside ${completed.has('general') ? 'TinyFish web cross-checking' : 'the other completed sources'}.`, receipt };
    if (requested.has('hootsuite')) {
      const failure = (receipt.errors || []).find((item) => item?.source === 'hootsuite');
      return { response: `No, Sir. Hootsuite was requested but did not complete${failure?.error ? `: ${String(failure.error).slice(0, 180)}` : ''}. The answer used the sources that did complete; it should have disclosed that.`, receipt };
    }
    return { response: 'No, Sir. Hootsuite was not requested for that research run.', receipt };
  }

  if (wantsAfluencer) {
    const used = [...completed].filter((source) => source.startsWith('afluencer-'));
    return { response: used.length ? `Yes, Sir. ${used.map(sourceLabel).join(' and ')} completed in that research run.` : 'No, Sir. Afluencer did not complete in that research run.', receipt };
  }

  if (wantsTinyFish) {
    return { response: completed.has('general') ? 'Yes, Sir. TinyFish general web research completed in that run.' : 'No, Sir. The general TinyFish research packet did not complete in that run.', receipt };
  }

  const used = (receipt.completedSources || []).map(sourceLabel);
  const failed = (receipt.errors || []).map((item) => sourceLabel(item.source));
  let response = used.length ? `Sir, the verified sources used were ${used.join(', ')}.` : 'Sir, no research source completed successfully in the saved receipt.';
  if (failed.length) response += ` Failed/unavailable: ${failed.join(', ')}.`;
  return { response, receipt };
}

async function run(task, options = {}) {
  if (!task?.query) throw new Error('Research task query is required.');
  const evidence = await web.searchAndFetch(task.query, {
    searchLimit: options.searchLimit || 6,
    fetchTop: options.fetchTop ?? 3,
    specializedFetchTop: options.specializedFetchTop ?? 2,
    maxMergedResults: options.maxMergedResults || 14,
    maxMergedPages: options.maxMergedPages || 7,
  });
  const receipt = saveReceipt(task, evidence);
  return {
    ...evidence,
    researchReceipt: receipt,
    researchTask: {
      kind: task.kind,
      original: task.original,
      query: task.query,
      resumed: Boolean(task.resumed),
      continuation: task.continuation || null,
    },
  };
}

function deliveryInstruction(task, evidence = null) {
  if (!task) return '';
  const execution = 'RESEARCH EXECUTION: The web research has ALREADY RUN. Do not say you are going to search, ask the user to rerun anything, or request a more specific prompt when the evidence can answer the task. Synthesize the evidence and give the result now.';
  const requested = new Set(evidence?.research?.requestedSources || []);
  const completed = new Set(evidence?.research?.completedSources || []);
  const provenance = `SOURCE TRUTH: requested=[${[...requested].join(', ') || 'none'}]; completed=[${[...completed].join(', ') || 'none'}]. Never claim a source was used unless it appears in completed.`;
  const hootsuiteTruth = task.kind === 'content-trends' && requested.has('hootsuite') && !completed.has('hootsuite')
    ? ' Hootsuite did NOT complete. Briefly disclose that the Hootsuite signal was unavailable and that the themes are based on the completed broader web evidence; do not imply Hootsuite validation.'
    : '';
  if (task.kind === 'content-trends') {
    return `${execution} ${provenance}${hootsuiteTruth} For a trending-content request, give 4–6 concrete video themes the user's clients can actually use. For each: name the theme, one short reason it is timely, and one practical execution angle. Prefer useful themes over generic advice. Keep it concise enough for voice but valuable enough to act on.`;
  }
  if (task.kind === 'creator-collabs') {
    return `${execution} ${provenance} For creator-collab research, surface the strongest current opportunities/signals, separate India/global context when evidence allows, and state clearly when public Afluencer coverage is incomplete.`;
  }
  return `${execution} ${provenance} Lead with the conclusion, cite the strongest current signals in plain language, and give one practical implication for Sir.`;
}

module.exports = {
  RECEIPT_PATH,
  stripInvocation,
  normalizeVoiceIntent,
  isContinuation,
  isContentTrendTask,
  isCreatorCollabTask,
  canonicalize,
  qualifies,
  resolve,
  run,
  isProvenanceQuestion,
  provenanceAnswer,
  lastReceipt,
  saveReceipt,
  deliveryInstruction,
};
