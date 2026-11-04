'use strict';

// 以固定测试集生成可比较的链路基线；报告只保存计数与退出码，不保存凭据和业务正文。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const GROUPS = {
    unit: ['knowledge-tool-chain', 'knowledge-graph-tool-chain', 'knowledge-workflow-chain', 'knowledge-lineage-access', 'tool-chain-remaining', 'knowledge-benchmark', 'workflow-iteration', 'knowledge-stream-fencing', 'knowledge-retrieval-faults', 'knowledge-ai-grounding', 'knowledge-retrieval-relevance', 'knowledge-business-fixtures', 'tool-routing-completion', 'agent-discovery-policy', 'agent-discovery-execution-recovery', 'agent-progressive-tool-discovery', 'agent-provider-sse-harness', 'tool-result-flow', 'chat-diagram-verification', 'client-agent-chinese-ui'],
    integration: ['knowledge-chain-postgres', 'knowledge-graph-workflow-postgres', 'tool-chain-files-postgres', 'knowledge-content', 'knowledge-pdf-coverage', 'knowledge-ingestion-lease-fencing', 'knowledge-ingestion-jobs', 'knowledge-sources', 'chat-knowledge-catalog', 'chat-conversation-product', 'agent-full-run-discovery', 'agent-non-idempotent-fault-matrix', 'agent-execution-approval-flow', 'offline-artifact-persistence', 'docx-preview-integration', 'onlyoffice-preview', 'chat-task-feed', 'workflow-iteration-persistence', 'agent-idle-chat-tasks-postgres'],
    recovery: ['agent-residency-multiprocess', 'agent-checkpoint-output-recovery', 'agent-control-plane-recovery', 'document-job-recovery', 'agent-browser-network-proxy', 'security-mcp', 'safe-http-status'],
    browser: ['docx-preview-browser', 'knowledge-task-detail-browser', 'tool-chain-quality-browser']
};

async function runGroup(group) {
    const files = GROUPS[group].map(name => `tests/${name}.test.js`);
    files.forEach(file => { if (!fs.existsSync(path.join(root, file))) throw new Error(`测试文件缺失：${file}`); });
    const databaseGroup = ['integration', 'recovery'].includes(group);
    if (databaseGroup && !process.env.TEST_DATABASE_URL) return { group, status: 'not_run', reason: '需要显式配置独立测试数据库 TEST_DATABASE_URL', files };
    const args = databaseGroup ? ['scripts/run_node_tests.js', ...files] : ['--test', '--test-timeout=120000', '--test-concurrency=1', ...files];
    const start = Date.now();
    return await new Promise(resolve => {
        const env = { ...process.env };
        if (!databaseGroup) { delete env.DATABASE_URL; delete env.TEST_DATABASE_URL; }
        const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let summary = '';
        const receive = chunk => { summary = (summary + chunk.toString()).slice(-100000); };
        child.stdout.on('data', receive);
        child.stderr.on('data', receive);
        child.on('error', () => resolve({ group, status: 'failed', reason: '测试进程无法启动', files }));
        child.on('close', code => {
            if (code !== 0) console.error(require('../server/services/diagnostic-redaction').redactDiagnostic(summary.slice(-18000)));
            const count = key => Number(summary.match(new RegExp(`(?:ℹ |# )${key} (\\d+)`))?.[1] || 0);
            resolve({ group, status: code === 0 ? 'passed' : 'failed', exitCode: code, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), durationMs: Date.now() - start, files });
        });
    });
}

async function main(args = process.argv.slice(2)) {
    if (args.includes('--isolated-postgres')) {
        const binIndex = args.indexOf('--pg-bin');
        const childArgs = args.filter((value, index) => value !== '--isolated-postgres' && value !== '--pg-bin' && (binIndex < 0 || index !== binIndex + 1));
        const code = await require('./test_support/isolated_postgres').withIsolatedPostgres(process.execPath,
            ['scripts/verify_tool_knowledge_chain.js', ...childArgs], { bin: binIndex >= 0 ? args[binIndex + 1] : undefined, cwd: root });
        process.exitCode = code; return;
    }
    const selected = args.filter(arg => ['--unit', '--integration', '--recovery', '--browser'].includes(arg)).map(arg => arg.slice(2));
    if (args.includes('--list')) { console.log(JSON.stringify(GROUPS, null, 2)); return; }
    const fingerprint = require('./test_support/chain_source_fingerprint').chainSourceFingerprint;
    const startedSourceFingerprint = fingerprint(root);
    const outputIndex = args.indexOf('--report');
    const reportPath = path.resolve(root, outputIndex >= 0 ? args[outputIndex + 1] || '' : 'output/tool-knowledge-chain/result.json');
    if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--report 需要文件路径。');
    const groups = [];
    for (const group of selected.length ? selected : Object.keys(GROUPS)) {
        console.log(`正在验证：${group}`);
        const result = await runGroup(group);
        groups.push(result);
        console.log(`${group}: ${result.status}，${result.passed || 0} 项通过，${result.failed || 0} 项失败`);
    }
    const report = { schemaVersion: 1, version: require('../package.json').version, createdAt: new Date().toISOString(), groups,
        provenance: { sourceFingerprint: fingerprint(root), startedSourceFingerprint, nodeVersion: process.version, platform: process.platform },
        productionStatus: 'not_verified', externalServices: { kroki: 'not_verified', onlyoffice: 'not_verified' } };
    report.provenance.sourceChangedDuringVerification = report.provenance.sourceFingerprint !== startedSourceFingerprint;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`验证结果：${reportPath}`);
    if (groups.some(group => group.status !== 'passed') || report.provenance.sourceChangedDuringVerification) process.exitCode = 1;
}

if (require.main === module) main().catch(() => { console.error('链路验证无法完成，请核对参数、测试文件和环境。'); process.exitCode = 1; });
module.exports = { GROUPS, main };
