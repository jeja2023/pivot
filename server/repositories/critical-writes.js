'use strict';
const { queryOne } = require('../db/client');

async function exists(kind, deliveryId) {
    if (kind === 'auditLogs') return Boolean(await queryOne('SELECT 1 FROM audit_logs WHERE delivery_id = ?', [deliveryId]));
    if (kind === 'modelUsageEvents') return Boolean(await queryOne('SELECT 1 FROM model_usage_events WHERE delivery_id = ?', [deliveryId]));
    throw new Error('关键写入类型未登记。');
}

module.exports = { exists };
