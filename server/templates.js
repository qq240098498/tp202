const { AppError } = require('./errors');
const store = require('./store');
const questions = require('./questions');

function decorate(data, template) {
  const sections = (template.sections || []).map((s) => ({
    type: s.type,
    count: Number(s.count),
    scoreEach: Number(s.scoreEach),
    minDifficulty: Number(s.minDifficulty),
    maxDifficulty: Number(s.maxDifficulty),
    sectionScore: store.round(Number(s.count) * Number(s.scoreEach), 2),
  }));
  const sectionScoreSum = store.round(sections.reduce((sum, s) => sum + s.sectionScore, 0), 2);
  const poolCount = sections.reduce((sum, s) => {
    return sum + data.questions.filter((q) =>
      q.subjectCode === template.subjectCode &&
      q.type === s.type &&
      q.status === '启用' &&
      Number(q.difficulty) >= s.minDifficulty &&
      Number(q.difficulty) <= s.maxDifficulty
    ).length;
  }, 0);
  const needCount = sections.reduce((sum, s) => sum + s.count, 0);
  return Object.assign({}, template, {
    sections,
    sectionScoreSum,
    totalScore: Number(template.totalScore),
    needCount,
    poolCount,
    poolEnough: poolCount >= needCount,
    usedInCount: data.papers.filter((p) => p.templateId === template.id).length,
  });
}

function list(data) {
  return data.templates.map((t) => decorate(data, t)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function find(data, id) {
  const found = data.templates.find((t) => t.id === id);
  if (!found) throw new AppError(404, 'TEMPLATE_NOT_FOUND', '这个卷面模板不存在');
  return found;
}

function validate(data, payload) {
  const errors = {};
  if (!String(payload.name || '').trim()) errors.name = '模板名称不能为空';
  if (!data.subjects.some((s) => s.code === payload.subjectCode)) errors.subjectCode = '科目不存在';
  const total = Number(payload.totalScore);
  if (!Number.isFinite(total) || total <= 0) errors.totalScore = '卷面总分要填正数';
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  if (!sections.length) errors.sections = '至少要有一节';
  let sum = 0;
  sections.forEach((s, index) => {
    if (!questions.TYPE_LIST.includes(s.type)) errors['sections.' + index + '.type'] = '题型不对';
    const count = Number(s.count);
    const scoreEach = Number(s.scoreEach);
    if (!Number.isFinite(count) || count <= 0) errors['sections.' + index + '.count'] = '题量要填正数';
    if (!Number.isFinite(scoreEach) || scoreEach <= 0) errors['sections.' + index + '.scoreEach'] = '每题分值要填正数';
    const min = Number(s.minDifficulty);
    const max = Number(s.maxDifficulty);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) errors['sections.' + index + '.minDifficulty'] = '难度区间不对';
    sum += (Number.isFinite(count) ? count : 0) * (Number.isFinite(scoreEach) ? scoreEach : 0);
  });
  if (Number.isFinite(total) && Math.abs(store.round(sum, 2) - total) > 0.001) {
    errors.sections = '各节分值相加是 ' + store.round(sum, 2) + '，与卷面总分 ' + total + ' 不一致';
  }
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '模板没通过校验，请按提示补齐', errors);
  }
}

function create(data, payload) {
  validate(data, payload);
  const template = {
    id: store.nextId('tpl', data.templates),
    code: 'MB-' + String(data.templates.length + 1).padStart(3, '0'),
    name: String(payload.name).trim(),
    subjectCode: payload.subjectCode,
    totalScore: Number(payload.totalScore),
    sections: payload.sections.map((s) => ({
      type: s.type,
      count: Number(s.count),
      scoreEach: Number(s.scoreEach),
      minDifficulty: Number(s.minDifficulty),
      maxDifficulty: Number(s.maxDifficulty),
    })),
    remark: String(payload.remark || ''),
  };
  data.templates.push(template);
  return template;
}

function update(data, id, payload) {
  const template = find(data, id);
  const merged = Object.assign({}, template, payload);
  validate(data, merged);
  Object.assign(template, {
    name: String(merged.name).trim(),
    subjectCode: merged.subjectCode,
    totalScore: Number(merged.totalScore),
    sections: (merged.sections || []).map((s) => ({
      type: s.type,
      count: Number(s.count),
      scoreEach: Number(s.scoreEach),
      minDifficulty: Number(s.minDifficulty),
      maxDifficulty: Number(s.maxDifficulty),
    })),
    remark: String(merged.remark || ''),
  });
  return template;
}

function remove(data, id) {
  find(data, id);
  const used = data.papers.filter((p) => p.templateId === id).length;
  if (used > 0) {
    throw new AppError(409, 'TEMPLATE_IN_USE', '这个模板已经被 ' + used + ' 份试卷用过，不能删除', { paperCount: used });
  }
  data.templates = data.templates.filter((t) => t.id !== id);
  return { removed: id };
}

module.exports = { list, find, create, update, remove, decorate };
