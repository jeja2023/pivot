'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'client', 'chat', 'agent-acceptance-evidence-ui.js'), 'utf8');

function loadModule() {
    let api = null;
    vm.runInNewContext(source, { window: { Pivot: { exposeModule: (_name, value) => { api = value; } } }, Date });
    return api;
}

test('acceptance evidence template keeps frozen server thresholds and requires measured values', () => {
    const api = loadModule();
    const manifest = api.buildManifestTemplate('nonfunctional', {
        schemaVersion: 1, minimumObservationSamples: 30,
        requiredMetrics: [{ key: 'trace_correlation_rate', comparator: '>=', threshold: 0.99 }]
    }, '2026-10-18T00:00:00.000Z');
    assert.equal(manifest.sampleSize, 30);
    assert.equal(JSON.stringify(manifest.metrics), JSON.stringify([{ key: 'trace_correlation_rate', value: 'REPLACE_WITH_MEASURED_VALUE', threshold: 0.99, comparator: '>=', passed: false }]));
    assert.equal(manifest.artifact.sha256, 'REPLACE_WITH_64_CHAR_ARTIFACT_SHA256');
    assert.match(manifest.dashboardRef, /^REPLACE_WITH_/);
});

test('committee template requires every frozen role and never fabricates signer identities', () => {
    const api = loadModule();
    const manifest = api.buildManifestTemplate('committee', { committeeRoles: ['platform_security', 'runtime', 'qa_sre', 'product'] }, '2026-10-18T00:00:00.000Z');
    assert.equal(manifest.signatories.length, 4);
    assert.ok(manifest.signatories.every(item => item.signer.startsWith('REPLACE_WITH_')));
    assert.equal(manifest.recommendation, 'approve_for_score');
});
