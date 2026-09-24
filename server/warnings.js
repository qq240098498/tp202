const { AppError } = require('./errors');
const store = require('./store');
const reservoirs = require('./reservoirs');

// 泄洪预警：预警事件 + 通知回执闭环 + 同等级重复发布的序号与前后差异
const GRADES = ['注意', '警戒', '严重'];
const WARNING_STATUS = ['生效中', '已解除'];
const RECEIPTS = ['已收到', '有异议', '未回'];
const NOTICE_METHODS = ['电话', '短信', '传真', '书面', '广播', '上门', '其他'];
const BASIS_KINDS = { level: '水位', inflow: '入库流量', order: '指令' };

// 同等级前后两次发布，水位回落超过这个差值，就算趋势与等级矛盾
const SHARP_DROP = 0.5;

function nowText() {
  const d = new Date();
  return store.todayIso() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 时刻口径：YYYY-MM-DD HH:mm，也接受 T 分隔或只填日期（补 08:00）
function normalizeDt(value, field, errors) {
  const text = String(value || '').trim().replace('T', ' ');
  if (!text) return nowText();
  const m = /^(\d{4}-\d{2}-\d{2})(?: (\d{1,2}):(\d{2}))?$/.exec(text);
  if (!m) {
    if (errors) errors[field] = '时刻要按 年-月-日 时:分 填';
    throw new AppError(400, 'VALIDATION_FAILED', '时刻格式不对', { [field]: '时刻要按 年-月-日 时:分 填' });
  }
  const hh = m[2] === undefined ? '08' : String(Number(m[2])).padStart(2, '0');
  const mm = m[3] === undefined ? '00' : String(Number(m[3])).padStart(2, '0');
  if (Number(hh) > 23 || Number(mm) > 59) {
    throw new AppError(400, 'VALIDATION_FAILED', '时刻里的时分不对', { [field]: '时分为 00:00–23:59' });
  }
  return m[1] + ' ' + hh + ':' + mm;
}

function basisKindsOf(event) {
  const kinds = [];
  if (event.basisLevel !== null && event.basisLevel !== undefined && event.basisLevel !== '') kinds.push(BASIS_KINDS.level);
  if (event.basisInflow !== null && event.basisInflow !== undefined && event.basisInflow !== '') kinds.push(BASIS_KINDS.inflow);
  if (event.basisOrderId) kinds.push(BASIS_KINDS.order);
  return kinds;
}

// 该等级对应的水位门槛：注意=警戒水位下 0.5m，警戒=警戒水位，严重=汛限水位
function gradeLevelThreshold(reservoir, grade) {
  if (grade === '严重') return Number(reservoir.floodLimitLevel);
  if (grade === '警戒') return Number(reservoir.warningLevel);
  return Number(reservoir.warningLevel) - 0.5;
}

// 该等级对应的入库流量门槛：注意/警戒取注意流量，严重取严重流量
function gradeFlowThreshold(settings, grade) {
  return grade === '严重' ? Number(settings.inflowSeriousFlow) : Number(settings.inflowAttentionFlow);
}

function chainOf(data, reservoirId, grade) {
  return data.warnings
    .filter((w) => w.reservoirId === reservoirId && w.grade === grade)
    .sort((a, b) => (a.issuedAt === b.issuedAt ? (a.id < b.id ? -1 : 1) : a.issuedAt < b.issuedAt ? -1 : 1));
}

function findWarning(data, id) {
  const found = data.warnings.find((w) => w.id === id);
  if (!found) throw new AppError(404, 'WARNING_NOT_FOUND', '这条预警不存在');
  return found;
}

function findNotice(warning, nid) {
  const found = (warning.notices || []).find((n) => n.id === nid);
  if (!found) throw new AppError(404, 'NOTICE_NOT_FOUND', '这条通知记录不存在');
  return found;
}

// 与前一次同等级发布逐项对比，差异和矛盾都在这里算出来，前端只原样展示
function buildDiff(data, event, prev) {
  if (!prev) return null;
  const settings = data.settings;
  const kinds = basisKindsOf(event);
  const prevKinds = basisKindsOf(prev);
  const addedKinds = kinds.filter((k) => prevKinds.indexOf(k) < 0);
  const removedKinds = prevKinds.filter((k) => kinds.indexOf(k) < 0);

  const diff = {
    prevId: prev.id,
    prevCode: prev.code,
    prevIssuedAt: prev.issuedAt,
    prevStatus: prev.status,
    prevStillActive: prev.status === '生效中',
    prevKinds,
    addedKinds,
    removedKinds,
    kindsChanged: addedKinds.length > 0 || removedKinds.length > 0,
    levelDelta: null,
    inflowDelta: null,
    orderChanged: false,
    orderFromCode: '',
    orderToCode: '',
    timeReversed: event.issuedAt <= prev.issuedAt,
    prevObjections: (prev.notices || []).filter((n) => n.receipt === '有异议').length,
    contradictions: [],
  };

  const flag = (code, message) => diff.contradictions.push({ code, message });

  if (event.basisLevel !== null && prev.basisLevel !== null) {
    diff.levelDelta = store.round(Number(event.basisLevel) - Number(prev.basisLevel), 2);
    if (diff.levelDelta <= -SHARP_DROP) {
      flag('LEVEL_DROPPED_SHARP', '同为「' + event.grade + '」等级，水位却比前一次回落 ' + Math.abs(diff.levelDelta) + 'm，等级与水势矛盾，请核对是否该降级或解除');
    }
  }
  if (event.basisInflow !== null && prev.basisInflow !== null) {
    diff.inflowDelta = store.round(Number(event.basisInflow) - Number(prev.basisInflow), 2);
  }
  if ((event.basisOrderId || '') !== (prev.basisOrderId || '')) {
    diff.orderChanged = true;
    const from = data.orders.find((o) => o.id === prev.basisOrderId);
    const to = data.orders.find((o) => o.id === event.basisOrderId);
    diff.orderFromCode = from ? from.code : (prev.basisOrderId || '');
    diff.orderToCode = to ? to.code : (event.basisOrderId || '');
  }
  if (diff.removedKinds.length) {
    flag('BASIS_KIND_REMOVED', '前一次依据含「' + diff.removedKinds.join('、') + '」，本次没有这项依据，触发口径发生了变化');
  }
  if (diff.timeReversed) {
    flag('TIME_REVERSED', '本次下达时刻 ' + event.issuedAt + ' 不晚于前一次 ' + prev.issuedAt + '，发布次序对不上');
  }
  return diff;
}

// 依据数值与等级门槛是否自洽（每次发布都查，不只在重复发布时）
function consistencyChecks(data, reservoir, event) {
  const out = [];
  if (event.basisLevel !== null) {
    const threshold = gradeLevelThreshold(reservoir, event.grade);
    if (Number(event.basisLevel) + 1e-9 < threshold) {
      out.push({ code: 'LEVEL_BELOW_GRADE', message: '水位 ' + event.basisLevel + 'm 未达「' + event.grade + '」门槛 ' + threshold + 'm，依据数值与预警等级不符' });
    }
  }
  if (event.basisInflow !== null) {
    const threshold = gradeFlowThreshold(data.settings, event.grade);
    if (Number(event.basisInflow) + 1e-9 < threshold) {
      out.push({ code: 'INFLOW_BELOW_GRADE', message: '入库流量 ' + event.basisInflow + ' m³/s 未达「' + event.grade + '」门槛 ' + threshold + ' m³/s，依据数值与预警等级不符' });
    }
  }
  if (event.basisOrderId) {
    const order = data.orders.find((o) => o.id === event.basisOrderId);
    if (!order) out.push({ code: 'ORDER_MISSING', message: '关联的调度指令 ' + event.basisOrderId + ' 不存在' });
    else if (order.reservoirId !== reservoir.id) out.push({ code: 'ORDER_OTHER_RESERVOIR', message: '关联指令 ' + order.code + ' 属于另一座水库' });
  }
  return out;
}

function decorate(data, event) {
  const reservoir = data.reservoirs.find((r) => r.id === event.reservoirId);
  const chain = chainOf(data, event.reservoirId, event.grade);
  const sequence = chain.findIndex((w) => w.id === event.id) + 1;
  const seqIndex = chain.findIndex((w) => w.id === event.id);
  const prev = seqIndex > 0 ? chain[seqIndex - 1] : null;

  const order = event.basisOrderId ? data.orders.find((o) => o.id === event.basisOrderId) : null;
  const notices = event.notices || [];
  const diff = buildDiff(data, event, prev);
  const contradictions = consistencyChecks(data, reservoir || { warningLevel: 0, floodLimitLevel: 0 }, event).slice();
  if (diff) contradictions.push.apply(contradictions, diff.contradictions);

  // 同一座水库已有别的等级仍在生效：高低等级并存也是互相矛盾
  const activeOther = data.warnings.find(
    (w) => w.reservoirId === event.reservoirId && w.id !== event.id && w.status === '生效中' && w.grade !== event.grade
  );
  if (event.status === '生效中' && activeOther) {
    contradictions.push({ code: 'GRADE_CONFLICT', message: '本库已有生效中的「' + activeOther.grade + '」预警（' + activeOther.code + '），两个等级并存且都未解除，请先明确升降级' });
  }

  return Object.assign({}, event, {
    reservoirName: reservoir ? reservoir.name : '',
    sequence,
    sequenceTotal: chain.length,
    basisKinds: basisKindsOf(event),
    basisOrderCode: order ? order.code : '',
    basisOrderTargetFlow: order ? Number(order.targetFlow) : null,
    prevId: prev ? prev.id : '',
    prevCode: prev ? prev.code : '',
    levelThreshold: reservoir ? gradeLevelThreshold(reservoir, event.grade) : null,
    inflowThreshold: reservoir ? gradeFlowThreshold(data.settings, event.grade) : null,
    diff,
    contradictions,
    noticeCount: notices.length,
    receivedCount: notices.filter((n) => n.receipt === '已收到').length,
    objectionCount: notices.filter((n) => n.receipt === '有异议').length,
    pendingCount: notices.filter((n) => n.receipt === '未回').length,
  });
}

function list(data, query) {
  const q = query || {};
  let rows = data.warnings.slice();
  if (q.reservoirId) rows = rows.filter((w) => w.reservoirId === q.reservoirId);
  if (q.grade) rows = rows.filter((w) => w.grade === q.grade);
  if (q.status) rows = rows.filter((w) => w.status === q.status);
  return rows
    .map((w) => decorate(data, w))
    .sort((a, b) => (a.issuedAt === b.issuedAt ? (a.id < b.id ? -1 : 1) : a.issuedAt < b.issuedAt ? 1 : -1));
}

// 未回执清单：生效中预警里 receipt=未回 的通知，扁平挂出来提醒（已解除的不再催）
function pendingReceipts(data, query) {
  const q = query || {};
  const out = [];
  list(data, {}).forEach((w) => {
    if (w.status !== '生效中') return;
    (w.notices || []).forEach((n) => {
      if (n.receipt !== '未回') return;
      if (q.reservoirId && w.reservoirId !== q.reservoirId) return;
      out.push({
        warningId: w.id,
        warningCode: w.code,
        reservoirId: w.reservoirId,
        reservoirName: w.reservoirName,
        grade: w.grade,
        warningIssuedAt: w.issuedAt,
        warningStatus: w.status,
        id: n.id,
        unit: n.unit,
        contact: n.contact,
        method: n.method,
        notifiedAt: n.notifiedAt,
        note: n.note,
      });
    });
  });
  return out.sort((a, b) => (a.notifiedAt === b.notifiedAt ? (a.id < b.id ? -1 : 1) : a.notifiedAt < b.notifiedAt ? -1 : 1));
}

function createWarning(data, payload) {
  const p = payload || {};
  const reservoir = reservoirs.find(data, p.reservoirId);
  const errors = {};
  if (!GRADES.includes(p.grade)) errors.grade = '预警等级只能是：' + GRADES.join('、');

  const hasLevel = p.basisLevel !== undefined && p.basisLevel !== null && String(p.basisLevel).trim() !== '';
  const hasInflow = p.basisInflow !== undefined && p.basisInflow !== null && String(p.basisInflow).trim() !== '';
  const basisOrderId = String(p.basisOrderId || '').trim();
  if (!hasLevel && !hasInflow && !basisOrderId) errors.basis = '触发依据至少要给一项：水位、入库流量或调度指令';

  const basisLevel = hasLevel ? Number(p.basisLevel) : null;
  const basisInflow = hasInflow ? Number(p.basisInflow) : null;
  if (hasLevel && !Number.isFinite(basisLevel)) errors.basisLevel = '触发水位要填数字';
  if (hasInflow && (!Number.isFinite(basisInflow) || basisInflow < 0)) errors.basisInflow = '入库流量要填非负数字';
  if (basisOrderId && !data.orders.some((o) => o.id === basisOrderId)) errors.basisOrderId = '没有这条调度指令';

  const issuer = String(p.issuer || '').trim();
  if (!issuer) errors.issuer = '下达人不能为空';

  let issuedAt;
  try {
    issuedAt = normalizeDt(p.issuedAt, 'issuedAt');
  } catch (e) {
    errors.issuedAt = (e.details && e.details.issuedAt) || '下达时刻格式不对';
  }

  const status = WARNING_STATUS.includes(p.status) ? p.status : '生效中';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '预警没通过校验，请按提示补齐', errors);
  }

  const chain = chainOf(data, reservoir.id, p.grade);
  const event = {
    id: store.nextId('warn', data.warnings),
    code: 'YJ-' + String(data.warnings.length + 1).padStart(4, '0'),
    reservoirId: reservoir.id,
    grade: p.grade,
    basisLevel,
    basisInflow,
    basisOrderId: basisOrderId || '',
    issuedAt,
    issuer,
    status,
    remark: String(p.remark || ''),
    notices: [],
    prevId: chain.length ? chain[chain.length - 1].id : '',
  };
  data.warnings.push(event);
  return decorate(data, event);
}

