const { AppError } = require('./errors');
const store = require('./store');
const questions = require('./questions');
const templates = require('./templates');
const checks = require('./checks');
const exposure = require('./exposure');

const STATUS_LIST = ['草稿', '已定稿', '已作废'];

function variantOf(data, templateId) {
  const used = data.papers.filter((p) => p.templateId === templateId && p.status !== '已作废').map((p) => p.variant);
  const letters = 'ABCDEFGH';
  for (const ch of letters) {
    if (!used.includes(ch)) return ch;
  }
  return 'X';
}

function decorate(data, paper) {
  const template = data.templates.find((t) => t.id === paper.templateId);
  const settings = data.settings;
  const items = paper.items || [];
  const rows = items.map((item, index) => {
    const question = checks.questionOf(data, item.questionId);
    return Object.assign({}, item, {
      order: index + 1,
      code: question ? question.code : '(题目已删除)',
      title: question ? question.title : '(这道题已经不在题库里了)',
      topicName: question ? (data.topics.find((t) => t.code === question.topicCode) || {}).name || '' : '',
      subjectName: question ? (data.subjects.find((s) => s.code === question.subjectCode) || {}).name || '' : '',
      missing: !question,
    });
  });
  const score = checks.scoreCheck(items, template ? template.totalScore : 0);
  return Object.assign({}, paper, {
    templateName: template ? template.name : '(模板已删除)',
    subjectCode: template ? template.subjectCode : '',
    itemCount: rows.length,
    needCount: template ? (template.sections || []).reduce((sum, s) => sum + Number(s.count), 0) : 0,
    totalScore: score.sum,
    targetScore: score.target,
    scoreOk: score.ok,
    items: rows,
    typeStats: checks.typeStats(data, items),
    difficultyStats: checks.difficultyStats(data, items, settings),
    coverage: template ? checks.coverage(data, items, template.subjectCode, settings) : null,
    issues: template ? checks.buildIssues(data, template, items, settings) : [],
  });
}

