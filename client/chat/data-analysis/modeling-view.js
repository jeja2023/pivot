(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis;
    const m = app.modeling;
    const { state, table } = m;
    const { esc } = app;
    const byId = id => document.getElementById(id);
    const html = (element, value) => { if (element) PivotSafeHtml.setHtml(element, value); };
    const button = (action, label, id = '', primary = false, extraClass = '') => {
        return `<button class="${primary ? 'btn-primary' : 'btn-secondary'}${extraClass ? ` ${extraClass}` : ''}" type="button" data-modeling-action="${action}"${id ? ` data-modeling-id="${esc(id)}"` : ''}>${esc(label)}</button>`;
    };
    const lifecycle = model => ({ draft: '草稿', published: '已有发布版本', archived: '已归档' }[model.lifecycle] || '关联探索');
    const lifecycleTone = model => model.modelKind === 'exploration' ? 'info' : ({ draft: 'warning', published: 'success', archived: 'muted' }[model.lifecycle] || 'muted');
    const availabilityLabel = availability => ({ available: '可用', pending: '有新数据待检查', source_unavailable: '来源不可用', refresh_failed: '刷新失败' }[availability] || '未检查');
    const availabilityTone = availability => ({ available: 'success', pending: 'warning', source_unavailable: 'danger', refresh_failed: 'danger' }[availability] || 'muted');
    const badge = (text, tone = 'muted') => `<span class="modeling-badge is-${tone}">${esc(text)}</span>`;

    function mount() {
        const panel = byId('data-analysis-modeling-panel');
        if (!panel || panel.dataset.mounted) return;
        panel.dataset.mounted = 'true';
        html(panel, `<div class="modeling-workspace">
            <div id="modeling-list" class="modeling-list-view">
                <div class="modeling-surface-bar modeling-list-bar">
                    <div class="modeling-filter-bar">
                        <input id="modeling-search" class="form-input modeling-search-input" maxlength="120" type="search" placeholder="搜索模型名称或用途说明…" aria-label="搜索模型名称或用途">
                        <select id="modeling-ownership" class="form-input modeling-filter-select" aria-label="按归属筛选"><option value="all">归属：全部可见</option><option value="mine">归属：我创建的</option><option value="shared">归属：共享给我</option></select>
                        <select id="modeling-lifecycle" class="form-input modeling-filter-select" aria-label="按生命周期筛选"><option value="all">状态：全部类型</option><option value="draft">状态：草稿</option><option value="published">状态：已发布</option><option value="archived">状态：已归档</option><option value="exploration">状态：关联探索</option></select>
                        <select id="modeling-availability" class="form-input modeling-filter-select" aria-label="按数据状态筛选"><option value="all">数据：全部状态</option><option value="available">数据：可用</option><option value="pending">数据：有新数据待检查</option><option value="source_unavailable">数据：来源不可用</option><option value="refresh_failed">数据：刷新失败</option></select>
                    </div>
                    <div class="modeling-bar-actions">
                        ${button('goto-analysis', '数据分析工作台')}
                        ${button('refresh-list', '刷新')}
                        ${button('reviews', '业务复核')}
                        ${button('transfers', '模型交接')}
                        ${button('create', '新建模型', '', true)}
                    </div>
                </div>
                <div class="modeling-guide-strip" aria-label="一体化画布建模说明">
                    <span class="modeling-guide-title">可视化建模工作台：</span>
                    <span class="modeling-guide-item">拖入数据表与内置算子</span>
                    <span class="modeling-guide-sep">→</span>
                    <span class="modeling-guide-item">单圆点连线串联关联、筛选、函数计算与自定义 SQL</span>
                    <span class="modeling-guide-sep">→</span>
                    <span class="modeling-guide-item">点击任意节点弹出右侧抽屉配置并实时预览流转数据</span>
                </div>
                <div id="modeling-list-content" class="modeling-card modeling-list-card" aria-live="polite"></div>
                <div id="modeling-list-pagination" class="workspace-pagination"></div>
            </div>
            <div id="modeling-editor" class="modeling-editor-view hidden">
                <div class="modeling-surface-bar modeling-editor-header">
                    <div class="modeling-editor-identity">
                        ${button('back', '← 模型列表')}
                        <div class="modeling-editor-titles">
                            <div class="modeling-editor-title-row">
                                <strong id="modeling-title" class="modeling-editor-name"></strong>
                                <span id="modeling-version" class="modeling-version-pill"></span>
                                <span id="modeling-save-state" class="modeling-save-pill" role="status" aria-live="polite"></span>
                            </div>
                            <div id="modeling-status" class="modeling-status-line" role="status"></div>
                        </div>
                    </div>
                    <div class="modeling-bar-actions">
                        ${button('basic', '模型信息')}
                        ${button('open-semantics', '维度与指标')}
                        ${button('check', '检查')}
                        ${button('analyze', '试算与分析')}
                        ${button('save', '保存草稿', '', true)}
                        ${button('publish', '发布')}
                        <details class="modeling-more"><summary class="modeling-more-trigger">更多</summary><div class="modeling-more-menu">${button('refresh-data', '检查新数据')}${button('versions', '版本与差异')}${button('dependencies', '依赖与血缘')}${button('share', '共享与复核')}${button('transfer', '交接模型')}${button('archive', '归档或恢复')}${button('goto-analysis-editor', '前往数据分析')}</div></details>
                    </div>
                </div>
                <div id="modeling-content" class="modeling-studio-body"></div>
            </div>
            <div id="data-analysis-modeling-dialog" class="modal-overlay data-analysis-modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="modeling-dialog-title"><div class="workspace-modal modeling-dialog"><div class="workspace-modal-header"><h3 id="modeling-dialog-title"></h3>${button('close-dialog', '关闭')}</div><form id="modeling-dialog-form"><div id="modeling-dialog-body" class="workspace-modal-body modeling-form"></div><div class="modeling-dialog-footer"><span id="modeling-dialog-error" role="alert"></span>${button('close-dialog', '取消')}<button class="btn-primary" type="submit">确认</button></div></form></div></div>
        </div>`);
    }

    function renderList() {
        mount();
        const rows = state.models.filter(model => {
            if (state.search && !`${model.name} ${model.description || ''}`.toLocaleLowerCase().includes(state.search.toLocaleLowerCase())) return false;
            if (state.ownership === 'mine' && !model.isOwner || state.ownership === 'shared' && model.isOwner) return false;
            if (state.lifecycle !== 'all' && (model.modelKind === 'exploration' ? 'exploration' : model.lifecycle) !== state.lifecycle) return false;
            return state.availability === 'all' || model.availability === state.availability;
        });
        state.listPage = Math.max(1, Math.min(state.listPage, Math.ceil(rows.length / 10) || 1));
        const pager = byId('modeling-list-pagination');
        if (!rows.length) {
            const hasDatasets = (app.state.datasets || []).length > 0;
            html(byId('modeling-list-content'), `<div class="modeling-empty-state"><h4>${state.models.length ? '没有匹配筛选条件的模型' : '还没有创建数据模型'}</h4><p>${state.models.length ? '请调整上方搜索词或筛选条件后重试。' : hasDatasets ? `当前已有 ${app.state.datasets.length} 个可用数据集，点击下方按钮即可选取主表开始拖拽建模。` : '数据建模需要先上传表格数据集。您可以先前往数据分析上传 CSV 或 Excel 表格，再回来拖拽建模。'}</p><div class="modeling-empty-actions">${hasDatasets ? button('create-empty', '+ 立即新建数据模型', '', true) : button('goto-analysis-empty', '前往上传数据集', '', true)}${state.models.length ? button('reset-filters', '清空筛选条件') : ''}</div></div>`);
            if (pager) {
                if (typeof window.Pivot.legacy.renderWorkspacePagination === 'function') {
                    window.Pivot.legacy.renderWorkspacePagination(pager, { total: 0, page: 1, limit: 10, alwaysShow: false });
                } else {
                    html(pager, '');
                }
            }
        } else {
            const curUser = (typeof currentUser !== 'undefined' && currentUser) || window.Pivot?.legacy?.currentUser || null;
            const listRows = rows.slice((state.listPage - 1) * 10, state.listPage * 10).map((model, offset) => {
                const rowIndex = (state.listPage - 1) * 10 + offset + 1;
                const descText = model.description || '未填写用途说明';
                const ownerDisplay = model.ownerName || (model.isOwner ? (curUser?.username || '当前用户') : `用户 ${model.userId}`);
                const actions = [];
                if (model.modelKind === 'production') {
                    actions.push(button('select', '打开', model.id, false, 'data-analysis-table-btn'));
                    if (model.isOwner) {
                        actions.push(button('edit-model-list', '编辑', model.id, false, 'data-analysis-table-btn'));
                        actions.push(button('delete-model-list', '删除', model.id, false, 'data-analysis-table-btn is-danger'));
                    }
                } else {
                    actions.push(button('legacy', '打开', model.id, false, 'data-analysis-table-btn'));
                    if (model.isOwner) {
                        actions.push(button('edit-model-list', '编辑', model.id, false, 'data-analysis-table-btn'));
                        actions.push(button('migrate', '升级模型', model.id, false, 'data-analysis-table-btn'));
                        actions.push(button('delete-model-list', '删除', model.id, false, 'data-analysis-table-btn is-danger'));
                    }
                }
                return `<tr>` +
                    `<td class="text-center data-analysis-row-index">${rowIndex}</td>` +
                    `<td class="modeling-cell-name" title="${esc(model.name)}"><strong>${esc(model.name)}</strong></td>` +
                    `<td class="modeling-cell-desc" title="${esc(descText)}"><span>${esc(descText)}</span></td>` +
                    `<td>${esc(ownerDisplay)}</td>` +
                    `<td>${badge(lifecycle(model), lifecycleTone(model))}</td>` +
                    `<td>${model.publishedVersion ? badge(`v${model.publishedVersion}`, 'success') : '<span class="text-muted">未发布</span>'}</td>` +
                    `<td>${badge(availabilityLabel(model.availability), availabilityTone(model.availability))}</td>` +
                    `<td class="modeling-cell-time">${esc(String(model.updatedAt || '').replace('T', ' ').slice(0, 19))}</td>` +
                    `<td class="text-center"><div class="modeling-row-actions">${actions.join('')}</div></td>` +
                `</tr>`;
            });
            html(byId('modeling-list-content'), table(['序号', '模型名称', '用途说明', '所有者', '类型 / 生命周期', '发布版本', '数据状态', '更新时间', '操作'], listRows));
            if (pager) {
                if (typeof window.Pivot.legacy.renderWorkspacePagination === 'function') {
                    window.Pivot.legacy.renderWorkspacePagination(pager, {
                        total: rows.length,
                        page: state.listPage,
                        limit: 10,
                        alwaysShow: true,
                        onPageChange: targetPage => {
                            state.listPage = targetPage;
                            renderList();
                        }
                    });
                } else {
                    html(pager, `${button('previous-page', '上一页')}<span>第 ${state.listPage} / ${Math.max(1, Math.ceil(rows.length / 10))} 页 · 共 ${rows.length} 个模型</span>${button('next-page', '下一页')}`);
                }
            }
        }
    }

    function renderSaveState() {
        const status = byId('modeling-save-state');
        if (!status) return;
        status.dataset.state = state.saveState || 'saved';
        status.textContent = ({ saved: '已保存', unsaved: '未保存', saving: '保存中…', failed: '保存失败，输入已保留' })[state.saveState];
    }

    function fieldName(nodeId, fieldKey) {
        const node = state.draft?.nodes.find(item => item.id === nodeId);
        const source = state.selected?.sources?.find(item => item.nodeId === nodeId) || app.state.datasets.find(item => item.id === node?.datasetId);
        return source?.columns?.find(item => item.key === fieldKey)?.name || fieldKey;
    }

    function nodeName(id) {
        return state.draft?.nodes.find(node => node.id === id)?.name || m.getFlowNode?.(id)?.name || id;
    }

    function issueTargetLabel(issue) {
        if (issue.nodeId) return `表 · ${nodeName(issue.nodeId)}`;
        if (issue.relationId) {
            const rel = state.draft?.relations.find(item => item.id === issue.relationId);
            return rel ? `关联 · ${nodeName(rel.leftNodeId)} → ${nodeName(rel.rightNodeId)}` : `关联 · ${issue.relationId}`;
        }
        if (issue.dimensionId) return `维度 · ${state.draft?.dimensions.find(item => item.id === issue.dimensionId)?.name || issue.dimensionId}`;
        if (issue.metricId) return `指标 · ${state.draft?.metrics.find(item => item.id === issue.metricId)?.name || issue.metricId}`;
        return '模型整体';
    }

    function renderFieldListItems(selected, columns, keyword = '') {
        if (!selected) return '<li class="modeling-field-empty">未选择表节点</li>';
        const q = String(keyword || '').trim().toLocaleLowerCase();
        const filtered = q ? columns.filter(field => String(field.name || field.key).toLocaleLowerCase().includes(q)) : columns;
        const shown = filtered.slice(0, 80);
        const existingDimKeys = new Set(state.draft.dimensions.filter(dim => dim.nodeId === selected.id).map(dim => dim.fieldKey));
        const existingMetricKeys = new Set(state.draft.metrics.filter(met => met.field?.nodeId === selected.id).map(met => met.field.fieldKey));
        if (!shown.length) {
            return `<li class="modeling-field-empty">${columns.length ? '没有匹配该搜索词的字段' : '暂无字段信息'}</li>`;
        }
        const items = shown.map(field => {
            const isKey = selected.grainKeys.includes(field.key);
            const hasDim = existingDimKeys.has(field.key);
            const hasMetric = existingMetricKeys.has(field.key);
            const fieldTitle = esc(`${field.name}（${field.type || '文本'}）`);
            return `<li class="modeling-field-item">
                <div class="modeling-field-main" title="${fieldTitle}">
                    ${isKey ? '<span class="modeling-mini-tag is-key">主键</span>' : ''}
                    <span class="modeling-field-name">${esc(field.name)}</span>
                </div>
                <div class="modeling-field-quick">
                    ${hasDim ? '<span class="modeling-mini-tag">维度</span>' : `<button class="btn-secondary modeling-mini-btn" type="button" data-modeling-action="field-dimension" data-modeling-id="${esc(`${selected.id}:${field.key}`)}" title="将该字段添加为分析维度">+维度</button>`}
                    ${selected.role === 'fact' ? (hasMetric ? '<span class="modeling-mini-tag">指标</span>' : `<button class="btn-secondary modeling-mini-btn" type="button" data-modeling-action="field-metric" data-modeling-id="${esc(field.key)}" title="将该字段添加为统计指标">+指标</button>`) : ''}
                </div>
            </li>`;
        }).join('');
        const moreNote = filtered.length > shown.length
            ? `<li class="modeling-field-empty">共匹配 ${filtered.length} 列，当前展示前 ${shown.length} 列，请输入关键字精准筛选</li>`
            : '';
        return items + moreNote;
    }

    function renderNodeDrawerContent() {
        const editable = state.selected?.isOwner && state.selected.lifecycle !== 'archived';
        const flowNode = m.getFlowNode?.(state.selectedNodeId);
        if (flowNode && m.renderOperatorInspector) {
            return m.renderOperatorInspector(flowNode, editable);
        }
        const fact = state.draft.nodes.find(node => node.role === 'fact');
        const selected = state.draft.nodes.find(node => node.id === state.selectedNodeId) || fact || state.draft.nodes[0];
        if (!selected) return '<p class="text-muted">请点击画布中的节点查看属性配置。</p>';
        const source = state.selected.sources?.find(item => item.nodeId === selected.id) || app.state.datasets.find(item => item.id === selected.datasetId);
        const columns = source?.columns || [];
        const nodeRelations = state.draft.relations.filter(rel => rel.leftNodeId === selected.id || rel.rightNodeId === selected.id);

        return `<div class="modeling-drawer-section">
                <div class="modeling-inspector-card">
                    <div class="modeling-drawer-subhead">
                        <strong class="modeling-inspector-title" title="${esc(selected.name)}">${esc(selected.name)}</strong>
                        ${badge(selected.role === 'fact' ? '事实主表' : '维度表', selected.role === 'fact' ? 'success' : 'info')}
                    </div>
                    ${selected.role === 'fact' ? `<div class="modeling-inspector-meta"><span>单行含义：</span><strong>${esc(state.draft.grainDescription || '尚未设置事实粒度说明')}</strong></div>` : ''}
                    <div class="modeling-inspector-meta"><span>唯一主键：</span><strong>${esc(selected.grainKeys.map(key => fieldName(selected.id, key)).join(' + ') || '尚未勾选')}</strong></div>
                    <div class="modeling-drawer-actions">
                        ${button('preview-node', '运行数据预览', selected.id, true)}
                        ${button('edit-node-modal', '编辑表与粒度', selected.id)}
                        ${selected.role === 'dimension' ? button('remove-node', '移除维度表', selected.id) : ''}
                    </div>
                </div>
            </div>
            <div class="modeling-drawer-section">
                <div class="modeling-drawer-subhead">
                    <span>已连接表关联</span>
                    <span class="modeling-rail-count">${nodeRelations.length} 条</span>
                </div>
                ${nodeRelations.length ? `<div class="modeling-flow-list">${nodeRelations.map(rel => {
                    const keys = rel.keyPairs.map(pair => `${fieldName(rel.leftNodeId, pair.leftFieldKey)} = ${fieldName(rel.rightNodeId, pair.rightFieldKey)}`).join('；');
                    return `<div class="modeling-relation-mini">
                        <div>
                            <strong>${esc(nodeName(rel.leftNodeId))} → ${esc(nodeName(rel.rightNodeId))}</strong>
                            <small>${esc(rel.joinType === 'inner' ? '内关联' : '左关联')} · ${esc(keys)}</small>
                        </div>
                        <div class="modeling-row-actions">
                            ${button('edit-relation-modal', '编辑', rel.id)}
                            ${button('remove-relation', '删除', rel.id)}
                        </div>
                    </div>`;
                }).join('')}</div>` : '<p class="modeling-rail-tip">可直接从画布节点右侧圆点拖线至维度表左侧圆点建立关联。</p>'}
            </div>
            <div class="modeling-drawer-section modeling-fields-section">
                <div class="modeling-drawer-subhead">
                    <span>表内字段搜索与快捷建模</span>
                    <span class="modeling-rail-count">共 ${columns.length} 列</span>
                </div>
                <input id="modeling-field-search" class="form-input modeling-compact-search" type="search" value="${esc(state.fieldSearch || '')}" placeholder="输入字段名快速筛选（支持上百列宽表）…" aria-label="搜索表内字段">
                <ul id="modeling-drawer-field-list" class="modeling-field-list">${renderFieldListItems(selected, columns, state.fieldSearch)}</ul>
            </div>`;
    }

    function semantics() {
        return `<div class="modeling-drawer-toolbar">
                ${button('dimension', '+ 添加维度', '', true)}
                ${button('metric', '+ 添加指标', '', true)}
                ${button('quick-recommend', '一键推荐维度与指标')}
            </div>
            <div class="modeling-card">
                <div class="modeling-card-header"><div><h5>分析维度（分组口径）</h5><span class="text-muted">用于按地区、部门、日期对指标分组切片。</span></div>${badge(`${state.draft.dimensions.length} 个维度`, state.draft.dimensions.length ? 'info' : 'muted')}</div>
                ${table(['维度名称', '来源表与字段', '类型 / 粒度', '操作'], state.draft.dimensions.map(dimension => {
                    return `<tr><td><strong>${esc(dimension.name)}</strong></td><td>${esc(nodeName(dimension.nodeId))} · ${esc(fieldName(dimension.nodeId, dimension.fieldKey))}</td><td>${esc(({ text: '文本', enum: '枚举', date: '日期', timestamp: '时间点' })[dimension.logicalType] || dimension.logicalType)}${dimension.granularity ? ` / ${esc(({ year: '按年', quarter: '按季', month: '按月', day: '按日' })[dimension.granularity] || '')}` : ''}</td><td><div class="modeling-row-actions">${button('dimension', '编辑', dimension.id)}${button('remove-dimension', '删除', dimension.id)}</div></td></tr>`;
                }), '暂未添加分析维度；可点击上方「+ 添加维度」或「一键推荐维度与指标」。')}
            </div>
            <div class="modeling-card">
                <div class="modeling-card-header"><div><h5>业务指标（统计口径）</h5><span class="text-muted">统一维护求和、均值、去重计数或派生比率公式。</span></div>${badge(`${state.draft.metrics.length} 个指标`, state.draft.metrics.length ? 'success' : 'muted')}</div>
                ${table(['指标名称与口径说明', '统计方式', '单位 / 小数', '操作'], state.draft.metrics.map(metric => {
                    const metricDesc = metric.description || '未填写口径说明';
                    return `<tr><td><div class="modeling-cell-primary"><strong>${esc(metric.name)}</strong><span title="${esc(metricDesc)}">${esc(metricDesc)}</span></div></td><td>${esc(({ count: '记录数', count_nonnull: '非空计数', count_distinct: '去重计数', sum: '求和', avg: '平均值', min: '最小值', max: '最大值', derived: '派生公式' })[metric.type])}${metric.field ? ` · ${esc(fieldName(metric.field.nodeId, metric.field.fieldKey))}` : ''}</td><td>${esc([metric.unit, metric.currency || ''].filter(Boolean).join(' ') || '数值')} · ${metric.scale}位</td><td><div class="modeling-row-actions">${button('metric', '编辑', metric.id)}${button('remove-metric', '删除', metric.id)}</div></td></tr>`;
                }), '暂未添加业务指标；请至少添加一个指标后再执行检查与发布。')}
            </div>`;
    }

    function quality() {
        const check = state.check;
        const statusLabel = check ? (({ queued: '排队中', running: '检查中…', passed: '完整检查通过', failed: '检查未通过（存在阻断项）', incomplete: '检查未完成', cancelled: '已取消' })[check.status] || check.status) : '待执行检查';
        const statusTone = !check ? 'muted' : check.status === 'passed' ? 'success' : ['queued', 'running'].includes(check.status) ? 'info' : 'danger';
        const issues = [
            ...(check?.report?.blockers || []).map(issue => ({ ...issue, level: '阻断', tone: 'danger' })),
            ...(check?.report?.warnings || []).map(issue => ({ ...issue, level: '警告', tone: 'warning' })),
            ...(state.selected.draftIssues || []).map(issue => ({ ...issue, level: '草稿待完善', tone: 'muted' }))
        ];
        return `<div class="modeling-card">
                <div class="modeling-card-header">
                    <div>
                        <div class="modeling-title-inline"><h5>发布前质量检查</h5>${badge(statusLabel, statusTone)}</div>
                        <span class="text-muted">${check ? `${esc(check.complete ? '已完成全量主键、关联基数与指标口径校验' : '尚未完成全量校验')}${check.manifestId ? ` · 清单 ${esc(check.manifestId)}` : ''}` : '修改草稿后点击“立即检查”，自动保存并校验主键唯一性与关联匹配率。'}</span>
                    </div>
                    <div class="modeling-bar-actions">
                        ${button('run-check', '立即检查', '', !check || check.status !== 'passed')}
                        ${check?.status === 'passed' ? button('go-publish', '发布当前版本', '', true) : ''}
                    </div>
                </div>
                ${table(['级别', '涉及对象', '诊断结果与处理建议'], issues.map(issue => `<tr><td>${badge(issue.level, issue.tone)}</td><td><strong>${esc(issueTargetLabel(issue))}</strong></td><td>${esc(issue.message)}${issue.rows ? `（涉及 ${esc(issue.rows)} 行）` : ''}</td></tr>`), check?.status === 'passed' ? '全部检查项均已通过，无阻断问题，可以安全发布版本或前往试算。' : '暂无诊断问题记录，请点击“立即检查”执行全量体检。')}
            </div>
            ${check?.report?.grains ? `<div class="modeling-card"><div class="modeling-card-header"><div><h5>表粒度与主键体检</h5></div></div>${table(['模型表', '总行数', '空键行', '重复键组', '转换失败'], check.report.grains.map(grain => `<tr><td><strong>${esc(nodeName(grain.nodeId))}</strong></td><td>${esc(grain.rowCount)}</td><td>${esc(grain.missingRows)}</td><td>${esc(grain.duplicateKeys)}</td><td>${esc(grain.conversionErrors)}</td></tr>`))}</div>` : ''}
            ${check?.report?.relations?.length ? `<div class="modeling-card"><div class="modeling-card-header"><div><h5>多表关联匹配率体检</h5></div></div>${table(['关联关系', '父表行', '匹配行', '未匹配', '关联后总行', '匹配率'], check.report.relations.map(relation => {
                const relObj = state.draft?.relations.find(item => item.id === relation.relationId);
                const rawRate = Number(relation.leftMatchRate);
                const rateLabel = relation.leftMatchRate !== null && relation.leftMatchRate !== undefined && !String(relation.leftMatchRate).includes('%') && Number.isFinite(rawRate) && rawRate <= 1 ? `${(rawRate * 100).toFixed(1)}%` : (relation.leftMatchRate ?? '—');
                return `<tr><td><strong>${esc(relObj ? `${nodeName(relObj.leftNodeId)} → ${nodeName(relObj.rightNodeId)}` : relation.relationId)}</strong></td><td>${esc(relation.leftRows)}</td><td>${esc(relation.matchedLeftRows)}</td><td>${esc(relation.unmatchedLeftRows)}</td><td>${esc(relation.joinedRows)}</td><td>${esc(rateLabel)}</td></tr>`;
            }))}</div>` : ''}
            <div class="modeling-card">
                <div class="modeling-card-header">
                    <div><h5>下游依赖与历史版本</h5><span class="text-muted">查看引用当前模型的分析视图、仪表盘血缘关系与历史口径差异。</span></div>
                    <div class="modeling-bar-actions">${button('drawer-dependencies', '查看依赖与血缘')}${button('drawer-versions', '查看版本与差异')}</div>
                </div>
                <div id="modeling-dependencies"></div>
                <div id="modeling-versions"></div>
            </div>`;
    }

    function trial() {
        const definition = state.queryMode === 'trial' ? state.draft : state.analysisDefinition;
        const options = state.selected.versionOptions || [];
        return `<div class="modeling-card modeling-trial-card">
                <div class="modeling-card-header">
                    <div><h5>模型口径试算与正式查询</h5><span class="text-muted">勾选需要汇总的维度与指标；正式发布版本计算后可生成图表、透视表、保存视图或导出文件。</span></div>
                    <div class="modeling-bar-actions">
                        ${button('add-query-filter', '+ 添加筛选条件')}
                        ${state.queryMode === 'trial' ? button('trial', '运行草稿试算', '', true) : button('run-published', '运行发布版本', '', true)}
                        ${button('cancel-run', '取消运行')}
                    </div>
                </div>
                <div class="modeling-trial-controls">
                    <div class="modeling-trial-top-row">
                        <label><span class="modeling-field-label">计算口径来源</span><select id="modeling-query-mode" class="form-input">${state.selected.isOwner ? `<option value="trial"${state.queryMode === 'trial' ? ' selected' : ''}>当前草稿试算（快速验证口径）</option>` : ''}${state.selected.publishedVersion ? `<option value="published"${state.queryMode === 'published' ? ' selected' : ''}>正式发布版本（可导出与保存视图）</option>` : ''}</select></label>
                        ${state.queryMode === 'published' ? `<label><span class="modeling-field-label">选择发布版本</span><select id="modeling-query-version" class="form-input">${options.map(item => `<option value="${item.version}"${item.version === state.analysisVersion ? ' selected' : ''}>v${item.version}</option>`).join('')}</select></label>` : ''}
                        <label><span class="modeling-field-label">最多展示分组行数</span><input id="modeling-query-limit" type="number" class="form-input" min="1" max="5000" value="100"></label>
                    </div>
                    <div class="modeling-trial-selectors">
                        <div class="modeling-multi-group" data-modeling-multi-group>
                            <div class="modeling-multi-head"><span class="modeling-field-label">分组维度（最多勾选 5 个）</span><div class="modeling-multi-actions"><button class="btn-secondary" type="button" data-modeling-multi-action="all" data-modeling-multi-limit="5">选前5项</button><button class="btn-secondary" type="button" data-modeling-multi-action="clear">清空</button></div></div>
                            <select id="modeling-query-dimensions" class="form-input modeling-multi-select" multiple aria-label="分组维度">${(definition?.dimensions || []).map(dimension => `<option value="${esc(dimension.id)}">${esc(dimension.name)}</option>`).join('')}</select>
                        </div>
                        <div class="modeling-multi-group" data-modeling-multi-group>
                            <div class="modeling-multi-head"><span class="modeling-field-label">统计指标（必选，最多勾选 10 个）</span><div class="modeling-multi-actions"><button class="btn-secondary" type="button" data-modeling-multi-action="all" data-modeling-multi-limit="10">全选</button><button class="btn-secondary" type="button" data-modeling-multi-action="clear">清空</button></div></div>
                            <select id="modeling-query-metrics" class="form-input modeling-multi-select" multiple aria-label="统计指标">${(definition?.metrics || []).map(metric => `<option value="${esc(metric.id)}">${esc(metric.name)}</option>`).join('')}</select>
                        </div>
                    </div>
                    <div id="modeling-query-filters" class="modeling-trial-filters"></div>
                </div>
            </div>
            <div id="modeling-run-result" class="modeling-card modeling-result-card" aria-live="polite"></div>`;
    }

    function renderDrawer() {
        if (!state.drawerOpen) return '';
        const mode = state.drawerMode || 'node';
        const titles = {
            node: '节点属性与算子配置',
            semantics: '分析维度与业务指标',
            quality: '质量检查与版本血缘',
            trial: '模型试算与正式分析'
        };
        const isWide = ['semantics', 'quality', 'trial'].includes(mode);
        let bodyContent = '';
        if (mode === 'semantics') bodyContent = semantics();
        else if (mode === 'quality') bodyContent = quality();
        else if (mode === 'trial') bodyContent = trial();
        else bodyContent = renderNodeDrawerContent();

        const drawerAriaLabel = esc(titles[mode] || '建模配置抽屉');
        return `<aside id="modeling-drawer" class="modeling-node-drawer${isWide ? ' is-wide' : ''}" aria-label="${drawerAriaLabel}">
            <div class="modeling-drawer-header">
                <div class="modeling-drawer-tabs" role="tablist">
                    ${[['node', '节点配置'], ['semantics', `维度指标 (${state.draft.dimensions.length}/${state.draft.metrics.length})`], ['quality', '检查血缘'], ['trial', '试算分析']].map(([key, label]) => {
                        return `<button class="btn-secondary modeling-drawer-tab${mode === key ? ' is-active' : ''}" type="button" role="tab" aria-selected="${mode === key}" data-modeling-action="drawer-mode" data-modeling-id="${key}">${esc(label)}</button>`;
                    }).join('')}
                </div>
                ${button('close-drawer', '关闭')}
            </div>
            <div id="modeling-drawer-body" class="modeling-drawer-body">${bodyContent}</div>
        </aside>`;
    }

    function renderStudio() {
        const fact = state.draft.nodes.find(node => node.role === 'fact');
        const allNodes = [
            ...state.draft.nodes.map(n => ({ id: n.id, name: n.name, tag: n.role === 'fact' ? '事实' : '维度', isFact: n.role === 'fact' })),
            ...(state.flowGraph?.nodes || []).map(n => ({ id: n.id, name: n.name, tag: m.OPERATOR_MAP?.get(n.kind)?.badge || '算子', isFact: false }))
        ];
        const grainSummary = state.draft.grainDescription
            ? `<div class="modeling-canvas-grain-bar"><span><strong>事实表粒度：</strong>${esc(state.draft.grainDescription)}</span>${fact?.grainKeys?.length ? `<span class="text-muted">主键：${esc(fact.grainKeys.map(k => fieldName(fact.id, k)).join(' + '))}</span>` : ''}</div>`
            : '';

        const isWideDrawer = state.drawerOpen && ['semantics', 'quality', 'trial'].includes(state.drawerMode);
        const shellClass = [
            'modeling-studio-shell',
            state.paletteCollapsed ? 'is-palette-collapsed' : '',
            state.drawerOpen ? 'has-drawer' : '',
            isWideDrawer ? 'has-wide-drawer' : ''
        ].filter(Boolean).join(' ');

        return `<div class="${shellClass}">
            ${state.paletteCollapsed ? '' : `<aside class="modeling-rail modeling-studio-palette">
                ${m.canvasPalette()}
                <div class="modeling-rail-section">
                    <div class="modeling-rail-head"><h5>画布节点</h5><span class="modeling-rail-count">${allNodes.length}</span></div>
                    <div class="modeling-node-list">${allNodes.map(item => {
                        return `<button class="btn-secondary modeling-node-item${item.id === state.selectedNodeId ? ' is-selected' : ''}" type="button" data-modeling-action="node-select" data-modeling-id="${esc(item.id)}"><span class="modeling-node-role${item.isFact ? ' is-fact' : ''}">${esc(item.tag)}</span><span class="modeling-node-label" title="${esc(item.name)}">${esc(item.name)}</span></button>`;
                    }).join('')}</div>
                </div>
            </aside>`}
            <div class="modeling-canvas-stage">
                <div class="modeling-canvas-toolbar-wrap">
                    ${m.canvasToolbar()}
                </div>
                ${grainSummary}
                <div class="modeling-graph-container">${m.canvasGraph()}</div>
                ${m.renderPreviewDock ? m.renderPreviewDock() : ''}
            </div>
            ${renderDrawer()}
        </div>`;
    }

    function cacheNotice(result) {
        if (!result?.cache?.hit) return '';
        return `<div class="modeling-notice is-info" role="status">复用相同数据与口径的已验证结果，原计算时间：${esc(result.cache.computedAt || '未记录')}。本次已按当前权限核对。</div>`;
    }

    function renderRun() {
        const target = byId('modeling-run-result'), run = state.run;
        if (!target) return;
        if (!run) {
            html(target, '<div class="modeling-empty-inline"><p>请在上方勾选至少一个指标，点击“运行草稿试算”或“运行发布版本”查看汇总结果。</p></div>');
            return;
        }
        if (run.resultExpired) {
            html(target, '<div class="modeling-notice is-warning">该次运行结果的保留期已结束，请点击上方运行按钮重新计算。</div>');
            return;
        }
        if (run.status !== 'succeeded') {
            const statusText = ({ queued: '排队等待执行…', running: '正在精确计算…', retry_wait: '等待重试…', failed: '执行失败', cancelled: '已取消运行', cancelling: '正在取消…' })[run.status] || run.status;
            html(target, `<div class="modeling-notice ${run.status === 'failed' ? 'is-danger' : 'is-info'}">运行状态：${esc(statusText)}${run.lastError ? ` — ${esc(run.lastError)}` : ''}</div>`);
            return;
        }
        const result = run.result, dimensions = result?.columns?.dimensions || [], metrics = result?.columns?.metrics || [];
        const definition = run.executionKind === 'model_trial' ? state.draft : state.analysisDefinition || state.draft;
        const label = id => definition?.dimensions.find(item => item.id === id)?.name || definition?.metrics.find(item => item.id === id)?.name || id;
        const formatValue = metric => metric?.value === null ? ({ mixed_currency: '不同币种不可合计', zero_denominator: '分母为零', no_valid_values: '无有效值' })[metric.nullReason] || '无有效值' : `${metric?.value ?? ''}${metric?.currency ? ` ${metric.currency}` : ''}`;
        const row = (record, total = false) => `<tr${total ? ' class="modeling-total-row"' : ''}>${dimensions.map((id, index) => `<td>${total ? (index === 0 ? '<strong>总计</strong>' : '') : esc(record.members[id]?.unmatched ? '未匹配' : record.members[id]?.label ?? '空值')}</td>`).join('')}${metrics.map(id => `<td class="modeling-num-cell">${esc(formatValue(record.values[id]))}</td>`).join('')}</tr>`;
        const page = state.resultPage?.runId === run.id ? state.resultPage : null;
        const rows = page?.rows || (result?.rows || []).slice(0, 100);
        html(target, `<div class="modeling-result-head">
                <div class="modeling-result-meta">
                    ${badge(result?.trial ? '草稿试算结果' : `正式版本 v${run.publishedVersion}`, result?.trial ? 'warning' : 'success')}
                    <span>共 ${esc(result?.groupCount || '0')} 个分组 · ${result?.truncated ? '总计包含未展示分组' : '总计覆盖全部过滤结果'}</span>
                    <span class="text-muted">来源截止：${esc((result?.dataTimes || []).map(item => `${nodeName(item.nodeId)} ${item.updatedAt}`).join('；') || '—')}</span>
                </div>
                <div class="modeling-bar-actions">
                    ${button('chart-result', '生成图表')}
                    ${button('pivot-result', '交叉透视')}
                    ${run.executionKind === 'model_trial' ? '' : `${button('save-view', '保存为分析视图', '', true)}${button('export-csv', '导出 CSV')}${button('export-xlsx', '导出 XLSX')}`}
                </div>
            </div>
            ${cacheNotice(result)}
            ${run.stale ? '<div class="modeling-notice is-warning" role="status">当前显示历史快照结果，请留意来源数据更新时间。</div>' : ''}
            ${table([...dimensions.map(label), ...metrics.map(label)], [...rows.map(record => row(record)), ...(dimensions.length && result?.total ? [row(result.total, true)] : [])])}
            <div class="workspace-pagination">${button('result-first-page', '第一页')}${page?.nextCursor || !page && (result?.rows?.length > 100 || result?.displayedRows > 100) ? button('result-next-page', '下一页') : ''}</div>
            <div id="modeling-consumer-result" class="modeling-consumer-box"></div>`);
    }

    function updateFieldSearchDom() {
        const listEl = byId('modeling-drawer-field-list');
        if (!listEl || !state.draft) return;
        const fact = state.draft.nodes.find(node => node.role === 'fact');
        const selected = state.draft.nodes.find(node => node.id === state.selectedNodeId) || fact || state.draft.nodes[0];
        const source = state.selected?.sources?.find(item => item.nodeId === selected?.id) || app.state.datasets.find(item => item.id === selected?.datasetId);
        html(listEl, renderFieldListItems(selected, source?.columns || [], state.fieldSearch));
    }

    function render() {
        mount();
        byId('modeling-list')?.classList.toggle('hidden', Boolean(state.selected));
        byId('modeling-editor')?.classList.toggle('hidden', !state.selected);
        if (!state.selected) { renderList(); return; }
        byId('modeling-title').textContent = state.selected.name;
        byId('modeling-version').textContent = `草稿修订 ${state.selected.version} · ${state.selected.publishedVersion ? `发布 v${state.selected.publishedVersion}` : '尚未发布'}`;
        byId('modeling-status').textContent = state.selected.message || `${lifecycle(state.selected)} · ${state.selected.isOwner ? '所有者可编辑' : '共享只读'} · 业务时区 ${state.draft?.timezone || '—'}`;
        renderSaveState();

        const semBtn = byId('modeling-editor')?.querySelector('[data-modeling-action="open-semantics"]');
        if (semBtn && state.draft) {
            semBtn.textContent = `维度与指标 (${state.draft.dimensions.length}/${state.draft.metrics.length})`;
            semBtn.classList.toggle('is-selected', state.drawerOpen && state.drawerMode === 'semantics');
        }
        const analyzeBtn = byId('modeling-editor')?.querySelector('[data-modeling-action="analyze"]');
        if (analyzeBtn) {
            analyzeBtn.classList.toggle('is-selected', state.drawerOpen && state.drawerMode === 'trial');
        }

        const content = byId('modeling-content');
        if (!state.draft && !state.analysisDefinition) {
            html(content, '<div class="modeling-card"><div class="modeling-notice is-danger">当前模型的底层来源数据集不可用或无访问权限，请联系模型维护者核查数据集权限。</div></div>');
            return;
        }
        if (!state.draft && state.analysisDefinition) {
            html(content, trial());
            renderRun();
            return;
        }

        html(content, renderStudio());

        const disabled = !state.selected.isOwner || state.selected.lifecycle === 'archived';
        const editableActions = new Set([
            'save', 'check', 'run-check', 'publish', 'go-publish', 'basic', 'add-node', 'node', 'edit-node-modal',
            'edit-fact-grain', 'relation', 'edit-relation-modal', 'remove-node', 'remove-relation', 'remove-flow-node',
            'dimension', 'remove-dimension', 'metric', 'remove-metric', 'quick-recommend', 'field-dimension',
            'field-metric', 'trial', 'share', 'refresh-data', 'transfer', 'materialize-node'
        ]);
        byId('modeling-editor').querySelectorAll('[data-modeling-action]').forEach(btn => {
            if (editableActions.has(btn.dataset.modelingAction)) btn.disabled = disabled;
        });

        if (state.drawerOpen && state.drawerMode === 'trial') renderRun();
        m.renderDependencies?.();
        m.renderVersions?.();
        m.renderMigrationReport?.();
    }

    Object.assign(m, { mount, render, renderList, renderSaveState, renderRun, updateFieldSearchDom, fieldName, nodeName, button, badge, html, cacheNotice });
})();