function updateWarning(data, id, payload) {
  const warning = findWarning(data, id);
  const p = payload || {};
  if (p.status !== undefined) {
    if (!WARNING_STATUS.includes(p.status)) {
      throw new AppError(400, 'VALIDATION_FAILED', '状态只能是：' + WARNING_STATUS.join('、'), { status: '状态不对' });
    }
    warning.status = p.status;
  }
  if (p.remark !== undefined) warning.remark = String(p.remark);
  if (p.issuer !== undefined && String(p.issuer).trim()) warning.issuer = String(p.issuer).trim();
  return decorate(data, warning);
}

function removeWarning(data, id) {
  const warning = findWarning(data, id);
  if ((warning.notices || []).length) {
    throw new AppError(409, 'WARNING_HAS_NOTICES', '这条预警已有 ' + warning.notices.length + ' 条通知记录，闭环台账不能删除；如已结束请改为「已解除」', { count: warning.notices.length });
  }
  data.warnings = data.warnings.filter((w) => w.id !== id);
  return { removed: id };
}

function addNotice(data, id, payload) {
  const warning = findWarning(data, id);
  const p = payload || {};
  const errors = {};
  const unit = String(p.unit || '').trim();
  const contact = String(p.contact || '').trim();
  const method = String(p.method || '').trim();
  if (!unit) errors.unit = '通知单位不能为空';
  if (!contact) errors.contact = '联系人不能为空';
  if (!method) errors.method = '通知方式不能为空';
  const receipt = RECEIPTS.includes(p.receipt) ? p.receipt : '未回';

  let notifiedAt;
  try {
    notifiedAt = normalizeDt(p.notifiedAt, 'notifiedAt');
  } catch (e) {
    errors.notifiedAt = (e.details && e.details.notifiedAt) || '通知时刻格式不对';
  }
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '通知记录没通过校验，请按提示补齐', errors);
  }

  const notice = {
    id: store.nextId('ntf', allNotices(data)),
    unit,
    contact,
    method,
    notifiedAt,
    receipt,
    receiptAt: receipt === '未回' ? '' : normalizeDt(p.receiptAt, 'receiptAt'),
    objection: receipt === '有异议' ? String(p.objection || '').trim() : '',
    note: String(p.note || '').trim(),
  };
  warning.notices = warning.notices || [];
  warning.notices.push(notice);
  return decorate(data, warning);
}

