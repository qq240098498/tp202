const { AppError } = require('./errors');
const store = require('./store');
const water = require('./water');

const STATUS_LIST = ['运行', '检修'];

function decorate(data, reservoir) {
  const curve = water.curveOf(data, reservoir.id);
  const today = store.todayIso();
  const latest = data.levels
    .filter((l) => l.reservoirId === reservoir.id)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const check = latest ? water.levelCheck(reservoir, latest.level, latest.date, data.settings) : null;
  const points = curve ? water.sortedPoints(curve) : [];
  const capacityAtNormal = curve ? water.capacityAt(curve, reservoir.normalLevel, data.settings) : 0;
  const capacityAtFloodLimit = curve ? water.capacityAt(curve, reservoir.floodLimitLevel, data.settings) : 0;
  return Object.assign({}, reservoir, {
    curveId: curve ? curve.id : '',
    pointCount: points.length,
    curveVerifiedOn: curve ? curve.verifiedOn : '',
    capacityAtNormal,
    capacityAtFloodLimit,
    floodCapacityGap: store.round(capacityAtNormal - capacityAtFloodLimit, 3),
    latestLevelDate: latest ? latest.date : '',
    latestLevel: latest ? Number(latest.level) : null,
    today,
    limitNow: water.limitLevelOf(reservoir, today, data.settings),
    levelCheck: check,
    levelCount: data.levels.filter((l) => l.reservoirId === reservoir.id).length,
  });
}

function list(data) {
  return data.reservoirs.map((r) => decorate(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function find(data, id) {
  const found = data.reservoirs.find((r) => r.id === id);
  if (!found) throw new AppError(404, 'RESERVOIR_NOT_FOUND', '这个水库不存在');
  return found;
}

function detail(data, id) {
  const reservoir = find(data, id);
  const curve = water.curveOf(data, id);
  const levels = data.levels.filter((l) => l.reservoirId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const inflows = data.inflows.filter((l) => l.reservoirId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const releases = data.releases.filter((l) => l.reservoirId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const orders = data.orders.filter((o) => o.reservoirId === id).sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
  return Object.assign({}, decorate(data, reservoir), {
    curve: curve ? Object.assign({}, curve, { points: water.sortedPoints(curve) }) : null,
    levels,
    inflows,
    releases,
    orders,
  });
}

function validate(payload, current) {
  const errors = {};
  const merged = Object.assign({}, current || {}, payload || {});
  if (!String(merged.name || '').trim()) errors.name = '水库名称不能为空';
  if (!STATUS_LIST.includes(merged.status)) errors.status = '状态只能是：' + STATUS_LIST.join('、');
  const numbers = ['normalLevel', 'floodLimitLevel', 'deadLevel', 'warningLevel'];
  for (const key of numbers) {
    if (!Number.isFinite(Number(merged[key]))) errors[key] = '要填数字';
  }
  if (Number(merged.floodLimitLevel) > Number(merged.normalLevel)) errors.floodLimitLevel = '汛限水位不能高于正常蓄水位';
  if (Number(merged.deadLevel) > Number(merged.floodLimitLevel)) errors.deadLevel = '死水位不能高于汛限水位';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验，请按提示补齐', errors);
  }
}

function create(data, payload) {
  validate(payload, null);
  const reservoir = {
    id: store.nextId('res', data.reservoirs),
    code: 'SK' + String(data.reservoirs.length + 1).padStart(3, '0'),
    name: String(payload.name).trim(),
    normalLevel: Number(payload.normalLevel),
    floodLimitLevel: Number(payload.floodLimitLevel),
    deadLevel: Number(payload.deadLevel),
    warningLevel: Number(payload.warningLevel),
    status: payload.status,
    basin: String(payload.basin || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.reservoirs.push(reservoir);
  data.curves.push({ id: store.nextId('curve', data.curves), reservoirId: reservoir.id, verifiedOn: store.todayIso(), points: [] });
  return reservoir;
}

function update(data, id, payload) {
  const reservoir = find(data, id);
  validate(payload, reservoir);
  const merged = Object.assign({}, reservoir, payload);
  Object.assign(reservoir, {
    name: String(merged.name).trim(),
    normalLevel: Number(merged.normalLevel),
    floodLimitLevel: Number(merged.floodLimitLevel),
    deadLevel: Number(merged.deadLevel),
    warningLevel: Number(merged.warningLevel),
    status: merged.status,
    basin: String(merged.basin || '').trim(),
    remark: String(merged.remark || ''),
  });
  return reservoir;
}

function remove(data, id) {
  find(data, id);
  const used = data.levels.filter((l) => l.reservoirId === id).length + data.orders.filter((o) => o.reservoirId === id).length;
  if (used > 0) {
    throw new AppError(409, 'RESERVOIR_IN_USE', '这个水库名下还有 ' + used + ' 条水位或指令记录，不能删除', { count: used });
  }
  data.reservoirs = data.reservoirs.filter((r) => r.id !== id);
  data.curves = data.curves.filter((c) => c.reservoirId !== id);
  return { removed: id };
}

// 水位-库容曲线：整条替换，保存前校验水位递增、库容递增
function saveCurve(data, reservoirId, payload) {
  const reservoir = find(data, reservoirId);
  const points = (payload.points || []).map((p) => ({ level: Number(p.level), capacity: Number(p.capacity) }));
  const errors = {};
  points.forEach((p, index) => {
    if (!Number.isFinite(p.level) || !Number.isFinite(p.capacity)) errors['points.' + index] = '水位与库容都要填数字';
  });
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].level <= points[i - 1].level) errors['points.' + i] = '水位要从小到大';
    if (points[i].capacity < points[i - 1].capacity) errors['points.' + i] = '库容要随水位递增';
  }
  if (points.length < 2) errors.points = '至少要两个点';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '曲线点没通过校验，请按提示补齐', errors);
  }
  let curve = water.curveOf(data, reservoirId);
  if (!curve) {
    curve = { id: store.nextId('curve', data.curves), reservoirId, verifiedOn: store.todayIso(), points: [] };
    data.curves.push(curve);
  }
  curve.points = points;
  curve.verifiedOn = String(payload.verifiedOn || store.todayIso());
  curve.remark = String(payload.remark || '');
  return Object.assign({}, curve, { reservoirName: reservoir.name });
}

module.exports = { list, find, detail, create, update, remove, saveCurve, decorate, STATUS_LIST };
