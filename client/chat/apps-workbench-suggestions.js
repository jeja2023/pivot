// 建议与来源视图只渲染明确状态；已处理条目不再提供重复采纳动作。
function renderOfficialWritingSuggestions() {
    const list = document.getElementById('official-writing-suggestion-list');
    const suggestions = officialWritingState.suggestions || [];
    setText('official-writing-suggestion-count', suggestions.filter(item => item.status === 'pending').length + ' 条待处理');
    if (!list) return;
    const labels = { pending: '待处理', accepted: '已采纳', rejected: '已忽略', stale: '原文已变化' };
    const markup = suggestions.map(item => {
        const pending = item.status === 'pending';
        const apply = pending && item.canApply && !item.partial;
        const original = item.original ? `<p class="official-writing-suggestion-original">${escapeAppsHtml(item.original)}</p>` : '';
        const replacement = item.replacement ? `<p class="official-writing-suggestion-text">${escapeAppsHtml(item.replacement)}</p>` : '';
        const primary = apply
            ? '<button class="btn-primary" type="button" data-suggestion-action="replace">采纳修改</button><button class="btn-secondary" type="button" data-suggestion-action="preview">预览</button>'
            : '<button class="btn-secondary" type="button" data-suggestion-action="comment">转为批注</button>';
        const actions = pending ? `<div class="official-writing-suggestion-actions">${primary}<button class="btn-secondary" type="button" data-suggestion-action="reject">忽略</button></div>` : '';
        return `<article class="official-writing-suggestion-item" data-suggestion-id="${escapeAppsHtml(item.id)}"><div><strong>${escapeAppsHtml(item.title || '审校意见')}</strong><span>${labels[item.status] || '待处理'}</span></div>${original}<p>${escapeAppsHtml(item.detail || '')}</p>${replacement}${actions}</article>`;
    }).join('');
    const empty = officialWritingAiBusy ? 'AI 正在审校…' : officialWritingState.review?.status === 'complete' ? 'AI 审校已完成，当前没有待处理意见。' : '暂无意见，请点击开始审校。';
    PivotSafeHtml.setHtml(list, markup || `<div class="official-writing-empty-note">${empty}</div>`);
}

function renderOfficialWritingReferences() {
    const list = document.getElementById('official-writing-reference-list');
    if (!list) return;
    const references = officialWritingState.references || [];
    const labels = { current: '来源有效', changed: '来源已变化', unavailable: '来源不可访问', snapshot: '导入快照' };
    setText('official-writing-reference-count', references.length + ' 条来源');
    PivotSafeHtml.setHtml(list, references.map(ref => {
        const location = [ref.page ? '页码 ' + ref.page : '', ref.version ? '版本 ' + ref.version : '', ref.chunkId ? '片段 ' + ref.chunkId : ''].filter(Boolean).join(' · ');
        return `<article class="official-writing-reference-item"><strong>${escapeAppsHtml(ref.source || '本篇材料')}</strong><span>${escapeAppsHtml(location)}</span><p>${labels[ref.sourceStatus] || '待核对来源'}</p><p>${escapeAppsHtml(compactTextPreview(ref.content, 200))}</p><button class="btn-secondary" type="button" data-official-writing-reference-remove="${escapeAppsHtml(ref.id)}">移除依据</button><button class="btn-secondary" type="button" data-official-writing-reference-view="${escapeAppsHtml(ref.id)}">查看来源</button></article>`;
    }).join('') || '<div class="official-writing-empty-note">可在写作资源中检索并选择知识库依据，或上传材料。文本相似度仅供定位，不能代替事实核验。</div>');
}
