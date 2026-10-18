'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { attachWorkingMemoryOutputReference, isWorkingMemoryOutputPartial, serializeWorkingMemoryOutput } = require('../server/services/agent-working-memory-artifacts');
const { stateArtifactReferences } = require('../server/services/agent-working-memory-revisions');

test('Working Memory only carries CAS metadata for context-truncated tool output', () => {
    const compacted = { structuredContent: { rows: [], __partial: true }, text: '预览' };
    assert.equal(isWorkingMemoryOutputPartial(compacted), true);
    const annotated = attachWorkingMemoryOutputReference(compacted, {
        ref: 'artifact-cas://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', digest: 'b'.repeat(64), bytes: 1024
    });
    assert.equal(annotated.rawOutputRef.startsWith('artifact-cas://'), true);
    assert.deepEqual(stateArtifactReferences({ evidence: [{ rawOutputRef: annotated.rawOutputRef }] }), ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    assert.equal(serializeWorkingMemoryOutput({ value: 1 }), '{"value":1}');
});
