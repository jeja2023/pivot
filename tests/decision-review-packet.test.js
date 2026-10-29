'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('审阅包不把失败或无效的预审核动作展示为有效候选', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-review-packet-'));
    try {
        const set = { version: 'v2', cases: [
            { id: 'failed', scenario: 'chat.rag', providerInput: { routingText: '测试' }, candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }] },
            { id: 'invalid', scenario: 'chat.rag', providerInput: { routingText: '测试' }, candidates: [{ id: 'retrieve', allowed: true }] },
            { id: 'valid', scenario: 'chat.rag', providerInput: { routingText: '测试' }, candidates: [{ id: 'retrieve', allowed: true }] }
        ] };
        const report = { kind: 'pivot_decision_pre_review_report', evaluationSetVersion: 'v2', results: [
            { caseId: 'failed', selectedActionId: 'retrieve', error: 'timeout' },
            { caseId: 'invalid', selectedActionId: 'skip' },
            { caseId: 'valid', selectedActionId: 'retrieve' }
        ] };
        const setPath = path.join(root, 'set.json');
        const reportPath = path.join(root, 'report.json');
        const output = path.join(root, 'packet.md');
        fs.writeFileSync(setPath, JSON.stringify(set));
        fs.writeFileSync(reportPath, JSON.stringify(report));
        const run = spawnSync(process.execPath, [path.join(__dirname, '../scripts/generate_decision_review_packet.js'), '--set', setPath, '--report', reportPath, '--output', output], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        const packet = fs.readFileSync(output, 'utf8');
        assert.match(packet, /\| failed \|.*\| 预审核失败 \|/);
        assert.match(packet, /\| invalid \|.*\| 无有效结果 \|/);
        assert.match(packet, /\| valid \|.*\| retrieve \| 待业务管理员填写/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
