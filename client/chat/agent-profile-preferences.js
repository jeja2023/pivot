/* 个人档案中的标签偏好编辑器：保持数组数据契约，不承担授权决策。 */
(function () {
    const LIST_LIMIT = 24;
    const FIELDS = Object.freeze(['workHabits', 'frequentTools', 'commonTasks']);
    const SUGGESTIONS = Object.freeze({
        workHabits: ['先给结论', '列出假设与风险', '提供可执行下一步', '优先复用现有规范'],
        commonTasks: ['待办整理', '项目汇报', '资料检索', '数据分析', '代码审查']
    });

    let lists = { workHabits: [], frequentTools: [], commonTasks: [] };
    let tools = [];

    function escape(value) {
        return window.Pivot?.legacy?.PivotSafeHtml?.escapeHtml
            ? window.Pivot.legacy.PivotSafeHtml.escapeHtml(value)
            : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
    }

    function escapeAttr(value) {
        return window.Pivot?.legacy?.PivotSafeHtml?.escapeAttr
            ? window.Pivot.legacy.PivotSafeHtml.escapeAttr(value)
            : escape(value).replace(/"/g, '&quot;');
    }

    function setMarkup(element, markup) {
        if (!element) return;
        if (window.Pivot?.legacy?.PivotSafeHtml?.setHtml) window.Pivot.legacy.PivotSafeHtml.setHtml(element, markup);
        else element.textContent = String(markup || '');
    }

    function notify(message) {
        window.Pivot?.legacy?.showToast?.(message, 'error');
    }

    function normalizeList(value) {
        const source = Array.isArray(value) ? value : String(value || '').split(/[\n,，]/);
        return [...new Set(source.map(item => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, LIST_LIMIT);
    }

    function values(field) {
        if (!FIELDS.includes(field)) return [];
        return Array.isArray(lists[field]) ? lists[field] : [];
    }

    function input(field) {
        return document.querySelector(`[data-agent-profile-input="${field}"]`);
    }

    function fieldId(field) {
        return field === 'workHabits' ? 'work-habits' : field === 'frequentTools' ? 'tools' : 'tasks';
    }

    function toolMeta(name) {
        return tools.find(tool => tool.name === name) || null;
    }

    function renderField(field) {
        const selected = values(field);
        const list = document.querySelector(`[data-agent-profile-token-list="${field}"]`);
        const count = document.getElementById(`agent-profile-${fieldId(field)}-count`);
        if (count) count.textContent = `${selected.length} / ${LIST_LIMIT} 项`;
        if (list) {
            if (!selected.length) setMarkup(list, '<span class="agent-profile-token-empty">尚未添加</span>');
            else setMarkup(list, selected.map(value => {
                const tool = field === 'frequentTools' ? toolMeta(value) : null;
                const label = tool?.title || value;
                const code = tool && tool.title && tool.title !== value ? `<code>${escape(value)}</code>` : '';
                return `<span class="agent-profile-token" title="${escapeAttr(value)}"><span>${escape(label)}</span>${code}<button class="btn-secondary" type="button" data-agent-profile-remove="${escapeAttr(field)}" data-agent-profile-value="${escapeAttr(value)}" aria-label="移除 ${escapeAttr(label)}" title="移除">×</button></span>`;
            }).join(''));
        }

        const suggestionList = document.getElementById(`agent-profile-${fieldId(field)}-suggestions`);
        if (suggestionList) {
            const candidates = field === 'frequentTools'
                ? tools.filter(tool => !selected.includes(tool.name)).slice(0, 3)
                : (SUGGESTIONS[field] || []).filter(value => !selected.includes(value));
            if (!candidates.length) suggestionList.replaceChildren();
            else if (field === 'frequentTools') {
                setMarkup(suggestionList, candidates.map(tool => `<button type="button" class="btn-secondary agent-profile-suggestion" data-agent-profile-suggestion="${escapeAttr(field)}" data-agent-profile-value="${escapeAttr(tool.name)}" title="${escapeAttr(tool.name)}"><span>${escape(tool.title || tool.name)}</span><code>${escape(tool.name)}</code></button>`).join(''));
            } else {
                setMarkup(suggestionList, candidates.map(value => `<button type="button" class="btn-secondary agent-profile-suggestion" data-agent-profile-suggestion="${escapeAttr(field)}" data-agent-profile-value="${escapeAttr(value)}">${escape(value)}</button>`).join(''));
            }
        }

        if (field === 'frequentTools') {
            const options = document.getElementById('agent-profile-tool-options');
            if (options) setMarkup(options, tools.slice(0, 120).map(tool => `<option value="${escapeAttr(tool.name)}" label="${escapeAttr(tool.title || tool.name)}"></option>`).join(''));
        }
    }

    function render() {
        FIELDS.forEach(renderField);
    }

    function add(field, rawValue) {
        if (!FIELDS.includes(field)) return;
        const candidates = normalizeList(rawValue);
        if (!candidates.length) return;
        const next = [...values(field)];
        for (const value of candidates) {
            if (next.includes(value)) continue;
            if (next.length >= LIST_LIMIT) {
                notify(`每类偏好最多保存 ${LIST_LIMIT} 项。`);
                break;
            }
            next.push(value);
        }
        lists = { ...lists, [field]: next };
        const entry = input(field);
        if (entry) { entry.value = ''; entry.focus(); }
        renderField(field);
    }

    function remove(field, value) {
        if (!FIELDS.includes(field)) return;
        lists = { ...lists, [field]: values(field).filter(item => item !== value) };
        renderField(field);
        input(field)?.focus();
    }

    async function loadTools() {
        try {
            const response = await apiFetch('/api/agents/tools', { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '工具目录加载失败。');
            const seen = new Set();
            tools = (Array.isArray(data.tools) ? data.tools : []).map(tool => ({
                name: String(tool?.name || '').trim(),
                title: String(tool?.title || tool?.name || '').trim()
            })).filter(tool => tool.name && !seen.has(tool.name) && Boolean(seen.add(tool.name))).slice(0, 240);
        } catch (_) {
            tools = [];
        }
        render();
        return tools;
    }

    function fill(profile = {}) {
        lists = {
            workHabits: normalizeList(profile.workHabits),
            frequentTools: normalizeList(profile.frequentTools),
            commonTasks: normalizeList(profile.commonTasks)
        };
        render();
    }

    function getValues() {
        return Object.fromEntries(FIELDS.map(field => [field, [...values(field)] ]));
    }

    function bind() {
        const root = document.getElementById('agent-profile-preferences-editor');
        if (!root || root.dataset.agentProfilePreferencesBound === '1') return;
        root.dataset.agentProfilePreferencesBound = '1';
        root.addEventListener('click', event => {
            const removeButton = event.target.closest('[data-agent-profile-remove]');
            if (removeButton) return remove(removeButton.dataset.agentProfileRemove, removeButton.dataset.agentProfileValue || '');
            const addButton = event.target.closest('[data-agent-profile-add]');
            if (addButton) return add(addButton.dataset.agentProfileAdd, input(addButton.dataset.agentProfileAdd)?.value || '');
            const suggestion = event.target.closest('[data-agent-profile-suggestion]');
            if (suggestion) add(suggestion.dataset.agentProfileSuggestion, suggestion.dataset.agentProfileValue || '');
        });
        root.addEventListener('keydown', event => {
            const entry = event.target.closest('[data-agent-profile-input]');
            if (!entry || event.key !== 'Enter' || event.isComposing) return;
            event.preventDefault();
            add(entry.dataset.agentProfileInput, entry.value);
        });
    }

    window.Pivot?.exposeModule?.('agent.profilePreferences', { bind, fill, getValues, loadTools });
})();
