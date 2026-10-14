(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderBatchReady) return;

    const { canManage, canDeleteDocuments } = ns;

    function renderBatchToolbar() {
        if (!canManage()) return '';
        return `<div id="regulations-batch-actions" class="workspace-toolbar regulations-toolbar regulations-batch-actions hidden" role="group" aria-label="法规批量操作">
            <span id="regulations-selected-count" aria-live="polite">已选 0 项</span>
            <span class="regulations-batch-scope-hint">选择会跨页保留；表头复选框仅操作当前页</span>
            <button id="regulations-select-folder-btn" class="btn-secondary" type="button" disabled>全选当前范围</button>
            <button id="regulations-governance-batch-action-btn" class="btn-primary hidden" type="button" disabled>处理选中待办</button>
            <button id="regulations-reindex-scope-btn" class="btn-secondary" type="button" disabled>重建当前范围向量</button>
            <button id="regulations-clear-selection-btn" class="btn-secondary" type="button" disabled>取消选择</button>
            <button id="regulations-batch-edit-btn" class="btn-secondary" type="button" disabled>批量修改</button>
            ${canDeleteDocuments() ? '<button id="regulations-batch-delete-btn" class="btn-secondary btn-danger-outline" type="button" disabled>批量删除</button>' : ''}
        </div>`;
    }

    function renderBatchField(key, label, input) {
        return `<div class="regulations-batch-field">
            <label class="regulations-checkline"><input type="checkbox" data-regulation-batch-field="${key}"><span>修改${label}</span></label>
            ${input}
        </div>`;
    }

    function renderBatchDialogs() {
        if (!canManage()) return '';
        return `
            <section id="regulations-batch-edit-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-batch-edit-title">
                <div class="workspace-modal regulations-admin-dialog">
                    <div class="workspace-modal-header">
                        <div><h3 id="regulations-batch-edit-title">批量修改法规信息</h3><p id="regulations-batch-edit-count"></p></div>
                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-batch-edit>关闭</button>
                    </div>
                    <form id="regulations-batch-edit-form" class="workspace-modal-body regulations-admin-form">
                        <div class="regulations-admin-group">
                            <div class="regulations-admin-group-head">
                                <strong>批量修改字段</strong>
                                <span>未勾选字段保留原值；已勾选文本字段留空会清除原值</span>
                            </div>
                            <div class="regulations-admin-grid">
                                ${renderBatchField('category', '分类', '<input name="category" class="form-input" maxlength="120" list="regulations-category-list" aria-label="批量分类" placeholder="如：法律、行政法规" disabled>')}
                                ${renderBatchField('legalLevel', '法规层级', '<input name="legalLevel" class="form-input" maxlength="80" list="regulations-legal-level-list" aria-label="批量法规层级" placeholder="如：法律、行政法规" disabled>')}
                                ${renderBatchField('issuingBody', '发布机构（可多个）', '<input name="issuingBody" class="form-input" maxlength="120" aria-label="批量发布机构" placeholder="如：最高人民法院、最高人民检察院" disabled>')}
                                ${renderBatchField('jurisdiction', '适用范围', '<input name="jurisdiction" class="form-input" maxlength="120" list="regulations-jurisdiction-list" aria-label="批量适用范围" placeholder="如：全国" disabled>')}
                                ${renderBatchField('officialSourceUrl', '权威来源地址', '<input name="officialSourceUrl" class="form-input" maxlength="1000" aria-label="批量权威来源地址" placeholder="如：https://www.gov.cn/..." disabled>')}
                                ${renderBatchField('maintainerUserId', '维护人', '<select name="maintainerUserId" class="form-input" aria-label="批量维护人" disabled><option value="">未指派</option></select>')}
                                ${renderBatchField('metadataReviewStatus', '元数据审核状态', '<select name="metadataReviewStatus" class="form-input" aria-label="批量元数据审核状态" disabled><option value="unreviewed">待审核</option><option value="approved">已审核</option><option value="rejected">驳回</option></select>')}
                                ${renderBatchField('effectStatus', '效力状态', '<select name="effectStatus" class="form-input" aria-label="批量效力状态" disabled><option value="unverified">待核验</option><option value="pending">待生效</option><option value="effective">现行有效</option><option value="expired">已失效</option><option value="repealed">已废止</option></select>')}
                                ${renderBatchField('reviewStatus', '版本审核状态', '<select name="reviewStatus" class="form-input" aria-label="批量版本审核状态" disabled><option value="pending">待审核</option><option value="approved">已审核</option><option value="rejected">驳回</option></select>')}
                                ${renderBatchField('status', '状态', '<select name="status" class="form-input" aria-label="批量状态" disabled><option value="active">启用</option><option value="archived">归档</option></select>')}
                            </div>
                        </div>
                        <div class="regulations-admin-actions">
                            <button class="btn-secondary" type="button" data-regulations-close-batch-edit>取消</button>
                            <button id="regulations-batch-save-btn" class="btn-primary" type="submit" disabled>应用修改</button>
                        </div>
                    </form>
                </div>
            </section>
            <section id="regulations-batch-result-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-batch-result-title">
                <div class="workspace-modal regulations-admin-dialog">
                    <div class="workspace-modal-header">
                        <h3 id="regulations-batch-result-title">批量处理结果</h3>
                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-batch-result>关闭</button>
                    </div>
                    <div id="regulations-batch-result-body" class="workspace-modal-body"></div>
                </div>
            </section>`;
    }

    Object.assign(ns, { renderBatchToolbar, renderBatchDialogs, renderBatchReady: true });
})();
