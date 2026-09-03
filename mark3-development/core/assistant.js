const config = require('./config');
const memory = require('./memory');
const workspace = require('./workspace');
const models = require('./model-intelligence');
const modelLeague = require('./model-league');
const planner = require('./planner');
const verifier = require('./verifier');
const integrations = require('./integrations');
const tools = require('./tools');
const web = require('./web');
const codingBrain = require('./coding-brain');
const voice = require('./voice-orchestrator');
const conversation = require('./conversation');
const intent = require('./intent');
const { emit } = require('./events');

const BASE_SYSTEM = `You are ULTRON Mark 3, a persistent private executive aide, chief-of-staff assistant and strategic operator for the founder. You are calm, formidable, intelligent, composed, respectful, direct, practical and subtly witty. You are not a casual friend or peer. Voice conversation is the primary experience; typed chat is the transcript and backup surface. Write for the ear by default. For ordinary conversation, use an executive-brief style: lead with the answer, usually one or two short sentences, roughly 20–50 words, and no more than one recommendation unless more is requested. Do not restate the question, add background the user did not request, or expand merely to appear helpful. When the user explicitly asks for detail, teaching, analysis, a plan, step-by-step guidance, writing, code, tables or another structured deliverable, expand as much as necessary while remaining economical. Use natural spoken sentences and clean pacing. Avoid robotic headings, dense bullet lists, repeated labels and screen-only phrasing unless structure is requested or materially necessary. Do not read out raw URLs, long identifiers, code syntax, file paths or telemetry unless directly needed. Never invent live facts, model capabilities, tool results or completed work. State facts, assumptions, estimates and judgments separately when that distinction matters. Prefer deterministic tools when reliable. Verify consequential actions whenever possible. Maintain continuity only from context deliberately supplied for the current request; never resurrect an unrelated previous task. If fetched web-page or live-search content is supplied, use it directly and never claim that you cannot access that material. Never expose hidden chain-of-thought, scratchpad, internal reasoning or analysis; provide only the conclusion and useful rationale.`;

function wantsDetailedResponse(text) {
  return /\b(?:in detail|detailed|deep dive|deeply|elaborate|elaborately|explain fully|full explanation|comprehensive|thorough|step[- ]by[- ]step|walk me through|break(?:\s+it)?\s+down|everything about|all details|long answer|complete guide|teach me)\b/i.test(String(text || ''));
}

function wantsWrittenResponse(text) {
  return /\b(?:write|draft|compose|rewrite|email|message|caption|post|prompt|table|checklist|bullet(?:s| points)?|code|script|json|markdown|format(?:ted)?|document|template|copy|bio|resume|cv|letter)\b/i.test(String(text || ''));
}

function responseStyleInstruction(text, inputMode = 'chat') {
  const detailed = wantsDetailedResponse(text);
  const written = wantsWrittenResponse(text);
  const voiceInput = String(inputMode || '').toLowerCase() === 'voice';
  if (written) {
    return `RESPONSE DELIVERY: The user requested a written or structured deliverable. Produce the deliverable cleanly; keep surrounding commentary minimal. ${detailed ? 'The user also requested depth, so include the necessary detail without repetition.' : ''}`;
  }
  if (voiceInput && detailed) {
    return 'RESPONSE DELIVERY: Spoken detailed mode. Address Sir respectfully, explain fully, and keep the explanation organized and economical. Depth is requested; repetition is not.';
  }
  if (voiceInput) {
    return 'RESPONSE DELIVERY: EXECUTIVE BRIEF. Address Sir once. Give the direct answer in one or two short spoken sentences, normally 20–50 words. One recommendation maximum. No headings, preamble, recap or extra background.';
  }
  if (detailed) {
    return 'RESPONSE DELIVERY: Detailed mode. Address Sir respectfully and explain thoroughly, but remain concise within each point and avoid repetition.';
  }
  return 'RESPONSE DELIVERY: EXECUTIVE BRIEF. Address Sir once. Answer directly in one or two short sentences, normally 20–50 words. One recommendation maximum. Do not add background, lists or follow-up material unless necessary.';
}

