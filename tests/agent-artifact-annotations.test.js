'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { createStandaloneArtifact } = require('../server/services/agent-artifacts');
const {
    createAgentArtifactAnnotation,
    listAgentArtifactAnnotations,
    updateAgentArtifactAnnotation
} = require('../server/services/agent-artifact-annotations');

test('artifact annotations are version-scoped, user-scoped, and resolvable', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const artifact = await createStandaloneArtifact(user, { title: `annotation-${process.pid}`, content: '初始内容' });
    try {
        const annotation = await createAgentArtifactAnnotation(artifact.id, user, {
            location: '第 2 页 / 风险表', note: '补充数据来源'
        });
        assert.equal(annotation.status, 'open');
        const listed = await listAgentArtifactAnnotations(artifact.id, user);
        assert.equal(listed.annotations.length, 1);
        assert.equal(listed.annotations[0].target.location, '第 2 页 / 风险表');
        const resolved = await updateAgentArtifactAnnotation(artifact.id, annotation.id, user, { status: 'resolved' });
        assert.equal(resolved.status, 'resolved');
        assert.equal(await listAgentArtifactAnnotations(artifact.id, { id: Number(user.id) + 999999 }), null);
    } finally {
        await execute('DELETE FROM agent_artifacts WHERE id = ?', [artifact.id]);
    }
});
