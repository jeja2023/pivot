// 可变高度聊天消息窗口：服务端游标分页 + 像素级 overscan。
(function initializeChatMessageVirtualizer() {
    const PAGE_SIZE = 50;
    const OVERSCAN_PX = 800;
    const MESSAGE_GAP_PX = 8;
    const INITIAL_TAIL_COUNT = 18;
    const BOTTOM_PIN_SETTLE_MS = 120;
    let state = null;

    function recordKey(record) {
        return `message:${record.id}`;
    }

    function estimateRecordHeight(record) {
        const contentLength = String(record?.content || '').length;
        const lines = Math.max(1, Math.ceil(contentLength / (record?.role === 'assistant' ? 72 : 90)));
        return Math.min(520, 82 + lines * 22) + MESSAGE_GAP_PX;
    }

    function getRecordHeight(record) {
        return state?.heights.get(recordKey(record)) || estimateRecordHeight(record);
    }

    function buildOffsets(records) {
        const offsets = [0];
        records.forEach(record => offsets.push(offsets[offsets.length - 1] + getRecordHeight(record)));
        return offsets;
    }

    function findOffsetIndex(offsets, value) {
        let low = 0;
        let high = Math.max(0, offsets.length - 1);
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (offsets[middle + 1] < value) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    function captureMountedState() {
        if (!state?.container) return;
        state.container.querySelectorAll('.message[data-virtual-message-key]').forEach(message => {
            const key = message.dataset.virtualMessageKey;
            state.uiStates.set(key, {
                thoughts: Array.from(message.querySelectorAll('.thought-block')).map(block => block.classList.contains('is-open')),
                thoughtScroll: Array.from(message.querySelectorAll('.thought-content-inner')).map(inner => inner.scrollTop)
            });
        });
    }

    function restoreMountedState(message, record) {
        const ui = state.uiStates.get(recordKey(record));
        if (!ui) return;
        Array.from(message.querySelectorAll('.thought-block')).forEach((block, index) => {
            block.classList.toggle('is-open', Boolean(ui.thoughts?.[index]));
        });
        Array.from(message.querySelectorAll('.thought-content-inner')).forEach((inner, index) => {
            inner.scrollTop = Number(ui.thoughtScroll?.[index] || 0);
        });
    }

    function messageStats(record) {
        return {
            createdAt: record.created_at,
            costTime: record.cost_time,
            tps: record.tokens_per_sec,
            tokenCount: record.token_count,
            modelName: record.model_name || record.model_api_name || ''
        };
    }

    function updateSpacerHeights(offsets = buildOffsets(state.records)) {
        if (!state) return;
        const top = state.container.querySelector('.message-virtual-spacer-top');
        const bottom = state.container.querySelector('.message-virtual-spacer-bottom');
        if (top) top.style.height = `${offsets[state.range.start] || 0}px`;
        if (bottom) bottom.style.height = `${Math.max(0, offsets[offsets.length - 1] - offsets[state.range.end])}px`;
        state.offsets = offsets;
    }

    function setProgrammaticScrollTop(container, top) {
        if (!state) return;
        const targetTop = Math.max(0, Math.round(top));
        if (Math.abs(container.scrollTop - targetTop) <= 1) return;
        state.isProgrammaticScroll = true;
        container.scrollTop = targetTop;
        requestAnimationFrame(() => {
            if (state) state.isProgrammaticScroll = false;
        });
    }

    function cancelBottomPinRelease(activeState = state) {
        if (!activeState?.bottomPinTimer) return;
        clearTimeout(activeState.bottomPinTimer);
        activeState.bottomPinTimer = 0;
    }

    function pinToBottomUntilStable(activeState = state) {
        if (state !== activeState || !activeState?.active || !activeState.pinBottom) return;
        setProgrammaticScrollTop(activeState.container, activeState.container.scrollHeight);
        cancelBottomPinRelease(activeState);
        activeState.bottomPinTimer = setTimeout(() => {
            if (state !== activeState || !activeState.active || !activeState.pinBottom) return;
            setProgrammaticScrollTop(activeState.container, activeState.container.scrollHeight);
            activeState.pinBottom = false;
            activeState.bottomPinTimer = 0;
        }, BOTTOM_PIN_SETTLE_MS);
    }

    function observeMountedMessages() {
        state.resizeObserver?.disconnect();
        if (typeof ResizeObserver === 'undefined') return;
        const activeState = state;
        state.resizeObserver = new ResizeObserver(entries => {
            if (state !== activeState || !activeState.active) return;
            let changed = false;
            let scrollAdjustment = 0;
            entries.forEach(entry => {
                const key = entry.target.dataset.virtualMessageKey;
                const height = Math.ceil(entry.contentRect.height) + MESSAGE_GAP_PX;
                const previousHeight = activeState.heights.get(key) || 0;
                if (!key || height <= 0 || Math.abs(previousHeight - height) < 2) return;
                if (previousHeight > 0 && entry.target.offsetTop < activeState.container.scrollTop) {
                    scrollAdjustment += height - previousHeight;
                }
                activeState.heights.set(key, height);
                changed = true;
            });
            if (changed) {
                updateSpacerHeights();
                if (activeState.pinBottom) {
                    pinToBottomUntilStable(activeState);
                } else if (scrollAdjustment && Math.abs(scrollAdjustment) > 2) {
                    setProgrammaticScrollTop(activeState.container, activeState.container.scrollTop + scrollAdjustment);
                }
            }
        });
        state.container.querySelectorAll('.message[data-virtual-message-key]').forEach(message => state.resizeObserver.observe(message));
    }

    function computeRange() {
        const records = state.records;
        if (!records.length) return { start: 0, end: 0 };
        if (state.pinBottom) {
            return { start: Math.max(0, records.length - INITIAL_TAIL_COUNT), end: records.length };
        }
        const offsets = buildOffsets(records);
        const viewportStart = Math.max(0, state.container.scrollTop - OVERSCAN_PX);
        const viewportEnd = state.container.scrollTop + state.container.clientHeight + OVERSCAN_PX;
        const start = Math.max(0, findOffsetIndex(offsets, viewportStart));
        const end = Math.min(records.length, Math.max(start + 1, findOffsetIndex(offsets, viewportEnd) + 1));
        return { start, end };
    }

    function createSpacer(className, height) {
        const spacer = document.createElement('div');
        spacer.className = `message-virtual-spacer ${className}`;
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.height = `${Math.max(0, height)}px`;
        return spacer;
    }

    function renderWindow(force = false) {
        if (!state?.active) return;
        const nextRange = computeRange();
        if (!force && nextRange.start === state.range.start && nextRange.end === state.range.end) return;
        captureMountedState();

        const offsets = buildOffsets(state.records);
        let topSpacer = state.container.querySelector('.message-virtual-spacer-top');
        let bottomSpacer = state.container.querySelector('.message-virtual-spacer-bottom');

        if (!topSpacer) {
            topSpacer = createSpacer('message-virtual-spacer-top', offsets[nextRange.start] || 0);
            state.container.prepend(topSpacer);
        } else {
            topSpacer.style.height = `${offsets[nextRange.start] || 0}px`;
        }

        if (!bottomSpacer) {
            bottomSpacer = createSpacer('message-virtual-spacer-bottom', Math.max(0, offsets[offsets.length - 1] - offsets[nextRange.end]));
            state.container.appendChild(bottomSpacer);
        } else {
            bottomSpacer.style.height = `${Math.max(0, offsets[offsets.length - 1] - offsets[nextRange.end])}px`;
        }

        const existingMessages = new Map();
        state.container.querySelectorAll('.message[data-virtual-message-key]').forEach(el => {
            existingMessages.set(el.dataset.virtualMessageKey, el);
        });

        const activeKeys = new Set();
        const newlyMountedAssistantNodes = [];
        let insertRefNode = bottomSpacer;

        for (let index = nextRange.end - 1; index >= nextRange.start; index -= 1) {
            const record = state.records[index];
            const key = recordKey(record);
            activeKeys.add(key);

            let messageEl = existingMessages.get(key);
            if (messageEl) {
                if (messageEl.nextSibling !== insertRefNode) {
                    state.container.insertBefore(messageEl, insertRefNode);
                }
            } else {
                const tempDiv = document.createElement('div');
                appendMessage(record.role, record.content, record.id, messageStats(record), {
                    target: tempDiv,
                    deferRender: true,
                    disableImagePinning: true
                });
                messageEl = tempDiv.querySelector('.message');
                if (messageEl) {
                    messageEl.dataset.virtualMessageKey = key;
                    restoreMountedState(messageEl, record);
                    state.container.insertBefore(messageEl, insertRefNode);
                    if (record.role === 'assistant') {
                        const contentNode = messageEl.querySelector('.message-content');
                        if (contentNode) newlyMountedAssistantNodes.push(contentNode);
                    }
                }
            }
            if (messageEl) insertRefNode = messageEl;
        }

        existingMessages.forEach((messageEl, key) => {
            if (!activeKeys.has(key)) {
                window.teardownPivotCharts?.(messageEl);
                messageEl.remove();
            }
        });

        state.range = nextRange;
        state.offsets = offsets;

        newlyMountedAssistantNodes.forEach(node => window.renderPivotCharts?.(node));
        observeMountedMessages();

        if (state.pinBottom) {
            pinToBottomUntilStable(state);
        } else {
            const maxScrollTop = Math.max(0, state.container.scrollHeight - state.container.clientHeight);
            if (state.container.scrollTop > maxScrollTop) {
                setProgrammaticScrollTop(state.container, maxScrollTop);
            }
        }
    }

    function scheduleRender() {
        if (!state?.active || state.renderFrame) return;
        state.renderFrame = requestAnimationFrame(() => {
            if (!state) return;
            state.renderFrame = 0;
            renderWindow();
        });
    }

    async function loadOlderMessages() {
        if (!state?.active || state.loading || !state.page?.hasMore) return;
        state.loading = true;
        const activeState = state;
        try {
            const url = `${API_BASE}/sessions/${encodeURIComponent(state.sessionId)}?messageLimit=${PAGE_SIZE}&beforeMessageId=${encodeURIComponent(state.page.beforeId)}`;
            const response = await apiFetch(url);
            if (!response.ok) throw new Error('历史消息加载失败');
            const data = await response.json();
            if (state !== activeState || !state.active) return;
            const existingIds = new Set(state.records.map(record => Number(record.id)));
            const older = (Array.isArray(data.messages) ? data.messages : [])
                .filter(record => !existingIds.has(Number(record.id)));
            const addedHeight = older.reduce((sum, record) => sum + estimateRecordHeight(record), 0);
            const previousTop = state.container.scrollTop;
            state.records = older.concat(state.records);
            state.page = data.page || { hasMore: false, beforeId: null };
            setProgrammaticScrollTop(state.container, previousTop + addedHeight);
            renderWindow(true);
        } catch (error) {
            showToast(error.message || '历史消息加载失败', 'error');
        } finally {
            if (state === activeState) state.loading = false;
        }
    }

    function handleScroll() {
        if (!state?.active) return;
        if (state.isProgrammaticScroll) {
            state.isProgrammaticScroll = false;
            return;
        }
        if (state.pinBottom) {
            const distanceFromBottom = state.container.scrollHeight - state.container.clientHeight - state.container.scrollTop;
            if (distanceFromBottom > 48) {
                cancelBottomPinRelease(state);
                state.pinBottom = false;
            }
        }
        if (state.container.scrollTop < 500) loadOlderMessages();
        scheduleRender();
    }

    function stop({ clear = true } = {}) {
        if (!state) return;
        captureMountedState();
        state.active = false;
        if (state.renderFrame) window.cancelAnimationFrame(state.renderFrame);
        cancelBottomPinRelease(state);
        state.resizeObserver?.disconnect();
        state.container.removeEventListener('scroll', handleScroll);
        state.container.classList.remove('is-virtualized');
        window.teardownPivotCharts?.(state.container);
        if (clear) PivotSafeHtml.setHtml(state.container, '');
        state = null;
    }

    function start({ sessionId, records, page }) {
        stop();
        const container = document.getElementById('message-container');
        state = {
            active: true,
            container,
            sessionId: String(sessionId),
            records: (Array.isArray(records) ? records : []).filter(record => ['user', 'assistant'].includes(record.role)),
            page: page || { hasMore: false, beforeId: null },
            heights: new Map(),
            uiStates: new Map(),
            offsets: [],
            range: { start: -1, end: -1 },
            resizeObserver: null,
            renderFrame: 0,
            bottomPinTimer: 0,
            loading: false,
            pinBottom: true,
            isProgrammaticScroll: false
        };
        PivotSafeHtml.setHtml(container, '');
        container.classList.add('is-virtualized');
        container.addEventListener('scroll', handleScroll, { passive: true });
        renderWindow(true);
    }

    function prepareForLiveAppend() {
        if (!state?.active) return;
        const container = state.container;
        const recentRecords = state.records.slice(-60);
        captureMountedState();
        if (state.renderFrame) window.cancelAnimationFrame(state.renderFrame);
        cancelBottomPinRelease(state);
        state.resizeObserver?.disconnect();
        container.removeEventListener('scroll', handleScroll);
        container.classList.remove('is-virtualized');
        window.teardownPivotCharts?.(container);
        PivotSafeHtml.setHtml(container, '');
        const fragment = document.createDocumentFragment();
        const assistantNodes = [];
        recentRecords.forEach(record => {
            const content = appendMessage(record.role, record.content, record.id, messageStats(record), {
                target: fragment,
                deferRender: true,
                disableImagePinning: true
            });
            if (record.role === 'assistant' && content) assistantNodes.push(content);
        });
        container.appendChild(fragment);
        assistantNodes.forEach(node => window.renderPivotCharts?.(node));
        state.active = false;
        state = null;
        window.scrollMessagesToBottom?.({ duration: 300 });
    }

    window.Pivot.exposeModule('chat.messageVirtualizer', {
        isActive: () => Boolean(state?.active),
        loadOlderMessages,
        prepareForLiveAppend,
        start,
        stop
    });
})();
