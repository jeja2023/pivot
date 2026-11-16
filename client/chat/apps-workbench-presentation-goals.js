(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    function mount(form, prefix) {
        for (const [key, label, type, options] of [['audience', '目标受众', 'text'], ['purpose', '整稿目的', 'textarea'], ['consumption', '阅读方式', 'select', { presentation: '现场演示', reading: '阅读材料' }], ['duration', '目标时长（分钟）', 'number']]) {
            if (byId(prefix + '-' + key)) continue;
            const wrapper = document.createElement('label'); wrapper.className = 'presentation-master-field modal-form-field';
            const caption = document.createElement('span'); caption.className = 'modal-form-label'; caption.textContent = label;
            const input = document.createElement(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input'); input.className = 'form-input'; input.id = prefix + '-' + key; input.setAttribute('aria-label', label);
            if (options) for (const [value, text] of Object.entries(options)) input.appendChild(new Option(text, value));
            else if (type !== 'textarea') input.type = type; else input.rows = 2;
            if (key === 'audience') { input.placeholder = '例如：管理层决策人、项目评审委员会、核心业务团队'; input.maxLength = 240; }
            if (key === 'purpose') { input.placeholder = '希望受众看完后了解什么或采取什么行动'; input.maxLength = 600; }
            if (key === 'duration') { input.placeholder = '如：20'; input.min = '0'; input.max = '720'; }
            wrapper.append(caption, input); form.appendChild(wrapper);
        }
    }
    function read(prefix, previous = {}) {
        const minutes = Number(byId(prefix + '-duration')?.value || 0);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 720) throw new Error('目标时长请填写0至720分钟。');
        return { ...previous, audience: byId(prefix + '-audience')?.value.trim() || '', purpose: byId(prefix + '-purpose')?.value.trim() || '', consumptionMode: byId(prefix + '-consumption')?.value || 'presentation', targetDurationSeconds: minutes * 60 };
    }
    function fill(prefix, profile = {}) {
        for (const [key, value] of Object.entries({ audience: profile.audience || '', purpose: profile.purpose || '', consumption: profile.consumptionMode || 'presentation', duration: profile.targetDurationSeconds ? profile.targetDurationSeconds / 60 : '' })) if (byId(prefix + '-' + key)) byId(prefix + '-' + key).value = value;
    }
    window.Pivot.exposeModule('apps.presentations.goals', { mount, read, fill });
})();
