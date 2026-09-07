const path = require('path');
const config = require('./config');
const fabric = require('./context-fabric');
const { readJson, writeJsonAtomic } = require('./persistence');

const STATE_PATH = path.join(config.dataDir, 'greeting-state.json');

const VARIANTS = {
  morning: [
    'Good morning, Sir. Systems are up.',
    'Morning, Sir. I have the thread loaded.',
    'Good morning, Sir. We are online and synchronized.',
    'Morning, Sir. I have your recent work in view.',
    'Good morning, Sir. Context is loaded; no cold start today.',
    'Morning, Sir. I am caught up and ready to move.',
  ],
  afternoon: [
    'Good afternoon, Sir. I am caught up.',
    'Afternoon, Sir. I have the current thread.',
    'Good afternoon, Sir. Systems are steady and context is loaded.',
    'Afternoon, Sir. I know where we left things.',
    'Good afternoon, Sir. I have your recent work and priorities in view.',
    'Afternoon, Sir. We can continue without rebuilding context from scratch.',
  ],
  evening: [
    'Good evening, Sir. I have the thread.',
    'Evening, Sir. Everything is online and your recent context is loaded.',
    'Good evening, Sir. I am synchronized with the day so far.',
    'Evening, Sir. I know what we were working on.',
    'Good evening, Sir. Systems are steady; I have the recent trail.',
    'Evening, Sir. I am up to speed.',
  ],
  'late-night': [
    'Still here, Sir. I have the thread.',
    'Late one, Sir. Systems are quiet and context is loaded.',
    'I am online, Sir. I have not lost the trail.',
    'Still with you, Sir. Recent work is in context.',
    'Online, Sir. The system is steady and I know where we left off.',
    'I am here, Sir. No reset; the recent thread is loaded.',
  ],
};

function clean(value, max = 105) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trim()}…` : text;
}

function choose(daypart, salt = 0) {
  const options = VARIANTS[daypart] || VARIANTS.morning;
  const state = readJson(STATE_PATH, { lastIndex: -1, count: 0 });
  let index = Math.abs(Number(salt || 0) + Number(state.count || 0) + new Date().getMinutes()) % options.length;
  if (options.length > 1 && index === state.lastIndex) index = (index + 1) % options.length;
  writeJsonAtomic(STATE_PATH, { lastIndex: index, count: Number(state.count || 0) + 1, at: new Date().toISOString(), daypart });
  return options[index];
}

function create() {
  const ctx = fabric.compactSnapshot();
  const base = choose(ctx.clock.daypart, ctx.recentSessions?.length || 0);
  const previous = ctx.recentSessions?.[0] || ctx.previousSession;
  const yesterday = Array.isArray(ctx.yesterdayCompleted) ? ctx.yesterdayCompleted : [];
  const recentActivity = Array.isArray(ctx.recentActivity) ? ctx.recentActivity : [];
  const focus = ctx.topAction;
  const diagnostic = ctx.diagnostic;

  const details = [];
  if (previous?.lastUser) details.push(`We left off on ${clean(previous.lastUser, 92)}.`);
  else if (yesterday.length) details.push(`Yesterday we closed ${clean(yesterday[0].objective, 92)}.`);
  else {
    const recentDone = recentActivity.find((row) => row.status === 'done');
    if (recentDone?.summary) details.push(`Last useful system activity: ${clean(recentDone.summary, 92)}.`);
  }

  if (diagnostic && ['critical', 'attention', 'suggestion'].includes(diagnostic.level)) {
    details.push(`One thing worth checking: ${clean(diagnostic.text, 105)}`);
  } else if (focus?.title) {
    details.push(`The clean next move is ${clean(focus.title, 90)}.`);
  }

  return {
    response: [base, ...details.slice(0, 2)].join(' '),
    context: ctx,
  };
}

module.exports = { STATE_PATH, VARIANTS, choose, create };
