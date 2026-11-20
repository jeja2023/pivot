(function () {
    'use strict';
    const API = '/api/apps/presentations';
    const byId = id => document.getElementById(id);

    function create(state, { requestJson, beginAiRequest, endAiRequest, aiJsonOptions, isAiAbort, loadDocuments, openPresentation,
        flush, requireModel, toast, activeSlide, canEdit, formatChangeImpact, recordHistory, renderEditor }) {
        let draftPlan;
        async function openDraft(id) {
            byId('presentation-outline-modal')?.classList.add('hidden');
            await loadDocuments();
            await openPresentation(id);
        }

        async function generateSlides(outline) {
            const pending = state.pendingCreate;
            const outlineKey = JSON.stringify(outline);
            if (!pending.draftId || draftPlan?.pending !== pending || draftPlan.outlineKey !== outlineKey) {
                pending.draftId = 'pptgen_' + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
                draftPlan = { pending, outlineKey };
            }
            const draftId = pending.draftId;
            const button = byId('presentation-outline-confirm-btn'), controller = beginAiRequest();
            button.disabled = true; button.textContent = '正在生成页面…';
            try {
                const request = { ...pending, outline, title: outline.title || pending.topic };
                const data = await requestJson(API + '/ai/slides', aiJsonOptions(request, controller));
                if (controller.signal.aborted || state.pendingCreate !== pending) return;
                await openDraft(data.draftId);
                const warning = data.warnings?.find(Boolean);
                toast(warning || '大纲页面已生成并保存。', warning ? 'warning' : 'success');
            } catch (error) {
                if (isAiAbort(error, controller)) { toast('AI 页面生成已取消。', 'warning'); return; }
                if (state.pendingCreate !== pending) return;
                if (error.code === 'PRESENTATION_GENERATION_PLAN_CHANGED') {
                    delete pending.draftId;
                    toast('原草稿已按旧大纲保存。再次点击“生成页面”可按当前大纲新建草稿。', 'warning');
                    return;
                }
                const partial = await requestJson(API + '/' + encodeURIComponent(draftId)).catch(() => null);
                if (controller.signal.aborted || state.pendingCreate !== pending) return;
                if (!partial?.presentation) throw error;
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

        async function rewriteCurrentSlide() {
            const slide = activeSlide();
            if (!slide || !state.active?.content || !canEdit() || slide.review?.status === 'approved') return;
            const presentationId = state.active.id, epoch = state.activeEpoch;
            const instruction = byId('presentation-ai-instruction')?.value.trim();
            if (!instruction) { toast('请先输入改写要求。', 'error'); return; }
            const model = requireModel();
            if (!model) return;
            let snapshot;
            const controller = beginAiRequest(), button = byId('presentation-ai-rewrite-btn');
            const rewriteTargetIsCurrent = () => state.active?.id === presentationId && state.activeEpoch === epoch && !controller.signal.aborted
                && activeSlide()?.id === slide.id && (!snapshot || JSON.stringify(activeSlide()) === snapshot) && canEdit();
            if (button) { button.disabled = true; button.textContent = '正在生成建议…'; }
            try {
                if (!await flush() || !rewriteTargetIsCurrent()) return;
                snapshot = JSON.stringify(activeSlide());
                const { title, sources } = state.active.content;
                const data = await requestJson(API + '/ai/rewrite', aiJsonOptions({
                    presentationId, title, topic: title, model, slide: { id: slide.id }, instruction, materials: sources || []
                }, controller));
                if (!rewriteTargetIsCurrent()) return;
                const proposed = data.proposal?.presentation?.slides?.[0];
                if (!proposed) throw new Error('AI 未返回可用页面。');
                const accepted = await window.Pivot.legacy.showConfirm?.('应用 AI 页面建议',
                    (formatChangeImpact(data.changeImpact) || 'AI 将替换当前页面内容。') + ' 你可以通过“撤销”恢复原页面。');
                if (!accepted || !rewriteTargetIsCurrent()) return;
                const index = state.active.content.slides.findIndex(item => item.id === slide.id);
                state.active.content.slides[index] = { ...proposed, id: slide.id, index };
                state.selectedElementId = '';
                recordHistory();
                renderEditor();
                toast('已应用 AI 页面建议。');
            } catch (error) {
                if (!isAiAbort(error, controller)) throw error;
                toast('AI 页面改写已取消。', 'warning');
            } finally {
                endAiRequest(controller);
                if (button) { button.disabled = false; button.textContent = 'AI 改写当前页'; }
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

        return { generateSlides, fillMissingPages, rewriteCurrentSlide, renderProgress };
    }

    window.Pivot?.exposeModule?.('apps.presentations.generation', { create });
})();
