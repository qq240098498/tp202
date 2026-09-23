const store = require('./store');

// 一道题的曝光次数：说明要求只统计近 exposureWindowMonths 个月内的出版次数
function exposureCount(data, question) {
  return (question.exposure || []).length;
}

function recentExposureDates(data, question, settings) {
  const months = Number(settings.exposureWindowMonths) || 12;
  const from = store.addMonths(store.todayIso(), -months);
  return (question.exposure || []).map((e) => e.date).filter((d) => d >= from);
}

function rows(data) {
  const settings = data.settings;
  const limit = Number(settings.exposureLimit);
  return data.questions
    .map((q) => {
      const count = exposureCount(data, q);
      return {
        questionId: q.id,
        code: q.code,
        title: q.title,
        type: q.type,
        subjectName: (data.subjects.find((s) => s.code === q.subjectCode) || {}).name || '',
        exposureCount: count,
        recentCount: recentExposureDates(data, q, settings).length,
        limit,
        over: count > limit,
        history: (q.exposure || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
      };
    })
    .sort((a, b) => b.exposureCount - a.exposureCount || (a.code < b.code ? -1 : 1));
}

function overLimitCount(data) {
  return rows(data).filter((r) => r.over).length;
}

module.exports = { exposureCount, recentExposureDates, rows, overLimitCount };