function allNotices(data) {
  const out = [];
  data.warnings.forEach((w) => (w.notices || []).forEach((n) => out.push(n)));
  return out;
}

function updateNotice(data, id, nid, payload) {
  const warning = findWarning(data, id);
  const notice = findNotice(warning, nid);
  const p = payload || {};
  if (p.receipt !== undefined) {
    if (!RECEIPTS.includes(p.receipt)) {
      throw new AppError(400, 'VALIDATION_FAILED', '回执只能是：' + RECEIPTS.join('、'), { receipt: '回执不对' });
    }
    const wasPending = notice.receipt === '未回';
    notice.receipt = p.receipt;
    if (p.receipt === '未回') {
      notice.receiptAt = '';
      notice.objection = '';
    } else {
      if (wasPending || !notice.receiptAt) {
        let receiptAt;
        try {
          receiptAt = normalizeDt(p.receiptAt, 'receiptAt');
        } catch (e) {
          receiptAt = nowText();
        }
        notice.receiptAt = receiptAt;
      }
      notice.objection = p.receipt === '有异议' ? String(p.objection !== undefined ? p.objection : notice.objection || '').trim() : '';
    }
  }
  if (p.note !== undefined) notice.note = String(p.note).trim();
  if (p.unit !== undefined && String(p.unit).trim()) notice.unit = String(p.unit).trim();
  if (p.contact !== undefined && String(p.contact).trim()) notice.contact = String(p.contact).trim();
  if (p.method !== undefined && String(p.method).trim()) notice.method = String(p.method).trim();
  return decorate(data, warning);
}

function removeNotice(data, id, nid) {
  const warning = findWarning(data, id);
  findNotice(warning, nid);
  warning.notices = (warning.notices || []).filter((n) => n.id !== nid);
  return decorate(data, warning);
}

module.exports = {
  GRADES,
  WARNING_STATUS,
  RECEIPTS,
  NOTICE_METHODS,
  find: findWarning,
  decorate,
  list,
  pendingReceipts,
  createWarning,
  updateWarning,
  removeWarning,
  addNotice,
  updateNotice,
  removeNotice,
};
