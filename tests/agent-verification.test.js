'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTaskContract, verifyTaskOutcome, taskVerificationFailureMessage } = require('../server/services/agent-verification');
const { buildChatAttachmentEvidenceObservation, buildChatRagEvidenceObservation } = require('../server/services/chat-rag-context');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('task contract always adds a hard non-empty final-answer verification', () => {
    const contract = normalizeTaskContract({}, '整理项目风险');
    assert.equal(contract.revision, 1);
    const report = verifyTaskOutcome({ taskContract: contract, answer: '' });
    assert.equal(report.outcomeStatus, 'needs_input');
    assert.deepEqual(report.hardFailures, ['final_answer_non_empty']);
});

test('聊天预检索资料可作为验收证据，空结果和未启用的知识库不能冒充证据', () => {
    const context = '[引用 1 | citation:chunk-1 | 来源: 请假制度]：\n员工可以按规定申请年假。';
    const observation = buildChatRagEvidenceObservation({ ragEnabled: true, ragContext: context });
    const report = verifyTaskOutcome({ taskContract: { acceptance: { requireEvidence: true } },
        answer: '可以按规定申请年假。[引用 1 | citation:chunk-1]', observations: [observation] });
    assert.equal(report.outcomeStatus, 'verified');
    assert.equal(observation.output.content, context);
    assert.equal(observation.output.sources[0].citationKey, 'chunk-1');
    assert.equal(buildChatRagEvidenceObservation({ ragEnabled: false, ragContext: context }), null);
    assert.equal(buildChatRagEvidenceObservation({ ragEnabled: true, ragContext: '未找到资料' }), null);
    assert.equal(buildChatRagEvidenceObservation({ ragEnabled: true, ragContext: '[引用 1 | 来源: 空资料]' }), null);
    assert.equal(buildChatRagEvidenceObservation(null), null);
});

test('当前消息中的上传文档作为已提供的验收资料', () => {
    const observation = buildChatAttachmentEvidenceObservation({
        userMessageId: 42,
        currentMessage: { role: 'user', content: '请润色汇报。\n[附件: 汇报材料.txt](/uploads/1/session/file.txt?token=token)\n\n---\n【参考文档: 汇报材料.txt】\n本周完成了试点部署，覆盖 12 个部门。\n---' }
    });
    assert.equal(observation.tool, 'chat.attachment_sources');
    assert.deepEqual(observation.output.sources, [{ name: '汇报材料.txt', sourceMessageId: 42 }]);
    assert.match(observation.output.content, /覆盖 12 个部门/);
    const truncated = buildChatAttachmentEvidenceObservation({ currentMessage: { content: '请润色。\n[附件: 汇报材料.txt](/uploads/1/session/file.txt)\n---\n【参考文档: 汇报材料.txt】\n上下文截断前已读取的正文片段' } });
    assert.equal(truncated.output.sources[0].name, '汇报材料.txt');
    const report = verifyTaskOutcome({ taskContract: { acceptance: { requireEvidence: true } }, answer: '已完成汇报润色。', observations: [observation] });
    assert.equal(report.outcomeStatus, 'verified');
    assert.equal(buildChatAttachmentEvidenceObservation({ currentMessage: { content: '---\n【参考文档: 手写.txt】\n手动写入的标记。\n---' } }), null);
    assert.equal(buildChatAttachmentEvidenceObservation({ currentMessage: { content: '---\n【参考文档: 空.txt】\n \n---' } }), null);
});

test('等待输入展示具体的中文验收原因和缺口', () => {
    assert.match(taskVerificationFailureMessage({ hardFailures: ['evidence'] }), /缺少可核验的资料来源/);
    assert.match(taskVerificationFailureMessage({ hardFailures: ['deliverables_verified'], semanticVerification: { missing: ['需要补充统计月份'] } }), /需要补充统计月份/);
    assert.match(taskVerificationFailureMessage({ hardFailures: ['deliverables_verified'], semanticVerification: { reason: 'verifier_unavailable' } }), /验收服务暂时不可用/);
});