function textFromResponse(data) {
  const direct = data?.content ?? data?.response ?? data?.text ?? data?.output_text
    ?? data?.choices?.[0]?.message?.content
    ?? data?.choices?.[0]?.delta?.content
    ?? data?.choices?.[0]?.text ?? data?.choices?.[0]?.message?.text
    ?? data?.raw?.choices?.[0]?.message?.content ?? data?.raw?.response ?? data?.raw?.text ?? '';
  if (typeof direct === 'string') return direct.trim();
  if (Array.isArray(direct)) return direct.map((item) => typeof item === 'string' ? item : item?.text || item?.content || item?.value || '').join('').trim();
  if (direct && typeof direct === 'object') return String(direct.text || direct.content || direct.value || '').trim();
  return String(direct || '').trim();
}

function toolCallsFromResponse(data) {
  return Array.isArray(data?.toolCalls) ? data.toolCalls
    : Array.isArray(data?.choices?.[0]?.message?.tool_calls) ? data.choices[0].message.tool_calls
      : Array.isArray(data?.raw?.choices?.[0]?.message?.tool_calls) ? data.raw.choices[0].message.tool_calls
        : [];
}

function explicitGitHubPrompt(text) {
  const match = String(text).match(/\b(?:read|open|inspect|check)\s+([A-Za-z0-9._\-/]+)\s+(?:from|on|in)\s+github\b/i);
  return match ? match[1] : null;
}

function needsRepositoryTools(text, taskType) {
  const value = String(text || '').toLowerCase();
  if (String(taskType || '').toLowerCase() === 'coding' && /\b(repo|repository|github|codebase|branch|commit|file|source|project ultron|ultron)\b/.test(value)) return true;
  return /\b(github|repository|repo|codebase|branch|commit|pull request|source file|edit file|update file|create file|delete file|project[- ]ultron)\b/.test(value);
}

function relevantRows(rows, query, fields, limit = 5) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const haystack = fields.map((field) => String(row?.[field] || '')).join(' ');
      return { row, score: conversation.overlap(query, haystack) };
    })
    .filter((entry) => entry.score >= 0.14)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.row);
}

function workspaceContext(userMessage) {
  const allCommitments = workspace.listCommitments({ status: 'open' });
  const allDecisions = workspace.listDecisions();
  const allProjects = workspace.listProjects();
  const explicitWorkspaceIntent = /\b(commitment|deadline|remind|decision|project|roadmap|milestone|todo|task)\b/i.test(userMessage);
  return {
    commitments: explicitWorkspaceIntent ? relevantRows(allCommitments, userMessage, ['title', 'project', 'description'], 6) : [],
    decisions: explicitWorkspaceIntent ? relevantRows(allDecisions, userMessage, ['title', 'project', 'decision', 'reason'], 5) : [],
    projects: relevantRows(allProjects, userMessage, ['name', 'title', 'description', 'status'], 5),
    counts: { commitments: allCommitments.length, projects: allProjects.length },
  };
}

function contextBlock(retrieved, workspaceData, recent, page, searchEvidence) {
  const blocks = [];
  if (recent.length) blocks.push('RELEVANT RECENT CONVERSATION:', JSON.stringify(recent.slice(-6)));
  if (retrieved.length) blocks.push('RELEVANT LONG-TERM MEMORY:', JSON.stringify(retrieved.slice(0, 6)));
  if (workspaceData.commitments.length || workspaceData.decisions.length || workspaceData.projects.length) {
    blocks.push('RELEVANT WORKSPACE STATE:', JSON.stringify({
      openCommitments: workspaceData.commitments,
      decisions: workspaceData.decisions,
      projects: workspaceData.projects,
    }));
  }
  if (page) {
    blocks.push(
      'FETCHED WEB PAGE:',
      JSON.stringify({ url: page.url, title: page.title, status: page.status, truncated: page.truncated, provider: page.provider }),
      page.text,
      'The page above was fetched successfully by ULTRON. Analyze it directly when relevant.'
    );
  }
  if (searchEvidence) {
    blocks.push(
      'LIVE WEB SEARCH:',
      JSON.stringify({ query: searchEvidence.query, provider: searchEvidence.provider, results: searchEvidence.results })
    );
    const readablePages = (searchEvidence.pages || []).filter((item) => item?.text);
    for (const evidencePage of readablePages.slice(0, 3)) {
      blocks.push(
        `SEARCH RESULT PAGE: ${evidencePage.url}`,
        JSON.stringify({ title: evidencePage.title || evidencePage.searchTitle || '', provider: evidencePage.provider, truncated: evidencePage.truncated }),
        String(evidencePage.text || '').slice(0, 8000)
      );
    }
    blocks.push('Use the live search results and fetched pages above as evidence. Do not pretend you lack web access.');
  }
  if (!blocks.length) blocks.push('No prior context is required for this request. Answer from the current user message only.');
  return blocks.join('\n\n');
}

