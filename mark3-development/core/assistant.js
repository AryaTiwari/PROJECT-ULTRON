const config = require('./config');
const memory = require('./memory');
const workspace = require('./workspace');
const models = require('./model-intelligence');
const planner = require('./planner');
const verifier = require('./verifier');
const integrations = require('./integrations');
const tools = require('./tools');
const web = require('./web');
const voice = require('./voice-orchestrator');
const conversation = require('./conversation');
const intent = require('./intent');
const { emit } = require('./events');

const BASE_SYSTEM = `You are ULTRON Mark 3, a persistent personal operating assistant and strategic companion. You are calm, formidable, intelligent, composed, direct, practical, subtly playful, philosophical when useful, and willing to challenge avoidance. Act like a trusted friend plus elite executive assistant. Never invent live facts, model capabilities, tool results, or completed work. State facts, assumptions, estimates and judgments separately. Prefer deterministic tools when reliable. Verify consequential actions whenever possible. Maintain continuity only from context deliberately supplied for the current request; never resurrect an unrelated previous task. If fetched web-page content is supplied, use it directly and never claim that you cannot access that page.`;

function textFromResponse(data) {
  const direct = data?.content ?? data?.response ?? data?.text ?? data?.output_text
    ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.message?.reasoning_content
    ?? data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.delta?.reasoning_content
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

function contextBlock(retrieved, workspaceData, recent, page) {
  const blocks = [];
  if (recent.length) {
    blocks.push('RELEVANT RECENT CONVERSATION:', JSON.stringify(recent.slice(-6)));
  }
  if (retrieved.length) {
    blocks.push('RELEVANT LONG-TERM MEMORY:', JSON.stringify(retrieved.slice(0, 6)));
  }
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
      JSON.stringify({ url: page.url, title: page.title, status: page.status, truncated: page.truncated }),
      page.text,
      'The page above was fetched successfully by ULTRON. Analyze it directly when relevant.'
    );
  }
  if (!blocks.length) blocks.push('No prior context is required for this request. Answer from the current user message only.');
  return blocks.join('\n\n');
}

