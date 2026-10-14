const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('法规质量治理队列仅面向管理员，并与当前版本、引用和定位状态保持一致', () => {
    const catalog = read('server/services/regulations/catalog.js');
    const route = read('server/routes/apps/regulations/documents.js');
    const governance = read('server/services/regulations/governance.js');
    const actions = read('client/chat/regulations/actions-governance.js');
    const base = read('client/chat/regulations/render-base.js');
    const events = read('client/chat/regulations/events.js');

    assert.match(catalog, /governancePending = false/);
    assert.match(catalog, /v\.id IS NULL OR v\.effect_status = 'unverified'/);
    assert.match(catalog, /\['metadata', 'maintainer', 'version', 'index', 'location'\]/);
    assert.match(catalog, /SELECT COUNT\(\*\) AS count\s+FROM regulation_documents d\s+LEFT JOIN regulation_versions v ON v\.id = d\.current_version_id/);
    assert.match(route, /const governancePending = req\.query\.governancePending === 'true'/);
    assert.match(route, /if \(\(governancePending \|\| governanceScope\) && !requireRegulationsAdmin\(req, res\)\) return;/);
    assert.match(route, /router\.get\('\/citation-governance'/);
    assert.match(route, /rebuild-locations/);
    assert.match(governance, /FROM regulation_documents d\s+LEFT JOIN regulation_versions v ON v\.id = d\.current_version_id/);
    assert.match(actions, /async function openGovernanceWorklist\(scope/);
    assert.match(actions, /async function showCitationGovernance\(type/);
    assert.match(actions, /data-regulation-governance-worklist/);
    assert.match(base, /function isRegulationGovernancePending/);
    assert.match(base, /data-regulation-governance-document/);
    assert.match(events, /openGovernanceWorklist\(event\.target\.closest\('\[data-regulation-governance-worklist\]'\)\.dataset\.regulationGovernanceWorklist/);
    assert.match(events, /openVersionGovernance\(/);
});
