(function () {
    const MODEL_ERROR_REASONS = {
        PPT_MASTER_UPSTREAM_CONTEXT_LIMIT: '模型服务拒绝了本轮上下文',
        PPT_MASTER_MODEL_TIMEOUT: '模型请求超时',
        PPT_MASTER_MODEL_RATE_LIMIT: '模型服务暂时限流',
        PPT_MASTER_MODEL_PROVIDER_QUOTA: '模型服务额度不足',
        PPT_MASTER_MODEL_AUTH: '模型服务拒绝授权',
        PPT_MASTER_MODEL_CONNECTION: '模型服务连接中断或暂不可用',
        PPT_MASTER_MODEL_REQUEST_REJECTED: '模型服务拒绝请求',
        AI_QUEUE_FULL: '模型请求队列已满',
        AI_QUEUE_TIMEOUT: '模型请求排队超时',
        AI_ENDPOINT_CIRCUIT_OPEN: '模型端点暂不可用'
    };

    function formatDuration(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '';
        if (ms < 1000) return `${Math.round(ms)} 毫秒`;
        const tenths = Math.round(ms / 100);
        if (tenths < 600) return `${tenths / 10} 秒`;
        const totalSeconds = Math.round(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60), seconds = totalSeconds % 60;
        return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
    }

    function timingLabel({ startedAt, durationMs }) {
        const timestamp = typeof startedAt === 'string' ? startedAt.trim() : '';
        const time = timestamp.match(/\d{2}:\d{2}:\d{2}/)?.[0];
        const duration = formatDuration(durationMs) || '未记录';
        return {
            text: `开始 ${time || '未记录'} · 用时 ${duration}`,
            title: `开始时间（北京时间）：${time ? timestamp : '未记录'}\n用时：${duration}`
        };
    }

    function formatTokens(tokens, estimated) {
        return tokens == null ? '未知' : `${tokens}${estimated ? '（估算）' : ''}`;
    }

    function formatMetrics(item) {
        const input = formatTokens(item.inputTokens, item.inputEstimated);
        const output = formatTokens(item.outputTokens, item.outputEstimated);
        return `输入 ${input}，输出 ${output}，累计已记录 ${item.cumulativeTokens}`;
    }

    function formatModelError(code) {
        const reason = Object.hasOwn(MODEL_ERROR_REASONS, code) ? MODEL_ERROR_REASONS[code] : '模型调用未完成';
        return reason + '。';
    }

    window.Pivot.exposeModule('apps.presentations.masterUsage', { timingLabel, formatMetrics, formatModelError });
})();
