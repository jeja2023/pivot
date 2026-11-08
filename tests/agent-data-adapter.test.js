const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const { createWorkspaceJail } = require('../server/services/agent-sandbox');
const { queryDataSource } = require('../server/services/agent-data-adapter');
const { withAnalysisSlot } = require('../server/services/data-analysis/shared');
const { queryOne, execute } = require('../server/db/client');
const XLSX = require('@e965/xlsx');

async function withAdapterActor(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const user = await queryOne("INSERT INTO users(username,password_hash,status) VALUES (?,'hash','active') RETURNING id", [`adapter_${crypto.randomUUID()}`]);
    try {
        // 适配器由已认证任务调用，沿用外层统一预算，不伪造匿名执行账号。
        const result = await withAnalysisSlot(() => run(user), { userId: user.id });
        const job = await queryOne('SELECT status,execution_kind FROM analysis_query_jobs WHERE user_id=?', [user.id]);
        assert.equal(job.status, 'succeeded'); assert.equal(job.execution_kind, 'legacy_operation');
        assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots s JOIN analysis_query_jobs q ON q.id=s.job_id WHERE q.user_id=?', [user.id])).n), 0);
        return result;
    } finally {
        await execute('DELETE FROM analysis_query_jobs WHERE user_id=?', [user.id]);
        await execute('DELETE FROM users WHERE id=?', [user.id]);
    }
}

test('DuckDB data adapter reads CSV through a workspace jail and bounded query', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-data-'));
    const jail = createWorkspaceJail(root, 'task-data');
    const csv = jail.resolve('input.csv');
    fs.writeFileSync(csv, 'name,amount\nAlice,1\nBob,2\n', 'utf8');
    try {
        await assert.rejects(queryDataSource(csv, { autonomous: true, jail, limit: 1 }), error => error.code === 'ANALYSIS_ACTOR_REQUIRED');
        const result = await withAdapterActor(() => queryDataSource(csv, { autonomous: true, jail, limit: 1, where: "c_2 = '2'" }));
        assert.equal(result.source.kind, 'csv');
        assert.equal(result.rows.length, 1);
        assert.equal(String(result.rows[0].c_1), 'Bob');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('autonomous data adapter refuses unjailed sources and unsafe filters', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-data-'));
    const csv = path.join(root, 'input.csv');
    fs.writeFileSync(csv, 'name,amount\nAlice,1\n', 'utf8');
    try {
        await assert.rejects(() => queryDataSource(csv, { autonomous: true }), /工作区沙箱/);
        await assert.rejects(() => queryDataSource(csv, { where: 'amount; DROP TABLE data' }), /不允许/);
        await assert.rejects(() => queryDataSource(csv, { where: "c_1 = (SELECT content FROM read_csv('/etc/passwd'))" }), /不允许/);
        await assert.rejects(() => queryDataSource(csv, { filters: [{ column: 'c_1', op: '= OR 1=', value: 'x' }] }), /无效/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('DuckDB data adapter materializes Excel through the spreadsheet path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-xlsx-'));
    const jail = createWorkspaceJail(root, 'task-xlsx');
    const xlsxPath = jail.resolve('input.xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['name', 'amount'], ['Alice', 1], ['Bob', 2]]), 'Sheet1');
    XLSX.writeFile(workbook, xlsxPath);
    try {
        const result = await withAdapterActor(() => queryDataSource(xlsxPath, { autonomous: true, jail, limit: 2 }));
        assert.equal(result.source.kind, 'xlsx');
        assert.equal(result.rows.length, 2);
        assert.equal(result.rows[0].c_1, 'Alice');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
