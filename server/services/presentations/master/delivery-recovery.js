'use strict';

const { error } = require('./runtime');
const { requireChecks, recordCheck } = require('./tool-checks');
const { boundedObservation } = require('./observations');

const staleExport = '最终文件与最近成功的上游导出或当前源稿不一致';
function isStaleExport(reason) {
    return String(reason || '').startsWith(staleExport);
}

async function deliverWithRecovery(state, delivery, execute, hooks, { reexport = true } = {}) {
    const deliver = async () => {
        try { return await execute(delivery); }
        catch (failure) {
            if (delivery.action !== 'deliver' || state.engine?.optionalSourcePackage !== 1
                || !['PPT_SERVICE_TIMEOUT', 'CAPABILITY_WORKER_TIMEOUT'].includes(failure.code)) throw failure;
            await hooks.ensureCurrent();
            await hooks.checkpoint(state, { phase: 'delivery_review', message: '交付等待超时，正在单独核验并登记 PPTX。' });
            return execute({ ...delivery, skipSourcePackage: true });
        }
    };
    try {
        return await deliver();
    } catch (failure) {
        if (delivery.action !== 'deliver' || failure.code !== 'PPT_MASTER_OPERATION_FAILED' || !isStaleExport(failure.message)) throw failure;
        const last = state.lastExport;
        const remember = () => state.messages.push({ role: 'user', content: JSON.stringify({
            deliveryRecovery: '当前导出回执已失效。请核对已批准项目及源稿，重新校验和导出后，再提交本次实际生成的 PPTX。'
        }) });
        if (!reexport || state.deliveryRetryAttempted || last?.path !== delivery.path || !last.args?.length) {
            remember();
            throw failure;
        }
        const [project] = last.args;
        const quick = last.args.includes('--quick-generate'), native = last.args.includes('--roundtrip');
        state.deliveryRetryAttempted = true;
        remember();
        await hooks.checkpoint(state, { phase: 'delivery_review', message: '导出回执已失效，正在复检并重新导出当前项目。' });
        const check = { action: 'run', tool: 'check_svg', args: [project, ...(native ? ['--roundtrip']
            : [...(quick ? ['--quick-generate'] : []), '--canonical-authoring', '--stage', 'final']), '--json'] };
        const run = async (action, label) => {
            await hooks.ensureCurrent();
            const result = await execute(action);
            recordCheck(state, action, result);
            if (result.exitCode !== 0) {
                state.messages.push({ role: 'user', content: JSON.stringify({ deliveryCheck: action.tool, result: boundedObservation(action, result) }) });
                throw error(label, 'PPT_MASTER_DELIVERY_REEXPORT_FAILED', 422);
            }
            return result;
        };
        await run(check, '复检未通过。已保存诊断，请修正当前源稿后继续。');
        if (!quick && !native) await run({ action: 'run', tool: 'finalize', args: [project] }, '源稿后处理失败。请核对错误后继续。');
        requireChecks(state, project, [], { exportArgs: last.args });
        const output = await run({ action: 'run', tool: 'export', args: last.args }, '重新导出失败。请核对导出参数和源稿后继续。');
        if (output.progressExport !== delivery.path) throw error('重新导出未取得原目标文件的有效回执，请核对导出文件后继续。', 'PPT_MASTER_DELIVERY_REEXPORT_FAILED', 422);
        await hooks.ensureCurrent();
        return deliver();
    }
}

module.exports = { deliverWithRecovery, isStaleExport };
