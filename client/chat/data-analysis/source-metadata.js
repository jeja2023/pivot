(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling, { esc } = app;
    const choices = [['full', '全量'], ['incremental', '增量（尚非全量合并）'], ['partial', '部分'], ['unknown', '未知']];
    function markup(prefix, value = {}) {
        return `<label>业务批次（可选，多来源可填写共同批次）<input class="form-input" name="${prefix}_batch" maxlength="128" value="${esc(value.inputBatchId || '')}"></label><label>业务期间（可选，例如 2026-10）<input class="form-input" name="${prefix}_period" maxlength="80" value="${esc(value.businessPeriod || '')}"></label><label>数据截止时间（可选，含时区）<input class="form-input" name="${prefix}_cutoff" maxlength="40" value="${esc(value.dataUpdatedAt || '')}" placeholder="2026-11-07T08:00:00+08:00"></label><label>业务数据覆盖范围<select class="form-input" name="${prefix}_coverage">${choices.map(([key, title]) => `<option value="${key}"${(value.coverage || 'full') === key ? ' selected' : ''}>${esc(title)}</option>`).join('')}</select></label><p class="text-muted">批次与业务期间按填写值精确匹配。截止时间应反映上游业务数据；不填时保留原数据时间。增量、部分和未知数据需在模型中声明部分分析。</p>`;
    }
    function read(form, prefix) {
        const value = name => form.elements.namedItem(`${prefix}_${name}`).value.trim();
        return { inputBatchId: value('batch'), businessPeriod: value('period'), dataUpdatedAt: value('cutoff'), coverage: value('coverage') };
    }
    function fill(form, prefix, metadata = {}) {
        for (const [name, value] of [['batch', metadata.inputBatchId], ['period', metadata.businessPeriod], ['cutoff', metadata.dataUpdatedAt], ['coverage', metadata.coverage || 'full']]) form.elements.namedItem(`${prefix}_${name}`).value = value || '';
    }
    async function openSourceMetadata() {
        const datasetId = app.currentGovernanceDatasetId();
        if (!datasetId) throw new Error('请先选择治理数据集，再查看或补录来源业务信息。');
        const userId = m.owner(), current = m.capture('source-metadata');
        const { source } = await m.request(`/datasets/${encodeURIComponent(datasetId)}/source-metadata`);
        if (!current() || m.owner() !== userId || app.currentGovernanceDatasetId() !== datasetId) return;
        m.dialog('来源业务信息', `<p class="text-muted">当前来源修订 ${esc(source.sourceRevision)}。保存会生成新的不可变数据版本；已发布清单保留原业务水位，需要检查或刷新后再切换。</p>${markup('source_metadata', source.metadata)}`, async form => {
            if (m.owner() !== userId) throw new Error('当前账号已变化，请重新打开来源信息。');
            if (!source.canEdit) throw new Error('只有数据集所有者可以修改来源业务信息。');
            await m.request(`/datasets/${encodeURIComponent(datasetId)}/source-metadata`, m.json({ expectedSourceRevision: source.sourceRevision, metadata: read(form, 'source_metadata') }, 'PUT'));
            if (m.owner() !== userId) return;
            await app.loadDatasets({ keepActive: true });
            app.toast('来源业务信息已保存到新数据版本，请重新检查或刷新受影响模型。', 'success');
        });
        const form = document.getElementById('modeling-dialog-form');
        form.querySelector('[type="submit"]').textContent = '保存新版本';
        if (!source.canEdit) form.querySelectorAll('input,select,[type="submit"]').forEach(control => { control.disabled = true; });
    }
    document.addEventListener('click', event => {
        if (event.target.closest('#data-analysis-source-metadata')) void openSourceMetadata().catch(error => app.toast(error.message, 'error'));
    });
    app.sourceMetadata = { markup, read, fill };
})();
