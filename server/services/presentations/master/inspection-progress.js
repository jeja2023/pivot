'use strict';

const { createHash } = require('node:crypto');
const { confirmedWrite, failedObservation, observationLocation } = require('./observations');

const READ_ACTIONS = new Set(['read', 'read_runtime', 'read_history', 'read_images', 'list']);
const PROJECT_INSPECTIONS = new Set(['info', 'validate', 'page-context', 'page-context-report']);
const LOOKUP_TOOLS = new Set(['chart_recall', 'visualization_recall', 'chart_calculator']);
const MAX_RESTORATIONS_PER_PAGE = 2;
const isInspection = action => READ_ACTIONS.has(action?.action) || action?.action === 'validate_template'
    || action?.action === 'run' && (action.tool === 'check_svg' || LOOKUP_TOOLS.has(action.tool)
        || action.tool === 'project' && PROJECT_INSPECTIONS.has(action.args?.[0]));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createInspectionProgress(messages, phaseFrom = 0) {
    const seen = new Map();
    const known = new Map();
    const restorations = new Map();
    const written = new Map();
    let visibleMessages, inspectionRounds = 0, repeatedRounds = 0, failedRounds = 0;

    function observe(actions, observations, historical = false) {
        let productive = false, failed = false, repeated;
        for (const [index, observation] of observations.entries()) {
            const action = actions[index];
            if (!action || action.action !== observation?.action) continue;
            if (failedObservation(observation)) { failed = true; continue; }
            if (isInspection(action) || !observation.result) continue;
            if (action.action === 'write') {
                const receipt = confirmedWrite(action, observation);
                if (!receipt) continue;
                if (written.get(action.path) === receipt.sha256) {
                    repeated = observationLocation(action, observation);
                    continue;
                }
                written.set(action.path, receipt.sha256);
            } else written.clear();
            productive = true;
        }
        if (productive) {
            seen.clear();
            if (!historical) {
                inspectionRounds = repeatedRounds = failedRounds = 0;
                known.clear();
                restorations.clear();
            }
            return { progressed: true, productive };
        }
        let foundNew = false;
        for (const [index, observation] of observations.entries()) {
            const action = actions[index], result = observation?.result;
            if (!isInspection(action) || action.action !== observation?.action || failedObservation(observation) || !result || result.archived
                || result.exitCode !== undefined && result.exitCode !== 0) continue;
            let key, end = 1;
            if (action.action === 'read_runtime') {
                key = JSON.stringify(['runtime', result.path || action.path, result.offset ?? action.offset ?? 0]);
                end = result.nextOffset ?? result.totalChars ?? Infinity;
            } else if (action.action === 'read_history') {
                key = JSON.stringify(['history', action.archive, action.index, result.offset ?? action.offset ?? 0]);
                end = result.nextOffset ?? result.totalChars ?? Infinity;
            } else if (action.action === 'read') {
                key = digest(['read', result.path || action.path, result.offset ?? action.offset ?? 0, result.nextOffset, result.text]);
            } else {
                key = digest([action.action === 'list' ? action.action : action, result]);
            }
            if (!seen.has(key) || seen.get(key) < end) {
                seen.set(key, end);
                if (historical) continue;
                if (known.has(key) && known.get(key) >= end) {
                    // 正文重新可见时允许推进，但反复归档和回读同一页不能一直充作新资料。
                    const count = (restorations.get(key) || 0) + 1;
                    restorations.set(key, count);
                    if (count > MAX_RESTORATIONS_PER_PAGE) {
                        repeated = observationLocation(action, observation);
                        continue;
                    }
                } else {
                    known.set(key, end);
                    restorations.delete(key);
                }
                foundNew = true;
            } else repeated = observationLocation(action, observation);
        }
        if (!historical) {
            inspectionRounds++;
            failedRounds = failed ? failedRounds + 1 : 0;
            repeatedRounds = failed || foundNew ? 0 : repeatedRounds + 1;
        }
        return { progressed: foundNew, productive, failed, repeated };
    }

    function syncVisibleObservations(current) {
        if (current === visibleMessages) return;
        visibleMessages = current;
        seen.clear();
        written.clear();
        // 归档会替换消息数组。重新核对仍可见的结果，保留当前运行的连续轮次。
        for (let index = Math.max(0, phaseFrom); index < current.length - 1; index++) {
            const message = current[index], reply = current[index + 1];
            if (message.role !== 'assistant' || reply.role !== 'user') continue;
            let turn, observations;
            try { turn = JSON.parse(message.content); observations = JSON.parse(reply.content); } catch (_) { continue; }
            if (Array.isArray(turn?.actions) && Array.isArray(observations)) observe(turn.actions, observations, true);
        }
        for (const [key, end] of seen) known.set(key, Math.max(known.get(key) ?? 0, end));
    }

    syncVisibleObservations(messages);
    return {
        evaluate: observe,
        syncVisibleObservations,
        stalled: () => repeatedRounds >= 3,
        failed: () => failedRounds >= 3,
        guidance() {
            if (failedRounds) return '最近的制作操作执行失败。请根据工具回执修正参数或文件后重试；若缺少事实、文件或能力，请提出明确的补充问题。';
            if (inspectionRounds < 6 && !repeatedRounds) return '';
            return '宿主检测到当前阶段反复处于读取和检查。请先利用已获得的结果，避免再次请求相同文件页。仍有必需资料时，成批读取具体未读页。资料齐备时，完成当前阶段清单、写入源稿或执行产物校验。缺少关键事实或授权时，提交明确的补充问题。';
        }
    };
}

module.exports = { createInspectionProgress, isInspection };
