(function () {
    function isVisible() {
        const view = document.getElementById('presentations-view');
        return Boolean(!document.hidden && view && !view.closest('.hidden, [hidden], [aria-hidden="true"]'));
    }

    function subscribe(types, listener) {
        const shared = window.Pivot.moduleApi('chat.tasks');
        if (typeof shared.subscribe === 'function') {
            const unsubscribe = shared.subscribe((type, event) => { if (types.includes(type)) listener(event); });
            return { close: unsubscribe };
        }
        if (!window.EventSource) return null;
        const source = new EventSource('/api/events', { withCredentials: true });
        types.forEach(type => source.addEventListener(type, listener));
        source.onerror = () => {};
        return source;
    }

    function subscribePresentation({ getActiveId, onRevoked, onUpdated, onComments, onCollaborators, onReconnect }) {
        const types = ['connected', 'realtime.resync', 'presentation.updated', 'presentation.comments', 'presentation.collaborators', 'presentation.access_revoked'];
        return subscribe(types, event => {
            let payload; try { payload = JSON.parse(event.data || '{}'); } catch (_) { return; }
            if (payload.type === 'connected' || payload.type === 'realtime.resync') { if (isVisible()) onReconnect(); return; }
            if (String(payload.presentationId || '') !== String(getActiveId() || '')) return;
            if (payload.type === 'presentation.access_revoked') { onRevoked(); return; }
            if (!isVisible()) return;
            if (payload.type === 'presentation.updated') onUpdated();
            if (payload.type === 'presentation.comments') onComments();
            if (payload.type === 'presentation.collaborators') onCollaborators();
        });
    }

    function startPolling({ getActiveId, onRefresh, onComments }) {
        let lastComments = Date.now();
        return window.setInterval(() => {
            const id = getActiveId();
            if (!id || !isVisible()) return;
            onRefresh();
            if (Date.now() - lastComments >= 15000) { lastComments = Date.now(); onComments(id); }
        }, 5000);
    }

    async function fetchCurrent({ active, getActive, request, onRevoked }) {
        let result;
        try { result = await request(active.id); }
        catch (error) {
            if (getActive() === active && (error.status === 403 || error.status === 404)) onRevoked();
            throw error;
        }
        return getActive() === active ? result : null;
    }

    window.Pivot.exposeModule('apps.presentations.realtime', { isVisible, subscribe, subscribePresentation, startPolling, fetchCurrent });
})();
