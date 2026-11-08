/* global Event */
(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling;
    const { state, request, json } = m;
    const byId = id => document.getElementById(id);
    const path = suffix => `/models/${encodeURIComponent(state.selected.id)}${suffix}`;
    const visible = () => !document.hidden && !byId('data-analysis-modeling-panel')?.classList.contains('hidden');
    let editRevision = 0;
    const changed = m.changed;
    m.changed = () => { editRevision++; changed(); };
    function editable() { if (!state.selected?.isOwner || state.selected.lifecycle === 'archived') throw new Error('当前模型只读，请由所有者编辑未归档草稿。'); }
    function saved() { if (state.dirty) throw new Error('草稿尚未保存，请先点击“保存草稿”，再执行此操作。'); }

    async function loadList() {
        m.mount();
        const current = m.capture('list');
        const data = await request('/models?limit=200');
        if (!current()) return;
        state.models = data.models || [];
        m.renderList();
    }

    async function loadModel(id, { force = false } = {}) {
        if (!force && !await m.canLeave()) return;
        m.reset();
        state.selected = state.models.find(model => model.id === id) || { id, name: '正在加载模型', availability: 'loading' };
        state.saveState = 'saved';
        state.drawerOpen = false;
        state.drawerMode = 'node';
        const current = m.capture('model');
        m.render();
        const data = await request(`/models/${encodeURIComponent(id)}`);
        if (!current()) return;
        state.selected = data.model;
        state.draft = m.clone(data.model.definition);
        state.flowGraph = m.clone(data.model.flowGraph || { nodes: [], edges: [] });
        state.canvasLayout = Object.assign(Object.create(null), m.clone(data.model.canvasLayout || {}));
        state.dirty = false;
        state.check = data.model.latestCheck || null;
        state.analysisDefinition = data.model.publishedDefinition || null;
        state.analysisVersion = data.model.publishedVersion;
        state.queryMode = data.model.publishedVersion ? 'published' : 'trial';
        state.selectedNodeId = state.draft?.nodes.find(node => node.role === 'fact')?.id || '';
        m.render();
    }

    async function saveDraft() {
        editable();
        if (!state.draft || !state.dirty) return;
        const current = m.capture('save'), revision = editRevision;
        const definition = m.clone(state.draft);
        const canvasLayout = m.clone(state.canvasLayout);
        const flowGraph = m.clone(state.flowGraph || { nodes: [], edges: [] });
        state.saveState = 'saving';
        m.renderSaveState();
        try {
            const data = await request(path('/draft'), json({ expectedVersion: state.selected.version, definition, canvasLayout, flowGraph }, 'PUT'));
            if (!current()) return;
            state.selected = data.model;
            if (revision === editRevision) {
                state.draft = m.clone(data.model.definition);
                state.flowGraph = m.clone(data.model.flowGraph || { nodes: [], edges: [] });
                state.canvasLayout = Object.assign(Object.create(null), m.clone(data.model.canvasLayout || {}));
                state.dirty = false;
                state.saveState = 'saved';
            } else {
                state.dirty = true;
                state.saveState = 'unsaved';
            }
            state.check = null;
            m.render();
        } catch (error) {
            if (current()) { state.saveState = 'failed'; m.renderSaveState(); }
            throw error;
        }
    }

    async function ensureSaved() {
        if (!state.dirty) return;
        editable();
        await saveDraft();
    }

    function createModel() {
        const availableDatasets = app.state.datasets || [];
        if (!availableDatasets.length) {
            m.dialog('新建数据模型', `<div class="modeling-empty-inline"><p>当前尚未导入任何表格数据集。请先前往「数据分析」上传 CSV 或 Excel 文件，再返回此处建立模型。</p><button class="btn-primary" type="button" data-modeling-action="goto-analysis">前往上传数据集</button></div>`, null);
            return;
        }
        m.dialog('新建数据模型', `${m.input('name', '模型名称', '', 'maxlength="120" required placeholder="例如：销售订单分析模型、学生成绩分析模型"')}${m.select('factDatasetId', '核心业务主表（事实表）', availableDatasets.map(dataset => [dataset.id, dataset.name]), availableDatasets[0]?.id || '')}${m.input('businessOwner', '业务负责人（发布前必填）', '', 'maxlength="120" placeholder="填写口径负责人姓名或部门"')}${m.input('maintenanceContact', '维护联系人（发布前必填）', '', 'maxlength="240" placeholder="填写日常维护人或联系方式"')}<label class="modeling-span-full"><span class="modeling-field-label">业务用途说明（可选）</span><input class="form-input" name="modeling_description" value="" maxlength="1000" placeholder="简要说明该模型面向的分析场景"></label><p class="modeling-dialog-note">提示：创建后可在一体化画布中点击节点打开右侧配置抽屉，拖入维度表、内置算子或自定义 SQL，并随时预览节点输出数据。</p>`, async form => {
            const current = m.capture('create-model');
            const data = await request('/models', json({ modelKind: 'production', name: m.value(form, 'name'), description: m.value(form, 'description'), businessOwner: m.value(form, 'businessOwner'), maintenanceContact: m.value(form, 'maintenanceContact'), factDatasetId: m.value(form, 'factDatasetId') }));
            if (!current()) return;
            await loadList();
            await loadModel(data.model.id, { force: true });
        });
    }

    function editBasic() {
        editable();
        m.dialog('模型基本信息与更新策略', `${m.input('name', '模型名称', state.selected.name, 'maxlength="120" required')}${m.input('timezone', '业务时区', state.draft.timezone, 'maxlength="80" required')}${m.input('businessOwner', '业务负责人', state.selected.businessOwner || '', 'maxlength="120" required')}${m.input('maintenanceContact', '维护联系人', state.selected.maintenanceContact || '', 'maxlength="240" required')}<label class="modeling-span-full"><span class="modeling-field-label">用途说明</span><input class="form-input" name="modeling_description" value="${app.esc(state.selected.description || '')}" maxlength="1000"></label><details class="modeling-advanced-panel"><summary>数据新鲜度、业务范围与跨表水位策略（高级可选）</summary><div class="modeling-advanced-grid">${m.input('refreshCadence', '期望刷新周期（秒）', state.draft.refreshCadence, 'type="number" min="1" max="31622400"')}${m.input('maxStaleness', '最大允许陈旧时间（秒）', state.draft.maxStaleness, 'type="number" min="1" max="31622400"')}${m.select('freshnessPolicy', '数据超期处理策略', [['strict', '严格：超过陈旧时限拒绝新计算'], ['historical_manual', '宽松：允许查看并标注历史结果']], state.draft.freshnessPolicy)}${m.select('coveragePolicy', '数据覆盖范围声明', [['complete', '完整业务数据范围'], ['partial', '局部样本或阶段数据']], state.draft.coveragePolicy)}${m.select('watermarkPolicy', '多表数据同步要求', [['independent', '各表保留独立更新时间'], ['same_batch', '要求所有表来自同一批次'], ['same_period', '要求所有表处于同一账期']], state.draft.watermarkPolicy)}</div></details>`, async form => {
            const current = m.capture('basic');
            const data = await request(path(''), json({ name: m.value(form, 'name'), description: m.value(form, 'description'), businessOwner: m.value(form, 'businessOwner'), maintenanceContact: m.value(form, 'maintenanceContact'), expectedVersion: state.selected.version }, 'PUT'));
            if (!current()) return;
            state.selected = data.model;
            for (const key of ['timezone', 'freshnessPolicy', 'coveragePolicy', 'watermarkPolicy']) state.draft[key] = m.value(form, key);
            for (const key of ['refreshCadence', 'maxStaleness']) state.draft[key] = m.number(form, key);
            m.changed();
            m.render();
        });
    }

    async function pollCheck(id) {
        m.stopPolling();
        const current = m.capture('check');
        const data = await request(path(`/checks/${encodeURIComponent(id)}`));
        if (!current()) return;
        state.check = data.check;
        if (state.drawerOpen && state.drawerMode === 'quality') m.render();
        if (['queued', 'running'].includes(state.check.status) && visible()) {
            state.pollTimer = setTimeout(() => pollCheck(id).catch(error => app.toast(error.message, 'error')), 1200);
        }
    }

    async function checkModel() {
        editable();
        await ensureSaved();
        if (state.selected.migrationOrigin && !state.selected.publishedVersion) return m.migrationCheck();
        const current = m.capture('create-check');
        const data = await request(path('/checks'), json({ expectedVersion: state.selected.version, requestKey: m.key() }));
        if (!current()) return;
        state.check = data.check;
        state.drawerMode = 'quality';
        state.drawerOpen = true;
        m.render();
        await pollCheck(data.check.id);
    }

    async function publish() {
        editable();
        await ensureSaved();
        if (!state.check || state.check.status !== 'passed' || !state.check.complete) {
            throw new Error('请先点击“检查”完成当前草稿的全量校验，并处理所有阻断项后再发布。');
        }
        const warnings = state.check.report?.warnings || [];
        m.dialog('发布模型版本', `<p class="modeling-dialog-note">发布后将生成不可变的正式口径版本，供图表、透视表、仪表盘及共享人员稳定复用；已有分析视图保持原固定版本不受影响。</p>${warnings.map((warning, index) => `${m.checkbox(`warning${index}`, warning.message)}${m.input(`reason${index}`, '接受此警告的业务原因', '', 'maxlength="1000" required')}`).join('')}${m.checkbox('confirm', '已核对表粒度、关联关系、指标口径及检查结果，确认正式发布')}`, async form => {
            if (!m.checked(form, 'confirm') || warnings.some((_, index) => !m.checked(form, `warning${index}`))) {
                throw new Error('请勾选发布确认项，并逐条确认可接受的质量警告及原因。');
            }
            const current = m.capture('publish');
            const data = await request(path('/publish'), json({ expectedVersion: state.selected.version, checkId: state.check.id, requestKey: m.key(), warningAcceptance: warnings.map((warning, index) => ({ code: warning.code, relationId: warning.relationId || null, metricId: warning.metricId || null, reason: m.value(form, `reason${index}`) })) }));
            if (!current()) return;
            state.selected.publishedVersion = data.version.version;
            app.toast('模型正式版本已发布。', 'success');
            await loadModel(state.selected.id, { force: true });
        });
    }

    async function pollRun(id) {
        m.stopPolling();
        const current = m.capture('run');
        const data = await request(`/async-queries/${encodeURIComponent(id)}`);
        if (!current()) return;
        state.run = data.job || data;
        m.renderRun();
        if (['queued', 'running', 'retry_wait', 'cancelling'].includes(state.run.status) && visible()) {
            state.pollTimer = setTimeout(() => pollRun(id).catch(error => app.toast(error.message, 'error')), 1200);
        }
    }

    async function ensureCheckedForTrial() {
        if (state.check?.status === 'passed') return;
        if (state.selected.migrationOrigin && !state.selected.publishedVersion) {
            throw new Error('迁移草稿首次试算前，请先点击顶部“检查”完成新旧探索对照。');
        }
        const current = m.capture('trial-precheck');
        const created = await request(path('/checks'), json({ expectedVersion: state.selected.version, requestKey: m.key() }));
        if (!current()) return;
        state.check = created.check;
        for (let attempt = 0; attempt < 25 && ['queued', 'running'].includes(state.check?.status); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 400));
            const polled = await request(path(`/checks/${encodeURIComponent(state.check.id)}`));
            if (!current()) return;
            state.check = polled.check;
        }
        if (state.check?.status !== 'passed') {
            state.drawerMode = 'quality';
            state.drawerOpen = true;
            m.render();
            throw new Error('草稿检查发现阻断问题，已在右侧抽屉展开「检查血缘」供您查看修复提示。');
        }
    }

    async function runQuery(trial) {
        if (trial !== (state.queryMode === 'trial')) throw new Error('请先切换分析口径，再运行对应的草稿或发布版本。');
        const dimensions = Array.from(byId('modeling-query-dimensions')?.selectedOptions || [], option => option.value);
        const metrics = Array.from(byId('modeling-query-metrics')?.selectedOptions || [], option => option.value);
        const filters = m.readFilters(byId('modeling-query-filters'));
        const limit = Number(byId('modeling-query-limit')?.value || 100);
        if (!metrics.length) throw new Error('请至少勾选一个统计指标后再运行。');
        if (trial) {
            editable();
            await ensureSaved();
            await ensureCheckedForTrial();
        } else {
            saved();
            if (!state.selected.publishedVersion) throw new Error('请先发布模型版本，再运行正式分析。');
        }
        const current = m.capture('create-run');
        const query = { dimensions, metrics, filters, limit, execution: 'auto', requestKey: m.key() };
        if (trial) { query.expectedVersion = state.selected.version; query.checkId = state.check.id; }
        else query.publishedVersion = state.analysisVersion || state.selected.publishedVersion;
        const data = await request(path(trial ? '/trial-queries' : '/queries'), json(query));
        if (!current()) return;
        state.run = data.job;
        state.resultPage = null;
        m.renderRun();
        await pollRun(data.job.id);
    }

    function quickRecommendSemantics() {
        editable();
        const fact = state.draft.nodes.find(node => node.role === 'fact');
        if (!fact) throw new Error('请先确认事实主表。');
        let addedDims = 0, addedMetrics = 0;
        const isNumericColumn = column => {
            const rawType = String(column.type || '').toLowerCase();
            const label = String(column.name || '');
            if (/编号|编码|代码|序号|手机|电话|身份证|邮编|id$/i.test(label)) return false;
            return /int|float|double|num|dec|real/.test(rawType) || /金额|成绩|分数|数量|销量|单价|费用|收入|支出|成本|利润|人数|时长|重量/.test(label);
        };
        const isDateColumn = column => /date|time/i.test(String(column.type || '')) || /日期|时间|月份|年份|季度/.test(String(column.name || ''));
        for (const node of state.draft.nodes) {
            for (const column of m.columns(node.id)) {
                if (state.draft.dimensions.length >= 16) break;
                if (state.draft.dimensions.some(dim => dim.nodeId === node.id && dim.fieldKey === column.key)) continue;
                if (node.role === 'fact' && isNumericColumn(column) && !node.grainKeys.includes(column.key)) continue;
                const logicalType = isDateColumn(column) ? 'date' : 'text';
                const dim = { id: `dimension_${m.key().replaceAll('-', '')}`, name: state.draft.dimensions.some(d => d.name === column.name) ? `${node.name}·${column.name}` : column.name, description: `按「${node.name}」的「${column.name}」分组`, nodeId: node.id, fieldKey: column.key, logicalType, memberKeyFields: [column.key], sort: 'asc', nullLabel: '空值' };
                if (logicalType === 'date') { dim.granularity = 'day'; dim.dateFormat = '%Y-%m-%d'; }
                state.draft.dimensions.push(dim);
                for (const metric of state.draft.metrics) {
                    if (!metric.allowedDimensionIds.includes(dim.id)) metric.allowedDimensionIds.push(dim.id);
                }
                addedDims++;
            }
        }
        const allDimIds = () => state.draft.dimensions.map(dim => dim.id);
        for (const column of m.columns(fact.id)) {
            if (state.draft.metrics.length >= 16) break;
            if (fact.grainKeys.includes(column.key) || !isNumericColumn(column)) continue;
            if (state.draft.metrics.some(metric => metric.field?.nodeId === fact.id && metric.field?.fieldKey === column.key)) continue;
            state.draft.metrics.push({
                id: `metric_${m.key().replaceAll('-', '')}`,
                name: `${column.name}合计`,
                description: `统计事实表「${fact.name}」中「${column.name}」字段的求和汇总`,
                type: 'sum',
                field: { nodeId: fact.id, fieldKey: column.key },
                numeric: { precision: 18, scale: 2, allowCurrency: false, allowThousands: true, allowPercent: false },
                scale: 2,
                unit: '',
                allowedDimensionIds: allDimIds(),
                invalidValuePolicy: 'block',
                required: false,
                filters: []
            });
            addedMetrics++;
        }
        if (!state.draft.metrics.some(metric => metric.type === 'count')) {
            state.draft.metrics.push({
                id: `metric_${m.key().replaceAll('-', '')}`,
                name: '记录条数',
                description: `统计事实表「${fact.name}」符合条件的业务记录总行数`,
                type: 'count',
                scale: 0,
                unit: '条',
                allowedDimensionIds: allDimIds(),
                invalidValuePolicy: 'block',
                required: false,
                filters: []
            });
            addedMetrics++;
        }
        if (!addedDims && !addedMetrics) {
            app.toast('当前字段均已配置对应的维度或指标，无需重复添加。');
            return;
        }
        m.changed();
        m.render();
        app.toast(`已自动生成 ${addedDims} 个维度与 ${addedMetrics} 个指标，您可按需编辑口径。`, 'success');
    }

    async function remove(kind, id) {
        editable();
        const key = ({ node: 'nodes', relation: 'relations', dimension: 'dimensions', metric: 'metrics' })[kind];
        const entity = state.draft[key].find(item => item.id === id);
        if (!entity) return;
        if (kind === 'node' && (entity.role === 'fact' || state.draft.dimensions.some(dimension => dimension.nodeId === id))) throw new Error('事实主表不能移除；移除维度表前请先删除引用该表的维度或筛选条件。');
        const contains = expression => expression?.metricId === id || expression?.args?.some(contains);
        if (kind === 'metric' && state.draft.metrics.some(metric => metric.id !== id && contains(metric.expression))) throw new Error('其他派生公式指标仍引用此指标，请先修改对应公式。');
        const depends = state.draft.metrics.some(metric => (metric.filters || []).some(filter => kind === 'dimension' ? filter.dimensionId === id : kind === 'node' && filter.field?.nodeId === id));
        if (depends) throw new Error('有指标的附加筛选条件引用了该对象，请先调整对应指标条件。');
        if (!await window.Pivot.legacy.showConfirm?.('移除模型对象', `确认从草稿移除「${entity.name || entity.id}」？此操作在保存后生效；已发布版本保留原口径。`)) return;
        state.draft[key] = state.draft[key].filter(item => item.id !== id);
        if (kind === 'node') {
            delete state.canvasLayout[id];
            state.draft.relations = state.draft.relations.filter(relation => relation.leftNodeId !== id && relation.rightNodeId !== id);
            if (state.flowGraph?.edges) {
                state.flowGraph.edges = state.flowGraph.edges.filter(edge => edge.fromNodeId !== id && edge.toNodeId !== id);
            }
            if (state.selectedNodeId === id) state.selectedNodeId = state.draft.nodes[0]?.id || '';
        }
        if (kind === 'dimension') for (const metric of state.draft.metrics) metric.allowedDimensionIds = metric.allowedDimensionIds.filter(value => value !== id);
        m.changed();
        m.render();
    }

    async function archive() {
        await ensureSaved();
        if (!state.selected.isOwner) throw new Error('只有所有者可以归档或恢复模型。');
        const archived = state.selected.lifecycle !== 'archived';
        if (!await window.Pivot.legacy.showConfirm?.(archived ? '归档模型' : '恢复模型', archived ? '归档后不能发起新分析，已保存资产仍按当前权限读取。确认继续？' : '确认恢复模型并允许后续编辑？')) return;
        const current = m.capture('archive');
        const data = await request(path('/archive'), json({ expectedVersion: state.selected.version, archived }));
        if (!current()) return;
        state.selected = data.model;
        m.render();
    }

    async function switchToDataAnalysis() {
        if (!await m.canLeave()) return;
        m.closeDialog();
        m.reset();
        window.Pivot.legacy.setAppsSessionValue?.('pivot_apps_active_app', 'data-analysis');
        app.state.modelingHostApp = 'data-analysis';
        app.activateTab(app.state.lastAnalysisTab || 'overview', { confirmed: true });
    }

    async function action(actionName, id) {
        if (['goto-analysis', 'goto-analysis-empty', 'goto-analysis-editor'].includes(actionName)) return switchToDataAnalysis();
        if (actionName === 'refresh-list') return loadList();
        if (actionName === 'reset-filters') {
            state.search = ''; state.ownership = 'all'; state.lifecycle = 'all'; state.availability = 'all'; state.listPage = 1;
            if (byId('modeling-search')) byId('modeling-search').value = '';
            for (const selectId of ['modeling-ownership', 'modeling-lifecycle', 'modeling-availability']) if (byId(selectId)) byId(selectId).value = 'all';
            m.renderList();
            return;
        }
        if (actionName === 'create' || actionName === 'create-empty') return createModel();
        if (actionName === 'select') return loadModel(id);
        if (actionName === 'legacy') return app.openLegacyDataModel?.(id);
        if (actionName === 'edit-model-list') {
            const target = state.models.find(item => item.id === id);
            if (!target) return;
            if (!target.isOwner) throw new Error('只有模型所有者可以编辑模型基本信息。');
            m.dialog('编辑模型基本信息', `${m.input('name', '模型名称', target.name, 'maxlength="120" required')}<label class="modeling-span-full"><span class="modeling-field-label">用途说明</span><input class="form-input" name="modeling_description" value="${app.esc(target.description || '')}" maxlength="1000" placeholder="请简要说明业务用途与分析场景"></label>${target.modelKind === 'production' ? `${m.input('businessOwner', '业务负责人', target.businessOwner || '', 'maxlength="120"')}${m.input('maintenanceContact', '维护联系人', target.maintenanceContact || '', 'maxlength="240"')}` : ''}`, async form => {
                const name = m.value(form, 'name');
                const description = m.value(form, 'description');
                const payload = { name, description, expectedVersion: target.version };
                if (target.modelKind === 'production') {
                    const ownerVal = m.value(form, 'businessOwner');
                    const contactVal = m.value(form, 'maintenanceContact');
                    if (ownerVal) payload.businessOwner = ownerVal;
                    if (contactVal) payload.maintenanceContact = contactVal;
                }
                const data = await request(`/models/${encodeURIComponent(target.id)}`, json(payload, 'PUT'));
                m.closeDialog();
                app.toast('模型信息已更新。', 'success');
                await loadList();
                if (state.selected?.id === target.id) {
                    state.selected = data.model;
                    m.render();
                }
            });
            return;
        }
        if (actionName === 'delete-model-list') {
            const target = state.models.find(item => item.id === id);
            if (!target) return;
            if (!target.isOwner) throw new Error('只有模型所有者可以删除模型。');
            const confirmed = typeof window.Pivot.legacy.showConfirm === 'function'
                ? await window.Pivot.legacy.showConfirm('删除数据模型', `确定删除数据模型「${target.name}」吗？已保存的分析视图和仪表盘将无法继续从此模型计算。`)
                : window.confirm(`确定删除数据模型「${target.name}」吗？`);
            if (!confirmed) return;
            await request(`/models/${encodeURIComponent(target.id)}`, json({ expectedVersion: target.version }, 'DELETE'));
            if (state.selected?.id === target.id) {
                m.reset();
            }
            app.toast('数据模型已删除。', 'success');
            await loadList();
            return;
        }
        if (actionName === 'close-dialog') return m.closeDialog();
        if (actionName === 'back') { if (!await m.canLeave()) return; m.reset(); m.render(); return loadList(); }
        if (actionName === 'previous-page' || actionName === 'next-page') { state.listPage += actionName === 'next-page' ? 1 : -1; m.renderList(); return; }
        if (actionName === 'toggle-palette') { state.paletteCollapsed = !state.paletteCollapsed; m.render(); return; }
        if (actionName === 'close-drawer') { state.drawerOpen = false; m.render(); return; }
        if (actionName === 'drawer-mode') { state.drawerMode = id || 'node'; state.drawerOpen = true; m.render(); return; }
        if (actionName === 'open-semantics' || actionName === 'goto-semantics') { state.drawerMode = 'semantics'; state.drawerOpen = true; m.render(); return; }
        if (actionName === 'goto-quality') { state.drawerMode = 'quality'; state.drawerOpen = true; m.render(); return; }
        if (actionName === 'analyze') { state.drawerMode = 'trial'; state.drawerOpen = true; m.render(); return; }
        if (actionName === 'node-select') {
            state.selectedNodeId = id;
            state.fieldSearch = '';
            state.drawerMode = 'node';
            state.drawerOpen = true;
            m.render();
            if (state.previewOpen) void m.runNodePreview?.(id).catch(() => { });
            return;
        }
        if (actionName === 'toggle-preview') {
            if (state.previewOpen) { state.previewOpen = false; m.render(); return; }
            return m.runNodePreview(state.selectedNodeId || state.draft?.nodes?.[0]?.id || '');
        }
        if (actionName === 'close-preview') { state.previewOpen = false; m.render(); return; }
        if (actionName === 'preview-node') return m.runNodePreview(id || state.selectedNodeId);
        if (actionName === 'materialize-node') { editable(); return m.materializeNodeDataset(id || state.selectedNodeId); }
        if (actionName === 'remove-flow-node') { editable(); m.removeFlowNode(id); return; }
        if (actionName === 'basic') return editBasic();
        if (actionName === 'save') return saveDraft();
        if (actionName === 'edit-fact-grain') { editable(); const fact = state.draft.nodes.find(node => node.role === 'fact'); return m.editNode(fact?.id || ''); }
        if (actionName === 'add-node') { editable(); return m.editNode(''); }
        if (actionName === 'node' || actionName === 'edit-node-modal') {
            editable();
            const fallbackId = id || (state.draft.nodes.some(n => n.id === state.selectedNodeId) ? state.selectedNodeId : state.draft.nodes[0]?.id || '');
            return m.editNode(fallbackId);
        }
        if (actionName === 'relation' || actionName === 'edit-relation-modal') { editable(); return m.editRelation(id); }
        if (actionName === 'dimension') { editable(); return m.editDimension(id); }
        if (actionName === 'metric') { editable(); return m.editMetric(id); }
        if (actionName === 'quick-recommend') return quickRecommendSemantics();
        if (actionName === 'field-dimension') {
            editable();
            const [nodeId, fieldKey] = String(id || '').split(':');
            const column = m.columns(nodeId).find(col => col.key === fieldKey);
            const logicalType = /date|time/i.test(String(column?.type || '')) || /日期|时间/.test(String(column?.name || '')) ? 'date' : 'text';
            return m.editDimension('', { nodeId, fieldKey, name: column?.name || '', logicalType });
        }
        if (actionName === 'field-metric') {
            editable();
            const fact = state.draft.nodes.find(node => node.role === 'fact');
            const column = fact ? m.columns(fact.id).find(col => col.key === id) : null;
            return m.editMetric('', { fieldKey: id, name: column ? `${column.name}合计` : '', type: 'sum', description: column ? `统计事实表「${column.name}」字段数值合计` : '' });
        }
        if (actionName.startsWith('remove-')) return remove(actionName.slice(7), id);
        if (actionName === 'check' || actionName === 'run-check') return checkModel();
        if (actionName === 'publish' || actionName === 'go-publish') return publish();
        if (actionName === 'archive') return archive();
        if (actionName === 'trial' || actionName === 'run-published') return runQuery(actionName === 'trial');
        if (actionName === 'cancel-run' && state.run) { await request(`/async-queries/${encodeURIComponent(state.run.id)}/cancel`, json({})); return pollRun(state.run.id); }
        if (actionName === 'add-query-filter') {
            const container = byId('modeling-query-filters');
            if (container.querySelectorAll('.modeling-filter-row').length >= 20) throw new Error('最多添加二十项筛选。');
            const row = document.createElement('div');
            m.html(row, m.queryFilterRow());
            container.appendChild(row.firstElementChild);
            return;
        }
        if (actionName === 'drawer-dependencies') return m.consumerAction?.('dependencies', id);
        if (actionName === 'drawer-versions') return m.consumerAction?.('versions', id);
        if (typeof m.consumerAction === 'function') return m.consumerAction(actionName, id);
    }

    function bind(root) {
        if (!root || root.dataset.modelingBound) return;
        root.dataset.modelingBound = 'true';
        m.bindCanvas(root);
        root.addEventListener('mousedown', event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const optionEl = event.target?.tagName === 'OPTION' ? event.target : null;
            const selectEl = optionEl?.closest?.('select[multiple]');
            if (!optionEl || !selectEl || selectEl.disabled) return;
            event.preventDefault();
            const scrollTop = selectEl.scrollTop;
            optionEl.selected = !optionEl.selected;
            selectEl.focus({ preventScroll: true });
            selectEl.scrollTop = scrollTop;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        });
        root.addEventListener('submit', event => { void m.submit(event); });
        root.addEventListener('change', event => {
            m.formChanged(event);
            m.handleOperatorInput?.(event);
            const filters = { 'modeling-ownership': 'ownership', 'modeling-lifecycle': 'lifecycle', 'modeling-availability': 'availability' };
            if (filters[event.target.id]) { state[filters[event.target.id]] = event.target.value; state.listPage = 1; m.renderList(); }
            if (['modeling-query-mode', 'modeling-query-version'].includes(event.target.id)) void m.querySourceChanged?.(event).catch(error => app.toast(error.message, 'error'));
        });
        root.addEventListener('input', event => {
            if (event.target.id === 'modeling-search') { state.search = event.target.value; state.listPage = 1; m.renderList(); return; }
            if (event.target.id === 'modeling-field-search') { state.fieldSearch = event.target.value; m.updateFieldSearchDom?.(); return; }
            if (event.target.id === 'modeling-dataset-search') {
                const pos = event.target.selectionStart;
                state.datasetSearch = event.target.value;
                m.render();
                const nextInput = byId('modeling-dataset-search');
                if (nextInput) { nextInput.focus(); if (Number.isInteger(pos)) nextInput.setSelectionRange(pos, pos); }
                return;
            }
            if (event.target.matches('[data-flow-node-name],[data-flow-cond-val],[data-flow-formula-name],[data-flow-formula-expr],[data-flow-agg-alias],[data-flow-sel-alias],#modeling-flow-sql-editor')) {
                m.handleOperatorInput?.(event);
            }
        });
        root.addEventListener('focusin', event => {
            if (event.target.matches?.('#modeling-flow-sql-editor, [data-flow-formula-expr]')) {
                m.handleOperatorInput?.(event);
            }
        });
        root.addEventListener('click', async event => {
            try {
                const openMore = root.querySelector('.modeling-more[open]');
                if (openMore && (!openMore.contains(event.target) || event.target.closest('.modeling-more-menu [data-modeling-action]'))) {
                    openMore.open = false;
                }
                const multiBtn = event.target.closest('[data-modeling-multi-action]');
                if (multiBtn) {
                    const group = multiBtn.closest('[data-modeling-multi-group]');
                    const selectEl = group?.querySelector('select[multiple]');
                    if (selectEl && !selectEl.disabled) {
                        const selectAll = multiBtn.dataset.modelingMultiAction === 'all';
                        const limit = Number(multiBtn.dataset.modelingMultiLimit || 999);
                        Array.from(selectEl.options).forEach((opt, idx) => { opt.selected = selectAll && idx < limit; });
                        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    return;
                }
                if (m.handleOperatorClick?.(event)) return;
                const trigger = event.target.closest('[data-modeling-action]');
                if (trigger && !trigger.disabled) {
                    const wasDisabled = trigger.disabled;
                    trigger.disabled = true;
                    try { await action(trigger.dataset.modelingAction, trigger.dataset.modelingId || ''); }
                    finally { if (trigger.isConnected) trigger.disabled = wasDisabled; }
                    return;
                }
                const removeBtn = event.target.closest('[data-modeling-remove-filter]');
                if (removeBtn) { removeBtn.closest('.modeling-filter-row').remove(); return; }
                if (event.target.closest('[data-modeling-add-metric-filter]')) {
                    const container = byId('modeling-metric-filters');
                    if (container.children.length >= 20) throw new Error('最多添加二十项条件。');
                    const row = document.createElement('div');
                    m.html(row, m.filterRow());
                    container.appendChild(row.firstElementChild);
                    return;
                }
                const graphNode = event.target.closest('[data-modeling-graph-node]');
                if (graphNode) {
                    state.selectedNodeId = graphNode.dataset.modelingGraphNode;
                    state.fieldSearch = '';
                    state.drawerMode = 'node';
                    state.drawerOpen = true;
                    m.render();
                    if (state.previewOpen) void m.runNodePreview?.(state.selectedNodeId).catch(() => { });
                }
            } catch (error) { app.toast(error.message || '模型操作失败，请重试。', 'error'); }
        });
        root.addEventListener('keydown', event => {
            const dialog = byId('data-analysis-modeling-dialog');
            if (event.key === 'Tab' && dialog && !dialog.classList.contains('hidden')) {
                const controls = Array.from(dialog.querySelectorAll('button,input,select,textarea,[tabindex="0"]')).filter(node => !node.disabled && node.getClientRects().length);
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
            if (event.key === 'Escape') {
                if (dialog && !dialog.classList.contains('hidden')) m.closeDialog();
                else if (state.drawerOpen) { state.drawerOpen = false; m.render(); }
            }
        });
    }

    const ensure = app.ensureView;
    app.ensureView = function (...args) { const view = ensure(...args); m.mount(); bind(view); return view; };
    const onTab = app.onDataAnalysisTabActivated;
    app.onDataAnalysisTabActivated = tab => {
        onTab?.(tab);
        m.stopPolling();
        if (tab === 'modeling') {
            m.mount();
            m.render();
            void loadList().catch(error => app.toast(error.message, 'error'));
            if (state.run && ['queued', 'running', 'retry_wait', 'cancelling'].includes(state.run.status)) void pollRun(state.run.id).catch(error => app.toast(error.message, 'error'));
            else if (state.check && ['queued', 'running'].includes(state.check.status)) void pollCheck(state.check.id).catch(error => app.toast(error.message, 'error'));
        } else {
            m.closeDialog();
        }
    };
    document.addEventListener('visibilitychange', () => {
        m.stopPolling();
        if (!visible()) return;
        if (state.run && ['queued', 'running', 'retry_wait', 'cancelling'].includes(state.run.status)) void pollRun(state.run.id).catch(error => app.toast(error.message, 'error'));
        else if (state.check && ['queued', 'running'].includes(state.check.status)) void pollCheck(state.check.id).catch(error => app.toast(error.message, 'error'));
    });
    Object.assign(m, { loadList, loadModel, saveDraft, checkModel, pollCheck, pollRun, action });
})();
