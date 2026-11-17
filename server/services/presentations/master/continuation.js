'use strict';

function createContinuationCoordinator(schedule = callback => setImmediate(callback)) {
    const running = new Set(), waiting = new Map();
    return {
        has(id) { return running.has(id); },
        begin(id) { if (running.has(id)) return false; running.add(id); return true; },
        continue(id, callback) {
            if (running.has(id)) waiting.set(id, callback);
            else schedule(callback);
        },
        finish(id) {
            running.delete(id);
            const callback = waiting.get(id);
            waiting.delete(id);
            if (callback) schedule(callback);
        }
    };
}

module.exports = { createContinuationCoordinator };
