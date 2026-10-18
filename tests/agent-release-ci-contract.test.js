'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('CI has a dedicated mandatory Agent release-quality gate suite', () => {
    const root = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const command = String(pkg.scripts?.['test:agent:release-gates'] || '');
    assert.match(command, /agent-evaluation-gates\.test\.js/);
    assert.match(command, /agent-judge-governance\.test\.js/);
    assert.match(command, /agent-workflow-breaker\.test\.js/);
    assert.match(command, /agent-postgres-integration\.test\.js/);
    assert.match(command, /agent-run-evidence-routes-http\.test\.js/);
    assert.match(workflow, /Agent release quality gates/);
    assert.match(workflow, /npm run test:agent:release-gates/);
});

test('CI runs a dedicated cross-process resource and recovery gate', () => {
    const root = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const command = String(pkg.scripts?.['test:agent:quality'] || '');
    assert.match(command, /agent-task-resource-multiprocess\.test\.js/);
    assert.match(command, /agent-non-idempotent-fault-matrix\.test\.js/);
    assert.match(command, /agent-checkpoint-boundaries\.test\.js/);
    assert.match(command, /agent-task-transactions-persistence\.test\.js/);
    assert.match(command, /agent-control\.test\.js/);
    assert.match(command, /agent-browser-sessions\.test\.js/);
    assert.match(command, /agent-browser-session-leases\.test\.js/);
    assert.match(command, /agent-monitoring-slo\.test\.js/);
    assert.match(workflow, /Agent runtime fault and resource gates/);
    assert.match(workflow, /npm run test:agent:quality/);
});
