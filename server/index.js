const path = require('path');
const express = require('express');
const api = require('./api');
const store = require('./store');

const app = express();
const port = Number(Number(process.env.PORT || 5202));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', api);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || '服务端出错了',
      details: err.details || null,
    },
  });
});

app.listen(port, () => {
  let info = '';
  try {
    const data = store.load();
    info = '水库 ' + data.reservoirs.length + ' 座、水位记录 ' + data.levels.length + ' 条、调度指令 ' + data.orders.length + ' 条';
  } catch (err) {
    info = '数据文件还没准备好：' + err.message;
  }
  console.log('水库调度与汛限水位管理台已启动：http://localhost:' + port + '（' + info + '）');
});
