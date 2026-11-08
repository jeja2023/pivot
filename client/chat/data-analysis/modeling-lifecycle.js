(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling;
    const { state, request, json, table } = m, { esc } = app;
    const button = (action, label, id) => `<button class="btn-secondary" type="button" data-modeling-action="${action}" data-modeling-id="${esc(id || '')}">${esc(label)}</button>`;
    const path = suffix => `/models/${encodeURIComponent(state.selected.id)}${suffix}`;
    const owner = async () => { if (!state.selected?.isOwner) throw new Error('只有模型所有者可以执行此操作。'); if (state.dirty) await m.saveDraft(); };
    const csv = value => String(value || '').split(',').filter(Boolean);

    async function versions() {
        const current = m.capture('versions');
        const data = await request(path('/versions'));
        if (!current()) return;
        state.versions = data.versions;
        const kinds = { nodes: '表', relations: '关联', dimensions: '维度', metrics: '指标', model: '模型设置' };
        const changes = { added: '新增', removed: '删除', modified: '修改' };
        const rows = data.versions.map(version => `<tr><td>v${esc(version.version)}${version.isCurrent ? '（当前）' : ''}</td><td>${esc(version.publishedAt)}</td><td>${esc(version.binding?.dataState || version.message || '不可用')}</td><td>${esc(version.binding?.revision || '—')}</td><td>${state.selected.isOwner && version.definition ? button('rollback-version', '设为当前版本', version.version) : '只读'}</td></tr>`);
        m.dialog('版本与业务差异', `${table(['版本', '发布时间', '数据状态', '数据修订', '操作'], rows)}<p>以下为当前已发布口径与草稿的差异。固定版本的分析视图不会自动升级。</p>${table(['对象', '名称', '变化', '变化属性'], data.changes.map(change => `<tr><td>${esc(kinds[change.kind])}</td><td>${esc(change.name || change.id)}</td><td>${esc(changes[change.change])}</td><td>${esc(change.fields.join('、') || '整体')}</td></tr>`))}<p>影响 ${esc(data.dependencies.views.length)} 个可见分析视图、${esc(new Set(data.dependencies.dashboards.map(item => item.id)).size)} 个可见仪表盘。</p>`, null);
    }

    async function rollback(id) {
        await owner();
        const modelId = state.selected.id, expectedVersion = state.selected.version;
        const current = m.capture('rollback');
        m.dialog('切换当前发布版本', `<p>将当前可选发布版本切换为 v${esc(id)}。已有视图继续使用固定版本，当前草稿保留。</p>${m.checkbox('confirm', '确认版本保留、当前来源权限及业务影响')}`, async form => {
            if (!m.checked(form, 'confirm')) throw new Error('请确认版本切换影响。');
            const data = await request(`/models/${encodeURIComponent(modelId)}/rollback`, json({ expectedVersion, publishedVersion: Number(id) }));
            if (!current()) return;
            state.selected = data.model; m.render(); await m.loadList();
        });
    }

    async function dependencies() {
        const current = m.capture('dependencies');
        const data = await request(path('/dependencies'));
        if (!current()) return;
        const definition = state.draft || {}, nodeName = id => definition.nodes?.find(node => node.id === id)?.name || id;
        const sourceRows = (definition.nodes || []).flatMap(node => node.grainKeys.map(key => `<tr><td>${esc(node.name)}</td><td>${esc(key)}</td><td>业务粒度键</td></tr>`));
        const dimensions = (definition.dimensions || []).map(dimension => `<tr><td>${esc(nodeName(dimension.nodeId))}</td><td>${esc(dimension.fieldKey)}</td><td>维度：${esc(dimension.name)}</td></tr>`);
        const metrics = (definition.metrics || []).map(metric => `<tr><td>${esc(metric.field ? nodeName(metric.field.nodeId) : '指标公式')}</td><td>${esc(metric.field?.fieldKey || metric.type)}</td><td>指标：${esc(metric.name)}</td></tr>`);
        m.dialog('依赖与确定性血缘', `${table(['来源', '字段或计算', '模型对象'], [...sourceRows, ...dimensions, ...metrics])}${table(['分析视图', '固定版本'], data.views.map(view => `<tr><td>${esc(view.name)}</td><td>v${esc(view.publishedVersion)}</td></tr>`))}${table(['仪表盘', '组件固定版本'], data.dashboards.map(item => `<tr><td>${esc(item.name)}</td><td>v${esc(item.publishedVersion)}</td></tr>`))}<p>只列出当前有权查看的依赖；删除来源前仍由服务端检查全部引用。</p>`, null);
    }

    async function refresh() {
        await owner();
        const current = m.capture('refresh-data');
        const data = await request(path('/versions'));
        if (!current()) return;
        const version = data.versions.find(item => item.isCurrent);
        if (!version?.binding) throw new Error('请先完成检查并发布模型。');
        const modelId = state.selected.id;
        m.dialog('检查并刷新模型数据', `<p>固定口径 v${esc(version.version)}，检查所有候选来源。完整检查通过才切换数据；失败保留上次成功清单。</p>${m.checkbox('confirm', '已了解各来源独立截止时间与刷新失败处理')}`, async form => {
            if (!m.checked(form, 'confirm')) throw new Error('请确认刷新规则。');
            const result = await request(`/models/${encodeURIComponent(modelId)}/data-refresh`, json({ publishedVersion: version.version, bindingRevision: version.binding.revision, requestKey: m.key() }));
            if (!current()) return;
            state.check = result.check; state.drawerMode = 'quality'; state.drawerOpen = true; m.render(); void m.pollCheck(result.check.id).catch(error => app.toast(error.message, 'error'));
        });
    }

    async function sharing() {
        await owner();
        const current = m.capture('sharing'), modelId = state.selected.id;
        const [targets, inbox] = await Promise.all([request('/share-targets'), request('/model-reviews')]);
        if (!current()) return;
        const tree = window.Pivot.modules?.['share.targetTree'] || window.Pivot.legacy.PivotShareTargetTree;
        if (!tree?.render) throw new Error('共享目标组件尚未就绪，请刷新页面。');
        const reviews = inbox.reviews.filter(item => item.model_id === modelId && item.status === 'approved');
        const targetMarkup = tree.render({ units: targets.units, users: targets.users, allowedUnits: csv(state.selected.allowedUnits), allowedUserIds: csv(state.selected.allowedUserIds), isShared: true, currentUnit: window.Pivot.legacy.currentUser?.unit,
            unitInputName: 'modeling_shareUnit', userInputName: 'modeling_shareUser', escapeText: esc, escapeAttr: esc });
        m.dialog('共享与业务口径复核', `<p>共享只读，不会共享底层来源。另一位具备实际来源权限的业务人员复核通过后才能启用。</p>${m.select('sharingAction', '操作', [['request', '发起当前口径复核'], ['activate', '使用已通过证据启用共享'], ['personal', '立即取消共享']], 'request')}<div class="agent-workflow-share-tree">${targetMarkup}</div>${m.select('reviewerId', '业务复核者', (targets.users || []).filter(user => String(user.id) !== m.owner()).map(user => [String(user.id), user.nickname || user.username]), '')}${m.select('reviewId', '已通过的复核证据', reviews.map(review => [review.id, `${review.id} · ${review.reviewed_at || ''}`]), '')}<p>当前检查：${esc(state.check?.id || '请先完整检查当前草稿')}</p>`, async form => {
            const action = m.value(form, 'sharingAction');
            const values = name => Array.from(form.querySelectorAll(`input[name="modeling_${name}"]:checked`), input => input.value).join(',');
            const body = { expectedVersion: state.selected.version, scope: action === 'personal' ? 'personal' : 'shared', allowedUnits: values('shareUnit'), allowedUserIds: values('shareUser') };
            if (action === 'request') {
                if (state.check?.status !== 'passed') throw new Error('请先完整检查当前草稿。');
                const result = await request(`/models/${encodeURIComponent(modelId)}/review-requests`, json({ ...body, reviewerId: Number(m.value(form, 'reviewerId')), checkId: state.check.id, requestKey: m.key() }));
                if (current()) app.toast(`已创建复核请求 ${result.review.id}，复核者可从“业务复核”进入。`, 'success');
            } else {
                const result = await request(`/models/${encodeURIComponent(modelId)}/sharing`, json({ ...body, reviewId: m.value(form, 'reviewId') }, 'PUT'));
                if (!current()) return;
                state.selected = result.model; m.render(); await m.loadList();
            }
        });
        tree.bind(document.getElementById('modeling-dialog-body'));
    }

    async function inbox() {
        const current = m.capture('review-inbox');
        const data = await request('/model-reviews');
        if (!current()) return;
        const statuses = { requested: '待复核', approved: '已通过', rejected: '已驳回' };
        m.dialog('业务口径复核', table(['复核请求', '状态', '创建时间', '操作'], data.reviews.map(review => `<tr><td>${esc(review.id)}</td><td>${esc(statuses[review.status])}</td><td>${esc(review.created_at)}</td><td>${button('open-review', '查看与复核', review.id)}</td></tr>`)), null);
    }

    async function openReview(id) {
        const current = m.capture('open-review');
        const { review } = await request(`/model-reviews/${encodeURIComponent(id)}`);
        if (!current()) return;
        const definitions = review.definition;
        const confirmations = [['grain', '已核对事实粒度和关联键'], ['metrics', '已核对指标定义、单位及公式'], ['coverage', '已核对数据完整性与部分范围'], ['freshness', '已核对各来源截止时间和陈旧上限'], ['warnings', '已逐项核对质量警告'], ['scope', '已核对共享范围']];
        const canDecide = review.reviewerId === Number(m.owner()) && review.status === 'requested';
        m.dialog('复核模型业务口径', `<p>${esc(review.name)} · 业务负责人：${esc(review.businessOwner)} · 维护联系人：${esc(review.maintenanceContact)}</p><p>一行代表：${esc(definitions.grainDescription)}；时区：${esc(definitions.timezone)}；陈旧上限：${esc(definitions.maxStaleness)} 秒。</p>${table(['指标', '计算方式', '单位 / 币种'], definitions.metrics.map(metric => `<tr><td>${esc(metric.name)}</td><td>${esc(metric.type)}</td><td>${esc(metric.unit || metric.currency || '—')}</td></tr>`))}${table(['来源', '截止时间', '完整性'], review.manifest.members.map(member => `<tr><td>${esc(review.sources.find(source => source.nodeId === member.nodeId)?.name || member.nodeId)}</td><td>${esc(member.watermark.updatedAt)}</td><td>${esc(member.coverage)}</td></tr>`))}<p>共享单位：${esc(review.proposal.allowedUnits || '未指定')}；共享个人 ID：${esc(review.proposal.allowedUserIds || '未指定')}。</p>${(review.report.warnings || []).map(warning => `<p role="status">${esc(warning.message)}</p>`).join('')}${canDecide ? `${confirmations.map(([key, label]) => m.checkbox(key, label)).join('')}${m.select('decision', '复核结论', [['approved', '通过'], ['rejected', '驳回']], 'approved')}${m.input('comment', '结论和业务原因', '', 'maxlength="2000" required')}` : `<p>${esc(review.comment || review.status)}</p>`}`, canDecide ? async form => {
            await request(`/model-reviews/${encodeURIComponent(id)}/decision`, json({ approved: m.value(form, 'decision') === 'approved', comment: m.value(form, 'comment'), confirmations: confirmations.filter(([key]) => m.checked(form, key)).map(([key]) => key) }));
            if (current()) app.toast('业务复核证据已保存。', 'success');
        } : null);
    }

    m.consumerAction = (action, id) => {
        if (action === 'versions') return versions();
        if (action === 'dependencies') return dependencies();
        if (action === 'rollback-version') return rollback(id);
        if (action === 'refresh-data') return refresh();
        if (action === 'share') return sharing();
        if (action === 'reviews') return inbox();
        if (action === 'open-review') return openReview(id);
        return false;
    };
})();
