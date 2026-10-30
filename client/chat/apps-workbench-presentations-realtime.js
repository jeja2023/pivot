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

    window.Pivot.exposeModule('apps.presentations.realtime', { isVisible, subscribe });
})();
