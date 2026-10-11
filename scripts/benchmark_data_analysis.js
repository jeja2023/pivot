'use strict';

// 数据分析容量基准：在不触及用户数据或外部模型的前提下测量
// CSV→Parquet 导入、聚合查询、透视聚合与导出。真实模型指标必须显式传入，
// 防止把本地估算冒充为线上 AI 成本或延迟证据。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { DuckDBInstance } = require('@duckdb/node-api');

const DEFAULT_TIERS = [100_000, 1_000_000, 10_000_000];
const MAX_ROWS = 10_000_000;

function arg(name, fallback = '') {
    const inline = process.argv.find(value => String(value).startsWith(`${name}=`));
    if (inline) return String(inline).slice(name.length + 1);
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function parseTiers(value) {
    const requested = String(value || '').trim();
    const source = requested ? requested.split(',') : (hasFlag('--all-tiers') ? DEFAULT_TIERS.map(String) : [String(DEFAULT_TIERS[0])]);
    const tiers = source.map(item => Number.parseInt(item.trim(), 10));
    if (!tiers.length || tiers.some(item => !Number.isSafeInteger(item) || item < 1 || item > MAX_ROWS)) {
        throw new Error(`--rows 仅接受 1 到 ${MAX_ROWS.toLocaleString('zh-CN')} 之间的逗号分隔整数。`);
    }
    return [...new Set(tiers)];
}

function sqlLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function elapsedMs(start) {
    return Number(process.hrtime.bigint() - start) / 1_000_000;
}

async function writeSyntheticCsv(filePath, rows) {
    const stream = fs.createWriteStream(filePath, { encoding: 'utf8', mode: 0o600 });
    stream.write('id,region,month,amount,comment\n');
    for (let index = 1; index <= rows; index += 1) {
        const region = `region-${String(index % 100).padStart(2, '0')}`;
        const month = `2025-${String((index % 12) + 1).padStart(2, '0')}`;
        const amount = ((index * 37) % 10_000) / 10;
        const line = `${index},${region},${month},${amount.toFixed(1)},sample record ${index}\n`;
        if (!stream.write(line)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

async function runTier(root, rows) {
    const tierDir = path.join(root, `rows-${rows}`);
    await fs.promises.mkdir(tierDir, { recursive: true, mode: 0o700 });
    const csvPath = path.join(tierDir, 'source.csv');
    const parquetPath = path.join(tierDir, 'source.parquet');
    const exportPath = path.join(tierDir, 'summary.csv');
    const timings = {};

    let started = process.hrtime.bigint();
    await writeSyntheticCsv(csvPath, rows);
    timings.generateCsvMs = elapsedMs(started);

    const instance = await DuckDBInstance.create(':memory:', {
        threads: String(Math.max(1, Math.min(os.cpus()?.length || 2, 4)))});
    const connection = await instance.connect();
    try {
        started = process.hrtime.bigint();
        await connection.run(`COPY (SELECT * FROM read_csv_auto(${sqlLiteral(csvPath)})) TO ${sqlLiteral(parquetPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
        timings.importToParquetMs = elapsedMs(started);

        started = process.hrtime.bigint();
        const aggregate = await connection.runAndReadAll(`
            SELECT region, COUNT(*) AS row_count, ROUND(SUM(amount), 2) AS amount_total
            FROM read_parquet(${sqlLiteral(parquetPath)})
            GROUP BY region
            ORDER BY amount_total DESC, region ASC
        `);
        const aggregateRows = aggregate.getRowObjectsJson();
        timings.aggregateQueryMs = elapsedMs(started);

        started = process.hrtime.bigint();
        const pivot = await connection.runAndReadAll(`
            SELECT region, month, ROUND(SUM(amount), 2) AS amount_total
            FROM read_parquet(${sqlLiteral(parquetPath)})
            GROUP BY region, month
            ORDER BY region, month
        `);
        const pivotRows = pivot.getRowObjectsJson();
        timings.pivotQueryMs = elapsedMs(started);

        started = process.hrtime.bigint();
        await connection.run(`COPY (
            SELECT region, month, COUNT(*) AS row_count, ROUND(SUM(amount), 2) AS amount_total
            FROM read_parquet(${sqlLiteral(parquetPath)})
            GROUP BY region, month
            ORDER BY region, month
        ) TO ${sqlLiteral(exportPath)} (HEADER, DELIMITER ',')`);
        timings.exportCsvMs = elapsedMs(started);

        return {
            rows,
            generatedBytes: (await fs.promises.stat(csvPath)).size,
            parquetBytes: (await fs.promises.stat(parquetPath)).size,
            exportBytes: (await fs.promises.stat(exportPath)).size,
            aggregateRows: aggregateRows.length,
            pivotRows: pivotRows.length,
            timings
        };
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

function realAiMetrics() {
    const required = ['--ai-input-tokens', '--ai-output-tokens', '--ai-latency-ms', '--ai-input-price-per-million', '--ai-output-price-per-million'];
    const raw = Object.fromEntries(required.map(name => [name, arg(name, '').trim()]));
    const measured = required.every(name => raw[name] !== '');
    if (!measured) {
        return {
            measured: false,
            reason: '真实模型成本与时延需要显式传入实测 token、价格和时延；本地数据基准不会伪造该证据。'
        };
    }
    const inputTokens = Number(raw['--ai-input-tokens']);
    const outputTokens = Number(raw['--ai-output-tokens']);
    const latencyMs = Number(raw['--ai-latency-ms']);
    const inputPrice = Number(raw['--ai-input-price-per-million']);
    const outputPrice = Number(raw['--ai-output-price-per-million']);
    if (![inputTokens, outputTokens, latencyMs, inputPrice, outputPrice].every(Number.isFinite)) {
        throw new Error('AI 基准指标必须是有限数字。');
    }
    return {
        measured: true,
        model: arg('--ai-model', 'unspecified'),
        inputTokens,
        outputTokens,
        latencyMs,
        estimatedCost: (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice,
        currency: arg('--ai-currency', 'USD')
    };
}

async function main() {
    if (hasFlag('--help') || hasFlag('-h')) {
        process.stdout.write('用法：node scripts/benchmark_data_analysis.js [--rows 100000,1000000,10000000 | --all-tiers] [--report 报告路径] [--keep-files] [--ai-model 名称 --ai-input-tokens N --ai-output-tokens N --ai-latency-ms N --ai-input-price-per-million N --ai-output-price-per-million N]\n');
        return;
    }
    const tiers = parseTiers(arg('--rows'));
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pivot-data-analysis-benchmark-'));
    try {
        const results = [];
        for (const rows of tiers) results.push(await runTier(root, rows));
        const report = {
            kind: 'pivot_data_analysis_capacity_benchmark',
            generatedAt: new Date().toISOString(),
            tiers: results,
            ai: realAiMetrics(),
            notes: [
                '所有数据为本地生成的非敏感样本；结果仅代表当前主机与 DuckDB 配置。',
                '千万行以上、跨节点、对象存储或专用 OLAP 的结论必须在目标生产架构上另行验证。'
            ]
        };
        const reportPath = arg('--report');
        if (reportPath) await fs.promises.writeFile(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally {
        if (!hasFlag('--keep-files')) await fs.promises.rm(root, { recursive: true, force: true });
        else process.stderr.write(`保留基准临时目录：${root}\n`);
    }
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
