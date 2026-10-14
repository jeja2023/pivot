(function () {
    const pivotLegacy = window.Pivot?.legacy;
    if (!pivotLegacy) return;

    function create({ api, state, requestJson, toast, renderDetail, loadDetail, loadJobs, closeDetailPanel, submitUpload }) {
        async function requireDesktopCapability(type, label) {
            const desktop = window.pivotDesktop;
            if (typeof desktop?.getLocalAuthorizationStatus !== 'function') {
                throw new Error(`当前桌面客户端不支持${label}，请升级 Pivot 客户端后重试。`);
            }
            const status = await desktop.getLocalAuthorizationStatus();
            const supportedTypes = Array.isArray(status?.supportedTypes) ? status.supportedTypes : [];
            if (!supportedTypes.includes(type)) {
                const error = new Error(`当前桌面客户端不支持${label}，请升级至 Pivot v0.2.23 或更高版本后重试。`);
                error.code = 'PIVOT_DESKTOP_CLIENT_UPDATE_REQUIRED';
                throw error;
            }
            return status;
        }

        async function extractFields(jobId) {
            const data = await requestJson(`${api}/jobs/${encodeURIComponent(jobId)}/fields`);
            const fields = data.fields?.fields || {};
            const target = document.getElementById('ocr-field-result');
            if (!target) return;
            const labels = { documentNumber: '文号', issueDate: '日期', issuer: '发布单位', amount: '金额' };
            const entries = Object.entries(fields);
            target.textContent = entries.length
                ? entries.map(([key, field]) => `${labels[key] || key}：${field.value}（第 ${field.pageNumber} 页候选）`).join('；')
                : '未识别到可直接提取的公文字段，请人工复核原文。';
            target.classList.remove('hidden');
        }

        async function openReviewers(jobId) {
            if (state.isReviewerPanelOpen && String(state.activeJobId) === String(jobId)) {
                state.isReviewerPanelOpen = false;
                renderDetail();
                return;
            }
            const data = await requestJson(`${api}/jobs/${encodeURIComponent(jobId)}/reviewer-candidates`);
            const candidates = Array.isArray(data.candidates) ? data.candidates : [];
            state.reviewCandidates = candidates;
            state.reviewPanelInfo = {
                ownerUnit: data.ownerUnit || '',
                reason: data.reason || (candidates.length ? '' : 'NO_COLLEAGUES')
            };
            state.selectedReviewerIds = new Set();
            state.isReviewerPanelOpen = true;
            renderDetail();
            if (!candidates.length) {
                if (data.reason === 'NO_OWNER_UNIT' || !data.ownerUnit) {
                    toast('当前账号未设置所属单位，无法分派复核人。请在用户管理中配置单位。', 'warning');
                } else {
                    toast(`所属单位「${data.ownerUnit}」暂无可分派的协同同事。`, 'info');
                }
            } else {
                toast(`已加载 ${candidates.length} 位同单位复核候选人，请勾选后分派`, 'info');
            }
        }

        async function saveReviewers(jobId) {
            const reviewerUserIds = Array.from(state.selectedReviewerIds).map(value => Number(value));
            if (!reviewerUserIds.length) {
                toast('请至少选择一位复核人', 'warning');
                return;
            }
            await requestJson(`${api}/jobs/${encodeURIComponent(jobId)}/reviewers`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewerUserIds }) });
            state.isReviewerPanelOpen = false;
            state.reviewCandidates = [];
            state.reviewPanelInfo = null;
            state.selectedReviewerIds = new Set();
            toast('复核人已分派', 'success');
            await loadDetail(jobId, { silent: true });
        }

        async function recognizeSelectedRegion(pageId) {
            const selection = state.regionSelection;
            if (!selection || String(selection.pageId) !== String(pageId)) return;
            const data = await requestJson(`${api}/pages/${encodeURIComponent(pageId)}/regions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ region: { x: selection.x, y: selection.y, width: selection.width, height: selection.height } }) });
            state.regionCandidate = data.candidate || null;
            toast('区域识别候选已生成，请人工核对后使用', 'success');
            renderDetail();
        }

        async function submitFeedback(pageId) {
            const correctedText = document.getElementById('ocr-review-text')?.value || '';
            const confirmed = typeof window.confirm !== 'function' || window.confirm('将该页原始识别与修订文本作为脱敏评测候选提交给管理员审核。确认已获得材料使用授权吗？');
            if (!confirmed) return;
            await requestJson(`${api}/pages/${encodeURIComponent(pageId)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ correctedText, feedbackType: 'correction', consented: true }) });
            toast('纠错反馈已提交，等待管理员审核', 'success');
        }

        async function captureDesktopScreenshot() {
            if (typeof window.pivotDesktop?.executeLocalMcpTool !== 'function') throw new Error('当前不是支持本机截图的桌面客户端，请直接粘贴图片或上传文件。');
            await requireDesktopCapability('local_desktop_control', '截取已授权窗口');
            const result = await window.pivotDesktop.executeLocalMcpTool({ toolName: 'desktop.screenshot', input: {} });
            const screenshot = result?.screenshot;
            if (!screenshot?.dataBase64 || !String(screenshot.mimeType || '').startsWith('image/')) throw new Error('未获得有效截图，请确认已授权当前前台窗口。');
            const bytes = Uint8Array.from(globalThis.atob(screenshot.dataBase64), char => char.charCodeAt(0));
            const extension = screenshot.mimeType === 'image/png' ? 'png' : 'jpg';
            const file = new File([bytes], `桌面截图-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, { type: screenshot.mimeType });
            const form = document.getElementById('ocr-upload-form');
            if (!form) throw new Error('文字识别上传表单未加载。');
            await submitUpload(form, [file]);
        }

        async function authorizeWatchDirectory() {
            if (typeof window.pivotDesktop?.requestLocalAuthorization !== 'function') throw new Error('当前不是支持本机目录授权的桌面客户端。');
            await requireDesktopCapability('local_ocr_watch_dir', '监控目录授权');
            const result = await window.pivotDesktop.requestLocalAuthorization('local_ocr_watch_dir');
            if (result?.canceled) return false;
            toast('已授权文字识别监控目录；新文件稳定写入后将自动创建任务', 'success');
            return true;
        }

        async function revokeWatchDirectory() {
            if (typeof window.pivotDesktop?.revokeLocalAuthorization !== 'function') throw new Error('当前不是支持本机目录授权的桌面客户端。');
            await requireDesktopCapability('local_ocr_watch_dir', '监控目录监听');
            await window.pivotDesktop.revokeLocalAuthorization('local_ocr_watch_dir');
            toast('已停止文字识别目录监听', 'success');
        }

        function bindWatchEvents() {
            if (state.ocrWatchUnsubscribe || typeof window.pivotDesktop?.onOcrWatchFile !== 'function') return;
            state.ocrWatchUnsubscribe = window.pivotDesktop.onOcrWatchFile(async payload => {
                if (window.Pivot?.legacy?.getAppsSessionValue?.('pivot_apps_active_app') !== 'ocr') return;
                try {
                    const result = await window.pivotDesktop.executeLocalMcpTool({ toolName: 'ocr.watch.read', input: { fileName: payload?.fileName } });
                    const file = result?.file;
                    if (!file?.dataBase64) return;
                    const bytes = Uint8Array.from(globalThis.atob(file.dataBase64), char => char.charCodeAt(0));
                    const upload = new File([bytes], file.originalName, { type: file.mimeType || 'application/octet-stream' });
                    const form = document.getElementById('ocr-upload-form');
                    if (!form) return;
                    await submitUpload(form, [upload]);
                    toast(`已从授权目录接收 ${file.originalName}`, 'success');
                } catch (error) {
                    if (error?.code !== 'OCR_WATCH_FILE_UNSTABLE') toast(error.message || '读取授权目录文件失败', 'warning');
                }
            });
        }

        async function retryJob(jobId) {
            const failedPages = Number(state.detail?.job?.failedPageCount || state.detail?.job?.result?.coverage?.failedPageCount || 0);
            await requestJson(`${api}/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retryFailedPages: failedPages > 0 }) });
            toast('任务已重新排队', 'success');
            await loadJobs({ keepActive: true });
        }

        async function cancelJob(jobId) {
            await requestJson(`${api}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
            toast('任务已取消');
            await loadJobs({ keepActive: true });
        }

        async function deleteJob(jobId) {
            if (!jobId) return;
            if (typeof window.confirm === 'function' && !window.confirm('确定删除该任务及相关文件吗？删除后不可恢复。')) return;
            await requestJson(`${api}/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
            if (String(state.activeJobId) === String(jobId)) {
                state.activeJobId = '';
                state.activePageId = '';
                state.detail = null;
                state.isReviewerPanelOpen = false;
                state.reviewPanelInfo = null;
                closeDetailPanel();
            }
            toast('任务已删除', 'success');
            await loadJobs({ keepActive: false });
        }

        async function downloadOutput(outputId, filename = '') {
            const response = await apiFetch(`${api}/outputs/${encodeURIComponent(outputId)}/download`);
            if (!response.ok) throw new Error('输出文件下载失败');
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename || `ocr-output-${outputId}`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        }

        async function exportOutput(format) {
            if (!state.activeJobId) return;
            const data = await requestJson(`${api}/jobs/${encodeURIComponent(state.activeJobId)}/outputs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format }) });
            const exportRequest = data.export;
            if (!exportRequest?.id) throw new Error('未能创建导出请求');
            toast(exportRequest.status === 'ready' ? '输出已就绪' : '正在固定当前修订并生成输出…', 'info');
            let current = exportRequest;
            for (let attempt = 0; current.status === 'queued' || current.status === 'processing'; attempt += 1) {
                if (attempt >= 120) throw new Error('导出仍在处理中，请稍后在任务详情中查看。');
                await new Promise(resolve => setTimeout(resolve, Math.min(500 + attempt * 25, 1500)));
                const result = await requestJson(`${api}/exports/${encodeURIComponent(current.id)}`);
                current = result.export || current;
            }
            if (current.status !== 'ready' || !current.outputId) throw new Error(current.errorMessage || '导出失败，请重试。');
            toast('输出已生成（内容版本已固定）', 'success');
            await loadDetail(state.activeJobId, { silent: true });
            await downloadOutput(current.outputId);
        }

        function bindRegionPointerEvents(view) {
            const previewPoint = (event, element) => {
                const rect = element.getBoundingClientRect();
                return { x: Math.min(Math.max((event.clientX - rect.left) / Math.max(rect.width, 1), 0), 1), y: Math.min(Math.max((event.clientY - rect.top) / Math.max(rect.height, 1), 0), 1) };
            };
            view.addEventListener('pointerdown', event => {
                const preview = event.target.closest('[data-ocr-preview-page]');
                if (!preview || event.button !== 0 || event.target.closest('.ocr-overlay-box')) return;
                const start = previewPoint(event, preview);
                state.regionDrag = { pageId: String(preview.dataset.ocrPreviewPage), start, preview };
                state.regionSelection = { pageId: String(preview.dataset.ocrPreviewPage), x: start.x, y: start.y, width: 0, height: 0 };
                preview.setPointerCapture?.(event.pointerId);
                event.preventDefault();
            });
            view.addEventListener('pointermove', event => {
                const drag = state.regionDrag;
                if (!drag) return;
                const current = previewPoint(event, drag.preview);
                state.regionSelection = { pageId: drag.pageId, x: Math.min(drag.start.x, current.x), y: Math.min(drag.start.y, current.y), width: Math.abs(current.x - drag.start.x), height: Math.abs(current.y - drag.start.y) };
                const element = document.querySelector('#ocr-detail .ocr-region-selection');
                if (element) Object.assign(element.style, { left: `${state.regionSelection.x * 100}%`, top: `${state.regionSelection.y * 100}%`, width: `${state.regionSelection.width * 100}%`, height: `${state.regionSelection.height * 100}%` });
            });
            view.addEventListener('pointerup', event => {
                if (!state.regionDrag) return;
                state.regionDrag.preview.releasePointerCapture?.(event.pointerId);
                state.regionDrag = null;
                if (!state.regionSelection || state.regionSelection.width < 0.01 || state.regionSelection.height < 0.01) state.regionSelection = null;
                renderDetail();
            });
        }

        return { authorizeWatchDirectory, bindRegionPointerEvents, bindWatchEvents, cancelJob, captureDesktopScreenshot, deleteJob, downloadOutput, exportOutput, extractFields, openReviewers, recognizeSelectedRegion, retryJob, revokeWatchDirectory, saveReviewers, submitFeedback };
    }

    pivotLegacy.PivotOcrActions = { create };
})();
