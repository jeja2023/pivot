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

    function formatModelError(code, kind) {
        const detail = { connection_reset: '模型连接提前关闭，未收到完整回复', gateway_error: '模型服务或上游网关返回服务器错误',
            local_timeout: '模型请求达到 Pivot 的等待时限', upstream_timeout: '上游模型网关返回 HTTP 504' };
        const reason = Object.hasOwn(MODEL_ERROR_REASONS, code) ? MODEL_ERROR_REASONS[code] : '模型调用未完成';
        return (detail[kind] || reason) + '。';
    }

    function preparationDiagnostic(item) {
        if (item.correctionKind === 'action_fields') return `同批第 ${item.actionIndex} 项制作动作含不支持的参数（${item.actionType}）。`;
        const project = (item.actions || []).find(entry => entry.projectIssues?.length);
        if (project) {
            const labels = { design: '设计规范', lock: '执行锁', communication: '沟通字段', layout: '模板版式或资源引用', other: '项目结构' };
            return '项目校验未通过。请核对' + project.projectIssues.map(kind => labels[kind]).filter(Boolean).join('、') + '。';
        }
        if (item.correctionKind === 'citation_patch' && item.outcome !== 'citation_placeholder') return '引文修正未命中当前待核对项，请使用当前条目标识与原文。';
        if (item.correctionKind === 'plan_page_count' && item.outcome !== 'citation_placeholder') return '模型提交的清单页数不足或超出制作要求。';
        if (item.errorCode === 'PPT_MASTER_AUTHORING_READ_LIMIT') return '仍无首张页面回执，需写入规范或页面，或完成必要校验。';
        const action = (item.actions || []).find(entry => entry.svgCheckPages?.length || entry.pageCheck);
        const pages = action?.svgCheckPages || item.hostSvgCheckPages;
        if (pages?.length) return (action ? 'SVG 检查未通过' : '宿主自动复检未通过') + '。' + pages.map(({ page, reasons }) => `第 ${page} 页${reasons.join('、')}`).join('，') + '。';
        const check = action?.pageCheck;
        if (check) {
            const reasons = { source_path: '源文件名或目录与清单页序不符', first_page_pending: '须先完成对应页面及首张检查',
                source_xml: 'SVG 格式无效', source_content: '源稿的标题或正文与清单不一致', first_page_layout: '首张 SVG 版式检查未通过' };
            return (check.page ? `第 ${check.page} 页` : '') + (reasons[check.kind] || '源稿检查未通过') + '。';
        }
        return '';
    }

    function observationStatus(item, failReason) {
        if (item.confirmed) return '已确认写入';
        if (item.unavailable) return '记录尚未生成';
        if (!item.failed) return '';
        if (Number.isInteger(item.exitCode)) return `未通过（退出码 ${item.exitCode}）`;
        return '未通过' + (failReason ? '（' + failReason + '）' : '');
    }

    function contextLabel(item) {
        const b = item.breakdown;
        const parts = b ? `（初始指引及任务 ${b.initial}，历史消息 ${b.history}，工具结果 ${b.toolResults || 0}，图片 ${b.images}）` : '';
        return `预计输入 ${item.inputEstimate}${parts}，收敛前预计 ${item.originalEstimate}，压缩 ${item.compactedWrites} 条历史写入。`;
    }

    window.Pivot.exposeModule('apps.presentations.masterUsage', { timingLabel, formatMetrics, formatModelError, preparationDiagnostic, observationStatus, contextLabel });
})();
