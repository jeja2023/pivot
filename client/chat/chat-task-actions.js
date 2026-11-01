// 聊天内控制只作用于明确的运行，审批同时绑定当前请求摘要。
(function initializeChatTaskActions() {
    let previewSequence = 0;
    let activePreview = null;

    function closeResultPreview() {
        previewSequence++;
        if (!activePreview) return;
        const preview = activePreview;
        activePreview = null;
        document.removeEventListener('keydown', preview.onKeydown);
        preview.cleanup?.();
        preview.panel.remove();
        document.body.classList.remove('chat-result-preview-open');
        if (preview.trigger?.isConnected) preview.trigger.focus();
    }

    function setSafeMarkup(element, markup) {
        if (!element) return;
        if (window.PivotSafeHtml?.setHtml) {
            window.PivotSafeHtml.setHtml(element, markup);
            return;
        }
        const parsed = new DOMParser().parseFromString(markup, 'text/html');
        element.replaceChildren(...parsed.body.childNodes);
    }

    function createNoticeElement(text) {
        const notice = document.createElement('div');
        notice.className = 'chat-result-preview-notice';
        setNoticeText(notice, text, false);
        return notice;
    }

    function setNoticeText(notice, text, isError = false) {
        if (!notice) return;
        notice.className = `chat-result-preview-notice${isError ? ' chat-result-preview-notice-error' : ''}`;
        const iconWrap = document.createElement('span');
        iconWrap.className = 'chat-result-preview-notice-icon';
        setSafeMarkup(iconWrap, isError
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>');
        const textSpan = document.createElement('span');
        textSpan.className = 'chat-result-preview-notice-text';
        textSpan.textContent = text;
        notice.replaceChildren(iconWrap, textSpan);
    }

    function createResultPreview(artifact, trigger) {
        closeResultPreview();
        const sequence = previewSequence;
        const panel = document.createElement('aside');
        panel.className = 'chat-result-preview';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', `${artifact.title || '结果文件'}预览`);

        const header = document.createElement('div');
        header.className = 'chat-result-preview-header';

        const main = document.createElement('div');
        main.className = 'chat-result-preview-header-main';

        const icon = document.createElement('span');
        icon.className = 'chat-result-preview-header-icon';
        setSafeMarkup(icon, '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>');

        const title = document.createElement('strong');
        title.className = 'chat-result-preview-title';
        title.textContent = artifact.title || '结果文件预览';
        title.title = artifact.title || '结果文件预览';

        const format = String(artifact.rendition?.format || '').toUpperCase();
        main.append(icon, title);
        if (format) {
            const badge = document.createElement('span');
            badge.className = 'chat-result-preview-meta-badge';
            badge.textContent = format;
            main.appendChild(badge);
        }

        const actions = document.createElement('div');
        actions.className = 'chat-result-preview-header-actions';

        if (artifact.rendition?.ready) {
            const dlBtn = document.createElement('button');
            dlBtn.type = 'button';
            dlBtn.className = 'btn-secondary chat-result-preview-download-btn';
            setSafeMarkup(dlBtn, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>下载</span>');
            dlBtn.title = '下载原文件';
            dlBtn.addEventListener('click', () => {
                const delivery = window.Pivot.moduleApi('chat.codeDelivery');
                delivery?.downloadRendition?.(artifact.rendition, artifact.title);
            });
            actions.appendChild(dlBtn);
        }

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn-secondary btn-danger-outline chat-result-preview-close';
        close.textContent = '关闭预览';
        close.title = '关闭预览 (Esc)';
        close.addEventListener('click', closeResultPreview);
        actions.appendChild(close);

        header.append(main, actions);

        const body = document.createElement('div');
        body.className = 'chat-result-preview-body';
        panel.append(header, body);
        document.body.appendChild(panel);
        document.body.classList.add('chat-result-preview-open');
        const onKeydown = event => { if (event.key === 'Escape' && activePreview?.panel === panel) closeResultPreview(); };
        document.addEventListener('keydown', onKeydown);
        activePreview = { panel, body, trigger, onKeydown, cleanup: null };
        return { panel, body, sequence };
    }

    function previewIsCurrent(preview) { return activePreview?.panel === preview.panel && preview.sequence === previewSequence; }
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
            if (artifact.rendition?.ready && ['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(String(artifact.rendition.format || '').toLowerCase())) {
                return await previewImageRendition(artifact, button);
            }
            if (artifact.rendition?.ready && String(artifact.rendition.format || '').toLowerCase() === 'docx') {
                return await previewDocumentRendition(artifact, button);
            }
            if (typeof window.Pivot.openArtifact === 'function') return window.Pivot.openArtifact(artifact.id);
            throw new Error('结果查看模块尚未加载，请刷新页面后重试。');
        }
        if (!artifact.rendition?.ready) throw new Error('文件尚未就绪或已经过期。');
        const delivery = window.Pivot.moduleApi('chat.codeDelivery');
        if (action === 'download') return delivery.downloadRendition(artifact.rendition, artifact.title);
        return delivery.queueRenditionToDesktop(artifact.rendition, artifact.title);
    }

    async function previewDocumentRendition(artifact, trigger) {
        const preview = createResultPreview(artifact, trigger);
        const notice = createNoticeElement('正在加载文档预览…');
        preview.body.appendChild(notice);
        try {
            const configResponse = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(artifact.rendition.id)}/onlyoffice-preview`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            const configData = await configResponse.json().catch(() => ({}));
            if (!configResponse.ok) throw new Error(configData.error || '无法准备文档预览。');
            if (!previewIsCurrent(preview)) return;
            if (configData.onlyoffice) return await previewWithOnlyOffice(artifact, configData.onlyoffice, preview, notice);
            const response = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(artifact.rendition.id)}/document-preview`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok || typeof data.html !== 'string') throw new Error(data.error || '文档预览暂不可用，请稍后重试。');
            if (!previewIsCurrent(preview)) return;
            setNoticeText(notice, data.imagePlaceholders ? '文档内容预览，分页和图片可能与原文件不同；图片请下载原文件查看。' : '文档内容预览，分页与字体可能与原文件不同。');
            const frame = document.createElement('iframe');
            frame.className = 'chat-result-preview-frame';
            frame.title = artifact.title || '文档内容预览';
            frame.setAttribute('sandbox', '');
            PivotSafeHtml.setSrcdoc(frame, data.html);
            preview.body.appendChild(frame);
        } catch (error) {
            if (!previewIsCurrent(preview)) return;
            setNoticeText(notice, error.message || '文档预览加载失败。', true);
            throw error;
        }
    }

    async function previewWithOnlyOffice(artifact, config, preview, notice) {
        if (!/^\/[A-Za-z0-9_-]+\/web-apps\/apps\/api\/documents\/api\.js$/.test(String(config.scriptUrl || ''))) throw new Error('文档服务地址无效。');
        if (!window.DocsAPI?.DocEditor) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = config.scriptUrl;
                script.onload = resolve;
                script.onerror = () => { script.remove(); reject(new Error('文档服务无法连接，请检查 ONLYOFFICE 代理配置。')); };
                document.head.appendChild(script);
            });
        }
        if (!previewIsCurrent(preview)) return;
        if (!window.DocsAPI?.DocEditor) throw new Error('文档服务初始化失败。');
        notice.remove();
        const host = document.createElement('div');
        host.className = 'chat-result-preview-office';
        host.id = `onlyoffice-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        preview.body.appendChild(host);
        const editor = new window.DocsAPI.DocEditor(host.id, config.editor);
        if (previewIsCurrent(preview)) activePreview.cleanup = () => editor.destroyEditor?.();
        else editor.destroyEditor?.();
    }

    async function previewImageRendition(artifact, trigger) {
        const preview = createResultPreview(artifact, trigger);
        const notice = createNoticeElement('正在加载图片预览…');
        preview.body.appendChild(notice);
        try {
            const rendition = artifact.rendition;
            const tokenRes = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(rendition.id)}/download-token`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            const issued = await tokenRes.json().catch(() => ({}));
            if (!tokenRes.ok || !issued.token) throw new Error(issued.error || '获取预览许可失败，请刷新后重试。');
            if (!previewIsCurrent(preview)) return;
            const file = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(rendition.id)}/download?token=${encodeURIComponent(issued.token)}`);
            if (!file.ok) throw new Error('读取预览文件失败，请刷新后重试。');
            const blob = await file.blob();
            const mime = String(blob.type || '').split(';')[0].toLowerCase();
            if (!['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('结果文件不是受支持的图片格式。');
            if (!previewIsCurrent(preview)) return;
            const url = URL.createObjectURL(blob);
            activePreview.cleanup = () => URL.revokeObjectURL(url);
            notice.remove();
            const wrap = document.createElement('div');
            wrap.className = 'chat-result-preview-image-wrap';
            const image = document.createElement('img');
            image.className = 'chat-result-preview-image';
            image.alt = artifact.title || '生成的图形';
            image.src = url;
            wrap.appendChild(image);
            preview.body.appendChild(wrap);
        } catch (error) {
            if (!previewIsCurrent(preview)) return;
            setNoticeText(notice, error.message || '图片预览加载失败。', true);
            throw error;
        }
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
            if (action === 'create-schedule') {
                return (window.Pivot?.moduleApi?.('agent.runActions')?.createScheduleFromAgentRun || window.Pivot?.legacy?.createScheduleFromAgentRun)?.(entry.runId, entry.state.run);
            }
            if (action === 'save-template') {
                return (window.Pivot?.moduleApi?.('agent.runActions')?.saveTemplateFromAgentRun || window.Pivot?.legacy?.saveTemplateFromAgentRun)?.(entry.runId, entry.state.run);
            }
            if (action === 'steer') {
                await window.Pivot.legacy.steerChatAgentRun?.(entry.runId);
                return await tasks.refresh(entry);
            }
            let result;
            if (['approve', 'reject', 'renew-approval'].includes(action)) {
                const binding = entry.state.approval?.binding;
                if (!binding?.inputHash) throw new Error('授权请求已变化，请刷新状态后重新确认。');
                const rememberEl = entry.element?.querySelector('[data-task-approval-remember]');
                const rememberForRun = action === 'approve' && Boolean(rememberEl?.checked);
                result = await request(entry.runId, action === 'renew-approval' ? '/approval/refresh' : '/approval', {
                    approve: action === 'approve',
                    ...binding,
                    ...(rememberForRun ? { rememberForRun: true } : {})
                });
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
