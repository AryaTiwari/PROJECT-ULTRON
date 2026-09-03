const router = require('./model-router');
const league = require('./model-league');
const { emit } = require('./events');

const PARTICIPANTS = Math.max(2, Math.min(8, Number(process.env.ULTRON_M3_LEAGUE_PARTICIPANTS || 4)));
const TRIAL_TIMEOUT_MS = Math.max(7000, Number(process.env.ULTRON_M3_LEAGUE_TRIAL_TIMEOUT_MS || 22000));
const JUDGE_TIMEOUT_MS = Math.max(10000, Number(process.env.ULTRON_M3_LEAGUE_JUDGE_TIMEOUT_MS || 30000));
const INTERVAL_MS = Math.max(15 * 60 * 1000, Number(process.env.ULTRON_M3_LEAGUE_INTERVAL_MS || 45 * 60 * 1000));
const INITIAL_DELAY_MS = Math.max(15000, Number(process.env.ULTRON_M3_LEAGUE_INITIAL_DELAY_MS || 60000));
const AUTO_RUN = /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_LEAGUE_ARENA_AUTORUN || '0'));
const TASKS = ['general', 'coding', 'research', 'planning'];

let timer = null;
let running = false;
let taskIndex = 0;

const BENCHMARKS = {
  general: {
    system: 'You are being evaluated as a concise personal assistant. Answer directly, accurately, and usefully. Do not mention this evaluation.',
    user: 'A creator has 10,000 followers and their average reel views fell by about 20% over four weeks. Give exactly three checks they should make before changing their whole content strategy. Keep the answer under 120 words.',
  },
  coding: {
    system: 'You are being evaluated for practical debugging skill. Give a compact, correct answer. Do not mention this evaluation.',
    user: 'In JavaScript, this function sometimes returns duplicate IDs: `function add(items, next){ if(!items.includes(next)) items.push(next); return items }`. Explain the most likely issue if `items` is an array of objects like `{id: 7}`, and give a corrected version that prevents duplicate IDs. Keep it concise.',
  },
  research: {
    system: 'You are being evaluated for research judgment. Be rigorous and concise. Do not mention this evaluation.',
    user: 'Someone claims a new AI model is "twice as accurate" as its predecessor. Give a short verification plan that distinguishes primary evidence from marketing claims and explains which metrics must match before the comparison is meaningful.',
  },
  planning: {
    system: 'You are being evaluated for prioritization and execution planning. Be decisive and concise. Do not mention this evaluation.',
    user: 'A solo founder has one day to fix a broken login flow, improve a landing-page headline, add analytics, and design a future marketplace feature. Put these in execution order and give one sentence of reasoning for each priority.',
  },
};

function modelPriority(model) {
  const value = String(model || '').toLowerCase();
  let score = 0;
  if (/latest|stable/.test(value)) score += 12;
  if (/gemini-3\.|gpt-5|claude-(?:4|sonnet-4|opus-4)|deepseek-(?:v3|r1)|qwen3|llama-4|mistral-large/.test(value)) score += 35;
  if (/reason|pro|sonnet|opus|large/.test(value)) score += 8;
  if (/flash|mini|lite|small|fast/.test(value)) score += 4;
  if (/preview|experimental|exp\b/.test(value)) score -= 8;
  if (/deprecated|legacy|retired|eol|gemini-2\.5/.test(value)) score -= 60;
  return score;
}

function answerText(result) {
  const direct = result?.content ?? result?.response ?? result?.text ?? result?.output_text
    ?? result?.raw?.choices?.[0]?.message?.content ?? '';
  if (typeof direct === 'string') return direct.trim();
  if (Array.isArray(direct)) return direct.map((item) => typeof item === 'string' ? item : item?.text || item?.content || '').join('').trim();
  return String(direct || '').trim();
}

