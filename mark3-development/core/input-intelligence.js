const conversation = require('./conversation');
const assistant = require('./assistant');
const voice = require('./voice-orchestrator');
const { emit } = require('./events');

const VERSION = '1.0.0';
const MAX_HISTORY = 180;
const SAFE_AUTO_THRESHOLD = 0.72;
const CLARIFY_THRESHOLD = 0.50;

const STOPWORDS = new Set([
  'the','a','an','to','of','for','and','or','on','in','with','this','that','it','them','those','these','my','our','your',
  'please','can','could','would','will','you','me','do','make','run','go','same','again','now','just','ultron','sir','bro',
]);

const RISKY_ACTIONS = /\b(?:delete|remove|erase|wipe|send|email|mail|message|dm|publish|post|push|commit|merge|deploy|purchase|buy|pay|transfer|book|cancel|submit|apply|invite|share)\b/i;
const HARD_CONTINUATION = /^(?:do\s+(?:it|that)|run\s+it|execute\s+it|go\s+ahead|proceed|continue|resume|retry|try\s+again|same|same\s+again|same\s+as\s+before|do\s+the\s+same|this\s+one\s+too|same\s+for\s+this|again|finish\s+it|complete\s+it)[.!?\s]*$/i;
const TARGET_ONLY = /^(?:https?:\/\/\S+|@[\w .()\-]+)$/i;

