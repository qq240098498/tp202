const { AppError } = require('./errors');
const store = require('./store');
const water = require('./water');
const reservoirs = require('./reservoirs');

// 水位记录
function listLevels(data, query) {
  const q = query || {};
  let rows = data.levels.slice();
  if (q.reservoirId) rows = rows.filter((l) => l.reservoirId === q.reservoirId);
  if (q.from) rows = rows.filter((l) => l.date >= q.from);
  if (q.to) rows = rows.filter((l) => l.date <= q.to);
  return rows
    .map((l) => {
      const reservoir = data.reservoirs.find((r) => r.id === l.reservoirId);
      const check = reservoir ? water.levelCheck(reservoir, l.level, l.date, data.settings) : null;
      const inflow = data.inflows
        .filter((x) => x.reservoirId === l.reservoirId && x.date === l.date)
        .reduce((s, x) => s + Number(x.flow), 0);
      const warning = reservoir ? water.warningOf(reservoir, l.level, inflow, data.settings) : null;
      return Object.assign({}, l, {
        reservoirName: reservoir ? reservoir.name : '',
        limit: check ? check.limit : null,
        over: check ? check.over : null,
        exceeded: check ? check.exceeded : false,
        floodSeason: check ? check.floodSeason : false,
        inflow,
        warning: warning ? warning.level : '',
      });
    })
    .sort((a, b) => (a.date === b.date ? (a.reservoirId < b.reservoirId ? -1 : 1) : a.date < b.date ? 1 : -1));
}

function saveLevel(data, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const date = String(payload.date || '').trim();
  const level = Number(payload.level);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'VALIDATION_FAILED', '日期要按 年-月-日 填', { date: '日期格式不对' });
  if (!Number.isFinite(level)) throw new AppError(400, 'VALIDATION_FAILED', '水位要填数字', { level: '水位不对' });
  const existing = data.levels.find((l) => l.reservoirId === reservoir.id && l.date === date && l.time === String(payload.time || '08:00'));
  if (existing) {
    existing.level = level;
    existing.remark = String(payload.remark || '');
    return { updated: true, id: existing.id };
  }
  const record = {
    id: store.nextId('lev', data.levels),
    reservoirId: reservoir.id,
    date,
    time: String(payload.time || '08:00'),
    level,
    source: String(payload.source || '实测'),
    recorder: String(payload.recorder || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.levels.push(record);
  return { updated: false, id: record.id };
}

function removeLevel(data, id) {
  const found = data.levels.find((l) => l.id === id);
  if (!found) throw new AppError(404, 'LEVEL_NOT_FOUND', '这条水位记录不存在');
  data.levels = data.levels.filter((l) => l.id !== id);
  return { removed: id };
}

// 入库与出库流量记录
function listFlows(data, kind, query) {
  const q = query || {};
  const source = kind === 'inflow' ? data.inflows : data.releases;
  let rows = source.slice();
  if (q.reservoirId) rows = rows.filter((r) => r.reservoirId === q.reservoirId);
  if (q.from) rows = rows.filter((r) => r.date >= q.from);
  if (q.to) rows = rows.filter((r) => r.date <= q.to);
  return rows
    .map((r) => {
      const reservoir = data.reservoirs.find((x) => x.id === r.reservoirId);
      return Object.assign({}, r, {
        reservoirName: reservoir ? reservoir.name : '',
        volumeWan: store.round((Number(r.flow) * 86400) / 10000, 3),
      });
    })
    .sort((a, b) => (a.date === b.date ? (a.reservoirId < b.reservoirId ? -1 : 1) : a.date < b.date ? 1 : -1));
}

function saveFlow(data, kind, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const date = String(payload.date || '').trim();
  const flow = Number(payload.flow);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'VALIDATION_FAILED', '日期要按 年-月-日 填', { date: '日期格式不对' });
  if (!Number.isFinite(flow) || flow < 0) throw new AppError(400, 'VALIDATION_FAILED', '流量要填非负数字', { flow: '流量不对' });
  const list = kind === 'inflow' ? data.inflows : data.releases;
  const record = {
    id: store.nextId(kind === 'inflow' ? 'in' : 'out', list),
    reservoirId: reservoir.id,
    date,
    flow,
    type: kind === 'inflow' ? String(payload.type || '实测') : String(payload.type || '发电'),
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  list.push(record);
  return record;
}

function removeFlow(data, kind, id) {
  const list = kind === 'inflow' ? data.inflows : data.releases;
  const found = list.find((r) => r.id === id);
  if (!found) throw new AppError(404, 'FLOW_NOT_FOUND', '这条记录不存在');
  if (kind === 'inflow') data.inflows = data.inflows.filter((r) => r.id !== id);
  else data.releases = data.releases.filter((r) => r.id !== id);
  return { removed: id };
}

// 调度指令
const ORDER_STATUS = ['已下达', '执行中', '已完成', '已撤销'];

function decorateOrder(data, order) {
  const reservoir = data.reservoirs.find((r) => r.id === order.reservoirId);
  const releases = data.releases.filter(
    (r) => r.reservoirId === order.reservoirId && r.date >= order.windowStart && r.date <= order.windowEnd
  );
  const actualMean = releases.length ? store.round(releases.reduce((s, r) => s + Number(r.flow), 0) / releases.length, 2) : null;
  const deviation = actualMean === null ? null : store.round(actualMean - Number(order.targetFlow), 2);
  return Object.assign({}, order, {
    reservoirName: reservoir ? reservoir.name : '',
    actualMean,
    deviation,
    releaseCount: releases.length,
    level: reservoir ? water.levelCheck(reservoir, order.targetFlow, order.issuedAt, data.settings) : null,
  });
}

function listOrders(data, query) {
  const q = query || {};
  let rows = data.orders.slice();
  if (q.reservoirId) rows = rows.filter((o) => o.reservoirId === q.reservoirId);
  if (q.status) rows = rows.filter((o) => o.status === q.status);
  return rows.map((o) => decorateOrder(data, o)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function findOrder(data, id) {
  const found = data.orders.find((o) => o.id === id);
  if (!found) throw new AppError(404, 'ORDER_NOT_FOUND', '这条调度指令不存在');
  return found;
}

function createOrder(data, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const errors = {};
  const targetFlow = Number(payload.targetFlow);
  if (!Number.isFinite(targetFlow) || targetFlow <= 0) errors.targetFlow = '目标下泄流量要填正数';
  const windowStart = String(payload.windowStart || '').trim();
  const windowEnd = String(payload.windowEnd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) errors.windowStart = '起始日期格式不对';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(windowEnd)) errors.windowEnd = '结束日期格式不对';
  if (windowStart && windowEnd && windowEnd < windowStart) errors.windowEnd = '结束日期不能早于起始日期';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '指令没通过校验，请按提示补齐', errors);
  }
  const order = {
    id: store.nextId('ord', data.orders),
    code: 'ZL-' + String(data.orders.length + 1).padStart(4, '0'),
    reservoirId: reservoir.id,
    issuedAt: String(payload.issuedAt || store.todayIso()),
    targetFlow,
    windowStart,
    windowEnd,
    status: ORDER_STATUS.includes(payload.status) ? payload.status : '已下达',
    reason: String(payload.reason || '').trim(),
    issuer: String(payload.issuer || '').trim(),
    remark: String(payload.remark || ''),
    attachments: [],
  };
  data.orders.push(order);
  return decorateOrder(data, order);
}

