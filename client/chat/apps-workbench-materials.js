// 复用统一文档处理任务；任务编号随公文保存，刷新后可继续查看导入结果。
const officialWritingMaterialTasks = new Map();

function addOfficialWritingMaterial(doc, name, content, provenance = {}) {
    if (!doc?._loaded || doc._owner !== getOfficialWritingOwner() || officialWritingDeletedDocumentIds.has(doc.id)) return;
    const body = String(content || '').trim();
    if (!body) throw new Error('文件未提取到可用文字，请检查扫描件或 OCR 配置');
    const id = provenance.id || `material-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if ((doc.state.references || []).some(ref => ref.id === id)) return;
    if ((doc.state.references || []).length >= 100) throw new Error('本篇材料来源已达上限，请移除不需要的依据后重试');
    const block = `【材料：${name}】\n${body}`;
    const editorCard = document.getElementById('official-writing-material-editor-card');
    const editor = document.getElementById('official-writing-material-editor');
    const editing = doc.id === officialWritingLibrary.activeId && editorCard && !editorCard.classList.contains('hidden');
    const currentSource = editing ? editor?.value ?? doc.state.source : doc.state.source;
    const next = [currentSource, block].filter(Boolean).join('\n\n');
    if (officialWritingDocument.bytes({ ...doc.state, source: next }) > 3 * 1024 * 1024) throw new Error('导入后正文与材料过大，请精简材料后再试');
    if (doc.id === officialWritingLibrary.activeId) pushOfficialWritingUndoSnapshot();
    doc.state.source = next;
    doc.state.references ||= [];
    doc.state.references.push({ id, source: name, content: body, addedAt: new Date().toISOString(), ...provenance });
    if (doc.id === officialWritingLibrary.activeId) { setOfficialWritingTextareaValue('source', next); syncOfficialWritingMaterialEditor(next, { force: true }); renderOfficialWritingWorkspace(); }
    void scheduleOfficialWritingDocumentSave(doc, { immediate: true });
}

async function pollOfficialWritingMaterial(doc, entry) {
    const key = `${doc.id}:${entry.id}`;
    if (officialWritingMaterialTasks.has(key)) return;
    const owner = getOfficialWritingOwner();
    officialWritingMaterialTasks.set(key, true);
    try {
        for (let attempt = 0; attempt < 160; attempt++) {
            if (owner !== getOfficialWritingOwner() || officialWritingDeletedDocumentIds.has(doc.id)) return;
            const response = await apiFetch(`${API_BASE}/apps/document-processing/jobs/${encodeURIComponent(entry.id)}`);
            const data = await response.json();
            if (owner !== getOfficialWritingOwner()) return;
            if (!response.ok) throw new Error(data.error || '读取材料解析结果失败');
            const status = data.job?.status;
            entry.status = status;
            if (['failed', 'cancelled'].includes(status)) throw new Error(data.job.errorMessage || '材料解析未完成，可在文字识别应用中检查任务');
            if (['succeeded', 'partial_success', 'needs_review'].includes(status)) {
                const pages = data.pages || [];
                const body = pages.map(page => page.effectiveText || page.text || page.rawText || '').filter(Boolean).join('\n\n')
                    || (data.blocks || []).map(block => block.text || '').filter(Boolean).join('\n');
                addOfficialWritingMaterial(doc, entry.name, body, { id: `job-${entry.id}`, documentId: `document-job:${entry.id}`, page: pages.length ? `1-${pages.length}` : '' });
                entry.status = 'imported'; entry.error = status === 'succeeded' ? '' : '有页面需复核，请核对来源文件';
                void scheduleOfficialWritingDocumentSave(doc, { immediate: true });
                const level = status === 'succeeded' ? 'info' : 'warning';
                showToast(`材料“${entry.name}”已加入${doc.title}`, level);
                return;
            }
            if (doc.id === officialWritingLibrary.activeId) setText('official-writing-material-import-status', `正在解析 ${entry.name}，进度 ${Number(data.job.progress || 0)}%`);
            await new Promise(resolve => setTimeout(resolve, 750));
        }
        entry.error = '任务仍在处理，重新进入本篇公文可继续查看';
    } catch (error) {
        entry.error = error.message || '导入失败，请重试';
        if (owner === getOfficialWritingOwner() && doc.id === officialWritingLibrary.activeId) showToast(`${entry.name}：${entry.error}`, 'error');
    } finally {
        officialWritingMaterialTasks.delete(key);
        void scheduleOfficialWritingDocumentSave(doc, { immediate: true });
        if (doc.id === officialWritingLibrary.activeId) setText('official-writing-material-import-status', entry.error || '材料已加入本篇');
    }
}

function resumeOfficialWritingMaterialJobs(doc) {
    for (const entry of doc.state.imports || []) if (!['imported', 'failed', 'cancelled'].includes(entry.status)) void pollOfficialWritingMaterial(doc, entry);
}

async function importOfficialWritingMaterialFiles(fileList) {
    const files = Array.from(fileList || []).slice(0, 10);
    const doc = getActiveOfficialWritingDoc(), owner = getOfficialWritingOwner();
    if (!doc?._loaded) return;
    syncOfficialWritingStateFromInputs();
    for (const file of files) {
        if (owner !== getOfficialWritingOwner()) return;
        try {
            if (file.size > 10 * 1024 * 1024) throw new Error('单个文件不得超过 10 MiB');
            if (/\.(txt|md|csv|json)$/i.test(file.name)) {
                const buffer = await file.arrayBuffer();
                let text;
                try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
                catch (_) { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
                if (text.includes('\u0000')) throw new Error('文本包含二进制内容，请选择正确的文件类型');
                addOfficialWritingMaterial(doc, file.name, text);
            } else if (/\.(docx?|pdf|png|jpe?g)$/i.test(file.name)) {
                const form = new FormData(); form.append('file', file); form.append('jobType', 'auto');
                form.append('sourceModule', 'official_writing'); form.append('sourceRef', doc.id);
                const response = await apiFetch(`${API_BASE}/apps/document-processing/jobs`, { method: 'POST', body: form });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || '材料上传失败');
                if (owner !== getOfficialWritingOwner()) return;
                const entry = { id: String(data.job.id), name: file.name, status: data.job.status || 'queued', error: '' };
                doc.state.imports ||= []; doc.state.imports.unshift(entry); doc.state.imports = doc.state.imports.slice(0, 20);
                void scheduleOfficialWritingDocumentSave(doc, { immediate: true });
                void pollOfficialWritingMaterial(doc, entry);
            } else throw new Error('支持 TXT、Markdown、CSV、JSON、Word、PDF 和图片');
        } catch (error) { if (owner === getOfficialWritingOwner()) showToast(`${file.name}：${error.message || '读取失败'}`, 'error'); }
    }
}

function recordOfficialWritingRagReference(match) {
    const content = String(match.text || '').trim();
    const id = `rag-${match.documentId || match.document_id || ''}-${match.chunkId || match.chunk_id || ''}-${officialWritingDocument.digest(content)}`;
    officialWritingState.references ||= [];
    if (officialWritingState.references.some(ref => ref.id === id)) return true;
    if (officialWritingState.references.length >= 100) { showToast('本篇材料来源已达上限，请先移除不需要的依据', 'warning'); return false; }
    const citation = /^kb:(\d+):v(\d+):/.exec(String(match.citationKey || ''));
    officialWritingState.references.push({ id, source: String(match.source || '知识库'), content, citationKey: String(match.citationKey || ''),
        documentId: String(citation?.[1] || match.documentId || match.document_id || match.metadata?.documentId || ''),
        chunkId: String(match.chunkId || match.chunk_id || match.id || ''), version: String(citation?.[2] || match.version || match.metadata?.version || ''),
        page: String(match.pageNumber || match.page || match.metadata?.pageNumber || ''), addedAt: new Date().toISOString() });
    saveOfficialWritingState();
    return true;
}

let officialWritingReferenceChecks = new Map();
async function checkOfficialWritingReferenceSources({ previewId = '' } = {}) {
    const doc = getActiveOfficialWritingDoc();
    if (!doc?.state.references?.length) return;
    try {
        if (!await flushOfficialWritingSaves()) throw new Error('请先完成公文保存再核对来源');
        const response = await apiFetch(`${OFFICIAL_WRITING_DOCUMENTS_API}/${encodeURIComponent(doc.id)}/references/check`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '来源检查失败');
        if (doc.id !== officialWritingLibrary.activeId) return;
        officialWritingReferenceChecks = new Map((data.checks || []).map(item => [item.id, item]));
        for (const ref of doc.state.references) {
            ref.sourceStatus = officialWritingReferenceChecks.get(ref.id)?.status || 'unknown';
            ref.checkedAt = new Date().toISOString();
        }
        saveOfficialWritingState(); renderOfficialWritingReferences();
        if (previewId) {
            const ref = doc.state.references.find(item => item.id === previewId), check = officialWritingReferenceChecks.get(previewId);
            if (ref) { openOfficialWritingResultPreview('', ref.content, check?.message || '本篇材料快照'); setText('official-writing-result-text', check?.currentContent || ref.content); }
        } else showToast(data.checks.some(item => ['changed', 'unavailable'].includes(item.status)) ? '有来源已变化或不可访问，请核对后再使用' : '材料来源检查完成', 'info');
    } catch (error) { showToast(error.message || '来源检查失败，可重试', 'error'); }
}

function removeOfficialWritingReference(id) {
    const ref = officialWritingState.references.find(item => item.id === id);
    if (!ref) return;
    const source = officialWritingState.source;
    const start = source.indexOf(ref.content);
    if (start >= 0 && source.indexOf(ref.content, start + 1) >= 0) return showToast('材料存在多处相同文字，请在本篇材料中核对后删除', 'warning');
    pushOfficialWritingUndoSnapshot();
    let next = source;
    for (const prefix of [`【知识库引用：${ref.source}】\n`, `【材料：${ref.source}】\n`]) next = next.replace(prefix + ref.content, '');
    if (next === source && start >= 0) next = source.slice(0, start) + source.slice(start + ref.content.length);
    officialWritingState.references = officialWritingState.references.filter(item => item.id !== id);
    setOfficialWritingTextareaValue('source', next.trim());
    syncOfficialWritingStateFromInputs(); renderOfficialWritingWorkspace();
}
