(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling;
    const { state, request, json, table } = m, { esc } = app;
    let inventory = null;
    const control = (form, name) => form.elements.namedItem(`modeling_${name}`);
    const reset = m.reset;
    m.reset = () => { inventory = null; reset(); };

    async function migrate(id) {
        const current = m.capture('migration-inventory'), data = await request(`/models/${encodeURIComponent(id)}/migration-inventory`);
        if (!current()) return;
        inventory = data.snapshot;
        const first = inventory.nodes[0], key = m.key();
        m.dialog('创建正式模型草稿', `<p>保留关联探索“${esc(inventory.sourceName)}”及其原有查询；新草稿需修正粒度、关系和指标后检查发布。</p>${m.input('name', '新模型名称', `${inventory.sourceName} · 正式`, 'maxlength="120" required')}${m.select('migrationFact', '事实数据集', inventory.nodes.map(node => [node.datasetId, node.name]), first.datasetId)}${m.many('migrationGrain', '事实粒度字段（需明确选择）', first.columns.map(column => [column.key, column.name]), [])}${m.input('grainDescription', '每行代表什么业务事件', '', 'maxlength="1000" required')}${m.input('businessOwner', '业务负责人', '', 'maxlength="120"')}${m.input('maintenanceContact', '维护联系人', '', 'maxlength="240"')}<p>${esc(inventory.relations.length)} 条原关联、${esc(inventory.metrics.length)} 个可见单数据集指标、${esc(inventory.views.length)} 个我的来源视图。关系方向及异常基数保留，不自动反转或清洗数据。</p>${inventory.unavailable.length ? '<p role="alert">存在缺失或无权关联字段，请先修复来源。</p>' : ''}${m.checkbox('confirmMigration', '已确认事实表和粒度；之后将按固定来源核对新旧结果')}`, async form => {
            if (!m.checked(form, 'confirmMigration') || !m.selected(form, 'migrationGrain').length) throw new Error('请明确选择事实粒度，并确认新旧对照流程。');
            const result = await request(`/models/${encodeURIComponent(id)}/formal-drafts`, json({ name: m.value(form, 'name'), factDatasetId: m.value(form, 'migrationFact'), grainKeys: m.selected(form, 'migrationGrain'), grainDescription: m.value(form, 'grainDescription'), businessOwner: m.value(form, 'businessOwner'), maintenanceContact: m.value(form, 'maintenanceContact'), expectedVersion: inventory.sourceRevision, snapshotHash: data.snapshotHash, requestKey: key }));
            if (!current()) return;
            inventory = null; await m.loadList(); await m.loadModel(result.model.id, { force: true });
        });
    }
    const changed = m.formChanged;
    m.formChanged = event => {
        changed(event);
        if (event.target.name !== 'modeling_migrationFact' || !inventory) return;
        const node = inventory.nodes.find(node => node.datasetId === event.target.value), form = event.target.form;
        m.html(control(form, 'migrationGrain'), (node?.columns || []).map(column => `<option value="${esc(column.key)}">${esc(column.name)}</option>`).join(''));
    };
    function migrationCheck() {
        const current = m.capture('migration-check'), key = m.key();
        m.dialog('检查与旧探索对照', `${m.many('comparisonDimensions', '对照维度（一至五个，建议选择原始分组字段）', state.draft.dimensions.map(item => [item.id, item.name]), [])}${m.many('comparisonMetrics', '对照指标（一至十个，请包含需要核对的金额）', state.draft.metrics.filter(item => ['count', 'sum', 'avg', 'min', 'max'].includes(item.type)).map(item => [item.id, item.name]), [])}<p>新旧计算共同使用本次检查固定的数据来源；旧探索可对照记录数、求和、平均及最小最大值，去重和派生口径通过正式试算核对。对照完整分组，不使用探索页的前五百行。超过五千分组需改选更粗的维度。</p>`, async form => {
            const data = await request(`/models/${encodeURIComponent(state.selected.id)}/checks`, json({ expectedVersion: state.selected.version, requestKey: key, migrationComparison: { dimensions: m.selected(form, 'comparisonDimensions'), metrics: m.selected(form, 'comparisonMetrics') } }));
            if (!current()) return;
            state.check = data.check; state.drawerMode = 'quality'; state.drawerOpen = true; m.render(); await m.pollCheck(data.check.id);
        });
    }
    function renderMigrationReport() {
        if (!state.selected?.migrationOrigin || !state.drawerOpen) return;
        const content = document.getElementById('modeling-drawer-body') || document.getElementById('modeling-content');
        if (!content) return;
        if (state.drawerMode === 'semantics') {
            const names = state.selected.migrationOrigin.metrics.filter(item => state.draft.metrics.some(metric => metric.id === item.metricId)).map(item => `${state.draft.metrics.find(metric => metric.id === item.metricId).name} ← 单数据集指标 ${item.sourceMetricId} 修订 ${item.sourceRevision}`);
            if (names.length) { const detail = document.createElement('details'); m.html(detail, `<summary>导入指标来源</summary>${names.map(name => `<p>${esc(name)}</p>`).join('')}`); content.appendChild(detail); }
        }
        if (state.drawerMode !== 'quality') return;
        const report = state.check?.report?.migrationComparison, element = document.createElement('section');
        m.html(element, `<h5>旧探索迁移对照</h5><p>来源：${esc(state.selected.migrationOrigin.sourceName)}。${report ? report.complete ? report.hasDifferences ? '对照完成，存在差异；发布时须填写接受原因。' : '对照完成，所选范围一致。' : '对照尚未完成。' : '首次发布前请选择维度与指标进行固定来源对照。'}</p>${report ? `<p>记录数：旧探索 ${esc(report.rows?.legacy ?? '—')} / 正式模型 ${esc(report.rows?.formal ?? '—')}；分组数 ${esc(report.groups?.legacy ?? '—')} / ${esc(report.groups?.formal ?? '—')}。</p>${table(['指标', '旧探索总计', '正式总计'], (report.totals || []).map(item => `<tr><td>${esc(state.draft.metrics.find(metric => metric.id === item.metricId)?.name || item.metricId)}</td><td>${esc(item.legacy ?? '空值')}</td><td>${esc(item.formal ?? '空值')}</td></tr>`))}${table(['关联', '旧探索未匹配', '正式未匹配'], (report.unmatched || []).map(item => `<tr><td>${esc(item.relationId)}</td><td>${esc(item.legacy)}</td><td>${esc(item.formal ?? '已移除')}</td></tr>`))}<details><summary>差异与原因（${esc(report.groupDifferenceCount || 0)} 项分组差异，最多展示一百项）</summary>${(report.reasons || []).map(reason => `<p>${esc(reason)}</p>`).join('')}${table(['分组', '指标', '旧值', '正式值', '原因'], (report.differences || []).map(item => `<tr><td>${esc(item.group.map(value => value ?? '空值').join(' / '))}</td><td>${esc(state.draft.metrics.find(metric => metric.id === item.metricId)?.name || '分组范围')}</td><td>${esc(item.legacy ?? '无记录')}</td><td>${esc(item.formal ?? '无记录')}</td><td>${esc(item.reason)}</td></tr>`))}</details>` : ''}`);
        content.appendChild(element);
    }
    const action = m.consumerAction;
    m.consumerAction = (name, id) => name === 'migrate' ? migrate(id) : action?.(name, id);
    Object.assign(m, { migrationCheck, renderMigrationReport });
})();
