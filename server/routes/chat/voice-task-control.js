'use strict';

const { getAgentVoiceSession } = require('../../services/agent-voice-sessions');
const { listChatAgentRunsForSession } = require('../../services/chat-agent-bridge');
const { runs: { cancelAgentRun, pauseAgentRun, resumeAgentRun } } = require('../../services/agent-runtime');

const VOICE_TASK_ACTIONS = new Set(['pause', 'resume', 'cancel']);
const VOICE_PAUSABLE_STATUSES = new Set(['queued', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'running', 'resuming']);

function voiceTaskControlError(message, code = 'AGENT_VOICE_TASK_CONTROL_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

async function controlVoiceSessionAgentRun(user, voiceSessionId, action, deps = {}) {
    const safeAction = String(action || '').trim().toLowerCase();
    if (!VOICE_TASK_ACTIONS.has(safeAction)) throw voiceTaskControlError('未知的语音任务控制动作。');
    const getVoiceSession = deps.getAgentVoiceSession || getAgentVoiceSession;
    const listRuns = deps.listChatAgentRunsForSession || listChatAgentRunsForSession;
    const pauseRun = deps.pauseAgentRun || pauseAgentRun;
    const resumeRun = deps.resumeAgentRun || resumeAgentRun;
    const cancelRun = deps.cancelAgentRun || cancelAgentRun;
    const voiceSession = await getVoiceSession(user, voiceSessionId);
    if (!voiceSession || voiceSession.status !== 'active' || !voiceSession.sessionId) {
        throw voiceTaskControlError('语音会话未绑定活动聊天，不能控制任务。', 'AGENT_VOICE_TASK_SESSION_INVALID', 409);
    }
    const runs = await listRuns(voiceSession.sessionId, user?.id, { limit: 20 });
    const target = safeAction === 'resume'
        ? runs.find(run => String(run.status || '') === 'needs_input')
        : runs.find(run => VOICE_PAUSABLE_STATUSES.has(String(run.status || '')));
    if (!target) {
        throw voiceTaskControlError(
            safeAction === 'resume' ? '当前聊天没有可续跑的已暂停任务。' : '当前聊天没有可控制的运行中任务。',
            'AGENT_VOICE_TASK_TARGET_NOT_FOUND', 409
        );
    }
    const run = safeAction === 'pause' ? await pauseRun(target.id, user)
        : safeAction === 'resume' ? await resumeRun(target.id, user) : await cancelRun(target.id, user);
    if (!run) throw voiceTaskControlError('任务控制未能生效。', 'AGENT_VOICE_TASK_CONTROL_FAILED', 409);
    const message = safeAction === 'pause' ? '任务已暂停，可说“继续任务”从安全检查点续跑。'
        : safeAction === 'resume' ? '已创建任务续跑，将从安全检查点继续。' : '任务已停止。';
    return { action: safeAction, sourceRunId: String(target.id), run, message };
}

module.exports = { controlVoiceSessionAgentRun };
