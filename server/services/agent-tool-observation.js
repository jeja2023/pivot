'use strict';

const { attachWorkingMemoryOutputReference, persistWorkingMemoryOutput, isWorkingMemoryOutputPartial } = require('./agent-working-memory-artifacts');
const { recordWorkingObservation } = require('./agent-working-state');

async function prepareToolObservation({ run, user, tool, output, modelCfg, compact }, deps = {}) {
    output = await require('./agent-tool-vision').prepareToolVision(output, user, deps.vision);
    let preview = compact(output, modelCfg);
    if (output?.toolVision) preview = { ...preview, toolVision: output.toolVision };
    if (isWorkingMemoryOutputPartial(preview)) {
        try {
            const reference = await (deps.persistOutput || persistWorkingMemoryOutput)(output, user, { tenantId: run.tenant_id || user.tenant_id || user.tenantId, force: true });
            if (reference) preview = attachWorkingMemoryOutputReference(preview, reference);
        } catch (error) { preview = { ...preview, rawOutputStorageError: String(error.message || '原文存储失败').slice(0, 240) }; }
    }
    const summaries = require('./agent-tool-output-context').observationSummaries(preview);
    const metadata = await (deps.updateMetadata || require('./agent-run-metadata-patch').updateAgentRunMetadataWithRetry)(run.id, current => {
        let state = current.workingState;
        for (const item of summaries) state = recordWorkingObservation(state, {
            tool: item.tool || tool, output: { ...item.output, rawOutputRef: preview?.rawOutputRef, rawOutputDigest: preview?.rawOutputDigest }, summary: item.summary
        }, current.taskContract, run.goal);
        const skillResourceEvidence=['skill.resources','skill.read_resource'].includes(tool)&&output?.reference&&output.packageDigest
            ? {...output.reference,packageDigest:output.packageDigest}:null;
        return { ...current, workingState: state, ...(skillResourceEvidence?{skillResourceEvidence}:{}) };
    }, { userId: user.id });
    if (metadata) {
        run.metadata = metadata;
        await (deps.persistRevision || require('./agent-working-memory-revisions').persistWorkingMemoryRevision)({ run, user,
            state: metadata.workingState, taskContract: metadata.taskContract, reason: 'tool_observation' });
    }
    return preview;
}

module.exports = { prepareToolObservation };