async function modelToolLoop(messages, model, taskType, toolSchemas = null) {
  let working = [...messages];
  const schemas = Array.isArray(toolSchemas) && toolSchemas.length ? toolSchemas : null;

  // Ordinary conversation uses the streaming path. Tool-calling requests stay on
  // non-streaming chat because tool-call deltas differ across providers.
  if (!schemas) {
    let streamed = '';
    let emitted = false;
    try {
      const data = await integrations.streamChat(working, model, null, {
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
      if (emitted) throw error;
      emit('model_stream_fallback', { model, taskType, reason: error.message });
      const data = await integrations.chat(working, model, null, { taskType });
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

async function chooseModel(requested, taskType) {
  const wanted = String(requested || '').trim();
  if (wanted && integrations.isDirectProviderModel(wanted)) return { model: wanted, mode: 'direct' };
  return { model: nativeModelForTask(taskType), mode: 'routing' };
}

function fastGreeting(userMessage) {
  if (/good\s+morning/i.test(userMessage)) return 'Morning, Arya. I’m online. What are we moving forward today?';
  if (/good\s+(?:afternoon|evening)/i.test(userMessage)) return 'Hey Arya. I’m here. What are we working on?';
  return 'Hey Arya. I’m here. What are we building?';
}

async function handle(message, options = {}) {
  const userMessage = String(message || '').trim();
  if (!userMessage) throw new Error('Message is required.');

  const started = Date.now();
  const taskType = options.taskType || 'general';
  const previousConversation = conversation.contextFor(userMessage, options.history);

  emit('task_started', { message: userMessage, taskType });
  conversation.append('user', userMessage, { taskType });

  if (conversation.isGreeting(userMessage)) {
    const response = fastGreeting(userMessage);
    conversation.append('assistant', response, { model: 'mark3-fastpath', provider: 'local', taskType: 'smalltalk' });
    emit('context_ready', { memoryCount: 0, commitments: 0, projectCount: 0, contextMode: 'isolated-greeting' });
    emit('response_ready', { model: 'mark3-fastpath', provider: 'local', taskType: 'smalltalk', mode: 'fastpath' });
    void voice.enqueue(response);
    emit('task_completed', { durationMs: Date.now() - started });
    return { ok: true, response, text: response, model: 'mark3-fastpath', provider: 'local', taskType: 'smalltalk', mode: 'fastpath', plan: null, toolRounds: 0 };
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
  });

  const githubPath = explicitGitHubPrompt(userMessage);
  if (githubPath) {
    emit('tool_started', { tool: 'github_read_file', input: { path: githubPath, ref: config.githubBranch } });
    const file = await integrations.githubReadFile(githubPath, config.githubBranch);
    emit('tool_completed', { tool: 'github_read_file', result: { path: file.path, sha: file.sha, size: file.size } });
    const response = `I inspected ${file.path} on GitHub (${file.sha.slice(0, 7)}).\n\n${file.content.slice(0, 12000)}`;
    verifier.report(verifier.verifyText(response), 'github-read-response');
    conversation.append('assistant', response, { model: 'deterministic-github', taskType });
    memory.remember({ type: 'episodic', content: `GitHub file inspected: ${githubPath}`, source: 'tool', project: 'ULTRON Mark 3', importance: 0.35 });
    emit('response_ready', { model: 'deterministic-github', taskType });
    void voice.enqueue(response);
    emit('task_completed', { durationMs: Date.now() - started });
    return { ok: true, response, text: response, model: 'deterministic-github', taskType, plan, tool: 'github_read_file', sha: file.sha };
  }

  let fetchedPage = null;
  const suppliedUrl = web.extractFirstUrl(userMessage);
  if (suppliedUrl && !/^(?:https?:\/\/)?(?:www\.)?github\.com\b/i.test(suppliedUrl)) {
    emit('tool_started', { tool: 'web_fetch', input: { url: suppliedUrl } });
    try {
      fetchedPage = await web.fetchPage(suppliedUrl);
      emit('tool_completed', { tool: 'web_fetch', result: { url: fetchedPage.url, title: fetchedPage.title, status: fetchedPage.status, chars: fetchedPage.text.length } });
    } catch (error) {
      emit('tool_failed', { tool: 'web_fetch', url: suppliedUrl, error: error.message });
    }
  }

  const selection = await chooseModel(options.model || '', taskType);
  const selectedModel = selection.model;
  const selectedProvider = integrations.providerFromModel(selectedModel);
  const repositoryToolsEnabled = needsRepositoryTools(userMessage, taskType);
  const toolSchemas = tools.schemasFor({ github: repositoryToolsEnabled, web: false });
  emit('model_selection', { selectedModel, mode: selection.mode, provider: selectedProvider, repositoryToolsEnabled, webFetched: Boolean(fetchedPage) });

  const messages = [
    {
      role: 'system',
      content: `${BASE_SYSTEM}\n\nMODEL MODE: ${selection.mode === 'routing' ? 'Use Mark 3 OmniRoute native routing and fallback policy.' : 'Use the requested provider model through the Mark 3 OmniRoute transport.'}\nREPOSITORY TOOLS: ${repositoryToolsEnabled ? 'Enabled for this request.' : 'Disabled for this request.'}\n\n${contextBlock(retrieved, workspaceData, previousConversation, fetchedPage)}`,
    },
    ...previousConversation.map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content || '') })),
    { role: 'user', content: userMessage },
  ];

  emit('model_started', { taskType, model: selectedModel, mode: selection.mode, provider: selectedProvider });
  let loop;
  try {
    loop = await modelToolLoop(messages, selectedModel, taskType, toolSchemas);
  } catch (error) {
    models.record({ provider: selectedProvider, model: selectedModel, taskType, success: false, latencyMs: Date.now() - started, reason: error.message });
    emit('model_failed', { taskType, model: selectedModel, provider: selectedProvider, error: error.message });
    throw error;
  }

  const data = loop.data;
  const text = textFromResponse(data);
  const checked = verifier.report(verifier.verifyText(text), 'model-response');
  if (!checked.ok) throw new Error('Model returned an empty response.');

  const observedModel = data?.model || data?.raw?.model || selectedModel;
  const observedProvider = data?.provider || data?.raw?.provider || integrations.providerFromModel(observedModel) || selectedProvider;
  models.record({ provider: observedProvider, model: observedModel, taskType, success: true, latencyMs: Date.now() - started });
  conversation.append('assistant', text, { model: observedModel, provider: observedProvider, taskType, mode: selection.mode });
  emit('response_ready', { model: observedModel, taskType, provider: observedProvider, mode: selection.mode, streamed: Boolean(loop.streamed) });
  void voice.enqueue(text);
  emit('task_completed', { durationMs: Date.now() - started });

  return {
    ok: true,
    response: text,
    text,
    model: observedModel,
    provider: observedProvider,
    taskType,
    mode: selection.mode,
    plan,
    toolRounds: loop.rounds,
    streamed: Boolean(loop.streamed),
    web: fetchedPage ? { url: fetchedPage.url, title: fetchedPage.title, status: fetchedPage.status } : null,
  };
}

module.exports = { handle, BASE_SYSTEM, needsRepositoryTools };
