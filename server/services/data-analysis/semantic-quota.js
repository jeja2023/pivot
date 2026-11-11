'use strict';
// 兼容旧调用方；所有业务模型调用共用同一份每日额度预留。
const { ensureModelQuota, getInflightQuota, reserveInflightQuota } = require('../model-daily-quota');
module.exports = { ensureSemanticQuota: ensureModelQuota, getInflightQuota, reserveInflightQuota };
