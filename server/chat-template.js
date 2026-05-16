const fs = require('fs');
const path = require('path');

const chatTemplatePath = path.join(__dirname, '../client/chat/chat.html');
const chatPartialsDir = path.resolve(__dirname, '../client/chat/partials');

function resolveChatHtmlIncludes(template, seen = new Set()) {
    return String(template || '').replace(/<!--\s*@include\s+([a-zA-Z0-9_./-]+)\s*-->/g, (match, includePath) => {
        const normalizedPath = includePath.replace(/\\/g, '/');
        if (!normalizedPath.startsWith('partials/') || path.extname(normalizedPath) !== '.html') {
            throw new Error(`Invalid chat include path: ${includePath}`);
        }
        const relativePartialPath = normalizedPath.slice('partials/'.length);
        const absolutePartialPath = path.resolve(chatPartialsDir, relativePartialPath);
        if (!absolutePartialPath.startsWith(`${chatPartialsDir}${path.sep}`)) {
            throw new Error(`Chat include escapes partials directory: ${includePath}`);
        }
        if (seen.has(absolutePartialPath)) {
            throw new Error(`Circular chat include detected: ${includePath}`);
        }
        if (!fs.existsSync(absolutePartialPath)) {
            throw new Error(`Missing chat partial: ${includePath}`);
        }
        seen.add(absolutePartialPath);
        const partial = fs.readFileSync(absolutePartialPath, 'utf8');
        const resolved = resolveChatHtmlIncludes(partial, seen);
        seen.delete(absolutePartialPath);
        return resolved;
    });
}

function loadChatHtmlTemplate() {
    return resolveChatHtmlIncludes(fs.readFileSync(chatTemplatePath, 'utf8'));
}

module.exports = {
    chatPartialsDir,
    chatTemplatePath,
    loadChatHtmlTemplate,
    resolveChatHtmlIncludes
};
