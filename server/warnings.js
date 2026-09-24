// 泄洪预警：预警事件、通知闭环、同级重复发布的次数与差异、矛盾标记
// 口径都集中在这里，页面只显示这里算出的派生字段
const { AppError } = require('./errors');
const store = require('./store');
const reservoirs = require('./reservoirs');

const LEVELS = ['注意', '警戒', '严重'];
const BASIS_TYPES = ['水位', '入库流量', '指令'];
const RECEIPTS = ['已收到', '有异议', '未回'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isNum(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function sortKey(w) {
  return String(w.issuedAt || '') + 'T' + String(w.issuedTime || '');
}

// 预警编号：YJ- 加四位，取当前最大编号加一，删掉预警之后新增不重号
function nextWarningCode(data) {
  let max = 0;
  for (const w of data.warnings) {
    const matched = String(w.code || '').match(/^YJ-(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return 'YJ-' + String(max + 1).padStart(4, '0');
}

function nextNotificationId(data) {
  const all = [];
  for (const w of data.warnings) all.push(...(w.notifications || []));
  return store.nextId('ntf', all);
}

// 同一水库同一等级的全部预警，按下达时刻（再按 id）排成发布序列
function seriesOf(data, warning) {
  return data.warnings
    .filter((w) => w.reservoirId === warning.reservoirId && w.level === warning.level)
    .sort((a, b) => {
      const k = sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0;
      return k !== 0 ? k : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x) => b.indexOf(x) >= 0);
}

// 与上一次的差别：依据换没换、水位差多少、流量差多少、指令换没换
function diffAgainst(prev, curr) {
  const t1 = prev.trigger || {};
  const t2 = curr.trigger || {};
  const basisFrom = Array.isArray(t1.basis) ? t1.basis : [];
  const basisTo = Array.isArray(t2.basis) ? t2.basis : [];
  const bothOrder = basisFrom.indexOf('指令') >= 0 && basisTo.indexOf('指令') >= 0;
  return {
    levelDiff: isNum(t1.level) && isNum(t2.level) ? store.round(Number(t2.level) - Number(t1.level), 2) : null,
    inflowDiff: isNum(t1.inflow) && isNum(t2.inflow) ? store.round(Number(t2.inflow) - Number(t1.inflow), 2) : null,
    basisChanged: !sameSet(basisFrom, basisTo),
    basisFrom,
    basisTo,
    orderChanged: bothOrder ? String(t1.orderId || '') !== String(t2.orderId || '') : false,
  };
}

// 两次发布互相矛盾的判定：水位或流量回落仍发同级、触发依据完全更换
function contradictionOf(prev, curr, diff) {
  const t1 = prev.trigger || {};
  const t2 = curr.trigger || {};
  const reasons = [];
  if (diff.levelDiff !== null && diff.levelDiff < 0) {
    reasons.push('触发水位比上一次低 ' + Math.abs(diff.levelDiff) + ' m（' + t1.level + ' → ' + t2.level + '），仍发布同级预警');
  }
  if (diff.inflowDiff !== null && diff.inflowDiff < 0) {
    reasons.push('入库流量比上一次低 ' + Math.abs(diff.inflowDiff) + ' m³/s（' + t1.inflow + ' → ' + t2.inflow + '），仍发布同级预警');
  }
  const disjoint = diff.basisFrom.length > 0 && diff.basisTo.length > 0
    && !diff.basisFrom.some((b) => diff.basisTo.indexOf(b) >= 0);
  if (disjoint) {
    reasons.push('触发依据完全更换（' + diff.basisFrom.join('＋') + ' → ' + diff.basisTo.join('＋') + '），两次依据对不上');
  }
  return { flag: reasons.length > 0, reasons };
}

function notifyStats(warning) {
  const list = warning.notifications || [];
  const stats = { notifyTotal: list.length, notifyReceived: 0, notifyObjection: 0, notifyUnreplied: 0 };
  for (const n of list) {
    const receipt = RECEIPTS.indexOf(n.receipt) >= 0 ? n.receipt : '未回';
    if (receipt === '已收到') stats.notifyReceived += 1;
    else if (receipt === '有异议') stats.notifyObjection += 1;
    else stats.notifyUnreplied += 1;
  }
  return stats;
}

function decorate(data, warning) {
  const reservoir = data.reservoirs.find((r) => r.id === warning.reservoirId);
  const trigger = warning.trigger || {};
  const order = trigger.orderId ? data.orders.find((o) => o.id === trigger.orderId) : null;

  const series = seriesOf(data, warning);
  const index = series.findIndex((w) => w.id === warning.id);
  const prev = index > 0 ? series[index - 1] : null;
  const diff = prev ? diffAgainst(prev, warning) : null;
  const contradiction = prev ? contradictionOf(prev, warning, diff) : { flag: false, reasons: [] };
  const prevOrder = prev && prev.trigger && prev.trigger.orderId
    ? data.orders.find((o) => o.id === prev.trigger.orderId) : null;

  return Object.assign({}, warning, {
    reservoirName: reservoir ? reservoir.name : '',
    reservoirCode: reservoir ? reservoir.code : '',
    orderCode: order ? order.code : '',
    orderMissing: !!(trigger.orderId && !order),
    seq: index + 1,
    seriesCount: series.length,
    previous: prev ? {
      id: prev.id,
      code: prev.code,
      issuedAt: prev.issuedAt,
      issuedTime: prev.issuedTime,
      trigger: prev.trigger || {},
      orderCode: prevOrder ? prevOrder.code : '',
    } : null,
    diff,
    contradiction,
  }, notifyStats(warning));
}

function list(data, query) {
  const q = query || {};
  let rows = data.warnings.slice();
  if (q.reservoirId) rows = rows.filter((w) => w.reservoirId === q.reservoirId);
  if (q.level) rows = rows.filter((w) => w.level === q.level);
  const rank = (level) => LEVELS.indexOf(level);
  return rows
    .map((w) => decorate(data, w))
    .sort((a, b) => {
      const r = rank(a.level) - rank(b.level);
      if (r !== 0) return r;
      return sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0;
    });
}

function find(data, id) {
  const found = data.warnings.find((w) => w.id === id);
  if (!found) throw new AppError(404, 'WARNING_NOT_FOUND', '这条预警不存在');
  return found;
}

function validateTrigger(data, reservoir, payload, errors) {
  const raw = payload.trigger || {};
  let basis = Array.isArray(raw.basis) ? raw.basis.map((b) => String(b)) : [];
  basis = basis.filter((b, i) => BASIS_TYPES.indexOf(b) >= 0 && basis.indexOf(b) === i);
  if (!basis.length) errors['trigger.basis'] = '触发依据至少要勾一项（水位、入库流量、指令）';

  const trigger = { basis, level: null, inflow: null, orderId: null, detail: String(raw.detail || '').trim() };
  if (basis.indexOf('水位') >= 0) {
    if (!isNum(raw.level)) errors['trigger.level'] = '依据含水位时，触发水位要填数字';
    else trigger.level = Number(raw.level);
  }
  if (basis.indexOf('入库流量') >= 0) {
    if (!isNum(raw.inflow) || Number(raw.inflow) < 0) errors['trigger.inflow'] = '依据含入库流量时，流量要填非负数字';
    else trigger.inflow = Number(raw.inflow);
  }
  if (basis.indexOf('指令') >= 0) {
    const orderId = String(raw.orderId || '').trim();
    if (!orderId) {
      errors['trigger.orderId'] = '依据含指令时，要选关联的调度指令';
    } else {
      const order = data.orders.find((o) => o.id === orderId);
      if (!order) errors['trigger.orderId'] = '关联的调度指令不存在';
      else if (order.reservoirId !== reservoir.id) errors['trigger.orderId'] = '关联指令不属于这个水库';
      else trigger.orderId = orderId;
    }
  }
  return trigger;
}

function create(data, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const errors = {};
  const level = String(payload.level || '');
  if (LEVELS.indexOf(level) < 0) errors.level = '预警等级只能是：' + LEVELS.join('、');
  const issuedAt = String(payload.issuedAt || '').trim();
  if (!DATE_RE.test(issuedAt)) errors.issuedAt = '下达日期要按 年-月-日 填';
  const issuedTime = String(payload.issuedTime || '').trim();
  if (!TIME_RE.test(issuedTime)) errors.issuedTime = '下达时刻要按 时:分 填（如 08:30）';
  const issuer = String(payload.issuer || '').trim();
  if (!issuer) errors.issuer = '下达人必须登记';
  const trigger = validateTrigger(data, reservoir, payload, errors);
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '预警没通过校验，请按提示补齐', errors);
  }
  const warning = {
    id: store.nextId('warn', data.warnings),
    code: nextWarningCode(data),
    reservoirId: reservoir.id,
    level,
    trigger,
    issuedAt,
    issuedTime,
    issuer,
    remark: String(payload.remark || ''),
    notifications: [],
  };
  data.warnings.push(warning);
  return decorate(data, warning);
}

function remove(data, id) {
  find(data, id);
  data.warnings = data.warnings.filter((w) => w.id !== id);
  return { removed: id };
}

function validateNotification(payload, current, errors) {
  const merged = Object.assign({}, current || {}, payload || {});
  const out = {
    unit: String(merged.unit || '').trim(),
    contact: String(merged.contact || '').trim(),
    method: String(merged.method || '').trim(),
    notifiedAt: String(merged.notifiedAt || '').trim(),
    notifiedTime: String(merged.notifiedTime || '').trim(),
    receipt: RECEIPTS.indexOf(merged.receipt) >= 0 ? merged.receipt : '未回',
    receiptAt: String(merged.receiptAt || '').trim(),
    receiptTime: String(merged.receiptTime || '').trim(),
    note: String(merged.note || '').trim(),
  };
  if (!out.unit) errors.unit = '通知单位不能为空';
  if (!out.contact) errors.contact = '联系人不能为空';
  if (!out.method) errors.method = '通知方式不能为空';
  if (!DATE_RE.test(out.notifiedAt)) errors.notifiedAt = '通知日期要按 年-月-日 填';
  if (!TIME_RE.test(out.notifiedTime)) errors.notifiedTime = '通知时刻要按 时:分 填';
  if (payload.receipt !== undefined && RECEIPTS.indexOf(payload.receipt) < 0) {
    errors.receipt = '回执只能是：' + RECEIPTS.join('、');
  }
  if (out.receipt === '未回') {
    out.receiptAt = '';
    out.receiptTime = '';
  } else {
    if (!DATE_RE.test(out.receiptAt)) errors.receiptAt = '回了就要登记回执日期';
    if (!TIME_RE.test(out.receiptTime)) errors.receiptTime = '回了就要登记回执时刻（时:分）';
  }
  return out;
}

function addNotification(data, id, payload) {
  const warning = find(data, id);
  const errors = {};
  const values = validateNotification(payload || {}, null, errors);
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '通知对象没通过校验，请按提示补齐', errors);
  }
  warning.notifications = warning.notifications || [];
  warning.notifications.push(Object.assign({ id: nextNotificationId(data) }, values));
  return decorate(data, warning);
}

function updateNotification(data, id, nid, payload) {
  const warning = find(data, id);
  const target = (warning.notifications || []).find((n) => n.id === nid);
  if (!target) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', '这条通知记录不存在');
  const errors = {};
  const values = validateNotification(payload || {}, target, errors);
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '回执没通过校验，请按提示补齐', errors);
  }
  Object.assign(target, values);
  return decorate(data, warning);
}

function removeNotification(data, id, nid) {
  const warning = find(data, id);
  const before = (warning.notifications || []).length;
  warning.notifications = (warning.notifications || []).filter((n) => n.id !== nid);
  if (warning.notifications.length === before) {
    throw new AppError(404, 'NOTIFICATION_NOT_FOUND', '这条通知记录不存在');
  }
  return decorate(data, warning);
}

// 概览用的计数：预警数、未回执/有异议通知数、有矛盾标记的预警数
function counts(data) {
  const rows = list(data, {});
  return {
    warningCount: rows.length,
    warningUnrepliedCount: rows.reduce((s, w) => s + w.notifyUnreplied, 0),
    warningObjectionCount: rows.reduce((s, w) => s + w.notifyObjection, 0),
    warningContradictionCount: rows.filter((w) => w.contradiction.flag).length,
  };
}

module.exports = {
  LEVELS,
  BASIS_TYPES,
  RECEIPTS,
  list,
  find,
  decorate,
  create,
  remove,
  addNotification,
  updateNotification,
  removeNotification,
  counts,
};
