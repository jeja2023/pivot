const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

test('mobile approval actions retain the same server authority and provide touch-sized decisions', () => {
    const detail = read('client/chat/agent-run-detail.js');
    const css = read('client/chat/styles/workspaces/agent/agent-run-detail.css');
    const controlPlane = read('server/services/agent-approval-requests.js');

    assert.match(detail, /data-agent-approve>同意放行/);
    assert.match(detail, /data-agent-reject>拒绝执行/);
    assert.match(detail, /approveAgentRun\(run\.id, true\)/);
    assert.match(detail, /approveAgentRun\(run\.id, false\)/);
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.agent-run-approval-actions/);
    assert.match(css, /\.agent-run-approval-actions \.btn-primary[\s\S]*?min-height:\s*42px/);
    assert.match(css, /touch-action:\s*manipulation/);
    assert.match(controlPlane, /decideWorkflowApprovalRequest/);
});
