const store = require('./store');
const water = require('./water');
const records = require('./records');

function overview(data) {
  const settings = data.settings;
  const today = store.todayIso();

  const reservoirs = data.reservoirs.map((r) => {
    const own = data.levels.filter((l) => l.reservoirId === r.id).sort((a, b) => (a.date < b.date ? 1 : -1));
    const latest = own[0];
    const latestInflowDate = data.inflows
      .filter((x) => x.reservoirId === r.id)
      .map((x) => x.date)
      .sort()
      .slice(-1)[0];
    const inflow = data.inflows
      .filter((x) => x.reservoirId === r.id && x.date === (latestInflowDate || ''))
      .reduce((s, x) => s + Number(x.flow), 0);
    const check = latest ? water.levelCheck(r, latest.level, latest.date, settings) : null;
    const warning = latest ? water.warningOf(r, latest.level, inflow, settings) : null;
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      date: latest ? latest.date : '',
      level: latest ? Number(latest.level) : null,
      inflow,
      limit: check ? check.limit : null,
      over: check ? check.over : null,
      exceeded: check ? check.exceeded : false,
      floodSeason: check ? check.floodSeason : false,
      warning: warning ? warning.level : '',
    };
  });

  const orders = data.orders.map((o) => records.decorateOrder(data, o));
  const orderStatusCount = {};
  for (const o of orders) orderStatusCount[o.status] = (orderStatusCount[o.status] || 0) + 1;

  const exceededCount = data.levels.filter((l) => {
    const reservoir = data.reservoirs.find((r) => r.id === l.reservoirId);
    return reservoir ? water.levelCheck(reservoir, l.level, l.date, settings).exceeded : false;
  }).length;

  return {
    today,
    reservoirCount: data.reservoirs.length,
    runningCount: data.reservoirs.filter((r) => r.status === '运行').length,
    reservoirs,
    levelCount: data.levels.length,
    exceededCount,
    orderCount: data.orders.length,
    orderStatusCount,
    activeOrders: orders.filter((o) => o.status === '已下达' || o.status === '执行中').length,
    orderDeviationCount: orders.filter((o) => o.deviation !== null && Math.abs(o.deviation) > 5).length,
    lossPerDayWan: Number(settings.lossPerDayWan),
    toleranceWan: Number(settings.balanceToleranceWan),
    floodSeason: settings.floodSeasonStart + ' 至 ' + settings.floodSeasonEnd,
  };
}

module.exports = { overview };
