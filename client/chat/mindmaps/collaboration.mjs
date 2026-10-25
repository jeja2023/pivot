import crdt from '/common/vendor/simple-mind-map/0.14.0-fix.3/collaboration.mjs';
function decode(value) { const binary = globalThis.atob(value); return Uint8Array.from(binary, character => character.charCodeAt(0)); }
function encode(value) { let binary = ''; for (const byte of value) binary += String.fromCharCode(byte); return globalThis.btoa(binary); }
export function create(snapshot) {
    const doc = crdt.create(); crdt.apply(doc, decode(snapshot.collaborationState));
    let acknowledged = crdt.vector(doc); const undo = crdt.undoManager(doc); const epoch = snapshot.collaborationEpoch;
    return {
        epoch,
        edit(document) { crdt.write(doc, document); return crdt.read(doc); },
        document() { return crdt.read(doc); },
        payload() { return { collaborationUpdate: encode(crdt.update(doc, acknowledged)), collaborationEpoch: epoch }; },
        receive(snapshot) {
            if (!snapshot.collaboration || snapshot.collaborationEpoch !== epoch) throw new Error('协作会话已变化，请重载或另存本地副本。');
            const incoming = decode(snapshot.collaborationState); const candidate = crdt.create(); const remote = crdt.create();
            try {
                crdt.apply(candidate, crdt.encode(doc)); crdt.apply(candidate, incoming); const merged = crdt.read(candidate);
                crdt.apply(remote, incoming); acknowledged = crdt.vector(remote); crdt.apply(doc, incoming);
                return merged;
            } finally { candidate.destroy(); remote.destroy(); }
        },
        undo() { undo.undo(); return crdt.read(doc); },
        redo() { undo.redo(); return crdt.read(doc); },
        destroy() { undo.destroy(); doc.destroy(); }
    };
}