async function modelToolLoop(messages, model, taskType, toolSchemas = null, exact = false) {
  let working = [...messages];
  const schemas = Array.isArray(toolSchemas) && toolSchemas.length ? toolSchemas : null;

  if (!schemas) {
    let streamed = '';
    let emitted = false;
    try {
      const stream = exact ? integrations.streamExact : integrations.streamChat;
      const data = await stream(working, model, null, {
        taskType,
        onDelta: (delta, meta = {}) => {
          const text = String(delta || '');
          if (!text) return;
          emitted = true;
          streamed += text;
          emit('model_delta', { delta: text, model: meta.model || model, taskType });
        },
      });
      if (!data.content && streamed) data.content = streamed;
      return { data, rounds: 0, streamed: true };
    } catch (error) {
      if (emitted) {
        error.partialStream = true;
        throw error;
      }
      emit('model_stream_fallback', { model, taskType, reason: error.message, exact });
      const data = exact
        ? await integrations.chatExact(working, model, null, { taskType })
        : await integrations.chat(working, model, null, { taskType });
      return { data, rounds: 0, streamed: false };
    }
  }

  for (let round = 0; round < 5; round += 1) {
    const data = await integrations.chat(working, model, schemas, { taskType });
    const calls = toolCallsFromResponse(data);
    if (!calls.length) return { data, rounds: round, streamed: false };

    working.push({ role: 'assistant', content: textFromResponse(data) || null, tool_calls: calls });
    for (const call of calls) {
      const fn = call.function || {};
      let input = {};
      try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments || {}; }
      catch { input = {}; }
      emit('tool_started', { tool: fn.name, input: { ...input, path: input.path, model } });
      const result = await tools.execute(fn.name, input);
      emit('tool_completed', { tool: fn.name, result: result.result || result, model });
      working.push({ role: 'tool', tool_call_id: call.id || `${fn.name}-${round}`, name: fn.name, content: JSON.stringify(result) });
    }
  }
  throw new Error('ULTRON tool loop exceeded the five-round safety limit.');
}

function nativeModelForTask(taskType) {
  const task = String(taskType || 'general').toLowerCase();
  if (task === 'coding') return 'auto/best-coding';
  if (task === 'research' || task === 'planning') return 'auto/best-reasoning';
  return 'auto/best-fast';
}

async function chooseModel(requested, taskType, { allowLeague = true } = {}) {
  const wanted = String(requested || '').trim();
  if (wanted && integrations.isDirectProviderModel(wanted)) return { model: wanted, mode: 'direct', candidates: [wanted] };
  if (allowLeague) {
    const rec = modelLeague.recommend(taskType);
    if (rec.primary) {
      return {
        model: rec.primary,
        mode: 'league',
        candidates: [...new Set([rec.primary, ...(rec.backups || []), nativeModelForTask(taskType)])],
        league: rec,
      };
    }
  }
  const routed = nativeModelForTask(taskType);
  return { model: routed, mode: 'routing', candidates: [routed] };
}

function fastGreeting(userMessage) {
  if (/good\s+morning/i.test(userMessage)) return 'Good morning, Sir. I’m online.';
  if (/good\s+afternoon/i.test(userMessage)) return 'Good afternoon, Sir. I’m here.';
  if (/good\s+evening/i.test(userMessage)) return 'Good evening, Sir. I’m here.';
  return 'Yes, Sir. I’m here.';
}

function deterministicWebFailure(kind, target, error) {
  const label = kind === 'search' ? 'search the live web' : `fetch ${target}`;
  return `I couldn't ${label}, Sir. The web layer returned: ${error.message}`;
}

