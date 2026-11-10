'use strict';

// 此执行进程不加载应用数据库、身份或密钥，只消费控制进程固定的受控输入。
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { DuckDBInstance } = require('@duckdb/node-api');
const { BI_POLICY } = require('../services/data-analysis/bi/policy');
const { checkModelQuality } = require('../services/data-analysis/bi/quality');
const { compileModelQuery } = require('../services/data-analysis/bi/query');
const { consumeModelQuery } = require('../services/data-analysis/bi/result');
const { sqlIdentifier, sqlLiteral } = require('../services/data-analysis/bi/sql-expressions');
const { executionFields } = require('../services/data-analysis/bi/field-requirements');
let finishStatistics = null;
async function respond(value) { process.stdout.write(JSON.stringify({ ...value, ...(finishStatistics ? { runtimeMetrics: await finishStatistics() } : {}) })); }

async function input() {
    let text = '';
    for await (const piece of process.stdin) {
        text += piece.toString('utf8');
        if (Buffer.byteLength(text) > 3 * 1024 * 1024) throw new Error('隔离执行器输入超过协议上限。');
    }
    return JSON.parse(text);
}

async function main() {
    const payload = await input();
    if (payload.protocol !== 2 || payload.compilerVersion !== BI_POLICY.compilerVersion) throw new Error('隔离执行器协议或编译版本不兼容。');
    const root = path.resolve(payload.outputRoot);
    const spillRoot = path.resolve(payload.spillRoot || path.join(root, 'spill'));
    await fs.promises.mkdir(spillRoot, { recursive: true });
    finishStatistics = require('../services/data-analysis/bi/execution-statistics').executionStatistics(spillRoot);
    const output = path.join(root, 'result.ndjson');
    const instance = await DuckDBInstance.create(':memory:', { threads: '2', memory_limit: '1GiB', temp_directory: spillRoot, max_temp_directory_size: '8GiB' });
    const connection = await instance.connect();
    try {
        const engine = (await connection.runAndReadAll('SELECT version() AS version')).getRowObjectsJson()[0].version;
        if (!/^v1\.5\./.test(engine)) throw new Error('隔离执行器引擎版本不兼容。');
        if (payload.kind === 'ingest') {
            const result = await require('../services/data-analysis/bi/ingest-worker').ingestCsvChunks(connection, payload);
            await respond({ protocol: 2, engine, result }); return;
        }
        if (['node_preview', 'node_dataset'].includes(payload.kind)) {
            const result = await require('../services/data-analysis/bi/flow-worker').executeFlow(connection, payload);
            await respond({ protocol: 2, engine, result }); return;
        }
        if (payload.kind === 'probe_cancel') {
            await fs.promises.writeFile(path.join(root, 'cancel-ready'), '开始计算', { flag: 'wx', mode: 0o644 });
            await connection.run('SELECT SUM(CAST(a.range AS HUGEINT)*b.range) FROM range(1000000000) a CROSS JOIN range(1000000000) b');
            return;
        }
        if (payload.kind === 'export') {
            const result = await require('../services/data-analysis/bi/export-result').exportModelResult({ ...payload, format: payload.resultFormat });
            await respond({ protocol: 2, engine, result }); return;
        }
        if (payload.kind === 'probe') {
            const read = async name => { try { return (await fs.promises.readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim(); } catch (_) { return null; } };
            const network = process.platform === 'linux' ? await fs.promises.readFile('/proc/net/route', 'utf8') : '';
            const identity = process.platform === 'linux' ? await fs.promises.readFile('/proc/self/status', 'utf8') : '';
            const inputBytes = payload.inputResult ? await fs.promises.readFile(payload.inputResult) : null;
            const deniedWrite = async file => { try { await fs.promises.appendFile(file, 'x'); return false; } catch (_) { return true; } };
            const probeFile = path.join(root, 'write-probe'); await fs.promises.writeFile(probeFile, '就绪'); await fs.promises.unlink(probeFile);
            await connection.run('SET autoinstall_known_extensions=false'); await connection.run('SET autoload_known_extensions=false'); await connection.run('SET enable_external_access=false'); await connection.run('SET lock_configuration=true');
            const configured = (await connection.runAndReadAll("SELECT current_setting('enable_external_access') AS external,current_setting('autoinstall_known_extensions') AS install,current_setting('autoload_known_extensions') AS load")).getRowObjectsJson()[0];
            const spill = process.platform === 'linux' ? await fs.promises.statfs(payload.spillRoot) : null;
            const limits = { memory: await read('memory.max'), cpu: await read('cpu.max'), pids: await read('pids.max'), networkIsolated: !network.split('\n').some(line => /^\S+\s+00000000\s/.test(line)),
                nonPrivileged: Boolean(process.getuid?.()), uid: process.getuid?.(), gid: process.getgid?.(), outputWritable: true,
                inputReadable: Boolean(inputBytes), inputSha256: inputBytes ? require('node:crypto').createHash('sha256').update(inputBytes).digest('hex') : null,
                noCoordinatorSocket: await fs.promises.access('/var/run/docker.sock').then(() => false, () => true), capabilitiesDropped: /^CapEff:\s+0+$/m.test(identity), noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(identity),
                inputReadOnly: payload.inputResult ? await deniedWrite(payload.inputResult) : null,
                rootReadOnly: process.platform === 'linux' ? await deniedWrite('/app/.analysis-write-probe') : false, spillBytes: spill ? String(spill.blocks * spill.bsize) : null,
                capabilities: ['check', 'query', 'export', 'ingest', 'node_flow', 'cancel', 'migration_compare', 'column_projection', 'runtime_metrics'], extensionsDisabled: !configured.external && !configured.install && !configured.load, noCredentials: !Object.keys(process.env).some(key => /^(DATABASE_URL|JWT_SECRET|DATA_ENCRYPTION_KEY|PGPASSWORD|OPENAI_API_KEY)$/.test(key)) };
            await respond({ protocol: 2, engine, probe: limits });
            return;
        }
        const sources = Object.create(null);
        const compiled = payload.kind === 'check' ? null : compileModelQuery(payload.definition, payload.query, payload.sources, { evaluationTime: payload.evaluationTime });
        const factNode = payload.definition.nodes.find(node => node.role === 'fact');
        const materialized = compiled ? new Set([factNode.id, ...compiled.joins.flatMap(relation => [relation.leftNodeId, relation.rightNodeId])]) : null;
        const required = executionFields(payload.definition, payload.query, payload.kind === 'check', compiled?.joins || payload.definition.relations);
        if (payload.query?.migrationComparison) for (const node of payload.query.migrationComparison.snapshot.nodes) {
            for (const relation of payload.query.migrationComparison.snapshot.relations) {
                if (relation.leftNodeId === node.id) required.get(node.id)?.add(relation.leftFieldKey);
                if (relation.rightNodeId === node.id) required.get(node.id)?.add(relation.rightFieldKey);
            }
            for (const metricId of payload.query.migrationComparison.metrics) {
                const match = metricId.match(/^legacy_metric_(\d+)$/), metric = match && payload.query.migrationComparison.snapshot.metrics[Number(match[1])];
                if (metric?.datasetId === node.datasetId && metric.config.fieldKey && metric.config.aggregation !== 'count') required.get(node.id)?.add(metric.config.fieldKey);
            }
        }
        let dimensionRows = 0;
        for (const [nodeId, source] of Object.entries(payload.sources)) {
            if (!/^bi_input_[0-8]$/.test(source.tableName) || !Array.isArray(source.columns) || !source.columns.length || !path.isAbsolute(source.file)) throw new Error('隔离执行器输入表合同无效。');
            const schema = (await connection.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${sqlLiteral(source.file)})`)).getRowObjectsJson();
            const count = BigInt((await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM read_parquet(${sqlLiteral(source.file)})`)).getRowObjectsJson()[0].n);
            const fact = payload.definition.nodes.find(node => node.id === nodeId)?.role === 'fact';
            if (!fact) dimensionRows += Number(count);
            if (schema.length > 120 || fact && count > 1000000n || dimensionRows > 2000000) throw Object.assign(new Error('模型超过百万事实行、两百万维度行或每表一百二十列的受控档位，请缩小范围。'), { code: 'ANALYSIS_MODEL_CAPACITY_EXCEEDED' });
            sources[nodeId] = { tableName: source.tableName, columns: source.columns };
            if (materialized && !materialized.has(nodeId)) continue;
            // 仅物化本次口径需要的字段，宽表的无关字符串不会挤占执行器内存和溢写预算。
            const selected = source.columns.filter(column => required.get(nodeId)?.has(column.key));
            await connection.run(`CREATE TEMP TABLE ${sqlIdentifier(source.tableName)} AS SELECT ${selected.map(column => sqlIdentifier(column.key)).join(',')} FROM read_parquet(${sqlLiteral(source.file)})`);
        }
        await connection.run('SET autoinstall_known_extensions=false');
        await connection.run('SET autoload_known_extensions=false');
        await connection.run('SET enable_external_access=false');
        await connection.run('SET lock_configuration=true');
        if (payload.kind === 'check') {
            const report = await checkModelQuality(connection, payload.definition, sources);
            if (payload.query?.migrationComparison && report.passed) {
                report.migrationComparison = await require('../services/data-analysis/bi/migration-compare').compareMigration(connection, payload.definition, sources, payload.query.migrationComparison, report);
                if (!report.migrationComparison.complete) { report.passed = false; report.blockers.push({ code: 'ANALYSIS_MODEL_MIGRATION_INCOMPLETE', message: '旧探索对照尚未完成，请查看差异原因并调整对照维度后重新检查。' }); }
                else if (report.migrationComparison.hasDifferences) report.warnings.push({ code: 'ANALYSIS_MODEL_MIGRATION_DIFFERENCE', message: '旧探索与正式模型存在统计差异，请核对对照报告，并在首次发布前填写接受原因。' });
            }
            await respond({ protocol: 2, engine, report });
            return;
        }
        let rows = 0, bytes = 0;
        const writer = fs.createWriteStream(output, { flags: 'wx', mode: 0o600 });
        let writeError = null; writer.on('error', error => { writeError = error; });
        try {
            const result = await consumeModelQuery(connection, compiled, { onRow: async (row, { total }) => {
                if (writeError) throw writeError;
                if (!total && ++rows > 200000) throw Object.assign(new Error('完整结果超过二十万行，请增加筛选条件后重新分析。'), { code: 'ANALYSIS_MODEL_OUTPUT_LIMIT' });
                const line = JSON.stringify({ ...row, isTotal: total }) + '\n'; bytes += Buffer.byteLength(line);
                if (bytes > 200 * 1024 * 1024) throw Object.assign(new Error('完整结果超过二百 MiB，请增加筛选条件。'), { code: 'ANALYSIS_MODEL_OUTPUT_LIMIT' });
                if (!writer.write(line)) await once(writer, 'drain');
            } });
            writer.end(); await once(writer, 'close');
            if (writeError) throw writeError;
            const handle = await fs.promises.open(output, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
            await fs.promises.chmod(output, 0o644);
            const pages = path.join(root, 'pages.ndjson');
            await fs.promises.writeFile(pages, result.rows.map(row => JSON.stringify(row) + '\n').join(''), { flag: 'wx', mode: 0o600 });
            const pageFile = await fs.promises.open(pages, 'r+'); try { await pageFile.sync(); } finally { await pageFile.close(); }
            await fs.promises.chmod(pages, 0o644);
            result.displayedRows = result.rows.length;
            result.rows = result.rows.slice(0, 100);
            await respond({ protocol: 2, engine, result, outputBytes: bytes, outputRows: rows });
        } catch (error) { writer.destroy(); await fs.promises.unlink(output).catch(() => {}); throw error; }
    } finally { connection.closeSync(); instance.closeSync(); }
}

main().catch(async error => {
    // 不透出 SQL、字段值、绝对路径或原生堆栈。
    const code = /^ANALYSIS_[A-Z_]+$/.test(error.code || '') ? error.code : /overflow|out of range/i.test(error.message || '') ? 'ANALYSIS_MODEL_NUMERIC_OVERFLOW' : 'ANALYSIS_MODEL_EXECUTION_FAILED';
    await respond({ protocol: 2, error: { code, message: code === 'ANALYSIS_MODEL_EXECUTION_FAILED' ? '隔离分析执行失败，请检查模型口径或联系维护者。' : code === 'ANALYSIS_MODEL_NUMERIC_OVERFLOW' ? '指标计算超出精度范围，结果未登记；请核对数值规模和口径。' : error.message } });
    process.exitCode = 1;
});
