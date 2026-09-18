/* DAG 检查器专用字段：受控资源选择器。 */

function renderDagInspectorChannelBindingField({ fieldName = 'bindingId', label = '渠道绑定', value = '', bindings = [], escapeAttr, escapeHtml } = {}) {
    const safeAttr = typeof escapeAttr === 'function' ? escapeAttr : text => String(text || '');
    const safeHtml = typeof escapeHtml === 'function' ? escapeHtml : text => String(text || '');
    const platforms = { wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉' };
    const active = (Array.isArray(bindings) ? bindings : []).filter(binding => {
        const platform = String(binding?.config?.platform || '').trim().toLowerCase();
        return binding?.status === 'active' && Object.hasOwn(platforms, platform);
    });
    const current = String(value || '').trim();
    const currentKnown = active.some(binding => String(binding.id) === current);
    const options = [
        `<option value="">${active.length ? '请选择受控渠道绑定' : '暂无可用渠道绑定'}</option>`,
        current && !currentKnown ? `<option value="${safeAttr(current)}">${safeHtml(`当前绑定（不可用）：${current}`)}</option>` : '',
        ...active.map(binding => {
            const platform = String(binding?.config?.platform || '').trim().toLowerCase();
            const text = `${platforms[platform]} · ${binding.channelKey || binding.id}`;
            return `<option value="${safeAttr(binding.id)}" ${String(binding.id) === current ? 'selected' : ''}>${safeHtml(text)}</option>`;
        })
    ].join('');
    return `<label class="pivot-dag-inline-field pivot-dag-inline-channel-binding"><span>${safeHtml(label)}</span><select class="form-input" data-pivot-dag-input-field="${safeAttr(fieldName)}" ${active.length || current ? '' : 'disabled aria-disabled="true"'}>${options}</select><small>平台由所选绑定自动确定；可在通知设置中新增或启用渠道。</small></label>`;
}
