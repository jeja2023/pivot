/* 画布和步骤视图共用一份可撤销编辑历史。 */
(function () {
    function createHistory({ snapshot, restore, notify, limit = 100 }) {
        const undoStack = []; const redoStack = [];
        const record = () => {
            const value = snapshot();
            if (undoStack.at(-1) !== value) undoStack.push(value);
            if (undoStack.length > limit) undoStack.shift();
            redoStack.length = 0;
        };
        const undo = () => {
            const value = undoStack.pop();
            if (!value) { notify?.('没有可撤销的修改', 'info'); return; }
            redoStack.push(snapshot()); restore(value);
        };
        const redo = () => {
            const value = redoStack.pop();
            if (!value) { notify?.('没有可重做的修改', 'info'); return; }
            undoStack.push(snapshot()); restore(value);
        };
        return { record, undo, redo };
    }
    if (typeof window !== 'undefined') window.Pivot.registerModule('agent.dagHistory', { createHistory });
    if (typeof module !== 'undefined') module.exports = { createHistory };
})();
