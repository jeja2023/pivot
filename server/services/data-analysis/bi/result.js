'use strict';

const { canonicalHash } = require('./canonical');
const { parseDecimal, compareDecimals } = require('./decimal');
const { evaluateMetricValues } = require('./metrics');
const { biError } = require('./errors');

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function compareRows(orderBy) {
    return (left, right) => {
        for (const order of orderBy) {
            const a = order.metricId ? left.values[order.metricId]?.value : left.members[order.dimensionId]?.label;
            const b = order.metricId ? right.values[order.metricId]?.value : right.members[order.dimensionId]?.label;
            if (a === null && b !== null) return 1;
            if (a !== null && b === null) return -1;
            if (a === null && b === null) continue;
            const difference = order.metricId ? compareDecimals(parseDecimal(a), parseDecimal(b)) : compareText(String(a), String(b));
            if (difference) return order.direction === 'desc' ? -difference : difference;
        }
        return compareText(left.rowKey, right.rowKey);
    };
}

// 堆顶保留最差的可见记录；扫描多少分组都只在内存保留 limit 条和一个原生数据块。
function retainRow(heap, row, limit, compare) {
    if (heap.length < limit) {
        heap.push(row);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (compare(heap[parent], heap[index]) >= 0) break;
            [heap[parent], heap[index]] = [heap[index], heap[parent]]; index = parent;
        }
        return;
    }
    if (compare(row, heap[0]) >= 0) return;
    heap[0] = row;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child], heap[child + 1]) < 0) child++;
        if (compare(heap[index], heap[child]) >= 0) break;
        [heap[index], heap[child]] = [heap[child], heap[index]]; index = child;
    }
}

async function consumeModelQuery(connection, compiled, { signal, onRow } = {}) {
    const retained = [], compare = compareRows(compiled.orderBy);
    let total = null, groupCount = 0n;
    const interrupt = () => connection.interrupt();
    const assertActive = () => { if (signal?.aborted) throw biError('ANALYSIS_MODEL_QUERY_CANCELLED', '分析已取消。', 409); };
    assertActive();
    signal?.addEventListener('abort', interrupt, { once: true });
    try {
        const stream = await connection.stream(compiled.sql, compiled.parameters);
        for await (const chunk of stream.yieldRowObjectJson()) {
            assertActive();
            for (const raw of chunk) {
                assertActive();
                const aggregates = Object.create(null), currencyValues = Object.create(null);
                for (const column of compiled.aggregateColumns) aggregates[column.id] = column.countColumn
                    ? { sum: raw[column.valueColumn], count: raw[column.countColumn] } : raw[column.valueColumn];
                for (const column of compiled.aggregateColumns) if (column.currencyCountColumn) currencyValues[column.id] = { distinctCount: String(raw[column.currencyCountColumn]), code: raw[column.currencyCodeColumn], missingCount: String(raw[column.currencyMissingColumn]) };
                const evaluated = evaluateMetricValues(compiled.metrics, aggregates, { currencyValues });
                const values = Object.create(null);
                for (const id of compiled.selectedMetricIds) values[id] = evaluated[id];
                const members = Object.create(null);
                for (const dimension of compiled.dimensionColumns) members[dimension.id] = { key: dimension.keyColumns.map(key => raw[key]), label: raw[dimension.labelColumn], unmatched: Boolean(raw[dimension.unmatchedColumn]) };
                const identity = Object.fromEntries(Object.entries(members).map(([id, member]) => [id, { key: member.key, unmatched: member.unmatched }]));
                const row = { members, values, rowKey: raw.is_total ? 'total' : canonicalHash(identity) };
                if (raw.is_total) {
                    if (total) throw biError('ANALYSIS_MODEL_RESULT_INVALID', '分析返回重复总计，结果未发布。', 500);
                    total = row;
                } else { groupCount++; retainRow(retained, row, compiled.limit, compare); }
                if (onRow) await onRow(row, { total: Boolean(raw.is_total) });
            }
        }
        if (!total) throw biError('ANALYSIS_MODEL_RESULT_INVALID', '分析缺少总计，结果未发布。', 500);
        if (!compiled.dimensionColumns.length) { retained.push(total); groupCount = 1n; }
        retained.sort(compare);
        return { rows: retained, total, groupCount: groupCount.toString(), limit: compiled.limit, truncated: groupCount > BigInt(compiled.limit),
            queryHash: compiled.queryHash, timezone: compiled.timezone, columns: { dimensions: compiled.dimensionColumns.map(dimension => dimension.id), metrics: compiled.selectedMetricIds } };
    } catch (error) {
        connection.interrupt();
        assertActive();
        throw error;
    } finally { signal?.removeEventListener('abort', interrupt); }
}

module.exports = { consumeModelQuery };
