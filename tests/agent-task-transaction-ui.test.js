'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('事务面板禁止对执行中或结果不明的外部动作重试及回滚', () => {
    const context = { agentEscape: value => String(value), agentEscapeAttr: value => String(value) };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-run-status-views.js'), 'utf8'), context);
    for (const status of ['executing', 'failed']) {
        const html = context.renderAgentTaskTransaction({ id: 'tx', status: 'awaiting_commit', effects: [{ status, commitMode: 'after_verify' }] });
        assert.match(html, /人工核对外部状态/);
        assert.doesNotMatch(html, /data-agent-transaction-commit=/);
        assert.doesNotMatch(html, /data-agent-transaction-rollback=/);
    }
    const irreversible = context.renderAgentTaskTransaction({ id: 'tx', status: 'awaiting_commit', effects: [{ status: 'committed', commitMode: 'after_verify', compensation: { mode: 'none', required: false } }] });
    assert.match(irreversible, /不能自动回滚/);
    assert.match(irreversible, /data-agent-transaction-commit=/);
    assert.doesNotMatch(irreversible, /data-agent-transaction-rollback=/);
    const staged = context.renderAgentTaskTransaction({ id: 'tx', status: 'awaiting_commit', effects: [{ status: 'staged', commitMode: 'after_verify' }] });
    assert.match(staged, /data-agent-transaction-commit=/);
    assert.match(staged, /data-agent-transaction-rollback=/);
    const cancelled = context.renderAgentTaskTransaction({ id: 'tx', status: 'awaiting_commit', effects: [{ status: 'staged', commitMode: 'after_verify' }] }, 'cancelled');
    assert.match(cancelled, /不能提交外部动作/);
    assert.doesNotMatch(cancelled, /data-agent-transaction-commit=/);
    assert.match(cancelled, /data-agent-transaction-rollback=/);
    const conflicts = context.renderAgentTaskTransaction({ id: 'tx', status: 'awaiting_commit', effects: [],
        resourceConflicts: [{ status: 'open', resourceKey: '受控资源' }],
        resourceLeases: [{ expiresAt: '2000-01-01T00:00:00Z', releasedAt: null }] });
    assert.match(conflicts, /租约到期不代表副作用已完成/);
    assert.match(conflicts, /<dt>资源租约<\/dt><dd[^>]*>0<\/dd>/);
});

test('等待提交的任务不显示停止或继续执行类操作', () => {
    const context = { agentEscape: value => String(value), document: { addEventListener: () => {} }, window: { Pivot: { legacy: {} } } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-run-detail.js'), 'utf8'), context);
    const pending = context.agentRunActionMarkup({ id: 'run', status: 'awaiting_commit' }, { canCancel: true, isActive: true });
    assert.doesNotMatch(pending, /data-agent-cancel|data-agent-steer|data-agent-delegate-batch/);
    const running = context.agentRunActionMarkup({ id: 'run', status: 'running' }, { canCancel: true, isActive: true });
    assert.match(running, /data-agent-cancel/);
});

test('浏览器恢复提示先核对旧执行器和写入结果', () => {
    const context = { agentEscape: value => String(value), agentEscapeAttr: value => String(value) };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-run-status-views.js'), 'utf8'), context);
    const flagged = context.renderAgentBrowserActionEvidence([], [{ id: 'browser', status: 'needs_user_recovery', mutationPendingRecovery: true }]);
    assert.match(flagged, /确认旧执行器已停止并核对外部写入结果/);
    assert.match(flagged, /data-agent-browser-recover=/);
    assert.doesNotMatch(flagged, /data-agent-browser-close=/);
    const unflagged = context.renderAgentBrowserActionEvidence([], [{ id: 'browser', status: 'needs_user_recovery', mutationPendingRecovery: false }]);
    assert.match(unflagged, /data-agent-browser-close=/);
});
