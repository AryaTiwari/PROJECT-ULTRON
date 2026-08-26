function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return new Set(normalize(text).split(' ').filter(token => token.length > 1));
}

function score(query, content) {
  const A = tokens(query);
  const B = tokens(content);
  if (!A.size || !B.size) return 0;

  let overlap = 0;
  for (const token of A) if (B.has(token)) overlap += 1;

  const lexical = overlap / Math.sqrt(A.size * B.size);
  const exactPhrase = normalize(content).includes(normalize(query)) ? 0.35 : 0;
  return Math.min(1, lexical + exactPhrase);
}

function retrieve(query, memories = [], limit = 8, minimumScore = 0.12) {
  return memories
    .filter(memory => memory?.active !== false && memory?.content)
    .map(memory => ({
      memory,
      score: score(query, memory.content),
    }))
    .filter(item => item.score >= minimumScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => ({ ...item.memory, retrieval_score: Number(item.score.toFixed(4)) }));
}

module.exports = { normalize, score, retrieve };
