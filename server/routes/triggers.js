/* 入站触发路由：供内网其他系统以 HTTP 方式触发已发布工作流。
   该路由挂在 /hooks 前缀下，不参与浏览器会话鉴权，令牌本身就是凭证。 */
const express = require('express');
const { asyncHandler } = require('../http');
const { logger } = require('../logger');
const { dispatchWebhookTrigger, MAX_WEBHOOK_PAYLOAD_BYTES } = require('../services/agent-triggers');
const { handleImApprovalCallback, CALLBACK_TOKEN_PATTERN } = require('../services/agent-approval-requests');

// 令牌格式固定为 wht_ 加 48 位十六进制，先做格式校验再查库，减少无效查询
const TOKEN_PATTERN = /^wht_[0-9a-f]{48}$/;

function createTriggersRouter({ triggerLimiter, logAction } = {}) {
    const router = express.Router();
    const limiterGuard = typeof triggerLimiter === 'function' ? triggerLimiter : (req, res, next) => next();

    router.post('/workflow/:token', limiterGuard, asyncHandler(async (req, res) => {
        const token = String(req.params.token || '').trim();
        // 令牌无效、触发器停用、账号失效统一返回 404，避免通过响应差异探测有效令牌
        if (!TOKEN_PATTERN.test(token)) {
            return res.status(404).json({ error: '触发器不存在或已停用。' });
        }

        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        // 全局 JSON 解析上限为 10MB，触发入参在此基础上再收紧，避免超大 payload 进入运行参数
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_WEBHOOK_PAYLOAD_BYTES) {
            return res.status(413).json({ error: '触发请求内容过大，请精简后重试。' });
        }
        let result = null;
        try {
            result = dispatchWebhookTrigger(token, payload, { sourceIp: req.ip });
        } catch (err) {
            const status = Number(err.status) || 500;
            logger.warn({ err: err.message, sourceIp: req.ip }, '入站 Webhook 触发失败');
            return res.status(status).json({ error: status >= 500 ? '触发工作流失败，请稍后重试。' : err.message });
        }

        if (!result) {
            return res.status(404).json({ error: '触发器不存在或已停用。' });
        }
        if (typeof logAction === 'function') {
            logAction(req, '入站 Webhook 触发工作流', `触发器: ${result.triggerName}，任务ID: ${result.runId}`);
        }
        res.status(202).json({ success: true, runId: result.runId });
    }));

    router.post('/im-callback/:token', limiterGuard, asyncHandler(async (req, res) => {
        const token = String(req.params.token || '').trim();
        if (!CALLBACK_TOKEN_PATTERN.test(token)) {
            return res.status(404).json({ error: '回调令牌不存在或已失效。' });
        }
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        try {
            const result = await handleImApprovalCallback(token, payload, req.headers);
            if (!result) return res.status(404).json({ error: '回调令牌不存在或已失效。' });
            if (typeof logAction === 'function') {
                logAction(req, 'IM 审批回调', `请求ID: ${result.id}，状态: ${result.status}`);
            }
            return res.status(202).json({ success: true, request: result });
        } catch (err) {
            const status = Number(err.status) || 500;
            logger.warn({ err: err.message, sourceIp: req.ip }, 'IM 审批回调失败');
            return res.status(status).json({ error: status >= 500 ? '审批回调失败，请稍后重试。' : err.message });
        }
    }));

    return router;
}

module.exports = { createTriggersRouter };
