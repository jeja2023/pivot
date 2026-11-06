'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function chatIntentImplementation(root, routingConfig = {}) {
    const pending = ['server/routes/chat/index.js', 'client/chat/chat-auto-route.js', 'server/services/chat-intent-resolver.js', 'server/services/chat-auto-execution-handler.js',
        'server/services/chat-context-assembler.js', 'server/services/chat-agent-handoff.js', 'scripts/lib/chat_intent_evaluation.js', 'scripts/lib/chat_intent_entry_evaluation.js'];
    const sources = new Map();
    while (pending.length) {
        const file = pending.pop().replace(/\\/g, '/');
        if (sources.has(file)) continue;
        const content = await fs.readFile(path.join(root, file), 'utf8');
        sources.set(file, content);
        for (const match of content.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
            const base = path.resolve(root, path.dirname(file), match[1]);
            for (const candidate of [base.endsWith('.js') ? base : `${base}.js`, path.join(base, 'index.js')]) {
                if (!candidate.startsWith(path.resolve(root) + path.sep)) continue;
                try { if ((await fs.stat(candidate)).isFile()) { pending.push(path.relative(root, candidate)); break; } } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
            }
        }
    }
    const ordered = [...sources].sort(([left], [right]) => left.localeCompare(right));
    return { implementationDigest: crypto.createHash('sha256').update(JSON.stringify({ sources: ordered, routingConfig })).digest('hex'),
        implementationFiles: ordered.map(([file]) => file), routingConfig };
}

module.exports = { chatIntentImplementation };
