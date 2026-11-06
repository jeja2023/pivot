(function () {
    if (window.Pivot?.moduleApi?.('apps.presentations.design')?.ready) return;
    function reviewMessage(state) {
        const review = state.active?.validation?.visualReview;
        if (!review || review.status === 'not_requested') return '尚未进行视觉模型复核。';
        if (review.localRevision !== state.editRevision || review.localVersion !== state.active.version) return '文稿已变化，之前的视觉复核结果仅供参考，请重新复核。';
        return review.message;
    }
    async function runVisualReview(state, helpers) {
        const { requirePresentationAiModel, beginAiRequest, endAiRequest, saveActive, activeContent, requestJson, aiJsonOptions, switchPanel, renderIssues, toast, isAiAbort } = helpers;
        if (!state.active?.id) return;
        const model = requirePresentationAiModel(); if (!model) return;
        const controller = beginAiRequest(), button = document.getElementById('presentation-visual-review-btn');
        button?.setAttribute('disabled', 'disabled');
        try {
            if (state.dirty) await saveActive();
            const activeId = state.active.id, revision = state.editRevision;
            const slideIndex = activeContent().slides.findIndex(slide => slide.id === state.selectedSlideId);
            const data = await requestJson(`/api/apps/presentations/${encodeURIComponent(activeId)}/visual-review`, aiJsonOptions({ model, slideIndex }, controller));
            if (state.active?.id !== activeId || state.editRevision !== revision) { toast('文稿已变化，请重新复核当前内容。', 'warning'); return; }
            const previous = state.active.validation || { issues: [] };
            state.active.validation = { ...previous, visualReview: { ...data.review, localRevision: state.editRevision, localVersion: state.active.version }, issues: [...(previous.issues || []).filter(issue => !(String(issue.code).startsWith('VISUAL_') && issue.slideId === data.review.slideId)), ...(data.review.issues || [])] };
            const toastType = data.review.status === 'passed' ? 'success' : 'warning';
            switchPanel('issues'); renderIssues(); toast(data.review.message, toastType);
        } catch (error) { if (!isAiAbort(error, controller)) throw error; }
        finally { endAiRequest(controller); button?.removeAttribute('disabled'); }
    }
    window.Pivot?.exposeModule?.('apps.presentations.design', { ready: true, runVisualReview, reviewMessage });
})();
