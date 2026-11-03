'use strict';

// 以固定测试集生成可比较的链路基线；报告只保存计数与退出码，不保存凭据和业务正文。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const GROUPS = {
    unit: ['knowledge-tool-chain', 'knowledge-stream-fencing', 'knowledge-retrieval-faults', 'knowledge-ai-grounding', 'knowledge-retrieval-relevance', 'knowledge-business-fixtures', 'tool-routing-completion', 'agent-discovery-policy', 'agent-discovery-execution-recovery', 'agent-progressive-tool-discovery', 'agent-provider-sse-harness', 'tool-result-flow', 'chat-diagram-verification', 'client-agent-chinese-ui'],
    integration: ['knowledge-chain-postgres', 'knowledge-content', 'knowledge-pdf-coverage', 'knowledge-ingestion-lease-fencing', 'knowledge-sources', 'chat-knowledge-catalog', 'chat-conversation-product', 'agent-full-run-discovery', 'agent-non-idempotent-fault-matrix', 'agent-execution-approval-flow', 'offline-artifact-persistence', 'docx-preview-integration', 'agent-idle-chat-tasks-postgres'],
    browser: ['docx-preview-browser', 'knowledge-task-detail-browser']
};

async function runGroup(group) {
    const files = GROUPS[group].map(name => `tests/${name}.test.js`);
    files.forEach(file => { if (!fs.existsSync(path.join(root, file))) throw new Error(`测试文件缺失：${file}`); });
    if (group === 'integration' && !process.env.TEST_DATABASE_URL) return { group, status: 'not_run', reason: '需要显式配置独立测试数据库 TEST_DATABASE_URL', files };
    const args = group === 'integration' ? ['scripts/run_node_tests.js', ...files] : ['--test', '--test-timeout=120000', '--test-concurrency=1', ...files];
    const start = Date.now();
    return await new Promise(resolve => {
        const env = { ...process.env };
        if (group !== 'integration') { delete env.DATABASE_URL; delete env.TEST_DATABASE_URL; }
        const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let summary = '';
        const receive = chunk => { summary = (summary + chunk.toString()).slice(-100000); };
        child.stdout.on('data', receive);
        child.stderr.on('data', receive);
        child.on('error', () => resolve({ group, status: 'failed', reason: '测试进程无法启动', files }));
        child.on('exit', code => {
            const count = key => Number(summary.match(new RegExp(`(?:ℹ |# )${key} (\\d+)`))?.[1] || 0);
            resolve({ group, status: code === 0 ? 'passed' : 'failed', exitCode: code, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), durationMs: Date.now() - start, files });
        });
    });
}

async function main(args = process.argv.slice(2)) {
    const selected = args.filter(arg => ['--unit', '--integration', '--browser'].includes(arg)).map(arg => arg.slice(2));
    if (args.includes('--list')) { console.log(JSON.stringify(GROUPS, null, 2)); return; }
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
        productionStatus: 'not_verified', externalServices: { kroki: 'not_verified', onlyoffice: 'not_verified' } };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`验证结果：${reportPath}`);
    if (groups.some(group => group.status !== 'passed')) process.exitCode = 1;
}

if (require.main === module) main().catch(() => { console.error('链路验证无法完成，请核对参数、测试文件和环境。'); process.exitCode = 1; });
module.exports = { GROUPS, main };
