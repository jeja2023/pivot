'use strict';

const { createHash } = require('node:crypto');

const READ_ACTIONS = new Set(['read', 'read_runtime', 'read_history', 'read_images', 'list']);
const PROJECT_INSPECTIONS = new Set(['info', 'validate', 'page-context', 'page-context-report']);
const isInspection = action => READ_ACTIONS.has(action?.action) || action?.action === 'validate_template'
    || action?.action === 'run' && (action.tool === 'check_svg' || action.tool === 'project' && PROJECT_INSPECTIONS.has(action.args?.[0]));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createInspectionProgress(messages) {
    let seen = new Map(), inspectionRounds = 0, repeatedRounds = 0;
    const written = new Map();

    function observe(actions, observations, historical = false) {
        let productive = false;
        observations.forEach((observation, index) => {
            const action = actions[index];
            if (!action || isInspection(action) || action.action !== observation?.action || !observation.result
                || observation.error || observation.result.exitCode) return;
            if (action.action === 'write' && observation.result.sha256) {
                if (written.get(action.path) === observation.result.sha256) return;
                written.set(action.path, observation.result.sha256);
            } else written.clear();
            productive = true;
        });
        if (productive) {
            seen = new Map();
            inspectionRounds = 0;
            repeatedRounds = 0;
            return true;
        }
        let foundNew = false;
        for (const [index, observation] of observations.entries()) {
            const action = actions[index], result = observation?.result;
            if (!isInspection(action) || action.action !== observation?.action || observation.error || !result
                || result.exitCode !== undefined && result.exitCode !== 0) continue;
            let key, end = 1;
            if (action.action === 'read_runtime') {
                key = JSON.stringify(['runtime', result.path || action.path, result.offset ?? action.offset ?? 0]);
                end = result.nextOffset ?? result.totalChars ?? Infinity;
            } else if (action.action === 'read_history') {
                // 旧回读归档后，源归档坐标可能包含在请求中而不在压缩后的回执中。
                key = JSON.stringify(['history', action.archive, action.index, result.offset ?? action.offset ?? 0]);
                end = result.nextOffset ?? result.totalChars ?? Infinity;
            } else if (!result.archived) {
                key = digest([action, result]);
            } else continue;
            if (!seen.has(key) || seen.get(key) < end) {
                seen.set(key, end);
                foundNew = true;
            }
        }
        inspectionRounds++;
        if (!historical) repeatedRounds = foundNew ? 0 : repeatedRounds + 1;
        return foundNew;
    }

    for (let index = 0; index < messages.length - 1; index++) {
        const message = messages[index], reply = messages[index + 1];
        if (message.role !== 'assistant' || reply.role !== 'user') continue;
        let turn, observations;
        try { turn = JSON.parse(message.content); observations = JSON.parse(reply.content); } catch (_) { continue; }
        if (Array.isArray(turn?.actions) && Array.isArray(observations)) observe(turn.actions, observations, true);
    }

    return {
        observe,
        stalled: () => repeatedRounds >= 3,
        guidance() {
            if (inspectionRounds < 6 && !repeatedRounds) return '';
            return '宿主检测到当前阶段反复处于读取和检查。请先利用已获得的结果，避免再次请求相同文件页。仍有必需资料时，成批读取具体未读页。资料齐备时，按流程立即推进到初始化项目、提交用户确认、写入当前阶段文件或校验产物中的适用步骤。缺少关键事实或授权时，提交明确的补充问题。';
        }
    };
}

module.exports = { createInspectionProgress };
