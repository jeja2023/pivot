// @ts-check
'use strict';

/** 登记必须在响应前持久确认的审计。 @param {any} req @param {Promise<any> | undefined} write */
function trackCriticalWrite(req, write) {
    const pending = Promise.resolve(write);
    (req.criticalWrites ||= []).push(pending);
    // 立即登记拒绝处理，最终由响应边界决定失败状态，避免先触发未处理拒绝。
    pending.catch(() => {});
    return pending;
}

/** 响应边界等待审计，失败保留明确状态。 @param {any} req @param {any} res @param {() => void} next */
function criticalWriteResponse(req, res, next) {
    const end = res.end;
    let ending = false;
    res.end = function (...args) {
        if (!req.criticalWrites?.length) return end.apply(this, args);
        if (ending) return this;
        ending = true;
        let timer;
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('审计持久确认超时'), { code: 'AUDIT_PERSISTENCE_TIMEOUT' })), 15000); });
        Promise.race([Promise.all(req.criticalWrites), deadline]).then(() => {
            if (!res.destroyed) end.apply(res, args);
        }, error => {
            req.log?.error?.({ code: error.code }, '操作审计未能持久保存，响应不确认成功');
            if (res.destroyed) return;
            if (res.headersSent) { res.destroy(); return; }
            res.statusCode = 503;
            res.removeHeader('Content-Length');
            res.removeHeader('ETag');
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            end.call(res, JSON.stringify({ error: '操作结果的审计记录尚未确认，请刷新状态后再决定是否重试。', code: 'AUDIT_PERSISTENCE_UNAVAILABLE' }));
        }).finally(() => clearTimeout(timer));
        return this;
    };
    next();
}

module.exports = { criticalWriteResponse, trackCriticalWrite };