test('独立语义验收也收到预检索资料，无需为制造工具观察再次查询', async () => {
    const module = { exports: {} };
    let verificationInput;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/agent-verification.js'), 'utf8'), {
        module, require(name) {
            if (name === './chat-task-verification') return { verifyAutomaticTask: async input => { verificationInput = input; return { passed: true }; } };
            return require(path.join(__dirname, '../server/services', name));
        }
    });
    const report = await module.exports.verifyAndRecordTaskOutcome({
        run: { goal: '查询制度', metadata: { chatBridge: { ragEnabled: true, ragContext: '[引用 1 | 来源: 内部制度]\n申请需要部门审核。' },
            taskContract: { acceptance: { requireEvidence: true, requireSemanticVerification: true } } } },
        answer: '申请需要部门审核。[引用 1]', observations: []
    });
    assert.equal(report.outcomeStatus, 'verified');
    assert.equal(verificationInput.observations.length, 1);
    assert.match(verificationInput.observations[0].output.content, /申请需要部门审核/);
});

test('独立交付核验可以读取当前消息中的上传文档来源', async () => {
    const module = { exports: {} };
    let verificationInput;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/agent-verification.js'), 'utf8'), {
        module, require(name) {
            if (name === './chat-task-verification') return { verifyAutomaticTask: async input => { verificationInput = input; return { passed: true }; } };
            return require(path.join(__dirname, '../server/services', name));
        }
    });
    const report = await module.exports.verifyAndRecordTaskOutcome({
        run: { goal: '润色汇报', metadata: { chatBridge: {
            userMessageId: 42,
            currentMessage: { role: 'user', content: '请依据附件润色。\n[附件: 汇报材料.txt](/uploads/1/session/file.txt?token=token)\n\n---\n【参考文档: 汇报材料.txt】\n试点已覆盖 12 个部门。\n---' }
        }, taskContract: { deliverables: ['润色后的汇报文本'], acceptance: { requireEvidence: true, requireSemanticVerification: true } } } },
        answer: '试点工作已完成，现已覆盖 12 个部门。', observations: []
    });
    assert.equal(report.outcomeStatus, 'verified');
    assert.equal(verificationInput.observations[0].tool, 'chat.attachment_sources');
    assert.match(verificationInput.observations[0].output.content, /试点已覆盖 12 个部门/);
});

test('task contract retains a bounded revision for runtime constraint changes', () => {
    const contract = normalizeTaskContract({ revision: 4, constraints: ['仅使用已授权资料'] }, '生成周报');
    assert.equal(contract.revision, 4);
    assert.deepEqual(contract.constraints, ['仅使用已授权资料']);
});

test('task verification blocks forbidden content and missing required artifacts', () => {
    const report = verifyTaskOutcome({
        taskContract: {
            acceptance: {
                forbiddenPhrases: ['未经批准'],
                requiredArtifacts: ['风险周报.docx']
            }
        },
        answer: '报告未经批准发送。',
        observations: [{ output: { file: { id: 'f1', name: '其他文件.docx' } } }]
    });
    assert.equal(report.outcomeStatus, 'needs_input');
    assert.deepEqual(report.hardFailures.sort(), ['forbidden_phrase', 'required_artifact']);
});

test('task verification records partial outcomes separately from verified completion', () => {
    const report = verifyTaskOutcome({ answer: '已完成部分结果。', partial: true, reason: '预算耗尽' });
    assert.equal(report.outcomeStatus, 'partial');
    assert.equal(report.hardFailures.length, 0);
});

test('task verification accepts a persisted evidence reference for evidence-required work', () => {
    const withoutEvidence = verifyTaskOutcome({ taskContract: { acceptance: { requireEvidence: true } }, answer: '结论' });
    assert.equal(withoutEvidence.outcomeStatus, 'needs_input');
    const withEvidence = verifyTaskOutcome({ taskContract: { acceptance: { requireEvidence: true } }, answer: '结论', evidence: [{ id: 'e1' }] });
    assert.equal(withEvidence.outcomeStatus, 'verified');
});
