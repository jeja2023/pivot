'use strict';

const { digest, invalid } = require('./policy-review/contract');

function definitions() {
    return [{ name: 'policy.review_report', title: '制度材料审查与Word报告', capabilities: ['document.render', 'model.invoke'],
        idempotent: true, side_effect: true, concurrency: 'write', cancellable: true,
        description: '按业务日期选取已复核有效的制度版本，逐条对照待审材料，保留双方原文与待核实项，生成可编辑Word初审报告。start创建持久任务，status读取进度和结果，resume明确续跑未完成批次，cancel停止，export导出已保存版本并挂载任务文件。start登记成功不是审查或文件交付完成；只有export返回真实renditionId才有Word文件。制度来自法规库documentIds，最多三份；材料为一至四份完整文本或已上传materialIds。原文引述匹配不证明结论已由人工核验。',
        input_schema: { type: 'object', additionalProperties: false, properties: {
            operation: { type: 'string', enum: ['start', 'status', 'resume', 'cancel', 'export'], default: 'start' },
            taskId: { type: 'string', maxLength: 100 }, title: { type: 'string', maxLength: 100 }, asOf: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            documentIds: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer', minimum: 1 } }, scope: { type: 'string', maxLength: 1500 },
            materials: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 160 }, text: { type: 'string', maxLength: 60000 } }, required: ['text'] } },
            materialIds: { type: 'array', maxItems: 4, items: { type: 'integer', minimum: 1 } }, modelId: { type: 'string', maxLength: 160 }, version: { type: 'integer', minimum: 1 }
        } } }];
}

async function execute(input, user, context = {}) {
    context.signal?.throwIfAborted();
    const runtime = require('./policy-review/runtime'), operation = input.operation || 'start';
    if (operation === 'start') {
        const requestKey = digest([user.id, context.run?.id || context.runId || context.stepId || '', input]);
        return { task: await runtime.start(user, { ...input, requestKey, modelId: input.modelId || context.run?.chosen_model_id || context.run?.model_id }, context),
            text: '审查任务已登记，请读取实际进度；尚未生成Word交付文件。' };
    }
    if (typeof input.taskId !== 'string' || !/^policy_review_[a-f0-9]{40}$/.test(input.taskId)) throw invalid('请提供本次真实审查任务标识。');
    if (operation === 'export') return require('./policy-review/delivery').exportReport(user, input.taskId, input.version, context);
    const task = operation === 'resume' ? await runtime.resume(user, input.taskId) : operation === 'cancel' ? await runtime.cancel(user, input.taskId) : await runtime.get(user, input.taskId);
    if (!task) throw invalid('审查任务不存在或无权访问。', 404);
    return { task, text: task.status === 'completed' ? '本次逐条初审已结束，请核对结论和待核实项；需要Word文件时再导出当前版本。' : '任务当前状态已返回，不能把进度登记当作交付完成。' };
}

module.exports = { definitions, execute };
