/* 知识图谱交互辅助函数 Knowledge graph interaction helpers */



(function () {
    const DEFAULT_MIN_ZOOM = 0.55;
    const DEFAULT_MAX_ZOOM = 2.2;
    const DEFAULT_ZOOM_STEP = 0.16;
    const DEFAULT_MAP_SELECTOR = '.rag-graph-map';
    const DEFAULT_STAGE_SELECTOR = '.rag-graph-map-stage';
    const DEFAULT_IGNORE_PAN_SELECTOR = '.rag-graph-map-controls, .rag-graph-map-node';
    let graphNodeTooltipHideTimer = null;

    function normalizeNumber(value, fallback) {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    function ensureGraphMapView(graphState) {
        if (!graphState.mapView) {
            graphState.mapView = {
                x: 0,
                y: 0,
                scale: 1,
                isPanning: false,
                pointerId: null,
                startX: 0,
                startY: 0,
                originX: 0,
                originY: 0,
                moved: false,
                suppressNextNodeClick: false
            };
        }
        return graphState.mapView;
    }

    function applyGraphMapTransform(graphState, options = {}) {
        const view = ensureGraphMapView(graphState);
        const minZoom = normalizeNumber(options.minZoom, DEFAULT_MIN_ZOOM);
        const maxZoom = normalizeNumber(options.maxZoom, DEFAULT_MAX_ZOOM);
        const stage = document.querySelector(options.stageSelector || DEFAULT_STAGE_SELECTOR);
        const zoomValue = document.getElementById(options.zoomValueId || 'rag-graph-zoom-value');
        if (stage) {
            stage.style.transform = `translate(${view.x.toFixed(1)}px, ${view.y.toFixed(1)}px) scale(${view.scale.toFixed(3)})`;
        }
        if (zoomValue) zoomValue.textContent = `${Math.round(view.scale * 100)}%`;
        document.querySelectorAll('[data-graph-zoom-action="in"]').forEach((button) => {
            button.disabled = view.scale >= maxZoom - 0.01;
        });
        document.querySelectorAll('[data-graph-zoom-action="out"]').forEach((button) => {
            button.disabled = view.scale <= minZoom + 0.01;
        });
    }

    function resetGraphMapView(graphState, options = {}) {
        const view = ensureGraphMapView(graphState);
        view.x = 0;
        view.y = 0;
        view.scale = 1;
        view.isPanning = false;
        view.pointerId = null;
        view.moved = false;
        view.suppressNextNodeClick = false;
        applyGraphMapTransform(graphState, options);
    }

function zoomGraphMap(nextScale, graphState, options = {}) {
        const map = document.querySelector(options.mapSelector || DEFAULT_MAP_SELECTOR);
        if (!map) return;
        const clientX = options.clientX;
        const clientY = options.clientY;
        const minZoom = normalizeNumber(options.minZoom, DEFAULT_MIN_ZOOM);
        const maxZoom = normalizeNumber(options.maxZoom, DEFAULT_MAX_ZOOM);
        const clampZoom = options.clampZoom || ((scale, min, max) => Math.min(max, Math.max(min, scale)));
        const view = ensureGraphMapView(graphState);
        const oldScale = view.scale;
        const scale = clampZoom(nextScale, minZoom, maxZoom);
        if (Math.abs(scale - oldScale) < 0.001) return;
        if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
            const rect = map.getBoundingClientRect();
            const pointerX = clientX - rect.left;
            const pointerY = clientY - rect.top;
            view.x = pointerX - ((pointerX - view.x) / oldScale) * scale;
            view.y = pointerY - ((pointerY - view.y) / oldScale) * scale;
        }
        view.scale = scale;
        applyGraphMapTransform(graphState, options);
    }

    function zoomGraphMapByAction(action, graphState, options = {}) {
        const map = document.querySelector(options.mapSelector || DEFAULT_MAP_SELECTOR);
        const rect = map?.getBoundingClientRect();
        if (action === 'reset') {
            resetGraphMapView(graphState, options);
            return;
        }
        const view = ensureGraphMapView(graphState);
        const zoomStep = normalizeNumber(options.zoomStep, DEFAULT_ZOOM_STEP);
        const delta = action === 'in' ? zoomStep : -zoomStep;
        zoomGraphMap(
            view.scale + delta,
            graphState,
            {
                ...options,
                clientX: rect ? rect.left + rect.width / 2 : null,
                clientY: rect ? rect.top + rect.height / 2 : null
            }
        );
    }

    function ensureGraphNodeTooltip() {
        let tooltip = document.getElementById('rag-graph-node-tooltip');
        if (tooltip) return tooltip;
        tooltip = document.createElement('div');
        tooltip.id = 'rag-graph-node-tooltip';
        tooltip.className = 'rag-graph-node-tooltip hidden';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.addEventListener('mouseenter', cancelGraphNodeTooltipHide);
        tooltip.addEventListener('mouseleave', () => scheduleGraphNodeTooltipHide(120));
        document.body.appendChild(tooltip);
        return tooltip;
    }

    function cancelGraphNodeTooltipHide() {
        if (!graphNodeTooltipHideTimer) return;
        clearTimeout(graphNodeTooltipHideTimer);
        graphNodeTooltipHideTimer = null;
    }

    function scheduleGraphNodeTooltipHide(delay = 160) {
        cancelGraphNodeTooltipHide();
        graphNodeTooltipHideTimer = setTimeout(() => {
            graphNodeTooltipHideTimer = null;
            hideGraphNodeTooltip();
        }, Math.max(0, Number(delay) || 0));
    }

    function positionGraphNodeTooltip(eventOrRect) {
        const tooltip = document.getElementById('rag-graph-node-tooltip');
        if (!tooltip || tooltip.classList.contains('hidden')) return;
        const point = eventOrRect?.left !== undefined
            ? { x: eventOrRect.left + eventOrRect.width / 2, y: eventOrRect.top }
            : { x: eventOrRect?.clientX, y: eventOrRect?.clientY };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        const offset = 8;
        let left = point.x + offset;
        let top = point.y + offset;
        const rect = tooltip.getBoundingClientRect();
        if (left + rect.width > window.innerWidth - 10) left = point.x - rect.width - offset;
        if (top + rect.height > window.innerHeight - 10) top = point.y - rect.height - offset;
        tooltip.style.left = `${Math.max(10, left)}px`;
        tooltip.style.top = `${Math.max(10, top)}px`;
    }

    function showGraphNodeTooltip(node, eventOrRect, options = {}) {
        const text = node?.dataset?.graphNodeTooltip || node?.dataset?.graphRelationTooltip;
        if (!text) return;
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const tooltip = ensureGraphNodeTooltip();
        cancelGraphNodeTooltipHide();
        const lines = text.split('\n').filter(Boolean);
        tooltip.innerHTML = lines.map((line, index) => (
            index === 0
                ? `<strong>${escapeHtml(line)}</strong>`
                : `<span>${escapeHtml(line)}</span>`
        )).join('');
        tooltip.classList.remove('hidden');
        positionGraphNodeTooltip(eventOrRect);
    }

    function hideGraphNodeTooltip() {
        cancelGraphNodeTooltipHide();
        document.getElementById('rag-graph-node-tooltip')?.classList.add('hidden');
    }

    function startGraphMapPan(event, graphState, options = {}) {
        const map = event.target.closest?.(options.mapSelector || DEFAULT_MAP_SELECTOR);
        const ignoreSelector = options.ignorePanSelector || DEFAULT_IGNORE_PAN_SELECTOR;
        if (!map || event.target.closest?.(ignoreSelector)) return false;
        hideGraphNodeTooltip();
        if (event.button !== undefined && event.button !== 0) return false;
        const view = ensureGraphMapView(graphState);
        view.isPanning = true;
        view.pointerId = event.pointerId;
        view.startX = event.clientX;
        view.startY = event.clientY;
        view.originX = view.x;
        view.originY = view.y;
        view.moved = false;
        map.classList.add('is-panning');
        if (typeof map.setPointerCapture === 'function') map.setPointerCapture(event.pointerId);
        return true;
    }

    function moveGraphMapPan(event, graphState, options = {}) {
        const view = ensureGraphMapView(graphState);
        if (!view.isPanning || view.pointerId !== event.pointerId) return false;
        const dx = event.clientX - view.startX;
        const dy = event.clientY - view.startY;
        if (Math.hypot(dx, dy) > 3) view.moved = true;
        if (!view.moved) return false;
        view.x = view.originX + dx;
        view.y = view.originY + dy;
        applyGraphMapTransform(graphState, options);
        event.preventDefault();
        return true;
    }

    function stopGraphMapPan(event, graphState, options = {}) {
        const view = ensureGraphMapView(graphState);
        if (!view.isPanning || view.pointerId !== event.pointerId) return false;
        const map = document.querySelector(options.mapSelector || DEFAULT_MAP_SELECTOR);
        if (view.moved) {
            view.suppressNextNodeClick = true;
            setTimeout(() => {
                view.suppressNextNodeClick = false;
            }, 120);
        }
        view.isPanning = false;
        view.pointerId = null;
        view.moved = false;
        map?.classList.remove('is-panning');
        if (map && typeof map.releasePointerCapture === 'function') {
            try {
                map.releasePointerCapture(event.pointerId);
            } catch (error) {
                // The pointer may already be released by the browser.
            }
        }
        return true;
    }

    const existingPivot = window.Pivot || {};
    existingPivot.ragGraphUi = {
        applyGraphMapTransform,
        cancelGraphNodeTooltipHide,
        ensureGraphMapView,
        ensureGraphNodeTooltip,
        hideGraphNodeTooltip,
        moveGraphMapPan,
        positionGraphNodeTooltip,
        resetGraphMapView,
        scheduleGraphNodeTooltipHide,
        showGraphNodeTooltip,
        startGraphMapPan,
        stopGraphMapPan,
        zoomGraphMap,
        zoomGraphMapByAction
    };
    window.Pivot = existingPivot;
})();
