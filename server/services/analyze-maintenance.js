'use strict';

function tableKey(table = {}) {
    return `${String(table.schemaname || '').trim()}.${String(table.tablename || '').trim()}`;
}

function createAnalyzeProgress() {
    return {
        running: false,
        totalTables: 0,
        completedTables: 0,
        failedTables: 0,
        cursor: 0,
        nextTable: '',
        currentTable: '',
        elapsedMs: 0,
        totalTimeoutMs: 0,
        timedOut: false
    };
}

function resolveCursor(tables, progress = {}) {
    const nextTable = String(progress.nextTable || '').trim();
    if (nextTable) {
        const index = tables.findIndex(table => tableKey(table) === nextTable);
        if (index >= 0) return index;
    }
    const cursor = Number.parseInt(progress.cursor, 10);
    return Number.isInteger(cursor) && cursor >= 0 && cursor < tables.length ? cursor : 0;
}

async function runAnalyzeTables(tables, {
    analyzeTable,
    now = () => Date.now(),
    progress = createAnalyzeProgress(),
    totalTimeoutMs
} = {}) {
    if (typeof analyzeTable !== 'function') throw new Error('ANALYZE 维护任务缺少单表执行器。');
    const normalizedTables = Array.isArray(tables) ? tables.filter(table => tableKey(table) !== '.') : [];
    const timeoutMs = Math.max(1_000, Number.parseInt(totalTimeoutMs, 10) || 1_000);
    const startedAt = now();
    const startIndex = resolveCursor(normalizedTables, progress);
    const failures = [];

    Object.assign(progress, {
        running: true,
        totalTables: normalizedTables.length,
        completedTables: startIndex,
        failedTables: 0,
        cursor: startIndex,
        nextTable: normalizedTables[startIndex] ? tableKey(normalizedTables[startIndex]) : '',
        currentTable: '',
        elapsedMs: 0,
        totalTimeoutMs: timeoutMs,
        timedOut: false
    });

    for (let index = startIndex; index < normalizedTables.length; index += 1) {
        const elapsedMs = Math.max(0, now() - startedAt);
        // 单表 SQL 超时最低为 1 秒；剩余预算不足一个可执行时间片时不再启动新事务，
        // 让本轮总时限成为硬上限，并把下一张表留给后续周期。
        if (elapsedMs + 1_000 > timeoutMs) {
            Object.assign(progress, {
                running: false,
                cursor: index,
                nextTable: tableKey(normalizedTables[index]),
                currentTable: '',
                elapsedMs,
                timedOut: true
            });
            return { completed: false, timedOut: true, failures, progress };
        }

        const table = normalizedTables[index];
        progress.currentTable = tableKey(table);
        try {
            await analyzeTable(table, Math.max(1_000, timeoutMs - elapsedMs));
        } catch (error) {
            failures.push({ table: tableKey(table), error: error?.message || String(error) });
        }
        progress.completedTables = index + 1;
        progress.failedTables = failures.length;
        progress.cursor = index + 1;
        progress.nextTable = normalizedTables[index + 1] ? tableKey(normalizedTables[index + 1]) : '';
        progress.elapsedMs = Math.max(0, now() - startedAt);
    }

    Object.assign(progress, {
        running: false,
        currentTable: '',
        elapsedMs: Math.max(0, now() - startedAt),
        timedOut: false
    });
    if (!failures.length) {
        progress.cursor = 0;
        progress.nextTable = '';
    }
    return { completed: failures.length === 0, timedOut: false, failures, progress };
}

module.exports = { createAnalyzeProgress, runAnalyzeTables, tableKey };
