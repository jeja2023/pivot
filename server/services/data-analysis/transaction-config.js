'use strict';
const money = require('./transaction-money');
const invalid = message => Object.assign(new Error(message), { status: 422, expose: true, code: 'TRANSACTION_CONFIG_INVALID' });
const FIELDS = Object.freeze(['account', 'counterpartyAccount', 'counterpartyName', 'time', 'amount', 'direction', 'currency', 'balance', 'memo', 'transactionId', 'status']);
function normalize(input = {}) {
    if (!input || typeof input !== 'object' || !input.mapping || typeof input.mapping !== 'object') throw invalid('请确认交易字段映射。');
    const mapping = {};
    for (const key of FIELDS) { const value = input.mapping[key]; if (value !== undefined && value !== '') { if (typeof value !== 'string' || value.length > 96) throw invalid('字段映射无效。'); mapping[key] = value; } }
    if (!mapping.account || !mapping.time || !mapping.amount) throw invalid('本方账户、交易时间和金额为必选字段。');
    const amountMode = input.amountMode || 'signed';
    if (!['signed', 'direction'].includes(amountMode) || (amountMode === 'direction' && !mapping.direction)) throw invalid('请选择金额正负或已确认的收支方向口径。');
    const values = (value, fallback) => { const list = value ?? fallback; if (!Array.isArray(list) || list.length > 20 || list.some(item => typeof item !== 'string' || !item.trim() || item.length > 40)) throw invalid('方向及状态映射最多 20 项，每项最多 40 字符。'); return [...new Set(list.map(item => item.trim()))]; };
    const incomeValues = values(input.incomeValues, ['收入', '入', '贷']); const expenseValues = values(input.expenseValues, ['支出', '出', '借']);
    if (incomeValues.some(value => expenseValues.includes(value))) throw invalid('收入和支出的方向值不能重叠。');
    const timezoneOffsetMinutes = input.timezoneOffsetMinutes ?? 480;
    if (!Number.isInteger(timezoneOffsetMinutes) || timezoneOffsetMinutes < -840 || timezoneOffsetMinutes > 840) throw invalid('时区偏移应为 -840 到 840 分钟。');
    const defaultCurrency = String(input.defaultCurrency || 'CNY').toUpperCase();
    if (!/^[A-Z]{3}$/.test(defaultCurrency)) throw invalid('请使用三位币种代码。');
    const accounts = values(input.accounts, []); const internalTransfer = input.internalTransfer || 'include';
    if (!['include', 'exclude-both-in-scope'].includes(internalTransfer) || (internalTransfer === 'exclude-both-in-scope' && (!mapping.counterpartyAccount || accounts.length < 2))) throw invalid('排除内部转账需要明确列出至少两个本方账户并映射对手账户。');
    const duplicatePolicy = input.duplicatePolicy || 'exclude-id';
    if (!['include', 'exclude-id', 'exclude-exact'].includes(duplicatePolicy)) throw invalid('重复行处理方式无效。');
    const rules = input.rules || {}; const positive = (value, fallback) => { const raw = value === undefined ? fallback : value; let parsed; try { parsed = money.parse(raw); } catch (_) { throw invalid('规则金额阈值需要有效的定点数字。'); } if (parsed <= 0n) throw invalid('规则金额阈值必须大于零。'); return money.format(parsed); };
    const windowMinutes = rules.windowMinutes ?? 60; const frequency = rules.frequency ?? 20;
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440 || !Number.isInteger(frequency) || frequency < 2 || frequency > 1000) throw invalid('时间窗应为 1–1440 分钟，频次阈值应为 2–1000 次。');
    const thresholds = {}; for (const [currency, value] of Object.entries(rules.thresholds || { [defaultCurrency]: '10000' })) { if (!/^[A-Z]{3}$/.test(currency)) throw invalid('阈值币种无效。'); thresholds[currency] = positive(value, '10000'); } if (Object.keys(thresholds).length > 20) throw invalid('最多配置 20 个币种阈值。');
    if (input.categories !== undefined && (!Array.isArray(input.categories) || input.categories.length > 50)) throw invalid('分类规则必须为数组，最多 50 项。');
    const categories = (input.categories || []).map(rule => { if (!rule || !/^[\w-]{1,64}$/.test(rule.id || '') || !['memo', 'counterpartyName', 'counterpartyAccount'].includes(rule.field) || !['contains', 'equals'].includes(rule.operator) || typeof rule.value !== 'string' || !rule.value || rule.value.length > 120 || typeof rule.label !== 'string' || !rule.label.trim() || rule.label.length > 40) throw invalid('分类规则无效，请使用文字包含或完全匹配规则。'); return { id: rule.id, field: rule.field, operator: rule.operator, value: rule.value, label: rule.label.trim() }; });
    if (categories.length > 50 || new Set(categories.map(rule => rule.id)).size !== categories.length) throw invalid('分类规则最多 50 项且标识不能重复。');
    const corrections = input.corrections || {};
    if (typeof corrections !== 'object' || Array.isArray(corrections) || Object.keys(corrections).length > 1000 || Object.entries(corrections).some(([key, value]) => !/^\d{1,9}$/.test(key) || typeof value !== 'string' || !value.trim() || value.length > 40)) throw invalid('分类修正应按来源行号填写，最多 1000 项。');
    const retentionDays = input.retentionDays ?? 30;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw invalid('分析保留期应为 1–365 天。');
    return { version: 1, mapping, amountMode, incomeValues, expenseValues, reversalValues: values(input.reversalValues, ['冲正', '撤销入账']), cancelledValues: values(input.cancelledValues, ['已取消', '未入账']), timezoneOffsetMinutes, defaultCurrency, accounts, internalTransfer, duplicatePolicy, rules: { thresholds, roundAmount: positive(rules.roundAmount, '1000'), quickMinimum: positive(rules.quickMinimum, '1000'), windowMinutes, frequency }, categories, corrections: { ...corrections }, retentionDays };
}
module.exports = { normalize, FIELDS, invalid };
