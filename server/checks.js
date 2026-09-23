const store = require('./store');

function bandOf(settings, difficulty) {
  const bands = settings.difficultyBands || [];
  for (const band of bands) {
    if (Number(difficulty) <= Number(band.max)) return band.name;
  }
  return bands.length ? bands[bands.length - 1].name : '未分段';
}

function questionOf(data, id) {
  return data.questions.find((x) => x.id === id) || null;
}

// 题型分布：按题型分别统计题量与分值
function typeStats(data, items) {
  const stats = {};
  for (const item of items) {
    const question = questionOf(data, item.questionId);
    if (!question) continue;
    const key = question.type === '单选' || question.type === '多选' ? '选择题' : question.type;
    if (!stats[key]) stats[key] = { type: key, count: 0, score: 0 };
    stats[key].count += 1;
    stats[key].score = store.round(stats[key].score + Number(item.score), 2);
  }
  return Object.keys(stats).map((k) => stats[k]).sort((a, b) => (a.type < b.type ? -1 : 1));
}

// 难度分布：按设置里的分段统计题量与分值，并给出按分值加权的难度均值
function difficultyStats(data, items, settings) {
  const bands = (settings.difficultyBands || []).map((b) => ({ name: b.name, max: Number(b.max), count: 0, score: 0 }));
  let scoreTotal = 0;
  let weighted = 0;
  for (const item of items) {
    const question = questionOf(data, item.questionId);
    if (!question) continue;
    const name = bandOf(settings, question.difficulty);
    const band = bands.find((b) => b.name === name);
    if (band) {
      band.count += 1;
      band.score = store.round(band.score + Number(item.score), 2);
    }
    scoreTotal += Number(item.score);
    weighted += Number(question.difficulty) * Number(item.score);
  }
  return {
    bands: bands.map((b) => Object.assign({}, b, { scoreShare: scoreTotal ? store.round(b.score / scoreTotal, 4) : 0 })),
    averageDifficulty: scoreTotal ? store.round(weighted / scoreTotal, 4) : 0,
  };
}

// 知识点覆盖：按分值占比判断某个知识点算不算被覆盖
function coverage(data, items, subjectCode, settings) {
  const topics = data.topics.filter((t) => t.subjectCode === subjectCode);
  const byScore = {};
  const byCount = {};
  let scoreTotal = 0;
  for (const item of items) {
    const question = questionOf(data, item.questionId);
    if (!question) continue;
    byScore[question.topicCode] = store.round((byScore[question.topicCode] || 0) + Number(item.score), 2);
    byCount[question.topicCode] = (byCount[question.topicCode] || 0) + 1;
    scoreTotal += Number(item.score);
  }
  const minShare = Number(settings.topicMinShare);
  const rows = topics.map((t) => {
    const score = byScore[t.code] || 0;
    return {
      topicCode: t.code,
      topicName: t.name,
      score,
      count: byCount[t.code] || 0,
      scoreShare: scoreTotal ? store.round(score / scoreTotal, 4) : 0,
      meetsShare: scoreTotal ? score / scoreTotal >= minShare : false,
    };
  });
  const covered = rows.filter((r) => r.count > 0).length;
  return {
    rows,
    covered,
    total: rows.length,
    ratio: rows.length ? store.round(covered / rows.length, 4) : 0,
    minShare,
  };
}

// 卷面合计：逐题分值相加与卷面总分对照
function scoreCheck(items, target) {
  const sum = store.round(items.reduce((acc, item) => acc + Number(item.score), 0), 2);
  return { sum, target: Number(target), gap: store.round(sum - Number(target), 2), ok: Math.abs(sum - Number(target)) < 0.005 };
}

// 组卷核对清单：分值、难度、知识点、题量
function buildIssues(data, template, items, settings) {
  const issues = [];
  const score = scoreCheck(items, template.totalScore);
  if (!score.ok) {
    issues.push({ level: 'error', code: 'SCORE_NOT_MATCH', message: '逐题分值相加是 ' + score.sum + '，卷面总分是 ' + score.target, detail: score });
  }
  const expected = (template.sections || []).reduce((sum, s) => sum + Number(s.count), 0);
  if (items.length < expected) {
    issues.push({ level: 'error', code: 'COUNT_NOT_ENOUGH', message: '题量不足：需要 ' + expected + ' 道，实际 ' + items.length + ' 道', detail: { expected, actual: items.length } });
  }
  for (const section of template.sections || []) {
    const rows = items.filter((it) => it.type === section.type);
    if (!rows.length) {
      issues.push({ level: 'error', code: 'SECTION_EMPTY', message: section.type + '节一道题都没有', detail: { type: section.type } });
    }
  }
  const cover = coverage(data, items, template.subjectCode, settings);
  if (cover.covered < cover.total) {
    const miss = cover.rows.filter((r) => !r.meetsShare).map((r) => r.topicName);
    issues.push({ level: 'warn', code: 'TOPIC_NOT_COVERED', message: '这些知识点的分值占比没到门槛：' + miss.join('、'), detail: cover });
  }
  return issues;
}

module.exports = { bandOf, typeStats, difficultyStats, coverage, scoreCheck, buildIssues, questionOf };
