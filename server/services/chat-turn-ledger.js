'use strict';

const crypto = require('crypto');
const repository = require('../repositories/chat-conversation-turns');
const { resolveChatProject } = require('./chat-preference-context');

async function beginChatTurn({ req, res, state, modelCfg, writeSse }) {
    if (state.regenerate || state.ephemeralVoice) return null;
    state.projectId = (await resolveChatProject(req.user, state.sessionId, state.ragScope)).projectId;
    const requestKey = String(req.body.clientRequestId || crypto.randomUUID());
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey)) throw Object.assign(new Error('请求标识无效，请重新发送。'), { code: 'CHAT_REQUEST_INVALID' });
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ content: state.modelContent, modelId: modelCfg.id, mode: state.chatMode, ragScope: state.ragScope, routeOverrides: state.routeOverrides, mcpToolAllowlist: state.mcpToolAllowlist, ragEnabled: state.ragEnabled, mcpEnabled: state.mcpEnabled })).digest('hex');
    const turn = await repository.claimTurn({ userId: state.userId, sessionId: state.sessionId, requestKey, inputHash, content: state.modelContent, modelId: modelCfg.id });
    writeSse(JSON.stringify({ type: 'message_saved', role: 'user', messageId: Number(turn.user_message_id), requestId: requestKey }));
    if (turn.replay || turn.busy) {
        if (turn.assistant_message_id) {
            const message = await repository.replayTurn(turn);
            const outcome = typeof turn.outcome === 'string' ? JSON.parse(turn.outcome) : turn.outcome || {};
            if (outcome.status === 'error' && outcome.code === 'MODEL_EMPTY_RESPONSE' && message) {
                writeSse(JSON.stringify({ type: 'assistant_error', error: '模型返回空回复', code: outcome.code, retryable: true, messageId: message.id, content: message.content }));
            } else {
                writeSse(JSON.stringify({ type: 'message_saved', role: 'assistant', messageId: message?.id, content: message?.content || '该回答已移除。' }));
            }
        } else if (turn.run_id) writeSse(JSON.stringify({ type: 'agent_handoff', runId: turn.run_id, automatic: true, message: '已恢复这项任务的处理状态。' }));
        else writeSse(JSON.stringify({ error: '同一请求正在处理中，请稍后刷新会话查看。', code: 'CHAT_REQUEST_IN_PROGRESS' }));
        writeSse('[DONE]');
        return { ...turn, handled: true };
    }
    const timer = setInterval(() => { repository.renewTurn(turn).catch(error => req.log.warn({ code: error.code }, '聊天请求租约续期失败')); }, 30000);
    timer.unref?.();
    res.once('close', () => {
        clearInterval(timer);
        // 断开连接时不能释放尚在建立任务的认领，避免重试读到半初始化 Run。
        // 已交接/完成可立即释放；中途崩溃由两分钟租约到期恢复。
        if (['completed','handed_off'].includes(turn.status)) repository.releaseTurn(turn).catch(error => req.log.warn({ code: error.code }, '聊天请求租约释放失败'));
    });
    return turn;
}

module.exports = { beginChatTurn };
