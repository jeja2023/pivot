'use strict';

const { normalizeProductionProfile } = require('./presentation-semantics');
function fromRequest(body = {}) {
    if (body.productionProfile !== undefined) return normalizeProductionProfile(body.productionProfile);
    if (body.presentation?.metadata?.productionProfile) return normalizeProductionProfile(body.presentation.metadata.productionProfile);
    const minutes = typeof body.duration === 'number' ? body.duration : typeof body.duration === 'string' && /^\d+(?:\.\d+)?\s*(?:分钟|min)?$/.test(body.duration.trim()) ? Number.parseFloat(body.duration) : 0;
    return normalizeProductionProfile({ audience: body.audience || '', purpose: body.purpose || '', consumptionMode: body.consumptionMode || 'presentation', targetDurationSeconds: minutes * 60 });
}
function prompt(profile) {
    return '整稿制作目标：' + JSON.stringify(normalizeProductionProfile(profile || {})) + '。据此安排内容深度、逐页职责与讲解时间；目标不授予额外工具或数据权限。';
}
module.exports = { fromRequest, prompt };
