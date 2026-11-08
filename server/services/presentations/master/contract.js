'use strict';

const { error } = require('./runtime');
const { normalizeMaterials, sha256 } = require('../presentation-evidence');
const OPERATIONS = ['generate', 'create_template', 'edit_native'];
const PROFILES = ['default', 'quick', 'beautify', 'image_to_pptx'];
function text(value, max, label, required = false) {
    if (value !== undefined && typeof value !== 'string') throw error(label + '必须是文字。');
    const result = String(value || '').trim();
    if (result.length > max || (required && !result)) throw error(label + '为空或过长。');
    return result;
}
function normalize(input = {}) {
    const operation = input.operation || 'generate', profile = input.profile || 'default';
    if (!OPERATIONS.includes(operation) || !PROFILES.includes(profile) || (operation !== 'generate' && profile !== 'default')) throw error('制作流程或生成方式无效。');
    const title = text(input.title, 120, '文稿名称', true), instruction = text(input.instruction, 16000, '制作要求', true);
    const modelId = text(input.modelId === undefined ? input.model : String(input.modelId), 160, '模型标识', true);
    const pageCount = Number(input.pageCount || 8);
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 40) throw error('单次制作请指定一至四十页。');
    if (input.materials !== undefined && (!Array.isArray(input.materials) || input.materials.length > 20)) throw error('最多提供二十份文本材料。');
    if ((input.materials || []).some(material => !material || typeof material.text !== 'string' || material.text.length > 120000)) throw error('每份事实材料须为不超过十二万字的文本，超出时请明确拆分后提交。');
    const materials = normalizeMaterials(input.materials);
    const productionProfile = require('../presentation-production-profile').fromRequest(input);
    let template = null;
    if (input.template !== undefined && input.template !== null) {
        if (!input.template || typeof input.template !== 'object' || Array.isArray(input.template) || !['runtime', 'organization'].includes(input.template.type)) throw error('制作模板类型无效。');
        const id = text(input.template.id, 96, '制作模板标识', true);
        if (input.template.type === 'runtime' && !require('../presentation-template-catalog').runtimeTemplate(id)) throw error('所选引擎模板不属于当前固定发行包。');
        if (input.template.type === 'organization' && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id) || !Number.isSafeInteger(input.template.version) || input.template.version < 1)) throw error('单位模板标识或版本无效。');
        if (operation === 'create_template' || profile !== 'default' || input.template.type === 'runtime' && operation !== 'generate' || input.template.type === 'organization' && operation !== 'edit_native' || input.sourceAssetId) throw error('模板与当前制作流程不匹配，请重新选择制作方式。');
        template = { type: input.template.type, id, ...(input.template.type === 'organization' ? { version: input.template.version } : {}) };
    }
    if (input.sourceAssetId !== undefined && !/^[1-9]\d{0,14}$/.test(String(input.sourceAssetId))) throw error('源文件标识无效。');
    if (input.assetIds !== undefined && (!Array.isArray(input.assetIds) || input.assetIds.length > 20 || input.assetIds.some(id => !/^[1-9]\d{0,14}$/.test(String(id))))) throw error('补充素材标识无效或超过二十个。');
    if (operation === 'edit_native' && !input.sourceAssetId && template?.type !== 'organization') throw error('编辑原稿需要提供已上传的PPTX文件。');
    if (['beautify', 'image_to_pptx'].includes(profile) && !input.sourceAssetId) throw error('美化或图片重建需要提供已上传的源文件。');
    const maxSteps = Number(input.maxSteps || 80), tokenBudget = Number(input.tokenBudget || 400000);
    if (!Number.isInteger(maxSteps) || maxSteps < 5 || maxSteps > 160 || !Number.isInteger(tokenBudget) || tokenBudget < 10000 || tokenBudget > 500000) throw error('执行步骤或模型用量预算无效。');
    return { operation, profile, title, instruction, modelId, pageCount, materials, productionProfile, template, sourceAssetId: input.sourceAssetId ? String(input.sourceAssetId) : '',
        presentationId: text(input.presentationId, 96, '源稿标识'), assetIds: [...new Set((input.assetIds || []).map(String))], maxSteps, tokenBudget,
        sourceDigest: sha256(JSON.stringify({ instruction, materials, sourceAssetId: input.sourceAssetId || '', template, productionProfile })) };
}
module.exports = { normalize };
