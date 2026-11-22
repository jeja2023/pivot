'use strict';

function checklistLimits(state) {
    return state.engine?.expandedChecklist === 1 ? { perPage: 24, total: 480 } : { perPage: 8, total: 120 };
}

module.exports = { checklistLimits };
