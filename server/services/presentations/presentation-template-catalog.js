'use strict';

const runtimeTemplates = require('../../../config/ppt-master-templates.json');
const runtime = require('./master/runtime');
const { isAdmin } = require('../../permissions');

function runtimeTemplate(id) { return runtimeTemplates.revision === runtime.lock.revision ? runtimeTemplates.templates.find(item => item.id === id) || null : null; }
function classify(template) {
    const legacy = ['business-blue', 'forest-green'].includes(template.id);
    const system = template.ownerType === 'system';
    return { ...template, catalogGroup: legacy ? 'theme' : system ? 'starter' : 'organization', sourceLabel: system ? '内置' : template.scope === 'private' ? '个人' : '单位',
        recommended: !legacy && system, legacyTheme: legacy, supportedEngines: ['structured', ...(template.sourceAvailable && (template.sourceFormat || template.definition?.importMetadata?.sourceFormat) === 'pptx' ? ['master'] : [])] };
}
async function list(user) {
    const templates = await require('./presentation-service').listPresentationTemplates(user);
    const available = runtime.availability();
    return { engine: available, canManageTemplates: isAdmin(user), defaultMode: 'free', templates: [
        ...templates.map(classify),
        ...runtimeTemplates.templates.map(item => ({ ...item, ownerType: 'engine', scope: 'system', status: 'published', catalogGroup: 'engine', sourceLabel: 'PPT Master', supportedEngines: ['master'], available: available.enabled, aspectRatio: '16:9' }))
    ] };
}
module.exports = { list, classify, runtimeTemplate };