function normalize(text) {
  return String(text || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripWake(text) {
  return normalize(text).replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '').trim();
}

function words(text) {
  return stripWake(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w .()\-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function tokenOverlap(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const token of A) if (B.has(token)) shared += 1;
  return shared / Math.max(1, Math.min(A.size, B.size));
}

function classify(text) {
  const value = stripWake(text).toLowerCase();
  if (!value) return 'empty';
  if (/\b(?:apollo|lead\s+enrich|enrich(?:ment)?\s+(?:this\s+)?sheet|phone\s*(?:and|\+|&)\s*email|email\s*(?:and|\+|&)\s*phone)\b/.test(value)) return 'lead-enrichment';
  if (/\b(?:google\s*sheet|spreadsheet|sheet)\b/.test(value) && /\b(?:enrich|fill|find|get|fetch|phone|email|contact|lead)\b/.test(value)) return 'lead-enrichment';
  if (/\b(?:reel|video|clip|animation|b-?roll|image|poster|thumbnail|logo|pdf|docx|document|report|proposal)\b/.test(value)
      && /\b(?:make|create|generate|render|design|produce|build|export|prepare)\b/.test(value)) return 'artifact-generation';
  if (/\b(?:github|repo|repository|codebase|branch|bug|code|implement|refactor|function|script|commit|deploy)\b/.test(value)) return 'coding';
  if (/\b(?:research|search|look\s*up|find\s+(?:latest|current|online)|check\s+(?:online|web)|investigate)\b/.test(value)) return 'research';
  if (/\b(?:developer|sales|trader|influencer|executive)\s+mode\b|\b(?:switch|change|go)\s+(?:back\s+)?(?:to\s+)?\w+\s+mode\b/.test(value)) return 'mode-control';
  if (/\b(?:remind|schedule|calendar|meeting|appointment)\b/.test(value)) return 'scheduling';
  return 'general';
}

function hasAction(text) {
  return /\b(?:enrich|fill|find|get|fetch|make|create|generate|render|design|produce|build|research|search|check|inspect|fix|implement|update|change|write|draft|analyze|analyse|compare|explain|run|execute|resume|retry|continue|open|read|show|list|send|publish|post|commit|deploy)\b/i.test(stripWake(text));
}

function isVague(text) {
  const value = stripWake(text);
  if (!value) return true;
  if (HARD_CONTINUATION.test(value) || TARGET_ONLY.test(value)) return true;
  const count = value.split(/\s+/).filter(Boolean).length;
  return count <= 8 && /\b(?:same|again|this|that|it|one|previous|last|before|continue|resume|retry|proceed)\b/i.test(value) && !hasAction(value);
}

function extractTarget(text) {
  const value = normalize(text);
  const url = value.match(/https?:\/\/[^\s<>'"`]+/i)?.[0];
  if (url) return url.replace(/[),.;!?]+$/, '');
  const mention = value.match(/@[\w .()\-]{2,}/)?.[0];
  if (mention) return mention.trim();
  return null;
}

function isRepeatSameTarget(text) {
  return /\b(?:again|retry|resume|same\s+(?:one|sheet|task)|do\s+it\s+again|run\s+it\s+again)\b/i.test(stripWake(text));
}

function candidateIntent(row) {
  return row?.inputIntent || classify(row?.resolvedMessage || row?.content || '');
}

function actionableCandidate(row) {
  const value = String(row?.resolvedMessage || row?.content || '').trim();
  if (!value || row?.role !== 'user') return false;
  if (isVague(value)) return false;
  return hasAction(value) || classify(value) !== 'general';
}

function historyRows(suppliedHistory = null) {
  const supplied = Array.isArray(suppliedHistory) ? suppliedHistory : [];
  const persisted = conversation.history(MAX_HISTORY);
  const combined = [...persisted, ...supplied.map((row) => ({ ...row, supplied: true }))];
  const seen = new Set();
  return combined.filter((row) => {
    const key = `${row?.role}|${row?.at || ''}|${String(row?.content || '').trim()}`;
    if (!row || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreCandidate(current, currentIntent, row, index, total) {
  const text = String(row?.resolvedMessage || row?.content || '');
  const intent = candidateIntent(row);
  const age = Math.max(0, total - 1 - index);
  const recency = Math.max(0, 1 - age / Math.max(12, total));
  const lexical = tokenOverlap(current, text);
  let intentScore = 0;
  if (currentIntent !== 'general' && currentIntent === intent) intentScore = 1;
  else if (currentIntent === 'general' && intent !== 'general') intentScore = 0.48;
  else if (/\bsheet|spreadsheet\b/i.test(current) && intent === 'lead-enrichment') intentScore = 0.9;
  else if (/\breel|video|pdf|document|image\b/i.test(current) && intent === 'artifact-generation') intentScore = 0.9;
  else if (/\brepo|code|github\b/i.test(current) && intent === 'coding') intentScore = 0.9;

  const target = extractTarget(current);
  const candidateTarget = extractTarget(text);
  const targetScore = target && candidateTarget ? 0.15 : 0;
  return recency * 0.42 + intentScore * 0.36 + lexical * 0.17 + targetScore + (hasAction(text) ? 0.05 : 0);
}

function previousCandidates(current, suppliedHistory = null) {
  const rows = historyRows(suppliedHistory);
  const intent = classify(current);
  return rows
    .map((row, index) => ({ row, index, score: actionableCandidate(row) ? scoreCandidate(current, intent, row, index, rows.length) : -1 }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

function explicitLeadShortcut(text) {
  const value = stripWake(text);
  const target = extractTarget(value);
  if (!target) return null;
  if (/\b(?:apollo|enrich|lead|phone|email|contact)\b/i.test(value) && /\b(?:sheet|spreadsheet)\b/i.test(value)) {
    return `Ultron, enrich this sheet with Apollo: ${target}`;
  }
  return null;
}

function reconstruct(current, candidate) {
  const currentIntent = classify(current);
  const candidateText = String(candidate?.row?.resolvedMessage || candidate?.row?.content || '').trim();
  const candidateType = candidateIntent(candidate?.row);
  const target = extractTarget(current);

  const directLead = explicitLeadShortcut(current);
  if (directLead) return directLead;

  if (candidateType === 'lead-enrichment') {
    if (target) return `Ultron, enrich this sheet with Apollo: ${target}`;
    if (isRepeatSameTarget(current)) return candidateText;
  }

  if (target && candidateType === 'artifact-generation') {
    return `${candidateText}\nUse the current target/reference ${target} instead of the previous target.`;
  }

  if (target && candidateType === 'coding') {
    return `${candidateText}\nApply the same coding operation to the current target ${target}.`;
  }

  if (target && candidateType === 'research') {
    return `${candidateText}\nRepeat the same research operation for the current target ${target}.`;
  }

  if (HARD_CONTINUATION.test(stripWake(current)) && candidateText) return candidateText;
  if (currentIntent !== 'general' && currentIntent === candidateType && candidateText) {
    return `${candidateText}\nCurrent follow-up: ${stripWake(current)}. Preserve the same operation unless the follow-up explicitly changes it.`;
  }
  return normalize(current);
}

function safeToAutoResolve(current, candidate, executionMessage) {
  if (!candidate?.row || !executionMessage) return false;
  const candidateText = String(candidate.row.resolvedMessage || candidate.row.content || '');
  if (RISKY_ACTIONS.test(candidateText) && HARD_CONTINUATION.test(stripWake(current))) return false;
  if (candidateIntent(candidate.row) === 'lead-enrichment' && !extractTarget(current) && !isRepeatSameTarget(current)) return false;
  return true;
}

function clarification(current, candidates) {
  const best = candidates[0];
  if (!best) return 'I need the target or action, Sir. A short phrase is enough, for example “enrich this sheet”, “fix this file”, or “make the same reel again”.';
  const intent = candidateIntent(best.row).replaceAll('-', ' ');
  const target = extractTarget(current);
  if (target) return `I can see the new target, Sir, but the action is ambiguous. Do you want me to repeat the previous ${intent} operation on it?`;
  return `I can infer the previous ${intent} operation, Sir, but this command is too vague to execute safely. Mention the target or say “same one again”.`;
}

function resolve(message, options = {}) {
  const originalMessage = normalize(message);
  const normalizedMessage = stripWake(originalMessage);
  const directLead = explicitLeadShortcut(originalMessage);
  if (directLead) {
    return {
      version: VERSION,
      originalMessage,
      normalizedMessage,
      resolvedMessage: directLead,
      intent: 'lead-enrichment',
      confidence: 1,
      source: 'explicit-shortcut',
      vague: false,
      autoResolved: directLead !== originalMessage,
      clarification: null,
      candidate: null,
    };
  }

  const vague = isVague(normalizedMessage);
  const intent = classify(normalizedMessage);
  if (!vague) {
    return {
      version: VERSION,
      originalMessage,
      normalizedMessage,
      resolvedMessage: originalMessage,
      intent,
      confidence: 1,
      source: 'explicit',
      vague: false,
      autoResolved: false,
      clarification: null,
      candidate: null,
    };
  }

  const candidates = previousCandidates(normalizedMessage, options.history);
  const best = candidates[0] || null;
  const second = candidates[1] || null;
  const score = best ? Math.min(0.99, best.score) : 0;
  const margin = best && second ? best.score - second.score : score;
  const executionMessage = best ? reconstruct(normalizedMessage, best) : originalMessage;
  const safe = safeToAutoResolve(normalizedMessage, best, executionMessage);
  const strong = score >= SAFE_AUTO_THRESHOLD || (score >= 0.62 && margin >= 0.16);

  if (best && safe && strong) {
    return {
      version: VERSION,
      originalMessage,
      normalizedMessage,
      resolvedMessage: executionMessage,
      intent: candidateIntent(best.row),
      confidence: Number(score.toFixed(3)),
      source: 'previous-similar-command',
      vague: true,
      autoResolved: executionMessage !== originalMessage,
      clarification: null,
      candidate: { content: String(best.row.content || ''), taskType: best.row.taskType || null, score: Number(score.toFixed(3)) },
    };
  }

  const shouldClarify = HARD_CONTINUATION.test(normalizedMessage) || TARGET_ONLY.test(normalizedMessage) || score >= CLARIFY_THRESHOLD;
  return {
    version: VERSION,
    originalMessage,
    normalizedMessage,
    resolvedMessage: originalMessage,
    intent,
    confidence: Number(score.toFixed(3)),
    source: best ? 'ambiguous-history' : 'insufficient-context',
    vague: true,
    autoResolved: false,
    clarification: shouldClarify ? clarification(normalizedMessage, candidates) : null,
    candidate: best ? { content: String(best.row.content || ''), taskType: best.row.taskType || null, score: Number(score.toFixed(3)) } : null,
  };
}

function contextHint(resolution) {
  if (!resolution?.candidate || !resolution.autoResolved) return null;
  return {
    role: 'assistant',
    content: `PRIVATE INPUT RESOLUTION CONTEXT. The current user message was vague. ULTRON matched it to a previous command with confidence ${resolution.confidence}. Previous command: ${resolution.candidate.content}\nResolved execution command: ${resolution.resolvedMessage}\nExecute the resolved command, but do not mention this internal resolution unless it materially affects the answer.`,
  };
}

function install() {
  if (assistant.__inputIntelligenceInstalled) return status();
  const previousHandle = assistant.handle.bind(assistant);

  assistant.handle = async (message, options = {}) => {
    const resolution = resolve(message, { history: options.history });
    emit('input_interpreted', {
      intent: resolution.intent,
      confidence: resolution.confidence,
      source: resolution.source,
      vague: resolution.vague,
      autoResolved: resolution.autoResolved,
    });

    if (resolution.clarification) {
      const response = resolution.clarification;
      conversation.append('user', resolution.originalMessage, {
        taskType: 'input-clarification',
        inputMode: options.inputMode || 'chat',
        inputIntent: resolution.intent,
        inputConfidence: resolution.confidence,
      });
      conversation.append('assistant', response, {
        model: 'mark3-input-intelligence',
        provider: 'local',
        taskType: 'input-clarification',
        inputMode: options.inputMode || 'chat',
      });
      void voice.enqueue(response);
      emit('input_clarification', { intent: resolution.intent, confidence: resolution.confidence });
      return {
        ok: true,
        response,
        text: response,
        model: 'mark3-input-intelligence',
        provider: 'local',
        taskType: 'input-clarification',
        mode: 'local-input-guard',
        inputResolution: resolution,
      };
    }

    const hint = contextHint(resolution);
    const baseHistory = Array.isArray(options.history) && options.history.length ? options.history : null;
    const history = hint ? [...(baseHistory || conversation.recent(8)), hint].slice(-10) : baseHistory;
    const result = await previousHandle(resolution.resolvedMessage, {
      ...options,
      history,
      originalMessage: resolution.originalMessage,
      inputResolution: resolution,
    });
    return { ...result, inputResolution: resolution };
  };

  assistant.__inputIntelligenceInstalled = true;
  return status();
}

function status() {
  return {
    ready: true,
    version: VERSION,
    safeAutoThreshold: SAFE_AUTO_THRESHOLD,
    clarificationThreshold: CLARIFY_THRESHOLD,
    persistentSimilarity: true,
    modelCallsForResolution: 0,
    mark4ContractReady: true,
  };
}

module.exports = {
  VERSION,
  normalize,
  stripWake,
  classify,
  isVague,
  extractTarget,
  previousCandidates,
  resolve,
  install,
  status,
};