function updateOrder(data, id, payload) {
  const order = findOrder(data, id);
  const merged = {
    reservoirId: order.reservoirId,
    targetFlow: payload.targetFlow !== undefined ? payload.targetFlow : order.targetFlow,
    windowStart: payload.windowStart !== undefined ? payload.windowStart : order.windowStart,
    windowEnd: payload.windowEnd !== undefined ? payload.windowEnd : order.windowEnd,
    issuedAt: payload.issuedAt !== undefined ? payload.issuedAt : order.issuedAt,
    status: payload.status !== undefined ? payload.status : order.status,
  };
  const draft = {
    id: order.id,
    reservoirId: merged.reservoirId,
    targetFlow: merged.targetFlow,
    windowStart: merged.windowStart,
    windowEnd: merged.windowEnd,
    issuedAt: merged.issuedAt,
    status: merged.status,
  };
  const errors = {};
  if (!Number.isFinite(Number(draft.targetFlow)) || Number(draft.targetFlow) <= 0) errors.targetFlow = '目标下泄流量要填正数';
  if (!ORDER_STATUS.includes(draft.status)) errors.status = '状态只能是：' + ORDER_STATUS.join('、');
  if (draft.windowEnd < draft.windowStart) errors.windowEnd = '结束日期不能早于起始日期';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '指令没通过校验，请按提示补齐', errors);
  }
  Object.assign(order, {
    targetFlow: Number(draft.targetFlow),
    windowStart: String(draft.windowStart),
    windowEnd: String(draft.windowEnd),
    issuedAt: String(draft.issuedAt),
    status: draft.status,
    reason: payload.reason !== undefined ? String(payload.reason) : order.reason,
    issuer: payload.issuer !== undefined ? String(payload.issuer) : order.issuer,
    remark: payload.remark !== undefined ? String(payload.remark) : order.remark,
  });
  return decorateOrder(data, order);
}

// 复制一条指令（含附件与说明）
function copyOrder(data, id, payload) {
  const source = findOrder(data, id);
  const order = {
    id: store.nextId('ord', data.orders),
    code: 'ZL-' + String(data.orders.length + 1).padStart(4, '0'),
    reservoirId: source.reservoirId,
    issuedAt: String((payload && payload.issuedAt) || store.todayIso()),
    targetFlow: Number(source.targetFlow),
    windowStart: String((payload && payload.windowStart) || source.windowStart),
    windowEnd: String((payload && payload.windowEnd) || source.windowEnd),
    status: '已下达',
    reason: String((payload && payload.reason) || source.reason),
    issuer: String((payload && payload.issuer) || source.issuer),
    remark: String((payload && payload.remark) || source.remark),
    attachments: source.attachments,
  };
  data.orders.push(order);
  return decorateOrder(data, order);
}

function removeOrder(data, id) {
  const order = findOrder(data, id);
  if (order.status === '执行中') throw new AppError(409, 'ORDER_RUNNING', '执行中的指令不能删除，请先撤销');
  data.orders = data.orders.filter((o) => o.id !== id);
  return { removed: id };
}

function addAttachment(data, id, payload) {
  const order = findOrder(data, id);
  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new AppError(400, 'VALIDATION_FAILED', '附件名称不能为空', { name: '请填附件名称' });
  order.attachments = order.attachments || [];
  order.attachments.push({ name, note: String((payload && payload.note) || '').trim(), at: store.todayIso() });
  return decorateOrder(data, order);
}

module.exports = {
  listLevels,
  saveLevel,
  removeLevel,
  listFlows,
  saveFlow,
  removeFlow,
  listOrders,
  findOrder,
  createOrder,
  updateOrder,
  copyOrder,
  removeOrder,
  addAttachment,
  decorateOrder,
  ORDER_STATUS,
};
