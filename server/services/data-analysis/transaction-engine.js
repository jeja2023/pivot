'use strict';
const money = require('./transaction-money');
const crypto = require('node:crypto');
const { normalize, invalid } = require('./transaction-config');
function timestamp(value, offset) {
    const input = String(value || '').trim().replace(/\//g, '-').replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(input)) throw invalid('交易时间需要 ISO 日期或日期时间格式。');
    const date = input.slice(0, 10); const parsed = new Date(`${date}T00:00:00Z`);
    if (input.length > 10 && (Number(input.slice(11, 13)) > 23 || Number(input.slice(14, 16)) > 59 || Number(input.slice(17, 19) || '0') > 59)) throw invalid('交易时分秒无效。');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw invalid('交易日期无效。');
    const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    const normalized = input.length === 10 ? `${input}T00:00:00${zone}` : /(?:Z|[+-]\d{2}:\d{2})$/.test(input) ? input : input + zone;
    const time = Date.parse(normalized); if (!Number.isFinite(time)) throw invalid('交易时间无效。');
    return time;
}
function periods(time, offset) {
    const local = new Date(time + offset * 60000); const month = local.toISOString().slice(0, 7); const hour = local.getUTCHours();
    local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7);
    return { month, week: local.toISOString().slice(0, 10), hour };
}
const mask = value => value ? String(value).length > 6 ? `${String(value).slice(0, 2)}***${String(value).slice(-4)}` : '***' : '未提供';
const totals = () => ({ income: 0n, expense: 0n, count: 0 });
function add(total, row) { if (row.amount >= 0n) total.income += row.amount; else total.expense -= row.amount; total.count++; }
function publicTotal(total) { return { income: money.format(total.income), expense: money.format(total.expense), net: money.format(total.income - total.expense), count: total.count }; }
function analyze(rows, input) {
    const config = normalize(input); const evidence = []; const issues = []; const records = []; const seen = new Map(); const accounts = new Set(config.accounts);
    const counts = { source: rows.length, accepted: 0, invalid: 0, duplicates: 0, cancelled: 0, outsideScope: 0, internalTransfers: 0, reversals: 0 }; const currencyCodes = new Set();
    function issue(row, reason) { counts.invalid++; if (issues.length < 100) issues.push({ row: Number(row.source_row), reason }); }
    for (const raw of rows) {
        const rowNumber = Number(raw.source_row); const field = key => String(raw[key] ?? '').trim();
        try {
            const account = field('account'); if (!account || account.length > 256) throw invalid('本方账户为空或过长。');
            if (accounts.size && !accounts.has(account)) { counts.outsideScope++; continue; }
            const status = field('status'); if (config.cancelledValues.includes(status)) { counts.cancelled++; continue; }
            let amount = money.parse(field('amount')); const negative = amount < 0n;
            if (config.amountMode === 'direction') { const direction = field('direction'); const sign = config.incomeValues.includes(direction) ? 1n : config.expenseValues.includes(direction) ? -1n : null; if (sign === null) throw invalid('收支方向未映射。'); amount = money.abs(amount) * sign; }
            if (config.reversalValues.includes(status) || (config.amountMode === 'direction' && negative)) { amount = -amount; counts.reversals++; }
            const currency = config.mapping.currency ? field('currency').toUpperCase() : config.defaultCurrency; if (!/^[A-Z]{3}$/.test(currency)) throw invalid('币种为空或不是三位代码。');
            currencyCodes.add(currency); if (currencyCodes.size > 20) throw Object.assign(invalid('币种超过 20 种，请核对字段映射或拆分数据集。'), { fatal: true });
            const time = timestamp(field('time'), config.timezoneOffsetMinutes);
            const counterpartyAccount = field('counterpartyAccount'); const counterpartyName = field('counterpartyName');
            if (config.internalTransfer === 'exclude-both-in-scope' && accounts.has(counterpartyAccount)) { counts.internalTransfers++; continue; }
            const row = { sourceRow: rowNumber, account, counterpartyAccount, counterpartyName, currency, time, amount, balance: field('balance') ? money.parse(field('balance')) : null, ...periods(time, config.timezoneOffsetMinutes) };
            const identity = config.duplicatePolicy === 'exclude-id' && field('transactionId') ? JSON.stringify([account, currency, field('transactionId')]) : config.duplicatePolicy === 'exclude-exact' ? JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'source_row'))) : '';
            const fingerprint = JSON.stringify([time, amount.toString(), counterpartyAccount, counterpartyName]);
            if (identity && seen.has(identity)) { if (seen.get(identity) !== fingerprint) throw invalid('相同交易编号对应不同内容，请清洗后重新分析。'); counts.duplicates++; continue; } if (identity) seen.set(identity, fingerprint);
            const category = config.categories.find(rule => rule.operator === 'equals' ? field(rule.field) === rule.value : field(rule.field).includes(rule.value));
            row.category = config.corrections[String(rowNumber)] || category?.label || '未分类'; row.categoryRule = config.corrections[String(rowNumber)] ? 'manual' : category?.id || '';
            records.push(row);
        } catch (error) { if (error.fatal) throw error; issue(raw, error.message); }
    }
    records.sort((a, b) => a.time - b.time || a.sourceRow - b.sourceRow); counts.accepted = records.length;
    const currencies = new Map(); const monthly = new Map(); const weekly = new Map(); const counterparties = new Map(); const categories = new Map(); const ledgers = new Map();
    const hitCounts = {}; const hit = (rule, row, related = []) => { hitCounts[rule] = (hitCounts[rule] || 0) + 1; if (evidence.length < 200) evidence.push({ rule, currency: row.currency, amount: money.format(money.abs(row.amount)), rows: [...new Set([row.sourceRow, ...related])].slice(0, 20) }); };
    const addGroup = (map, key, row) => { if (!map.has(key)) map.set(key, totals()); add(map.get(key), row); };
    for (const row of records) {
        addGroup(currencies, row.currency, row); addGroup(monthly, `${row.currency}:${row.month}`, row); addGroup(weekly, `${row.currency}:${row.week}`, row); addGroup(categories, JSON.stringify([row.currency, row.category]), row);
        const counterKey = JSON.stringify([row.currency, row.counterpartyAccount || `row:${row.sourceRow}`]);
        if (!counterparties.has(counterKey)) counterparties.set(counterKey, { ...totals(), currency: row.currency, account: mask(row.counterpartyAccount), names: new Set(), identified: Boolean(row.counterpartyAccount), firstSeen: row.time, lastSeen: row.time, evidenceRows: [] });
        const party = counterparties.get(counterKey); add(party, row); if (party.names.size < 5 && row.counterpartyName) party.names.add(mask(row.counterpartyName)); party.lastSeen = row.time; if (party.evidenceRows.length < 5) party.evidenceRows.push(row.sourceRow);
        const threshold = config.rules.thresholds[row.currency]; if (threshold && money.abs(row.amount) >= money.parse(threshold)) hit('largeAmount', row);
        if (row.amount !== 0n && money.abs(row.amount) % money.parse(config.rules.roundAmount) === 0n) hit('roundAmount', row);
        if (row.hour < 6) hit('lateNight', row);
        const ledgerKey = JSON.stringify([row.account, row.currency]);
        if (!ledgers.has(ledgerKey)) ledgers.set(ledgerKey, { frequency: [], frequencyIndex: 0, incoming: [], incomingIndex: 0, balance: null }); const ledger = ledgers.get(ledgerKey);
        const cutoff = row.time - config.rules.windowMinutes * 60000;
        ledger.frequency.push(row); while (ledger.frequency[ledger.frequencyIndex]?.time < cutoff) ledger.frequencyIndex++;
        if (ledger.frequency.length - ledger.frequencyIndex === config.rules.frequency) hit('frequency', row, ledger.frequency.slice(ledger.frequencyIndex, ledger.frequencyIndex + 19).map(item => item.sourceRow));
        if (row.balance !== null && ledger.balance !== null && ledger.balance + row.amount !== row.balance) hit('balanceMismatch', row);
        ledger.balance = row.balance;
        while (ledger.incoming[ledger.incomingIndex]?.time < cutoff) ledger.incomingIndex++;
        if (row.amount > 0n) ledger.incoming.push({ ...row, remaining: row.amount });
        else if (row.amount < 0n) {
            let remaining = -row.amount; const related = []; let consumed = 0n;
            while (remaining > 0n && ledger.incomingIndex < ledger.incoming.length) { const incoming = ledger.incoming[ledger.incomingIndex]; const take = incoming.remaining < remaining ? incoming.remaining : remaining; incoming.remaining -= take; remaining -= take; consumed += take; if (related.length < 19) related.push(incoming.sourceRow); if (!incoming.remaining) ledger.incomingIndex++; }
            if (-row.amount >= money.parse(config.rules.quickMinimum) && consumed * 100n >= -row.amount * 90n) hit('quickInOut', row, related);
        }
    }
    const grouped = (map, label) => [...map.entries()].map(([key, total]) => { const index = key.indexOf(':'); return { currency: key.slice(0, index), [label]: key.slice(index + 1), ...publicTotal(total) }; });
    const parties = [...counterparties.values()].sort((a, b) => { const av = a.income + a.expense; const bv = b.income + b.expense; return av === bv ? 0 : av > bv ? -1 : 1; });
    return { version: 1, ruleVersion: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex'), counts, currencies: [...currencies].map(([currency, total]) => ({ currency, ...publicTotal(total) })), periodCounts: { months: monthly.size, weeks: weekly.size }, monthly: grouped(monthly, 'month').slice(0, 1000), weekly: grouped(weekly, 'week').slice(0, 1000), counterparties: parties.slice(0, 100).map(party => ({ currency: party.currency, account: party.account, names: [...party.names], identified: party.identified, firstSeen: new Date(party.firstSeen).toISOString(), lastSeen: new Date(party.lastSeen).toISOString(), evidenceRows: party.evidenceRows, ...publicTotal(party) })), counterpartyCount: parties.length, categories: [...categories].map(([key, total]) => ({ currency: JSON.parse(key)[0], category: JSON.parse(key)[1], ...publicTotal(total) })), hitCounts, evidence, issues, window: { start: records.length ? new Date(records[0].time).toISOString() : null, end: records.length ? new Date(records.at(-1).time).toISOString() : null, timezoneOffsetMinutes: config.timezoneOffsetMinutes }, caveats: ['统计仅覆盖当前数据窗口，净流量不代表真实期末余额。', '币种分别汇总，不执行汇率换算。', '无对手账户时按来源行分别列示，不以同名户名合并。', '规则命中是待复核线索，不能据此认定交易性质；证据和对手方列表有展示上限。', '取消行、重复行、无效行和范围外交易按口径单独计数；请核对后使用。'] };
}
module.exports = { analyze, timestamp };
