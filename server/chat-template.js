const fs = require('fs');
const path = require('path');

const chatTemplatePath = path.join(__dirname, '../client/chat/chat.html');
const chatPartialsDir = path.resolve(__dirname, '../client/chat/partials');
const lazyWorkspaceTemplates = Object.freeze({
    apps: 'workspaces/apps.html',
    agent: 'workspaces/agent.html',
    'agent-dag': 'workspaces/agent-dag.html',
    knowledge: 'workspaces/knowledge.html',
    mcp: 'workspaces/mcp.html',
    settings: 'workspaces/settings.html'
});

function resolveChatHtmlIncludes(template, seen = new Set()) {
    return String(template || '').replace(/<!--\s*@include\s+([a-zA-Z0-9_./-]+)\s*-->/g, (match, includePath) => {
        const normalizedPath = includePath.replace(/\\/g, '/');
        if (!normalizedPath.startsWith('partials/') || path.extname(normalizedPath) !== '.html') {
            throw new Error(`非法的聊天片段包含路径: ${includePath}`);
        }
        const relativePartialPath = normalizedPath.slice('partials/'.length);
        const absolutePartialPath = path.resolve(chatPartialsDir, relativePartialPath);
        if (!absolutePartialPath.startsWith(`${chatPartialsDir}${path.sep}`)) {
            throw new Error(`聊天片段路径越界: ${includePath}`);
        }
        if (seen.has(absolutePartialPath)) {
            throw new Error(`检测到循环片段引用: ${includePath}`);
        }
        if (!fs.existsSync(absolutePartialPath)) {
            throw new Error(`缺失聊天模板片段: ${includePath}`);
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

function loadChatWorkspaceTemplate(name) {
    const relativePath = lazyWorkspaceTemplates[String(name || '')];
    if (!relativePath) {
        const error = new Error(`未知的聊天工作区模板：${name}`);
        error.code = 'CHAT_WORKSPACE_TEMPLATE_NOT_FOUND';
        throw error;
    }
    const absolutePath = path.resolve(chatPartialsDir, relativePath);
    if (!absolutePath.startsWith(`${chatPartialsDir}${path.sep}`)) {
        throw new Error(`聊天工作区模板路径越界：${name}`);
    }
    return resolveChatHtmlIncludes(fs.readFileSync(absolutePath, 'utf8'));
}

module.exports = {
    chatPartialsDir,
    chatTemplatePath,
    lazyWorkspaceTemplates,
    loadChatHtmlTemplate,
    loadChatWorkspaceTemplate,
    resolveChatHtmlIncludes
};
