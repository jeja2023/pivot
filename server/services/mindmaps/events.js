'use strict';
// 事件只携带文档标识；每个接收连接重新鉴权后读取内容，避免撤权后广播数据。
const events = new (require('node:events').EventEmitter)();
function changed(id) { events.emit('changed', String(id)); }
module.exports = { events, changed };