function heuristicQuality(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  let score = 0.55;
  if (value.length >= 80 && value.length <= 1200) score += 0.12;
  if (/\b(?:because|therefore|first|second|third|1\.|2\.|3\.|- )/i.test(value)) score += 0.08;
  if (!/\b(?:i cannot|i can't|as an ai|unable to|no access)\b/i.test(value)) score += 0.08;
  if (value.length > 2200) score -= 0.12;
  return Math.max(0, Math.min(1, score));
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function judge(taskType, benchmark, candidates) {
  if (candidates.length < 2) {
    return Object.fromEntries(candidates.map((candidate) => [candidate.model, heuristicQuality(candidate.answer)]));
  }
  const labels = candidates.map((candidate, index) => String.fromCharCode(65 + index));
  const payload = candidates.map((candidate, index) => `ANSWER ${labels[index]}:\n${candidate.answer}`).join('\n\n---\n\n');
  const messages = [
    {
      role: 'system',
      content: 'You are an impartial answer-quality judge. The model identities are hidden. Score each answer from 0 to 100 using: correctness 40%, instruction-following 25%, usefulness 20%, concision/directness 15%. Penalize hallucinations, evasiveness, needless verbosity, and failure to satisfy explicit format constraints. Return JSON only: {"scores":{"A":0,"B":0},"winner":"A"}.',
    },
    {
      role: 'user',
      content: `TASK TYPE: ${taskType}\nORIGINAL REQUEST:\n${benchmark.user}\n\n${payload}`,
    },
  ];
  try {
    const result = await router.chat({ messages, model: 'auto/best-reasoning', taskType: 'research' });
    const parsed = extractJson(answerText(result));
    const scores = parsed?.scores || {};
    const out = {};
    for (let i = 0; i < candidates.length; i += 1) {
      const numeric = Number(scores[labels[i]]);
      out[candidates[i].model] = Number.isFinite(numeric)
        ? Math.max(0, Math.min(1, numeric / 100))
        : heuristicQuality(candidates[i].answer);
    }
    return out;
  } catch {
    return Object.fromEntries(candidates.map((candidate) => [candidate.model, heuristicQuality(candidate.answer)]));
  }
}

async function runTournament(taskType = 'general', options = {}) {
  if (running) return { ok: false, skipped: true, reason: 'arena_busy', league: league.snapshot() };
  running = true;
  const task = TASKS.includes(String(taskType).toLowerCase()) ? String(taskType).toLowerCase() : 'general';
  const benchmark = BENCHMARKS[task] || BENCHMARKS.general;
  emit('model_league_started', { taskType: task });
  try {
    const catalog = await router.listNativeEligibleModels({ force: Boolean(options.forceCatalog) });
    const sortedCatalog = [...catalog].sort((a, b) => modelPriority(b) - modelPriority(a) || a.localeCompare(b));
    const participants = league.selectParticipants(sortedCatalog, task, Number(options.participants || PARTICIPANTS));
    const successes = [];

    for (const model of participants) {
      const provider = router.providerFromModel(model);
      const started = Date.now();
      emit('model_league_trial_started', { taskType: task, model, provider });
      try {
        const result = await router.chatExact({
          messages: [
            { role: 'system', content: benchmark.system },
            { role: 'user', content: benchmark.user },
          ],
          model,
          taskType: task,
          timeoutMs: TRIAL_TIMEOUT_MS,
        });
        const answer = answerText(result);
        if (!answer) throw new Error('Model produced no usable answer.');
        const latencyMs = Date.now() - started;
        successes.push({ model: result.model || model, provider: result.provider || provider, answer, latencyMs });
        emit('model_league_trial_completed', { taskType: task, model: result.model || model, provider: result.provider || provider, latencyMs });
      } catch (error) {
        const latencyMs = Date.now() - started;
        league.recordTrial({ model, provider, taskType: task, success: false, latencyMs, error: error.message, tournament: true });
        emit('model_league_trial_failed', { taskType: task, model, provider, latencyMs, error: error.message });
        if (error?.code === 'resource_pressure') break;
      }
    }

    const quality = await judge(task, benchmark, successes);
    for (const candidate of successes) {
      league.recordTrial({
        model: candidate.model,
        provider: candidate.provider,
        taskType: task,
        success: true,
        quality: quality[candidate.model] ?? heuristicQuality(candidate.answer),
        latencyMs: candidate.latencyMs,
        tournament: true,
      });
    }
    league.markTournament(task);
    const promotion = league.promote(task);
    emit('model_league_completed', {
      taskType: task,
      participants: participants.length,
      successful: successes.length,
      primary: promotion.primary,
      backups: promotion.backups,
      changed: promotion.previous !== promotion.primary,
    });
    if (promotion.previous !== promotion.primary) {
      emit('model_league_promoted', { taskType: task, previous: promotion.previous, primary: promotion.primary, backups: promotion.backups });
    }
    return { ok: true, taskType: task, participants, successful: successes.map((item) => item.model), quality, promotion };
  } finally {
    running = false;
  }
}

async function scheduledRound() {
  const task = TASKS[taskIndex % TASKS.length];
  taskIndex += 1;
  try { await runTournament(task); } catch (error) { emit('model_league_error', { taskType: task, error: error.message }); }
}

function start() {
  stop();
  if (!AUTO_RUN) {
    emit('model_league_passive', { reason: 'arena_autorun_disabled', policy: 'learn-from-real-requests' });
    return false;
  }
  const initial = setTimeout(async () => {
    timer = null;
    await scheduledRound();
    timer = setInterval(scheduledRound, INTERVAL_MS);
  }, INITIAL_DELAY_MS);
  timer = initial;
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  if (timer) clearTimeout(timer);
  timer = null;
}

function status() {
  return {
    running,
    autoRun: AUTO_RUN,
    learningMode: AUTO_RUN ? 'active-benchmarking' : 'passive-operational-evidence',
    participantsPerRound: PARTICIPANTS,
    intervalMs: INTERVAL_MS,
    trialTimeoutMs: TRIAL_TIMEOUT_MS,
    judgeTimeoutMs: JUDGE_TIMEOUT_MS,
    tasks: TASKS,
    league: league.snapshot(),
  };
}

module.exports = { runTournament, start, stop, status, heuristicQuality, BENCHMARKS };
