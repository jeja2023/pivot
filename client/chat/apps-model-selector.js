// 应用中心内的模型选择器。
//
// 每个业务应用维护自己的选择结果，避免业务任务意外继承聊天会话当前选中的模型。
// 首次打开时仍会使用用户/系统默认模型作为初始值，之后仅在当前应用内持久化该选择。
(function () {
    const STORAGE_PREFIX = 'pivot_app_model:';

    function getUserScope() {
        const user = typeof currentUser !== 'undefined' ? currentUser : (window.currentUser || {});
        return String(user.id || user.username || 'anonymous');
    }

    function getStorageKey(appId) {
        return `${STORAGE_PREFIX}${getUserScope()}:${String(appId || '').trim()}`;
    }

    function readSavedModelId(appId) {
        try {
            return String(window.localStorage?.getItem(getStorageKey(appId)) || '').trim();
        } catch (_error) {
            return '';
        }
    }

    function saveModelId(appId, modelId) {
        try {
            window.localStorage?.setItem(getStorageKey(appId), String(modelId || ''));
        } catch (_error) {
            // 隐私模式或受限 WebView 无法存储时，保留当前页面选择即可。
        }
    }

    function modelLabel(model) {
        const personal = model?.user_id ? '（个人）' : '';
        return `${String(model?.name || model?.model_name || '未命名模型')}${personal}`;
    }

    function setSelectorMessage(select, message) {
        if (!select) return;
        select.replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = message;
        select.appendChild(option);
        select.value = '';
        select.disabled = true;
    }

    function syncAppModelSelectors(appId, modelId, source) {
        const selectors = document.querySelectorAll?.(`[data-pivot-app-model="${String(appId || '')}"]`) || [];
        selectors.forEach(select => {
            if (select === source) return;
            const hasModel = Array.from(select.options || []).some(option => String(option.value) === String(modelId));
            if (!hasModel) return;
            select.value = String(modelId);
            select.title = select.selectedOptions[0]?.title || select.selectedOptions[0]?.textContent || '';
        });
    }

    function getSelectedModel(appId, selectorId) {
        const select = document.getElementById(selectorId);
        return String(readSavedModelId(appId) || select?.value || '').trim();
    }

    async function refresh(appId, selectorId) {
        const select = document.getElementById(selectorId);
        if (!select) return '';

        if (typeof window.loadSelectableModels !== 'function') {
            setSelectorMessage(select, '模型列表未就绪');
            return '';
        }

        const currentId = String(select.value || '').trim();
        select.disabled = true;
        try {
            const { models = [], defaultModelId } = await window.loadSelectableModels();
            if (!models.length) {
                setSelectorMessage(select, '暂无可用模型');
                return '';
            }

            select.replaceChildren();
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = String(model.id);
                option.textContent = modelLabel(model);
                option.title = typeof window['describeSelectorModel'] === 'function'
                    ? window['describeSelectorModel'](model, false)
                    : option.textContent;
                select.appendChild(option);
            });

            const availableIds = new Set(models.map(model => String(model.id)));
            const savedId = readSavedModelId(appId);
            const preferredId = [currentId, savedId, String(defaultModelId || '')]
                .find(id => id && availableIds.has(id));
            const selectedId = preferredId || String(models[0].id);
            select.value = selectedId;
            select.disabled = false;
            select.title = select.selectedOptions[0]?.title || select.selectedOptions[0]?.textContent || '';
            saveModelId(appId, selectedId);
            syncAppModelSelectors(appId, selectedId, select);

            if (select.dataset.appModelSelectorBound !== 'true') {
                select.dataset.appModelSelectorBound = 'true';
                select.addEventListener('change', () => {
                    saveModelId(appId, select.value);
                    select.title = select.selectedOptions[0]?.title || select.selectedOptions[0]?.textContent || '';
                    syncAppModelSelectors(appId, select.value, select);
                });
            }
            return selectedId;
        } catch (error) {
            console.error('加载应用模型列表失败:', error);
            setSelectorMessage(select, '模型列表加载失败');
            return '';
        }
    }

    const api = { refresh, getSelectedModel };
    window['PivotAppModels'] = api;
    window.Pivot?.exposeModule?.('apps.modelSelector', api);
})();
