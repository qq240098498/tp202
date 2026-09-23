const { AppError } = require('./errors');
const store = require('./store');

const TYPE_LIST = ['单选', '多选', '填空', '解答'];
const STATUS_LIST = ['启用', '停用', '送审'];

function decorate(data, question) {
  const topic = data.topics.find((t) => t.code === question.topicCode);
  const subject = data.subjects.find((s) => s.code === question.subjectCode);
  return Object.assign({}, question, {
    topicName: topic ? topic.name : '(未登记的知识点)',
    subjectName: subject ? subject.name : '(未登记的科目)',
    usedInCount: data.papers.filter((p) => (p.items || []).some((it) => it.questionId === question.id)).length,
  });
}

function list(data, query) {
  const q = query || {};
  let rows = data.questions.slice();
  if (q.subjectCode) rows = rows.filter((x) => x.subjectCode === q.subjectCode);
  if (q.topicCode) rows = rows.filter((x) => x.topicCode === q.topicCode);
  if (q.type) rows = rows.filter((x) => x.type === q.type);
  if (q.status) rows = rows.filter((x) => x.status === q.status);
  if (q.minDifficulty) rows = rows.filter((x) => Number(x.difficulty) >= Number(q.minDifficulty));
  if (q.maxDifficulty) rows = rows.filter((x) => Number(x.difficulty) <= Number(q.maxDifficulty));
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((x) => [x.code, x.title, x.topicName, x.type].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((x) => decorate(data, x)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function find(data, id) {
  const found = data.questions.find((x) => x.id === id);
  if (!found) throw new AppError(404, 'QUESTION_NOT_FOUND', '这道题不存在，可能已经被删掉了');
  return found;
}

function validate(data, payload, current) {
  const errors = {};
  const merged = Object.assign({}, current || {}, payload || {});
  if (!String(merged.title || '').trim()) errors.title = '题干不能为空';
  if (!TYPE_LIST.includes(merged.type)) errors.type = '题型只能是：' + TYPE_LIST.join('、');
  if (!STATUS_LIST.includes(merged.status)) errors.status = '状态只能是：' + STATUS_LIST.join('、');
  if (!data.subjects.some((s) => s.code === merged.subjectCode)) errors.subjectCode = '科目不存在';
  if (!data.topics.some((t) => t.code === merged.topicCode)) errors.topicCode = '知识点不存在';
  const difficulty = Number(merged.difficulty);
  if (!Number.isFinite(difficulty) || difficulty < 0.1 || difficulty > 1) errors.difficulty = '难度系数请在 0.1 到 1 之间';
  const score = Number(merged.score);
  if (!Number.isFinite(score) || score <= 0 || score > 30) errors.score = '分值请在 0 到 30 之间';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验，请按提示补齐', errors);
  }
}

function create(data, payload) {
  validate(data, payload, null);
  const question = {
    id: store.nextId('q', data.questions),
    code: 'TK-' + String(data.questions.length + 1).padStart(4, '0'),
    title: String(payload.title).trim(),
    subjectCode: payload.subjectCode,
    topicCode: payload.topicCode,
    type: payload.type,
    difficulty: Number(payload.difficulty),
    score: Number(payload.score),
    answer: String(payload.answer || '').trim(),
    source: String(payload.source || '').trim(),
    year: Number(payload.year) || new Date().getFullYear(),
    status: payload.status,
    exposure: [],
    createdAt: store.todayIso(),
    remark: String(payload.remark || ''),
  };
  data.questions.push(question);
  return question;
}

function update(data, id, payload) {
  const question = find(data, id);
  validate(data, payload, question);
  const merged = Object.assign({}, question, payload);
  Object.assign(question, {
    title: String(merged.title).trim(),
    subjectCode: merged.subjectCode,
    topicCode: merged.topicCode,
    type: merged.type,
    difficulty: Number(merged.difficulty),
    score: Number(merged.score),
    answer: String(merged.answer || '').trim(),
    source: String(merged.source || '').trim(),
    year: Number(merged.year) || question.year,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return question;
}

function remove(data, id) {
  find(data, id);
  data.questions = data.questions.filter((x) => x.id !== id);
  return { removed: id };
}

module.exports = { list, find, create, update, remove, decorate, TYPE_LIST, STATUS_LIST };
