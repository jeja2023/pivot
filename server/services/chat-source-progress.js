'use strict';

function hasReadRequiredSources(metadata = {}) {
    const required = metadata.requiredSourceMessages?.length ? metadata.requiredSourceMessages : [metadata.chatBridge?.userMessageId].filter(Boolean);
    if (!required.length) return false;
    return required.every(messageId => {
        const progress = metadata.sourceReadProgress?.[String(messageId)] || {};
        let coveredTo = 0;
        for (const range of (progress.ranges || []).slice().sort((left, right) => left[0] - right[0])) {
            if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] < range[0]) return false;
            if (range[0] > coveredTo) break;
            coveredTo = Math.max(coveredTo, range[1]);
        }
        return Number(progress.totalChars) > 0 && coveredTo >= Number(progress.totalChars);
    });
}

module.exports = { hasReadRequiredSources };
