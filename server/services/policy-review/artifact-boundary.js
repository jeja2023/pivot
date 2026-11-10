'use strict';

function assertGenericAccess(artifact) {
    if (['policy_review_report', 'policy_review_material'].includes(artifact?.type)) throw Object.assign(new Error('请在法规查询的材料审查中查看、修订、导出或撤回此报告及材料。'), { status: 403, code: 'POLICY_REVIEW_APP_REQUIRED' });
}

function filterGenericList(artifacts) {
    return artifacts.filter(artifact => !['policy_review_report', 'policy_review_material'].includes(artifact.type));
}

module.exports = { assertGenericAccess, filterGenericList };
