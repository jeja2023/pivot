'use strict';

// 历史接口依赖旧数据库接口或模拟执行；保留纯 DSL 解析，
// 避免未完成的操作以成功结果对外暴露。
function createExperimentalApiGuard(authMiddleware, { allow = [], block = null } = {}) {
    return (req, res, next) => {
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        const path = req.path.replace(/\/+$/, '').toLowerCase() || '/';
        const matches = rule => rule.method === method && rule.path === path;
        if (allow.some(matches)) return next();
        if (block && !block.some(matches)) return next();
        return authMiddleware(req, res, () => res.status(503).json({
            error: '此接口暂不可用，请使用现有工作台功能。',
            code: 'EXPERIMENTAL_API_UNAVAILABLE'
        }));
    };
}

module.exports = { createExperimentalApiGuard };
