(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    app.dataModelPanelMarkup = `
<!-- 跨数据集模型管理弹窗 -->
<div id="data-analysis-model-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-modal-size-840">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
        <div>
            <h3>跨数据集关联模型管理</h3>
            <p class="data-analysis-modal-subtitle">跨表多源关联，支持一对多、多对一关联质量校验与预览。</p>
        </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div class="data-analysis-governance-grid data-analysis-modal-mb-16">
        <div>
            <span class="data-analysis-subheading">已定义模型列表</span>
            <div id="data-analysis-models" class="data-analysis-asset-list data-analysis-modal-scroll-200"></div>
        </div>
        <div>
            <div id="data-analysis-model-relation-panel" class="data-analysis-model-relation-panel hidden data-analysis-modal-divider-clean">
                <div class="data-analysis-model-relation-subhead">
                    <h6 id="data-analysis-model-relation-title">模型关联</h6>
                    <button id="data-analysis-open-relation" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-relation-modal">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        <span>配置关联</span>
                    </button>
                </div>
                <div id="data-analysis-model-relations" class="data-analysis-asset-list data-analysis-modal-scroll-180-plain"></div>
                <div class="data-analysis-inline-actions">
                    <button id="data-analysis-model-edit" class="btn-secondary btn-sm" type="button">修改模型信息</button>
                    <button id="data-analysis-model-delete" class="btn-danger btn-sm" type="button">删除模型</button>
                </div>
                <div class="data-analysis-modal-form-grid">
                    <label><span class="data-analysis-label-title">分组字段</span><select id="data-analysis-model-dimension" class="form-input"></select></label>
                    <label><span class="data-analysis-label-title">数值字段</span><select id="data-analysis-model-measure" class="form-input"></select></label>
                    <label><span class="data-analysis-label-title">汇总方式</span><select id="data-analysis-model-aggregation" class="form-input"><option value="count">计数</option><option value="sum">求和</option><option value="avg">平均</option><option value="min">最小值</option><option value="max">最大值</option></select></label>
                    <button id="data-analysis-model-analyze" class="btn-primary" type="button">运行跨表汇总</button>
                </div>
                <div id="data-analysis-model-query-result" class="data-analysis-calc-preview-result"></div>
            </div>
        </div>
            </div>
            <div class="data-analysis-modal-divider">
        <span id="data-analysis-model-form-title" class="data-analysis-subheading">新建跨数据集模型</span>
        <button id="data-analysis-model-form-reset" class="btn-secondary btn-sm" type="button">清空并新建模型</button>
        <div class="data-analysis-model-form data-analysis-modal-form-grid">
            <label class="grid-span-full">
                <span class="data-analysis-label-title">模型名称 <span class="required">*</span></span>
                <input id="data-analysis-model-name" class="form-input" maxlength="120" placeholder="例如：订单与客户多维分析模型">
            </label>
            <label class="grid-span-full">
                <span class="data-analysis-label-title">模型用途说明</span>
                <input id="data-analysis-model-description" class="form-input" maxlength="500" placeholder="模型业务背景与分析目标说明">
            </label>
        </div>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-model-modal">取消</button>
            <button id="data-analysis-model-create" class="btn-primary" type="button">创建模型</button>
        </div>
    </div>
</div>

<!-- 模型关联配置弹窗 -->
<div id="data-analysis-relation-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-modal-size-620">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>
        <div>
                    <h3>配置跨数据集关联关系</h3>
                    <p class="data-analysis-modal-subtitle">设定主外键与 Join 关联规则，校验跨表连接正确性。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div class="data-analysis-relation-form data-analysis-modal-form-grid">
                <label>
                    <span class="data-analysis-label-title">左侧数据集</span>
                    <select id="data-analysis-relation-left-dataset" class="form-input"></select>
                </label>
                <label>
                    <span class="data-analysis-label-title">左侧主键/关联字段</span>
                    <select id="data-analysis-relation-left-field" class="form-input"></select>
                </label>
                <label>
                    <span class="data-analysis-label-title">右侧数据集</span>
                    <select id="data-analysis-relation-right-dataset" class="form-input"></select>
                </label>
                <label>
                    <span class="data-analysis-label-title">右侧外键/关联字段</span>
                    <select id="data-analysis-relation-right-field" class="form-input"></select>
                </label>
                <label>
                    <span class="data-analysis-label-title">关联类型 (Join)</span>
                    <select id="data-analysis-relation-join-type" class="form-input">
                        <option value="left">左关联 (LEFT JOIN)</option>
                        <option value="inner">内关联 (INNER JOIN)</option>
                    </select>
                </label>
                <label>
                    <span class="data-analysis-label-title">对应基数 (Cardinality)</span>
                    <select id="data-analysis-relation-cardinality" class="form-input">
                        <option value="many_to_one">多对一 (Many to One)</option>
                        <option value="one_to_many">一对多 (One to Many)</option>
                        <option value="one_to_one">一对一 (One to One)</option>
                        <option value="many_to_many">多对多 (Many to Many)</option>
                    </select>
                </label>
            </div>
            <div id="data-analysis-relation-quality" class="data-analysis-calc-preview-result" role="status"></div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-relation-modal">取消</button>
            <button id="data-analysis-model-relation-run" class="btn-secondary" type="button">检查关联质量</button>
            <button id="data-analysis-model-relation-save" class="btn-primary" type="button">保存关联</button>
        </div>
    </div>
</div>

`;
})();
