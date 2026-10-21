// 聊天内控制只作用于明确的运行，审批同时绑定当前请求摘要。
(function initializeChatTaskActions() {
    async function request(runId, path, body = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '任务操作未完成，请刷新状态后重试。');
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('操作确认超时，请重新读取任务状态后再决定是否重试。');
            throw error;
        } finally { clearTimeout(timeout); }
    }

    async function artifactAction(entry, action, button) {
        const artifact = entry.state.artifacts.find(item => item.id === button.dataset.taskArtifact && String(item.rendition?.id || '') === String(button.dataset.taskRendition || ''));
        if (!artifact) throw new Error('结果记录已变化，请刷新任务状态。');
        if (action === 'preview') {
            if (typeof window.Pivot.openArtifact === 'function') return window.Pivot.openArtifact(artifact.id);
            throw new Error('结果查看模块尚未加载，请刷新页面后重试。');
        }
        if (!artifact.rendition?.ready) throw new Error('文件尚未就绪或已经过期。');
        const delivery = window.Pivot.moduleApi('chat.codeDelivery');
        if (action === 'download') return delivery.downloadRendition(artifact.rendition, artifact.title);
        return delivery.queueRenditionToDesktop(artifact.rendition, artifact.title);
    }

    async function perform(entry, action, button) {
        if (entry.disposed) return;
        const mutation = ['pause', 'resume', 'cancel', 'approve', 'reject', 'renew-approval', 'steer'].includes(action);
        if (mutation && entry.actionInFlight) return;
        if (mutation) entry.actionInFlight = true;
        entry.busyAction = action;
        if (button) button.disabled = true;
        const tasks = window.Pivot.moduleApi('chat.tasks');
        tasks.renderEntry?.(entry);
        try {
            if (action === 'details') {
                if (typeof window.Pivot.legacy.openChatAgentRunDetail !== 'function') throw new Error('任务详情模块尚未就绪，请刷新页面后重试。');
                return await window.Pivot.legacy.openChatAgentRunDetail(entry.runId);
            }
            if (action === 'older') return await tasks.loadOlder(entry);
            if (action === 'refresh') return await tasks.refresh(entry);
            if (['preview', 'download', 'save-local'].includes(action)) {
                await artifactAction(entry, action, button);
                return await tasks.refresh(entry);
            }
            if (action === 'steer') {
                await window.Pivot.legacy.steerChatAgentRun?.(entry.runId);
                return await tasks.refresh(entry);
            }
            let result;
            if (['approve', 'reject', 'renew-approval'].includes(action)) {
                const binding = entry.state.approval?.binding;
                if (!binding?.inputHash) throw new Error('授权请求已变化，请刷新状态后重新确认。');
                result = await request(entry.runId, action === 'renew-approval' ? '/approval/refresh' : '/approval', { approve: action === 'approve', ...binding });
            } else if (['pause', 'resume', 'cancel'].includes(action)) {
                result = await request(entry.runId, `/${action}`);
                if (entry.disposed) return;
                const feedback = action === 'cancel' && result.run?.status !== 'cancelled'
                    ? `当前状态：${window.Pivot.moduleApi('chat.taskState').labels[result.run?.status] || '已更新'}。`
                    : ({ pause: '已暂停任务，可以随后继续。', resume: '已请求继续任务。', cancel: '已停止后续处理，已完成操作保留记录。' })[action];
                tasks.applyControlResult?.(entry, result, feedback);
                showToast(feedback, 'info');
            } else return;
            if (!['pause', 'resume', 'cancel'].includes(action)) tasks.applyControlResult?.(entry, result, '操作决定已保存。');
            void tasks.refresh(entry, { reset: true });
        } catch (error) {
            showToast(error.message || '任务操作未完成，请刷新状态后重试。', 'error');
            entry.state.actionFeedback = error.message || '操作未完成，请重试。';
            void tasks.refresh(entry).catch(() => {});
        } finally {
            if (mutation) entry.actionInFlight = false;
            if (entry.busyAction === action) entry.busyAction = '';
            tasks.renderEntry?.(entry);
            if (button?.isConnected) button.disabled = false;
        }
    }

    window.Pivot.exposeModule('chat.taskActions', { perform, request });
})();
