/* eslint-disable no-undef -- Split regulations modules resolve names through PivotRegulationsInternal. */
(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsImportReady) return;
    with (ns) {
            async function uploadDocument(form) {
                        const fileInput = form.querySelector('#regulations-upload-file');
                        const fileCount = Number(fileInput?.files?.length || 0);
                        if (!fileCount) {
                            toast('请选择要导入的文档', 'warning');
                            return;
                        }
                        const formData = new FormData(form);
                        const endpoint = fileCount > 1 ? `${API}/documents/batch` : `${API}/documents`;
                        setBusy(true, fileCount > 1 ? `正在导入 ${fileCount} 个文档...` : '正在导入文档...');
                        try {
                            const data = await fetchJson(endpoint, { method: 'POST', body: formData });
                            if (fileCount > 1) {
                                const created = Array.isArray(data.created) ? data.created : [];
                                const failed = Array.isArray(data.failed) ? data.failed : [];
                                state.activeId = created[0]?.document?.id || state.activeId || '';
                                const hasIssues = failed.length > 0 || created.some(c => c.duplicateOf);
                                if (hasIssues) {
                                    showImportResult(created, failed);
                                }
                                toast(`已导入 ${created.length} 个文档${failed.length ? `，${failed.length} 个失败` : ''}`, failed.length ? 'warning' : undefined);
                            } else {
                                state.activeId = data.document?.id || '';
                                if (data.duplicateOf) {
                                    toast(`文档已导入（疑似重复：${data.duplicateOf.title || '已有同源文档'}）`, 'warning');
                                } else {
                                    toast('文档已导入');
                                }
                            }
                            form.reset();
                            syncImportHint(form);
                            closeDialogs();
                            await loadDocuments({ keepActive: true, page: 1 });
                        } catch (e) {
                            toast(e.message || '导入失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    function showImportResult(created, failed) {
                        const panel = document.getElementById('regulations-import-result-panel');
                        const body = document.getElementById('regulations-import-result-body');
                        if (!panel || !body) return;
                        const createdHtml = created.length ? `
                            <div class="regulations-import-section">
                                <div class="regulations-section-head compact"><strong>已导入</strong><span>${created.length} 个</span></div>
                                ${created.map(item => {
                                    const dup = item.duplicateOf ? `<span class="regulations-badge warning">疑似重复：${esc(item.duplicateOf.title || '已有同源')}</span>` : '';
                                    return `<div class="regulations-import-item success">${esc(item.sourceName || item.document?.title || '文档')} ${dup}</div>`;
                                }).join('')}
                            </div>
                        ` : '';
                        const failedHtml = failed.length ? `
                            <div class="regulations-import-section">
                                <div class="regulations-section-head compact"><strong>失败</strong><span>${failed.length} 个</span></div>
                                ${failed.map(item => `
                                    <div class="regulations-import-item error">
                                        <strong>${esc(item.fileName || '文件')}</strong>
                                        <span>${esc(item.message || '导入失败')}</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : '';
                        PivotSafeHtml.setHtml(body, createdHtml + failedHtml);
                        panel.classList.remove('hidden');
                    }

                    async function saveMetadata(form) {
                        const docId = form.dataset.docId;
                        const payload = collectForm(form);
                        setBusy(true, '正在保存法规信息...');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(docId)}`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            });
                            toast('法规信息已保存');
                            closeInlineForms();
                            await loadDocuments({ keepActive: true, page: state.page });
                            await loadDetail(docId);
                        } catch (e) {
                            toast(e.message || '保存失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function uploadVersion(form) {
                        const docId = form.dataset.docId;
                        const fileInput = form.querySelector('input[type="file"]');
                        if (!fileInput?.files?.length) {
                            toast('请选择新版本文件', 'warning');
                            return;
                        }
                        const formData = new FormData(form);
                        setBusy(true, '正在上传新版本...');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/versions`, { method: 'POST', body: formData });
                            toast('新版本已上传');
                            form.reset();
                            syncFileInputState(fileInput);
                            closeInlineForms();
                            await loadDocuments({ keepActive: true, page: state.page });
                            await loadDetail(docId);
                        } catch (e) {
                            toast(e.message || '上传版本失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function archiveDocument(id) {
                        if (!id) return;
                        if (!(await regulationConfirm('删除法规文档', '确定删除该法规文档吗？删除后仅管理员可在归档列表中查看。'))) return;
                        setBusy(true, '正在删除法规文档...');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
                            toast('法规文档已删除');
                            state.activeId = '';
                            state.detail = null;
                            document.getElementById('regulations-detail-panel')?.classList.add('hidden');
                            await loadDocuments({ keepActive: false, page: 1 });
                        } catch (e) {
                            toast(e.message || '删除失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function askAi() {
                        const question = document.getElementById('regulations-ai-question')?.value.trim() || '';
                        if (!question) {
                            toast('请输入要咨询的问题', 'warning');
                            return;
                        }
                        state.aiBusy = true;
                        const modelSelector = document.getElementById('regulations-ai-model');
                        if (modelSelector) modelSelector.disabled = true;
                        renderAiAnswer();
                        setBusy(true, '正在生成回答...');
                        try {
                            // 多轮问答：携带最近 4 轮历史，每轮仍做全库检索
                            const history = state.aiTurns.slice(-4).map(t => ({ question: t.question, answer: t.answer }));
                            const model = getRegulationsSelectedModelId() || undefined;
                            const data = await fetchJson(`${API}/ai`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ query: question, limit: 8, history, model })
                            });
                            const answer = data.content || data.answer || '';
                            const sources = Array.isArray(data.sources) ? data.sources : [];
                            state.aiTurns.push({ question, answer, sources });
                        } catch (e) {
                            toast(e.message || 'AI 回答失败', 'error');
                        } finally {
                            state.aiBusy = false;
                            if (modelSelector) modelSelector.disabled = !modelSelector.value;
                            setBusy(false);
                            renderAiAnswer();
                        }
                    }

                    async function loadFacets() {
                        try {
                            const data = await fetchJson(`${API}/facets${canManage() && state.filters.includeArchived ? '?includeArchived=true' : ''}`);
                            state.facets.categories = Array.isArray(data.categories) ? data.categories : [];
                            state.facets.jurisdictions = Array.isArray(data.jurisdictions) ? data.jurisdictions : [];
                            const catList = document.getElementById('regulations-category-list');
                            const jurList = document.getElementById('regulations-jurisdiction-list');
                            if (catList) PivotSafeHtml.setHtml(catList, state.facets.categories.map(c => `<option value="${esc(c)}">`).join(''));
                            if (jurList) PivotSafeHtml.setHtml(jurList, state.facets.jurisdictions.map(j => `<option value="${esc(j)}">`).join(''));
                        } catch (_e) {
                            // facets 失败不影响主流程
                        }
                    }

                    function clearAiTurns() {
                        state.aiTurns = [];
                        renderAiAnswer();
                    }

                    // #4 引用网络：拉取条文引用图并用轻量 SVG 渲染（环形布局，无第三方库）

        Object.assign(ns, {
            uploadDocument,
            showImportResult,
            saveMetadata,
            uploadVersion,
            archiveDocument,
            askAi,
            loadFacets,
            clearAiTurns,
            actionsImportReady: true
        });
    }
})();
