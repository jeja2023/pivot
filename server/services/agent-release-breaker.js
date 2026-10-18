'use strict';

function createBreakerNotifier({ createAgentInboxEvent }) {
    /** 熔断通知发给发布者；通知失败不影响熔断结果。 */
    async function notifyBreakerAction(release, eventType, title, reason) {
        const publisherId = Number.parseInt(release.published_by, 10) || 0;
        if (!publisherId) return;
        try {
            await createAgentInboxEvent({ id: publisherId }, {
                eventKey: `skill.release.breaker:${release.id}:${eventType}`,
                eventType,
                sourceId: String(release.id),
                title,
                body: `${release.name} 触发熔断阈值：${reason || '未说明'}。`,
                risk: 'high',
                payload: { releaseId: release.id, reason }
            });
        } catch (_) {
            // 收件箱不可用时熔断仍然生效，事件已记录在 release 状态与日志中。
        }
    }
    return { notifyBreakerAction };
}

module.exports = { createBreakerNotifier };