async function handle(message, options = {}) {
  const userMessage = String(message || '').trim();
  if (!userMessage) throw new Error('Message is required.');

  const started = Date.now();
  const taskType = options.taskType || 'general';
  const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
  const previousConversation = conversation.contextFor(userMessage, options.history);

  emit('task_started', { message: userMessage, taskType, inputMode });
  conversation.append('user', userMessage, { taskType, inputMode });

  if (conversation.isGreeting(userMessage)) {
    const response = fastGreeting(userMessage);
    conversation.append('assistant', response, { model: 'mark3-fastpath', provider: 'local', taskType: 'smalltalk', inputMode });
    emit('context_ready', { memoryCount: 0, commitments: 0, projectCount: 0, contextMode: 'isolated-greeting', inputMode });
    emit('response_ready', { model: 'mark3-fastpath', provider: 'local', taskType: 'smalltalk', mode: 'fastpath', inputMode });
    void voice.enqueue(response);
    emit('task_completed', { durationMs: Date.now() - started, inputMode });
    return { ok: true, response, text: response, model: 'mark3-fastpath', provider: 'local', taskType: 'smalltalk', mode: 'fastpath', inputMode, plan: null, toolRounds: 0 };
  }

  const retrieved = memory.retrieve(userMessage, { limit: Math.min(config.maxContextItems, 6) });
  const workspaceData = workspaceContext(userMessage);

  const captured = intent.extractCommitment(userMessage);
  if (captured) {
    const commitment = workspace.createCommitment({ title: captured.title, priority: captured.priority, project: intent.extractProject(userMessage) });
    emit('commitment_created', { commitment });
  }

  const plan = planner.createPlan(userMessage, taskType);
  emit('context_ready', {
    memoryCount: retrieved.length,
    commitments: workspaceData.commitments.length,
    projectCount: workspaceData.projects.length,
    conversationItems: previousConversation.length,
    inputMode,
  });

  const githubPath = explicitGitHubPrompt(userMessage);
  if (githubPath) {
    emit('tool_started', { tool: 'github_read_file', input: { path: githubPath, ref: config.githubBranch } });
    const file = await integrations.githubReadFile(githubPath, config.githubBranch);
    emit('tool_completed', { tool: 'github_read_file', result: { path: file.path, sha: file.sha, size: file.size } });
    const response = `Inspected ${file.path} on GitHub, Sir (${file.sha.slice(0, 7)}).\n\n${file.content.slice(0, 12000)}`;
    verifier.report(verifier.verifyText(response), 'github-read-response');
    conversation.append('assistant', response, { model: 'deterministic-github', taskType, inputMode });
    memory.remember({ type: 'episodic', content: `GitHub file inspected: ${githubPath}`, source: 'tool', project: 'ULTRON Mark 3', importance: 0.35 });
    emit('response_ready', { model: 'deterministic-github', taskType, inputMode });
    void voice.enqueue(response);
    emit('task_completed', { durationMs: Date.now() - started, inputMode });
    return { ok: true, response, text: response, model: 'deterministic-github', taskType, inputMode, plan, tool: 'github_read_file', sha: file.sha };
  }

  if (codingBrain.shouldUse(userMessage, taskType)) {
    const codingMode = codingBrain.modeFor(userMessage);
    const codingWorkspace = codingBrain.resolveWorkspace(userMessage, options.codingWorkspace);
    emit('coding_brain_probe', { mode: codingMode, workspace: codingWorkspace, taskType });
    const brainHealth = await codingBrain.health();
    if (brainHealth.ok) {
      emit('coding_brain_started', { mode: codingMode, workspace: codingWorkspace, taskType });
      try {
        const codingResult = await codingBrain.run(userMessage, { mode: codingMode, workspace: codingWorkspace });
        for (const stage of Array.isArray(codingResult.trace) ? codingResult.trace : []) emit('coding_brain_stage', stage);
        const response = codingBrain.summarize(codingResult);
        conversation.append('assistant', response, { model: 'coding-brain', provider: 'ultron-cortex', taskType: 'coding', mode: codingMode, inputMode });
        emit('coding_brain_completed', { mode: codingMode, workspace: codingWorkspace, changedFiles: codingResult.changedFiles || [], validation: codingResult.validation?.status || null, review: codingResult.review?.verdict || null });
        emit('response_ready', { model: 'coding-brain', provider: 'ultron-cortex', taskType: 'coding', mode: codingMode, inputMode });
        void voice.enqueue(response);
        emit('task_completed', { durationMs: Date.now() - started, inputMode });
        return { ok: Boolean(codingResult.ok), response, text: response, model: 'coding-brain', provider: 'ultron-cortex', taskType: 'coding', mode: codingMode, inputMode, plan, coding: codingResult, toolRounds: 0 };
      } catch (error) {
        emit('coding_brain_failed', { mode: codingMode, workspace: codingWorkspace, error: error.message });
      }
    } else {
      emit('coding_brain_unavailable', { url: brainHealth.url, error: brainHealth.error || brainHealth.reason || 'offline' });
    }
  }

  let fetchedPage = null;
  let searchEvidence = null;
  const suppliedUrl = web.extractFirstUrl(userMessage);
  if (suppliedUrl && !/^(?:https?:\/\/)?(?:www\.)?github\.com\b/i.test(suppliedUrl)) {
    emit('tool_started', { tool: 'web_fetch', input: { url: suppliedUrl, primary: 'tinyfish' } });
    try {
      fetchedPage = await web.fetchPage(suppliedUrl);
      emit('tool_completed', { tool: 'web_fetch', result: { url: fetchedPage.url, title: fetchedPage.title, status: fetchedPage.status, chars: fetchedPage.text.length, provider: fetchedPage.provider, primaryError: fetchedPage.primaryError || null } });
    } catch (error) {
      emit('tool_failed', { tool: 'web_fetch', url: suppliedUrl, error: error.message });
      const response = deterministicWebFailure('fetch', suppliedUrl, error);
      conversation.append('assistant', response, { model: 'deterministic-web-error', provider: 'web', taskType, inputMode });
      emit('response_ready', { model: 'deterministic-web-error', provider: 'web', taskType, mode: 'tool-error', inputMode });
      emit('task_completed', { durationMs: Date.now() - started, inputMode });
      return { ok: true, response, text: response, model: 'deterministic-web-error', provider: 'web', taskType, mode: 'tool-error', inputMode, plan, webError: error.message };
    }
  } else if (web.shouldSearch(userMessage)) {
    emit('tool_started', { tool: 'web_search', input: { query: userMessage, primary: 'tinyfish' } });
    try {
      searchEvidence = await web.searchAndFetch(userMessage, { searchLimit: 5, fetchTop: 3 });
      emit('tool_completed', { tool: 'web_search', result: { query: searchEvidence.query, resultCount: searchEvidence.results.length, fetchedPages: searchEvidence.pages.filter((item) => item.text).length, provider: searchEvidence.provider } });
    } catch (error) {
      emit('tool_failed', { tool: 'web_search', query: userMessage, error: error.message });
      const response = deterministicWebFailure('search', userMessage, error);
      conversation.append('assistant', response, { model: 'deterministic-web-error', provider: 'web', taskType, inputMode });
      emit('response_ready', { model: 'deterministic-web-error', provider: 'web', taskType, mode: 'tool-error', inputMode });
      emit('task_completed', { durationMs: Date.now() - started, inputMode });
      return { ok: true, response, text: response, model: 'deterministic-web-error', provider: 'web', taskType, mode: 'tool-error', inputMode, plan, webError: error.message };
    }
  }

  const repositoryToolsEnabled = needsRepositoryTools(userMessage, taskType);
  const selection = await chooseModel(options.model || '', taskType, { allowLeague: !repositoryToolsEnabled });
  const toolSchemas = tools.schemasFor({ github: repositoryToolsEnabled, web: false });
  emit('model_selection', {
    selectedModel: selection.model,
    mode: selection.mode,
    provider: integrations.providerFromModel(selection.model),
    backups: selection.mode === 'league' ? selection.candidates.slice(1) : [],
    repositoryToolsEnabled,
    webFetched: Boolean(fetchedPage),
    webSearched: Boolean(searchEvidence),
    inputMode,
  });

  const messages = [
    {
      role: 'system',
      content: `${BASE_SYSTEM}\n\n${responseStyleInstruction(userMessage, inputMode)}\nINTERACTION MODE: ${inputMode === 'voice' ? 'VOICE-FIRST. The response will be spoken aloud automatically.' : 'CHAT BACKUP. The response may still be spoken aloud, so keep prose speech-friendly.'}\nMODEL MODE: ${selection.mode === 'routing' ? 'Use Mark 3 OmniRoute native routing and fallback policy.' : selection.mode === 'league' ? 'Use the adaptive Model League primary; backups are available if it fails.' : 'Use the requested provider model through the Mark 3 OmniRoute transport.'}\nREPOSITORY TOOLS: ${repositoryToolsEnabled ? 'Enabled for this request.' : 'Disabled for this request.'}\n\n${contextBlock(retrieved, workspaceData, previousConversation, fetchedPage, searchEvidence)}`,
    },
    ...previousConversation.map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content || '') })),
    { role: 'user', content: userMessage },
  ];

  let loop = null;
  let selectedModel = selection.model;
  let selectedProvider = integrations.providerFromModel(selectedModel);
  let lastError = null;
  let leagueAfterUse = selection.league || null;
  const candidates = selection.candidates || [selection.model];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const candidateProvider = integrations.providerFromModel(candidate);
    const exact = selection.mode === 'league' && integrations.isDirectProviderModel(candidate) && !integrations.isRoutingAlias(candidate);
    const attemptStarted = Date.now();
    emit('model_started', { taskType, model: candidate, mode: exact ? 'league-exact' : selection.mode, provider: candidateProvider, backupIndex: index, inputMode });
    try {
      loop = await modelToolLoop(messages, candidate, taskType, toolSchemas, exact);
      selectedModel = candidate;
      selectedProvider = candidateProvider;
      if (selection.mode === 'league' && exact) {
        modelLeague.recordTrial({ model: candidate, provider: candidateProvider, taskType, success: true, latencyMs: Date.now() - attemptStarted, tournament: false });
      }
      break;
    } catch (error) {
      lastError = error;
      const latencyMs = Date.now() - attemptStarted;
      models.record({ provider: candidateProvider, model: candidate, taskType, success: false, latencyMs, reason: error.message });
      if (selection.mode === 'league' && exact) {
        modelLeague.recordTrial({ model: candidate, provider: candidateProvider, taskType, success: false, latencyMs, error: error.message, tournament: false });
      }
      emit('model_failed', { taskType, model: candidate, provider: candidateProvider, error: error.message, backupIndex: index, inputMode });
      if (index + 1 < candidates.length) {
        if (error.partialStream) emit('model_stream_reset', { failedModel: candidate, nextModel: candidates[index + 1], taskType });
        emit('model_backup_selected', { taskType, failedModel: candidate, nextModel: candidates[index + 1], backupIndex: index + 1 });
      }
    }
  }

  if (!loop) throw lastError || new Error('All Model League routes failed.');

  if (selection.mode === 'league') {
    const reranked = modelLeague.promote(taskType);
    leagueAfterUse = reranked;
    if (reranked.previous !== reranked.primary) {
      emit('model_league_promoted', { taskType, previous: reranked.previous, primary: reranked.primary, backups: reranked.backups, reason: 'operational-evidence' });
    }
  }

  const data = loop.data;
  const text = textFromResponse(data);
  const checked = verifier.report(verifier.verifyText(text), 'model-response');
  if (!checked.ok) throw new Error('Model returned an empty response.');

  const observedModel = data?.model || data?.raw?.model || selectedModel;
  const observedProvider = data?.provider || data?.raw?.provider || integrations.providerFromModel(observedModel) || selectedProvider;
  models.record({ provider: observedProvider, model: observedModel, taskType, success: true, latencyMs: Date.now() - started });
  conversation.append('assistant', text, { model: observedModel, provider: observedProvider, taskType, mode: selection.mode, inputMode });
  emit('response_ready', { model: observedModel, taskType, provider: observedProvider, mode: selection.mode, streamed: Boolean(loop.streamed), inputMode });
  void voice.enqueue(text);
  emit('task_completed', { durationMs: Date.now() - started, inputMode });

  return {
    ok: true,
    response: text,
    text,
    model: observedModel,
    provider: observedProvider,
    taskType,
    mode: selection.mode,
    inputMode,
    league: selection.mode === 'league' ? { primary: leagueAfterUse?.primary || selection.model, backups: leagueAfterUse?.backups || selection.candidates.slice(1, -1) } : null,
    plan,
    toolRounds: loop.rounds,
    streamed: Boolean(loop.streamed),
    web: fetchedPage
      ? { mode: 'fetch', url: fetchedPage.url, title: fetchedPage.title, status: fetchedPage.status, provider: fetchedPage.provider }
      : searchEvidence
        ? { mode: 'search', query: searchEvidence.query, resultCount: searchEvidence.results.length, provider: searchEvidence.provider }
        : null,
  };
}

module.exports = { handle, BASE_SYSTEM, needsRepositoryTools, wantsDetailedResponse, wantsWrittenResponse, responseStyleInstruction, chooseModel };
