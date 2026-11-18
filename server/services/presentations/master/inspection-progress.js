'use strict';

const { createHash } = require('node:crypto');

const READ_ACTIONS = new Set(['read', 'read_runtime', 'read_history', 'read_images', 'list']);
const PROJECT_INSPECTIONS = new Set(['info', 'page-context', 'page-context-report']);
const isInspection = action => READ_ACTIONS.has(action?.action) || action?.action === 'run' && action.tool === 'project' && PROJECT_INSPECTIONS.has(action.args?.[0]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createInspectionProgress(messages) {
    let seen = new Map(), inspectionRounds = 0, repeatedRounds = 0;

    function observe(actions, observations, historical = false) {
        if (!actions.length || !actions.every(isInspection)) {
            seen = new Map();
            inspectionRounds = 0;
            repeatedRounds = 0;
            return;
        }
        let foundNew = false;
        for (const [index, observation] of observations.entries()) {
            const action = actions[index], result = observation?.result;
            if (!action || action.action !== observation?.action) continue;
            let key, end = 1;
            if (result && !observation.error && action.action === 'read_runtime') {
                key = JSON.stringify(['runtime', result.path || action.path, result.offset ?? action.offset ?? 0]);
                end = result.nextOffset ?? result.totalChars ?? Infinity;
            } else if (result && !observation.error && action.action === 'read_history') {
                // 旧回读归档后，源归档坐标可能包含在请求中而不在压缩后的回执中。
                key = JSON.stringify(['history', action.archive, action.index, result.offset ?? action.offset ?? 0]);
                end = result.nextOffset ?? result.totalChars ?? Infinity;
            } else if (!result?.archived) {
                key = digest(observation.error ? [action, observation.error] : [action, result]);
            } else continue;
            if (!seen.has(key) || seen.get(key) < end) {
                seen.set(key, end);
                foundNew = true;
            }
        }
        inspectionRounds++;
        if (!historical) repeatedRounds = foundNew ? 0 : repeatedRounds + 1;
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
