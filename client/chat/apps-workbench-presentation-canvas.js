(function () {
    'use strict';
    function renderSlideList(state, helpers) {
        const list = document.getElementById('presentation-slide-list');
        if (!list) return;
        list.replaceChildren();
        const content = state.active?.content;
        content.slides.forEach((slide, index) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = `presentation-slide-thumb${slide.id === state.selectedSlideId ? ' is-active' : ''}`; button.dataset.presentationSlideId = slide.id;
            const number = document.createElement('span'); number.className = 'presentation-slide-number'; number.textContent = String(index + 1);
            const preview = document.createElement('div'); preview.className = 'presentation-slide-thumb-preview'; preview.style.background = slide.background.fill;
            const heading = slide.elements.find(element => element.visible !== false && element.type === 'text' && Number(element.style?.fontSize || 0) >= 24);
            const title = heading?.content?.text || `第 ${index + 1} 页`;
            const previewTitle = document.createElement('strong'); previewTitle.textContent = String(title).slice(0, 30);
            previewTitle.style.color = window.Pivot.moduleApi('apps.presentations.colors').readable(slide.background.fill, heading?.style?.color || '#243746'); preview.appendChild(previewTitle);
            const label = document.createElement('small'); label.textContent = helpers.layoutLabel(slide.layoutId);
            button.append(number, preview, label); list.appendChild(button);
        });
    }
    async function renderImage(element, node, state, request) {
        node.dataset.presentationImageRef = element.assetRef;
        const cached = state.imageUrls.get(element.assetRef);
        if (cached) { node.style.backgroundImage = `url("${cached}")`; return; }
        try {
            const res = await request(`/api/apps/presentations/assets/content/by-ref?ref=${encodeURIComponent(element.assetRef)}&presentationId=${encodeURIComponent(state.active?.id || '')}`);
            if (!res.ok) return;
            const url = URL.createObjectURL(await res.blob());
            state.imageUrls.set(element.assetRef, url);
            if (node.isConnected && node.dataset.presentationImageRef === element.assetRef) node.style.backgroundImage = `url("${url}")`;
        } catch (_) {}
    }
    window.Pivot.exposeModule('apps.presentations.canvas', { renderSlideList, renderImage });
})();
