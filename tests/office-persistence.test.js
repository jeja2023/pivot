'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { saveMindmap } = require('../server/services/mindmap');
const { executeOfflineOffice } = require('../server/services/agent-tools-offline-office');

test('脑图编辑写入真实版本，拒绝跨用户编辑，比较修订通过原生产物交付', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const first = await saveMindmap(user, { tree: { id: 'root', text: '计划', children: [] } }, { stepId: 'mindmap-create' });
    assert.equal(first.artifactId, first.mindmapArtifactId);
    const second = await saveMindmap(user, { artifactId: first.mindmapArtifactId, expectedVersionId: first.versionId, tree: { id: 'root', text: '新计划', children: [{ id: 'a', text: '执行' }] } }, { stepId: 'mindmap-update' });
    assert.equal(second.mindmapArtifactId, first.mindmapArtifactId);
    const version = await queryOne('SELECT MAX(version) AS version FROM agent_artifact_versions WHERE artifact_id = ?', [first.mindmapArtifactId]);
    assert.equal(Number(version.version), 2);
    await assert.rejects(saveMindmap({ id: Number(user.id) + 999999 }, { artifactId: first.mindmapArtifactId, tree: first.tree }, { stepId: 'denied' }), /无权/);
    const diff = await executeOfflineOffice('document.compare', { before: '原文', after: '新文' }, user, { stepId: 'compare-test' });
    assert.equal(diff.format, 'docx'); assert.ok(diff.renditionId);
    for (const id of [first.mindmapArtifactId, first.artifactId, second.artifactId, diff.artifactId]) await execute('DELETE FROM agent_artifacts WHERE id = ?', [id]);
});
