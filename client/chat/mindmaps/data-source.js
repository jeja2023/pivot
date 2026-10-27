(function () {
    'use strict';
    function create(context) {
        const { dialog, closeDialog, request, json, escape } = context;
        const $ = id => document.getElementById(id);
        let sources = [];
        let selected;
        let preview;
        let generation = 0;

        return {
            stop() { generation++; sources = []; selected = null; preview = null; },
            async action(name) {
                const current = ++generation;
                const dialogSequence = context.state.dialogSequence;

                if (name === 'dataset-mapping') {
                    sources = (await request('/data-sources')).rows;
                    if (current !== generation || context.state.dialogSequence !== dialogSequence) return true;
                    const hasSources = sources.length > 0;
                    const modalHtml = `
<div class="mm-modal-form mm-dataset-modal">
    <div class="mm-config-notice">
        <svg class="mm-config-notice-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <div class="mm-config-notice-text">
            可使用本人或有权限读取的共享数据。受限字段不会出现在映射选项中。
        </div>
    </div>

    <div class="mm-form-field">
        <div class="mm-field-label-row">
            <label class="mm-field-label" for="mindmap-source-dataset">
                <span class="mm-label-text">数据集</span>
            </label>
            <span class="mm-label-hint">${hasSources ? `共 ${sources.length} 个可用数据集` : '暂无可读取数据集'}</span>
        </div>
        <div class="mm-select-wrap">
            <svg class="mm-select-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
            <select class="form-input mm-modal-select mm-select-has-icon" id="mindmap-source-dataset">
                ${sources.map(source => `<option value="${escape(source.id)}">${escape(source.name)}</option>`).join('')}
            </select>
        </div>
    </div>

    <div class="mm-dataset-feature-strip">
        <div class="mm-feature-chip">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            <span>最多 5 层维度聚合</span>
        </div>
        <div class="mm-feature-chip">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            <span>记录数与数值度量</span>
        </div>
        <div class="mm-feature-chip">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            <span>支持打开自动同步</span>
        </div>
    </div>

    <div class="mm-modal-footer">
        <span class="mm-footer-hint">选定数据集后进行维度与度量映射</span>
        <div class="mm-footer-btns">
            <button type="button" class="btn-secondary mm-modal-cancel" data-mm-action="dialog-close">取消</button>
            <button class="btn-primary mm-modal-submit" type="button" data-mm-action="dataset-configure"${hasSources ? '' : ' disabled'}>
                <span>配置层级</span>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
        </div>
    </div>
</div>`;
                    void dialog('从数据集生成导图', modalHtml, { hideClose: true });
                    return true;
                }

                if (name === 'dataset-configure') {
                    selected = sources.find(source => source.id === $('mindmap-source-dataset').value);
                    if (!selected) throw new Error('请选择有效数据集。');
                    const fields = selected.columns.map(field => `<option value="${escape(field.key)}">${escape(field.name)}</option>`).join('');
                    const modalHtml = `
<div class="mm-modal-form mm-levels-modal">
    <div class="mm-config-notice">
        <svg class="mm-config-notice-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <div class="mm-config-notice-text">
            维度按从上到下的顺序生成层级。自动刷新会在当前导图打开时每分钟检查来源，并替换生成的分支，请使用副本进行独立创作。
        </div>
    </div>

    <div class="mm-config-section">
        <div class="mm-config-header">
            <span class="mm-config-title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                <span>维度层级树（自顶向下）</span>
            </span>
            <span class="mm-config-badge">最多可选 5 层</span>
        </div>
        <div class="mm-levels-grid">
            <div class="mm-form-field">
                <div class="mm-field-label-row">
                    <label class="mm-field-label" for="mindmap-source-level-1">
                        <span class="mm-label-text">第 1 层维度</span>
                    </label>
                    <span class="mm-badge-req">必选</span>
                </div>
                <select class="form-input mm-modal-select" id="mindmap-source-level-1">
                    <option value="">请选择</option>
                    ${fields}
                </select>
            </div>
            <div class="mm-form-field">
                <div class="mm-field-label-row">
                    <label class="mm-field-label" for="mindmap-source-level-2">
                        <span class="mm-label-text">第 2 层维度</span>
                    </label>
                    <span class="mm-label-hint">可选</span>
                </div>
                <select class="form-input mm-modal-select" id="mindmap-source-level-2">
                    <option value="">不使用</option>
                    ${fields}
                </select>
            </div>
            <div class="mm-form-field">
                <div class="mm-field-label-row">
                    <label class="mm-field-label" for="mindmap-source-level-3">
                        <span class="mm-label-text">第 3 层维度</span>
                    </label>
                    <span class="mm-label-hint">可选</span>
                </div>
                <select class="form-input mm-modal-select" id="mindmap-source-level-3">
                    <option value="">不使用</option>
                    ${fields}
                </select>
            </div>
            <div class="mm-form-field">
                <div class="mm-field-label-row">
                    <label class="mm-field-label" for="mindmap-source-level-4">
                        <span class="mm-label-text">第 4 层维度</span>
                    </label>
                    <span class="mm-label-hint">可选</span>
                </div>
                <select class="form-input mm-modal-select" id="mindmap-source-level-4">
                    <option value="">不使用</option>
                    ${fields}
                </select>
            </div>
            <div class="mm-form-field">
                <div class="mm-field-label-row">
                    <label class="mm-field-label" for="mindmap-source-level-5">
                        <span class="mm-label-text">第 5 层维度</span>
                    </label>
                    <span class="mm-label-hint">可选</span>
                </div>
                <select class="form-input mm-modal-select" id="mindmap-source-level-5">
                    <option value="">不使用</option>
                    ${fields}
                </select>
            </div>
            <div class="mm-dimension-hint-box">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>
                <span>未选中的层级将自动跳过，不影响生成已选的上级分支。</span>
            </div>
        </div>
    </div>

    <div class="mm-config-section">
        <div class="mm-config-header">
            <span class="mm-config-title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>
                <span>指标度量与聚合控制</span>
            </span>
        </div>
        <div class="mm-metric-grid">
            <div class="mm-form-field">
                <label class="mm-field-label" for="mindmap-source-aggregation">
                    <span class="mm-label-text">统计方式</span>
                </label>
                <select class="form-input mm-modal-select" id="mindmap-source-aggregation">
                    <option value="count">记录数</option>
                    <option value="sum">求和</option>
                    <option value="avg">平均</option>
                    <option value="min">最小值</option>
                    <option value="max">最大值</option>
                </select>
            </div>
            <div class="mm-form-field">
                <label class="mm-field-label" for="mindmap-source-metric">
                    <span class="mm-label-text">度量字段</span>
                </label>
                <select class="form-input mm-modal-select" id="mindmap-source-metric">
                    <option value="">记录数无需选择</option>
                    ${fields}
                </select>
            </div>
            <div class="mm-form-field">
                <label class="mm-field-label" for="mindmap-source-limit">
                    <span class="mm-label-text">最大组数</span>
                </label>
                <input class="form-input mm-modal-input" type="number" min="1" max="500" value="100" id="mindmap-source-limit">
            </div>
        </div>
    </div>

    <label class="mm-sync-toggle-card">
        <input type="checkbox" id="mindmap-source-auto">
        <div class="mm-sync-toggle-info">
            <span class="mm-sync-toggle-title">打开时自动刷新数据分支</span>
            <span class="mm-sync-toggle-desc">开启后，打开当前导图时自动同步数据源并替换分支</span>
        </div>
    </label>

    <div class="mm-modal-footer">
        <button type="button" class="btn-secondary mm-modal-back-btn" data-mm-action="dataset-mapping">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            <span>重选数据集</span>
        </button>
        <div class="mm-footer-btns">
            <button type="button" class="btn-secondary mm-modal-cancel" data-mm-action="dialog-close">取消</button>
            <button class="btn-primary mm-modal-submit" type="button" data-mm-action="dataset-preview">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>生成预览</span>
            </button>
        </div>
    </div>
</div>`;
                    void dialog('配置数据层级', modalHtml, { hideClose: true });
                    return true;
                }

                if (name === 'dataset-preview') {
                    const dimensions = [1, 2, 3, 4, 5].map(index => $(`mindmap-source-level-${index}`).value).filter(Boolean);
                    const input = {
                        datasetId: selected.id,
                        mapping: {
                            dimensions,
                            aggregation: $('mindmap-source-aggregation').value,
                            metric: $('mindmap-source-metric').value,
                            limit: Number($('mindmap-source-limit').value)
                        },
                        refreshMode: $('mindmap-source-auto').checked ? 'auto' : 'manual'
                    };
                    preview = (await request('/from-dataset', json(input))).document;
                    if (current !== generation || context.state.dialogSequence !== dialogSequence) return true;
                    const modalHtml = `
<div class="mm-modal-form mm-dataset-preview-modal">
    <div class="mm-config-notice">
        <svg class="mm-config-notice-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
        </svg>
        <div class="mm-config-notice-text">
            ${escape(preview.source.description)}
        </div>
    </div>

    <div class="mm-form-field">
        <div class="mm-field-label-row">
            <span class="mm-label-text">数据大纲预览</span>
            <span class="mm-label-hint">结构核对</span>
        </div>
        <pre class="mm-ai-preview-pre">${escape(window.Pivot.moduleApi('mindmaps.document').markdown(preview))}</pre>
    </div>

    <div class="mm-modal-footer">
        <button type="button" class="btn-secondary mm-modal-back-btn" data-mm-action="dataset-configure">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            <span>返回调整层级</span>
        </button>
        <div class="mm-footer-btns">
            <button type="button" class="btn-secondary mm-modal-cancel" data-mm-action="dialog-close">取消</button>
            <button class="btn-primary mm-modal-submit" type="button" data-mm-action="dataset-save">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                <span>保存为个人导图</span>
            </button>
        </div>
    </div>
</div>`;
                    void dialog('核对数据导图', modalHtml, { hideClose: true });
                    return true;
                }

                if (name === 'dataset-save') {
                    if (!preview) throw new Error('请先生成预览。');
                    await context.create(preview);
                    preview = null;
                    closeDialog();
                    return true;
                }
                return false;
            }
        };
    }
    window.Pivot.exposeModule('mindmaps.dataSource', { create });
})();
