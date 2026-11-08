(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling;
    const { state, request, json, table } = m, { esc } = app;
    const button = (action, label, id) => `<button class="btn-secondary" type="button" data-modeling-action="${action}" data-modeling-id="${esc(id)}">${esc(label)}</button>`;
    const planTable = impact => table(['相关计划', '类型', '交接后'], (impact?.plans || []).map(plan => `<tr><td>${esc(plan.name)}</td><td>${plan.kind === 'refresh' ? '仪表盘刷新' : '工作流计划'}</td><td>暂停，重新确认后方可启用</td></tr>`));
    const impactText = (impact, preview = true) => `<p>草稿修订 ${esc(impact.version)}；保留 ${esc(impact.versions.length)} 个发布版本。${preview ? '接收人已通过全部所需来源和字段权限核验。' : '申请时已核验来源权限，接受时会再次检查。'}</p><p>共享范围将转为个人，原共享证据失效；底层数据集、原有分析视图和凭据仍属于各自所有者。重新共享需要新的业务复核。</p>${planTable(impact)}`;

    async function start(rescue = false) {
        if (!rescue) {
            if (!state.selected?.isOwner) throw new Error('请由模型所有者发起交接。');
            if (state.dirty) await m.saveDraft();
        }
        const current = m.capture('transfer-start');
        const targets = await request('/share-targets');
        if (!current()) return;
        m.dialog(rescue ? '停用账号模型交接' : '选择模型接收人', `${rescue ? `${m.input('modelId', '待交接模型 ID', '', 'required maxlength="160"')}<p>仅系统管理员可以为已停用或删除的所有者发起交接；仍须接收人原本具备全部来源权限。</p>` : ''}${m.select('recipientId', '接收人', (targets.users || []).filter(user => String(user.id) !== m.owner()).map(user => [String(user.id), user.nickname || user.username]), '')}`, async form => {
            const modelId = rescue ? m.value(form, 'modelId') : state.selected.id, recipientId = Number(m.value(form, 'recipientId'));
            const preview = await request(`/models/${encodeURIComponent(modelId)}/transfer-preview`, json({ recipientId }));
            if (current()) setTimeout(() => { if (current()) confirmRequest(preview, recipientId); }, 0);
        });
    }

    function confirmRequest(preview, recipientId) {
        const current = m.capture('transfer-request');
        const key = m.key();
        m.dialog('确认模型交接影响', `<p>${esc(preview.name)}</p>${impactText(preview.impact)}${m.input('businessOwner', '新业务负责人', '', 'required maxlength="120"')}${m.input('maintenanceContact', '新维护联系人', '', 'required maxlength="120"')}${m.input('reason', '交接原因', '', 'required maxlength="2000"')}${m.checkbox('confirm', '确认以上影响，并请接收人从模型交接入口核对和处理')}`, async form => {
            if (!m.checked(form, 'confirm')) throw new Error('请确认交接影响。');
            const result = await request(`/models/${encodeURIComponent(preview.modelId)}/transfers`, json({ recipientId, expectedVersion: preview.impact.version, impactHash: preview.impactHash, requestKey: key,
                businessOwner: m.value(form, 'businessOwner'), maintenanceContact: m.value(form, 'maintenanceContact'), reason: m.value(form, 'reason') }));
            if (current()) app.toast(`交接请求已创建，等待接收人确认：${result.transfer.id}`, 'success');
        });
    }

    async function inbox() {
        const current = m.capture('transfer-inbox'), data = await request('/model-transfers');
        if (!current()) return;
        const statuses = { requested: '待确认', accepted: '已接受', rejected: '已拒绝', cancelled: '已撤回' };
        const user = window.Pivot.legacy.currentUser;
        m.dialog('模型交接', `<p>接收人接受后才改变所有权。请求七天内有效；模型或相关计划变化后需重新发起。</p>${table(['模型', '接收人', '状态', '操作'], data.transfers.map(row => `<tr><td>${esc(row.impact.modelName)}</td><td>${esc(row.impact.recipientName)}</td><td>${esc(statuses[row.status])}</td><td>${button('open-transfer', '查看交接', row.id)}</td></tr>`))}${user?.role === 'admin' && user?.username === 'admin' ? button('rescue-transfer', '处理停用账号的模型', '') : ''}`, null);
    }

    async function open(id) {
        const current = m.capture('transfer-detail'), { transfer } = await request(`/model-transfers/${encodeURIComponent(id)}`);
        if (!current()) return;
        const incoming = transfer.recipientId === Number(m.owner()), pending = transfer.status === 'requested';
        const confirmations = [['sources', '已确认全部来源和字段权限持续有效'], ['personalScope', '已确认模型转为个人，重新共享须复核'], ['credentials', '已确认数据集和凭据不转移，后续重新绑定'], ['pausedPlans', '已确认相关计划暂停，需重新确认执行主体'], ['contacts', '已确认新的业务负责人和维护联系人']];
        m.dialog('核对模型交接', `<p>${esc(transfer.impact.modelName)} · 原所有者 ${esc(transfer.impact.ownerName)} · 接收人 ${esc(transfer.impact.recipientName)}</p><p>原因：${esc(transfer.reason)}</p><p>新业务负责人：${esc(transfer.businessOwner)}；维护联系人：${esc(transfer.maintenanceContact)}</p>${impactText(transfer.currentImpact || transfer.impact, false)}${pending && transfer.unchanged === false ? '<p role="alert">当前权限、模型或计划已变化，可拒绝或撤回后重新发起；此请求不能接受。</p>' : ''}${pending ? `${incoming ? `${confirmations.map(([key, label]) => m.checkbox(key, label)).join('')}${m.select('action', '处理', [['accepted', '接受交接'], ['rejected', '拒绝交接']], 'accepted')}` : '<p>可撤回当前请求。</p>'}${m.input('comment', '处理说明', '', 'required maxlength="2000"')}` : `<p>${esc(transfer.status)}：${esc(transfer.decisionComment)}</p>`}`, pending ? async form => {
            await request(`/model-transfers/${encodeURIComponent(id)}/decision`, json({ action: incoming ? m.value(form, 'action') : 'cancelled', comment: m.value(form, 'comment'), confirmations: confirmations.filter(([key]) => m.checked(form, key)).map(([key]) => key) }));
            if (!current()) return;
            app.toast('交接处理已保存。', 'success'); m.reset(); m.render(); await m.loadList();
        } : null);
    }

    const previous = m.consumerAction;
    m.consumerAction = (action, id) => {
        if (action === 'transfer') return start();
        if (action === 'transfers') return inbox();
        if (action === 'open-transfer') return open(id);
        if (action === 'rescue-transfer') return start(true);
        return previous?.(action, id) ?? false;
    };
})();
