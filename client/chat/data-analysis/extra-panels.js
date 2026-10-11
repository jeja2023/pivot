(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');

    function openModal(modalId) {
        document.querySelectorAll('.data-analysis-modal-overlay:not(.hidden)').forEach(m => {
            if (m.id !== modalId) m.classList.add('hidden');
        });
        const el = document.getElementById(modalId);
        if (el) {
            el.classList.remove('hidden');
            const firstInput = el.querySelector('input:not([type="hidden"]), select, textarea');
            if (firstInput) setTimeout(() => { try { firstInput.focus(); } catch (_) {} }, 50);
        }
    }

    function closeModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.classList.add('hidden');
    }

    const panels = {
        governance: `
<div class="data-analysis-governance-layout">
    <div class="data-analysis-panel-header">
        <div class="data-analysis-panel-header-left">
            <div class="data-analysis-header-icon-badge">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-4"></path></svg>
            </div>
            <div class="data-analysis-panel-header-intro">
                <div class="data-analysis-title-row">
                    <h5>字段治理工作台</h5>
                    <span class="data-analysis-badge-safe">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                        元数据治理 · 四级权限脱敏隔离
                    </span>
                </div>
                <p>统一维护字段业务含义、度量/维度角色、单位格式和敏感等级；支持计算衍生字段、指标口径、跨数据集关联模型与规模化数据管道。</p>
            </div>
        </div>
        <div class="data-analysis-panel-header-actions">
            <label class="data-analysis-dataset-picker" title="选择治理数据集">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                <span class="data-analysis-picker-label">治理数据集</span>
                <select id="data-analysis-governance-dataset" class="form-input data-analysis-picker-select"></select>
            </label>
            <button id="data-analysis-governance-refresh" class="btn-secondary" type="button" title="刷新治理信息">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                <span>刷新治理信息</span>
            </button>
            <button id="data-analysis-open-share-modal" class="btn-secondary" type="button" data-analysis-modal-trigger="data-analysis-share-modal" title="设置数据集共享范围">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
                <span>共享范围</span>
            </button>
        </div>
    </div>

    <div class="data-analysis-status-strip">
        <div class="data-analysis-status-strip-left">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            <span id="data-analysis-source-state" class="data-analysis-source-state"></span>
        </div>
        <div class="data-analysis-status-strip-actions">
            <button id="data-analysis-open-calc-modal" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-calc-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="8" y1="6" x2="16" y2="6"></line><line x1="16" y1="14" x2="16" y2="18"></line></svg>
                <span>计算字段管理</span>
            </button>
            <button id="data-analysis-open-metric-modal" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-metric-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                <span>业务指标口径</span>
            </button>
            <button id="data-analysis-open-model-modal" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-model-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
                <span>跨表关联模型</span>
            </button>
            <button id="data-analysis-open-scale-modal" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-scalability-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
                <span>规模化数据管道</span>
            </button>
        </div>
    </div>

    <div class="data-analysis-governance-card data-analysis-field-governance-card">
        <div class="data-analysis-governance-card-header">
            <div>
                <div class="data-analysis-card-title-wrap">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                    <h5>字段字典与权限治理</h5>
                </div>
                <p>统一维护显示名、业务类型、度量/维度角色、单位、日期格式和敏感级别（机密/受限字段在共享查询中自动脱敏屏蔽）。</p>
            </div>
            <div class="data-analysis-inline-actions">
                <button id="data-analysis-governance-save" class="btn-primary btn-sm" type="button">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                    <span>保存字段治理</span>
                </button>
            </div>
        </div>
        <div id="data-analysis-field-governance" class="data-analysis-field-governance"></div>
    </div>
</div>

<!-- 计算字段管理弹窗 -->
<div id="data-analysis-calc-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-calc-modal-dialog data-analysis-modal-size-720">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="8" y1="6" x2="16" y2="6"></line><line x1="16" y1="14" x2="16" y2="18"></line></svg>
                <div>
                    <h3>计算字段管理</h3>
                    <p class="data-analysis-modal-subtitle">查看已有计算字段，或基于字段表达式实时演算派生新版本数据集。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div>
                <span class="data-analysis-subheading">已生效计算字段列表</span>
                <div id="data-analysis-calculated-fields" class="data-analysis-asset-list data-analysis-modal-scroll-180"></div>
            </div>
            <div class="data-analysis-modal-divider">
                <span class="data-analysis-subheading">+ 新增计算字段</span>
                <div class="data-analysis-calc-form data-analysis-modal-form-grid">
                    <label>
                        <span class="data-analysis-label-title">字段名称 <span class="required">*</span></span>
                        <input id="data-analysis-calc-name" class="form-input" maxlength="80" placeholder="例如：含税销售额">
                    </label>
                    <label>
                        <span class="data-analysis-label-title">单位</span>
                        <input id="data-analysis-calc-unit" class="form-input" maxlength="40" placeholder="例如：元">
                    </label>
                    <label class="grid-span-full">
                        <span class="data-analysis-label-title">表达式 <span class="required">*</span></span>
                        <textarea id="data-analysis-calc-expression" class="form-input" maxlength="1000" placeholder="例如：{{c_2}} * 1.13"></textarea>
                    </label>
                    <label>
                        <span class="data-analysis-label-title">敏感级别</span>
                        <select id="data-analysis-calc-sensitivity" class="form-input">
                            <option value="internal">内部</option>
                            <option value="public">公开</option>
                            <option value="confidential">机密</option>
                            <option value="restricted">受限</option>
                        </select>
                    </label>
                    <label>
                        <span class="data-analysis-label-title">派生数据集名称</span>
                        <input id="data-analysis-calc-dataset-name" class="form-input" maxlength="120" placeholder="默认：原数据集（含计算字段）">
                    </label>
                </div>
                <div class="data-analysis-inline-actions data-analysis-modal-mt-14">
                    <button id="data-analysis-calc-preview" class="btn-secondary btn-sm" type="button">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        <span>预览计算</span>
                    </button>
                    <button id="data-analysis-calc-create" class="btn-primary btn-sm" type="button">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        <span>生成派生数据集</span>
                    </button>
                </div>
                <div id="data-analysis-calc-preview-result" class="data-analysis-calc-preview-result"></div>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-calc-modal">取消</button>
            <button class="btn-primary" type="button" data-analysis-modal-close="data-analysis-calc-modal">完成</button>
        </div>
    </div>
</div>

<!-- 数据集共享范围弹窗 -->
<div id="data-analysis-share-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
                <div>
                    <h3>数据集共享范围设置</h3>
                    <p class="data-analysis-modal-subtitle">控制当前数据集在部门及团队内的共享与敏感字段隔离策略。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div class="data-analysis-modal-form-col">
                <label class="data-analysis-share-toggle data-analysis-modal-checkbox-row">
                    <input id="data-analysis-dataset-shared" type="checkbox"> 共享给指定部门
                </label>
                <label class="data-analysis-modal-meta-note">
                    共享部门名称
                    <input id="data-analysis-dataset-shared-units" class="form-input" maxlength="500" placeholder="例如：财务部, 运营部（逗号分隔）">
                </label>
                <p class="data-analysis-form-hint">共享数据集时，标记为机密或受限的敏感字段将在被共享用户预览、查询和导出中被自动剔除。</p>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-share-modal">取消</button>
            <button id="data-analysis-dataset-share-save" class="btn-primary" type="button">保存共享范围</button>
        </div>
    </div>
</div>

<!-- 指标口径管理弹窗 -->
<div id="data-analysis-metric-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-modal-size-720">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                <div>
                    <h3>业务指标口径管理</h3>
                    <p class="data-analysis-modal-subtitle">标准化原子指标与聚合口径，供全域复用与看板消费。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div>
                <span class="data-analysis-subheading">已定义指标列表</span>
                <div id="data-analysis-metrics" class="data-analysis-asset-list data-analysis-modal-scroll-180"></div>
            </div>
            <div class="data-analysis-modal-divider">
                <span class="data-analysis-subheading">+ 新建指标口径</span>
                <div class="data-analysis-metric-form data-analysis-modal-form-grid">
                    <label class="grid-span-full">
                        <span class="data-analysis-label-title">指标名称 <span class="required">*</span></span>
                        <input id="data-analysis-metric-name" class="form-input" maxlength="120" placeholder="例如：总销售额、日活跃用户数">
                    </label>
                    <label>
                        <span class="data-analysis-label-title">目标字段</span>
                        <select id="data-analysis-metric-field" class="form-input"></select>
                    </label>
                    <label>
                        <span class="data-analysis-label-title">聚合计算方式</span>
                        <select id="data-analysis-metric-aggregation" class="form-input">
                            <option value="sum">求和 (SUM)</option>
                            <option value="count">计数 (COUNT)</option>
                            <option value="avg">平均值 (AVG)</option>
                            <option value="min">最小值 (MIN)</option>
                            <option value="max">最大值 (MAX)</option>
                        </select>
                    </label>
                    <label class="grid-span-full">
                        <span class="data-analysis-label-title">显示单位</span>
                        <input id="data-analysis-metric-unit" class="form-input" maxlength="40" placeholder="例如：元、笔、人次">
                    </label>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-metric-modal">取消</button>
            <button id="data-analysis-metric-save" class="btn-primary" type="button">保存指标口径</button>
        </div>
    </div>
</div>

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
                            <button class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-relation-modal">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                <span>配置关联</span>
                            </button>
                        </div>
                        <div id="data-analysis-model-relations" class="data-analysis-asset-list data-analysis-modal-scroll-180-plain"></div>
                        <div id="data-analysis-model-query-result" class="data-analysis-calc-preview-result"></div>
                    </div>
                </div>
            </div>
            <div class="data-analysis-modal-divider">
                <span class="data-analysis-subheading">+ 新建跨数据集模型</span>
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
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-relation-modal">取消</button>
            <button id="data-analysis-model-relation-run" class="btn-secondary" type="button">预览关联</button>
            <button id="data-analysis-model-relation-save" class="btn-primary" type="button">保存关联</button>
        </div>
    </div>
</div>

<!-- 规模化数据管道弹窗 -->
<div id="data-analysis-scalability-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-scalability-modal-dialog data-analysis-modal-size-840-90">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
                <div>
                    <h3>规模化数据管道</h3>
                    <p class="data-analysis-modal-subtitle">开发环境使用受控本地存储：增量导入生成可回放版本，分区 Parquet 与物化聚合均绑定字段权限。</p>
                </div>
            </div>
            <div class="data-analysis-inline-actions">
                <button id="data-analysis-scale-refresh" class="btn-secondary btn-sm" type="button" title="刷新管道状态">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                    <span>刷新状态</span>
                </button>
            </div>
        </div>
        <div class="data-analysis-modal-body" id="data-analysis-scalability-panel">
            <div class="data-analysis-scale-subtoolbar data-analysis-modal-mb-14">
                <label class="data-analysis-dataset-picker">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                    <span class="data-analysis-picker-label">目标数据集</span>
                    <select id="data-analysis-scale-dataset" class="form-input data-analysis-picker-select"></select>
                </label>
                <span id="data-analysis-scale-status" class="data-analysis-source-state"></span>
            </div>
            <div class="data-analysis-governance-grid">
                <div class="data-analysis-pipe-box">
                    <div class="data-analysis-pipe-box-head">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                        <h6>增量导入</h6>
                    </div>
                    <div class="data-analysis-file-picker-row">
                        <label class="btn-secondary btn-sm data-analysis-file-btn" for="data-analysis-scale-increment-file">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                            <span>选择文件</span>
                        </label>
                        <span id="data-analysis-scale-file-name" class="data-analysis-file-chosen-text">未选择任何文件</span>
                        <input id="data-analysis-scale-increment-file" class="data-analysis-hidden-file-input" type="file" accept=".csv,.xlsx,.xls,.sqlite,.sqlite3,.db">
                    </div>
                    <button id="data-analysis-scale-append" class="btn-secondary btn-sm" type="button">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        <span>追加为新版本</span>
                    </button>
                    <small>字段顺序必须与当前数据集一致；旧版本文件会保留用于回放。</small>
                </div>
                <div class="data-analysis-pipe-box">
                    <div class="data-analysis-pipe-box-head">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                        <h6>分区 Parquet</h6>
                    </div>
                    <select id="data-analysis-scale-partition-field" class="form-input data-analysis-pipe-select"></select>
                    <button id="data-analysis-scale-partition" class="btn-secondary btn-sm" type="button">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        <span>生成受控分区</span>
                    </button>
                    <small>分区副本保留在受控数据集目录，原始查询边界不变。</small>
                </div>
            </div>
            <div class="data-analysis-governance-grid data-analysis-modal-mt-12">
                <div class="data-analysis-pipe-box">
                    <div class="data-analysis-pipe-box-head">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                        <h6>物化聚合</h6>
                    </div>
                    <div class="data-analysis-pipe-form-grid">
                        <input id="data-analysis-scale-materialization-name" class="form-input data-analysis-pipe-input grid-span-full" maxlength="120" placeholder="例如：按区域销售额">
                        <select id="data-analysis-scale-materialization-group" class="form-input data-analysis-pipe-select"></select>
                        <select id="data-analysis-scale-materialization-field" class="form-input data-analysis-pipe-select"></select>
                        <select id="data-analysis-scale-materialization-aggregation" class="form-input data-analysis-pipe-select grid-span-full">
                            <option value="sum">求和 (SUM)</option>
                            <option value="count">计数 (COUNT)</option>
                            <option value="avg">平均 (AVG)</option>
                            <option value="min">最小 (MIN)</option>
                            <option value="max">最大 (MAX)</option>
                        </select>
                    </div>
                    <button id="data-analysis-scale-materialization-save" class="btn-primary btn-sm" type="button">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        <span>创建物化聚合</span>
                    </button>
                </div>
                <div class="data-analysis-pipe-box">
                    <div class="data-analysis-pipe-box-head">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                        <h6>版本、分区与聚合资产</h6>
                    </div>
                    <div id="data-analysis-scale-assets" class="data-analysis-asset-list"></div>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-scalability-modal">取消</button>
            <button class="btn-primary" type="button" data-analysis-modal-close="data-analysis-scalability-modal">完成</button>
        </div>
    </div>
</div>
`,
        assets: `
<div class="data-analysis-governance-layout">
    <div class="data-analysis-panel-header">
        <div class="data-analysis-panel-header-left">
            <div class="data-analysis-header-icon-badge">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="12 11 12 17 15 14"></polyline></svg>
            </div>
            <div class="data-analysis-panel-header-intro">
                <div class="data-analysis-title-row">
                    <h5>分析资产库</h5>
                    <span class="data-analysis-badge-safe">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        跨版本回放 · 可复跑视图 · 团队协作
                    </span>
                </div>
                <p>沉淀并维护图表生成、多维透视与自定义 SQL 等分析视图；支持跨版本快速回放、部门共享及一键添加至仪表盘。</p>
            </div>
        </div>
        <div class="data-analysis-panel-header-actions">
            <label class="data-analysis-dataset-picker" title="选择关联数据集">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                <span class="data-analysis-picker-label">关联数据集</span>
                <select id="data-analysis-assets-dataset" class="form-input data-analysis-picker-select"></select>
            </label>
            <button id="data-analysis-assets-refresh" class="btn-secondary" type="button" title="刷新分析资产">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                <span>刷新资产</span>
            </button>
            <button id="data-analysis-open-save-view-modal" class="btn-primary" type="button" data-analysis-modal-trigger="data-analysis-save-view-modal">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                <span>保存当前视图</span>
            </button>
        </div>
    </div>

    <div class="data-analysis-governance-card">
        <div class="data-analysis-governance-card-header">
            <div>
                <div class="data-analysis-card-title-wrap">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
                    <h5>可复跑分析资产</h5>
                </div>
                <p>点击“运行”可将该资产的图表配置、透视行列或查询 SQL 恢复到对应工作区重放。</p>
            </div>
            <button class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-save-view-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                <span>保存当前分析视图</span>
            </button>
        </div>
        <div id="data-analysis-saved-views" class="data-analysis-asset-list"></div>
    </div>
</div>

<!-- 保存视图弹窗 -->
<div id="data-analysis-save-view-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                <div>
                    <h3>保存当前分析视图</h3>
                    <p class="data-analysis-modal-subtitle">固化图表、透视或查询配置，方便后续复用与看板组合。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div class="data-analysis-view-save-form data-analysis-modal-form-grid">
                <label>
                    <span class="data-analysis-label-title">资产名称 <span class="required">*</span></span>
                    <input id="data-analysis-view-name" class="form-input" maxlength="120" placeholder="例如：月度销售额汇总图表">
                </label>
                <label>
                    <span class="data-analysis-label-title">资产类型</span>
                    <select id="data-analysis-view-type" class="form-input">
                        <option value="chart">当前图表</option>
                        <option value="pivot">当前透视</option>
                        <option value="query">当前查询</option>
                    </select>
                </label>
                <label class="grid-span-full">
                    <span class="data-analysis-label-title">说明备注</span>
                    <input id="data-analysis-view-description" class="form-input" maxlength="500" placeholder="资产用途或口径补充说明（可选）">
                </label>
                <div class="grid-span-full data-analysis-share-section data-analysis-modal-dept-stack">
                    <label class="data-analysis-share-toggle data-analysis-modal-checkbox-row">
                        <input id="data-analysis-view-shared" type="checkbox"> 共享给本部门
                    </label>
                    <input id="data-analysis-view-shared-units" class="form-input" maxlength="500" placeholder="共享部门，例如：财务部">
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-save-view-modal">取消</button>
            <button id="data-analysis-save-view" class="btn-primary" type="button">保存当前视图</button>
        </div>
    </div>
</div>
`,
        dashboards: `
<div class="data-analysis-dashboard-layout">
    <div class="data-analysis-panel-header grid-span-full">
        <div class="data-analysis-panel-header-left">
            <div class="data-analysis-header-icon-badge">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect></svg>
            </div>
            <div class="data-analysis-panel-header-intro">
                <div class="data-analysis-title-row">
                    <h5>协作仪表盘工作台</h5>
                    <span class="data-analysis-badge-safe">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        多维看板 · 周期刷新 · 自动化阈值告警
                    </span>
                </div>
                <p>将已保存的图表、透视与查询组合为业务协作看板；配置周期自动刷新、最新快照回溯与指标越限预警。</p>
            </div>
        </div>
        <div class="data-analysis-panel-header-actions">
            <button id="data-analysis-open-create-dashboard-modal" class="btn-primary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-create-dashboard-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                <span>新建仪表盘</span>
            </button>
            <button id="data-analysis-open-schedule-modal" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-schedule-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                <span>定时刷新计划</span>
            </button>
            <button id="data-analysis-open-alert-modal" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-alert-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
                <span>阈值告警规则</span>
            </button>
            <button id="data-analysis-open-snapshot-modal" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-snapshot-modal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                <span>快照历史</span>
            </button>
        </div>
    </div>

    <div class="data-analysis-governance-card data-analysis-dashboard-sidebar-card">
        <div class="data-analysis-governance-card-header">
            <div>
                <div class="data-analysis-card-title-wrap">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
                    <h5>协作仪表盘</h5>
                </div>
                <p>选择或切换目标看板</p>
            </div>
            <button id="data-analysis-open-create-dashboard-btn" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-create-dashboard-modal">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                <span>新建</span>
            </button>
        </div>
        <div id="data-analysis-dashboard-list" class="data-analysis-dashboard-list"></div>
    </div>

    <div class="data-analysis-governance-card data-analysis-dashboard-content-card">
        <div class="data-analysis-governance-card-header">
            <div>
                <h5 id="data-analysis-dashboard-title">请选择仪表盘</h5>
                <p id="data-analysis-dashboard-meta">可以添加保存视图并设置周期刷新和阈值告警。</p>
            </div>
            <div class="data-analysis-inline-actions data-analysis-dashboard-actions">
                <button id="data-analysis-open-add-view-modal" class="btn-secondary btn-sm" type="button" data-analysis-modal-trigger="data-analysis-add-view-modal" title="添加已保存的分析视图到看板">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    <span>添加组件</span>
                </button>
                <button id="data-analysis-dashboard-refresh" class="btn-primary btn-sm" type="button">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                    <span>立即刷新</span>
                </button>
            </div>
        </div>
        <div id="data-analysis-dashboard-items" class="data-analysis-dashboard-items"></div>
    </div>
</div>

<!-- 新建仪表盘弹窗 -->
<div id="data-analysis-create-dashboard-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
                <div>
                    <h3>新建协作仪表盘</h3>
                    <p class="data-analysis-modal-subtitle">创建多组件业务看板，组织视图流并配置监控策略。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div class="data-analysis-dashboard-create data-analysis-modal-form-grid">
                <label class="grid-span-full">
                    <span class="data-analysis-label-title">仪表盘名称 <span class="required">*</span></span>
                    <input id="data-analysis-dashboard-name" class="form-input" maxlength="120" placeholder="例如：核心业务指标监控大盘">
                </label>
                <label class="grid-span-full">
                    <span class="data-analysis-label-title">用途说明</span>
                    <input id="data-analysis-dashboard-description" class="form-input" maxlength="500" placeholder="大盘目标、受众与业务说明（可选）">
                </label>
                <div class="grid-span-full data-analysis-modal-dept-stack">
                    <label class="data-analysis-share-toggle data-analysis-modal-checkbox-row">
                        <input id="data-analysis-dashboard-shared" type="checkbox"> 共享给本部门
                    </label>
                    <input id="data-analysis-dashboard-shared-units" class="form-input" maxlength="500" placeholder="共享部门，例如：管理层, 销售部">
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-create-dashboard-modal">取消</button>
            <button id="data-analysis-dashboard-create" class="btn-primary" type="button">创建仪表盘</button>
        </div>
    </div>
</div>

<!-- 定时刷新计划弹窗 -->
<div id="data-analysis-schedule-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-modal-size-680">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                <div>
                    <h3>看板定时刷新计划管理</h3>
                    <p class="data-analysis-modal-subtitle">查看已有定时计划或添加周期自动刷新快照调度。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div>
                <span class="data-analysis-subheading">当前已配置定时刷新计划</span>
                <div id="data-analysis-refresh-schedules" class="data-analysis-asset-list data-analysis-modal-scroll-180"></div>
            </div>
            <div class="data-analysis-modal-divider">
                <span class="data-analysis-subheading">+ 添加定时刷新计划</span>
                <div class="data-analysis-schedule-form data-analysis-modal-form-grid">
                    <label class="grid-span-full">
                        <span class="data-analysis-label-title">计划名称 <span class="required">*</span></span>
                        <input id="data-analysis-refresh-name" class="form-input" maxlength="120" placeholder="例如：工作日早晨定时刷新">
                    </label>
                    <label>
                        <span class="data-analysis-label-title">刷新频率</span>
                        <select id="data-analysis-refresh-frequency" class="form-input">
                            <option value="interval">间隔执行</option>
                            <option value="cron">计划表达式 (Cron)</option>
                            <option value="manual">手动执行</option>
                        </select>
                    </label>
                    <label>
                        <span class="data-analysis-label-title">执行间隔 (分钟)</span>
                        <input id="data-analysis-refresh-interval" class="form-input" type="number" min="5" max="1440" value="60">
                    </label>
                    <label class="grid-span-full">
                        <span class="data-analysis-label-title">Cron 表达式 (可选)</span>
                        <input id="data-analysis-refresh-cron" class="form-input" maxlength="100" placeholder="例如: 0 9 * * 1-5 (每周一至周五 9:00)">
                    </label>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-schedule-modal">取消</button>
            <button id="data-analysis-refresh-schedule-save" class="btn-primary" type="button">保存刷新计划</button>
        </div>
    </div>
</div>

<!-- 阈值告警规则弹窗 -->
<div id="data-analysis-alert-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-modal-size-680">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
                <div>
                    <h3>指标阈值告警规则管理</h3>
                    <p class="data-analysis-modal-subtitle">查看已有规则或新增指标阈值超限告警。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div>
                <span class="data-analysis-subheading">当前已配置告警规则</span>
                <div id="data-analysis-alerts" class="data-analysis-asset-list data-analysis-modal-scroll-180"></div>
            </div>
            <div class="data-analysis-modal-divider">
                <span class="data-analysis-subheading">+ 添加指标阈值告警</span>
                <div class="data-analysis-alert-form data-analysis-modal-form-grid">
                    <label class="grid-span-full">
                        <span class="data-analysis-label-title">告警名称 <span class="required">*</span></span>
                        <input id="data-analysis-alert-name" class="form-input" maxlength="120" placeholder="例如：日销售额偏低预警">
                    </label>
                    <label>
                        <span class="data-analysis-label-title">监控字段</span>
                        <select id="data-analysis-alert-field" class="form-input"></select>
                    </label>
                    <label>
                        <span class="data-analysis-label-title">聚合计算方式</span>
                        <select id="data-analysis-alert-aggregation" class="form-input">
                            <option value="sum">求和 (SUM)</option>
                            <option value="count">计数 (COUNT)</option>
                            <option value="avg">平均 (AVG)</option>
                            <option value="min">最小 (MIN)</option>
                            <option value="max">最大 (MAX)</option>
                        </select>
                    </label>
                    <label>
                        <span class="data-analysis-label-title">比较操作符</span>
                        <select id="data-analysis-alert-operator" class="form-input">
                            <option value="gt">大于 (&gt;)</option>
                            <option value="gte">大于等于 (&gt;=)</option>
                            <option value="lt">小于 (&lt;)</option>
                            <option value="lte">小于等于 (&lt;=)</option>
                            <option value="eq">等于 (=)</option>
                        </select>
                    </label>
                    <label>
                        <span class="data-analysis-label-title">阈值数值 <span class="required">*</span></span>
                        <input id="data-analysis-alert-threshold" class="form-input" type="number" step="any" placeholder="例如：10000">
                    </label>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-alert-modal">取消</button>
            <button id="data-analysis-alert-save" class="btn-primary" type="button">保存告警规则</button>
        </div>
    </div>
</div>

<!-- 数据快照历史弹窗 -->
<div id="data-analysis-snapshot-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-modal-size-640">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                <div>
                    <h3>看板数据快照历史</h3>
                    <p class="data-analysis-modal-subtitle">查看当前仪表盘的历史数据刷新记录与离线快照。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div id="data-analysis-dashboard-snapshot" class="data-analysis-dashboard-snapshot data-analysis-modal-divider-clean"></div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-snapshot-modal">取消</button>
            <button class="btn-primary" type="button" data-analysis-modal-close="data-analysis-snapshot-modal">完成</button>
        </div>
    </div>
</div>

<!-- 向仪表盘添加组件弹窗 -->
<div id="data-analysis-add-view-modal" class="modal-overlay data-analysis-modal-overlay hidden">
    <div class="modal data-analysis-dialog-modal data-analysis-modal-size-520">
        <div class="data-analysis-modal-header">
            <div class="data-analysis-modal-title-group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect></svg>
                <div>
                    <h3>添加看板组件</h3>
                    <p class="data-analysis-modal-subtitle">从已保存的图表、透视表或自定义查询中选取，载入当前业务看板。</p>
                </div>
            </div>
        </div>
        <div class="data-analysis-modal-body">
            <div class="data-analysis-modal-form-grid data-analysis-modal-grid-1col">
                <label>
                    <span class="data-analysis-label-title">选择已保存的分析视图 <span class="required">*</span></span>
                    <select id="data-analysis-dashboard-view-select" class="form-input data-analysis-dashboard-view-picker" aria-label="选择保存视图"></select>
                </label>
                <p class="data-analysis-form-hint">组件添加后将自动呈现于看板流中，并在看板周期刷新或立即刷新时获取最新演算数据。</p>
            </div>
        </div>
        <div class="data-analysis-modal-footer">
            <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-add-view-modal">取消</button>
            <button id="data-analysis-dashboard-add-view" class="btn-primary" type="button">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                <span>确认添加</span>
            </button>
        </div>
    </div>
</div>
`
    };

    function bindModalEvents() {
        if (document.body.dataset.dataAnalysisModalBound === 'true') return;
        document.body.dataset.dataAnalysisModalBound = 'true';

        document.addEventListener('click', event => {
            const trigger = event.target.closest('[data-analysis-modal-trigger]');
            if (trigger) {
                event.preventDefault();
                openModal(trigger.dataset.analysisModalTrigger);
                return;
            }

            const closer = event.target.closest('[data-analysis-modal-close]');
            if (closer) {
                event.preventDefault();
                closeModal(closer.dataset.analysisModalClose);
                return;
            }

            const closeBtn = event.target.closest('.data-analysis-modal-close-btn');
            if (closeBtn) {
                const modal = closeBtn.closest('.modal-overlay');
                if (modal) modal.classList.add('hidden');
                return;
            }

            if (event.target.classList.contains('modal-overlay')) {
                event.target.classList.add('hidden');
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                const openOverlays = document.querySelectorAll('.data-analysis-dialog-modal');
                openOverlays.forEach(dialog => {
                    const overlay = dialog.closest('.modal-overlay');
                    if (overlay && !overlay.classList.contains('hidden')) {
                        overlay.classList.add('hidden');
                    }
                });
            }
        });

        document.addEventListener('focusin', event => {
            const modal = event.target.closest?.('.modal-overlay[id^="data-analysis-"]');
            if (modal && modal.classList.contains('hidden')) {
                modal.classList.remove('hidden');
            }
        });
    }

    function mountDataAnalysisExtraPanels() {
        Object.entries(panels).forEach(([name, markup]) => {
            const panel = document.getElementById(`data-analysis-${name}-panel`);
            if (panel && !panel.dataset.mounted) {
                PivotSafeHtml.setHtml(panel, markup);
                panel.dataset.mounted = 'true';
            }
        });
        bindModalEvents();
    }

    Object.assign(app, {
        mountDataAnalysisExtraPanels,
        openModal,
        closeModal
    });
})();