function list(data, query) {
  const q = query || {};
  let rows = data.papers.slice();
  if (q.templateId) rows = rows.filter((p) => p.templateId === q.templateId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorate(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function find(data, id) {
  const found = data.papers.find((p) => p.id === id);
  if (!found) throw new AppError(404, 'PAPER_NOT_FOUND', '这份试卷不存在');
  return found;
}

function detail(data, id) {
  return decorate(data, find(data, id));
}

// 组卷：按模板各节抽题
function assemble(data, payload) {
  const template = templates.find(data, payload.templateId);
  const items = [];
  for (const section of template.sections) {
    const pool = data.questions.filter((q) =>
      q.subjectCode === template.subjectCode && q.type === section.type && q.status === '启用'
    );
    const inRange = pool.filter((q) => Number(q.difficulty) >= Number(section.minDifficulty) && Number(q.difficulty) <= Number(section.maxDifficulty));
    const ordered = inRange.slice().sort((a, b) => exposure.exposureCount(data, a) - exposure.exposureCount(data, b) || Number(a.difficulty) - Number(b.difficulty));
    const picked = [];
    for (const q of ordered) {
      if (picked.length >= Number(section.count)) break;
      picked.push(q);
    }
    if (picked.length < Number(section.count)) {
      const rest = pool
        .filter((q) => !picked.includes(q))
        .sort((a, b) => Math.abs(Number(a.difficulty) - Number(section.minDifficulty)) - Math.abs(Number(b.difficulty) - Number(section.minDifficulty)));
      for (const q of rest) {
        if (picked.length >= Number(section.count)) break;
        picked.push(q);
      }
    }
    for (const q of picked) {
      items.push({ questionId: q.id, type: q.type, score: Number(section.scoreEach), difficulty: Number(q.difficulty) });
    }
  }

  const paper = {
    id: store.nextId('p', data.papers),
    code: (payload.code || 'SJ') + '-' + String(data.papers.length + 1).padStart(3, '0'),
    templateId: template.id,
    variant: payload.variant || variantOf(data, template.id),
    name: String(payload.name || (template.name + ' ' + store.todayIso())).trim(),
    status: '草稿',
    createdAt: store.todayIso(),
    publishedAt: '',
    creator: String(payload.creator || '').trim(),
    items,
    remark: String(payload.remark || ''),
  };
  data.papers.push(paper);
  return decorate(data, paper);
}

// 复制一份：题目列表要各自独立
function copy(data, id, payload) {
  const source = find(data, id);
  const paper = {
    id: store.nextId('p', data.papers),
    code: String(payload && payload.code ? payload.code : source.code.replace(/-([^-]+)$/, '-B')) + String(data.papers.length + 1).padStart(3, '0'),
    templateId: source.templateId,
    variant: variantOf(data, source.templateId),
    name: String((payload && payload.name) || source.name + '（副本）').trim(),
    status: '草稿',
    createdAt: store.todayIso(),
    publishedAt: '',
    creator: String((payload && payload.creator) || '').trim(),
    items: source.items,
    remark: String((payload && payload.remark) || ''),
  };
  data.papers.push(paper);
  return decorate(data, paper);
}

function updateItem(data, id, questionId, payload) {
  const paper = find(data, id);
  if (paper.status === '已作废') throw new AppError(409, 'PAPER_VOIDED', '这份试卷已经作废，不能再改');
  const item = (paper.items || []).find((it) => it.questionId === questionId);
  if (!item) throw new AppError(404, 'ITEM_NOT_FOUND', '这份试卷里没有这道题');
  if (payload.score !== undefined) {
    const score = Number(payload.score);
    if (!Number.isFinite(score) || score <= 0) throw new AppError(400, 'VALIDATION_FAILED', '分值要填正数', { score: '分值不对' });
    item.score = score;
  }
  if (payload.difficulty !== undefined) {
    const difficulty = Number(payload.difficulty);
    if (!Number.isFinite(difficulty) || difficulty < 0.1 || difficulty > 1) throw new AppError(400, 'VALIDATION_FAILED', '难度系数请在 0.1 到 1 之间', { difficulty: '难度不对' });
    item.difficulty = difficulty;
  }
  return decorate(data, paper);
}

function removeItem(data, id, questionId) {
  const paper = find(data, id);
  const index = (paper.items || []).findIndex((it) => it.questionId === questionId);
  if (index < 0) throw new AppError(404, 'ITEM_NOT_FOUND', '这份试卷里没有这道题');
  paper.items.splice(index, 1);
  return decorate(data, paper);
}

function publish(data, id) {
  const paper = find(data, id);
  if (paper.status !== '草稿') throw new AppError(409, 'PAPER_STATE', '只有草稿可以定稿，这份试卷现在是「' + paper.status + '」');
  paper.status = '已定稿';
  paper.publishedAt = store.todayIso();
  for (const item of paper.items || []) {
    const question = checks.questionOf(data, item.questionId);
    if (!question) continue;
    question.exposure = question.exposure || [];
    question.exposure.push({ date: paper.publishedAt, paperCode: paper.code });
  }
  return decorate(data, paper);
}

function voidPaper(data, id, payload) {
  const paper = find(data, id);
  if (paper.status === '已作废') throw new AppError(409, 'PAPER_STATE', '这份试卷已经作废过了');
  paper.status = '已作废';
  paper.voidReason = String((payload && payload.reason) || '').trim();
  return decorate(data, paper);
}

function remove(data, id) {
  const paper = find(data, id);
  if (paper.status === '已定稿') throw new AppError(409, 'PAPER_STATE', '已定稿的试卷不能删除，请先作废');
  data.papers = data.papers.filter((p) => p.id !== id);
  return { removed: id };
}

// 等值核对：同一模板下的两份卷子对照
function equivalence(data, templateId) {
  const rows = data.papers
    .filter((p) => p.templateId === templateId && p.status === '已定稿')
    .map((p) => decorate(data, p));
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      const gap = store.round(Math.abs(a.difficultyStats.averageDifficulty - b.difficultyStats.averageDifficulty), 4);
      pairs.push({
        aCode: a.code,
        bCode: b.code,
        aAvg: a.difficultyStats.averageDifficulty,
        bAvg: b.difficultyStats.averageDifficulty,
        difficultyGap: gap,
        scoreGap: store.round(Math.abs(a.totalScore - b.totalScore), 2),
        itemGap: Math.abs(a.itemCount - b.itemCount),
        equivalent: gap <= 0.05 && Math.abs(a.totalScore - b.totalScore) < 0.005 && a.itemCount === b.itemCount,
      });
    }
  }
  return { templateId, papers: rows.map((r) => ({ code: r.code, name: r.name, status: r.status, avg: r.difficultyStats.averageDifficulty, totalScore: r.totalScore, itemCount: r.itemCount })), pairs };
}

module.exports = { list, find, detail, assemble, copy, updateItem, removeItem, publish, voidPaper, remove, equivalence, decorate, STATUS_LIST };
