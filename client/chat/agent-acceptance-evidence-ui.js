(function () {
    const now = () => new Date().toISOString();
    const artifact = (type, generatedAt) => ({ id: `REPLACE_WITH_${type.toUpperCase()}_REPORT_ID`, kind: `${type}_report`, generatedAt, sha256: 'REPLACE_WITH_64_CHAR_ARTIFACT_SHA256' });
    const metrics = requirements => (requirements?.requiredMetrics || []).map(policy => ({ key: policy.key, value: 'REPLACE_WITH_MEASURED_VALUE', threshold: policy.threshold, comparator: policy.comparator, passed: false }));
    function buildManifestTemplate(evidenceType, requirements = {}, generatedAt = now()) {
        const base = { schemaVersion: Number(requirements.schemaVersion) || 1, artifact: artifact(evidenceType, generatedAt) };
        if (evidenceType === 'implementation_review') return { ...base, reviewScope: 'REPLACE_WITH_REVIEW_SCOPE_AT_LEAST_12_CHARS', changeRefs: ['REPLACE_WITH_CONTROLLED_CHANGE_REFERENCE'], commit: 'REPLACE_WITH_COMMIT_SHA', reviewedAt: generatedAt };
        if (evidenceType === 'automated') return { ...base, suite: 'REPLACE_WITH_SUITE', runId: 'REPLACE_WITH_RUN_ID', total: 'REPLACE_WITH_TOTAL', passed: 'REPLACE_WITH_PASSED', failed: 'REPLACE_WITH_FAILED', completedAt: generatedAt, resultRef: 'REPLACE_WITH_CONTROLLED_RESULT_REFERENCE' };
        if (evidenceType === 'nonfunctional') return { ...base, window: { start: 'REPLACE_WITH_WINDOW_START', end: 'REPLACE_WITH_WINDOW_END' }, sampleSize: requirements.minimumObservationSamples || 30, metrics: metrics(requirements), dashboardRef: 'REPLACE_WITH_CONTROLLED_DASHBOARD_REFERENCE' };
        if (evidenceType === 'canary') return { ...base, environment: 'canary', window: { start: 'REPLACE_WITH_WINDOW_START', end: 'REPLACE_WITH_WINDOW_END' }, cohort: 'REPLACE_WITH_CONTROLLED_COHORT', sampleSize: requirements.minimumObservationSamples || 30, fullCycle: false, p0Count: 0, p1Count: 0, metrics: metrics(requirements), rollbackDrillRef: 'REPLACE_WITH_ROLLBACK_DRILL_REFERENCE', operator: 'REPLACE_WITH_OPERATOR' };
        return { ...base, meetingAt: generatedAt, minutesRef: 'REPLACE_WITH_COMMITTEE_MINUTES_REFERENCE', recommendation: 'approve_for_score', signatories: (requirements.committeeRoles || []).map(role => ({ role, signer: `REPLACE_WITH_${role.toUpperCase()}_SIGNER`, signedAt: generatedAt })) };
    }
    window.Pivot?.exposeModule?.('agent.acceptanceEvidence', { buildManifestTemplate });
})();
