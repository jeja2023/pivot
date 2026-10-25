export function connect({ request, artifactId, snapshot, revoked }) {
    let socket; let stopped = false; let connected = false; let retry; let startup;
    function reconnect() {
        connected = false; clearTimeout(startup);
        if (!stopped) { clearTimeout(retry); retry = setTimeout(() => { void open(); }, 15000); }
    }
    async function open() {
        try {
            const ticket = await request(`/${artifactId}/stream-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (stopped) return;
            const url = new URL(ticket.path, window.location.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            socket = new WebSocket(url);
            startup = setTimeout(() => socket?.close(), 6000);
            socket.onopen = () => { if (!stopped) socket.send(JSON.stringify({ ticket: ticket.ticket })); };
            socket.onmessage = event => {
                if (stopped) return;
                try {
                    const result = JSON.parse(event.data);
                    if (result.type === 'ready') { connected = true; clearTimeout(startup); }
                    else if (result.type === 'snapshot') snapshot(result);
                    else if (result.type === 'error' && result.status === 404) revoked();
                } catch (_) { socket.close(); }
            };
            socket.onclose = reconnect; socket.onerror = () => socket.close();
        } catch (_) { reconnect(); }
    }
    void open();
    return { get connected() { return connected; }, close() { stopped = true; connected = false; clearTimeout(retry); clearTimeout(startup); socket?.close(); } };
}
