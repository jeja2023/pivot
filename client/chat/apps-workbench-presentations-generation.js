(function () {
    'use strict';
    const API = '/api/apps/presentations';
    const byId = id => document.getElementById(id);

    function create(state, { requestJson, beginAiRequest, endAiRequest, aiJsonOptions, isAiAbort, loadDocuments, openPresentation, flush, requireModel, toast }) {
        async function openDraft(id) {
            byId('presentation-outline-modal')?.classList.add('hidden');
            await loadDocuments();
            await openPresentation(id);
        }

        async function generateSlides(outline) {
            const pending = state.pendingCreate;
            const draftId = pending.draftId ||= 'pptgen_' + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
            const button = byId('presentation-outline-confirm-btn'), controller = beginAiRequest();
            button.disabled = true; button.textContent = '正在生成页面…';
            try {
                const request = { ...pending, outline, title: outline.title || pending.topic };
                const data = await requestJson(API + '/ai/slides', aiJsonOptions(request, controller));
                if (controller.signal.aborted) return;
                await openDraft(data.draftId);
                const warning = data.warnings?.find(Boolean);
                toast(warning || '大纲页面已生成并保存。', warning ? 'warning' : 'success');
            } catch (error) {
                if (isAiAbort(error, controller)) { toast('AI 页面生成已取消。', 'warning'); return; }
                const partial = await requestJson(API + '/' + encodeURIComponent(draftId)).catch(() => null);
                if (!partial?.presentation || controller.signal.aborted) throw error;
                await openDraft(draftId);
                toast(error.message + ' 已生成页面已保存，可补齐缺页。', 'warning');
            } finally {
                endAiRequest(controller);
                button.disabled = false; button.textContent = '生成页面';
            }
        }

        async function fillMissingPages() {
            const id = state.active?.id;
            if (!id || !state.active.generation?.pending.length) return;
            const model = requireModel();
            if (!model || !await flush() || state.active?.id !== id) return;
            const button = byId('presentation-fill-missing-btn'), controller = beginAiRequest();
            button.disabled = true; button.textContent = '正在补齐…';
            try {
                await requestJson(API + '/' + encodeURIComponent(id) + '/ai/fill-missing', aiJsonOptions({ model }, controller));
                if (!controller.signal.aborted && state.active?.id === id) await openPresentation(id);
                if (!controller.signal.aborted) toast('缺页已补齐并保存。');
            } catch (error) {
                if (!isAiAbort(error, controller)) {
                    if (state.active?.id === id && !state.dirty) await openPresentation(id).catch(() => {});
                    toast(error.message + ' 已保存的页面可继续编辑。', 'warning');
                }
            } finally {
                endAiRequest(controller);
                button.disabled = false; button.textContent = '补齐缺页';
            }
        }

        function renderProgress() {
            const remaining = state.active.generation?.pending || [];
            const status = byId('presentation-generation-progress');
            if (status) {
                status.classList.toggle('hidden', !remaining.length);
                status.textContent = remaining.length ? `待补齐 ${remaining.length} 页` : '';
                status.title = remaining.map(page => page.title).join('、');
            }
            byId('presentation-fill-missing-btn')?.classList.toggle('hidden', !remaining.length || state.active.isOwner === false);
            return Boolean(remaining.length);
        }

        return { generateSlides, fillMissingPages, renderProgress };
    }

    window.Pivot?.exposeModule?.('apps.presentations.generation', { create });
})();
